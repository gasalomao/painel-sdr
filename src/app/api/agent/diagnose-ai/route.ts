/**
 * GET /api/agent/diagnose-ai?remote_jid=<jid>&instance=<name>
 *
 * Diagnóstico em runtime: por que a IA NÃO respondeu (ou está respondendo)
 * pra esse contato/instância. Junta tudo num só lugar pro admin/cliente ver
 * a resposta sem precisar abrir 4 tabelas no banco.
 *
 * Retorna:
 *   - logs: últimos eventos relevantes em webhook_logs (filtrados pelos
 *     event types que indicam falha do agente)
 *   - state: snapshot de tudo que afeta a IA decisão (agente, key, modelo,
 *     bot_status da sessão, pausa global)
 *   - verdict: 1 string clara explicando o motivo mais provável
 *
 * Multi-tenant: cliente vê só sua própria instância. Admin vê qualquer.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId, clientIdFromInstance } from "@/lib/tenant";
import { getOrganizerConfig } from "@/lib/organizer-config-cache";
import { resolveModelForClient } from "@/lib/ai-default-model";
import { getInternalSecret } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

const FAILURE_EVENTS = [
  "WEBHOOK_SECRET_REJECTED",
  "WEBHOOK_SECRET_MISMATCH",
  "AGENT_INACTIVE",
  "AGENT_NO_API_KEY",
  "AGENT_NO_MODEL",
  "AGENT_DISPATCH_NO_SECRET",
  "AGENT_DISPATCH_FETCH_FAIL",
  "AGENT_SKIP_PAUSED",
  "AGENT_CRITICAL_ERROR",
  "AGENT_SEND_ERROR",
  "WEBHOOK_SESSION_FAIL",
];

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const instanceName = req.nextUrl.searchParams.get("instance") || "";
  const remoteJid = req.nextUrl.searchParams.get("remote_jid") || "";
  if (!instanceName) {
    return NextResponse.json({ ok: false, error: "instance é obrigatório" }, { status: 400 });
  }

  // Ownership: cliente comum só pode diagnosticar a própria instância.
  if (!auth.isAdmin) {
    const owner = await clientIdFromInstance(instanceName);
    if (owner && owner !== auth.clientId) {
      return NextResponse.json({ ok: false, error: "Instância não pertence a este cliente" }, { status: 403 });
    }
  }

  // 1) Últimos eventos de falha em webhook_logs (últimas 24h)
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: logs } = await supabaseAdmin
    .from("webhook_logs")
    .select("event, payload, created_at")
    .eq("instance_name", instanceName)
    .in("event", FAILURE_EVENTS)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  // 2) Estado da instância
  const { data: conn } = await supabaseAdmin
    .from("channel_connections")
    .select("instance_name, provider, status, agent_id, client_id, provider_config")
    .eq("instance_name", instanceName)
    .maybeSingle();

  // 3) Estado do agente vinculado
  let agent: any = null;
  if (conn?.agent_id) {
    const { data: a } = await supabaseAdmin
      .from("agent_settings")
      .select("id, name, is_active, target_model, main_prompt")
      .eq("id", conn.agent_id)
      .maybeSingle();
    agent = a;
  }

  // 4) API Key Gemini configurada?
  const orgCfg = await getOrganizerConfig();
  const hasApiKey = !!(orgCfg?.api_key && orgCfg.api_key.trim());

  // 5) Modelo IA efetivo pra esse cliente
  const effectiveModel = await resolveModelForClient(conn?.client_id || auth.clientId);

  // 6) Bot status / pausa pra esse contato (se passou remote_jid)
  let session: any = null;
  let globalPause: any = null;
  if (remoteJid) {
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("remote_jid", remoteJid)
      .maybeSingle();
    if (contact) {
      const { data: s } = await supabaseAdmin
        .from("sessions")
        .select("id, bot_status, paused_by, paused_at, resume_at")
        .eq("contact_id", contact.id)
        .eq("instance_name", instanceName)
        .maybeSingle();
      session = s;
    }
    // Pausa global por instância
    const { data: gp } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `global_ai_paused_until:${instanceName}`)
      .maybeSingle();
    if (gp?.value) globalPause = { until: gp.value, scope: "instance" };
  }

  // 7) Internal secret
  const hasInternalSecret = !!getInternalSecret();

  // 8) Veredito
  let verdict = "Tudo parece OK. Se IA não respondeu, manda uma mensagem teste e roda este diagnóstico de novo.";
  let actionable: string | null = null;

  if (!conn) {
    verdict = `Instância "${instanceName}" não existe em channel_connections.`;
    actionable = "Vá em /whatsapp e crie/registre a instância antes.";
  } else if (!conn.agent_id) {
    verdict = "Instância não tem agent_id vinculado.";
    actionable = "Vá em /agente e vincule a instância a um agente.";
  } else if (!agent) {
    verdict = `agent_id=${conn.agent_id} não existe em agent_settings.`;
    actionable = "Vá em /agente e recrie/relink o agente.";
  } else if (!agent.is_active) {
    verdict = `Agente "${agent.name}" está DESATIVADO.`;
    actionable = "Vá em /agente e ative o agente (toggle 'Ativo').";
  } else if (!hasApiKey) {
    verdict = "API Key Gemini NÃO configurada globalmente.";
    actionable = "Vá em /configuracoes → Organizador IA → cole a API Key Gemini.";
  } else if (!effectiveModel) {
    verdict = "Modelo IA NÃO configurado.";
    actionable = "Vá em /configuracoes → Organizador IA → escolha um modelo. Ou em /admin/clientes → cliente → 'Modelo IA padrão'.";
  } else if (!hasInternalSecret) {
    verdict = "AUTH_SECRET vazio no servidor (env).";
    actionable = "Admin do deploy: configure AUTH_SECRET ou SUPABASE_SERVICE_ROLE_KEY no Easypanel.";
  } else if (session?.bot_status && session.bot_status !== "bot_active") {
    verdict = `IA pausada pra este contato (status=${session.bot_status}).`;
    actionable = "Clique no botão Play/Resume na conversa, ou desfaça a pausa manual.";
  } else if (globalPause) {
    verdict = `IA pausada GLOBALMENTE nesta instância até ${globalPause.until}.`;
    actionable = "Vá no chat e clique em 'Despausar IA' no topo.";
  } else if (logs && logs.length > 0) {
    const latest = logs[0];
    verdict = `Último evento de falha: ${latest.event} em ${new Date(latest.created_at).toLocaleString("pt-BR")}.`;
    actionable = "Veja o payload abaixo pro detalhe técnico.";
  } else if (conn.status !== "open") {
    verdict = `Instância está com status="${conn.status}" (não conectada).`;
    actionable = "Vá em /whatsapp e reconecte (escaneie QR de novo).";
  }

  return NextResponse.json({
    ok: true,
    verdict,
    actionable,
    state: {
      instance: conn ? {
        name: conn.instance_name,
        status: conn.status,
        provider: conn.provider,
        agent_id: conn.agent_id,
        has_webhook_secret: !!((conn.provider_config as any)?.webhook_secret),
      } : null,
      agent: agent ? {
        id: agent.id,
        name: agent.name,
        is_active: agent.is_active,
        has_prompt: !!agent.main_prompt?.trim(),
      } : null,
      hasApiKey,
      effectiveModel,
      hasInternalSecret,
      session: session ? {
        bot_status: session.bot_status,
        paused_until: session.resume_at,
      } : null,
      globalPause,
    },
    logs: (logs || []).map((l: any) => ({
      event: l.event,
      created_at: l.created_at,
      payload: l.payload,
    })),
  });
}
