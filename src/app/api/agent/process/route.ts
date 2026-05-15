import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { google } from "googleapis";
import { getEffectiveStatus } from "@/lib/bot-status";
import { renderTemplate } from "@/lib/template-vars";
import { logTokenUsage, extractGeminiUsage } from "@/lib/token-usage";
import { getEvolutionConfig } from "@/lib/evolution";

export const dynamic = 'force-dynamic';

// Para chamadas internas (server-to-server), sempre usar localhost
const INTERNAL_BASE = `http://localhost:${process.env.PORT || 3000}`;

export async function POST(req: NextRequest) {
  try {
    const payloadBody = await req.json();
    const defaultInstance = (await getEvolutionConfig()).instance;
    const { remoteJid, isStatusUpdate, instanceName = defaultInstance, text, isTestMode = false, testHistory = [], sessionId, testState, testLeadData } = payloadBody;

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
    if (!isTestMode && sessionId) {
      const { data: sessionRow } = await supabase
        .from("sessions")
        .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at")
        .eq("id", sessionId)
        .single();
      if (sessionRow) {
        const eff = await getEffectiveStatus(sessionRow as any);
        if (!eff.isActive) {
          console.log(`[AGENT] IA pausada (${eff.reason}) para ${remoteJid}. Mensagem já foi salva.`);
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
       supabase.from("channel_connections").select("agent_id").eq("instance_name", instanceName).single(),
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
       leadRow = {
           nome_negocio: testLeadData.nome_negocio || null,
           ramo_negocio: testLeadData.ramo_negocio || null,
           categoria: testLeadData.categoria || null,
           endereco: testLeadData.endereco || null,
           website: testLeadData.website || null,
           telefone: testLeadData.telefone || null,
       };
       contactRow = {
           push_name: testLeadData.push_name || null,
           phone_number: testLeadData.telefone || null,
       };
    }

    // 2. Determinar AgentID e Buscar Dados do Agente em Paralelo
    let agentId = Number(req.headers.get("x-test-agent-id")) || channel?.agent_id || 1;

    // Buscar histórico — limit 30 (era 10) cobre disparo inicial + 3-4 follow-ups +
    // ~20 trocas de mensagem do cliente. Antes, se o lead tivesse trocado >10
    // msgs com o SDR, o disparo original sumia do contexto e a IA "começava do zero".
    const historyQuery = !isTestMode
       ? (sessionId
          ? supabase.from("messages").select("sender, content, created_at").eq("session_id", sessionId).order("created_at", { ascending: false }).limit(30)
          : supabase.from("chats_dashboard").select("sender_type, content, created_at").eq("remote_jid", remoteJid).eq("instance_name", instanceName).order("created_at", { ascending: false }).limit(30)
       )
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
       return NextResponse.json({ success: true, status: "agent_inactive" });
    }

    console.log(`[AGENT] Processing for Agent: ${agentConfig.name} (ID: ${agentId})`);
    
    // ============================================================
    // NOVO: SISTEMA DE AGRUPAMENTO (BUFFER) DE MENSAGENS
    // ============================================================
    const bufferSeconds = agentConfig.options?.message_buffer_seconds || 0;
    let finalProcessText = text;

    if (!isTestMode && bufferSeconds > 0) {
       console.log(`[BUFFER] Ativado: ${bufferSeconds}s para ${remoteJid} na instância ${instanceName}`);
       const batchStartTime = new Date().toISOString();
       const expiresAt = new Date(Date.now() + (bufferSeconds + 10) * 1000).toISOString();

       // Tenta ser o "Líder" do lote
       const { error: lockErr } = await supabase.from("chat_buffers").insert({
          remote_jid: remoteJid, instance_name: instanceName, expires_at: expiresAt
       });

       if (lockErr) {
          // Se for erro de conflito (23505), outro processo já é o líder
          if (lockErr.code === "23505") {
             console.log(`[BUFFER] Outro processo já é o líder para ${remoteJid}. Este encerra.`);
             return NextResponse.json({ success: true, status: "batching_active" });
          } else {
             console.error("[BUFFER] Erro inesperado ao criar lock:", lockErr);
             // Se não for conflito, apenas ignora o buffer e processa agora para não travar
          }
       } else {
          // Eu sou o Líder
          console.log(`[BUFFER] LIDER: Aguardando ${bufferSeconds}s para consolidar mensagens de ${remoteJid}...`);
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

    // 4. API KEY
    const finalApiKey = agentConfig.options?.gemini_api_key || orgConfig?.api_key;
    if (!finalApiKey) return NextResponse.json({ success: false, error: "API Key não configurada." });

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
    let skippedStages = isTestMode ? (testState?.skippedStages || []) : [];

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
        while (currentStageIndex < leadStages.length) {
            const stage = leadStages[currentStageIndex];
            
            let conditionMet = true;
            if (stage.condition_variable && stage.condition_operator && stage.condition_value) {
                const varValue = currentVariables[stage.condition_variable] || "";
                const targetValue = stage.condition_value;
                if (stage.condition_operator === 'equals') conditionMet = (varValue.toLowerCase() === targetValue.toLowerCase());
                if (stage.condition_operator === 'not_equals') conditionMet = (varValue.toLowerCase() !== targetValue.toLowerCase());
                if (stage.condition_operator === 'contains') conditionMet = varValue.toLowerCase().includes(targetValue.toLowerCase());
            }

            if (conditionMet) {
                activeStage = stage;
                break;
            } else {
                if (!skippedStages.includes(currentStageIndex)) skippedStages.push(currentStageIndex);
                currentStageIndex++;
            }
        }
        
        // Salvar stage atual na DB se avançou
        if (!isTestMode && sessionId && activeStage) {
            await supabase.from("sessions").update({ current_stage_id: activeStage.id }).eq("id", sessionId);
        }

        if (activeStage) {
            funilInstrucao = `### ETAPA ATUAL DO CLIENTE: ${activeStage.title}\nSua missão imediata nesta etapa: ${activeStage.goal_prompt}`;
            
            const varsToCapture = activeStage.captured_variables;
            if (Array.isArray(varsToCapture) && varsToCapture.length > 0) {
                let captureInstructions: string[] = [];
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

    let rawGeminiHistory: any[] = [];
    if (isTestMode && testHistory.length > 0) {
        testHistory.forEach((m: any) => {
            if (m.role === "system") return; // Ignora logs de sistema no histórico da IA
            rawGeminiHistory.push({
                role: m.role === "user" ? "user" : "model",
                parts: [{ text: m.content || "" }]
            });
        });
    } else if (historico.length > 0) {
        historico.reverse().forEach((m: any) => {
            const senderKey = m.sender || m.sender_type;
            if (senderKey === "system" || senderKey === "human") return; // Foca apenas IA e Cliente
            const role = senderKey === 'customer' ? 'user' : 'model';
            const safeContent = m.content ? (m.content.length > 1000 ? m.content.substring(0, 1000) + "... [cortado]" : m.content) : "[Mídia/Comando]";
            rawGeminiHistory.push({
                role,
                parts: [{ text: safeContent }]
            });
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
    const diasSemana = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
    const infoDataHora = `Data de Hoje: ${agora.toLocaleDateString("pt-BR")} (${diasSemana[agora.getDay()]})\nHora Atual: ${agora.toLocaleTimeString("pt-BR")}`;

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

<lead_context>
${leadContextBlock || "(sem dados de CRM/disparo/follow-up para este lead)"}
</lead_context>

<current_funnel_stage>
${funilInstrucao}
</current_funnel_stage>

<data_collection_goals>
${capturedVariablesPrompt}
</data_collection_goals>

<execution_directives>
1. Aja EXCLUSIVAMENTE de acordo com sua <system_identity> e siga estritamente as <core_instructions>. Nunca revele que é uma inteligência artificial.
2. FOCO ABSOLUTO: O seu objetivo imediato é ÚNICA E EXCLUSIVAMENTE cumprir as orientações da <current_funnel_stage> e extrair os dados listados em <data_collection_goals>. Não se antecipe a etapas futuras.
3. Utilize as ferramentas disponíveis em <available_tools_and_rules> sempre que as condições exigirem.
4. O histórico da conversa e a mensagem atual do usuário serão fornecidos pelo sistema nativamente.
5. CONTINUIDADE — NÃO RECOMECE: o <lead_context> mostra exatamente o que o SDR já enviou (disparo inicial, follow-ups). Você JÁ se apresentou, JÁ disse o nome da empresa, JÁ tratou pelo nome do negócio. NÃO repita "Olá, sou da [empresa]" se isso já está em <lead_context>. Continue a conversa de onde parou. Use os dados de CRM (ramo, categoria, endereço) pra contextualizar — sem perguntar o que já está conhecido.
6. Seja natural, humano e empático.
</execution_directives>
`;

    // 8. Tool Calls (MCP + RAG) — declarações DINÂMICAS baseadas em KB + Calendar config
    const functionDeclarations: any[] = [];

    // Ferramenta 1: RAG — descrição lista os tópicos disponíveis
    if (knowledgeTopics.length > 0) {
       const topicList = knowledgeTopics.map(k => `"${k.title}"`).join(", ");
       functionDeclarations.push({
          name: "search_knowledge_base",
          description: `Base de conhecimento da empresa. Tópicos disponíveis: ${topicList}. Use SEMPRE quando o cliente perguntar sobre qualquer um desses tópicos. Não invente respostas — consulte aqui primeiro.`,
          parameters: {
             type: SchemaType.OBJECT,
             properties: {
                query: { type: SchemaType.STRING, description: `Tópico exato a buscar. Use um dos disponíveis: ${topicList}` }
             },
             required: ["query"]
          }
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
          scheduleProps.necessidade = { type: SchemaType.STRING, description: "Resumo (1 linha) da dor ou motivo do contato. NÃO PERGUNTE. Inferida do histórico da conversa." };
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
          description: `Agenda reunião no calendário (duração padrão ${calendarDuration} min). PRÉ-REQUISITO OBRIGATÓRIO: você JÁ DEVE ter chamado check_google_calendar_availability nesta mesma conversa antes de criar o evento — proibido chutar horário.${askTxt} Empresa e necessidade você INFERE da conversa, NUNCA pergunta. Telefone é automático.`,
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

    const toolsConfig = functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;

    // Inicializar o cliente Google Generative AI
    const genAI = new GoogleGenerativeAI(finalApiKey);
    const modelId = agentConfig.target_model || "gemini-1.5-flash";
    console.log(`[AGENT] Usando modelo: ${modelId}`);

    const minifiedPromptMaster = promptMaster.replace(/\n\s+/g, '\n').trim();

    const modelWithTools = genAI.getGenerativeModel({ 
        model: modelId, 
        tools: toolsConfig,
        systemInstruction: minifiedPromptMaster 
    });
    
    // Historico Estruturado Nativo
    const chat = modelWithTools.startChat({
        history: geminiHistory
    });

    const timeContext = `[Sistema: Hoje é ${agora.toLocaleDateString("pt-BR")}, ${agora.toLocaleTimeString("pt-BR")}]`;
    const result = await chat.sendMessage([{ text: `${finalProcessText}\n\n${timeContext}` }]);

    let finalAnswer = result.response.text().trim();

    // Acumula tokens dessa interação (1 inicial + N de tool-loop)
    let totalPrompt = 0, totalCompletion = 0, totalAll = 0;
    {
      const u = extractGeminiUsage(result);
      totalPrompt += u.promptTokens; totalCompletion += u.completionTokens; totalAll += u.totalTokens;
    }

    // Tratamento de Function Call MCP — loop pra permitir CHAIN de tools
    // (ex: list_google_calendar_events → cancel_google_calendar_event).
    // Limite de 5 pra evitar loop infinito caso o modelo fique chamando tool.
    let callLogs: any[] = [];
    let currentResult = result;
    for (let iter = 0; iter < 5; iter++) {
       const callArray = currentResult.response.functionCalls();
       if (!callArray || callArray.length === 0) break;
       const call = callArray[0];
       const callArgs = call.args as any;
       let functionResultRes: any = {};

       if (call.name === "search_knowledge_base") {
          const searchQuery = (callArgs.query as string)?.toLowerCase() || "";
          const { data: konw } = await supabase.from("agent_knowledge")
              .select("*")
              .eq("agent_id", agentId)
              .or(`title.ilike.%${searchQuery}%,content.ilike.%${searchQuery}%`)
              .limit(3);

          if (konw && konw.length > 0) {
             functionResultRes = {
                found: true,
                documents: konw.map(k => `[${k.title}] ${k.content}`)
             };
          } else {
             functionResultRes = { found: false, message: "Nenhum documento listado na base corresponde a essa busca." };
          }
          callLogs.push({ role: "system", content: `[RAG BDD] Busca por: "${searchQuery}" | Encontrou: ${functionResultRes.found ? 'Sim' : 'Não'}` });
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

             const startDt = new Date(callArgs.start_datetime as string);
             const duration = Number(callArgs.duration_minutes) || calendarDuration;
             const endDt = new Date(startDt.getTime() + duration * 60000);

             // Descrição: respeita os toggles de captura automática
             const descLines = ["Agendado via Assistente IA SDR."];
             if (callArgs.nome)  descLines.push(`Nome: ${callArgs.nome}`);
             if (callArgs.email) descLines.push(`E-mail: ${callArgs.email}`);
             if (calendarAutoCapture.telefone) {
               const phoneFromJid = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
               descLines.push(`Telefone (WhatsApp): ${phoneFromJid}`);
             }
             if (calendarAutoCapture.empresa     && callArgs.empresa)     descLines.push(`Empresa: ${callArgs.empresa}`);
             if (calendarAutoCapture.necessidade && callArgs.necessidade) descLines.push(`Necessidade: ${callArgs.necessidade}`);

             const eventBody: any = {
                 summary: (callArgs.summary as string) + (callArgs.nome ? ` — ${callArgs.nome}` : ` - ${remoteJid.split("@")[0]}`),
                 start: { dateTime: startDt.toISOString() },
                 end: { dateTime: endDt.toISOString() },
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

             functionResultRes = { scheduled: true, message: `O evento "${callArgs.summary}" foi adicionado com sucesso para ${callArgs.start_datetime}. Avise o cliente.${meetLinkStr}` };
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
       
       currentResult = await chat.sendMessage([{
          functionResponse: {
             name: call.name,
             response: functionResultRes
          }
       }]);
       finalAnswer = currentResult.response.text().trim();
       const u = extractGeminiUsage(currentResult);
       totalPrompt += u.promptTokens; totalCompletion += u.completionTokens; totalAll += u.totalTokens;
    }

    // Loga consumo total de tokens dessa interação
    logTokenUsage({
      source: "agent",
      sourceId: agentId ? String(agentId) : null,
      sourceLabel: agentConfig?.name || `Agente #${agentId}`,
      model: modelId,
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
    console.log(`[AGENT] Enviando ${messageChunks.length} chunks para ${remoteJid} (Humanize: ${humanize})`);

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

// Verifica se o horário atual está coberto pela escala JSON (Síncrono para performance)
function checkSchedulesSync(schedulesJSON: any) {
    if (!schedulesJSON || !Array.isArray(schedulesJSON)) return false;
    const now = new Date();
    const dayNames = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
    const currentDay = dayNames[now.getDay()];
    const currentTime = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');

    const sched = schedulesJSON.find(s => s.day === currentDay);
    if (!sched || !sched.active) return true; // True = IS CLOSED
    if (currentTime < sched.start || currentTime > sched.end) return true; // IS CLOSED
    return false; // OPEN
}

// NOVO: Função para picotar mensagens de forma lógica (Humanização)
function splitMessage(text: string): string[] {
    if (!text) return [];
    
    // 1. Divide por quebras de linha (parágrafos)
    let initialChunks = text.split(/\n\n+/).map(c => c.trim()).filter(Boolean);
    
    let finalChunks: string[] = [];
    
    for (let chunk of initialChunks) {
        if (chunk.length > 400) {
            const sentences = chunk.split(/(?<=[.!?])\s+|\n/).map(s => s.trim()).filter(Boolean);
            
            let temp = "";
            for (let s of sentences) {
                if ((temp.length + s.length) < 400) {
                    temp += (temp ? " " : "") + s;
                } else {
                    if (temp) finalChunks.push(temp);
                    temp = s;
                }
            }
            if (temp) finalChunks.push(temp);
        } else {
            finalChunks.push(chunk);
        }
    }
    
    return finalChunks.filter(c => c.length > 0);
}
