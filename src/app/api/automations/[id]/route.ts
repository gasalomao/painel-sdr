import { NextRequest, NextResponse } from "next/server";
import { isDeepStrictEqual } from "node:util";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { isInstanceOwnedByClient, requireClientId } from "@/lib/tenant";
import { enforceClientDefaultModel } from "@/lib/enforce-model";
import { parseMinReviews } from "@/lib/scraper-review-count";

export const dynamic = "force-dynamic";

/**
 * GET    /api/automations/:id    → detalhes (ownership check obrigatório)
 * PATCH  /api/automations/:id    → edita campos (apenas em status=draft|paused|done|error)
 * DELETE /api/automations/:id    → remove + para campanhas vinculadas
 *
 * Sem filtro client_id: qualquer cliente autenticado podia ler/editar/apagar
 * automação de outro cliente passando o id na URL (IDOR).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await requireClientId(req);
  if (!tenant.ok) return tenant.response;
  const { id } = await ctx.params;

  let q = supabase.from("automations").select("*").eq("id", id);
  if (!tenant.isAdmin) q = q.eq("client_id", tenant.clientId);
  const { data, error } = await q.maybeSingle();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 });
  return NextResponse.json({ success: true, automation: data });
}

const EDITABLE_FIELDS = [
  "name",
  "agent_id",
  "instance_name",
  "niches",
  "regions",
  "scrape_filters",
  "scrape_max_leads",
  "dispatch_template",
  "dispatch_min_interval",
  "dispatch_max_interval",
  "dispatch_personalize",
  "dispatch_humanize",
  "dispatch_ai_model",
  "dispatch_ai_prompt",
  "dispatch_media_url",
  "dispatch_media_type",
  "dispatch_media_caption",
  "dispatch_media_file_name",
  "dispatch_media_mimetype",
  "lead_intelligence_enabled",
  "followup_enabled",
  "followup_steps",
  "followup_min_interval",
  "followup_max_interval",
  "followup_ai_enabled",
  "followup_ai_model",
  "followup_ai_prompt",
  "allowed_start_hour",
  "allowed_end_hour",
];

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await requireClientId(req);
  if (!tenant.ok) return tenant.response;
  const { id } = await ctx.params;
  try {
    const input: unknown = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return NextResponse.json({ success: false, error: "O corpo deve ser um objeto." }, { status: 400 });
    }
    const body = input as Record<string, unknown>;
    // Mesmo limite do formulário de automações.
    if (body.scrape_max_leads !== undefined && (
      typeof body.scrape_max_leads !== "number" || !Number.isInteger(body.scrape_max_leads) ||
      body.scrape_max_leads < 1 || body.scrape_max_leads > 5000
    )) {
      return NextResponse.json({ success: false, error: "scrape_max_leads deve ser um inteiro entre 1 e 5000." }, { status: 400 });
    }
    if (body.scrape_filters !== undefined) {
      if (!body.scrape_filters || typeof body.scrape_filters !== "object" || Array.isArray(body.scrape_filters)) {
        return NextResponse.json({ success: false, error: "scrape_filters deve ser um objeto." }, { status: 400 });
      }
      const filters = body.scrape_filters as Record<string, unknown>;
      if (Object.entries(filters).some(([key, value]) => key.startsWith("_") && !(key === "_source" && value === "prospeccao-sites"))) {
        return NextResponse.json({ success: false, error: "scrape_filters contém marcadores reservados ao servidor." }, { status: 400 });
      }
      if (parseMinReviews(filters.minReviews) === null) {
        return NextResponse.json({ success: false, error: "minReviews deve ser um inteiro entre 0 e 2147483647." }, { status: 400 });
      }
      if (filters.filterWithInstagram !== undefined && typeof filters.filterWithInstagram !== "boolean") {
        return NextResponse.json({ success: false, error: "filterWithInstagram deve ser um booleano." }, { status: 400 });
      }
    }
    // SaaS guard: cliente comum não escolhe modelo no PATCH.
    await enforceClientDefaultModel(body, tenant, ["dispatch_ai_model", "followup_ai_model"]);
    let ownerQuery = supabase.from("automations")
      .select("*").eq("id", id);
    if (!tenant.isAdmin) ownerQuery = ownerQuery.eq("client_id", tenant.clientId);
    const { data: current, error: readError } = await ownerQuery.maybeSingle();
    if (readError) throw readError;
    if (!current?.client_id) {
      return NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 });
    }
    if (!["draft", "paused", "done", "error"].includes(current.status)) {
      return NextResponse.json({ success: false, error: "Pause a automação antes de editar a configuração." }, { status: 409 });
    }
    if ("instance_name" in body && !(await isInstanceOwnedByClient(String(body.instance_name), current.client_id))) {
      return NextResponse.json({ success: false, error: "Instância não pertence a este cliente" }, { status: 403 });
    }
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of EDITABLE_FIELDS) {
      if (key in body) update[key] = body[key];
    }

    // O JSON mistura configuração e checkpoints do worker. Mescla só a edição
    // pública, sem apagar campos omitidos nem substituir marcadores existentes.
    const filters = (current.scrape_filters || {}) as Record<string, unknown>;
    if ("scrape_filters" in update) {
      const markers = Object.fromEntries(Object.entries(filters).filter(([key]) => key.startsWith("_")));
      update.scrape_filters = { ...filters, ...(update.scrape_filters as Record<string, unknown>), ...markers };
    }
    const captureStarted = Number(current.scraped_count) > 0 || filters._captureSessionId != null;
    if (captureStarted && ["niches", "regions", "scrape_max_leads", "scrape_filters"].some(
      key => key in update && !isDeepStrictEqual(update[key], key === "scrape_filters" ? filters : current[key]),
    )) {
      return NextResponse.json({ success: false, error: "A captura já foi iniciada. Crie outra automação para mudar nichos, regiões, filtros ou meta." }, { status: 409 });
    }

    // CAS: protege checkpoints e cada campo sobrescrito, inclusive quando duas
    // edições compartilham o mesmo updated_at. O timestamp é só suplementar.
    let writeQuery = supabase.from("automations").update(update)
      .eq("id", id).eq("client_id", current.client_id).eq("status", current.status);
    const comparedFields = new Set(["scrape_filters", "scraped_count", ...Object.keys(update)]);
    for (const key of comparedFields) {
      const value: unknown = current[key];
      writeQuery = value == null
        ? writeQuery.is(key, null)
        : writeQuery.eq(key, typeof value === "object" ? JSON.stringify(value) : value);
    }
    const { data: updated, error } = await writeQuery.select("id").maybeSingle();
    if (error) throw error;
    if (!updated) {
      return NextResponse.json({ success: false, error: "A automação foi atualizada durante a edição. Recarregue e tente novamente." }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await requireClientId(req);
  if (!tenant.ok) return tenant.response;
  const { id } = await ctx.params;
  try {
    // Pega referências pra também parar campanhas filhas — só se a automação
    // pertence ao tenant atual (ou se for admin).
    let lookupQ = supabase.from("automations").select("client_id, campaign_id, followup_campaign_id").eq("id", id);
    if (!tenant.isAdmin) lookupQ = lookupQ.eq("client_id", tenant.clientId);
    const { data: a } = await lookupQ.maybeSingle();
    if (!a) return NextResponse.json({ success: false, error: "Não encontrada ou sem permissão" }, { status: 404 });

    if (a?.campaign_id) {
      await supabase
        .from("campaigns")
        .update({ status: "stopped" })
        .eq("id", a.campaign_id)
        .eq("client_id", a.client_id);
    }
    if (a?.followup_campaign_id) {
      await supabase
        .from("followup_campaigns")
        .update({ status: "stopped" })
        .eq("id", a.followup_campaign_id)
        .eq("client_id", a.client_id);
    }
    const { error } = await supabase
      .from("automations")
      .delete()
      .eq("id", id)
      .eq("client_id", a.client_id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
