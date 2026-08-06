import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { enforceClientDefaultModel } from "@/lib/enforce-model";
import { computePriority, passesFilters, type ProspecOrderBy, type ProspecOrderDir } from "@/lib/prospeccao-priority";

export const dynamic = "force-dynamic";

/** GET /api/prospeccao-sites/campaigns — campanhas de prospecção sites */
export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;

  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("client_id", ctx.clientId)
    .eq("campaign_type", "prospeccao_sites")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, campaigns: data || [] });
}

/** POST /api/prospeccao-sites/campaigns — cria campanha + targets a partir de lead_ids */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;

  try {
    const body = await req.json();
    await enforceClientDefaultModel(body, { clientId: ctx.clientId, isAdmin: ctx.isAdmin, impersonating: ctx.impersonating }, ["ai_model"]);

    const {
      name,
      instance_name,
      message_template,
      min_interval_seconds = 30,
      max_interval_seconds = 60,
      allowed_start_hour = 9,
      allowed_end_hour = 20,
      lead_ids = [],
      personalize_with_ai = false,
      ai_model = null,
      ai_prompt = null,
      order_by = "reviews",
      order_dir = "desc",
      min_reviews = 0,
      min_rating = 0,
    } = body;

    const orderBy = (["reviews", "rating", "created_at"].includes(order_by) ? order_by : "reviews") as ProspecOrderBy;
    const orderDir = (order_dir === "asc" ? "asc" : "desc") as ProspecOrderDir;
    const minReviews = Math.max(Number(min_reviews) || 0, 0);
    const minRating = Math.max(Number(min_rating) || 0, 0);

    if (!name || !instance_name || !message_template) {
      return NextResponse.json({ success: false, error: "Faltam campos: name, instance_name, message_template" }, { status: 400 });
    }
    if (Number(min_interval_seconds) < 1 || Number(max_interval_seconds) < 1) {
      return NextResponse.json({ success: false, error: "Intervalo mínimo: 1 segundo" }, { status: 400 });
    }
    if (Number(min_interval_seconds) > Number(max_interval_seconds)) {
      return NextResponse.json({ success: false, error: "min_interval > max_interval" }, { status: 400 });
    }
    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return NextResponse.json({ success: false, error: "Selecione ao menos 1 lead" }, { status: 400 });
    }

    const insertPayload: Record<string, any> = {
      client_id: ctx.clientId,
      name,
      instance_name,
      message_template,
      min_interval_seconds,
      max_interval_seconds,
      allowed_start_hour,
      allowed_end_hour,
      personalize_with_ai,
      ai_prompt: ai_prompt || null,
      campaign_type: "prospeccao_sites",
      status: "draft",
    };
    if (ai_model) insertPayload.ai_model = ai_model;

    let { data: camp, error: cErr } = await supabase.from("campaigns").insert(insertPayload).select().single();
    if (cErr && (cErr as any).code === "PGRST204" && "ai_model" in insertPayload) {
      delete insertPayload.ai_model;
      const retry = await supabase.from("campaigns").insert(insertPayload).select().single();
      camp = retry.data as any;
      cErr = retry.error as any;
    }
    if (cErr || !camp) return NextResponse.json({ success: false, error: cErr?.message || "Falha ao criar" }, { status: 500 });

    // Resolve leads → targets (filtra tenant p/ evitar cross-tenant injection)
    const { data: leads } = await supabase
      .from("leads_extraidos")
      .select("id, remoteJid, nome_negocio, ramo_negocio, telefone, opt_out, avaliacao, reviews, created_at")
      .eq("client_id", ctx.clientId)
      .in("id", lead_ids);

    const targetsRows = (leads || [])
      .filter((l: any) => !l.opt_out && l.remoteJid)
      .filter((l: any) => passesFilters(l, minReviews, minRating))
      .map((l: any) => ({
        campaign_id: camp.id,
        remote_jid: l.remoteJid,
        nome_negocio: l.nome_negocio,
        ramo_negocio: l.ramo_negocio,
        status: "pending",
        priority: computePriority(l, orderBy, orderDir),
      }));

    if (targetsRows.length === 0) {
      return NextResponse.json({ success: false, error: "Nenhum lead válido (todos opt-out ou sem JID)" }, { status: 400 });
    }

    const { error: tErr } = await supabase.from("campaign_targets").upsert(targetsRows, { onConflict: "campaign_id,remote_jid", ignoreDuplicates: true });
    if (tErr) console.warn("[prospeccao-sites] erro targets:", tErr.message);
    await supabase.from("campaigns").update({ total_targets: targetsRows.length }).eq("id", camp.id);

    return NextResponse.json({ success: true, campaign: { ...camp, total_targets: targetsRows.length } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}