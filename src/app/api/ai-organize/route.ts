import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { logTokenUsage } from "@/lib/token-usage";
import {
  buildOrganizerSystemPrompt,
  extractJsonSafe,
  inferSemanticStageRank,
  inferStageRole,
  isTerminalColumn,
} from "@/lib/organizer-prompt";
import { chunkArray, formatChatMessageLine, hashChatContent } from "@/lib/organizer-hash";
import { requireClientId } from "@/lib/tenant";
import { hasInternalSecret } from "@/lib/internal-auth";
import { isFeatureEnabledForSession } from "@/lib/saas-policy";
import {
  checkTenantAiQuota,
  checkTenantRateLimit,
  isClientActiveCached,
  isClientAdminCached,
  requireFeatureAccess,
} from "@/lib/saas-limits";

const adminClient = supabaseAdmin;

async function fetchPagedQuery<T = Record<string, unknown>>(
  makeQuery: () => unknown,
  maxPages: number = 20,
  pageSize: number = 1000
): Promise<{ data: T[]; error: { message: string } | null }> {
  const firstQ = makeQuery() as { range?: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> } & PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  if (typeof firstQ.range !== "function") {
    const res = await firstQ;
    return { data: Array.isArray(res?.data) ? res.data : [], error: res?.error || null };
  }

  const all: T[] = [];
  for (let p = 0; p < maxPages; p++) {
    const from = p * pageSize;
    const to = from + pageSize - 1;
    const q = makeQuery() as { range: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> };
    const { data, error } = await q.range(from, to);
    if (error) return { data: all, error };
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return { data: all, error: null };
}

/**
 * Normaliza a resposta JSON da IA em uma lista de decisões, suportando:
 * - Array direto: [ { jid, status, ... } ]
 * - Objeto wrapper (comum em response_format=json_object): { results: [...] }, { leads: [...] }, etc.
 * - Mapa legado { "5511...@s.whatsapp.net": "interessado" }
 */
export function normalizeOrganizerAiOutput(parsed: any): Array<{
  jid: string;
  status: string;
  lead_type?: string | null;
  razao?: string | null;
  resumo?: string | null;
}> {
  const normalizeItem = (item: any) => {
    if (!item || typeof item !== "object") return null;
    const jid = item.jid || item.remote_jid || item.remoteJid || item.chat_id;
    const status = item.status || item.status_novo || item.coluna || item.status_key;
    if (typeof jid !== "string" || typeof status !== "string") return null;
    return {
      jid: jid.trim(),
      status: status.trim(),
      lead_type: item.lead_type || null,
      razao: item.razao || item.razao_curta || item.justificativa || item.motivo || item.reason || item.explanation || item.explicacao || null,
      resumo: item.resumo || item.summary || item.resumo_ia || item.resumo_executivo || item.overview || null,
    };
  };

  if (Array.isArray(parsed)) {
    return parsed.map(normalizeItem).filter(Boolean) as any[];
  }
  if (parsed && typeof parsed === "object") {
    const arrayField = Object.values(parsed).find((v) => Array.isArray(v)) as any[] | undefined;
    if (arrayField) {
      return arrayField.map(normalizeItem).filter(Boolean) as any[];
    }
    const single = normalizeItem(parsed);
    if (single) return [single];

    return Object.entries(parsed)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => ({
        jid: k,
        status: v as string,
        razao: "Classificado via mapa JSON.",
        resumo: null,
      }));
  }
  return [];
}

