import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { enforceClientDefaultModel } from "@/lib/enforce-model";
import { requireClientId } from "@/lib/tenant";
import { requireFeatureAccess } from "@/lib/saas-limits";
import { validateCampaignInstanceAccess, validateClientAgentAccess } from "@/lib/campaign-instance-access";
import { computePriority } from "@/lib/prospeccao-priority";
import { parseWeekendB2BGuardMode, serializeWeekendB2BGuardMode } from "@/lib/campaign-pool";
import { saveCampaignAbConfig } from "@/lib/campaign-ab-testing";

export const dynamic = "force-dynamic";

/** GET /api/campaigns — lista campanhas MANUAIS (criadas pelo /disparo).
 *  Filtro: automation_id IS NULL + client_id.
 */
export async function GET(req: NextRequest) {
  const session = await requireClientId(req);
  if (!session.ok) return session.response;
  const denied = requireFeatureAccess(session, "disparo");
  if (denied) return denied;

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

  // As opções anti-ban vivem em app_settings (chave por campanha). Sem este
  // merge, reabrir a campanha para edição perderia o estado dos switches.
  const campaigns = (data || []) as Array<Record<string, any>>;
  const ids = campaigns.map((c) => c?.id).filter(Boolean);
  const flagMap = new Map<string, string>();
  if (ids.length > 0) {
    const keys = ids.flatMap((id: string) => [
      `campaign_antiban:${id}`,
      `campaign_weekend_guard:${id}`,
      `campaign_cold_shield:${id}`,
      `campaign_ab_config:${id}`,
    ]);
    try {
      const { data: cfgRows } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", keys);
      for (const row of cfgRows || []) {
        if (row?.key) flagMap.set(String(row.key), String(row.value ?? ""));
      }
    } catch {}
  }
  const readFlag = (id: string, name: string, fallback: boolean): boolean => {
    const raw = flagMap.get(`${name}:${id}`);
    if (raw === undefined) return fallback;
    return raw === "true" || raw === "1";
  };
  for (const c of campaigns) {
    if (!c?.id) continue;
    c.antiban_mixer = readFlag(c.id, "campaign_antiban", true);
    const rawWg = flagMap.get(`campaign_weekend_guard:${c.id}`);
    c.weekend_guard = rawWg !== undefined ? parseWeekendB2BGuardMode(rawWg) : false;
    c.cold_shield = readFlag(c.id, "campaign_cold_shield", true);
    const rawAb = flagMap.get(`campaign_ab_config:${c.id}`);
    if (rawAb) {
      try {
        c.ab_test = JSON.parse(rawAb);
      } catch {}
    }
  }

  return NextResponse.json({ success: true, campaigns });
}

