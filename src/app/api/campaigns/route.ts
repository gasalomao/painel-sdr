import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { enforceClientDefaultModel } from "@/lib/enforce-model";
import { requireClientId } from "@/lib/tenant";
import { validateCampaignInstanceAccess, validateClientAgentAccess } from "@/lib/campaign-instance-access";

export const dynamic = "force-dynamic";

/** GET /api/campaigns — lista campanhas MANUAIS (criadas pelo /disparo).
 *  Filtro: automation_id IS NULL + client_id.
 */
export async function GET(req: NextRequest) {
  const session = await requireClientId(req);
  if (!session.ok) return session.response;

  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("client_id", session.clientId)
    .is("automation_id", null)   // só manuais
    .order("created_at", { ascending: false });
    
  if (error) {
    console.error("[campaigns/GET] Erro:", error.message);
    return NextResponse.json({ success: false, error: "Falha ao listar campanhas" }, { status: 500 });
  }
  return NextResponse.json({ success: true, campaigns: data });
}

/** POST /api/campaigns — cria campanha + targets a partir dos remoteJids */
export async function POST(req: NextRequest) {
  const session = await requireClientId(req);
  if (!session.ok) return session.response;

  try {
    const body = await req.json();
    // SaaS guard: cliente comum NÃO pode escolher modelo arbitrário. Backend
    // sobrescreve body.ai_model pelo client.default_ai_model. Admin não-
    // impersonando passa livre. Idempotente.
    await enforceClientDefaultModel(body, session, ["ai_model"]);
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
      humanize_messages = false,
      antiban_mixer = true,
      weekend_guard = false,
      ai_model = null,
      ai_prompt = null,
      media_url = null,
      media_type = null,
      media_caption = null,
      media_file_name = null,
      media_mimetype = null,
    } = body;

    if (!name || !instance_name || !message_template) {
      return NextResponse.json({ success: false, error: "Faltam campos: name, instance_name, message_template" }, { status: 400 });
    }
    if (Number(min_interval_seconds) < 1 || Number(max_interval_seconds) < 1) {
      return NextResponse.json({ success: false, error: "Intervalo mínimo permitido: 1 segundo" }, { status: 400 });
    }
    if (Number(min_interval_seconds) > Number(max_interval_seconds)) {
      return NextResponse.json({ success: false, error: "min_interval > max_interval" }, { status: 400 });
    }
    const access = await validateCampaignInstanceAccess(session.clientId, String(instance_name));
    if (!access.ok) {
      return NextResponse.json({ success: false, error: access.error }, { status: access.status });
    }
    const agentAccess = await validateClientAgentAccess(session.clientId, agent_id);
    if (!agentAccess.ok) {
      return NextResponse.json({ success: false, error: agentAccess.error }, { status: agentAccess.status });
    }

    const requestedLeadIds = Array.isArray(lead_ids) ? [...new Set(lead_ids.map(Number).filter(Number.isInteger))] : [];
    let selectedLeads: Array<{ id: number; remoteJid: string; nome_negocio: string | null; ramo_negocio: string | null }> = [];
    if (requestedLeadIds.length > 0) {
      const { data: leads, error: leadsError } = await supabase
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio")
        .eq("client_id", session.clientId)
        .in("id", requestedLeadIds);
      if (leadsError) {
        return NextResponse.json({ success: false, error: leadsError.message }, { status: 500 });
      }
      selectedLeads = leads || [];
      if (selectedLeads.length !== requestedLeadIds.length) {
        return NextResponse.json({ success: false, error: "Um ou mais leads não pertencem a este cliente" }, { status: 403 });
      }
    }

    // Cria campanha
    const insertPayload: Record<string, any> = {
      client_id: session.clientId,
      name, instance_name, message_template, agent_id: agentAccess.agentId,
      min_interval_seconds, max_interval_seconds, allowed_start_hour, allowed_end_hour,
      personalize_with_ai, use_web_search, humanize_messages,
      ai_prompt: ai_prompt || null,
      media_url: media_url || null,
      media_type: media_type || null,
      media_caption: media_caption || null,
      media_file_name: media_file_name || null,
      media_mimetype: media_mimetype || null,
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
    if (cErr || !camp) {
      console.error("[campaigns/POST] Erro ao criar:", cErr?.message);
      return NextResponse.json({ success: false, error: "Falha ao criar campanha" }, { status: 500 });
    }

    try {
      await supabase
        .from("system_config")
        .upsert([
          { key: `campaign_antiban:${camp.id}`, value: String(Boolean(antiban_mixer)) },
          { key: `campaign_weekend_guard:${camp.id}`, value: String(Boolean(weekend_guard)) },
        ], { onConflict: "key" });
    } catch {}

    // Resolve leads → targets
    const targetsRows: Array<Record<string, unknown>> = selectedLeads
      .filter((lead) => !!lead.remoteJid)
      .map((lead) => ({
        campaign_id: camp.id,
        client_id: session.clientId,
        remote_jid: lead.remoteJid,
        nome_negocio: lead.nome_negocio,
        ramo_negocio: lead.ramo_negocio,
        status: "pending",
      }));
    if (Array.isArray(remote_jids)) {
      for (const value of remote_jids) {
        const remoteJid = typeof value === "string" ? value.trim() : "";
        if (remoteJid && !targetsRows.some((target) => target.remote_jid === remoteJid)) {
          targetsRows.push({ campaign_id: camp.id, client_id: session.clientId, remote_jid: remoteJid, status: "pending" });
        }
      }
    }

    if (targetsRows.length > 0) {
      // upsert pra não falhar se houver duplicado
      const { error: tErr } = await supabase.from("campaign_targets").upsert(targetsRows, { onConflict: "campaign_id,remote_jid", ignoreDuplicates: true });
      if (tErr) {
        console.error("[campaigns/POST] Erro targets:", tErr.message);
        await supabase.from("campaigns").delete().eq("id", camp.id).eq("client_id", session.clientId);
        return NextResponse.json({ success: false, error: "Falha ao registrar destinatários da campanha" }, { status: 500 });
      }
      await supabase.from("campaigns").update({ total_targets: targetsRows.length }).eq("id", camp.id).eq("client_id", session.clientId);
    }

    return NextResponse.json({ success: true, campaign: { ...camp, total_targets: targetsRows.length } });
  } catch (err: unknown) {
    console.error("[campaigns/POST] Erro inesperado:", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Erro interno ao criar campanha" }, { status: 500 });
  }
}
