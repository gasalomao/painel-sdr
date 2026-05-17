import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import axios from "axios";
import { createHash } from "crypto";
import { logTokenUsage } from "@/lib/token-usage";

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

    // Se o cliente DOMINANTE tem prompt custom, usa ele como SISTEMA principal
    // e mantém regras técnicas (R1-R14 + formato) como apêndice obrigatório.
    // Senão usa o prompt SDR B2B hardcoded como sistema.
    const baseSystemInstruction = customOrganizerPrompt || `
Você é um classificador SÊNIOR de leads B2B para um funil SDR (Sales Development Representative).
Vai receber conversas de HOJE, agrupadas por contato. Cada bloco vem com CONTEXTO HISTÓRICO rico:

- STATUS ATUAL NO CRM
- ORIGEM DO LEAD (disparo em massa / cliente iniciou / contato manual / desconhecida)
- PRIMEIRO CONTATO REGISTRADO (data e hora — quando o lead foi promovido a primeiro_contato)
- MENSAGENS DO SDR ANTES DE HOJE (contagem acumulada)
- RESPOSTAS DO CLIENTE ANTES DE HOJE (contagem acumulada)
- FLAGS marcados com ⚑ (ESTA É A PRIMEIRA INTERAÇÃO / CLIENTE NUNCA RESPONDEU / CLIENTE RESPONDEU ESPONTANEAMENTE)

Sua missão: decidir o estágio REAL com base no conteúdo de HOJE + HISTÓRICO + estágio atual. SEM alucinar, SEM achismo, SEM mover só porque "melhorou o tom".

## ESTÁGIOS VÁLIDOS (use o identificador exato, em minúsculas):

1. "novo" — Lead existe, nunca foi contatado. NÃO use este estágio se o SDR já mandou mensagem (inclusive hoje via disparo).
2. "primeiro_contato" — SDR já mandou a prospecção inicial. O cliente pode ter respondido algo curto/neutro ("oi", "pode mandar", "quem é?") OU pode ainda não ter respondido (caso típico de disparo em massa). Status válido mesmo sem resposta do cliente.
3. "interessado" — O CLIENTE demonstrou interesse REAL: perguntou preço, condições, funcionalidades, prazos, pediu detalhes, pediu apresentação, disse "quero saber mais", "me explica melhor".
4. "follow-up" — Ficou combinado um retorno FUTURO concreto. Ex: "me liga amanhã", "me manda na segunda", "preciso pensar, te respondo semana que vem", SDR disse "te envio o material em X dias". NÃO é "o SDR está mandando follow-up" — é "ficou combinado retorno futuro".
5. "agendado" — Reunião/call/visita marcada com DATA+HORA explícitas, com confirmação dos DOIS LADOS. Ex: "quarta 14h combinado" respondido por "perfeito, confirmado".
6. "fechado" — Venda/contratação CONCLUÍDA. Cliente confirmou compra, fez pagamento, assinou contrato, disse "fechado, pode emitir", "já paguei", "contrato assinado". ⚠️ JAMAIS usar "fechado" para recusa.
7. "sem_interesse" — Cliente recusou explicitamente, pediu pra não receber mais mensagens, disse "não tenho interesse", "já tenho", bloqueou ou xingou. Terminal.
8. "descartado" — Número inválido, pessoa errada, fora do perfil, é pessoa física, "não é comercial", spam. Terminal.

## REGRAS DE DECISÃO (ordem de avaliação — pare na primeira que casar):

R1. CLIENTE recusou/xingou/pediu remoção/"não tenho interesse"/"pare de enviar" → "sem_interesse".
R2. CLIENTE disse que não é o negócio alvo / é pessoa física / número errado → "descartado".
R3. CONFIRMAÇÃO clara e mútua de compra/pagamento/contrato assinado HOJE → "fechado".
R4. Reunião com DATA+HORA explícitas confirmada pelos dois lados → "agendado".
R5. Retorno futuro concreto foi COMBINADO (dia/período acordado) → "follow-up".
R6. CLIENTE fez pergunta objetiva sobre preço/condição/funcionalidade/prazo → "interessado".
R7. CLIENTE respondeu algo curto/neutro ("oi", "pode falar", "quem é?") sem pedir preço → "primeiro_contato".
R8. SDR mandou HOJE uma prospecção/follow-up e o cliente NÃO respondeu:
    - Se ⚑ ESTA É A PRIMEIRA INTERAÇÃO (sdrBefore=0, clientBefore=0) → "primeiro_contato" (a mensagem de hoje É a prospecção inicial; foi entregue, lead está no funil esperando resposta). NÃO classificar como "novo".
    - Se ORIGEM = disparo em massa E cliente ainda não respondeu em nenhum dia → "primeiro_contato". Mesma lógica: disparo já colocou o lead no estágio primeiro_contato automaticamente.
    - Se status atual já é mais avançado (interessado/follow-up/agendado) → MANTENHA o status atual (é só um follow-up do SDR sem retorno hoje).
    - Em qualquer outro caso de silêncio → mantenha o status atual.
R9. CLIENTE respondeu algo, mas HOJE não há mensagem do SDR (⚑ CLIENTE RESPONDEU ESPONTANEAMENTE) → reavalie pelas regras R1-R7 normalmente. Cliente retomando conversa por conta própria é sinal forte de engajamento.

R10. ⚑ LEAD AUTO-PROMOVIDO PARA FOLLOW-UP (status atual = "follow-up", origem = disparo, cliente nunca respondeu): o sistema já moveu automaticamente após 2 dias de silêncio. Regras:
     - Se HOJE o cliente respondeu algo interessante (preço, detalhes, recusa) → reavalie normalmente por R1-R7.
     - Se HOJE continua sem resposta → MANTENHA "follow-up". No resumo explique: "Lead auto-promovido para follow-up após X dias de silêncio do disparo. Continua sem retorno. Recomendado: entrar em cadência de retomada ou considerar descarte se persistir por mais de 7 dias."
     - NUNCA rebaixe para "primeiro_contato".

R11. CLIENTE RECORRENTE / JÁ COMPROU (status atual = "fechado" OU lead_type prévio = "cliente_ativo"|"recorrente"):
     - O cliente JÁ COMPROU/CONTRATOU. Está voltando pra suporte, dúvida operacional, segunda compra, problema, etc.
     - JAMAIS rebaixe para "interessado" / "primeiro_contato" / "follow-up".
     - Mantenha "fechado" e marque lead_type="cliente_ativo".
     - SÓ mude pra "sem_interesse" se ele EXPLICITAMENTE pedir cancelamento/descadastramento.
     - Se houver sinal forte de NOVA venda separada (ex: "quero contratar outro plano", "tenho outra unidade"), anote em "razao" pra operador analisar — mas mantenha o status "fechado".

R12. DÚVIDA ÚNICA vs INTERESSE REAL:
     - Pergunta CURTA pontual + cliente nunca demonstrou interesse antes ("vocês atendem fim de semana?", "qual horário?") → lead_type="unica_duvida".
       Mantenha status atual ou no máximo "primeiro_contato". NÃO suba pra "interessado".
     - Pergunta sobre preço/condição/prazo/funcionalidade/proposta + contexto de compra → lead_type="qualificado" + status "interessado".
     - Diferença: dúvida operacional ≠ pergunta comercial.

R13. ANTI-BOUNCING (⚑ marcador no contexto):
     - Se o lead foi tocado pela IA nas últimas 24h e quer mudar de novo agora:
       - Aceita mudança SOMENTE se houver EVIDÊNCIA TEXTUAL FORTE no chat de hoje (cliente disse X explicitamente).
       - Em dúvida → mantenha o status atual. Evita pingue-pongue.

R14. SUSPEITA DE FALSO POSITIVO:
     - "Vou pensar" / "depois te respondo" / "quem sabe" → NÃO é "interessado", é "follow-up".
     - "Vou ver com sócio" / "vou falar com a equipe" → "follow-up", não "interessado".
     - Cliente perguntou e desapareceu → mantém status atual; NÃO conclua.

R15. JÁ AGENDADO — pergunta off-topic ou de confirmação NÃO rebaixa:
     - Status atual = "agendado" + cliente manda dúvida sobre OUTRO assunto (horário de outro dia, formas de pagamento, leva acompanhante, "to com dor de cabeça", qualquer coisa que NÃO seja desmarcar) → MANTÉM "agendado".
     - Status atual = "agendado" + cliente confirma ("tô indo", "confirmado", "tá certo") → MANTÉM "agendado".
     - Status atual = "agendado" + cliente pede pra REMARCAR explicitamente → MANTÉM "agendado" (ou move pra "follow-up" se o kanban tiver esse estágio). NUNCA volta pra "interessado"/"primeiro_contato".
     - Status atual = "agendado" + cliente CANCELA explicitamente ("não vou mais", "desisti", "cancela") → "sem_interesse" ou status terminal equivalente do kanban.
     - Status atual = "agendado" + data da reunião JÁ PASSOU + cliente agradece/conta como foi/pede próximo agendamento → MANTÉM "agendado" e registre no resumo "Atendimento já ocorreu em DD/MM". Só sobe pra "fechado" se houver confirmação EXPLÍCITA de venda/contrato/pagamento.

R16. CLIENTE EM ESTÁGIO AVANÇADO (interessado/follow-up/agendado/fechado) fazendo PERGUNTA OPERACIONAL única:
     - Ex: "qual o horário?", "atende fim de semana?", "tem estacionamento?", "aceita pix?" sem nada de comprar/desistir.
     - SEMPRE mantém o status atual. Anota a pergunta em "resumo" pra operador responder.
     - NUNCA usa essa pergunta como motivo pra mover. lead_type pode ser "unica_duvida" mas o STATUS permanece.

## HIERARQUIA (nunca rebaixe, exceto em estados terminais):

Ordem: novo < primeiro_contato < interessado < follow-up < agendado < fechado.
- Se status atual é "agendado", só aceita: agendado (mantém), fechado (avança), sem_interesse/descartado. NUNCA rebaixa para interessado.
- Se nada novo aconteceu hoje que justifique mudar, REPITA o status atual.
- Terminais ("sem_interesse", "descartado") podem ser aplicados de qualquer estágio, com evidência CLARA no texto de hoje.

## COMO ESCREVER "razao" E "resumo":

"razao" (≤ 160 chars): cite a REGRA acionada (R1-R9) e a evidência curta. Se usou contexto histórico (origem=disparo, primeira interação, etc), mencione. Ex:
  - "R8 + ⚑primeira interação: disparo enviado hoje, sem resposta. Lead entra no funil em primeiro_contato."
  - "R6: cliente perguntou 'qual o valor do plano?'."

"resumo" (1-3 frases, ≤ 400 chars): descreva O QUE aconteceu HOJE considerando o histórico. Seja específico:
  - NÃO escreva: "SDR enviou mensagem de follow-up, não houve resposta."
  - ESCREVA: "Primeira prospecção enviada hoje via disparo em massa. Cliente ainda não respondeu. Aguardar 24-48h antes de considerar follow-up."
  - Se há histórico: "SDR já tinha mandado 2 mensagens sem resposta antes. Hoje reenviou follow-up, continua sem retorno. Provavelmente desinteressado — avaliar pausa de cadência."
  - Se cliente respondeu: "Cliente retomou conversa espontaneamente, perguntou sobre preço. SDR respondeu com tabela. Próximo passo: aguardar confirmação do orçamento interno."

## ARMADILHAS — NÃO CAIA:

- "Ok, obrigado" → NÃO é fechamento, é educação. Classifique pela mensagem anterior.
- "Vou ver e te aviso" → é "follow-up", NÃO "interessado".
- "Quanto custa?" → é "interessado", NÃO "fechado".
- Cliente não respondeu hoje + status era "interessado" → mantém "interessado". NÃO volta pra "novo".
- SDR mandando várias msgs sem resposta do cliente → NÃO é progresso. Mantém status ou aplica R8.
- Lead que veio do disparo hoje e cliente ainda não respondeu → "primeiro_contato", NÃO "novo", NÃO "follow-up".

## FORMATO DE RESPOSTA:

Devolva ESTRITAMENTE um JSON array. Cada item:
- "jid": string (copie exato do CHAT ID recebido)
- "status": um dos estágios válidos
- "lead_type": OBRIGATÓRIO. Um destes:
   * "novo"            — primeira interação, sem compra prévia
   * "cliente_ativo"   — já comprou e está ativo (NÃO mover funil)
   * "recorrente"      — comprador recorrente em ciclos
   * "unica_duvida"    — fez 1 pergunta pontual, sem sinal de compra
   * "qualificado"     — sinais reais de intenção de compra
   * "frio"            — silencioso ou desinteressado claro
- "razao": ≤ 160 caracteres. REGRA acionada + evidência + menção ao contexto histórico quando relevante.
- "resumo": 1-3 frases (≤ 400 caracteres). Tom da conversa + contexto histórico + próximo passo concreto.

Exemplo VÁLIDO:
[
  {
    "jid": "55279999@s.whatsapp.net",
    "status": "interessado",
    "lead_type": "qualificado",
    "razao": "R6: cliente perguntou 'quanto fica o plano mensal?'.",
    "resumo": "Cliente pediu detalhes e preço do plano mensal após 2 msgs de prospecção. SDR enviou tabela. Aguarda cliente confirmar orçamento interno."
  },
  {
    "jid": "55318888@s.whatsapp.net",
    "status": "fechado",
    "lead_type": "cliente_ativo",
    "razao": "R11: cliente já comprou, hoje veio tirar dúvida operacional. Mantém fechado.",
    "resumo": "Cliente recorrente perguntou sobre boleto da próxima fatura. Suporte respondeu. Mantém em fechado — NÃO é nova venda."
  },
  {
    "jid": "55317777@s.whatsapp.net",
    "status": "primeiro_contato",
    "lead_type": "unica_duvida",
    "razao": "R12: cliente fez 1 pergunta operacional curta sem sinal de compra.",
    "resumo": "Cliente perguntou apenas 'vocês atendem domingo?'. Sem contexto de interesse. SDR respondeu. Aguardar próximas msgs antes de classificar como interessado."
  }
]

Nada além do JSON. Sem markdown, sem explicação, sem texto antes ou depois.
    `;

    // Apêndice com o KANBAN REAL do cliente — sobrescreve a lista hardcoded
    // de estágios quando o cliente tem um kanban customizado. AI deve usar
    // EXCLUSIVAMENTE os status_keys listados aqui (válido pro nicho dele).
    const kanbanAppendix = kanbanCols.length > 0
      ? `\n\n## ESTÁGIOS DISPONÍVEIS NESTE KANBAN (use SOMENTE estes status_key, ordem do funil — index 0 é o início):
${kanbanCols.map((c, i) => `  ${i}. status_key="${c.status_key}"  →  label exibido: "${c.label}"`).join("\n")}

REGRAS ESPECÍFICAS PARA ESTE KANBAN:
- Use o "status_key" EXATO (em minúsculas, com underscore) no campo "status" da resposta. NÃO use o "label".
- Hierarquia = ordem da lista acima (index menor = início do funil, maior = mais avançado). NUNCA rebaixe (mover pra index menor) exceto pra status terminais.
- Status TERMINAIS detectados automaticamente: ${[...terminalSet].join(", ") || "(nenhum)"}.
- Se o kanban tem um estágio que casa com "agendado"/"agendamento"/"reuniao" — trate como ponto alto do funil (R15 vale: não rebaixar por pergunta off-topic).
- Se o kanban tem um estágio que casa com "fechado"/"comprou"/"contratado"/"venda" — trate como conclusão positiva (R11 vale: cliente recorrente nunca rebaixa).
`
      : "";

    const systemInstruction = baseSystemInstruction + kanbanAppendix;

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
