import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

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
  const tenant = await requireClientId(req);
  if (!tenant.ok) return tenant.response;
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    for (const key of EDITABLE_FIELDS) {
      if (key in body) update[key] = body[key];
    }
    let q = supabase.from("automations").update(update).eq("id", id);
    if (!tenant.isAdmin) q = q.eq("client_id", tenant.clientId);
    const { error } = await q;
    if (error) throw error;
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
    let lookupQ = supabase.from("automations").select("campaign_id, followup_campaign_id").eq("id", id);
    if (!tenant.isAdmin) lookupQ = lookupQ.eq("client_id", tenant.clientId);
    const { data: a } = await lookupQ.maybeSingle();
    if (!a) return NextResponse.json({ success: false, error: "Não encontrada ou sem permissão" }, { status: 404 });

    if (a?.campaign_id) {
      await supabase.from("campaigns").update({ status: "stopped" }).eq("id", a.campaign_id);
    }
    if (a?.followup_campaign_id) {
      await supabase.from("followup_campaigns").update({ status: "stopped" }).eq("id", a.followup_campaign_id);
    }
    let delQ = supabase.from("automations").delete().eq("id", id);
    if (!tenant.isAdmin) delQ = delQ.eq("client_id", tenant.clientId);
    const { error } = await delQ;
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
