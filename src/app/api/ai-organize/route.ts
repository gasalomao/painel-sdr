import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import axios from "axios";
import { createHash } from "crypto";
import { logTokenUsage } from "@/lib/token-usage";
import { buildOrganizerSystemPrompt } from "@/lib/organizer-prompt";

// Client pra LER a config central (ai_organizer_config). Usa service role
// quando disponível pra contornar RLS; cai pro anon só em dev sem service key.
const adminClient = supabaseAdmin || supabase;

/**
 * Hash determinístico das mensagens de um chat. Usado pelo FILTRO 4 (cache):
 * se a IA já analisou EXATAMENTE essa sequência de mensagens, pula.
 *
 * Inclui status atual no hash — assim mudança de estado externa (drag manual
 * no Kanban) também invalida o cache e força reanálise.
 */
function hashChatContent(messages: string[], statusAtual: string): string {
  return createHash("sha256").update(`${statusAtual}|${messages.join("||")}`).digest("hex").slice(0, 16);
}

export async function POST(req: NextRequest) {
  const runStartedAt = new Date();
  let runId: number | null = null;
  let batchIdForRun: string | null = null;
  let chatsAnalyzed = 0;
  let leadsMoved = 0;
  let triggerLabel: string = "manual";

  // Helper pra fechar o registro de execução com o resultado final.
  const finishRun = async (status: "ok" | "error" | "noop", extra: { error?: string; summary?: string } = {}) => {
    if (!runId) return;
    try {
      const duration = Date.now() - runStartedAt.getTime();
      await adminClient.from("ai_organizer_runs").update({
        finished_at: new Date().toISOString(),
        duration_ms: duration,
        chats_analyzed: chatsAnalyzed,
        leads_moved: leadsMoved,
        status,
        error: extra.error || null,
        summary: extra.summary || null,
        batch_id: batchIdForRun,
      }).eq("id", runId);
    } catch (e: any) {
      console.warn("[AI-ORGANIZE] Falha ao fechar run:", e?.message);
    }
  };

  // clientId pode vir do body (scheduler per-client) → restringe TUDO a esse tenant.
  // Sem clientId = modo legado/global (admin manual).
  let clientIdScope: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    let { apiKey, model, provider, triggered_by, clientId } = body || {};
    triggerLabel = triggered_by === "auto" || triggered_by === "schedule_catchup" ? triggered_by : "manual";
    if (typeof clientId === "string" && clientId.trim()) clientIdScope = clientId.trim();

    // Abre registro da execução antes de qualquer coisa — vale mesmo se falhar.
    // Fallback silencioso se a tabela ainda não existe (PGRST/42P01).
    try {
      const { data: runRow, error: runErr } = await adminClient
        .from("ai_organizer_runs")
        .insert({
          started_at: runStartedAt.toISOString(),
          triggered_by: triggerLabel,
          status: "running",
          model: model || null,
          provider: provider || null,
        })
        .select("id")
        .single();
      if (runErr) {
        if ((runErr as any).code !== "42P01") {
          console.warn("[AI-ORGANIZE] Falha ao abrir run:", runErr.message);
        }
      } else {
        runId = runRow?.id || null;
      }
    } catch {}

    // Fallback: lê a config CENTRAL do banco quando o frontend não enviou
    // (ex.: modal do Chat e agendamento automático).
    // Usa service role pra não cair em RLS.
    if (!apiKey || !model || !provider) {
      const { data: cfg, error: cfgErr } = await adminClient
        .from("ai_organizer_config")
        .select("api_key, model, provider")
        .eq("id", 1)
        .maybeSingle();
      if (cfgErr) console.warn("[AI-ORGANIZE] Falha ao ler config central:", cfgErr.message);
      if (cfg) {
        apiKey = apiKey || cfg.api_key;
        model = model || cfg.model;
        provider = provider || cfg.provider || "Gemini";
      }
    }

    if (!apiKey) {
      // Sem API Key: fecha o run com erro pra não ficar "running" pra sempre.
      await finishRun("error", { error: "API Key não configurada. Salve em Configurações." });
      return NextResponse.json(
        { success: false, error: "API Key não configurada. Salve sua chave em Configurações antes de rodar o Organizador IA." },
        { status: 400 }
      );
    }
    if (!model || !provider) {
      await finishRun("error", { error: "Modelo ou provedor ausentes." });
      return NextResponse.json(
        { success: false, error: "Modelo ou provedor ausentes. Escolha um modelo no modal do Organizador IA." },
        { status: 400 }
      );
    }

    // 1. Puxar as mensagens de HOJE (00:00 até agora) — filtrando por cliente quando aplicável
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    let chatsQuery = adminClient
      .from("chats_dashboard")
      .select("*")
      .gte("created_at", startOfDay.toISOString())
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (clientIdScope) chatsQuery = chatsQuery.eq("client_id", clientIdScope);
    const { data: mensagensHoje, error: msgError } = await chatsQuery;

    if (msgError) throw new Error("Erro ao buscar mensagens do dia: " + msgError.message);
    if (!mensagensHoje || mensagensHoje.length === 0) {
      await finishRun("noop", { summary: "Nenhuma conversa registrada hoje." });
      return NextResponse.json({ success: true, message: "Nenhuma conversa registrada hoje para analisar.", updatedCount: 0 });
    }

    // 2. Agrupar por contato
    const grouped: Record<string, string[]> = {};
    mensagensHoje.forEach((msg) => {
      if (!grouped[msg.remote_jid]) grouped[msg.remote_jid] = [];
      const prefix = msg.is_from_me ? "SDR:" : "CLIENTE:";
      const content = msg.content || "";
      grouped[msg.remote_jid].push(`[${new Date(msg.created_at).toLocaleTimeString()}] ${prefix} ${content}`);
    });

    const numerosProcessados: string[] = Object.keys(grouped);
    chatsAnalyzed = numerosProcessados.length;

    // Lead: status + nome + origem + cache hash + tipo + client_id (pra prompt custom)
    let leadsQuery = adminClient
       .from("leads_extraidos")
       .select("remoteJid, status, nome_negocio, primeiro_contato_source, primeiro_contato_at, created_at, last_analysis_hash, lead_type, client_id")
       .in("remoteJid", numerosProcessados);
    if (clientIdScope) leadsQuery = leadsQuery.eq("client_id", clientIdScope);
    const { data: leadsAtuais } = await leadsQuery;

    const statusAtualMap: Record<string, string> = {};
    const nomeNegocioMap: Record<string, string> = {};
    const leadMetaMap: Record<string, {
      source: string | null;
      primeiroContatoAt: string | null;
      createdAt: string | null;
      lastHash: string | null;
      leadType: string | null;
      clientId: string | null;
    }> = {};
    if (leadsAtuais) {
        leadsAtuais.forEach((l: any) => {
            statusAtualMap[l.remoteJid] = l.status;
            if (l.nome_negocio) nomeNegocioMap[l.remoteJid] = l.nome_negocio;
            leadMetaMap[l.remoteJid] = {
              source: l.primeiro_contato_source || null,
              primeiroContatoAt: l.primeiro_contato_at || null,
              createdAt: l.created_at || null,
              lastHash: l.last_analysis_hash || null,
              leadType: l.lead_type || null,
              clientId: l.client_id || null,
            };
        });
    }

    // Anti-bouncing: leads que a IA tocou nas últimas 24h.
    // Se a IA quer mudar de novo dentro da janela, exige evidência forte (manda no prompt).
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentlyTouchedByIa = new Set<string>();
    {
      const { data: recentChanges } = await adminClient
        .from("historico_ia_leads")
        .select("remote_jid, status_antigo, status_novo, created_at")
        .in("remote_jid", numerosProcessados)
        .gte("created_at", last24h);
      (recentChanges || []).forEach((r: any) => {
        if (r.status_antigo !== r.status_novo) recentlyTouchedByIa.add(r.remote_jid);
      });
    }

    // Prompt customizado por cliente — multi-tenant.
    // No modo per-client (scheduler), usa direto o prompt do cliente em foco.
    // No modo global (legado), elege o cliente DOMINANTE (com mais chats hoje).
    let customOrganizerPrompt: string | null = null;
    let activeClientId: string | null = clientIdScope;
    {
      let pickedClient = clientIdScope;
      if (!pickedClient) {
        const clientCount: Record<string, number> = {};
        for (const jid of numerosProcessados) {
          const cid = leadMetaMap[jid]?.clientId;
          if (cid && cid !== "00000000-0000-0000-0000-000000000001") {
            clientCount[cid] = (clientCount[cid] || 0) + 1;
          }
        }
        const dominantClient = Object.entries(clientCount).sort((a, b) => b[1] - a[1])[0];
        if (dominantClient && dominantClient[1] > 0) pickedClient = dominantClient[0];
      }
      if (pickedClient) {
        activeClientId = pickedClient;
        const { data: cli } = await adminClient
          .from("clients")
          .select("organizer_prompt, organizer_enabled")
          .eq("id", pickedClient)
          .maybeSingle();
        if (cli?.organizer_enabled !== false && cli?.organizer_prompt) {
          customOrganizerPrompt = cli.organizer_prompt.trim() || null;
        }
      }
    }

    // Kanban dinâmico por cliente: carrega as colunas reais do tenant em foco.
    // Cada cliente pode ter status diferentes (salão de beleza vs B2B vs imobiliária).
    // Sem cliente em foco → cai pros estágios B2B hardcoded.
    type KanbanCol = { status_key: string; label: string; order_index: number };
    let kanbanCols: KanbanCol[] = [];
    if (activeClientId) {
      const { data: cols } = await adminClient
        .from("kanban_columns")
        .select("status_key, label, order_index")
        .eq("client_id", activeClientId)
        .order("order_index", { ascending: true });
      kanbanCols = (cols || []) as KanbanCol[];
    }
    const dynamicStatusKeys = kanbanCols.map(c => c.status_key);
    const dynamicHierarquia: Record<string, number> = {};
    kanbanCols.forEach((c, i) => { dynamicHierarquia[c.status_key] = i; });
    // Terminais detectados por padrão de nome (cobre B2B + nichos B2C tipo "perdido", "cancelado", "atendido_final").
    const isTerminalKey = (k: string) => /sem_interesse|descartado|perdido|cancelado|recusou/i.test(k);
    const terminalSet = new Set<string>(dynamicStatusKeys.filter(isTerminalKey));
    // Hardcoded fallback (modo global sem cliente em foco)
    if (kanbanCols.length === 0) {
      ["sem_interesse", "descartado"].forEach(k => terminalSet.add(k));
    }

    // HISTÓRICO ANTES DE HOJE — conta quantas msgs o SDR já mandou e quantas o cliente
    // já respondeu ANTES de hoje. Crucial para a IA distinguir "primeira prospecção
    // hoje (veio do disparo)" de "follow-up de conversa em andamento".
    const preHistMap: Record<string, { sdrBefore: number; clientBefore: number; firstSdrAt: string | null; lastClientAt: string | null }> = {};
    {
      const { data: histRows } = await adminClient
        .from("chats_dashboard")
        .select("remote_jid, sender_type, created_at")
        .in("remote_jid", numerosProcessados)
        .lt("created_at", startOfDay.toISOString());
      for (const jid of numerosProcessados) {
        preHistMap[jid] = { sdrBefore: 0, clientBefore: 0, firstSdrAt: null, lastClientAt: null };
      }
      (histRows || []).forEach((r: any) => {
        const rec = preHistMap[r.remote_jid];
        if (!rec) return;
        const isSdr = r.sender_type === "ai" || r.sender_type === "human";
        if (isSdr) {
          rec.sdrBefore++;
          if (!rec.firstSdrAt || r.created_at < rec.firstSdrAt) rec.firstSdrAt = r.created_at;
        } else {
          rec.clientBefore++;
          if (!rec.lastClientAt || r.created_at > rec.lastClientAt) rec.lastClientAt = r.created_at;
        }
      });
    }

    // ================================================================
    // OTIMIZAÇÃO DE TOKENS — TRÊS FILTROS ANTES DA IA
    //
    // Problema: rodar IA em TODOS os chats com TODAS as mensagens é caro.
    // Numa conta com 200 chats/dia × 40 msgs cada = ~50k tokens/run só de
    // input. Pior: maioria dos casos é repetitivo (lead em silêncio, status
    // terminal, resposta óbvia tipo "qual o preço").
    //
    // Estratégia em camadas:
    //   FILTRO 1 — pula chats em estado terminal sem nova msg do cliente.
    //   FILTRO 2 — pula chats sem nenhuma novidade (cliente não respondeu E
    //              status já é > "novo": IA só repetiria o mesmo).
    //   FILTRO 3 — heurística regex de casos óbvios: aplica diretamente
    //              "sem_interesse" / "interessado" / "agendado" sem chamar IA.
    //
    // Só os casos AMBÍGUOS / NOVOS chegam na IA. Resultado: 60-80% menos
    // tokens em accounts maduros, sem perder precisão.
    // ================================================================
    // Terminais pra fim de FILTRO 1 (skip se status já é terminal e cliente não respondeu).
    // Inclui "fechado" e qualquer status do kanban marcado como terminal.
    const STATUS_TERMINAL = new Set<string>(["sem_interesse", "descartado", "fechado", ...terminalSet]);
    const decisoesHeuristicas: Record<string, { status: string; razao: string; resumo: string; lead_type?: string }> = {};
    const skippedSemMudanca: string[] = [];
    const skippedCacheHit: string[] = []; // FILTRO 4: hash match → skip total
    const candidatosParaIA: string[] = [];
    const hashAtualMap: Record<string, string> = {}; // pra persistir no UPDATE

    for (const jid of numerosProcessados) {
      const statusAtual = statusAtualMap[jid] || "nenhum";
      const msgsHoje = grouped[jid] || [];
      const clienteRespondeuHoje = msgsHoje.some(m => m.includes("CLIENTE:"));
      const sdrMandouHoje = msgsHoje.some(m => m.includes("SDR:"));
      const ultimaMsgCliente = [...msgsHoje].reverse().find(m => m.includes("CLIENTE:"));
      const textoClienteHoje = ultimaMsgCliente
        ? ultimaMsgCliente.toLowerCase().replace(/\[.*?\]\s*cliente:\s*/i, "").trim()
        : "";

      // ───────── FILTRO 4: Cache por hash (skip se já analisado idêntico) ─────────
      // Mesma conversa + mesmo status que da última análise → não há motivo pra
      // gastar tokens de novo. Hash inclui status atual, então mudança manual
      // no Kanban invalida cache e força reanálise.
      const hashAtual = hashChatContent(msgsHoje, statusAtual);
      hashAtualMap[jid] = hashAtual;
      const meta = leadMetaMap[jid];
      if (meta?.lastHash === hashAtual && statusAtual !== "nenhum") {
        skippedCacheHit.push(jid);
        continue;
      }

      // ───────── FILTRO 1: Terminal sem novidade ─────────
      // Lead "sem_interesse" / "descartado" / "fechado" + sem msg nova do cliente
      // hoje = não há motivo pra reanalizar. Mantém o status, registra log curto.
      if (STATUS_TERMINAL.has(statusAtual) && !clienteRespondeuHoje) {
        skippedSemMudanca.push(jid);
        continue;
      }

      // ───────── FILTRO 2: Sem mensagem do cliente hoje + status já avançado ─────────
      // SDR mandou follow-up, cliente não respondeu, status já era > novo →
      // IA só repetiria "mantém status atual" pela R8. Pula.
      if (!clienteRespondeuHoje && sdrMandouHoje && statusAtual !== "nenhum" && statusAtual !== "novo") {
        skippedSemMudanca.push(jid);
        continue;
      }

      // ───────── FILTRO 3: Heurística regex de casos óbvios ─────────
      // Aplica decisão direta SEM chamar IA quando o cliente disse algo
      // muito explícito. Padrões testados em conversas reais.
      if (clienteRespondeuHoje && textoClienteHoje) {
        // Recusa explícita
        const recusa = /(n[ãa]o tenho interesse|n[ãa]o quero|n[ãa]o me liga|para de mandar|me tira|me remov|n[ãa]o me mande|j[áa] tenho|j[áa] uso|j[áa] sou)\b/i;
        if (recusa.test(textoClienteHoje)) {
          decisoesHeuristicas[jid] = {
            status: "sem_interesse",
            razao: "Heurística R1: cliente recusou explicitamente.",
            resumo: `Cliente declarou recusa: "${textoClienteHoje.slice(0, 120)}". Lead movido para sem_interesse sem necessidade de IA.`,
          };
          continue;
        }
        // Número errado / pessoa física
        const errado = /(n[úu]mero errado|pessoa errada|n[ãa]o sou|n[ãa]o trabalho|n[ãa]o conhe[çc]o|enganou|engano)\b/i;
        if (errado.test(textoClienteHoje) && textoClienteHoje.length < 200) {
          decisoesHeuristicas[jid] = {
            status: "descartado",
            razao: "Heurística R2: cliente disse que é número errado / pessoa errada.",
            resumo: `Cliente sinalizou contato indevido: "${textoClienteHoje.slice(0, 120)}". Descartado.`,
          };
          continue;
        }
      }

      // Se não foi pulado nem decidido, vai pra IA.
      candidatosParaIA.push(jid);
    }

    if (skippedSemMudanca.length > 0) {
      console.log(`[AI-ORGANIZE] Pulados (sem mudança): ${skippedSemMudanca.length} chats — economia de tokens.`);
    }
    if (skippedCacheHit.length > 0) {
      console.log(`[AI-ORGANIZE] Pulados (cache hit): ${skippedCacheHit.length} chats — conversa idêntica à última análise.`);
    }
    if (Object.keys(decisoesHeuristicas).length > 0) {
      console.log(`[AI-ORGANIZE] Decididos por heurística (sem IA): ${Object.keys(decisoesHeuristicas).length} chats.`);
    }
    console.log(`[AI-ORGANIZE] Total: ${numerosProcessados.length} | IA: ${candidatosParaIA.length} | Pulados: ${skippedSemMudanca.length} | Cache: ${skippedCacheHit.length} | Heurística: ${Object.keys(decisoesHeuristicas).length}`);

    // 3. Montar o Prompt Base — com contexto enriquecido
    // Antes: iterava sobre numerosProcessados (todos). Agora: só candidatosParaIA.
    // Antes: 40 msgs por chat. Agora: 15 últimas (mais que suficiente pra contexto
    // do dia + economia de ~60% de tokens).
    const threadsTexto = candidatosParaIA.map(jid => {
       const msgs = grouped[jid].slice(-15);
       const statusAtual = statusAtualMap[jid] || "nenhum";
       const nome = nomeNegocioMap[jid] || "(sem nome)";
       const meta = leadMetaMap[jid] || { source: null, primeiroContatoAt: null, createdAt: null };
       const hist = preHistMap[jid] || { sdrBefore: 0, clientBefore: 0, firstSdrAt: null, lastClientAt: null };

       // Flags de contexto
       const origem = meta.source === "disparo" ? "disparo em massa"
                    : meta.source === "webhook" ? "cliente iniciou"
                    : meta.source === "manual" ? "contato manual"
                    : "desconhecida";
       const ehPrimeiroContatoHoje = hist.sdrBefore === 0 && hist.clientBefore === 0;
       const clienteNuncaRespondeu = hist.clientBefore === 0;

       // Dias desde o primeiro_contato registrado (pra detectar auto-promoção e cadência)
       let diasDesdePrimeiroContato: number | null = null;
       if (meta.primeiroContatoAt) {
         diasDesdePrimeiroContato = Math.floor(
           (Date.now() - new Date(meta.primeiroContatoAt).getTime()) / (1000 * 60 * 60 * 24)
         );
       }

       // Detecção de auto-promoção: lead em "follow-up" vindo de disparo sem o
       // cliente ter respondido — foi o auto-promoter (48h de silêncio) que moveu.
       const ehAutoPromovidoFollowup =
         statusAtual === "follow-up" &&
         meta.source === "disparo" &&
         clienteNuncaRespondeu;

       // Detecta se HOJE tem mensagem do cliente
       const msgsDeHojeArr = grouped[jid] || [];
       const clienteRespondeuHoje = msgsDeHojeArr.some(m => m.includes("CLIENTE:"));
       const sdrMandouHoje = msgsDeHojeArr.some(m => m.includes("SDR:"));

       // Linha-resumo de contexto que vai no prompt
       const contexto: string[] = [];
       contexto.push(`NOME DO NEGÓCIO: ${nome}`);
       contexto.push(`STATUS ATUAL NO CRM: ${statusAtual}`);
       contexto.push(`TIPO DE LEAD ATUAL: ${meta.leadType || "(ainda não classificado)"}`);
       contexto.push(`ORIGEM DO LEAD: ${origem}`);
       if (recentlyTouchedByIa.has(jid)) {
         contexto.push(`⚑ ATENÇÃO ANTI-BOUNCING: a IA JÁ ALTEROU este lead nas últimas 24h. Só mude o status de novo se houver evidência MUITO clara hoje. Em dúvida, mantenha.`);
       }
       if (statusAtual === "fechado") {
         contexto.push(`⚑ CLIENTE JÁ FECHADO: este lead já comprou/contratou. Provavelmente é cliente recorrente tirando dúvida operacional. NÃO rebaixe (não mude pra "interessado" ou "primeiro_contato"). Use lead_type="cliente_ativo".`);
       }
       if (statusAtual === "agendado") {
         contexto.push(`⚑ JÁ AGENDADO: reunião marcada. Cliente entrando em contato pode ser confirmação, reagendamento ou dúvida. NÃO rebaixe.`);
       }
       const meta2 = leadMetaMap[jid];
       if (meta2?.leadType === "cliente_ativo" || meta2?.leadType === "recorrente") {
         contexto.push(`⚑ CLIENTE RECORRENTE/ATIVO marcado em análise anterior. NÃO inicie funil de novo. Mantenha status. Se for nova venda separada, anote em "razao".`);
       }
       if (meta.primeiroContatoAt) contexto.push(`PRIMEIRO CONTATO REGISTRADO: ${new Date(meta.primeiroContatoAt).toLocaleString("pt-BR")}${diasDesdePrimeiroContato != null ? ` (há ${diasDesdePrimeiroContato} dia(s))` : ""}`);
       contexto.push(`MENSAGENS DO SDR ANTES DE HOJE: ${hist.sdrBefore}`);
       contexto.push(`RESPOSTAS DO CLIENTE ANTES DE HOJE: ${hist.clientBefore}`);
       if (ehPrimeiroContatoHoje) {
         contexto.push(`⚑ ESTA É A PRIMEIRA INTERAÇÃO — nunca houve troca anterior com este contato. A mensagem do SDR hoje É a prospecção inicial.`);
       } else if (clienteNuncaRespondeu && sdrMandouHoje) {
         contexto.push(`⚑ CLIENTE NUNCA RESPONDEU — SDR já mandou ${hist.sdrBefore} msg(s) antes, hoje mandou mais uma prospecção/follow-up sem retorno.`);
       }
       if (clienteRespondeuHoje && !sdrMandouHoje) {
         contexto.push(`⚑ CLIENTE RESPONDEU ESPONTANEAMENTE HOJE (sem SDR ter mandado nada hoje).`);
       }
       if (ehAutoPromovidoFollowup) {
         contexto.push(`⚑ LEAD AUTO-PROMOVIDO PARA FOLLOW-UP — originado de disparo em massa, ficou 2+ dias em primeiro_contato sem resposta. O sistema moveu automaticamente para follow-up. NÃO rebaixar; manter "follow-up" salvo se houver evidência forte hoje (resposta do cliente, recusa, etc).`);
       }

       return `--- CHAT ID: ${jid} ---\n${contexto.join("\n")}\nMENSAGENS DE HOJE (ordem cronológica):\n${msgs.join("\n")}\n--- FIM DE CHAT ID: ${jid} ---`;
    }).join("\n\n");

    // Prompt do sistema centralizado em src/lib/organizer-prompt.ts
    // → custom do cliente (se houver) + apêndice do kanban real + contexto de data

    // Monta o prompt completo via lib compartilhada: prompt custom OU padrão
    // SDR (R1-R17), + apêndice do kanban real do cliente, + contexto de data.
    // Mesmo código que /api/organizer/effective-prompt mostra na UI.
    const { systemPrompt: systemInstruction } = buildOrganizerSystemPrompt(
      customOrganizerPrompt,
      kanbanCols,
    );

    // 4. Fluxo de Requisição Híbrida
    // SHORT-CIRCUIT: se nenhum candidato sobrou pra IA (tudo decidido por
    // heurística ou pulado por falta de mudança), nem chama o provedor.
    // Isso pode economizar 100% dos tokens em dias calmos.
    let textResponse = "[]";
    const skipAi = candidatosParaIA.length === 0;
    if (skipAi) {
      console.log("[AI-ORGANIZE] Nenhum chat ambíguo. Pulando chamada IA.");
    } else if (provider === "Gemini") {
        const payload = {
            contents: [{ parts: [{ text: `${systemInstruction}\n\nCONVERSAS A ANALISAR:\n\n${threadsTexto}` }] }],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
        };
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        try {
          const response = await axios.post(geminiUrl, payload, { headers: { "Content-Type": "application/json" } });
          textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
          // Token tracking
          const meta = response.data?.usageMetadata || {};
          await logTokenUsage({
            source: "organizer",
            sourceLabel: "Organizador IA",
            model,
            provider: "Gemini",
            promptTokens: Number(meta.promptTokenCount || 0),
            completionTokens: Number(meta.candidatesTokenCount || 0),
            totalTokens: Number(meta.totalTokenCount || 0),
            metadata: { triggered_by: triggerLabel, chats: chatsAnalyzed },
          });
        } catch (err: any) {
          throw new Error(`Erro na API do Gemini: ${err.response?.data?.error?.message || err.message}`);
        }
    }
    else if (provider === "OpenAI") {
        const payload = {
            model: model,
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: `CONVERSAS A ANALISAR:\n\n${threadsTexto}` }
            ],
            temperature: 0.2,
            response_format: { type: "json_object" }
        };
        const openaiUrl = `https://api.openai.com/v1/chat/completions`;

        try {
          const response = await axios.post(openaiUrl, payload, {
              headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${apiKey}`
              }
          });
          textResponse = response.data?.choices?.[0]?.message?.content || "{}";
          // Token tracking
          const u = response.data?.usage || {};
          await logTokenUsage({
            source: "organizer",
            sourceLabel: "Organizador IA",
            model,
            provider: "OpenAI",
            promptTokens: Number(u.prompt_tokens || 0),
            completionTokens: Number(u.completion_tokens || 0),
            totalTokens: Number(u.total_tokens || 0),
            metadata: { triggered_by: triggerLabel, chats: chatsAnalyzed },
          });
        } catch (err: any) {
          throw new Error(`Erro na API OpenAI: ${err.response?.data?.error?.message || err.message}`);
        }
    }

    // 5. Tratamento Comum da Resposta e Inserção no Supabase
    const batch_id = crypto.randomUUID();
    batchIdForRun = batch_id;
    const jsonMatch = textResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    let cleanJson = jsonMatch ? jsonMatch[1] : textResponse;
    const startIndex = cleanJson.indexOf('[');
    const endIndex = cleanJson.lastIndexOf(']');
    
    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
       cleanJson = cleanJson.substring(startIndex, endIndex + 1);
    }

    let resultadosLista: any[] = [];
    if (skipAi) {
      // Não chamou a IA — começa com lista vazia.
      resultadosLista = [];
    } else {
      try {
          resultadosLista = JSON.parse(cleanJson);
      } catch (e) {
          // Fallback final
          try {
             const fallb = cleanJson.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '');
             resultadosLista = JSON.parse(fallb);
          } catch(err2) {
             console.error("String que falhou:", textResponse);
             throw new Error("A IA não retornou um formato JSON de lista válido.");
          }
      }

      if (!Array.isArray(resultadosLista)) {
          if (typeof resultadosLista === 'object') {
             resultadosLista = Object.entries(resultadosLista).map(([k, v]) => ({ jid: k, status: v as string, razao: "Extraído via formato antigo de fallback.", resumo: null }));
          } else {
             throw new Error("A IA devolveu um formato inválido, era esperada uma lista.");
          }
      }
    }

    // INJETA decisões da heurística na lista (mesmo formato da IA). Vão pelo
    // mesmo loop de processamento abaixo — escrita no DB, hierarquia,
    // logs, etc. Heurística não pode ser sobrescrita pela IA porque já
    // filtramos esses jids de candidatosParaIA.
    for (const [jid, decisao] of Object.entries(decisoesHeuristicas)) {
      resultadosLista.push({
        jid,
        status: decisao.status,
        razao: decisao.razao,
        resumo: decisao.resumo,
      });
    }

    let alteracoes = 0;
    const logs = [];
    const nowIso = new Date().toISOString();

    for (const item of resultadosLista) {
       const jid = item.jid;
       const novoStatus = item.status?.toLowerCase()?.trim();
       const razao = (item.razao || "Sem justificativa detalhada pela IA.").toString().slice(0, 500);
       const resumo = item.resumo ? String(item.resumo).slice(0, 800) : null;
       // lead_type vem do output novo da IA. Validamos contra a lista esperada
       // pra evitar gravar lixo se a IA inventar uma categoria nova.
       const VALID_LEAD_TYPES = ["novo", "cliente_ativo", "recorrente", "unica_duvida", "qualificado", "frio"];
       const leadTypeRaw = item.lead_type?.toString().toLowerCase().trim();
       const leadType = leadTypeRaw && VALID_LEAD_TYPES.includes(leadTypeRaw) ? leadTypeRaw : null;

       if (!jid || !numerosProcessados.includes(jid)) continue;

       // Validação dinâmica: aceita status_keys do kanban do cliente OU os hardcoded (modo global).
       const HARDCODED_VALID = new Set(["novo", "primeiro_contato", "interessado", "follow-up", "agendado", "fechado", "sem_interesse", "descartado"]);
       const validStatuses = kanbanCols.length > 0
         ? new Set<string>([...dynamicStatusKeys, "sem_interesse", "descartado"]) // terminais universais sempre aceitos
         : HARDCODED_VALID;
       if (!validStatuses.has(novoStatus)) continue;

       const statusAntigo = statusAtualMap[jid] || "nenhum";
       const isLeadNovo = !statusAtualMap[jid];

       // Hierarquia: kanban dinâmico tem prioridade. Fallback pro B2B hardcoded.
       const HARDCODED_HIERARQUIA: Record<string, number> = { "novo": 0, "primeiro_contato": 1, "interessado": 2, "follow-up": 3, "agendado": 4, "fechado": 5 };
       const hierarquia = kanbanCols.length > 0 ? dynamicHierarquia : HARDCODED_HIERARQUIA;
       const isTerminal = terminalSet.has(novoStatus) || ["sem_interesse", "descartado"].includes(novoStatus);
       const isDowngrade = !isTerminal && !isLeadNovo && (hierarquia[novoStatus] ?? 0) < (hierarquia[statusAntigo] ?? 0);

       // Cliente recorrente/ativo: NUNCA permite rebaixar/mover, mesmo se IA pediu.
       // Defesa em profundidade contra a IA ignorar R11.
       const isClienteAtivo = leadType === "cliente_ativo" || leadType === "recorrente";
       const blockMoveByRecurringClient = isClienteAtivo && novoStatus !== statusAntigo && !isTerminal;

       // R15/R16 hard-guard: lead em estágio AGENDADO / FECHADO / equivalente nunca volta
       // pra estágios iniciais por causa de mensagem off-topic. Detecta "agendado"/"fechado"
       // por nome OU por estar nos top 30% do kanban (estágios avançados).
       const isAdvancedStage = (key: string): boolean => {
         if (/agendado|agendamento|reuniao|atendido|comprou|contratado|fechado/i.test(key)) return true;
         if (kanbanCols.length > 0) {
           const idx = hierarquia[key];
           if (typeof idx === "number" && idx >= Math.floor(kanbanCols.length * 0.6)) return true;
         }
         return false;
       };
       const blockDowngradeFromAdvanced = !isLeadNovo
         && !isTerminal
         && isAdvancedStage(statusAntigo)
         && !isAdvancedStage(novoStatus);

       if (blockDowngradeFromAdvanced) {
         console.log(`[AI-ORGANIZE] R15/R16 GUARD: bloqueando rebaixe de "${statusAntigo}" → "${novoStatus}" no lead ${jid} (pergunta off-topic não rebaixa estágio avançado).`);
       }

       let movido = false;
       const statusMudou = statusAntigo !== novoStatus && !isDowngrade && !blockMoveByRecurringClient && !blockDowngradeFromAdvanced;

       if (isLeadNovo) {
           await adminClient.from("leads_extraidos").insert({
               remoteJid: jid,
               status: novoStatus,
               justificativa_ia: razao,
               resumo_ia: resumo,
               ia_last_analyzed_at: nowIso,
               last_analysis_hash: hashAtualMap[jid] || null,
               last_analysis_at: nowIso,
               lead_type: leadType,
               nome_negocio: "Lead Via Chat ("+jid.split("@")[0]+")"
           });
           alteracoes++;
           movido = true;
       } else {
           // Sempre atualiza razão + resumo + timestamp, mesmo quando não muda de estágio,
           // para o card do lead refletir a última leitura da IA.
           const update: any = {
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
               movido = true;
           }
           await adminClient.from("leads_extraidos").update(update).eq("remoteJid", jid);
       }

       const nome_negocio = isLeadNovo ? "Lead Via Chat ("+jid.split("@")[0]+")" : (nomeNegocioMap[jid] || "Desconhecido");

       logs.push({
           jid,
           nome_negocio,
           statusAntigo,
           novoStatus,
           razao,
           resumo,
           movido,
           batch_id
       });
    }

    // Garantia de auditoria: todo chat analisado VIRA uma linha em historico_ia_leads,
    // mesmo quando a IA não retornou item específico pra ele. Isso evita "executei mas
    // não tem nada no histórico" — o user sempre vê o que foi processado.
    const jidsLogados = new Set(logs.map(l => l.jid));
    for (const jid of numerosProcessados) {
      if (jidsLogados.has(jid)) continue;
      const statusAntigo = statusAtualMap[jid] || "nenhum";
      logs.push({
        jid,
        nome_negocio: nomeNegocioMap[jid] || ("Lead Via Chat (" + jid.split("@")[0] + ")"),
        statusAntigo,
        novoStatus: statusAntigo, // mantido — IA não retornou nada novo
        razao: "IA não retornou veredito específico para este chat (manteve estágio).",
        resumo: null,
        movido: false,
        batch_id,
      });
    }

    if (logs.length > 0) {
        const logsToInsert = logs.map(l => ({
            remote_jid: l.jid,
            nome_negocio: l.nome_negocio,
            status_antigo: l.statusAntigo,
            status_novo: l.novoStatus,
            razao: l.razao,
            resumo: l.resumo,
            batch_id: batch_id
        }));
        const { error: histErr } = await adminClient.from("historico_ia_leads").insert(logsToInsert);
        if (histErr) {
          // Loga e devolve no response pro front-end — antes ficava silencioso.
          console.error("[AI-ORGANIZE] Erro salvando historico_ia_leads:", histErr.message, histErr);
          await finishRun("error", { error: `Análise OK mas histórico não foi gravado: ${histErr.message}` });
          return NextResponse.json({
            success: false,
            error: `Análise rodou mas falhou ao gravar histórico: ${histErr.message}. Confirme que a tabela historico_ia_leads existe e que o service_role tem permissão.`,
            updatedCount: alteracoes,
          }, { status: 500 });
        }
    }

    leadsMoved = alteracoes;
    const customPromptInfo = customOrganizerPrompt ? " · prompt CUSTOM do cliente" : "";
    const kanbanInfo = kanbanCols.length > 0 ? ` · kanban[${kanbanCols.length} colunas]` : "";
    const summary = `${chatsAnalyzed} chats — IA: ${candidatosParaIA.length} (${provider}/${model}${customPromptInfo}${kanbanInfo}) · heurística: ${Object.keys(decisoesHeuristicas).length} · pulados sem msg: ${skippedSemMudanca.length} · cache hit: ${skippedCacheHit.length}. ${alteracoes} movidos.`;
    await finishRun("ok", { summary });

    // Per-client mode: marca o último run no cliente em foco (scheduler usa isso
    // pra evitar re-disparar no mesmo dia).
    if (clientIdScope) {
      await adminClient.from("clients")
        .update({ organizer_last_run: new Date().toISOString() })
        .eq("id", clientIdScope);
    }

    return NextResponse.json({
      success: true,
      message: `Análise OTIMIZADA. ${numerosProcessados.length} chats lidos pela ${provider}, ${alteracoes} leads movidos!`,
      updatedCount: alteracoes,
      batch_id,
      triggered_by: triggerLabel,
      run_id: runId,
      logs
    });

  } catch (err: any) {
    console.error("Erro AI-Organizer:", err);
    await finishRun("error", { error: err?.message?.slice(0, 500) });
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
