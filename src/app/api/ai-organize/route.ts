import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import { createHash } from "crypto";
import { logTokenUsage } from "@/lib/token-usage";
import { buildOrganizerSystemPrompt, extractJsonSafe, isTerminalColumn } from "@/lib/organizer-prompt";
import { requireClientId } from "@/lib/tenant";
import { hasInternalSecret } from "@/lib/internal-auth";

const adminClient = supabaseAdmin || supabase;

/**
 * Hash determinístico das mensagens de um chat + status atual no Kanban.
 */
function hashChatContent(messages: string[], statusAtual: string): string {
  return createHash("sha256").update(`${statusAtual}|${messages.join("||")}`).digest("hex").slice(0, 16);
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
      razao: item.razao || item.razao_curta || item.justificativa || item.motivo || null,
      resumo: item.resumo || item.summary || null,
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
    sessionClientId = ctx.clientId;
    sessionIsAdmin = ctx.isAdmin;
  }

  try {
    const body = await req.json().catch(() => ({}));
    let { apiKey, model, provider } = body || {};
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
      ? targetJids.map((j) => String(j || "").trim()).filter(Boolean)
      : [];

    let activeJids: string[] = [];
    if (requestedJids.length > 0) {
      activeJids = [...new Set(requestedJids)];
    } else {
      const hours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : 48;
      const windowStart = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      let recentQ = adminClient
        .from("chats_dashboard")
        .select("remote_jid")
        .gte("created_at", windowStart)
        .eq("client_id", clientIdScope);
      const { data: recentRows, error: recentErr } = await recentQ;
      if (recentErr) throw new Error("Erro ao buscar conversas recentes: " + recentErr.message);
      activeJids = [...new Set((recentRows || []).map((r: any) => r.remote_jid).filter(Boolean))];
    }

    if (activeJids.length === 0) {
      await finishRun("noop", { summary: "Nenhuma conversa ativa na janela." });
      return NextResponse.json({
        success: true,
        message: "Nenhuma conversa recente para analisar.",
        updatedCount: 0,
      });
    }

    // 2. Buscar as mensagens completas desses JIDs (sem perder contexto que cruzou a meia-noite!)
    const { data: allChatRows, error: msgError } = await adminClient
      .from("chats_dashboard")
      .select("id, remote_jid, content, sender_type, is_from_me, status_envio, created_at")
      .in("remote_jid", activeJids)
      .eq("client_id", clientIdScope)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (msgError) throw new Error("Erro ao buscar mensagens das conversas: " + msgError.message);
    if (!allChatRows || allChatRows.length === 0) {
      await finishRun("noop", { summary: "Nenhuma mensagem encontrada." });
      return NextResponse.json({ success: true, message: "Nenhuma mensagem encontrada.", updatedCount: 0 });
    }

    // Agrupar por contato com identificação EXATA de SDR vs CLIENTE
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
      const senderType = String(msg.sender_type || "").toLowerCase();
      const isSdr =
        Boolean(msg.is_from_me) ||
        senderType === "ai" ||
        senderType === "human" ||
        senderType === "assistant" ||
        senderType === "agent" ||
        senderType === "sdr" ||
        senderType === "bot";
      const prefix = isSdr ? "SDR:" : "CLIENTE:";
      const content = (msg.content || "").trim();
      if (!content) continue;

      const timeStr = new Date(msg.created_at).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      grouped[jid].push(`[${timeStr}] ${prefix} ${content}`);

      const st = rawStatsByJid[jid];
      if (isSdr) {
        st.sdrCount++;
        st.sdrTexts.push(content);
        if (!st.firstSdrAt || msg.created_at < st.firstSdrAt) st.firstSdrAt = msg.created_at;
      } else {
        st.clientCount++;
        st.clientTexts.push(content);
        if (!st.lastClientAt || msg.created_at > st.lastClientAt) st.lastClientAt = msg.created_at;
      }
    }

    const numerosProcessados: string[] = Object.keys(grouped).filter((j) => grouped[j].length > 0);
    chatsAnalyzed = numerosProcessados.length;

    if (numerosProcessados.length === 0) {
      await finishRun("noop", { summary: "Conversas sem conteúdo textual." });
      return NextResponse.json({ success: true, message: "Sem conteúdo textual para analisar.", updatedCount: 0 });
    }

    // Anti-bouncing: leads que a IA tocou nas últimas 24h
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let histQ = adminClient
      .from("historico_ia_leads")
      .select("remote_jid, status_antigo, status_novo, created_at")
      .in("remote_jid", numerosProcessados)
      .gte("created_at", last24h);
    if (clientIdScope) histQ = histQ.eq("client_id", clientIdScope);
    const { data: recentChanges } = await histQ;
    const recentlyTouchedByIa = new Set<string>();
    (recentChanges || []).forEach((r: any) => {
      if (r.status_antigo !== r.status_novo) recentlyTouchedByIa.add(r.remote_jid);
    });

    // Pré-histórico das conversas antes de hoje
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    let preHistQ = adminClient
      .from("chats_dashboard")
      .select("remote_jid, sender_type, created_at")
      .in("remote_jid", numerosProcessados)
      .lt("created_at", startOfDay.toISOString());
    if (clientIdScope) preHistQ = preHistQ.eq("client_id", clientIdScope);
    await preHistQ;

    // 3. Carregar dados atuais dos leads, colunas do Kanban e Agente IA ativo da conta
    const [
      { data: leadsAtuais },
      { data: cli },
      { data: cols },
      { data: activeAgent },
    ] = await Promise.all([
      adminClient
        .from("leads_extraidos")
        .select('remoteJid, status, nome_negocio, primeiro_contato_source, primeiro_contato_at, created_at, last_analysis_hash, lead_type, client_id, previa_status, link_previa, reuniao_horario_confirmado')
        .in("remoteJid", numerosProcessados)
        .eq("client_id", clientIdScope),
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
    }> = {};

    for (const l of (leadsAtuais || []) as any[]) {
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
    const dynamicHierarquia: Record<string, number> = {};
    kanbanCols.forEach((c, i) => {
      dynamicHierarquia[c.status_key] = i;
    });

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

    const colPrimeiroContato = findColKey(/primeiro_contato|abordado|disparo|contato_inicial/i, "primeiro_contato");
    const colRecusa = findColKey(/sem_interesse|perdid|recus|nao_quis/i, "sem_interesse");
    const colDescarte = findColKey(/descartad|invalid|errado|robo|ura|sem_contato/i, "descartado");

    // 4. Camada 0 e Camada 1: Filtros de Economia Extrema de Tokens (0 Tokens)
    const decisoesHeuristicas: Record<string, { status: string; razao: string; resumo: string; lead_type?: string }> = {};
    const skippedSemMudanca: string[] = [];
    const skippedCacheHit: string[] = [];
    const candidatosParaIA: string[] = [];
    const hashAtualMap: Record<string, string> = {};

    for (const jid of numerosProcessados) {
      const statusAtual = statusAtualMap[jid] || "nenhum";
      const msgs = grouped[jid] || [];
      const st = rawStatsByJid[jid];
      const clienteRespondeu = (st?.clientCount || 0) > 0;
      const sdrMandou = (st?.sdrCount || 0) > 0;
      const ultimaMsgCliente = st?.clientTexts?.length ? st.clientTexts[st.clientTexts.length - 1] : "";
      const textoCliente = ultimaMsgCliente.toLowerCase().trim();

      const hashAtual = hashChatContent(msgs.slice(-15), statusAtual);
      hashAtualMap[jid] = hashAtual;
      const meta = leadMetaMap[jid];

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
      if (!clienteRespondeu && sdrMandou) {
        if (statusAtual === "novo" || statusAtual === "nenhum" || !dynamicStatusKeys.includes(statusAtual)) {
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

      candidatosParaIA.push(jid);
    }

    // 5. Agendamentos estruturados dos candidatos
    const appointmentsByJid = new Map<string, Array<{ start_at: string; end_at: string; status: string; title?: string; service_name?: string | null }>>();
    if (candidatosParaIA.length > 0) {
      try {
        const { data: apptRows } = await adminClient
          .from("appointments")
          .select("remote_jid, start_at, end_at, status, title, service_name")
          .in("remote_jid", candidatosParaIA)
          .eq("client_id", clientIdScope)
          .in("status", ["confirmed", "completed", "no_show"]);
        for (const row of apptRows || []) {
          if (!appointmentsByJid.has(row.remote_jid)) appointmentsByJid.set(row.remote_jid, []);
          appointmentsByJid.get(row.remote_jid)!.push(row);
        }
      } catch {}
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
    let resultadosLista: any[] = [];
    const BATCH_SIZE = 12;

    for (let i = 0; i < candidatosParaIA.length; i += BATCH_SIZE) {
      const loteJids = candidatosParaIA.slice(i, i + BATCH_SIZE);
      const threadsTexto = loteJids
        .map((jid) => {
          const msgs = grouped[jid].slice(-14);
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
          return `--- CHAT ID: ${jid} ---\n- EMPRESA: ${nome}\n- STATUS ATUAL NO KANBAN: "${statusAtual}"\n- TOTAL MSGS (SDR=${st.sdrCount}, CLIENTE=${st.clientCount})${apptInfo}${previaInfo}\nHISTÓRICO DA CONVERSA:\n${msgs.join("\n")}\n--- FIM CHAT ID: ${jid} ---`;
        })
        .join("\n\n");

      const out = await generateText({
        modelRef: model,
        system: systemInstruction,
        prompt: `Analise os ${loteJids.length} chats abaixo e retorne um JSON array com a decisão de coluna para cada "jid":\n\n${threadsTexto}`,
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
      const novoStatus = String(item?.status || "").toLowerCase().trim();
      if (!jid || !numerosProcessados.includes(jid)) continue;
      if (!validStatuses.has(novoStatus)) continue;

      const razao = String(item.razao || "Avaliado pelo Organizador IA.").slice(0, 500);
      const resumo = item.resumo ? String(item.resumo).slice(0, 800) : null;
      const VALID_LEAD_TYPES = ["novo", "cliente_ativo", "recorrente", "unica_duvida", "qualificado", "frio"];
      const leadTypeRaw = item.lead_type ? String(item.lead_type).toLowerCase().trim() : "";
      const leadType = VALID_LEAD_TYPES.includes(leadTypeRaw) ? leadTypeRaw : null;

      const statusAntigo = statusAtualMap[jid] || "nenhum";
      const isLeadNovo = !statusAtualMap[jid];
      const statusMudou = statusAntigo !== novoStatus;

      if (isLeadNovo) {
        upsertsBatch.push({
          remoteJid: jid,
          status: novoStatus,
          justificativa_ia: razao,
          resumo_ia: resumo,
          ia_last_analyzed_at: nowIso,
          last_analysis_hash: hashAtualMap[jid] || null,
          last_analysis_at: nowIso,
          lead_type: leadType,
          nome_negocio: "Lead Via Chat (" + jid.split("@")[0] + ")",
          client_id: clientIdScope,
        });
        alteracoes++;
      } else {
        const update: any = {
          remoteJid: jid,
          client_id: clientIdScope,
          justificativa_ia: razao,
          resumo_ia: resumo,
          ia_last_analyzed_at: nowIso,
          last_analysis_hash: hashAtualMap[jid] || null,
          last_analysis_at: nowIso,
          updated_at: nowIso,
        };
        if (leadType) update.lead_type = leadType;
        if (statusMudou) {
          update.status = novoStatus;
          alteracoes++;
        }
        upsertsBatch.push(update);
      }

      const nome_negocio = isLeadNovo
        ? "Lead Via Chat (" + jid.split("@")[0] + ")"
        : nomeNegocioMap[jid] || "Desconhecido";

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
  } catch (err: any) {
    console.error("Erro AI-Organizer:", err);
    await finishRun("error", { error: err?.message?.slice(0, 500) });
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
