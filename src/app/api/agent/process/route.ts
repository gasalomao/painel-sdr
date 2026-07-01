import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { SchemaType } from "@google/generative-ai";
import { google } from "googleapis";
import { getEffectiveStatus } from "@/lib/bot-status";
import { renderTemplate } from "@/lib/template-vars";
import { logTokenUsage } from "@/lib/token-usage";
import { getEvolutionConfig } from "@/lib/evolution";
import { requireClientId } from "@/lib/tenant";
import { hasInternalSecret } from "@/lib/internal-auth";
import { maskJid } from "@/lib/pii";
import { resolveFunnelStage, checkSchedulesSync, splitMessage } from "@/lib/agent-format";
import { parseAgendaDateTime, isDuplicateSlot, hasAgentOverlapConflict } from "@/lib/agenda-logic";

export const dynamic = 'force-dynamic';

// Para chamadas internas (server-to-server), sempre usar localhost
const INTERNAL_BASE = `http://localhost:${process.env.PORT || 3000}`;

export async function POST(req: NextRequest) {
  // AUTH: aceita cookie de sessão (UI /agente teste) OU header de segredo interno
  // (chamado pelo webhook do whatsapp via internal fetch).
  if (!hasInternalSecret(req)) {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
  }

  try {
    const payloadBody = await req.json();
    const defaultInstance = (await getEvolutionConfig()).instance;
    const { remoteJid, isStatusUpdate, instanceName = defaultInstance, text, isTestMode = false, testHistory = [], sessionId, testState, testLeadData, forceActive = false } = payloadBody;

    if (!remoteJid || !text) {
       return NextResponse.json({ success: false, error: "Missing remoteJid or text" });
    }

    // Log de entrada para depuração no painel
    await supabase.from("webhook_logs").insert({
       instance_name: instanceName,
       event: "AGENT_PROCESS_START",
       payload: { remoteJid, text_preview: text.slice(0, 50), isTestMode },
       created_at: new Date().toISOString()
    });
    
    if (isStatusUpdate) {
       return NextResponse.json({ success: true, ignored: true });
    }

    // 1. GATE de pausa: consulta DB (única fonte de verdade) — global + sessão
    if (!isTestMode && sessionId && !forceActive) {
      const { data: sessionRow } = await supabase
        .from("sessions")
        .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at")
        .eq("id", sessionId)
        .single();
      if (sessionRow) {
        const eff = await getEffectiveStatus(sessionRow as any);
        if (!eff.isActive) {
          console.log(`[AGENT] IA pausada (${eff.reason}) para ${maskJid(remoteJid)}. Mensagem já foi salva.`);
          await supabase.from("webhook_logs").insert({
            instance_name: instanceName,
            event: "AGENT_SKIP_PAUSED",
            payload: { remoteJid, reason: eff.reason, resumeAt: eff.resumeAt },
            created_at: new Date().toISOString(),
          });
          return NextResponse.json({ success: true, status: "ai_paused", reason: eff.reason });
        }
      }
    }

    // 2. Buscas Paralelas Iniciais: Conexão, Config Global, Lead e Contato.
    // O lead (leads_extraidos) e o contato (contacts) trazem todas as variáveis
    // dinâmicas que o prompt do agente pode usar ({{nome_empresa}}, {{ramo}}, etc).
    const [channelRes, orgRes, leadRes, contactRes] = await Promise.all([
       supabase.from("channel_connections").select("agent_id, client_id").eq("instance_name", instanceName).maybeSingle(),
       supabase.from("ai_organizer_config").select("*").eq("id", 1).single(),
       !isTestMode ? supabase.from("leads_extraidos")
         .select('"remoteJid", nome_negocio, ramo_negocio, categoria, endereco, website, avaliacao, reviews, telefone, status')
         .eq("remoteJid", remoteJid).maybeSingle() : Promise.resolve({ data: null }),
       !isTestMode ? supabase.from("contacts").select("push_name, phone_number").eq("remote_jid", remoteJid).maybeSingle() : Promise.resolve({ data: null }),
    ]);

    const channel = channelRes.data;
    const orgConfig = orgRes.data;
    let leadRow = leadRes.data || null;
    let contactRow = contactRes.data || null;

    if (isTestMode && testLeadData) {
       // Shape precisa bater com o select acima — 10 colunas, mesmo que vazias no teste.
       leadRow = {
           remoteJid: testLeadData.remoteJid || remoteJid,
           nome_negocio: testLeadData.nome_negocio || null,
           ramo_negocio: testLeadData.ramo_negocio || null,
           categoria: testLeadData.categoria || null,
           endereco: testLeadData.endereco || null,
           website: testLeadData.website || null,
           avaliacao: testLeadData.avaliacao || null,
           reviews: testLeadData.reviews || null,
           telefone: testLeadData.telefone || null,
           status: testLeadData.status || null,
       };
       contactRow = {
           push_name: testLeadData.push_name || null,
           phone_number: testLeadData.telefone || null,
       };
    }

    // 2. Determinar AgentID e Buscar Dados do Agente em Paralelo
    const agentId = Number(req.headers.get("x-test-agent-id")) || channel?.agent_id || 1;
    // Multi-tenant: identifica o cliente pelo client_id da channel_connection.
    // Toda token usage / message gravada nessa request fica vinculada a este cliente.
    const clientId: string = (channel as any)?.client_id || "00000000-0000-0000-0000-000000000001";

    // Buscar histórico — SEMPRE via chats_dashboard por remote_jid, ignorando
    // instance_name. Cobre dois cenários:
    //
    //  1. Conversa normal: o número aparece em chats_dashboard, IA carrega
    //     últimas 25 mensagens daquele contato.
    //  2. CROSS-INSTANCE: cliente apagou instância "sdr" (modo padrão,
    //     mensagens preservadas) e reconectou MESMO número em "sdr_v2".
    //     A V2 messages table cria session NOVA pra (contact_id, sdr_v2),
    //     então `messages.session_id=novoId` retorna VAZIO — IA "começaria
    //     do zero" perdendo o contexto. chats_dashboard preserva tudo por
    //     remote_jid → IA enxerga a conversa unificada.
    //
    // Janela adaptativa (linha ~370): se >15 turnos, corta pra 3 inicial +
    // 12 final + marcador de skip. Conversas curtas passam intactas.
    const HIST_LIMIT = 25;
    const historyQuery = !isTestMode
       ? supabase.from("chats_dashboard").select("sender_type, content, created_at").eq("remote_jid", remoteJid).order("created_at", { ascending: false }).limit(HIST_LIMIT)
       : Promise.resolve({ data: [] });

    const [agentRes, stagesRes, histRes, kbRes] = await Promise.all([
       supabase.from("agent_settings").select("*").eq("id", agentId).single(),
       supabase.from("agent_stages").select("*").eq("agent_id", agentId).order("order_index"),
       historyQuery,
       supabase.from("agent_knowledge").select("id, title").eq("agent_id", agentId).order("title"),
    ]);

    const agentConfig = agentRes.data;
    const leadStages = stagesRes.data;
    const historico = histRes.data || [];
    const knowledgeTopics: { id: string; title: string }[] = (kbRes.data || []).filter((k: any) => k.title);

    if (!agentConfig || !agentConfig.is_active) {
       console.log(`[AGENT] Agent ID ${agentId} is INACTIVE or not found.`);
       // Antes só logava no console e respondia 200 silencioso — usuário não
       // tinha como descobrir por que IA não respondeu. Agora persiste em
       // webhook_logs (visível no /api/webhooks/diagnose e na UI admin).
       await supabase.from("webhook_logs").insert({
          instance_name: instanceName,
          event: "AGENT_INACTIVE",
          payload: { agent_id: agentId, exists: !!agentConfig, is_active: agentConfig?.is_active ?? false, remote_jid: maskJid(remoteJid) },
          created_at: new Date().toISOString(),
       }).then(() => {}, () => {});
       return NextResponse.json({ success: true, status: "agent_inactive" });
    }

    console.log(`[AGENT] Processing for Agent: ${agentConfig.name} (ID: ${agentId})`);
    
    // ============================================================
    // NOVO: SISTEMA DE AGRUPAMENTO (BUFFER) DE MENSAGENS
    // ============================================================
    const bufferSeconds = agentConfig.options?.message_buffer_seconds || 0;
    let finalProcessText = text;

    if (!isTestMode && bufferSeconds > 0) {
       console.log(`[BUFFER] Ativado: ${bufferSeconds}s para ${maskJid(remoteJid)} na instância ${instanceName}`);
       const batchStartTime = new Date().toISOString();
       const expiresAt = new Date(Date.now() + (bufferSeconds + 10) * 1000).toISOString();

       // Tenta ser o "Líder" do lote
       const { error: lockErr } = await supabase.from("chat_buffers").insert({
          remote_jid: remoteJid, instance_name: instanceName, expires_at: expiresAt
       });

       if (lockErr) {
          // Se for erro de conflito (23505), outro processo já é o líder
          if (lockErr.code === "23505") {
             console.log(`[BUFFER] Outro processo já é o líder para ${maskJid(remoteJid)}. Este encerra.`);
             return NextResponse.json({ success: true, status: "batching_active" });
          } else {
             console.error("[BUFFER] Erro inesperado ao criar lock:", lockErr);
             // Se não for conflito, apenas ignora o buffer e processa agora para não travar
          }
       } else {
          // Eu sou o Líder
          console.log(`[BUFFER] LIDER: Aguardando ${bufferSeconds}s para consolidar mensagens de ${maskJid(remoteJid)}...`);
          await new Promise(resolve => setTimeout(resolve, bufferSeconds * 1000));

          // Buscar lote
          const { data: batchMsgs } = await supabase.from("chats_dashboard")
             .select("content")
             .eq("remote_jid", remoteJid)
             .eq("instance_name", instanceName)
             .eq("sender_type", "customer")
             .gte("created_at", batchStartTime)
             .order("created_at", { ascending: true });

          if (batchMsgs && batchMsgs.length > 0) {
             const contents = Array.from(new Set(batchMsgs.map(m => m.content).filter(Boolean)));
             if (!contents.includes(text)) contents.unshift(text);
             finalProcessText = contents.join("\n");
             console.log(`[BUFFER] Lote de ${batchMsgs.length} mensagens consolidado.`);
          }
          
          await supabase.from("chat_buffers").delete().eq("remote_jid", remoteJid).eq("instance_name", instanceName);
       }
    }

    // 3. Horário Comercial
    if (!isTestMode && !agentConfig.is_24h) {
       if (checkSchedulesSync(agentConfig.schedules)) {
          const awayMsg = agentConfig.away_message || "Olá! No momento estamos fora do nosso horário de atendimento.";
          console.log("[AGENT] Fora do horário. Enviando mensagem de ausência.");
          await supabase.from("webhook_logs").insert({
             instance_name: instanceName,
             event: "AGENT_STOP_HOURS",
             payload: { remoteJid, action: "Send Away Message" },
             created_at: new Date().toISOString()
          });
          await fetch(`${INTERNAL_BASE}/api/send-message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remoteJid, text: awayMsg, instanceName }) });
          return NextResponse.json({ success: true, status: "out_of_office", away_sent: true });
       }
    }

    // 4. API KEYS (Gemini + OpenRouter). O provedor real é decidido pelo modelo
    //    escolhido (modelRef). A chave Gemini também é usada pelo RAG/embeddings
    //    (sempre Gemini), mesmo quando o chat roda no OpenRouter.
    const geminiApiKey = agentConfig.options?.gemini_api_key || orgConfig?.api_key || null;
    const openrouterApiKey = agentConfig.options?.openrouter_api_key || (orgConfig as any)?.openrouter_api_key || null;
    const finalApiKey = geminiApiKey; // RAG/embeddings
    if (!geminiApiKey && !openrouterApiKey) {
       // Log persistente — antes esse erro voltava só no body do JSON, sem
       // rastro pro admin descobrir. Agora /api/webhooks/diagnose mostra.
       await supabase.from("webhook_logs").insert({
          instance_name: instanceName,
          event: "AGENT_NO_API_KEY",
          payload: { agent_id: agentId, agent_name: agentConfig.name, remote_jid: maskJid(remoteJid), hint: "Configure API Key Gemini ou OpenRouter em /configuracoes" },
          created_at: new Date().toISOString(),
       }).then(() => {}, () => {});
       return NextResponse.json({ success: false, error: "API Key não configurada." });
    }

    // 5. Prompt Base — expande variáveis {{kb:Título}} + variáveis dinâmicas ({{saudacao}}, etc)
    const rawMainPrompt: string = agentConfig.main_prompt || "";
    const manuallyInsertedKbTitles = new Set<string>();
    // Primeiro expande {{kb:Título}}
    let processedMainPrompt = rawMainPrompt.replace(/\{\{kb:([^}]+)\}\}/g, (_match, rawTitle) => {
       const title = String(rawTitle).trim();
       const exists = knowledgeTopics.find(k => k.title.toLowerCase() === title.toLowerCase());
       if (!exists) return `[KB "${title}" não encontrada]`;
       manuallyInsertedKbTitles.add(exists.title);
       return `Quando o cliente perguntar sobre **${exists.title}** (ou tópico relacionado), VOCÊ DEVE chamar a tool \`search_knowledge_base\` com query="${exists.title}" ANTES de responder. Não invente — sempre consulte.`;
    });

    // 6. Funil, Estado e Condições — carrega ANTES do render do prompt pra que
    // {{minha_var}} consiga puxar valores capturados anteriormente pelo funil.
    let currentStageIndex = isTestMode ? (testState?.currentStageIndex || 0) : 0;
    let currentVariables: Record<string, any> = isTestMode ? (testState?.variables || {}) : {};
    const skippedStages = isTestMode ? (testState?.skippedStages || []) : [];

    if (!isTestMode && sessionId) {
        const { data: sessionData } = await supabase.from("sessions").select("variables, current_stage_id").eq("id", sessionId).single();
        if (sessionData) {
            if (sessionData.variables) currentVariables = sessionData.variables;
            if (sessionData.current_stage_id) {
                const idx = leadStages?.findIndex((s: any) => s.id === sessionData.current_stage_id);
                if (idx !== -1) currentStageIndex = idx;
            }
        }
    }

    // Render do prompt com TODAS as variáveis vinculadas ao lead/contato/sessão.
    // Isso garante que {{nome_empresa}}, {{ramo}}, {{nome}}, etc — capturados
    // quando o lead foi cadastrado — apareçam efetivamente no prompt.
    processedMainPrompt = renderTemplate(processedMainPrompt, {
       remoteJid,
       nome_negocio: leadRow?.nome_negocio || null,
       ramo_negocio: leadRow?.ramo_negocio || null,
       categoria:    leadRow?.categoria    || null,
       endereco:     leadRow?.endereco     || null,
       website:      leadRow?.website      || null,
       avaliacao:    leadRow?.avaliacao    ?? null,
       reviews:      leadRow?.reviews      ?? null,
       telefone:     leadRow?.telefone     || contactRow?.phone_number || null,
       status:       leadRow?.status       || null,
       push_name:    contactRow?.push_name || null,
       variables:    currentVariables,
    });

    let activeStage: any = null;
    let funilInstrucao = "";
    let capturedVariablesPrompt = "";

    if (leadStages && leadStages.length > 0) {
        // Lógica pura extraída (testada em agent-helpers.test.ts).
        const funnel = resolveFunnelStage(leadStages as any, currentVariables, currentStageIndex, skippedStages);
        activeStage = funnel.activeStage;
        currentStageIndex = funnel.currentStageIndex;
        // resolveFunnelStage clona skippedStages — re-sincroniza a ref usada adiante.
        skippedStages.length = 0;
        skippedStages.push(...funnel.skippedStages);

        // Salvar stage atual na DB se avançou
        if (!isTestMode && sessionId && activeStage) {
            await supabase.from("sessions").update({ current_stage_id: activeStage.id }).eq("id", sessionId);
        }

        if (activeStage) {
            funilInstrucao = `### ETAPA ATUAL DO CLIENTE: ${activeStage.title}\nSua missão imediata nesta etapa: ${activeStage.goal_prompt}`;
            
            const varsToCapture = activeStage.captured_variables;
            if (Array.isArray(varsToCapture) && varsToCapture.length > 0) {
                const captureInstructions: string[] = [];
                let hasPending = false;

                varsToCapture.forEach((v: any) => {
                    const val = currentVariables[v.name];
                    const hasValue = !!val;
                    
                    if (v.type === 'reconfirmar' && hasValue) {
                        hasPending = true;
                        captureInstructions.push(`- ${v.name} (${v.description}): Você JÁ TEM o valor '${val}'. Você DEVE confirmar com o cliente se este valor ainda está correto (se ele corrigir, atualize).`);
                    } else if (v.type === 'volatil' && hasValue) {
                        // Não é pendente, não trava o avanço, mas a IA é instruída a manter os ouvidos abertos
                        captureInstructions.push(`- ${v.name} (${v.description}): O valor atual é '${val}'. (Pode ser atualizado se o cliente mencionar mudança)`);
                    } else if (!hasValue) {
                        hasPending = true;
                        captureInstructions.push(`- ${v.name}: ${v.description}`);
                    }
                });

                if (hasPending) {
                    capturedVariablesPrompt = `\nNesta etapa, você DEVE extrair/confirmar as seguintes informações do cliente:\n` + 
                       captureInstructions.join('\n') +
                       `\nQuando obtiver ou confirmar essas informações de forma clara, CHAME A TOOL \`save_variables\` para salvá-las no sistema.`;
                } else {
                    capturedVariablesPrompt = `\nVocê já coletou todas as variáveis obrigatórias desta etapa. CHAME A TOOL \`complete_current_stage\` para avançar o cliente para a próxima etapa.\n` + 
                       (captureInstructions.length > 0 ? `(Lembrete: ${captureInstructions.join(' | ')})` : "");
                }
            } else {
                capturedVariablesPrompt = `\nQuando concluir sua missão nesta etapa, CHAME A TOOL \`complete_current_stage\` para avançar o cliente no funil.`;
            }
        } else {
            funilInstrucao = `### ETAPAS DO FUNIL: O cliente já passou por todas as etapas. Apenas mantenha a conversa.`;
        }
    }

    const rawGeminiHistory: any[] = [];
    if (isTestMode && testHistory.length > 0) {
        testHistory.forEach((m: any) => {
            if (m.role === "system") return; // Ignora logs de sistema no histórico da IA
            rawGeminiHistory.push({
                role: m.role === "user" ? "user" : "model",
                parts: [{ text: m.content || "" }]
            });
        });
    } else if (historico.length > 0) {
        // Ordem cronológica (mais antiga primeiro)
        let chrono = [...historico].reverse().filter((m: any) => {
            const sk = m.sender || m.sender_type;
            return sk !== "system"; // Foca em tudo exceto mensagens internas de sistema (inclui IA, Campanhas/Disparos e Atendente Humano)
        });

        // Para evitar duplicar a mensagem atual no histórico enviado ao Gemini (e evitar erros de alternância de turnos no SDK),
        // se a última mensagem do histórico cronológico for a mensagem atual do cliente, nós a removemos do histórico.
        // Ela será enviada unicamente na chamada sendMessage() abaixo.
        if (chrono.length > 0) {
            const lastMsg = chrono[chrono.length - 1];
            const lastSender = lastMsg.sender_type;
            if (lastSender === "customer") {
                chrono.pop();
            }
        }

        // Janela adaptativa: se >15 trocas, mantém os 3 PRIMEIROS turnos (disparo
        // inicial / contexto fundador) + os 12 ÚLTIMOS (trocas recentes). Insere
        // marcador "[...resumo...]" no meio pra IA saber que pulou conversa.
        // Conversa curta passa intacta.
        const KEEP_HEAD = 3, KEEP_TAIL = 12;
        let windowed: any[] = chrono;
        if (chrono.length > KEEP_HEAD + KEEP_TAIL) {
            const skipped = chrono.length - KEEP_HEAD - KEEP_TAIL;
            const middle = chrono.slice(KEEP_HEAD, chrono.length - KEEP_TAIL);
            // RESUMO REAL do meio (antes era placeholder vazio — IA esquecia dados).
            // Gera com modelo barato + reasoningMode=0, cacheado por conteúdo (hash).
            // Se falhar, cai no placeholder legado como fallback (não-fatal).
            const { summarizeMiddleMessages } = await import("@/lib/history-summary");
            const summary = await summarizeMiddleMessages(remoteJid, middle).catch(() => null);
            const middleContent = summary
              ? `[Resumo de ${skipped} mensagens intermediárias da conversa — a IA deve usar estas informações como contexto]: ${summary}`
              : `[...${skipped} mensagens intermediárias omitidas pra economizar contexto. Resumo: cliente já passou pelo disparo inicial e está em diálogo ativo...]`;
            windowed = [
                ...chrono.slice(0, KEEP_HEAD),
                { sender: "system", content: middleContent, _skip_marker: true },
                ...chrono.slice(-KEEP_TAIL),
            ];
        }

        windowed.forEach((m: any) => {
            const senderKey = m.sender || m.sender_type;
            const role = (m._skip_marker || senderKey !== 'customer') ? 'model' : 'user';
            // Corta msgs individuais grandes (1000 chars já é bastante).
            const safeContent = m.content ? (m.content.length > 600 ? m.content.substring(0, 600) + "... [cortado]" : m.content) : "[Mídia/Comando]";
            rawGeminiHistory.push({ role, parts: [{ text: safeContent }] });
        });
    }

    // Normaliza o histórico para o Gemini: 
    // 1. Deve começar com 'user'
    // 2. Deve alternar perfeitamente entre 'user' e 'model'
    const geminiHistory: any[] = [];
    for (const msg of rawGeminiHistory) {
        if (geminiHistory.length === 0) {
            if (msg.role === "model") {
                geminiHistory.push({ role: "user", parts: [{ text: "(Contato iniciado pela IA/SDR com disparo ativo)" }] });
            }
            geminiHistory.push(msg);
        } else {
            const last = geminiHistory[geminiHistory.length - 1];
            if (last.role === msg.role) {
                last.parts[0].text += "\n\n" + msg.parts[0].text;
            } else {
                geminiHistory.push(msg);
            }
        }
    }

    const agora = new Date();

    // ============================================================
    // CONTEXTO DO LEAD — injeta dados do CRM, disparo recebido e follow-up
    // pra IA NÃO recomeçar do zero ("Olá, sou da empresa X" quando o lead já
    // recebeu disparo dizendo isso 2 dias atrás). Tudo via JOIN leve.
    // ============================================================
    let leadContextBlock = "";
    if (!isTestMode) {
      try {
        const [leadRes, lastCampaignTargetRes, lastFollowupTargetRes] = await Promise.all([
          supabase
            .from("leads_extraidos")
            .select("nome_negocio, ramo_negocio, categoria, telefone, endereco, website, status, primeiro_contato_source, primeiro_contato_at")
            .eq("remoteJid", remoteJid)
            .maybeSingle(),
          supabase
            .from("campaign_targets")
            .select("rendered_message, sent_at, status, campaigns(name)")
            .eq("remote_jid", remoteJid)
            .order("sent_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("followup_targets")
            .select("current_step, last_sent_at, last_rendered, status, followup_campaigns(name, steps)")
            .eq("remote_jid", remoteJid)
            .order("last_sent_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        const lead = leadRes.data;
        const camp = lastCampaignTargetRes.data as any;
        const fup  = lastFollowupTargetRes.data as any;

        const lines: string[] = [];
        if (lead) {
          if (lead.nome_negocio)            lines.push(`Empresa: ${lead.nome_negocio}`);
          if (lead.ramo_negocio)            lines.push(`Ramo: ${lead.ramo_negocio}`);
          if (lead.categoria)               lines.push(`Categoria: ${lead.categoria}`);
          if (lead.endereco)                lines.push(`Endereço: ${lead.endereco}`);
          if (lead.website)                 lines.push(`Website: ${lead.website}`);
          if (lead.telefone)                lines.push(`Telefone: ${lead.telefone}`);
          if (lead.status)                  lines.push(`Status no CRM: ${lead.status}`);
          if (lead.primeiro_contato_source) lines.push(`Origem do contato: ${lead.primeiro_contato_source}`);
          if (lead.primeiro_contato_at) {
            const dias = Math.floor((Date.now() - new Date(lead.primeiro_contato_at).getTime()) / 86400000);
            lines.push(`Primeiro contato: ${new Date(lead.primeiro_contato_at).toLocaleDateString("pt-BR")} (há ${dias} dia${dias === 1 ? "" : "s"})`);
          }
        }
        if (camp?.rendered_message && camp?.sent_at) {
          const dias = Math.floor((Date.now() - new Date(camp.sent_at).getTime()) / 86400000);
          const campName = camp?.campaigns?.name || "(sem nome)";
          lines.push(`\n>>> Mensagem inicial JÁ enviada por disparo (campanha "${campName}", há ${dias} dia${dias === 1 ? "" : "s"}):`);
          lines.push(`"${(camp.rendered_message || "").trim().slice(0, 500)}"`);
        }
        if (fup?.last_rendered && fup?.last_sent_at) {
          const dias = Math.floor((Date.now() - new Date(fup.last_sent_at).getTime()) / 86400000);
          const fupName = fup?.followup_campaigns?.name || "(sem nome)";
          const totalSteps = Array.isArray(fup?.followup_campaigns?.steps) ? fup.followup_campaigns.steps.length : null;
          const stepInfo = totalSteps != null ? `step ${fup.current_step}/${totalSteps}` : `step ${fup.current_step}`;
          lines.push(`\n>>> Follow-up JÁ enviada (campanha "${fupName}", ${stepInfo}, há ${dias} dia${dias === 1 ? "" : "s"}):`);
          lines.push(`"${(fup.last_rendered || "").trim().slice(0, 500)}"`);
        }

        // LEAD INTELLIGENCE: se o lead foi pré-analisado, INJETA o briefing.
        // Isso dá ao agente principal o mesmo contexto estratégico que o
        // disparo/follow-up usaram. Resultado: respostas mais alinhadas, menos
        // repetir o que já foi dito, mais cirúrgicas pra dor real do nicho.
        try {
          const { getCachedIntelligence } = await import("@/lib/lead-intelligence");
          const intel = await getCachedIntelligence(remoteJid);
          if (intel) {
            const intelLines: string[] = ["", "# 🎯 BRIEFING ESTRATÉGICO (Lead Intelligence)"];
            intelLines.push(`Tipo de lead: ${intel.lead_type} | ICP score: ${intel.icp_score}/100`);
            if (intel.dores?.length) intelLines.push(`Dores prováveis: ${intel.dores.slice(0, 3).join("; ")}`);
            if (intel.abordagem) intelLines.push(`Ângulo recomendado: ${intel.abordagem}`);
            if (intel.decisor && intel.decisor !== "não identificado") intelLines.push(`Decisor: ${intel.decisor}`);
            if (intel.alerta) intelLines.push(`⚠ ${intel.alerta}`);
            if (intel.concorrente_local) intelLines.push(`Concorrente local: ${intel.concorrente_local}`);
            intelLines.push("(Use ESSE contexto pra adaptar tom e proposta. NÃO mencione literalmente que tem briefing.)");
            lines.push(intelLines.join("\n"));
          }
        } catch (e) { /* não-fatal */ }

        if (lines.length > 0) {
          leadContextBlock = lines.join("\n");
        }
      } catch (e: any) {
        console.warn("[AGENT] Falha ao montar leadContextBlock:", e?.message);
      }
    } else if (isTestMode && testLeadData) {
        const lines: string[] = [];
        if (testLeadData.nome_negocio) lines.push(`Empresa: ${testLeadData.nome_negocio}`);
        if (testLeadData.ramo_negocio) lines.push(`Ramo: ${testLeadData.ramo_negocio}`);
        if (testLeadData.categoria) lines.push(`Categoria: ${testLeadData.categoria}`);
        if (testLeadData.endereco) lines.push(`Endereço: ${testLeadData.endereco}`);
        if (testLeadData.website) lines.push(`Website: ${testLeadData.website}`);
        if (testLeadData.telefone) lines.push(`Telefone: ${testLeadData.telefone}`);
        if (lines.length > 0) {
            leadContextBlock = lines.join("\n");
        }
    }

    const agendaConfig = agentConfig.options || {};
    const calendarEnabled = !!agendaConfig.calendar_enabled;
    const calendarDuration = Number(agendaConfig.calendar_default_duration) || 30;
    const calendarOptionalFields: Record<string, boolean> = agendaConfig.calendar_optional_fields || {};
    const calendarMeet = !!agendaConfig.calendar_generate_meet;
    const calendarAutoCapture = {
      telefone:    agendaConfig.calendar_auto_capture?.telefone    ?? true,
      empresa:     agendaConfig.calendar_auto_capture?.empresa     ?? true,
      necessidade: agendaConfig.calendar_auto_capture?.necessidade ?? true,
    };
    // Label customizado pro campo "necessidade" — adapta o agente ao nicho:
    //   Comercial B2B: "Dor / Necessidade"  (default)
    //   Salão de beleza: "Serviço desejado"
    //   Médico: "Especialidade"
    //   Advocacia: "Causa"
    //   etc.
    // Usado na tool description (a IA infere com o vocabulário certo) e na
    // descrição do evento no Google Calendar (aparece pro dono assim no UI dele).
    const necessidadeLabel: string = (agendaConfig.calendar_auto_capture?.necessidade_label || "").trim()
                                     || "Necessidade";
    const webSearchEnabled = !!agendaConfig.web_search_enabled;

    // ============================================================
    // REGRAS AUTO-INJETADAS — versão ENXUTA (estilo n8n tools).
    // A instrução de "quando / como chamar" cada ferramenta vai
    // DENTRO da descrição da própria tool — o Gemini só carrega isso
    // quando decide usar a tool, não a cada turn. Aqui deixamos só
    // uma frase-guia + listagem dos tópicos da KB que não foram
    // injetados manualmente via {{kb:...}} no prompt.
    // ============================================================
    const autoRules: string[] = [];

    const autoInjectedKbTitles = knowledgeTopics
      .filter(kb => !manuallyInsertedKbTitles.has(kb.title))
      .map(kb => kb.title);
    if (autoInjectedKbTitles.length > 0) {
      autoRules.push(`Base de conhecimento (tópicos): ${autoInjectedKbTitles.join(", ")}. Use a tool search_knowledge_base para consultar antes de responder sobre eles.`);
    }

    if (calendarEnabled) {
      const askedFields = Object.entries(calendarOptionalFields).filter(([, v]) => v).map(([k]) => k);
      const parts: string[] = [];
      parts.push(`Agenda ativa. Para marcar: 1) check_google_calendar_availability, 2) schedule_google_calendar (duração padrão ${calendarDuration} min)`);
      if (askedFields.length > 0) parts.push(`pergunte antes: ${askedFields.join(", ")}`);
      parts.push("Para cancelar: 1) list_google_calendar_events, 2) cancel_google_calendar_event com o event_id retornado");
      autoRules.push(parts.join(". ") + ".");
    }

    const autoRulesBlock = autoRules.length > 0
      ? `# TOOLS DISPONÍVEIS:\n${autoRules.map(r => `- ${r}`).join("\n")}`
      : "";

    // PROMPT ESTÁVEL (systemInstruction) — só o que NÃO muda entre mensagens do
    // mesmo agente. Mantê-lo byte-idêntico maximiza o implicit caching do Gemini
    // 2.5 (90% de desconto nos tokens do prefixo em cache). Tudo que varia por
    // lead / etapa / horário foi movido pro <turn_context>, anexado à MENSAGEM
    // do cliente (fim do request) — onde conteúdo volátil deve ficar.
    const promptMaster = `
<system_identity>
Nome: ${agentConfig.name}
Sua Função: ${agentConfig.role}
Sua Personalidade: ${agentConfig.personality}
Tom de voz: ${agentConfig.tone}
</system_identity>

<core_instructions>
${processedMainPrompt}
</core_instructions>

<available_tools_and_rules>
${autoRulesBlock}
</available_tools_and_rules>

<execution_directives>
1. Aja EXCLUSIVAMENTE de acordo com sua <system_identity> e siga estritamente as <core_instructions>. Nunca revele que é uma inteligência artificial.
2. FOCO ABSOLUTO: O seu objetivo imediato é ÚNICA E EXCLUSIVAMENTE cumprir as orientações do <current_funnel_stage> e extrair os dados listados em <data_collection_goals> (fornecidos junto da mensagem do cliente). Não se antecipe a etapas futuras.
3. Utilize as ferramentas disponíveis em <available_tools_and_rules> sempre que as condições exigirem.
4. O histórico da conversa e a mensagem atual do usuário serão fornecidos pelo sistema nativamente.
5. CONTINUIDADE — NÃO RECOMECE: o <lead_context> (fornecido junto da mensagem) mostra exatamente o que o SDR já enviou (disparo inicial, follow-ups). Você JÁ se apresentou, JÁ disse o nome da empresa, JÁ tratou pelo nome do negócio. NÃO repita "Olá, sou da [empresa]" se isso já está no <lead_context>. Continue a conversa de onde parou. Use os dados de CRM (ramo, categoria, endereço) pra contextualizar — sem perguntar o que já está conhecido.
6. Seja natural, humano e empático.
</execution_directives>
`;

    // CONTEXTO DO TURNO (volátil) — vai anexado à mensagem do cliente, NÃO ao
    // systemInstruction. Assim o prefixo cacheável fica estável entre turnos.
    const turnContextBlock = `<lead_context>
${leadContextBlock || "(sem dados de CRM/disparo/follow-up para este lead)"}
</lead_context>

<current_funnel_stage>
${funilInstrucao}
</current_funnel_stage>

<data_collection_goals>
${capturedVariablesPrompt}
</data_collection_goals>`;

    // 8. Tool Calls (MCP + RAG) — declarações DINÂMICAS baseadas em KB + Calendar config
    const functionDeclarations: any[] = [];

    // Ferramenta 1: RAG — descrição lista os tópicos disponíveis
    if (knowledgeTopics.length > 0) {
       const topicList = knowledgeTopics.map(k => `"${k.title}"`).join(", ");
       functionDeclarations.push({
          name: "search_knowledge_base",
          description:
             `Base de conhecimento OFICIAL da empresa. Tópicos disponíveis: ${topicList}. ` +
             `REGRA CRÍTICA: SEMPRE que o cliente perguntar sobre PREÇO, VALOR, HORÁRIO, ENDEREÇO, ` +
             `POLÍTICA, ENTREGA, GARANTIA, PROCEDIMENTO, ou qualquer tópico listado acima — você DEVE ` +
             `chamar esta tool ANTES de responder. PROIBIDO inventar valores, datas, condições ou termos. ` +
             `Se a base não retornar resultado, diga "vou verificar e te respondo" — nunca chute.`,
          parameters: {
             type: SchemaType.OBJECT,
             properties: {
                query: {
                   type: SchemaType.STRING,
                   description:
                      `Palavras-chave da busca (3-5 palavras). Exemplos: "preço plano premium", ` +
                      `"horário sábado", "política cancelamento". Use o vocabulário do cliente, ` +
                      `não precisa bater literal com o título. Tópicos atuais: ${topicList}`,
                },
             },
             required: ["query"],
          },
       });
    }

    // Ferramenta 1.5: Web Search — opt-in pelo agente
    if (webSearchEnabled) {
       functionDeclarations.push({
          name: "web_search",
          description: "Busca rápida na internet (DuckDuckGo). Use quando precisar de informação atualizada que não está nem na conversa nem na base de conhecimento (notícias, dados, fatos recentes). NÃO use pra coisas inventadas.",
          parameters: {
             type: SchemaType.OBJECT,
             properties: {
                query: { type: SchemaType.STRING, description: "O que buscar — frase curta e específica" },
             },
             required: ["query"],
          },
       });
    }

    // Ferramenta 2: Google Calendar — schedule com duração padrão + campos opcionais
    if (calendarEnabled) {
       // Apenas Nome e E-mail são perguntas DIRETAS (controladas pelo checkbox).
       // Telefone vem do JID server-side. Empresa e Necessidade a IA INFERE da conversa.
       const askedFields = Object.entries(calendarOptionalFields).filter(([, v]) => v).map(([k]) => k);

       const scheduleProps: Record<string, any> = {
          summary: { type: SchemaType.STRING, description: "Título do evento. Ex: Reunião com [nome do cliente]" },
          start_datetime: { type: SchemaType.STRING, description: "Data e hora de início ISO8601 (ex: 2026-04-25T14:00:00). PROIBIDO chutar — só usar horário confirmado via check_google_calendar_availability." },
          duration_minutes: { type: SchemaType.NUMBER, description: `Duração em minutos. Padrão: ${calendarDuration}. Use esse valor a menos que o cliente peça outro.` },
       };
       // Inferidos só se o operador deixou ligado
       if (calendarAutoCapture.empresa) {
          scheduleProps.empresa = { type: SchemaType.STRING, description: "Empresa do cliente. NÃO PERGUNTE. Se foi mencionada na conversa, preencha; senão deixe vazio." };
       }
       if (calendarAutoCapture.necessidade) {
          scheduleProps.necessidade = {
             type: SchemaType.STRING,
             description: `${necessidadeLabel}: resumo curto (1 linha) que o cliente quer/precisa. NÃO PERGUNTE diretamente — infira da conversa baseado no contexto do nicho.`,
          };
       }

       // Campos perguntados explicitamente (Nome / E-mail)
       const ASK_DESCS: Record<string, string> = {
          nome:  "Nome completo do cliente. PERGUNTE diretamente antes de agendar.",
          email: "E-mail do cliente. PERGUNTE diretamente — vira convidado oficial do evento.",
       };
       for (const f of askedFields) {
          if (ASK_DESCS[f]) scheduleProps[f] = { type: SchemaType.STRING, description: ASK_DESCS[f] };
       }

       const askTxt = askedFields.length > 0
          ? ` ANTES de chamar, PERGUNTE diretamente ao cliente: ${askedFields.join(", ")}.`
          : "";
       functionDeclarations.push({
          name: "schedule_google_calendar",
          description: `Agenda reunião no calendário (duração padrão ${calendarDuration} min). CHAME UMA ÚNICA VEZ por agendamento: depois que marcar, está marcado — NÃO chame de novo quando o cliente responder "ok", "combinado", "obrigada" etc (isso duplicaria o evento). PRÉ-REQUISITO OBRIGATÓRIO: você JÁ DEVE ter chamado check_google_calendar_availability nesta mesma conversa antes de criar o evento — proibido chutar horário. O horário (start_datetime) é no fuso de Brasília (America/Sao_Paulo); mande o horário que combinou com o cliente, sem converter.${askTxt} Empresa e necessidade você INFERE da conversa, NUNCA pergunta. Telefone é automático.`,
          parameters: { type: SchemaType.OBJECT, properties: scheduleProps, required: ["summary", "start_datetime", ...askedFields] }
       });

       functionDeclarations.push({
          name: "check_google_calendar_availability",
          description: "Checa a agenda do vendedor informando os horários livres num determinado dia. OBRIGATÓRIO USAR antes de sugerir horários ao cliente.",
          parameters: {
             type: SchemaType.OBJECT,
             properties: {
                date: { type: SchemaType.STRING, description: "Data para checar disponibilidade no formato YYYY-MM-DD. Ex: 2026-04-25" }
             },
             required: ["date"]
          }
       });

       functionDeclarations.push({
          name: "list_google_calendar_events",
          description: "Lista os eventos já agendados num intervalo de datas. Use QUANDO o cliente pedir pra cancelar/remarcar uma reunião, pra você descobrir o event_id dela. Retorna array com {id, summary, start, end, attendees}. Depois de listar, use cancel_google_calendar_event passando o id correto (o que bate com o que o cliente descreveu). NUNCA chute event_id.",
          parameters: {
             type: SchemaType.OBJECT,
             properties: {
                date_from: { type: SchemaType.STRING, description: "Data inicial (YYYY-MM-DD). Se o cliente só disse 'amanhã' ou 'sexta', use essa mesma data aqui." },
                date_to:   { type: SchemaType.STRING, description: "Data final (YYYY-MM-DD). Opcional. Se omitir, considera só o date_from (único dia)." },
             },
             required: ["date_from"]
          }
       });

       functionDeclarations.push({
          name: "cancel_google_calendar_event",
          description: "Cancela (deleta) um evento do Google Calendar. PRÉ-REQUISITO: você JÁ DEVE ter chamado list_google_calendar_events nesta conversa pra obter o event_id real — é PROIBIDO inventar event_id. Se a lista retornar vários eventos no período, confirme com o cliente qual antes de cancelar.",
          parameters: {
             type: SchemaType.OBJECT,
             properties: {
                event_id: { type: SchemaType.STRING, description: "ID exato do evento retornado por list_google_calendar_events. Copie o campo 'id' da listagem." },
                reason:   { type: SchemaType.STRING, description: "Motivo opcional (ex: 'cliente não poderá comparecer'). Fica no log interno." },
             },
             required: ["event_id"]
          }
       });
    }

    // Ferramentas Customizadas (Webhooks N8N/Make)
    const customTools = agentConfig.options?.custom_tools || [];
    customTools.forEach((t: any) => {
       functionDeclarations.push({
          name: t.name,
          description: t.description,
          parameters: {
             type: SchemaType.OBJECT,
             properties: {
                query: { type: SchemaType.STRING, description: "Argumento principal, formato livre a seu critério" }
             },
             required: ["query"]
          }
       });
    });

    // Tool de Funil e Variáveis
    if (activeStage) {
        const varsToCapture = activeStage.captured_variables;
        if (Array.isArray(varsToCapture) && varsToCapture.length > 0) {
           const properties: Record<string, any> = {};
           varsToCapture.forEach(v => {
              if (v.name) properties[v.name] = { type: SchemaType.STRING, description: v.description || v.name };
           });
           functionDeclarations.push({
              name: "save_variables",
              description: `Salva as variáveis que você extraiu do cliente na etapa atual. Chame assim que o cliente responder com as informações.`,
              parameters: {
                 type: SchemaType.OBJECT,
                 properties,
              }
           });
        }

        functionDeclarations.push({
           name: "complete_current_stage",
           description: `Chame esta ferramenta apenas quando você considerar que concluiu o objetivo da etapa atual E já salvou todas as variáveis necessárias. Isso moverá o cliente para a próxima etapa.`,
        });
    }

    // Inicializa o roteamento de provedor (Gemini ou OpenRouter) pelo modelo.
    const { resolveModel } = await import("@/lib/ai-default-model");
    const { startAiChat, providerOf } = await import("@/lib/ai-provider");
    const modelId = await resolveModel(agentConfig.target_model, clientId);
    if (!modelId) {
      await supabase.from("webhook_logs").insert({
         instance_name: instanceName,
         event: "AGENT_NO_MODEL",
         payload: { agent_id: agentId, agent_name: agentConfig.name, remote_jid: maskJid(remoteJid), hint: "Admin: configure modelo IA em /configuracoes ou per-cliente em /admin/clientes" },
         created_at: new Date().toISOString(),
      }).then(() => {}, () => {});
      return NextResponse.json({ success: false, error: "Modelo IA não configurado pelo admin" }, { status: 400 });
    }
    const agentProvider = providerOf(modelId);
    // Checagem de chave POR PROVEDOR do modelo escolhido.
    if (agentProvider === "gemini" && !geminiApiKey) {
      await supabase.from("webhook_logs").insert({
         instance_name: instanceName, event: "AGENT_NO_API_KEY",
         payload: { agent_id: agentId, remote_jid: maskJid(remoteJid), hint: "Modelo Gemini selecionado mas sem API Key Gemini em /configuracoes" },
         created_at: new Date().toISOString(),
      }).then(() => {}, () => {});
      return NextResponse.json({ success: false, error: "API Key Gemini não configurada." });
    }
    if (agentProvider === "openrouter" && !openrouterApiKey) {
      await supabase.from("webhook_logs").insert({
         instance_name: instanceName, event: "AGENT_NO_API_KEY",
         payload: { agent_id: agentId, remote_jid: maskJid(remoteJid), hint: "Modelo OpenRouter selecionado mas sem API Key OpenRouter em /configuracoes" },
         created_at: new Date().toISOString(),
      }).then(() => {}, () => {});
      return NextResponse.json({ success: false, error: "API Key OpenRouter não configurada." });
    }
    console.log(`[AGENT] Usando modelo: ${modelId} (provider=${agentProvider})`);

    const minifiedPromptMaster = promptMaster.replace(/\n\s+/g, '\n').trim();

    // THINKING BUDGET — Gemini 2.5 Flash liga "thinking" por padrão, e esses
    // tokens são cobrados como SAÍDA (o token mais caro). Pra um SDR de chat o
    // MODO DE RACIOCÍNIO UNIVERSAL (0=Econômico, 1=Equilibrado, 2=Intenso).
    // Funciona em TODOS os modelos (o ai-provider mapeia pro param certo de
    // cada provedor: Gemini thinkingBudget, OpenAI reasoning.effort, Anthropic
    // thinking, etc.). Default 0 (Econômico) — SDR raramente precisa raciocínio
    // extra; admin sobe pra Equilibrado em agendamento/tools, Intenso em casos
    // complexos. Retrocompat: se só vier thinking_budget legado, deriva dele.
    const rawReasoning = agentConfig.options?.reasoning_mode;
    const rawThinking = agentConfig.options?.thinking_budget;
    let reasoningMode: 0 | 1 | 2;
    if (rawReasoning === 0 || rawReasoning === 1 || rawReasoning === 2) {
      reasoningMode = rawReasoning;
    } else if (rawThinking !== undefined && rawThinking !== null && rawThinking !== "") {
      // Legado: 0→econômico, >0→equilibrado, -1→intenso.
      reasoningMode = Number(rawThinking) < 0 ? 2 : Number(rawThinking) > 0 ? 1 : 0;
    } else {
      reasoningMode = 0;
    }
    // Temperatura só entra se o admin configurou — senão mantém o default do
    // modelo (não mexer no comportamento atual sem necessidade).
    let temperature: number | undefined;
    if (agentConfig.options?.temperature !== undefined && agentConfig.options?.temperature !== null && agentConfig.options?.temperature !== "") {
      const t = Number(agentConfig.options.temperature);
      if (Number.isFinite(t)) temperature = t;
    }

    const timeContext = `[Sistema: Hoje é ${agora.toLocaleDateString("pt-BR")}, ${agora.toLocaleTimeString("pt-BR")}]`;
    // O contexto volátil do turno (lead/funil/metas) + horário vão no FIM, junto
    // da mensagem do cliente — fora do systemInstruction estável (implicit cache).
    const firstTurnMessage = `${turnContextBlock}\n\n=== MENSAGEM ATUAL DO CLIENTE ===\n${finalProcessText}\n\n${timeContext}`;

    // Histórico no formato neutro da camada de provedores.
    const neutralHistory = geminiHistory.map((m: any) => ({
      role: (m.role === "model" ? "model" : "user") as "user" | "model",
      text: m.parts?.[0]?.text || "",
    }));

    // Sessão de chat unificada — roteia Gemini OU OpenRouter conforme o modelo,
    // com ferramentas (function/tool calling). No Gemini ainda há auto-fallback
    // de modelo morto (404 generateContent) embutido na camada.
    const session = await startAiChat({
      modelRef: modelId,
      systemInstruction: minifiedPromptMaster,
      history: neutralHistory,
      tools: functionDeclarations,
      temperature,
      reasoningMode,
      geminiApiKey,
      openrouterApiKey,
    });

    let turn = await session.sendUser(firstTurnMessage);
    const effectiveModelId = session.modelUsed();
    if (effectiveModelId !== modelId && agentProvider === "gemini") {
      console.warn(`[AGENT] Modelo "${modelId}" morto. Usando "${effectiveModelId}" no lugar.`);
      // Auto-cura: atualiza o agent_settings pra próxima chamada já usar o vivo.
      supabase.from("agent_settings")
        .update({ target_model: effectiveModelId })
        .eq("id", agentId)
        .then(() => {}, () => {});
    }

    let finalAnswer = turn.text;

    // Acumula tokens dessa interação (1 inicial + N de tool-loop)
    let totalPrompt = turn.usage.promptTokens, totalCompletion = turn.usage.completionTokens, totalAll = turn.usage.totalTokens;

    // Tratamento de Function Call MCP — loop pra permitir CHAIN de tools
    // (ex: list_google_calendar_events → cancel_google_calendar_event).
    // Limite de 5 pra evitar loop infinito caso o modelo fique chamando tool.
    const callLogs: any[] = [];
    for (let iter = 0; iter < 5; iter++) {
       if (!turn.toolCalls || turn.toolCalls.length === 0) break;
       // Processa TODAS as tool calls do turno (Gemini costuma mandar 1; o
       // OpenRouter pode mandar várias e exige resposta pra cada tool_call_id).
       const toolResults: any[] = [];
       for (const call of turn.toolCalls) {
       const callArgs = call.args as any;
       let functionResultRes: any = {};

       if (call.name === "search_knowledge_base") {
          // RAG real: vector search (top-5 chunks por similaridade semântica).
          // Fallback ILIKE só se vetor não achar NADA — cobre docs ainda não
          // indexados (recém-criados antes do indexer rodar).
          const raw = String(callArgs.query || "").trim().slice(0, 500);
          let matches: any[] = [];
          let searchMethod = "none";
          let dbgError: string | null = null;

          if (raw) {
             try {
                const { searchKnowledge } = await import("@/lib/rag");
                const hits = await searchKnowledge({
                   query: raw,
                   agentId,
                   clientId,
                   apiKey: finalApiKey,
                   topK: 5,
                   minSimilarity: 0.55,
                });
                if (hits.length > 0) {
                   matches = hits.map((h) => ({
                      title: h.title,
                      content: h.content,
                      similarity: h.similarity,
                   }));
                   searchMethod = "vector";
                }
             } catch (e: any) {
                dbgError = e?.message;
                console.warn("[RAG] vector search falhou, caindo no ILIKE:", e?.message);
             }
          }

          // Fallback ILIKE — só se vector não retornou nada
          if (matches.length === 0 && raw) {
             const safeQuery = raw.toLowerCase().replace(/[%_,()]/g, " ").replace(/\s+/g, " ").trim();
             if (safeQuery) {
                let docs: any[] = [];
                const titleHit = await supabase.from("agent_knowledge")
                   .select("id, title, content")
                   .eq("agent_id", agentId)
                   .ilike("title", `%${safeQuery}%`)
                   .limit(3);
                docs = titleHit.data || [];
                if (docs.length === 0) {
                   const contentHit = await supabase.from("agent_knowledge")
                      .select("id, title, content")
                      .eq("agent_id", agentId)
                      .ilike("content", `%${safeQuery}%`)
                      .limit(3);
                   docs = contentHit.data || [];
                }
                if (docs.length > 0) {
                   // Corta docs grandes (fallback antigo, mantido)
                   const MAX = 1800;
                   matches = docs.map((k: any) => ({
                      title: k.title,
                      content: (k.content || "").length > MAX
                         ? (k.content || "").slice(0, MAX) + `\n[...truncado, doc tem ${(k.content || "").length} chars]`
                         : (k.content || ""),
                      similarity: null,
                   }));
                   searchMethod = "ilike-fallback";
                }
             }
          }

          if (matches.length > 0) {
             functionResultRes = {
                found: true,
                method: searchMethod,
                documents: matches.map((m) =>
                   m.similarity != null
                      ? `[${m.title} | relevância ${(m.similarity * 100).toFixed(0)}%]\n${m.content}`
                      : `[${m.title}]\n${m.content}`
                ),
             };
          } else {
             functionResultRes = {
                found: false,
                message: `Nada na base corresponde a "${raw}". Diga ao cliente que vai verificar e voltar — NÃO INVENTE resposta.`,
                ...(dbgError ? { _debug_error: dbgError } : {}),
             };
          }
          callLogs.push({ role: "system", content: `[RAG] "${raw}" | method=${searchMethod} | hits=${matches.length}` });
       } else if (call.name === "web_search") {
          const q = String(callArgs.query || "").trim();
          try {
             const { webSearch } = await import("@/lib/web-search");
             const results = await webSearch(q, 5);
             functionResultRes = results.length > 0
                ? { found: true, results: results.map(r => `${r.title}\n${r.url}\n${r.snippet}`) }
                : { found: false, message: "Nenhum resultado encontrado." };
             callLogs.push({ role: "system", content: `[Web Search] "${q}" | ${results.length} resultado(s)` });
          } catch (e: any) {
             functionResultRes = { found: false, error: e.message };
             callLogs.push({ role: "system", content: `[Web Search] "${q}" | FALHA: ${e.message}` });
          }
       } else if (call.name === "schedule_google_calendar") {
          console.log("[MCP] Iniciando Agendamento no Google Calendar ->", callArgs);
          functionResultRes = { scheduled: false, message: "Erro ao agendar no sistema." };

          try {
             const credsObj = typeof agentConfig.options.google_credentials === "string" 
                 ? JSON.parse(agentConfig.options.google_credentials) 
                 : agentConfig.options.google_credentials;

             const oauthTokens = typeof agentConfig.options.google_tokens === "string"
                 ? JSON.parse(agentConfig.options.google_tokens)
                 : agentConfig.options.google_tokens;

             if (!credsObj || !oauthTokens) {
                 throw new Error("Agente não está conectado ao Google via OAuth. Autentique primeiro.");
             }

             const { client_id, client_secret } = credsObj.web || credsObj.installed;
             const auth = new google.auth.OAuth2(client_id, client_secret);
             auth.setCredentials(oauthTokens);

             const calendar = google.calendar({ version: 'v3', auth });

             // TIMEZONE: a IA manda start_datetime "naive" (sem fuso), ex
             // "2026-06-01T10:00:00". Num servidor em UTC, new Date() leria como
             // 10:00 UTC e o dono (BRT -3) veria 07:00 — exatamente o bug
             // relatado. Interpretamos SEMPRE como horário de Brasília quando
             // não vier offset explícito.
             const rawStart = String(callArgs.start_datetime || "").trim();
             const startDt = parseAgendaDateTime(rawStart);
             if (isNaN(startDt.getTime())) {
                throw new Error(`Data/hora inválida recebida da IA: "${rawStart}"`);
             }
             const duration = Number(callArgs.duration_minutes) || calendarDuration;
             const endDt = new Date(startDt.getTime() + duration * 60000);

             // GUARD ANTI-DUPLICAÇÃO: quando o cliente manda várias mensagens
             // seguidas ("combinado", "pode ser?", "obrigada"), cada uma reabre
             // o agente e a IA pode chamar schedule_google_calendar de novo —
             // criando evento duplicado no Google + linha duplicada + vários
             // resumos pro dono (bug relatado: 3 eventos pro mesmo contato).
             // Se já existe agendamento CONFIRMADO pro mesmo contato no MESMO
             // horário (±2min), NÃO recria. (Só mesmo-horário: remarcar pra um
             // horário DIFERENTE é legítimo e tratado adiante cancelando o
             // antigo — por isso NÃO bloqueamos por "criado há pouco".)
             const { data: dupRows } = await supabase
                .from("appointments")
                .select("id, title, start_at, created_at")
                .eq("client_id", clientId)
                .eq("remote_jid", remoteJid)
                .eq("status", "confirmed")
                .order("created_at", { ascending: false })
                .limit(10);
             // Duplicado = mesmo contato já confirmado no MESMO horário (±2min).
             const dup = isDuplicateSlot(dupRows as any, startDt.getTime())
                ? (dupRows || []).find((r: any) => Math.abs(new Date(r.start_at).getTime() - startDt.getTime()) <= 2 * 60_000)
                : null;

             // CONFLITO DE SLOT (OUTRO contato): o banco tem índice único
             // (agent_id, start_at) pra status ativo — o MESMO agente não pode
             // ter 2 agendamentos no mesmo horário. Checamos ANTES de criar no
             // Google: se o slot exato já é de OUTRO número, NÃO criamos (senão
             // o Google teria o evento mas o insert no painel falharia em
             // silêncio = evento órfão sem lembrete). Instruímos a IA a oferecer
             // outro horário. Não bloqueia o próprio contato (isso é o `dup`).
             let slotConflict = false;
             if (agentConfig.id) {
                // Busca agendamentos ativos do agente que SE SOBREPÕEM ao novo
                // intervalo [startDt, endDt): start_at < fim novo E end_at >
                // início novo. Pega sobreposição parcial, não só horário igual.
                const { data: slotRows } = await supabase
                   .from("appointments")
                   .select("id, remote_jid, start_at, end_at")
                   .eq("agent_id", agentConfig.id)
                   .in("status", ["confirmed", "tentative"])
                   .lt("start_at", endDt.toISOString())
                   .gt("end_at", startDt.toISOString())
                   .limit(20);
                slotConflict = hasAgentOverlapConflict(slotRows as any, startDt.getTime(), endDt.getTime(), remoteJid);
             }

             // Descrição: respeita os toggles de captura automática
             const descLines = ["Agendado via Assistente IA SDR."];
             if (callArgs.nome)  descLines.push(`Nome: ${callArgs.nome}`);
             if (callArgs.email) descLines.push(`E-mail: ${callArgs.email}`);
             if (calendarAutoCapture.telefone) {
               const phoneFromJid = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
               descLines.push(`Telefone (WhatsApp): ${phoneFromJid}`);
             }
             if (calendarAutoCapture.empresa     && callArgs.empresa)     descLines.push(`Empresa: ${callArgs.empresa}`);
             if (calendarAutoCapture.necessidade && callArgs.necessidade) descLines.push(`${necessidadeLabel}: ${callArgs.necessidade}`);

             if (dup) {
                console.log(`[Agent/Schedule] Duplicado evitado (appt ${dup.id}) — NÃO recria.`);
                functionResultRes = {
                   scheduled: true,
                   already_scheduled: true,
                   message: `O cliente JÁ TEM um agendamento confirmado ("${dup.title}"). NÃO crie outro nem chame esta ferramenta de novo — apenas confirme com o cliente que está tudo certo, de forma natural.`,
                };
                callLogs.push({ role: "system", content: `[Google Calendar] Duplicado evitado (appt ${dup.id})` });
             } else if (slotConflict) {
                console.log(`[Agent/Schedule] Slot ${startDt.toISOString()} já ocupado por outro contato — oferecer outro horário.`);
                functionResultRes = {
                   scheduled: false,
                   slot_taken: true,
                   message: `Esse horário acabou de ser ocupado por outro cliente. Chame check_google_calendar_availability e ofereça um horário livre DIFERENTE — não insista nesse mesmo horário.`,
                };
                callLogs.push({ role: "system", content: `[Google Calendar] Slot ocupado por outro contato (${startDt.toISOString()})` });
             } else {
             // Corrida: 2 requests passam na checagem de slot ao mesmo tempo. O
             // índice único (agent_id,start_at) barra o 2º insert (23505); aí
             // desfazemos o evento no Google pra não sobrar órfão.
             let raceConflict = false;
             const eventBody: any = {
                 summary: (callArgs.summary as string) + (callArgs.nome ? ` — ${callArgs.nome}` : ` - ${remoteJid.split("@")[0]}`),
                 start: { dateTime: startDt.toISOString(), timeZone: "America/Sao_Paulo" },
                 end: { dateTime: endDt.toISOString(), timeZone: "America/Sao_Paulo" },
                 description: descLines.join("\n"),
             };

             // Se o cliente passou e-mail, vira convidado oficial
             if (callArgs.email) {
                 eventBody.attendees = [{ email: String(callArgs.email) }];
             }

             if (agentConfig.options?.calendar_generate_meet) {
                 eventBody.conferenceData = {
                     createRequest: {
                         requestId: "meeting-" + Date.now(),
                         conferenceSolutionKey: { type: "hangoutsMeet" }
                     }
                 };
             }

             const instRes = await calendar.events.insert({
                 calendarId: 'primary',
                 conferenceDataVersion: 1,
                 sendUpdates: 'all',
                 requestBody: eventBody
             });

             let meetLinkStr = "";
             if (instRes.data.conferenceData?.entryPoints) {
                 const meet = instRes.data.conferenceData.entryPoints.find((e: any) => e.entryPointType === 'video');
                 if (meet) meetLinkStr = ` Link do Meet gerado Automático: ${meet.uri}`;
             }

             // Notifica o dono se configurado em scheduler_config.notify_owner.
             // Best-effort: se falhar, segue normal.
             try {
                 const sched = (agentConfig.scheduler_config || {}) as any;
                 if (sched.notify_owner && sched.owner_phone) {
                     const ownerJid = `${String(sched.owner_phone).replace(/\D/g, "")}@s.whatsapp.net`;
                     const startBR = startDt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
                     const ownerMsg = `📅 Novo agendamento via IA:\n"${callArgs.summary}"\n${startBR}\nContato: ${remoteJid.replace(/@.*$/, "")}`;
                     const { sendMessage } = await import("@/lib/channel");
                     await sendMessage(ownerJid, ownerMsg, instanceName).catch((e: any) =>
                         console.warn("[Agent/NotifyOwner] falhou:", e?.message)
                     );
                 }
             } catch (notifyErr: any) {
                 console.warn("[Agent/NotifyOwner] erro inesperado:", notifyErr?.message);
             }

             // Persiste em public.appointments pra alimentar /calendario, worker
             // de lembrete, e organizer auto-promote do kanban pós-horário.
             // Best-effort: se falhar, não derruba a confirmação ao cliente —
             // o Google já tem o evento, isso é só metadata extra do painel.
             try {
                 const evId = instRes.data.id || null;
                 if (evId) {
                    // Procura lead_id linkado a esse remote_jid no client correto
                    const { data: leadRow } = await supabase
                       .from("leads_extraidos")
                       .select("id")
                       .eq("client_id", clientId)
                       .eq("remoteJid", remoteJid)
                       .maybeSingle();
                    const { error: apptInsErr } = await supabase.from("appointments").insert({
                       client_id: clientId,
                       agent_id: agentConfig.id || null,
                       lead_id: leadRow?.id || null,
                       remote_jid: remoteJid,
                       instance_name: instanceName,
                       google_event_id: evId,
                       calendar_id: "primary",
                       title: eventBody.summary,
                       description: eventBody.description || null,
                       service_name: (callArgs.necessidade as string) || (callArgs.summary as string) || null,
                       start_at: startDt.toISOString(),
                       end_at: endDt.toISOString(),
                       status: "confirmed",
                       created_by: "ia",
                       metadata: {
                          // Nome capturado pelo agente no agendamento ("nome completo").
                          // É o que o lembrete usa como {nome} — sem isso o worker cairia
                          // no nome_negocio (empresa), errando o tratamento do cliente.
                          attendee_name: (callArgs.nome as string) || null,
                          attendee_email: callArgs.email || null,
                          meet_link: meetLinkStr ? meetLinkStr.match(/https?:\/\/\S+/)?.[0] || null : null,
                       },
                    });
                    if (apptInsErr) {
                       // 23505 = índice único (agent_id,start_at): outro contato
                       // pegou o MESMO slot numa corrida. Desfaz o evento no
                       // Google pra não sobrar órfão e pede outro horário.
                       if ((apptInsErr as any).code === "23505") {
                          raceConflict = true;
                          await calendar.events.delete({ calendarId: "primary", eventId: evId, sendUpdates: "all" })
                             .catch((delErr: any) => console.warn("[Agent/Schedule] rollback Google falhou:", delErr?.message));
                          console.warn(`[Agent/Schedule] Corrida de slot ${startDt.toISOString()} — evento Google desfeito.`);
                       } else {
                          console.warn("[Agent/Schedule] Falha persistindo em appointments (não-fatal):", apptInsErr.message);
                       }
                    } else {
                       // REMARCAÇÃO por conversa: se o cliente já tinha um
                       // agendamento FUTURO confirmado e agora marcou outro
                       // horário, cancelamos o antigo (Google + DB) pra não
                       // sobrar evento duplicado nem disparar 2 lembretes. O
                       // novo (recém-criado) é preservado pelo filtro de evId.
                       try {
                          const { data: oldAppts } = await supabase
                             .from("appointments")
                             .select("id, google_event_id")
                             .eq("client_id", clientId)
                             .eq("remote_jid", remoteJid)
                             .eq("status", "confirmed")
                             .gt("start_at", new Date().toISOString())
                             .neq("google_event_id", evId);
                          for (const old of (oldAppts || [])) {
                             if (old.google_event_id) {
                                await calendar.events.delete({ calendarId: "primary", eventId: old.google_event_id, sendUpdates: "all" })
                                   .catch(() => {});
                             }
                             await supabase.from("appointments")
                                .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_reason: "Remarcado pelo cliente (novo horário)", google_event_id: null })
                                .eq("id", old.id);
                          }
                          if ((oldAppts || []).length > 0) {
                             console.log(`[Agent/Schedule] Remarcação: ${oldAppts!.length} agendamento(s) antigo(s) cancelado(s) pro contato ${maskJid(remoteJid)}.`);
                          }
                       } catch (reErr: any) {
                          console.warn("[Agent/Schedule] cancelamento de agendamento antigo (remarcação) falhou:", reErr?.message);
                       }
                    }
                 }
             } catch (apptErr: any) {
                 console.warn("[Agent/Schedule] Falha persistindo em appointments (não-fatal):", apptErr?.message);
             }

             if (raceConflict) {
                // Slot tomado numa corrida — não manda resumo nem confirma.
                functionResultRes = {
                   scheduled: false,
                   slot_taken: true,
                   message: `Esse horário acabou de ser ocupado por outro cliente. Chame check_google_calendar_availability e ofereça um horário livre DIFERENTE — não confirme esse.`,
                };
             } else {
             // RESUMO IA PRO DONO — lê a conversa, gera um resumo e manda no
             // WhatsApp do dono. Detecta reagendamento: se houve cancelamento
             // recente (≤10min) pro mesmo contato, trata como remarcação.
             try {
                 let summaryKind: "agendamento" | "reagendamento" = "agendamento";
                 const { data: recentCancel } = await supabase
                     .from("appointments")
                     .select("id")
                     .eq("client_id", clientId)
                     .eq("remote_jid", remoteJid)
                     .eq("status", "cancelled")
                     .gte("cancelled_at", new Date(Date.now() - 10 * 60_000).toISOString())
                     .limit(1)
                     .maybeSingle();
                 if (recentCancel) summaryKind = "reagendamento";
                 const { sendOwnerAppointmentSummary } = await import("@/lib/owner-summary");
                 await sendOwnerAppointmentSummary({
                     kind: summaryKind,
                     agentConfig,
                     clientId,
                     remoteJid,
                     instanceName,
                     appointment: {
                         title: eventBody.summary,
                         service_name: (callArgs.necessidade as string) || (callArgs.summary as string) || null,
                         start_at: startDt.toISOString(),
                     },
                 });
             } catch (sumErr: any) {
                 console.warn("[Agent/Schedule] resumo p/ dono falhou (não-fatal):", sumErr?.message);
             }

             // PAUSA PÓS-AGENDAMENTO: silencia a IA pra ESTE contato por X tempo
             // depois de marcar, evitando bombardear o cliente logo após confirmar
             // e dando uma janela pro atendente humano. Default 2h (120 min),
             // configurável por agente em scheduler_config.pause_after_schedule_minutes
             // (0 ou ausente = não pausa). Reusa o mecanismo de snooze existente
             // (sessions.resume_at + gate de pausa) — auto-resume gratuito.
             // Só roda quando o agendamento foi REALMENTE confirmado (o guard
             // anti-chamada-dupla em ~1084 garante que é 1x por agendamento).
             try {
                 const schedPause = (agentConfig.scheduler_config || {}) as any;
                 const pauseMin = Number(schedPause.pause_after_schedule_minutes);
                 if (!isTestMode && sessionId && Number.isFinite(pauseMin) && pauseMin > 0) {
                    const { snoozeSession } = await import("@/lib/bot-status");
                    await snoozeSession(sessionId, pauseMin, "system").catch((e: any) =>
                       console.warn("[Agent/Schedule] pausa pós-agendamento falhou (não-fatal):", e?.message));
                    // Log de auditoria: rastreável em /api/webhooks/diagnose.
                    supabase.from("webhook_logs").insert({
                       instance_name: instanceName,
                       event: "AGENT_SCHEDULE_PAUSE",
                       payload: { remote_jid: maskJid(remoteJid), session_id: sessionId, pause_minutes: pauseMin },
                       created_at: new Date().toISOString(),
                    }).then(() => {}, () => {});
                    console.log(`[Agent/Schedule] IA pausada por ${pauseMin}min p/ ${maskJid(remoteJid)} (pós-agendamento).`);
                 }
             } catch { /* não-fatal — o agendamento já está salvo */ }

             // Se o operador ligou "Enviar link do Meet ao cliente", a IA é
             // OBRIGADA a incluir o link na resposta. Senão, só informa que foi
             // gerado (comportamento antigo).
             const sendMeet = !!agentConfig.options?.calendar_send_meet_link;
             const meetUrl = meetLinkStr ? (meetLinkStr.match(/https?:\/\/\S+/)?.[0] || "") : "";
             const meetDirective = (sendMeet && meetUrl)
                ? ` OBRIGATÓRIO: inclua ESTE link do Google Meet na sua próxima mensagem ao cliente, de forma natural (não invente outro, não omita): ${meetUrl}`
                : meetLinkStr;
             functionResultRes = { scheduled: true, message: `O evento "${callArgs.summary}" foi adicionado com sucesso para ${callArgs.start_datetime}. Avise o cliente.${meetDirective}` };
             } // fim do if(!raceConflict)
             } // fim do else (não-duplicado)
          } catch (mcpErr: any) {
             console.error("[MCP Error]:", mcpErr);
             functionResultRes = { scheduled: false, message: `Falha na integração: ${mcpErr.message}. Peça desculpas ao cliente e avise que o sistema está indisponível.` };
          }
          callLogs.push({ role: "system", content: `[Google Calendar] O Agente tentou agendar: "${callArgs.summary}" | Status: ${functionResultRes.scheduled ? 'Sucesso' : 'Falha'}` });
       } else if (call.name === "check_google_calendar_availability") {
           console.log("[MCP] Checando disponibilidade no Google Calendar ->", callArgs);
           functionResultRes = { available: false, message: "Erro ao consultar agenda." };
           
           try {
               const credsObj = typeof agentConfig.options.google_credentials === "string" 
                   ? JSON.parse(agentConfig.options.google_credentials) : agentConfig.options.google_credentials;
               const oauthTokens = typeof agentConfig.options.google_tokens === "string"
                   ? JSON.parse(agentConfig.options.google_tokens) : agentConfig.options.google_tokens;
               
               if (!credsObj || !oauthTokens) throw new Error("Agente não autênticado.");
               const { client_id, client_secret } = credsObj.web || credsObj.installed;
               const auth = new google.auth.OAuth2(client_id, client_secret);
               auth.setCredentials(oauthTokens);
               const calendar = google.calendar({ version: 'v3', auth });

               const targetDate = callArgs.date as string;
               const timeMin = new Date(`${targetDate}T08:00:00-03:00`).toISOString();
               const timeMax = new Date(`${targetDate}T18:00:00-03:00`).toISOString();

               const freeBusyRes = await calendar.freebusy.query({
                   requestBody: {
                       timeMin,
                       timeMax,
                       items: [{ id: 'primary' }]
                   }
               });
               
               const busySlots = freeBusyRes.data.calendars?.['primary']?.busy || [];
               
               functionResultRes = {
                   available: true,
                   message: `Na data ${targetDate}, os seguintes blocos já ESTÃO OCUPADOS: ${JSON.stringify(busySlots)}. O restante do tempo comercial (08 as 18h) está livre. Sugira até 2 horários livres ao cliente baseando-se nesses espaços ociosos.`
               };
           } catch (mcpErr: any) {
               console.error("[MCP FreeBusy Error]:", mcpErr);
               functionResultRes = { available: false, message: `Falha na consulta de tempo: ${mcpErr.message}` };
           }
           callLogs.push({ role: "system", content: `[Google Calendar] Disponibilidade consultada para ${callArgs.date} | Status: ${functionResultRes.available ? 'OK' : 'Falha'}` });
       } else if (call.name === "list_google_calendar_events") {
           console.log("[MCP] Listando eventos do Google Calendar ->", callArgs);
           functionResultRes = { found: false, events: [], message: "Erro ao listar eventos." };
           try {
               const credsObj = typeof agentConfig.options.google_credentials === "string"
                   ? JSON.parse(agentConfig.options.google_credentials) : agentConfig.options.google_credentials;
               const oauthTokens = typeof agentConfig.options.google_tokens === "string"
                   ? JSON.parse(agentConfig.options.google_tokens) : agentConfig.options.google_tokens;
               if (!credsObj || !oauthTokens) throw new Error("Agente não autenticado no Google.");
               const { client_id, client_secret } = credsObj.web || credsObj.installed;
               const auth = new google.auth.OAuth2(client_id, client_secret);
               auth.setCredentials(oauthTokens);
               const calendar = google.calendar({ version: 'v3', auth });

               const dFrom = callArgs.date_from as string;
               const dTo   = (callArgs.date_to as string) || dFrom;
               const timeMin = new Date(`${dFrom}T00:00:00-03:00`).toISOString();
               const timeMax = new Date(`${dTo}T23:59:59-03:00`).toISOString();

               const list = await calendar.events.list({
                   calendarId: 'primary',
                   timeMin,
                   timeMax,
                   singleEvents: true,
                   orderBy: 'startTime',
                   maxResults: 30,
               });

               const events = (list.data.items || []).map((e: any) => ({
                   id: e.id,
                   summary: e.summary || "(sem título)",
                   start: e.start?.dateTime || e.start?.date,
                   end:   e.end?.dateTime   || e.end?.date,
                   attendees: (e.attendees || []).map((a: any) => a.email).filter(Boolean),
               }));

               functionResultRes = events.length > 0
                   ? { found: true, events, message: `${events.length} evento(s) encontrado(s) entre ${dFrom} e ${dTo}.` }
                   : { found: false, events: [], message: `Nenhum evento encontrado entre ${dFrom} e ${dTo}. Avise o cliente que não tem reunião nesse período.` };
           } catch (mcpErr: any) {
               console.error("[MCP List Error]:", mcpErr);
               functionResultRes = { found: false, events: [], message: `Falha ao listar agenda: ${mcpErr.message}` };
           }
           callLogs.push({ role: "system", content: `[Google Calendar] List ${callArgs.date_from}..${callArgs.date_to || callArgs.date_from} | ${functionResultRes.events?.length || 0} evento(s)` });
       } else if (call.name === "cancel_google_calendar_event") {
           console.log("[MCP] Cancelando evento do Google Calendar ->", callArgs);
           functionResultRes = { cancelled: false, message: "Erro ao cancelar evento." };
           try {
               const credsObj = typeof agentConfig.options.google_credentials === "string"
                   ? JSON.parse(agentConfig.options.google_credentials) : agentConfig.options.google_credentials;
               const oauthTokens = typeof agentConfig.options.google_tokens === "string"
                   ? JSON.parse(agentConfig.options.google_tokens) : agentConfig.options.google_tokens;
               if (!credsObj || !oauthTokens) throw new Error("Agente não autenticado no Google.");
               const { client_id, client_secret } = credsObj.web || credsObj.installed;
               const auth = new google.auth.OAuth2(client_id, client_secret);
               auth.setCredentials(oauthTokens);
               const calendar = google.calendar({ version: 'v3', auth });

               const eventId = String(callArgs.event_id || "").trim();
               if (!eventId) throw new Error("event_id vazio. Chame list_google_calendar_events primeiro.");

               await calendar.events.delete({
                   calendarId: 'primary',
                   eventId,
                   sendUpdates: 'all',
               });

               // Atualiza appointments local (se existe) pra refletir cancelamento.
               // .select() captura os dados ANTES de zerar — usados no resumo IA.
               let cancelledAppt: any = null;
               try {
                  const { data: cancelledRows } = await supabase
                     .from("appointments")
                     .update({
                        status: "cancelled",
                        cancelled_at: new Date().toISOString(),
                        cancelled_reason: (callArgs.reason as string) || "Cancelado pela IA via WhatsApp",
                        google_event_id: null,
                     })
                     .eq("google_event_id", eventId)
                     .select("title, service_name, start_at");
                  cancelledAppt = cancelledRows?.[0] || null;
               } catch (apptErr: any) {
                  console.warn("[Agent/Cancel] Falha atualizando appointments:", apptErr?.message);
               }

               // RESUMO IA PRO DONO — cancelamento. Lê a conversa e avisa o dono.
               try {
                  const { sendOwnerAppointmentSummary } = await import("@/lib/owner-summary");
                  await sendOwnerAppointmentSummary({
                     kind: "cancelamento",
                     agentConfig,
                     clientId,
                     remoteJid,
                     instanceName,
                     appointment: {
                        title: cancelledAppt?.title || null,
                        service_name: cancelledAppt?.service_name || null,
                        start_at: cancelledAppt?.start_at || null,
                     },
                  });
               } catch (sumErr: any) {
                  console.warn("[Agent/Cancel] resumo p/ dono falhou (não-fatal):", sumErr?.message);
               }

               functionResultRes = {
                   cancelled: true,
                   message: `Evento ${eventId} cancelado com sucesso. Avise o cliente que a reunião foi desmarcada${callArgs.reason ? ` (motivo: ${callArgs.reason})` : ""}.`
               };
           } catch (mcpErr: any) {
               console.error("[MCP Cancel Error]:", mcpErr);
               const msg = /not found|resource.*not.*exist/i.test(mcpErr.message)
                   ? "Esse evento não foi encontrado. Peça ao cliente pra confirmar a data e chame list_google_calendar_events de novo."
                   : `Falha ao cancelar: ${mcpErr.message}`;
               functionResultRes = { cancelled: false, message: msg };
           }
           callLogs.push({ role: "system", content: `[Google Calendar] Cancel ${callArgs.event_id} | Status: ${functionResultRes.cancelled ? 'Sucesso' : 'Falha'}` });
       } else if (call.name === "save_variables") {
          console.log("[MCP] Salvando Variáveis ->", callArgs);
          try {
             const newVars = { ...currentVariables, ...callArgs };
             currentVariables = newVars;
             if (!isTestMode && sessionId) {
                await supabase.from("sessions").update({ variables: newVars }).eq("id", sessionId);
             }
             functionResultRes = { success: true, message: "Variáveis salvas com sucesso no banco de dados." };
          } catch (err: any) {
             functionResultRes = { success: false, message: "Erro ao salvar: " + err.message };
          }
          callLogs.push({ role: "system", content: `[Funil] Variáveis extraídas: ${JSON.stringify(callArgs)}` });
       } else if (call.name === "complete_current_stage") {
          console.log("[MCP] Completando Etapa Atual ->", activeStage?.title);
          try {
             currentStageIndex++; // Avança
             if (!isTestMode && sessionId && leadStages && leadStages[currentStageIndex]) {
                await supabase.from("sessions").update({ current_stage_id: leadStages[currentStageIndex].id }).eq("id", sessionId);
             }
             functionResultRes = { success: true, message: "Etapa concluída! Leia as instruções da próxima etapa e continue o atendimento." };
          } catch (err: any) {
             functionResultRes = { success: false, message: "Erro ao avançar: " + err.message };
          }
          callLogs.push({ role: "system", content: `[Funil] Etapa '${activeStage?.title}' concluída.` });
       } else {
          // Custom Tool Handler
          const matchTool = customTools.find((ct: any) => ct.name === call.name);
          if (matchTool) {
              console.log("[MCP] Webhook Tool Request ->", matchTool.name);
              try {
                  const reqWb = await fetch(matchTool.webhook_url, {
                     method: "POST",
                     headers: { "Content-Type": "application/json" },
                     body: JSON.stringify({ query: callArgs.query, remoteJid, instanceName })
                  });
                  const reqJson = await reqWb.json();
                  functionResultRes = { success: true, api_response: reqJson };
              } catch (e: any) {
                  functionResultRes = { success: false, error_message: "A automação externa demorou a responder ou falhou: " + e.message };
              }
              callLogs.push({ role: "system", content: `[Webhook Custom] API: "${matchTool.name}" | Status: ${functionResultRes.success ? 'Retornou Dados' : 'Falhou'}` });
          }
       }
       
       toolResults.push({ name: call.name, id: call.id, response: functionResultRes });
       } // fim do for (const call of turn.toolCalls)

       // Devolve os resultados das ferramentas e pega o próximo turno.
       turn = await session.sendToolResults(toolResults);
       finalAnswer = turn.text;
       totalPrompt += turn.usage.promptTokens; totalCompletion += turn.usage.completionTokens; totalAll += turn.usage.totalTokens;
    }

    // Loga consumo total de tokens dessa interação
    logTokenUsage({
      source: "agent",
      sourceId: agentId ? String(agentId) : null,
      sourceLabel: agentConfig?.name || `Agente #${agentId}`,
      // Vincula o gasto ao cliente — sem isso, o painel /tokens do cliente
      // não enxerga o consumo e admin vê os dados misturados.
      clientId,
      model: effectiveModelId,
      provider: agentProvider === "openrouter" ? "OpenRouter" : "Gemini",
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      totalTokens: totalAll,
      metadata: { remoteJid, instanceName, isTestMode },
    });

    finalAnswer = finalAnswer.replace(/^```\w*\n?/g, "").replace(/\n?```$/g, "");

    // 9. Envio: roteia pelo provider do canal (Evolution OU WhatsApp Cloud).
    // Import dinâmico pra evitar ciclos.
    const channelMod = await import("@/lib/channel");
    const humanize = agentConfig.options?.humanize_messages ?? false;

    const testStateUpdate = isTestMode ? {
        variables: currentVariables,
        currentStageIndex: currentStageIndex,
        skippedStages: skippedStages
    } : undefined;

    if (isTestMode) {
        return NextResponse.json({ 
            success: true, 
            ai_responded: true, 
            text: finalAnswer, 
            chunks: humanize ? splitMessage(finalAnswer) : [finalAnswer],
            isTest: true, 
            logs: callLogs,
            testStateUpdate
        });
    }

    let lastSendResult: any = null;
    let anySendError: string | null = null;
    
    const messageChunks = humanize ? splitMessage(finalAnswer) : [finalAnswer];
    console.log(`[AGENT] Enviando ${messageChunks.length} chunks para ${maskJid(remoteJid)} (Humanize: ${humanize})`);

    for (let i = 0; i < messageChunks.length; i++) {
        const chunkText = messageChunks[i];
        let sendResult: any = null;
        let sendError: string | null = null;

        try {
            // Se for o segundo chunk em diante, a gente espera um pouco a mais
            if (i > 0) {
                const typingSeconds = Math.min(Math.max(chunkText.length / 15, 2), 5); // Simula velocidade de digitação
                console.log(`[AGENT] Delay entre mensagens: ${typingSeconds}s...`);
                await new Promise(r => setTimeout(r, typingSeconds * 1000));
            }

            try {
                const { registerPendingAutomatedSend } = await import("@/lib/manual-send-registry");
                registerPendingAutomatedSend(instanceName, remoteJid, chunkText);
            } catch (regErr) {
                console.warn("[AGENT] Falha ao registrar envio pendente:", regErr);
            }

            sendResult = await channelMod.sendMessage(remoteJid, chunkText, instanceName);
            lastSendResult = sendResult;
        } catch (err: any) {
            sendError = err.message;
            anySendError = sendError;
            console.error(`[AGENT] Falha ao enviar chunk ${i+1}:`, sendError);
        }

        // CRÍTICO: msgId precisa ser único E definido. Antes, se o Evolution
        // não retornasse key.id (acontece em alguns response shapes), msgId
        // virava `undefined` → insert no chats_dashboard com message_id=NULL
        // → silenciosa coleção de duplicatas. Sufixo aleatório blinda isso.
        const msgId = sendResult?.key?.id
          || sendResult?.data?.key?.id
          || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Registra o msgId como envio da IA — assim o webhook, ao receber o
        // echo fromMe, sabe que foi a PRÓPRIA IA e NÃO aciona a auto-pausa
        // (que é só pra quando um HUMANO assume a conversa).
        try {
          const { registerAiSend } = await import("@/lib/manual-send-registry");
          registerAiSend(msgId);
        } catch { /* não-fatal */ }

        // CRÍTICO: AWAIT os inserts. Em Next 16 standalone, fire-and-forget
        // pode ser cortado quando a função retorna a resposta. Sem await,
        // a mensagem da IA NÃO chegava no chats_dashboard mesmo o WhatsApp
        // tendo entregue. Por isso "nada aparecia em /chat".
        const nowIso = new Date().toISOString();

        if (sessionId) {
            const { error: msgErr } = await supabase.from("messages").insert({
                session_id: sessionId,
                message_id: msgId,
                sender: 'ai',
                content: chunkText,
                media_category: 'text',
                delivery_status: sendError ? 'error' : 'sent',
                created_at: nowIso,
            });
            if (msgErr) console.warn("[AGENT] messages insert:", msgErr.message);
        }

        // chats_dashboard — fonte que /chat lê. Se falhar (ex: msgId duplicado),
        // tenta de novo com sufixo aleatório. Não pode falhar silencioso.
        const dashPayload = {
            message_id: msgId,
            remote_jid: remoteJid,
            sender_type: 'ai',
            content: chunkText,
            status_envio: sendError ? 'error' : 'sent',
            instance_name: instanceName,
            created_at: nowIso,
        };
        const { error: dashErr } = await supabase.from("chats_dashboard").insert(dashPayload);
        if (dashErr) {
            if ((dashErr as any).code === "23505") {
                // Unique violation → tenta com sufixo aleatório.
                const retryId = `${msgId}-${Math.random().toString(36).slice(2, 8)}`;
                const retry = await supabase.from("chats_dashboard").insert({ ...dashPayload, message_id: retryId });
                if (retry.error) console.warn("[AGENT] chats_dashboard retry falhou:", retry.error.message);
            } else {
                console.warn("[AGENT] chats_dashboard insert:", dashErr.message);
                // Loga em webhook_logs pra usuário poder debugar via Configurações.
                await supabase.from("webhook_logs").insert({
                    instance_name: instanceName,
                    event: "AGENT_DASH_INSERT_FAIL",
                    payload: { remote_jid: remoteJid, error: dashErr.message, code: (dashErr as any).code, msg_id: msgId },
                    created_at: nowIso,
                }).then(() => {}, () => {});
            }
        }
    }

    // Log de resultado (resumo)
    await supabase.from("webhook_logs").insert({
       instance_name: instanceName,
       event: anySendError ? "AGENT_SEND_ERROR" : "AGENT_SEND_SUCCESS",
       payload: anySendError 
         ? { remoteJid, error: anySendError }
         : { remoteJid, text_preview: finalAnswer.slice(0, 50), chunks: messageChunks.length },
       created_at: new Date().toISOString()
    });

    return NextResponse.json({ success: true, ai_responded: true, sendResult: lastSendResult, sendError: anySendError, testStateUpdate });

  } catch (err: any) {
    console.error("[Agent Process Error]:", err);
    try {
      await supabase.from("webhook_logs").insert({
         instance_name: "unknown",
         event: "AGENT_CRITICAL_ERROR",
         payload: { error: err.message, stack: err.stack?.slice(0, 300) },
         created_at: new Date().toISOString()
      });
    } catch (_) { /* ignore logging errors */ }
    return NextResponse.json({ success: false, error: err.message });
  }
}
