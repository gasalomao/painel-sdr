import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { startCampaign, pauseCampaign, cancelCampaign, isCampaignActive } from "@/lib/campaign-worker";
import { enforceClientDefaultModel } from "@/lib/enforce-model";

export const dynamic = "force-dynamic";

async function ownsProspeccaoCampaign(req: NextRequest, id: string) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return { ok: false as const, res: ctx.response };
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
  return { ok: true as const, ctx };
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

/** POST /api/prospeccao-sites/campaigns/:id — start | pause | cancel */
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
  return NextResponse.json({ success: false, error: "Ação inválida" }, { status: 400 });
}

/** PATCH — edita campos */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsProspeccaoCampaign(req, id);
  if (!own.ok) return own.res;
  const body = await req.json();
  await enforceClientDefaultModel(body, { clientId: own.ctx.clientId, isAdmin: own.ctx.isAdmin, impersonating: own.ctx.impersonating }, ["ai_model"]);

  const ALLOWED = [
    "name", "instance_name", "message_template",
    "min_interval_seconds", "max_interval_seconds",
    "allowed_start_hour", "allowed_end_hour",
    "personalize_with_ai", "ai_prompt", "ai_model",
  ];
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const k of ALLOWED) if (k in body) update[k] = body[k];

  if ("min_interval_seconds" in update || "max_interval_seconds" in update) {
    const min = Number(update.min_interval_seconds);
    const max = Number(update.max_interval_seconds);
    if (min && min < 1) return NextResponse.json({ success: false, error: "Intervalo mínimo: 1s" }, { status: 400 });
    if (min && max && min > max) return NextResponse.json({ success: false, error: "min > max" }, { status: 400 });
  }

  const { data, error } = await supabase.from("campaigns").update(update).eq("id", id).select().single();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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