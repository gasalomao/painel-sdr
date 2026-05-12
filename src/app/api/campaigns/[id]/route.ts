import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { startCampaign, pauseCampaign, cancelCampaign, isCampaignActive } from "@/lib/campaign-worker";

export const dynamic = "force-dynamic";

/** GET /api/campaigns/:id — detalhes + targets + progresso */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: campaign } = await supabase.from("campaigns").select("*").eq("id", id).single();
  if (!campaign) return NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 });
  const { data: targets } = await supabase.from("campaign_targets").select("*").eq("campaign_id", id).order("created_at");
  return NextResponse.json({ success: true, campaign, targets, active_in_memory: isCampaignActive(id) });
}

/** POST /api/campaigns/:id — ações: start | pause | cancel */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

/** PATCH /api/campaigns/:id — edita campos da campanha (não mexe nos targets) */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  // Só deixa editar campos seguros (não mexer em status, counters, etc)
  const ALLOWED_FIELDS = [
    "name", "instance_name", "message_template", "agent_id",
    "min_interval_seconds", "max_interval_seconds",
    "allowed_start_hour", "allowed_end_hour",
    "personalize_with_ai", "use_web_search", "ai_prompt", "ai_model",
  ];
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const k of ALLOWED_FIELDS) {
    if (k in body) update[k] = body[k];
  }

  // Validações básicas
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

/** DELETE /api/campaigns/:id — apaga campanha (cascade nos targets) */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await cancelCampaign(id).catch(() => {});
  await supabase.from("campaigns").delete().eq("id", id);
  return NextResponse.json({ success: true });
}
