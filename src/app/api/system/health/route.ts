import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { getAiKeys } from "@/lib/ai-keys";
import { getInternalSecret } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

export type HealthStatus = "ok" | "warn" | "error";

export interface SystemHealthCheck {
  id: "whatsapp" | "ai" | "calendar" | "workers_db";
  title: string;
  status: HealthStatus;
  summary: string;
  actionHint?: string;
}

function isMissingFunctionError(msg: string | undefined): boolean {
  if (!msg) return false;
  return /could not find the function|function .* does not exist|schema cache/i.test(msg);
}

/**
 * GET /api/system/health
 * Painel consolidado de saúde operacional do tenant + workers/migrations críticas.
 * Nunca expõe chaves, tokens ou PII.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  if (!supabaseAdmin) {
    return NextResponse.json({
      success: false,
      overall: "error" as HealthStatus,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          id: "workers_db",
          title: "Banco e Workers",
          status: "error",
          summary: "Cliente administrativo do Supabase não configurado.",
          actionHint: "Defina SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente.",
        },
      ],
    }, { status: 500 });
  }

  const checks: SystemHealthCheck[] = [];

  // 1. WhatsApp & Webhooks do tenant
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [connsRes, logsRes] = await Promise.all([
      supabaseAdmin
        .from("channel_connections")
        .select("instance_name, status, provider")
        .eq("client_id", auth.clientId),
      supabaseAdmin
        .from("webhook_logs")
        .select("event, created_at")
        .eq("client_id", auth.clientId)
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false })
        .limit(40),
    ]);

    const conns = (connsRes.data || []) as Array<{ instance_name?: string; status?: string; provider?: string }>;
    const connected = conns.filter((c) => {
      const st = String(c.status || "").toLowerCase();
      return st === "open" || st === "connected";
    });
    const logs = (logsRes.data || []) as Array<{ event?: string }>;
    const hasSecret = Boolean(getInternalSecret());
    const recentCriticalLogs = logs.filter((l) =>
      /NO_SECRET|DISPATCH_FAIL|SIGNATURE_INVALID/i.test(String(l.event || "")),
    );

    if (!hasSecret) {
      checks.push({
        id: "whatsapp",
        title: "WhatsApp e Webhooks",
        status: "error",
        summary: "Segredo interno do servidor ausente — o webhook não conseguirá acionar a IA.",
        actionHint: "Configure AUTH_SECRET ou SUPABASE_SERVICE_ROLE_KEY no ambiente do servidor.",
      });
    } else if (conns.length === 0) {
      checks.push({
        id: "whatsapp",
        title: "WhatsApp e Webhooks",
        status: "warn",
        summary: "Nenhuma instância WhatsApp conectada nesta conta ainda.",
        actionHint: "Acesse a aba WhatsApp ou /whatsapp para criar e parear uma instância.",
      });
    } else if (connected.length === 0) {
      checks.push({
        id: "whatsapp",
        title: "WhatsApp e Webhooks",
        status: "warn",
        summary: `${conns.length} instância(s) cadastrada(s), mas nenhuma com status conectado.`,
        actionHint: "Verifique o QR Code / pareamento em /whatsapp.",
      });
    } else if (recentCriticalLogs.length > 0) {
      checks.push({
        id: "whatsapp",
        title: "WhatsApp e Webhooks",
        status: "warn",
        summary: `${connected.length} instância(s) online, mas houve ${recentCriticalLogs.length} alerta(s) de webhook nos últimos 7 dias.`,
        actionHint: "Rode o diagnóstico do webhook na tela WhatsApp se notar mensagens faltando.",
      });
    } else {
      checks.push({
        id: "whatsapp",
        title: "WhatsApp e Webhooks",
        status: "ok",
        summary: `${connected.length} de ${conns.length} instância(s) conectada(s) e webhook pronto para receber mensagens.`,
      });
    }
  } catch {
    checks.push({
      id: "whatsapp",
      title: "WhatsApp e Webhooks",
      status: "warn",
      summary: "Não foi possível consultar o status das conexões agora.",
    });
  }

  // 2. Provedores de IA (sem expor chaves)
  try {
    const keys = await getAiKeys().catch(() => null);
    const activeProviders: string[] = [];
    if (keys?.gemini) activeProviders.push("Gemini");
    if (keys?.openrouter || (keys?.openrouterKeys?.length || 0) > 0) activeProviders.push("OpenRouter");
    if (keys?.nvidia || (keys?.nvidiaAccounts?.length || 0) > 0) activeProviders.push("NVIDIA NIM");
    if (keys?.gatewayBaseUrl) activeProviders.push("Gateway");

    if (activeProviders.length === 0) {
      checks.push({
        id: "ai",
        title: "Provedores de IA",
        status: "error",
        summary: "Nenhuma API Key de IA configurada no servidor.",
        actionHint: "Adicione ao menos uma chave (Gemini, OpenRouter ou NVIDIA) abaixo para a IA responder.",
      });
    } else if (activeProviders.length === 1) {
      checks.push({
        id: "ai",
        title: "Provedores de IA",
        status: "ok",
        summary: `Provedor ativo: ${activeProviders[0]}.`,
        actionHint: "Dica: adicione um segundo provedor (ex.: OpenRouter) para ter failover automático se o principal oscilar.",
      });
    } else {
      checks.push({
        id: "ai",
        title: "Provedores de IA",
        status: "ok",
        summary: `${activeProviders.length} provedores configurados (${activeProviders.join(", ")}) — failover automático pronto.`,
      });
    }
  } catch {
    checks.push({
      id: "ai",
      title: "Provedores de IA",
      status: "warn",
      summary: "Falha ao validar configuração dos provedores de IA.",
    });
  }

  // 3. Google Agenda dos agentes do tenant
  try {
    const { data: agents } = await supabaseAdmin
      .from("agent_settings")
      .select("id, name, is_active, is_scheduler, options")
      .eq("client_id", auth.clientId);

    const typedAgents = (agents || []) as Array<{
      id: number;
      name?: string | null;
      is_active?: boolean | null;
      is_scheduler?: boolean | null;
      options?: Record<string, unknown> | null;
    }>;

    const schedulerAgents = typedAgents.filter((a) => {
      const opts = (a.options || {}) as Record<string, unknown>;
      return Boolean(a.is_active) && (Boolean(a.is_scheduler) || Boolean(opts.calendar_enabled));
    });

    const missingCalendar = schedulerAgents.filter((a) => {
      const opts = (a.options || {}) as Record<string, unknown>;
      const rawTokens = opts.google_tokens;
      let parsed: Record<string, unknown> | null = null;
      if (typeof rawTokens === "string") {
        try {
          parsed = JSON.parse(rawTokens) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      } else if (rawTokens && typeof rawTokens === "object") {
        parsed = rawTokens as Record<string, unknown>;
      }
      return !parsed?.refresh_token;
    });

    if (schedulerAgents.length === 0) {
      checks.push({
        id: "calendar",
        title: "Google Agenda",
        status: "ok",
        summary: "Nenhum agente ativo exige agendamento no Google Calendar no momento.",
      });
    } else if (missingCalendar.length > 0) {
      const names = missingCalendar.map((a) => a.name || `#${a.id}`).join(", ");
      checks.push({
        id: "calendar",
        title: "Google Agenda",
        status: "warn",
        summary: `Agente(s) com agenda ativada mas sem conta Google conectada: ${names}.`,
        actionHint: "Abra Agente IA -> Agenda e Reuniões e conclua o login Google OAuth.",
      });
    } else {
      checks.push({
        id: "calendar",
        title: "Google Agenda",
        status: "ok",
        summary: `${schedulerAgents.length} agente(s) com Google Calendar autenticado (refresh token válido).`,
      });
    }
  } catch {
    checks.push({
      id: "calendar",
      title: "Google Agenda",
      status: "warn",
      summary: "Não foi possível checar os agentes com Google Agenda.",
    });
  }

  // 4. Banco (migrations 018/021/029), Workers e Redis opcional
  try {
    const [followupTblRes, bufferTblRes, claimRpcRes, reschedRpcRes] = await Promise.all([
      supabaseAdmin.from("agent_followups").select("id").limit(1),
      supabaseAdmin.from("chat_buffers").select("remote_jid").limit(1),
      supabaseAdmin.rpc("claim_agent_followup", {
        p_claim: "00000000-0000-0000-0000-000000000000",
        p_lease_seconds: 1,
      }),
      supabaseAdmin.rpc("reschedule_agent_followup", {
        p_id: null,
        p_client: "00000000-0000-0000-0000-000000000000",
        p_agent: 1,
        p_step: 1,
        p_claim: "00000000-0000-0000-0000-000000000000",
        p_next_send_at: new Date().toISOString(),
      }),
    ]);

    const missingParts: string[] = [];
    if (followupTblRes.error && /relation|does not exist|schema cache/i.test(followupTblRes.error.message)) {
      missingParts.push("tabela agent_followups (migration 018)");
    }
    if (bufferTblRes.error && /relation|does not exist|schema cache/i.test(bufferTblRes.error.message)) {
      missingParts.push("tabela chat_buffers");
    }
    if (claimRpcRes.error && isMissingFunctionError(claimRpcRes.error.message)) {
      missingParts.push("RPC claim_agent_followup (migration 021)");
    }
    if (reschedRpcRes.error && isMissingFunctionError(reschedRpcRes.error.message)) {
      missingParts.push("RPC reschedule_agent_followup (migration 029)");
    }

    const workerEnabled = process.env.AGENT_FOLLOWUP_WORKER_ENABLED === "true";
    const redisEnabled = Boolean(process.env.REDIS_URL?.trim());

    if (missingParts.length > 0) {
      checks.push({
        id: "workers_db",
        title: "Banco e Workers",
        status: "warn",
        summary: `Pendência no banco detectada: ${missingParts.join("; ")}.`,
        actionHint: "Execute o SQL de atualização do setup ou aplique as migrations pendentes no Supabase.",
      });
    } else if (!workerEnabled) {
      checks.push({
        id: "workers_db",
        title: "Banco e Workers",
        status: "warn",
        summary: `Banco atualizado, mas o worker automático de follow-up está desligado (${redisEnabled ? "Redis ativo" : "modo sem Redis"}).`,
        actionHint: "Defina AGENT_FOLLOWUP_WORKER_ENABLED=true no deploy se utilizar follow-up automático de IA.",
      });
    } else {
      checks.push({
        id: "workers_db",
        title: "Banco e Workers",
        status: "ok",
        summary: `Banco em dia, worker de follow-up ativo e ${redisEnabled ? "Redis conectado" : "operando sem Redis"}.`,
      });
    }
  } catch {
    checks.push({
      id: "workers_db",
      title: "Banco e Workers",
      status: "warn",
      summary: "Não foi possível verificar as RPCs/tabelas de background.",
    });
  }

  const overall: HealthStatus = checks.some((c) => c.status === "error")
    ? "error"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";

  return NextResponse.json({
    success: true,
    overall,
    checkedAt: new Date().toISOString(),
    checks,
  });
}