/** POST /api/campaigns — cria campanha + targets a partir dos remoteJids */
export async function POST(req: NextRequest) {
  const session = await requireClientId(req);
  if (!session.ok) return session.response;
  const denied = requireFeatureAccess(session, "disparo");
  if (denied) return denied;

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
      cold_shield = true,
      prioritize_by_score = true,
      ai_model = null,
      ai_prompt = null,
      media_url = null,
      media_type = null,
      media_caption = null,
      media_file_name = null,
      media_mimetype = null,
      max_daily_previews = 0,
      approach_strategy = "mentor_2step",
      ab_test = null,
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
    const useScorePriority = prioritize_by_score !== false;
    type SelectedCampaignLead = {
      id: number;
      remoteJid: string;
      nome_negocio: string | null;
      ramo_negocio: string | null;
      avaliacao?: string | number | null;
      reviews?: string | number | null;
      created_at?: string | null;
      business_details?: Record<string, unknown> | null;
    };
    let selectedLeads: SelectedCampaignLead[] = [];
    if (requestedLeadIds.length > 0) {
      let { data: leads, error: leadsError } = await supabase
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio, avaliacao, reviews, created_at, business_details")
        .eq("client_id", session.clientId)
        .in("id", requestedLeadIds);
      if (leadsError && (leadsError.code === "PGRST204" || /business_details|avaliacao|reviews/i.test(leadsError.message))) {
        const retry = await supabase
          .from("leads_extraidos")
          .select("id, remoteJid, nome_negocio, ramo_negocio")
          .eq("client_id", session.clientId)
          .in("id", requestedLeadIds);
        leads = retry.data as typeof leads;
        leadsError = retry.error;
      }
      if (leadsError) {
        return NextResponse.json({ success: false, error: leadsError.message }, { status: 500 });
      }
      selectedLeads = (leads || []) as SelectedCampaignLead[];
      if (selectedLeads.length !== requestedLeadIds.length) {
        return NextResponse.json({ success: false, error: "Um ou mais leads não pertencem a este cliente" }, { status: 403 });
      }
      if (useScorePriority) {
        selectedLeads = [...selectedLeads].sort(
          (a, b) => computePriority(b, "qualification", "desc") - computePriority(a, "qualification", "desc"),
        );
      }
    }

    if (!session.isAdmin && Number(min_interval_seconds) < 15) {
      return NextResponse.json(
        { success: false, error: "Intervalo mínimo permitido para disparo é de 15 segundos." },
        { status: 400 }
      );
    }

    // Cria campanha
    const insertPayload: Record<string, any> = {
      client_id: session.clientId,
      name, instance_name, message_template, agent_id: agentAccess.agentId,
      min_interval_seconds, max_interval_seconds, allowed_start_hour, allowed_end_hour,
      personalize_with_ai,
      use_web_search: session.isAdmin ? Boolean(use_web_search) : false,
      humanize_messages,
      ai_prompt: ai_prompt || null,
      media_url: media_url || null,
      media_type: media_type || null,
      media_caption: media_caption || null,
      media_file_name: media_file_name || null,
      media_mimetype: media_mimetype || null,
      max_daily_previews: Math.max(0, Math.floor(Number(max_daily_previews) || 0)),
      approach_strategy: String(approach_strategy || "mentor_2step"),
      status: "draft",
    };
    if (ai_model) insertPayload.ai_model = ai_model;

    let { data: camp, error: cErr } = await supabase.from("campaigns").insert(insertPayload).select().single();
    if (cErr && ((cErr as any).code === "PGRST204" || (cErr as any).code === "42703")) {
      delete insertPayload.ai_model;
      delete insertPayload.max_daily_previews;
      delete insertPayload.approach_strategy;
      const retry = await supabase.from("campaigns").insert(insertPayload).select().single();
      camp = retry.data as any; cErr = retry.error as any;
    }
    if (cErr || !camp) {
      console.error("[campaigns/POST] Erro ao criar:", cErr?.message);
      return NextResponse.json({ success: false, error: "Falha ao criar campanha" }, { status: 500 });
    }

    try {
      await supabase
        .from("app_settings")
        .upsert([
          { key: `campaign_antiban:${camp.id}`, value: String(Boolean(antiban_mixer)) },
          {
            key: `campaign_weekend_guard:${camp.id}`,
            value: serializeWeekendB2BGuardMode(weekend_guard),
          },
          { key: `campaign_cold_shield:${camp.id}`, value: String(cold_shield !== false) },
        ], { onConflict: "key" });
    } catch {}

    if (ab_test && typeof ab_test === "object") {
      try {
        const abObj = ab_test as Record<string, unknown>;
        await saveCampaignAbConfig(camp.id, {
          enabled: Boolean(abObj.enabled),
          variantA_label: typeof abObj.variantA_label === "string" ? abObj.variantA_label : undefined,
          variantA_template: String(message_template),
          variantB_label: typeof abObj.variantB_label === "string" ? abObj.variantB_label : undefined,
          variantB_template: typeof abObj.variantB_template === "string" ? abObj.variantB_template : "",
        });
      } catch {}
    }

    // Resolve leads → targets (priorizados por Score ICP quando habilitado)
    const targetsRows: Array<Record<string, unknown>> = selectedLeads
      .filter((lead) => !!lead.remoteJid)
      .map((lead) => ({
        campaign_id: camp.id,
        client_id: session.clientId,
        remote_jid: lead.remoteJid,
        nome_negocio: lead.nome_negocio,
        ramo_negocio: lead.ramo_negocio,
        status: "pending",
        ...(useScorePriority ? { priority: computePriority(lead, "qualification", "desc") } : {}),
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
      // upsert pra não falhar se houver duplicado; retry sem priority caso a coluna ainda não exista no banco
      let { error: tErr } = await supabase.from("campaign_targets").upsert(targetsRows, { onConflict: "campaign_id,remote_jid", ignoreDuplicates: true });
      if (tErr && tErr.code === "PGRST204") {
        const fallbackRows = targetsRows.map((row) => {
          const rest = { ...row };
          delete rest.priority;
          return rest;
        });
        const retry = await supabase.from("campaign_targets").upsert(fallbackRows, { onConflict: "campaign_id,remote_jid", ignoreDuplicates: true });
        tErr = retry.error;
      }
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
