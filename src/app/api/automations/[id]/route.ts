import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

/**
 * GET    /api/automations/:id    → detalhes
 * PATCH  /api/automations/:id    → edita campos (apenas em status=draft|paused|done|error)
 * DELETE /api/automations/:id    → remove + para campanhas vinculadas
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { data, error } = await supabase.from("automations").select("*").eq("id", id).maybeSingle();
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
  "dispatch_ai_model",
  "dispatch_ai_prompt",
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
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    for (const key of EDITABLE_FIELDS) {
      if (key in body) update[key] = body[key];
    }
    const { error } = await supabase.from("automations").update(update).eq("id", id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    // Pega referências pra também parar campanhas filhas.
    const { data: a } = await supabase
      .from("automations")
      .select("campaign_id, followup_campaign_id")
      .eq("id", id)
      .maybeSingle();
    if (a?.campaign_id) {
      await supabase.from("campaigns").update({ status: "stopped" }).eq("id", a.campaign_id);
    }
    if (a?.followup_campaign_id) {
      await supabase.from("followup_campaigns").update({ status: "stopped" }).eq("id", a.followup_campaign_id);
    }
    const { error } = await supabase.from("automations").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