export async function POST(req: NextRequest) {
  const runStartedAt = new Date();
  let runId: number | null = null;
  let batchIdForRun: string | null = null;
  let chatsAnalyzed = 0;
  let leadsMoved = 0;
  let triggerLabel: string = "manual";

  const finishRun = async (status: "ok" | "error" | "noop", extra: { error?: string; summary?: string } = {}) => {
    if (!runId) return;
    try {
      const duration = Date.now() - runStartedAt.getTime();
      if (!adminClient) return;
      let q = adminClient.from("ai_organizer_runs").update({
        finished_at: new Date().toISOString(),
        duration_ms: duration,
        chats_analyzed: chatsAnalyzed,
        leads_moved: leadsMoved,
        status,
        error: extra.error || null,
        summary: extra.summary || null,
        batch_id: batchIdForRun,
      }).eq("id", runId);
      if (clientIdScope) q = q.eq("client_id", clientIdScope);
      await q;
    } catch (e: any) {
      console.warn("[AI-ORGANIZE] Falha ao fechar run:", e?.message);
    }
  };

  let clientIdScope: string | null = null;

  const isInternal = hasInternalSecret(req);
  let sessionClientId: string | null = null;
  let sessionIsAdmin = false;
  if (!isInternal) {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    const denied = requireFeatureAccess(ctx, "organizador");
    if (denied) return denied;
    sessionClientId = ctx.clientId;
    sessionIsAdmin = ctx.isAdmin;
    if (!sessionIsAdmin) {
      const rl = checkTenantRateLimit(`ai_organize:${sessionClientId}`, 5, 60_000);
      if (!rl.allowed) {
        return NextResponse.json(
          { success: false, error: `Muitas execuções em sequência. Aguarde ${rl.retryAfterSec ?? 1}s.` },
          { status: 429 }
        );
      }
    }
  }

  try {
    if (!adminClient) {
      return NextResponse.json({ success: false, error: "DB indisponível" }, { status: 500 });
    }
    const body = await req.json().catch(() => ({}));
    let { apiKey, model, provider } = body || {};
    if (!isInternal && !sessionIsAdmin) {
      // Cliente comum não pode injetar chave, modelo ou provedor customizado no request
      apiKey = undefined;
      model = undefined;
      provider = undefined;
    }
    const {
      triggered_by,
      clientId,
      targetJids,
      windowHours = 48,
      forceReanalyze = false,
    } = body || {};

    triggerLabel =
      triggered_by === "auto" || triggered_by === "schedule_catchup" || triggered_by === "realtime"
        ? triggered_by
        : "manual";
    if (typeof clientId === "string" && clientId.trim()) clientIdScope = clientId.trim();

    if (!isInternal && !sessionIsAdmin) {
      if (clientIdScope && clientIdScope !== sessionClientId) {
        return NextResponse.json(
          { success: false, error: "clientId do body não corresponde à sessão" },
          { status: 403 }
        );
      }
      clientIdScope = sessionClientId;
    }
    if (!isInternal && !clientIdScope) clientIdScope = sessionClientId;
    if (!clientIdScope) {
      return NextResponse.json(
        { success: false, error: "clientId é obrigatório para executar o organizador" },
        { status: 400 },
      );
    }

    const clientActive = await isClientActiveCached(clientIdScope);
    if (!clientActive) {
      return NextResponse.json(
        { success: false, status: "inactive_tenant", error: "Conta desativada.", updatedCount: 0 },
        { status: isInternal ? 200 : 403 },
      );
    }

    const effectiveAdmin = sessionIsAdmin || (isInternal && (await isClientAdminCached(clientIdScope)));
    if (!effectiveAdmin) {
      if (isInternal) {
        try {
          const { data: cliRow } = await adminClient
            .from("clients")
            .select("is_admin, is_active, features, organizer_enabled")
            .eq("id", clientIdScope)
            .maybeSingle();
          if (cliRow && typeof cliRow === "object" && !Array.isArray(cliRow) && "features" in cliRow) {
            const cRow = cliRow as {
              is_admin?: boolean | null;
              is_active?: boolean | null;
              features?: Record<string, boolean> | null;
              organizer_enabled?: boolean | null;
            };
            const featureOk = isFeatureEnabledForSession("organizador", {
              isAdmin: Boolean(cRow.is_admin),
              features: cRow.features || {},
            });
            if (cRow.is_active === false || !featureOk || (triggerLabel === "auto" && cRow.organizer_enabled !== true)) {
              return NextResponse.json({
                success: true,
                skipped: true,
                message: "Organizador desativado ou não liberado para esta conta.",
                updatedCount: 0,
              });
            }
          }
        } catch {}
      }

      const quota = await checkTenantAiQuota(clientIdScope, false);
      if (!quota.allowed) {
        return NextResponse.json(
          {
            success: false,
            status: "quota_exceeded",
            error: quota.reason || "Limite mensal de IA do plano atingido.",
            updatedCount: 0,
          },
          { status: isInternal ? 200 : 429 },
        );
      }
    }

    const { providerDisplayName, providerOf, generateText } = await import("@/lib/ai-provider");
    const { getAiKeys } = await import("@/lib/ai-keys");
    const aiKeys = await getAiKeys();

    let openrouterApiKey: string | null = null;
    let nvidiaApiKey: string | null = null;
    const { data: cfg } = await adminClient
      .from("ai_organizer_config")
      .select("api_key, openrouter_api_key, nvidia_api_key, model, provider")
      .eq("id", 1)
      .maybeSingle();

    if (cfg) {
      apiKey = apiKey || cfg.api_key;
      model = model || cfg.model;
      provider = provider || cfg.provider;
      openrouterApiKey = (cfg as any).openrouter_api_key || null;
      nvidiaApiKey = (cfg as any).nvidia_api_key || null;
    }

    model = (model || aiKeys.defaultAiModel || "gemini-2.5-flash").trim();
    const refProvider = providerOf(model);
    provider = providerDisplayName(refProvider);

    const geminiKey = (apiKey || aiKeys.gemini || process.env.GEMINI_API_KEY || "").trim();
    const effectiveOpenRouterKey = (openrouterApiKey || aiKeys.openrouter || process.env.OPENROUTER_API_KEY || "").trim();
    const effectiveNvidiaKey = (nvidiaApiKey || aiKeys.nvidia || process.env.NVIDIA_API_KEY || "").trim();

    const hasValidCredentials = Boolean(
      geminiKey ||
      effectiveOpenRouterKey ||
      aiKeys.openrouterKeys?.length ||
      effectiveNvidiaKey ||
      aiKeys.nvidiaAccounts?.length ||
      aiKeys.gatewayBaseUrl ||
      aiKeys.gatewayEndpoints?.length ||
      refProvider === "combo"
    );

    // Guard contra corrida concorrente entre ticks/cliques simultâneos no mesmo tenant (5 min TTL)
    if (triggerLabel !== "realtime" && clientIdScope) {
      try {
        const fiveMinAgoIso = new Date(Date.now() - 5 * 60_000).toISOString();
        const { data: activeRuns } = await adminClient
          .from("ai_organizer_runs")
          .select("id, started_at")
          .eq("client_id", clientIdScope)
          .eq("status", "running")
          .gte("started_at", fiveMinAgoIso)
          .limit(1);
        const alreadyRunning =
          Array.isArray(activeRuns) &&
          activeRuns.some((r: { id?: unknown; started_at?: unknown }) => Boolean(r?.started_at));
        if (alreadyRunning) {
          return NextResponse.json({
            success: true,
            alreadyRunning: true,
            message: "Organizador já está em execução para esta conta.",
            updatedCount: 0,
          });
        }
      } catch {
        // segue normalmente se a consulta de lock falhar
      }
    }

    try {
      const { data: runRow, error: runErr } = await adminClient
        .from("ai_organizer_runs")
        .insert({
          started_at: runStartedAt.toISOString(),
          triggered_by: triggerLabel,
          status: "running",
          model: model || null,
          provider: provider || null,
          client_id: clientIdScope,
        })
        .select("id")
        .single();
      if (!runErr) runId = runRow?.id || null;
    } catch {}

    if (!hasValidCredentials) {
      await finishRun("error", { error: "Credenciais do provedor não configuradas." });
      return NextResponse.json(
        { success: false, error: "Credenciais de IA não configuradas em Configurações." },
        { status: 400 }
      );
    }

    // 1. Identificar conversas ativas na janela (ou targetJids específicos no modo realtime)
    const requestedJids = Array.isArray(targetJids)
      ? targetJids.map((j) => String(j || "").trim()).filter(Boolean).slice(0, 100)
      : [];

    let activeJids: string[] = [];
    if (requestedJids.length > 0) {
      activeJids = [...new Set(requestedJids)];
    } else {
      const hours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : 48;
      const windowStart = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const { data: recentRows, error: recentErr } = await fetchPagedQuery<{ remote_jid?: string }>(() =>
        adminClient
          .from("chats_dashboard")
          .select("remote_jid")
          .gte("created_at", windowStart)
          .eq("client_id", clientIdScope)
          .order("id", { ascending: true })
      );
      if (recentErr) throw new Error("Erro ao buscar conversas recentes: " + recentErr.message);
      activeJids = [...new Set((recentRows || []).map((r) => r.remote_jid).filter((j): j is string => Boolean(j)))];
    }

    const markLastRunIfScheduled = async () => {
      if (clientIdScope && triggerLabel !== "realtime") {
        try {
          await adminClient
            .from("clients")
            .update({ organizer_last_run: new Date().toISOString() })
            .eq("id", clientIdScope);
        } catch {}
      }
    };

    if (activeJids.length === 0) {
      await finishRun("noop", { summary: "Nenhuma conversa ativa na janela." });
      await markLastRunIfScheduled();
      return NextResponse.json({
        success: true,
        message: "Nenhuma conversa recente para analisar.",
        updatedCount: 0,
      });
    }

    // 2. Buscar as mensagens completas em chunks de JID + paginação (evita limite de 1.000 linhas do PostgREST)
    type ChatMsgRow = {
      id?: number;
      remote_jid?: string;
      content?: string | null;
      sender_type?: string | null;
      is_from_me?: boolean | null;
      status_envio?: string | null;
      media_type?: string | null;
      mimetype?: string | null;
      file_name?: string | null;
      created_at?: string | null;
    };
    const allChatRows: ChatMsgRow[] = [];
    for (const jidChunk of chunkArray(activeJids, 80)) {
      let res = await fetchPagedQuery<ChatMsgRow>(() =>
        adminClient
          .from("chats_dashboard")
          .select("id, remote_jid, content, sender_type, is_from_me, status_envio, media_type, mimetype, file_name, created_at")
          .in("remote_jid", jidChunk)
          .eq("client_id", clientIdScope)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
      );
      if (res.error) {
        res = await fetchPagedQuery<ChatMsgRow>(() =>
          adminClient
            .from("chats_dashboard")
            .select("id, remote_jid, content, sender_type, is_from_me, status_envio, created_at")
            .in("remote_jid", jidChunk)
            .eq("client_id", clientIdScope)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
        );
      }
      if (res.error) throw new Error("Erro ao buscar mensagens das conversas: " + res.error.message);
      allChatRows.push(...res.data);
    }
    allChatRows.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return Number(a.id || 0) - Number(b.id || 0);
    });

    if (allChatRows.length === 0) {
      await finishRun("noop", { summary: "Nenhuma mensagem encontrada." });
      await markLastRunIfScheduled();
      return NextResponse.json({ success: true, message: "Nenhuma mensagem encontrada.", updatedCount: 0 });
    }

    // Agrupar por contato com identificação EXATA de SDR vs CLIENTE + marcadores de mídia
    const grouped: Record<string, string[]> = {};
    const rawStatsByJid: Record<string, {
      sdrCount: number;
      clientCount: number;
      firstSdrAt: string | null;
      lastClientAt: string | null;
      clientTexts: string[];
      sdrTexts: string[];
    }> = {};

    for (const msg of allChatRows) {
      const jid = msg.remote_jid;
      if (!jid) continue;
      if (!grouped[jid]) {
        grouped[jid] = [];
        rawStatsByJid[jid] = {
          sdrCount: 0,
          clientCount: 0,
          firstSdrAt: null,
          lastClientAt: null,
          clientTexts: [],
          sdrTexts: [],
        };
      }
      const formatted = formatChatMessageLine(msg);
      if (!formatted) continue;

      grouped[jid].push(formatted.line);

      const st = rawStatsByJid[jid];
      const msgIso = msg.created_at || null;
      if (formatted.isSdr) {
        st.sdrCount++;
        st.sdrTexts.push(formatted.textForStats);
        if (msgIso && (!st.firstSdrAt || msgIso < st.firstSdrAt)) st.firstSdrAt = msgIso;
      } else {
        st.clientCount++;
        st.clientTexts.push(formatted.textForStats);
        if (msgIso && (!st.lastClientAt || msgIso > st.lastClientAt)) st.lastClientAt = msgIso;
      }
    }

    let numerosProcessados: string[] = Object.keys(grouped).filter((j) => grouped[j].length > 0 && !j.includes("@g.us"));

    // Ignora números dos próprios chips conectados / aquecedor da conta para não poluir o Kanban
    try {
      const [{ data: ownConns }, { data: ownWarmups }] = await Promise.all([
        adminClient
          .from("channel_connections")
          .select("instance_name, provider_config")
          .eq("client_id", clientIdScope),
        adminClient
          .from("whatsapp_warmup_configs")
          .select("phone_number")
          .eq("client_id", clientIdScope),
      ]);
      const ownPhones = new Set<string>();
      const addOwnDigits = (raw: unknown) => {
        const d = String(raw || "").replace(/@.*$/, "").replace(/\D/g, "");
        if (d.length < 8) return;
        ownPhones.add(d);
        if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
          const ddd = d.slice(2, 4);
          const rest = d.length === 13 ? d.slice(5) : d.slice(4);
          ownPhones.add(`55${ddd}${rest}`);
          ownPhones.add(`55${ddd}9${rest}`);
        }
      };
      for (const c of ownConns || []) {
        const cfgObj = (c as any)?.provider_config;
        addOwnDigits(cfgObj?.owner_phone);
        addOwnDigits(cfgObj?.owner_jid);
      }
      for (const w of ownWarmups || []) {
        addOwnDigits((w as any)?.phone_number);
      }
      if (ownPhones.size > 0) {
        numerosProcessados = numerosProcessados.filter((j) => {
          const d = j.replace(/@.*$/, "").replace(/\D/g, "");
          return !d || !ownPhones.has(d);
        });
      }
    } catch {}

    chatsAnalyzed = numerosProcessados.length;

    if (numerosProcessados.length === 0) {
      await finishRun("noop", { summary: "Conversas sem conteúdo textual externo." });
      await markLastRunIfScheduled();
      return NextResponse.json({ success: true, message: "Sem conteúdo textual para analisar.", updatedCount: 0 });
    }

    // Anti-bouncing (24h) + respeito a movimentação manual recente no Kanban (7 dias)
    const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const last24hMs = Date.now() - 24 * 60 * 60 * 1000;
    const recentChanges: Array<{
      remote_jid?: string;
      status_antigo?: string;
      status_novo?: string;
      razao?: string | null;
      batch_id?: string | null;
      created_at?: string | null;
    }> = [];
    for (const jidChunk of chunkArray(numerosProcessados, 80)) {
      let histQ = adminClient
        .from("historico_ia_leads")
        .select("remote_jid, status_antigo, status_novo, razao, batch_id, created_at")
        .in("remote_jid", jidChunk)
        .gte("created_at", last7d)
        .order("created_at", { ascending: false });
      if (clientIdScope) histQ = histQ.eq("client_id", clientIdScope);
      const { data: chunkRows } = await histQ;
      if (Array.isArray(chunkRows)) recentChanges.push(...chunkRows);
    }

    const recentlyTouchedByIa = new Set<string>();
    const lastIaMoveByJid = new Map<string, { from: string; to: string }>();
    const latestManualAtByJid = new Map<string, string>();
    for (const r of recentChanges) {
      const jid = r.remote_jid;
      if (!jid) continue;
      const isManualMove =
        Boolean(r.batch_id && String(r.batch_id).startsWith("manual-")) ||
        Boolean(r.razao && String(r.razao).startsWith("[MANUAL]"));
      if (isManualMove) {
        const cur = latestManualAtByJid.get(jid);
        if (r.created_at && (!cur || r.created_at > cur)) {
          latestManualAtByJid.set(jid, r.created_at);
        }
        continue;
      }
      const createdMs = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (r.status_antigo !== r.status_novo && createdMs >= last24hMs) {
        recentlyTouchedByIa.add(jid);
        if (!lastIaMoveByJid.has(jid) && r.status_antigo && r.status_novo) {
          lastIaMoveByJid.set(jid, { from: r.status_antigo, to: r.status_novo });
        }
      }
    }

    // 3. Carregar dados atuais dos leads (chunked), colunas do Kanban e Agente IA ativo da conta
    const leadsAtuais: any[] = [];
    for (const jidChunk of chunkArray(numerosProcessados, 80)) {
      const { data: leadChunk } = await adminClient
        .from("leads_extraidos")
        .select('remoteJid, status, nome_negocio, resumo_ia, primeiro_contato_source, primeiro_contato_at, created_at, last_analysis_hash, lead_type, client_id, previa_status, link_previa, reuniao_horario_confirmado')
        .in("remoteJid", jidChunk)
        .eq("client_id", clientIdScope);
      if (Array.isArray(leadChunk)) leadsAtuais.push(...leadChunk);
    }

    const [
      { data: cli },
      { data: cols },
      { data: activeAgent },
    ] = await Promise.all([
      adminClient
        .from("clients")
        .select("organizer_prompt, organizer_enabled")
        .eq("id", clientIdScope)
        .maybeSingle(),
      adminClient
        .from("kanban_columns")
        .select("*")
        .eq("client_id", clientIdScope)
        .order("order_index", { ascending: true }),
      adminClient
        .from("agent_settings")
        .select("name, main_prompt, role")
        .eq("client_id", clientIdScope)
        .eq("is_active", true)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const statusAtualMap: Record<string, string> = {};
    const nomeNegocioMap: Record<string, string> = {};
    const leadMetaMap: Record<string, {
      source: string | null;
      primeiroContatoAt: string | null;
      createdAt: string | null;
      lastHash: string | null;
      leadType: string | null;
      clientId: string | null;
      previaStatus: string | null;
      linkPrevia: string | null;
      reuniaoHorario: string | null;
      prevResumo: string | null;
    }> = {};

    for (const l of leadsAtuais) {
      statusAtualMap[l.remoteJid] = l.status;
      if (l.nome_negocio) nomeNegocioMap[l.remoteJid] = l.nome_negocio;
      leadMetaMap[l.remoteJid] = {
        source: l.primeiro_contato_source || null,
        primeiroContatoAt: l.primeiro_contato_at || null,
        createdAt: l.created_at || null,
        lastHash: l.last_analysis_hash || null,
        leadType: l.lead_type || null,
        clientId: l.client_id || null,
        previaStatus: l.previa_status || null,
        linkPrevia: l.link_previa || null,
        reuniaoHorario: l.reuniao_horario_confirmado || null,
        prevResumo: l.resumo_ia || null,
      };
    }

    const customOrganizerPrompt =
      cli?.organizer_enabled !== false && cli?.organizer_prompt
        ? cli.organizer_prompt.trim() || null
        : null;

    type KanbanCol = { status_key: string; label: string; order_index: number; is_terminal?: boolean };
    const kanbanCols: KanbanCol[] = ((cols || []) as any[]).map((c) => ({
      status_key: c.status_key,
      label: c.label,
      order_index: c.order_index,
      is_terminal: typeof c.is_terminal === "boolean" ? c.is_terminal : isTerminalColumn(c),
    }));

    const dynamicStatusKeys = kanbanCols.map((c) => c.status_key);
    const colMetaByKey = new Map(
      kanbanCols.map((c, idx) => [
        c.status_key,
        {
          col: c,
          rank: inferSemanticStageRank(c, idx, kanbanCols.length),
          role: inferStageRole(c),
        },
      ])
    );

    const terminalSet = new Set<string>(
      kanbanCols.filter((c) => isTerminalColumn(c)).map((c) => c.status_key)
    );
    if (terminalSet.size === 0) {
      ["sem_interesse", "descartado", "fechado"].forEach((k) => terminalSet.add(k));
    }

    // Mapeamento inteligente de colunas equivalentes no Kanban atual do cliente
    const findColKey = (regex: RegExp, fallback: string): string => {
      const found = kanbanCols.find((c) => regex.test(`${c.status_key} ${c.label}`));
      if (found) return found.status_key;
      if (dynamicStatusKeys.includes(fallback)) return fallback;
      return dynamicStatusKeys[0] || fallback;
    };
    const findOptionalColKey = (regex: RegExp, roleMatch?: ReturnType<typeof inferStageRole>): string | null => {
      if (roleMatch) {
        const byRole = kanbanCols.find((c) => inferStageRole(c) === roleMatch);
        if (byRole) return byRole.status_key;
      }
      const found = kanbanCols.find((c) => regex.test(`${c.status_key} ${c.label}`));
      return found ? found.status_key : null;
    };

    const colPrimeiroContato = findColKey(/primeiro_contato|abordado|disparo|contato_inicial/i, "primeiro_contato");
    const colRecusa = findColKey(/sem_interesse|perdid|recus|nao_quis/i, "sem_interesse");
    const colDescarte = findColKey(/descartad|invalid|errado|robo|ura|sem_contato/i, "descartado");
    const colPreviaSolicitada = findOptionalColKey(/previa_solicitada|previa_pedida|aceitou_previa|gerar_previa|orcamento_solicitado/i, "waiting_asset");
    const colEmNegociacao = findOptionalColKey(/em_negociacao|previa_enviada|previa_pronta|proposta|orcamento_enviado/i, "proposal");
    const colAgendado = findOptionalColKey(/agendad|reuniao|call|consulta|visita|marcado/i, "scheduled");
    const colFechado = findOptionalColKey(/fechad|ganho|vendid|contratad|comprou|atendido|concluid/i, "won");

    // 4. Agendamentos estruturados de todos os leads ativos (chunked — alimenta Camada 0 multi-nicho e LLM)
    const appointmentsByJid = new Map<string, Array<{ start_at: string; end_at: string; status: string; title?: string; service_name?: string | null }>>();
    for (const jidChunk of chunkArray(numerosProcessados, 80)) {
      try {
        const { data: apptRows } = await adminClient
          .from("appointments")
          .select("remote_jid, start_at, end_at, status, title, service_name")
          .in("remote_jid", jidChunk)
          .eq("client_id", clientIdScope)
          .in("status", ["confirmed", "completed", "no_show"]);
        for (const row of apptRows || []) {
          if (!appointmentsByJid.has(row.remote_jid)) appointmentsByJid.set(row.remote_jid, []);
          appointmentsByJid.get(row.remote_jid)!.push(row);
        }
      } catch {}
    }

    // 5. Camada 0 e Camada 1: Filtros de Economia Extrema de Tokens (0 Tokens)
    const decisoesHeuristicas: Record<string, { status: string; razao: string; resumo: string; lead_type?: string }> = {};
    const skippedSemMudanca: string[] = [];
    const skippedCacheHit: string[] = [];
    const candidatosParaIA: string[] = [];
    const nowMs = Date.now();

    for (const jid of numerosProcessados) {
      const statusAtual = statusAtualMap[jid] || "nenhum";
      const msgs = grouped[jid] || [];
      const st = rawStatsByJid[jid];
      const clienteRespondeu = (st?.clientCount || 0) > 0;
      const sdrMandou = (st?.sdrCount || 0) > 0;
      const ultimaMsgCliente = st?.clientTexts?.length ? st.clientTexts[st.clientTexts.length - 1] : "";
      const textoCliente = ultimaMsgCliente.toLowerCase().trim();

      const hashAtual = hashChatContent(msgs.slice(-15), statusAtual);
      const meta = leadMetaMap[jid];

      // FILTRO MANUAL: respeita arraste manual recente se o cliente NÃO mandou nova mensagem depois
      const manualAt = latestManualAtByJid.get(jid);
      if (
        !forceReanalyze &&
        manualAt &&
        statusAtual !== "nenhum" &&
        dynamicStatusKeys.includes(statusAtual) &&
        (!st?.lastClientAt || new Date(st.lastClientAt).getTime() <= new Date(manualAt).getTime())
      ) {
        skippedSemMudanca.push(jid);
        continue;
      }

      // FILTRO CACHE: mesma conversa + mesmo status já analisado
      if (!forceReanalyze && meta?.lastHash === hashAtual && statusAtual !== "nenhum" && dynamicStatusKeys.includes(statusAtual)) {
        skippedCacheHit.push(jid);
        continue;
      }

      // FILTRO TERMINAL: já está em coluna terminal e cliente não respondeu
      if (terminalSet.has(statusAtual) && !clienteRespondeu) {
        skippedSemMudanca.push(jid);
        continue;
      }

      // CAMADA 0.A: Lead nunca respondeu (só o SDR mandou mensagem)
      if (!clienteRespondeu && sdrMandou && meta?.previaStatus !== "PREVIA_SOLICITADA" && meta?.previaStatus !== "GERANDO_WORKSPACE" && meta?.previaStatus !== "PREVIA_PRONTA" && !meta?.linkPrevia) {
        if (statusAtual === "invalid_number") {
          decisoesHeuristicas[jid] = {
            status: colDescarte,
            razao: "Número inválido / sem WhatsApp ativo (pré-validação).",
            resumo: "Número marcado como inválido/inexistente no WhatsApp.",
            lead_type: "frio",
          };
        } else if (statusAtual === "novo" || statusAtual === "nenhum" || !dynamicStatusKeys.includes(statusAtual)) {
          decisoesHeuristicas[jid] = {
            status: colPrimeiroContato,
            razao: "R8 (Camada 0): Disparo inicial enviado pelo SDR; aguardando primeira resposta do cliente.",
            resumo: "Abordagem inicial enviada. Cliente ainda não respondeu.",
            lead_type: "novo",
          };
        } else {
          skippedSemMudanca.push(jid);
        }
        continue;
      }

      // CAMADA 0.A2: Auto-resposta única de WhatsApp Business (horário / boas-vindas sem humano)
      if (
        st?.clientCount === 1 &&
        (statusAtual === "novo" || statusAtual === "nenhum" || statusAtual === colPrimeiroContato) &&
        /agradecemos (o )?seu contato|nosso hor[áa]rio de atendimento|no momento n[ãa]o estamos|responderemos o mais breve|aguarde e j[áa] ser[áa] atendido|seja muito bem[- ]vindo/i.test(textoCliente) &&
        !/\b(pode enviar|pode mandar|quero ver)\b/i.test(textoCliente)
      ) {
        if (statusAtual !== colPrimeiroContato) {
          decisoesHeuristicas[jid] = {
            status: colPrimeiroContato,
            razao: "R8 (Camada 0): Resposta única automática de WhatsApp Business; aguardando atendimento humano.",
            resumo: "Contato respondeu apenas com mensagem automática de horário/boas-vindas.",
            lead_type: "novo",
          };
        } else {
          skippedSemMudanca.push(jid);
        }
        continue;
      }

      // CAMADA 0.B: Detector de URA / Robô de autoatendimento preso em loop
      if (clienteRespondeu && (st?.clientTexts?.length || 0) >= 4) {
        const botMenuHits = st.clientTexts.filter((t) =>
          /n[ãa]o entendemos sua mensagem|escolha uma das seguintes op[çc][õo]es|n[ãa]o foi encontrado um menu|digite:?\s*#perfil|selecione uma op[çc][ãa]o/i.test(t)
        ).length;
        if (botMenuHits >= 3) {
          decisoesHeuristicas[jid] = {
            status: colDescarte,
            razao: "R2 (Camada 0): Atendimento preso em URA/robô automático repetitivo sem humano.",
            resumo: `Conversa travada em menu automático de URA (${botMenuHits} repetições de robô). Movido para "${colDescarte}".`,
            lead_type: "frio",
          };
          continue;
        }
      }

      // CAMADA 0.C: Recusa explícita ou Número Errado
      if (clienteRespondeu && textoCliente) {
        const recusa = /^(n[ãa]o tenho interesse|n[ãa]o quero|n[ãa]o me liga|para de mandar|me tira|me remov|n[ãa]o me mande|n[ãa]o preciso de site)$/i;
        if (recusa.test(textoCliente)) {
          decisoesHeuristicas[jid] = {
            status: colRecusa,
            razao: "R1 (Camada 0): Cliente declarou recusa explícita.",
            resumo: `Cliente recusou a abordagem ("${ultimaMsgCliente.slice(0, 120)}").`,
            lead_type: "frio",
          };
          continue;
        }
        const errado = /(n[úu]mero errado|pessoa errada|n[ãa]o pertence|enganou de n[úu]mero)/i;
        if (errado.test(textoCliente) && textoCliente.length < 180) {
          decisoesHeuristicas[jid] = {
            status: colDescarte,
            razao: "R2 (Camada 0): Cliente informou que o número está errado.",
            resumo: `Contato informou número errado ("${ultimaMsgCliente.slice(0, 120)}").`,
            lead_type: "frio",
          };
          continue;
        }
      }

      // CAMADA 0.D: Link da prévia já entregue (Vercel/link_previa/PREVIA_PRONTA) -> em_negociacao (0 tokens)
      const hasPreviewLinkInChat = st?.sdrTexts?.some((t) => /https?:\/\/[^\s]+\.vercel\.app/i.test(t));
      if (
        colEmNegociacao &&
        !terminalSet.has(statusAtual) &&
        statusAtual !== colEmNegociacao &&
        statusAtual !== colAgendado &&
        (Boolean(meta?.linkPrevia) || meta?.previaStatus === "PREVIA_PRONTA" || hasPreviewLinkInChat)
      ) {
        decisoesHeuristicas[jid] = {
          status: colEmNegociacao,
          razao: "Camada 0: Link da prévia do site já enviado na conversa — em fase de avaliação/negociação.",
          resumo: "Prévia do site já disponibilizada para o cliente avaliar no WhatsApp.",
          lead_type: "qualificado",
        };
        continue;
      }

      // CAMADA 0.E: Prévia solicitada / gerando e link ainda não enviado -> previa_solicitada (0 tokens)
      if (
        colPreviaSolicitada &&
        !terminalSet.has(statusAtual) &&
        statusAtual !== colPreviaSolicitada &&
        statusAtual !== colEmNegociacao &&
        statusAtual !== colAgendado &&
        (meta?.previaStatus === "PREVIA_SOLICITADA" || meta?.previaStatus === "GERANDO_WORKSPACE")
      ) {
        decisoesHeuristicas[jid] = {
          status: colPreviaSolicitada,
          razao: "Camada 0: Prévia solicitada e pipeline de geração acionado; aguardando envio do link.",
          resumo: "Cliente aceitou receber a prévia e a geração está em andamento.",
          lead_type: "qualificado",
        };
        continue;
      }

      // CAMADA 0.F: Agendamento real no Calendar (universal para qualquer nicho — 0 tokens)
      const leadAppts = appointmentsByJid.get(jid) || [];
      if (colFechado && !terminalSet.has(statusAtual) && statusAtual !== colFechado && leadAppts.some((a) => a.status === "completed")) {
        decisoesHeuristicas[jid] = {
          status: colFechado,
          razao: "R17 (Camada 0): Atendimento marcado como concluído na agenda.",
          resumo: "Atendimento confirmado e finalizado na agenda do negócio.",
          lead_type: "cliente_ativo",
        };
        continue;
      }
      if (
        colAgendado &&
        !terminalSet.has(statusAtual) &&
        statusAtual !== colAgendado &&
        leadAppts.some((a) => a.status === "confirmed" && (!a.end_at || new Date(a.end_at).getTime() >= nowMs))
      ) {
        decisoesHeuristicas[jid] = {
          status: colAgendado,
          razao: "R4 (Camada 0): Agendamento confirmado registrado na agenda.",
          resumo: "Lead possui horário confirmado na agenda.",
          lead_type: "qualificado",
        };
        continue;
      }

      candidatosParaIA.push(jid);
    }

    const allAppts = Array.from(appointmentsByJid.values()).flat();
    const { systemPrompt: systemInstruction } = buildOrganizerSystemPrompt(
      customOrganizerPrompt,
      kanbanCols,
      new Date(),
      allAppts,
      activeAgent
    );

    // 6. Avaliar candidatos via IA em lotes enxutos (máx 12 chats por lote para zero truncamento)
    const resultadosLista: any[] = [];
    const BATCH_SIZE = 12;

    for (let i = 0; i < candidatosParaIA.length; i += BATCH_SIZE) {
      const loteJids = candidatosParaIA.slice(i, i + BATCH_SIZE);
      const threadsTexto = loteJids
        .map((jid) => {
          const allThreadMsgs = grouped[jid] || [];
          const msgs = allThreadMsgs.slice(-14);
          const statusAtual = statusAtualMap[jid] || "nenhum";
          const nome = nomeNegocioMap[jid] || "(sem nome)";
          const st = rawStatsByJid[jid];
          const appts = appointmentsByJid.get(jid) || [];
          const apptInfo = appts.length > 0
            ? `\n- AGENDAMENTOS: ${appts.map((a) => `${a.start_at} (${a.status})`).join(", ")}`
            : "";
          const meta = leadMetaMap[jid];
          const previaInfo = meta?.previaStatus || meta?.linkPrevia
            ? `\n- PIPELINE PRÉVIA SITE: status="${meta.previaStatus || "nenhum"}", link="${meta.linkPrevia || "nenhum"}"`
            : "";
          const prevResumoInfo = allThreadMsgs.length > 14 && meta?.prevResumo
            ? `\n- RESUMO ANTERIOR (mensagens mais antigas omitidas): ${meta.prevResumo}`
            : "";
          const antiBounceFlag = recentlyTouchedByIa.has(jid)
            ? `\n- ⚑ ANTI-BOUNCING: movido pela IA nas últimas 24h — só mude com evidência textual inequívoca.`
            : "";
          return `--- CHAT ID: ${jid} ---\n- EMPRESA: ${nome}\n- STATUS ATUAL NO KANBAN: "${statusAtual}"\n- TOTAL MSGS (SDR=${st.sdrCount}, CLIENTE=${st.clientCount})${apptInfo}${previaInfo}${prevResumoInfo}${antiBounceFlag}\nHISTÓRICO DA CONVERSA:\n${msgs.join("\n")}\n--- FIM CHAT ID: ${jid} ---`;
        })
        .join("\n\n");

      const out = await generateText({
        modelRef: model,
        system: systemInstruction,
        prompt: `Analise os ${loteJids.length} chats abaixo e retorne APENAS um JSON array onde cada item contenha obrigatoriamente: {"jid": "...", "status": "<status_key>", "lead_type": "...", "razao": "<motivo claro da classificação>", "resumo": "<resumo de 1-2 frases da conversa>"}:\n\n${threadsTexto}`,
        temperature: 0.1,
        maxOutputTokens: 3000,
        reasoningMode: 0,
        jsonMode: true,
        geminiApiKey: geminiKey,
        openrouterApiKey: effectiveOpenRouterKey,
        nvidiaApiKey: effectiveNvidiaKey,
      });

      await logTokenUsage({
        source: "organizer",
        sourceLabel: "Organizador IA",
        model: out.modelUsed,
        provider: providerDisplayName(out.provider),
        promptTokens: out.usage.promptTokens,
        completionTokens: out.usage.completionTokens,
        totalTokens: out.usage.totalTokens,
        cachedTokens: out.usage.cachedTokens,
        costUsd: out.usage.costUsd,
        clientId: clientIdScope || undefined,
        metadata: { triggered_by: triggerLabel, chats: loteJids.length },
      });

      try {
        const parsedBatch = extractJsonSafe<any>(out.text);
        const normalized = normalizeOrganizerAiOutput(parsedBatch);
        resultadosLista.push(...normalized);
      } catch (parseErr: any) {
        console.error("[AI-ORGANIZE] Erro ao fazer parse do lote:", parseErr?.message, out.text?.slice(0, 300));
        throw new Error("A IA não retornou um formato JSON válido.");
      }
    }

    // 7. Injetar decisões da Camada 0 (heurísticas de 0 tokens)
    for (const [jid, decisao] of Object.entries(decisoesHeuristicas)) {
      resultadosLista.push({
        jid,
        status: decisao.status,
        lead_type: decisao.lead_type || null,
        razao: decisao.razao,
        resumo: decisao.resumo,
      });
    }

    // 8. Persistir mudanças no banco e gravar auditoria
    const batch_id = crypto.randomUUID();
    batchIdForRun = batch_id;
    let alteracoes = 0;
    const logs: any[] = [];
    const upsertsBatch: any[] = [];
    const nowIso = new Date().toISOString();

    const HARDCODED_VALID = new Set([
      "novo",
      "primeiro_contato",
      "em_qualificacao",
      "previa_solicitada",
      "em_negociacao",
      "interessado",
      "follow_up",
      "follow-up",
      "agendado",
      "fechado",
      "sem_interesse",
      "descartado",
      "perdido",
    ]);
    const validStatuses = kanbanCols.length > 0 ? new Set<string>(dynamicStatusKeys) : HARDCODED_VALID;

    for (const item of resultadosLista) {
      const jid = String(item?.jid || "").trim();
      let novoStatus = String(item?.status || "").toLowerCase().trim();
      if (!jid || !numerosProcessados.includes(jid)) continue;
      if (!validStatuses.has(novoStatus)) continue;

      const statusAntigo = statusAtualMap[jid] || "nenhum";
      const isHeuristicDecision = Boolean(decisoesHeuristicas[jid]);

      // Trava em código: anti-regressão, proteção de ganho/terminal sem retorno e anti-bouncing 24h para decisões da LLM
      let guardedNote = "";
      if (!isHeuristicDecision && statusAntigo !== "nenhum" && statusAntigo !== novoStatus && validStatuses.has(statusAntigo)) {
        const curMeta = colMetaByKey.get(statusAntigo);
        const nextMeta = colMetaByKey.get(novoStatus);
        const prevMove = lastIaMoveByJid.get(jid);
        const curIsTerminal = terminalSet.has(statusAntigo);
        const nextIsTerminal = terminalSet.has(novoStatus);

        if (curMeta?.role === "won" && nextMeta?.role !== "lost") {
          novoStatus = statusAntigo;
          guardedNote = " (Trava anti-regressão: cliente fechado mantido)";
        } else if (curIsTerminal && !nextIsTerminal && (rawStatsByJid[jid]?.clientCount || 0) === 0) {
          novoStatus = statusAntigo;
          guardedNote = " (Trava terminal sem retorno do cliente)";
        } else if (!curIsTerminal && !nextIsTerminal && curMeta && nextMeta) {
          if (curMeta.role === "followup" && nextMeta.rank < 30) {
            novoStatus = statusAntigo;
            guardedNote = " (Trava anti-regressão: follow-up não volta para etapa inicial)";
          } else if (curMeta.role !== "followup" && nextMeta.role !== "followup" && nextMeta.rank < curMeta.rank) {
            novoStatus = statusAntigo;
            guardedNote = " (Trava anti-regressão em código: etapa mantida)";
          }
        }

        if (
          novoStatus !== statusAntigo &&
          recentlyTouchedByIa.has(jid) &&
          prevMove &&
          prevMove.from === novoStatus &&
          prevMove.to === statusAntigo &&
          !nextIsTerminal
        ) {
          novoStatus = statusAntigo;
          guardedNote = " (Trava anti-bouncing 24h)";
        }
      }

      const st = rawStatsByJid[jid];
      const rawRazao = typeof item.razao === "string" ? item.razao.trim() : "";
      const razao = (
        (rawRazao || `Classificado em "${novoStatus}" (${st?.clientCount || 0} msg(s) do cliente, ${st?.sdrCount || 0} do SDR).`) +
        guardedNote
      ).slice(0, 500);

      const lastCliSnippet = st?.clientTexts?.length
        ? st.clientTexts[st.clientTexts.length - 1].replace(/\s+/g, " ").slice(0, 140)
        : "";
      const lastSdrSnippet = st?.sdrTexts?.length
        ? st.sdrTexts[st.sdrTexts.length - 1].replace(/\s+/g, " ").slice(0, 140)
        : "";
      const rawResumo = typeof item.resumo === "string" ? item.resumo.trim() : "";
      const resumo = (
        rawResumo ||
        (lastCliSnippet
          ? `Lead na etapa "${novoStatus}". Última msg do cliente: "${lastCliSnippet}".`
          : lastSdrSnippet
            ? `Lead na etapa "${novoStatus}". Última msg do SDR: "${lastSdrSnippet}".`
            : `Lead classificado na etapa "${novoStatus}".`)
      ).slice(0, 800);

      const VALID_LEAD_TYPES = ["novo", "cliente_ativo", "recorrente", "unica_duvida", "qualificado", "frio"];
      const leadTypeRaw = item.lead_type ? String(item.lead_type).toLowerCase().trim() : "";
      const leadType = VALID_LEAD_TYPES.includes(leadTypeRaw) ? leadTypeRaw : null;

      const isLeadNovo = !statusAtualMap[jid] && !leadMetaMap[jid];
      const statusMudou = statusAntigo !== novoStatus;
      const nomeResolvido = nomeNegocioMap[jid] || `Lead Via Chat (${jid.split("@")[0]})`;
      const finalHash = hashChatContent((grouped[jid] || []).slice(-15), novoStatus);

      // SEMPRE enviar todas as chaves uniformes no batch upsert para PostgREST
      // nunca preencher colunas omitidas com NULL em linhas já existentes!
      upsertsBatch.push({
        remoteJid: jid,
        client_id: clientIdScope,
        status: novoStatus,
        nome_negocio: nomeResolvido,
        justificativa_ia: razao,
        resumo_ia: resumo,
        ia_last_analyzed_at: nowIso,
        last_analysis_hash: finalHash,
        last_analysis_at: nowIso,
        lead_type: leadType || leadMetaMap[jid]?.leadType || null,
        updated_at: nowIso,
      });

      if (isLeadNovo || statusMudou) {
        alteracoes++;
      }

      const nome_negocio = nomeResolvido;

      logs.push({
        jid,
        nome_negocio,
        statusAntigo,
        novoStatus,
        razao,
        resumo,
        movido: isLeadNovo || statusMudou,
        batch_id,
      });
    }

    if (upsertsBatch.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < upsertsBatch.length; i += CHUNK) {
        const slice = upsertsBatch.slice(i, i + CHUNK);
        const { error: upErr } = await adminClient
          .from("leads_extraidos")
          .upsert(slice, { onConflict: "client_id,remoteJid" });
        if (upErr) {
          console.error("[AI-ORGANIZE] batch upsert erro:", upErr.message);
        }
      }
    }

    if (logs.length > 0) {
      const logsToInsert = logs.map((l) => ({
        remote_jid: l.jid,
        nome_negocio: l.nome_negocio,
        status_antigo: l.statusAntigo,
        status_novo: l.novoStatus,
        razao: l.razao,
        resumo: l.resumo,
        batch_id,
        client_id: clientIdScope,
      }));
      const { error: histErr } = await adminClient.from("historico_ia_leads").insert(logsToInsert);
      if (histErr) {
        console.error("[AI-ORGANIZE] Erro salvando historico_ia_leads:", histErr.message);
      }
    }

    leadsMoved = alteracoes;
    const customPromptInfo = customOrganizerPrompt ? " · prompt CUSTOM" : " · auto-adaptativo";
    const kanbanInfo = kanbanCols.length > 0 ? ` · kanban[${kanbanCols.length} cols]` : "";
    const summary = `${chatsAnalyzed} chats — IA: ${candidatosParaIA.length} (${provider}/${model}${customPromptInfo}${kanbanInfo}) · camada 0: ${Object.keys(decisoesHeuristicas).length} · sem mudança: ${skippedSemMudanca.length} · cache: ${skippedCacheHit.length}. ${alteracoes} movidos.`;
    await finishRun("ok", { summary });

    if (clientIdScope && triggerLabel !== "realtime") {
      await adminClient
        .from("clients")
        .update({ organizer_last_run: new Date().toISOString() })
        .eq("id", clientIdScope);
    }

    return NextResponse.json({
      success: true,
      message: `Análise concluída: ${numerosProcessados.length} conversas avaliadas (${candidatosParaIA.length} via IA, ${Object.keys(decisoesHeuristicas).length} via Camada 0), ${alteracoes} leads movidos!`,
      updatedCount: alteracoes,
      batch_id,
      triggered_by: triggerLabel,
      run_id: runId,
      logs,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Erro AI-Organizer:", err);
    await finishRun("error", { error: errMsg.slice(0, 500) });
    return NextResponse.json({ success: false, error: "Erro ao executar Organizador IA" }, { status: 500 });
  }
}
