import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { verifySession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/campaigns — lista campanhas MANUAIS (criadas pelo /disparo).
 *  Filtro: automation_id IS NULL + client_id.
 */
export async function GET(req: NextRequest) {
  const session = await verifySession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("client_id", session.clientId)
    .is("automation_id", null)   // só manuais
    .order("created_at", { ascending: false });
    
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, campaigns: data });
}

/** POST /api/campaigns — cria campanha + targets a partir dos remoteJids */
export async function POST(req: NextRequest) {
  const session = await verifySession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  try {
    const {
      name,
      instance_name,
      message_template,
      min_interval_seconds = 30,
      max_interval_seconds = 60,
      allowed_start_hour = 9,
      allowed_end_hour = 20,
      agent_id,
      lead_ids = [],          // ids da tabela leads_extraidos
      remote_jids = [],       // ou direto remote_jids
      personalize_with_ai = false,
      use_web_search = false,
      ai_model = null,
      ai_prompt = null,
    } = await req.json();

    if (!name || !instance_name || !message_template) {
      return NextResponse.json({ success: false, error: "Faltam campos: name, instance_name, message_template" }, { status: 400 });
    }
    if (Number(min_interval_seconds) < 1 || Number(max_interval_seconds) < 1) {
      return NextResponse.json({ success: false, error: "Intervalo mínimo permitido: 1 segundo" }, { status: 400 });
    }
    if (Number(min_interval_seconds) > Number(max_interval_seconds)) {
      return NextResponse.json({ success: false, error: "min_interval > max_interval" }, { status: 400 });
    }

    // Cria campanha
    const insertPayload: Record<string, any> = {
      client_id: session.clientId,
      name, instance_name, message_template, agent_id: agent_id || null,
      min_interval_seconds, max_interval_seconds, allowed_start_hour, allowed_end_hour,
      personalize_with_ai, use_web_search,
      ai_prompt: ai_prompt || null,
      status: "draft",
    };
    if (ai_model) insertPayload.ai_model = ai_model;

    let { data: camp, error: cErr } = await supabase.from("campaigns").insert(insertPayload).select().single();
    // Se a coluna ai_model ainda não existe, tenta sem ela
    if (cErr && (cErr as any).code === "PGRST204" && "ai_model" in insertPayload) {
      delete insertPayload.ai_model;
      const retry = await supabase.from("campaigns").insert(insertPayload).select().single();
      camp = retry.data as any; cErr = retry.error as any;
      console.warn("[campaigns] coluna ai_model não existe. Rode criar_campaign_logs.sql pra habilitar escolha de modelo por campanha.");
    }
    if (cErr || !camp) return NextResponse.json({ success: false, error: cErr?.message || "Falha ao criar" }, { status: 500 });

    // Resolve leads → targets
    let targetsRows: any[] = [];
    if (lead_ids.length > 0) {
      const { data: leads } = await supabase
        .from("leads_extraidos")
        .select("remoteJid, nome_negocio, ramo_negocio")
        .in("id", lead_ids);
      targetsRows = (leads || []).map(l => ({
        campaign_id: camp.id,
        remote_jid: l.remoteJid,
        nome_negocio: l.nome_negocio,
        ramo_negocio: l.ramo_negocio,
        status: "pending",
      }));
    }
    if (remote_jids.length > 0) {
      for (const j of remote_jids) {
        if (!targetsRows.some(t => t.remote_jid === j)) {
          targetsRows.push({ campaign_id: camp.id, remote_jid: j, status: "pending" });
        }
      }
    }

    if (targetsRows.length > 0) {
      // upsert pra não falhar se houver duplicado
      const { error: tErr } = await supabase.from("campaign_targets").upsert(targetsRows, { onConflict: "campaign_id,remote_jid", ignoreDuplicates: true });
      if (tErr) console.warn("[campaigns] erro ao inserir targets:", tErr.message);
      await supabase.from("campaigns").update({ total_targets: targetsRows.length }).eq("id", camp.id);
    }

    return NextResponse.json({ success: true, campaign: { ...camp, total_targets: targetsRows.length } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
