import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { requireFeatureAccess } from "@/lib/saas-limits";
import { validateCampaignInstanceAccess } from "@/lib/campaign-instance-access";
import { startCampaign, pauseCampaign, cancelCampaign, resetCampaign, isCampaignActive } from "@/lib/campaign-worker";
import { enforceClientDefaultModel } from "@/lib/enforce-model";
import { serializeWeekendB2BGuardMode } from "@/lib/campaign-pool";
import { saveCampaignAbConfig } from "@/lib/campaign-ab-testing";

export const dynamic = "force-dynamic";

async function ownsProspeccaoCampaign(req: NextRequest, id: string) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return { ok: false as const, res: ctx.response };
  const denied = requireFeatureAccess(ctx, "prospeccao_sites");
  if (denied) return { ok: false as const, res: denied };
  const { data } = await supabase
    .from("campaigns")
    .select("client_id, campaign_type")
    .eq("id", id)
    .maybeSingle();
  if (!data) return { ok: false as const, res: NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 }) };
  if (data.campaign_type !== "prospeccao_sites") {
    return { ok: false as const, res: NextResponse.json({ success: false, error: "Campanha não é de prospecção sites" }, { status: 403 }) };
  }
  if (!ctx.isAdmin && data.client_id !== ctx.clientId) {
    return { ok: false as const, res: NextResponse.json({ success: false, error: "Sem permissão" }, { status: 403 }) };
  }
  return { ok: true as const, ctx, ownerClientId: data.client_id || ctx.clientId };
}

/** GET /api/prospeccao-sites/campaigns/:id — detalhes + targets + logs */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsProspeccaoCampaign(req, id);
  if (!own.ok) return own.res;
  const { data: campaign } = await supabase.from("campaigns").select("*").eq("id", id).single();
  if (!campaign) return NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 });
  const { data: targets } = await supabase.from("campaign_targets").select("*").eq("campaign_id", id).order("created_at");
  const { data: logs } = await supabase.from("campaign_logs").select("*").eq("campaign_id", id).order("created_at", { ascending: false }).limit(200);
  return NextResponse.json({ success: true, campaign, targets, logs, active_in_memory: isCampaignActive(id) });
}

/** POST /api/prospeccao-sites/campaigns/:id — start | pause | cancel | reset */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsProspeccaoCampaign(req, id);
  if (!own.ok) return own.res;
  const { action } = await req.json();
  if (action === "start") {
    const r = await startCampaign(id);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, status: "running" });
  }
  if (action === "pause")  { await pauseCampaign(id);  return NextResponse.json({ success: true, status: "paused" }); }
  if (action === "cancel") { await cancelCampaign(id); return NextResponse.json({ success: true, status: "cancelled" }); }
  if (action === "reset")  {
    const r = await resetCampaign(id);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, status: "draft" });
  }
  return NextResponse.json({ success: false, error: "Ação inválida" }, { status: 400 });
}

/** PATCH — edita campos */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsProspeccaoCampaign(req, id);
  if (!own.ok) return own.res;
  const body = await req.json();
  await enforceClientDefaultModel(body, { clientId: own.ctx.clientId, isAdmin: own.ctx.isAdmin, impersonating: own.ctx.impersonating }, ["ai_model"]);

  if ("instance_name" in body) {
    const access = await validateCampaignInstanceAccess(own.ownerClientId, String(body.instance_name));
    if (!access.ok) {
      return NextResponse.json({ success: false, error: access.error }, { status: access.status });
    }
  }

  const ALLOWED = [
    "name", "instance_name", "message_template",
    "min_interval_seconds", "max_interval_seconds",
    "allowed_start_hour", "allowed_end_hour",
    "personalize_with_ai", "ai_prompt", "ai_model",
    "humanize_messages", "max_daily_previews", "approach_strategy",
  ];
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const k of ALLOWED) if (k in body) update[k] = body[k];

  if ("min_interval_seconds" in update || "max_interval_seconds" in update) {
    const min = Number(update.min_interval_seconds);
    const max = Number(update.max_interval_seconds);
    if (!own.ctx.isAdmin && Number.isFinite(min) && min < 15) {
      return NextResponse.json(
        { success: false, error: "Intervalo mínimo permitido para disparo é de 15 segundos." },
        { status: 400 }
      );
    }
    if (min && min < 1) return NextResponse.json({ success: false, error: "Intervalo mínimo: 1s" }, { status: 400 });
    if (min && max && min > max) return NextResponse.json({ success: false, error: "min > max" }, { status: 400 });
  }

  let { data, error } = await supabase.from("campaigns").update(update).eq("id", id).select().single();
  if (error && ((error as any).code === "PGRST204" || (error as any).code === "42703")) {
    delete update.max_daily_previews;
    delete update.approach_strategy;
    const retry = await supabase.from("campaigns").update(update).eq("id", id).select().single();
    data = retry.data;
    error = retry.error;
  }
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  if ("antiban_mixer" in body) {
    await supabase
      .from("app_settings")
      .upsert(
        { key: `campaign_antiban:${id}`, value: body.antiban_mixer !== false ? "true" : "false" },
        { onConflict: "key" }
      )
      .then(() => undefined, () => undefined);
  }
  if ("weekend_guard" in body) {
    await supabase
      .from("app_settings")
      .upsert(
        { key: `campaign_weekend_guard:${id}`, value: serializeWeekendB2BGuardMode(body.weekend_guard) },
        { onConflict: "key" }
      )
      .then(() => undefined, () => undefined);
  }
  if ("cold_shield" in body) {
    await supabase
      .from("app_settings")
      .upsert(
        { key: `campaign_cold_shield:${id}`, value: body.cold_shield !== false ? "true" : "false" },
        { onConflict: "key" }
      )
      .then(() => undefined, () => undefined);
  }
  if (body.ab_test && typeof body.ab_test === "object") {
    const abObj = body.ab_test as Record<string, unknown>;
    await saveCampaignAbConfig(id, {
      enabled: Boolean(abObj.enabled),
      variantA_label: typeof abObj.variantA_label === "string" ? abObj.variantA_label : undefined,
      variantA_template:
        typeof body.message_template === "string" ? body.message_template : (data?.message_template ?? ""),
      variantB_label: typeof abObj.variantB_label === "string" ? abObj.variantB_label : undefined,
      variantB_template: typeof abObj.variantB_template === "string" ? abObj.variantB_template : "",
      paused_variant: abObj.reset_pause ? null : undefined,
      paused_reason: abObj.reset_pause ? null : undefined,
    }).catch(() => undefined);
  }

  return NextResponse.json({ success: true, campaign: data });
}

/** DELETE */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsProspeccaoCampaign(req, id);
  if (!own.ok) return own.res;
  await cancelCampaign(id).catch(() => {});
  await supabase.from("campaigns").delete().eq("id", id);
  return NextResponse.json({ success: true });
}