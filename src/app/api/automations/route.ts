import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET  /api/automations             → lista do cliente atual (admin vê todas)
 * POST /api/automations             → cria nova (status='draft', phase='idle')
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;

    let q = supabase.from("automations").select("*").order("created_at", { ascending: false });
    if (!ctx.isAdmin) q = q.eq("client_id", ctx.clientId);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ success: true, automations: data || [] });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

// Defaults SEGUROS pra WhatsApp (Evolution / Baileys). Anti-banimento:
//   - 60-180s aleatório entre disparos (média ~2 min) = ~30 envios/hora
//   - 60-240s aleatório entre follow-ups (mais humano)
//   - Janela 09-20h (horário comercial padrão)
const DEFAULTS = {
  scrape_max_leads: 200,
  dispatch_min_interval: 60,
  dispatch_max_interval: 180,
  followup_min_interval: 60,
  followup_max_interval: 240,
  allowed_start_hour: 9,
  allowed_end_hour: 20,
};

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;

    const body = await req.json();
    if (!body?.name?.trim()) {
      return NextResponse.json({ success: false, error: "name é obrigatório" }, { status: 400 });
    }
    if (!body?.instance_name?.trim()) {
      return NextResponse.json({ success: false, error: "instance_name é obrigatório" }, { status: 400 });
    }

    const row = {
      client_id: ctx.clientId,
      name: String(body.name).trim(),
      agent_id: body.agent_id ? Number(body.agent_id) : null,
      instance_name: String(body.instance_name).trim(),
      niches: Array.isArray(body.niches) ? body.niches : [],
      regions: Array.isArray(body.regions) ? body.regions : [],
      scrape_filters: body.scrape_filters || {},
      scrape_max_leads: Number(body.scrape_max_leads ?? DEFAULTS.scrape_max_leads),
      dispatch_template: body.dispatch_template || "",
      dispatch_min_interval: Number(body.dispatch_min_interval ?? DEFAULTS.dispatch_min_interval),
      dispatch_max_interval: Number(body.dispatch_max_interval ?? DEFAULTS.dispatch_max_interval),
      dispatch_personalize: !!body.dispatch_personalize,
      dispatch_ai_model: body.dispatch_ai_model || null,
      dispatch_ai_prompt: body.dispatch_ai_prompt || null,
      lead_intelligence_enabled: !!body.lead_intelligence_enabled,
      followup_enabled: body.followup_enabled !== false, // default TRUE; só FALSE se vier explicitamente
      followup_steps: Array.isArray(body.followup_steps) ? body.followup_steps : [],
      followup_min_interval: Number(body.followup_min_interval ?? DEFAULTS.followup_min_interval),
      followup_max_interval: Number(body.followup_max_interval ?? DEFAULTS.followup_max_interval),
      followup_ai_enabled: !!body.followup_ai_enabled,
      followup_ai_model: body.followup_ai_model || null,
      followup_ai_prompt: body.followup_ai_prompt || null,
      allowed_start_hour: Number(body.allowed_start_hour ?? DEFAULTS.allowed_start_hour),
      allowed_end_hour: Number(body.allowed_end_hour ?? DEFAULTS.allowed_end_hour),
      status: "draft",
      phase: "idle",
    };

    const { data, error } = await supabase.from("automations").insert(row).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, automation: data });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
