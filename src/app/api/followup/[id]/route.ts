import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { enforceClientDefaultModel } from "@/lib/enforce-model";
import { validateCampaignInstanceAccess } from "@/lib/campaign-instance-access";

export const dynamic = "force-dynamic";

/**
 * Ownership check pra evitar IDOR: cliente A passa id da campanha de follow-up
 * do cliente B e edita/lê/apaga. Admin (não-impersonando) tem visão global.
 */
async function ownsFollowup(req: NextRequest, id: string) {
  const tenant = await requireClientId(req);
  if (!tenant.ok) return { ok: false as const, res: tenant.response };
  const { data } = await supabase
    .from("followup_campaigns")
    .select("client_id, min_interval_seconds, max_interval_seconds")
    .eq("id", id)
    .maybeSingle();
  if (!data) return { ok: false as const, res: NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 }) };
  if (!tenant.isAdmin && data.client_id !== tenant.clientId) {
    return { ok: false as const, res: NextResponse.json({ success: false, error: "Sem permissão" }, { status: 403 }) };
  }
  return {
    ok: true as const,
    isAdmin: tenant.isAdmin,
    clientId: data.client_id,
    minInterval: typeof data.min_interval_seconds === "number" ? data.min_interval_seconds : null,
    maxInterval: typeof data.max_interval_seconds === "number" ? data.max_interval_seconds : null,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsFollowup(req, id);
  if (!own.ok) return own.res;

  const { data: camp, error } = await supabase
    .from("followup_campaigns")
    .select("*")
    .eq("id", id)
    .eq("client_id", own.clientId)
    .maybeSingle();
  if (error) {
    console.error("[followup/GET] Erro:", error.message);
    return NextResponse.json({ success: false, error: "Falha ao carregar follow-up" }, { status: 500 });
  }
  if (!camp) return NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 });

  const { data: targets } = await supabase
    .from("followup_targets")
    .select("*")
    .eq("followup_campaign_id", id)
    .eq("client_id", own.clientId)
    .order("created_at", { ascending: false })
    .limit(500);

  return NextResponse.json({ success: true, campaign: camp, targets: targets || [] });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const own = await ownsFollowup(req, id);
    if (!own.ok) return own.res;

    const body = await req.json();
    // SaaS guard: cliente comum não pode escolher modelo arbitrário no PATCH.
    await enforceClientDefaultModel(body, { clientId: own.clientId, isAdmin: own.isAdmin }, ["ai_model"]);
    if ("instance_name" in body) {
      const access = await validateCampaignInstanceAccess(own.clientId, String(body.instance_name));
      if (!access.ok) {
        return NextResponse.json({ success: false, error: access.error }, { status: access.status });
      }
    }
    const allowed = [
      "name",
      "instance_name",
      "ai_enabled",
      "ai_model",
      "ai_prompt",
      "steps",
      "min_interval_seconds",
      "max_interval_seconds",
      "allowed_start_hour",
      "allowed_end_hour",
      "auto_execute",
      "status",
      "source_status", // coluna do kanban que abastece essa campanha
    ];
    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (body[k] !== undefined) update[k] = body[k];
    }
    if (update.status && !["active", "paused", "draft"].includes(update.status)) {
      return NextResponse.json({ success: false, error: "Status inválido" }, { status: 400 });
    }
    if ("steps" in update) {
      if (!Array.isArray(update.steps) || update.steps.length === 0) {
        return NextResponse.json({ success: false, error: "Inclua pelo menos 1 passo de follow-up." }, { status: 400 });
      }
      for (const s of update.steps) {
        if (typeof s?.day_offset !== "number" || !Number.isFinite(s.day_offset) || s.day_offset < 1) {
          return NextResponse.json({ success: false, error: "Cada passo precisa de day_offset >= 1." }, { status: 400 });
        }
        if (typeof s?.template !== "string" || !s.template.trim()) {
          return NextResponse.json({ success: false, error: "Cada passo precisa de template não vazio." }, { status: 400 });
        }
      }
    }
    if ("min_interval_seconds" in update || "max_interval_seconds" in update) {
      const nextMin = "min_interval_seconds" in update ? Number(update.min_interval_seconds) : (own.minInterval ?? 40);
      const nextMax = "max_interval_seconds" in update ? Number(update.max_interval_seconds) : (own.maxInterval ?? 90);
      if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMin < 5 || nextMax < 5) {
        return NextResponse.json({ success: false, error: "Intervalo mínimo entre envios: 5 s." }, { status: 400 });
      }
      if (nextMin > nextMax) {
        return NextResponse.json({ success: false, error: "min_interval > max_interval" }, { status: 400 });
      }
    }
    const { data, error } = await supabase
      .from("followup_campaigns")
      .update(update)
      .eq("id", id)
      .eq("client_id", own.clientId)
      .select()
      .single();
    if (error) {
      console.error("[followup/PATCH] Erro:", error.message);
      return NextResponse.json({ success: false, error: "Falha ao atualizar follow-up" }, { status: 500 });
    }
    if ("weekend_guard" in body) {
      await supabase
        .from("system_config")
        .upsert(
          { key: `followup_weekend_guard:${id}`, value: body.weekend_guard === true ? "true" : "false" },
          { onConflict: "key" }
        )
        .then(() => undefined, () => undefined);
    }
    return NextResponse.json({ success: true, campaign: data });
  } catch (err: unknown) {
    console.error("[followup/PATCH] Erro inesperado:", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Erro interno ao atualizar follow-up" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsFollowup(req, id);
  if (!own.ok) return own.res;
  const { error } = await supabase
    .from("followup_campaigns")
    .delete()
    .eq("id", id)
    .eq("client_id", own.clientId);
  if (error) {
    console.error("[followup/DELETE] Erro:", error.message);
    return NextResponse.json({ success: false, error: "Falha ao remover follow-up" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
