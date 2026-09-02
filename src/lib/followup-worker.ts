/**
 * Worker de Follow-up automático.
 *
 * Fluxo por target:
 *   1. Chega `next_send_at`; se o cliente respondeu desde `last_sent_at`, marca
 *      como "responded" e move o lead para "interessado" (respeita hierarquia).
 *   2. Senão, renderiza o template do passo atual (com variáveis) e, se a IA
 *      estiver ativa, passa pelo agente Gemini com o prompt custom + histórico
 *      da conversa para gerar uma mensagem mais contextual.
 *   3. Envia via Evolution com jitter entre envios (anti-bloqueio).
 *   4. Avança `current_step`; se o próximo passo não existe → target virou
 *      "exhausted": move o lead para "sem_interesse" com motivo e registra no
 *      historico_ia_leads.
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import * as channel from "@/lib/channel";
import { renderTemplate } from "@/lib/template-vars";
import { splitMessage } from "@/lib/agent-format";
import {
  findOrCreateContactSession,
  persistOutgoingMessage,
  isWithinHourWindow,
  jitterMs,
} from "@/lib/campaign-worker";
import { logTokenUsage } from "@/lib/token-usage";
import { registerPendingAutomatedSend } from "@/lib/manual-send-registry";
import { isInstanceOwnedByClient } from "@/lib/tenant";

type FollowupStep = {
  day_offset: number;
  template: string;
};

type FollowupCampaign = {
  id: string;
  client_id: string;
  name: string;
  instance_name: string;
  ai_enabled: boolean;
  ai_model: string | null;
  ai_prompt: string | null;
  steps: FollowupStep[];
  min_interval_seconds: number;
  max_interval_seconds: number;
  allowed_start_hour: number;
  allowed_end_hour: number;
  auto_execute: boolean;
  humanize_messages?: boolean;
  media_url?: string | null;
  media_type?: string | null;
  media_caption?: string | null;
  media_file_name?: string | null;
  media_mimetype?: string | null;
  status: string;
};

type FollowupTarget = {
  id: string;
  client_id: string;
  followup_campaign_id: string;
  lead_id: number | null;
  remote_jid: string;
  nome_negocio: string | null;
  ramo_negocio: string | null;
  current_step: number;
  last_sent_at: string | null;
  next_send_at: string | null;
  status: string;
  last_message_id: string | null;
};

// ============================================================
// Helpers
// ============================================================

// Cacheia se a tabela existe pra não poluir log toda vez que insere.
let followupLogsAvailable: boolean | null = null;

export async function addFollowupLog(
  campaignId: string,
  clientId: string,
  message: string,
  level: "info" | "success" | "warning" | "error" = "info"
) {
  console.log(`[FOLLOWUP_LOG][${level.toUpperCase()}] ${campaignId} | ${message}`);

  // Erros também persistem no last_error da campanha (visível no card)
  if (level === "error") {
    supabase.from("followup_campaigns").update({
      last_error: message.slice(0, 500),
      last_error_at: new Date().toISOString(),
    }).eq("id", campaignId).eq("client_id", clientId).then(() => {}, () => {});
  }

  if (followupLogsAvailable === false) return;
  try {
    const { error } = await supabase.from("followup_logs").insert({
      followup_campaign_id: campaignId,
      client_id: clientId,
      message,
      level,
    });
    if (error) {
      if ((error as any).code === "42P01") {
        console.warn("[FOLLOWUP_LOG] tabela followup_logs não existe. Rode criar_followup.sql.");
        followupLogsAvailable = false;
      }
    } else {
      followupLogsAvailable = true;
    }
  } catch {}
}

async function loadCampaign(id: string, clientId: string): Promise<FollowupCampaign | null> {
  const { data } = await supabase
    .from("followup_campaigns")
    .select("*")
    .eq("id", id)
    .eq("client_id", clientId)
    .maybeSingle();
  return (data as FollowupCampaign) || null;
}

async function getApiKey(): Promise<string | null> {
  const { data } = await supabase
    .from("ai_organizer_config")
    .select("api_key")
    .eq("id", 1)
    .maybeSingle();
  return data?.api_key || null;
}

async function clientRespondedSince(remoteJid: string, sinceIso: string, clientId: string): Promise<boolean> {
  const { data } = await supabase
    .from("chats_dashboard")
    .select("id")
    .eq("remote_jid", remoteJid)
    .eq("client_id", clientId)
    .eq("is_from_me", false)
    .gt("created_at", sinceIso)
    .limit(1);
  return !!(data && data.length > 0);
}

export async function getConversationHistory(remoteJid: string, clientId: string, limit = 80): Promise<string> {
  // Limit DEFAULT 80 (era 20). A IA do follow-up agora analisa a CONVERSA
  // INTEIRA pra entender exatamente o contexto: quais perguntas foram feitas,
  // o que o cliente respondeu, em que estágio do funil está, e adaptar a
  // próxima mensagem com naturalidade. Mensagens são truncadas no fim do
  // total (mantém as mais recentes).
  const { data } = await supabase
    .from("chats_dashboard")
    .select("content, is_from_me, created_at")
    .eq("remote_jid", remoteJid)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!data || data.length === 0) return "(sem histórico — este é o primeiro contato)";
  return data
    .reverse()
    .map((m) => `[${new Date(m.created_at).toLocaleString("pt-BR")}] ${m.is_from_me ? "SDR" : "CLIENTE"}: ${m.content || "(mensagem sem texto)"}`)
    .join("\n");
}

/**
 * Move o lead para "sem_interesse" no CRM após esgotar follow-ups sem resposta.
 */
async function moveLeadExhausted(opts: {
  remoteJid: string;
  clientId: string;
  attempts: number;
  campaignName: string;
}) {
  const motivo = `Fiz ${opts.attempts} follow-up${opts.attempts === 1 ? "" : "s"} e 0 resposta. Campanha: "${opts.campaignName}".`;
  const resumo = `Cliente não respondeu após ${opts.attempts} tentativa${opts.attempts === 1 ? "" : "s"} de reengajamento.`;

  const { data: lead } = await supabase
    .from("leads_extraidos")
    .select("id, status")
    .eq("remoteJid", opts.remoteJid)
    .eq("client_id", opts.clientId)
    .maybeSingle();

  const nowIso = new Date().toISOString();

  if (lead) {
    // Só rebaixa para sem_interesse; estados terminais já setados também são mantidos
    if (lead.status !== "fechado" && lead.status !== "sem_interesse" && lead.status !== "descartado") {
      await supabase
        .from("leads_extraidos")
        .update({
          status: "sem_interesse",
          justificativa_ia: motivo,
          resumo_ia: resumo,
          ia_last_analyzed_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", lead.id)
        .eq("client_id", opts.clientId);

      await supabase.from("historico_ia_leads").insert({
        client_id: opts.clientId,
        remote_jid: opts.remoteJid,
        nome_negocio: null,
        status_antigo: lead.status || "nenhum",
        status_novo: "sem_interesse",
        razao: motivo,
        resumo,
        batch_id: `followup-exhausted-${Date.now()}`,
      });
    }
  }
}

/**
 * Quando o cliente respondeu, promove o lead para "interessado" (se ainda não
 * estiver num estágio mais alto).
 */
async function moveLeadResponded(remoteJid: string, clientId: string) {
  const { data: lead } = await supabase
    .from("leads_extraidos")
    .select("id, status")
    .eq("remoteJid", remoteJid)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!lead) return;

  const ordered = ["novo", "primeiro_contato", "interessado", "follow-up", "agendado", "fechado"];
  const atual = ordered.indexOf(lead.status || "novo");
  const alvo = ordered.indexOf("interessado");
  const isTerminal = ["sem_interesse", "descartado"].includes(lead.status || "");
  if (!isTerminal && atual < alvo) {
    await supabase
      .from("leads_extraidos")
      .update({ status: "interessado", updated_at: new Date().toISOString() })
      .eq("id", lead.id)
      .eq("client_id", clientId);
  }
}

// ============================================================
// IA: reescreve a mensagem com base no histórico + prompt custom
// ============================================================

export async function personalizeFollowupWithAI(opts: {
  baseMessage: string;
  customPrompt: string;
  model: string;
  nome_empresa: string;
  ramo: string;
  history: string;
  apiKey?: string | null;
  stepNumber: number;
  campaignId?: string;
  campaignName?: string;
  clientId: string;
  /** remoteJid pra puxar o briefing IA cacheado (lead-intelligence). */
  remoteJid?: string;
}): Promise<string> {
  const { resolveModel } = await import("@/lib/ai-default-model");
  const modelId = await resolveModel(opts.model);
  if (!modelId) throw new Error("Modelo IA não configurado pelo admin");

  // Briefing cacheado entra antes das instruções pra IA.
  let intelContext = "";
  if (opts.remoteJid) {
    try {
      const { getCachedIntelligence, intelligenceToPromptContext } = await import("@/lib/lead-intelligence");
      const intel = await getCachedIntelligence(opts.remoteJid, opts.clientId);
      if (intel) intelContext = intelligenceToPromptContext(intel) + "\n\n";
    } catch {}
  }

  const prompt = `${opts.customPrompt || "Você é um SDR profissional e cordial que faz follow-up de forma natural, sem ser insistente."}

${intelContext}`;
  const fullPrompt = prompt + `

# DADOS DO LEAD
- Empresa: ${opts.nome_empresa || "(desconhecida)"}
- Ramo: ${opts.ramo || "(desconhecido)"}
- Este é o follow-up número ${opts.stepNumber}.

# HISTÓRICO COMPLETO DA CONVERSA (antigo → recente)
${opts.history}

# MENSAGEM-BASE (escrita pelo operador — adapte mas não copie literal)
"""
${opts.baseMessage}
"""

# COMO ANALISAR A CONVERSA ANTES DE GERAR A MENSAGEM

Antes de escrever, faça essa análise mental (não devolva, é só pra você):

1. **Estágio do lead** — onde a conversa parou? (sem resposta / interesse vago / pediu detalhes / pediu preço / disse "depois entro em contato" / pediu pra parar / agendou / silenciou após detalhes).
2. **Última coisa que o CLIENTE disse** — exata. É a base do gancho.
3. **Quantas vezes o SDR já tentou** sem resposta? Se >2 silêncios consecutivos, tom mais leve / "sem problema se não fizer sentido agora".
4. **Promessas/combinados** já feitos pelo SDR (ex: "te envio amanhã", "te ligo segunda"). Cumpra ou refira-se a eles.
5. **Sinais de saturação** — palavras tipo "obrigado", "depois vejo", "já temos" → sugerem espaçar / fechar elegantemente.
6. **Sinais de interesse latente** — "manda a tabela", "me liga", "qual valor" → vire o foco pra ação concreta.

# REGRAS DE GERAÇÃO

- UMA mensagem curta em PT-BR (até 3 frases, idealmente 1-2).
- NUNCA repita exatamente o que o SDR já escreveu antes.
- Puxe gancho do que o CLIENTE disse por último, se houver.
- Tom humano, sem clichês de vendedor agressivo. Sem "espero que esteja tudo bem".
- Se cliente já pediu pra parar / não tem interesse → escreva algo que ENCERRE com classe ("entendido, fico à disposição se mudar de ideia") em vez de mais um pitch.
- Sem emojis exagerados (no máx 1 emoji se fizer sentido).
- NÃO invente dados (preço, prazo, condições) que não estão no histórico.
- Devolva APENAS a mensagem final. Sem aspas, sem markdown, sem explicação, sem rótulo.`;

  // thinkingBudget=0: geração one-shot de follow-up não precisa de raciocínio
  // em cadeia (cobrado como saída). Economiza tokens sem perder qualidade.
  // Roteia Gemini OU OpenRouter conforme o modelo escolhido (modelRef).
  const { generateText, providerOf } = await import("@/lib/ai-provider");
  const { getAiKeys } = await import("@/lib/ai-keys");
  const keys = await getAiKeys();
  const out = await generateText({
    modelRef: modelId,
    prompt: fullPrompt,
    temperature: 0.6,
    thinkingBudget: 0,
    geminiApiKey: opts.apiKey || keys.gemini,
    openrouterApiKey: keys.openrouter,
  });

  logTokenUsage({
    source: "followup",
    sourceId: opts.campaignId || null,
    sourceLabel: opts.campaignName || "Follow-up",
    model: out.modelUsed,
    provider: providerOf(modelId) === "openrouter" ? "OpenRouter" : "Gemini",
    promptTokens: out.usage.promptTokens,
    completionTokens: out.usage.completionTokens,
    totalTokens: out.usage.totalTokens,
    clientId: opts.clientId,
    metadata: { stepNumber: opts.stepNumber, nome_empresa: opts.nome_empresa },
  });

  return out.text.replace(/^["']|["']$/g, "");
}

// ============================================================
// Core: processa um target
// ============================================================

async function processTarget(
  camp: FollowupCampaign,
  target: FollowupTarget,
  apiKey: string | null
): Promise<"sent" | "responded" | "exhausted" | "failed" | "skipped"> {
  const nomeLead = target.nome_negocio || target.remote_jid.split("@")[0];

  // 1. Cliente respondeu? Se sim, encerra follow-up.
  if (target.last_sent_at) {
    const responded = await clientRespondedSince(target.remote_jid, target.last_sent_at, camp.client_id);
    if (responded) {
      await supabase
        .from("followup_targets")
        .update({ status: "responded", updated_at: new Date().toISOString() })
        .eq("id", target.id)
        .eq("client_id", camp.client_id);
      await moveLeadResponded(target.remote_jid, camp.client_id);
      await supabase
        .from("followup_campaigns")
        .update({ total_responded: (await countByStatus(camp.id, camp.client_id, "responded")) })
        .eq("id", camp.id)
        .eq("client_id", camp.client_id);
      await addFollowupLog(camp.id, camp.client_id, `🎉 ${nomeLead} RESPONDEU ao follow-up — lead movido p/ "interessado" no CRM.`, "success");
      return "responded";
    }
  }

  // 2. Tem próximo step?
  const step = camp.steps[target.current_step];
  if (!step) {
    // Esgotou follow-ups
    await supabase
      .from("followup_targets")
      .update({ status: "exhausted", updated_at: new Date().toISOString() })
      .eq("id", target.id)
      .eq("client_id", camp.client_id);
    await moveLeadExhausted({
      remoteJid: target.remote_jid,
      clientId: camp.client_id,
      attempts: target.current_step,
      campaignName: camp.name,
    });
    await supabase
      .from("followup_campaigns")
      .update({ total_exhausted: (await countByStatus(camp.id, camp.client_id, "exhausted")) })
      .eq("id", camp.id)
      .eq("client_id", camp.client_id);
    await addFollowupLog(camp.id, camp.client_id, `⊘ ${nomeLead} ESGOTADO — ${target.current_step} follow-ups sem resposta → CRM "sem_interesse".`, "warning");
    return "exhausted";
  }

  await addFollowupLog(camp.id, camp.client_id, `Processando ${nomeLead} — step ${target.current_step + 1}/${camp.steps.length}...`, "info");

  // Busca o lead completo no CRM pra abastecer TODAS as variáveis do template
  // ({{endereco}}, {{website}}, {{avaliacao}}, {{ramo}}, etc) — não só o nome.
  // resumo_avaliacoes é coluna da migração reviews_ai.sql — PGRST204 cai no
  // retry sem ela (variável fica vazia, resto intacto).
  let leadFull: any = null;
  {
    const cols = "nome_negocio, ramo_negocio, telefone, endereco, website, instagram, facebook, avaliacao, reviews, status, categoria, resumo_avaliacoes";
    let res = await supabase.from("leads_extraidos").select(cols).eq("remoteJid", target.remote_jid).eq("client_id", camp.client_id).maybeSingle();
    if (res.error && res.error.code === "PGRST204") {
      res = await supabase
        .from("leads_extraidos")
        .select(cols.replace(", resumo_avaliacoes", ""))
        .eq("remoteJid", target.remote_jid)
        .eq("client_id", camp.client_id)
        .maybeSingle();
    }
    leadFull = res.data || null;
  }

  // push_name do contato — vem da tabela contacts (nome do WhatsApp). Necessário
  // pra resolver {{nome}} e {{push_name}} corretamente no follow-up.
  let pushName: string | null = null;
  if (target.remote_jid) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("push_name")
      .eq("remote_jid", target.remote_jid)
      .eq("client_id", camp.client_id)
      .maybeSingle();
    pushName = (contact as any)?.push_name || null;
  }

  // Contexto de render — usado no template AGORA e DE NOVO depois da IA
  // (rede de segurança: nenhuma {{variavel}} ou {variavel} pode chegar ao cliente).
  const renderCtx = {
    remoteJid:    target.remote_jid,
    nome_negocio: leadFull?.nome_negocio || target.nome_negocio,
    ramo_negocio: leadFull?.ramo_negocio || target.ramo_negocio,
    push_name:    pushName,
    telefone:     leadFull?.telefone || null,
    endereco:     leadFull?.endereco || null,
    website:      leadFull?.website || null,
    instagram:    leadFull?.instagram || null,
    facebook:     leadFull?.facebook || null,
    avaliacao:    leadFull?.avaliacao ?? null,
    reviews:      leadFull?.reviews ?? null,
    status:       leadFull?.status || null,
    categoria:    (leadFull as any)?.categoria || null,
    resumo_avaliacoes: (leadFull as any)?.resumo_avaliacoes || null,
  };

  // 3. Renderiza template
  let text = renderTemplate(step.template, renderCtx);
  let aiInputText: string | null = null;

  // 4. Passa pela IA se habilitado. (Não exige mais a chave Gemini aqui — o
  //    modelo pode ser OpenRouter; personalizeFollowupWithAI resolve a chave
  //    certa pelo provedor e, se faltar, o catch abaixo cai na mensagem-base.)
  if (camp.ai_enabled && camp.ai_model) {
    aiInputText = text;
    try {
      await addFollowupLog(camp.id, camp.client_id, `Personalizando mensagem com IA para ${nomeLead}...`, "info");
      const history = await getConversationHistory(target.remote_jid, camp.client_id, 20);
      const ai = await personalizeFollowupWithAI({
        baseMessage: text,
        customPrompt: camp.ai_prompt ? renderTemplate(camp.ai_prompt, renderCtx) : "",
        model: camp.ai_model,
        nome_empresa: target.nome_negocio || "",
        ramo: target.ramo_negocio || "",
        history,
        apiKey,
        stepNumber: target.current_step + 1,
        campaignId: camp.id,
        campaignName: camp.name,
        clientId: camp.client_id,
        remoteJid: target.remote_jid,  // ← injeta briefing
      });
      if (ai && ai.trim()) {
        text = ai.trim();
        await addFollowupLog(camp.id, camp.client_id, `IA gerou: "${text.slice(0, 140)}${text.length > 140 ? "…" : ""}"`, "success");
      }
    } catch (e: any) {
      console.warn(`[FOLLOWUP ${camp.name}] IA falhou, usando template: ${e.message}`);
      await addFollowupLog(camp.id, camp.client_id, `IA falhou (${e.message}). Enviando template cru.`, "warning");
    }
  }

  // REDE DE SEGURANÇA — render final. Se a IA deixou/reintroduziu qualquer
  // {{variavel}} ou {variavel}, resolve agora. O cliente NUNCA pode receber chaves cruas.
  text = renderTemplate(text, renderCtx);
  // BLINDAGEM FINAL — a IA, ao reescrever, às vezes "generaliza" o texto e
  // RE-INTRODUZ {{saudacao}}/{{nome_empresa}} como se montasse um template.
  // Aqui, qualquer {{...}} ou {...} que ainda reste (variável desconhecida)
  // é REMOVIDA. O cliente JAMAIS pode receber chaves cruas no WhatsApp.
  if (/\{\{.*?\}\}|\{.*?\}/.test(text)) {
    await addFollowupLog(camp.id, camp.client_id,
      `⚠️ A mensagem de follow-up continha variável {{...}} ou {...} não preenchida — removida automaticamente antes do envio.`, "warning");
    text = text
      .replace(/\{\{\s*[\w-]+\s*\}\}/g, "")  // remove {{var}} ou {{var-name}}
      .replace(/\{\s*[\w-]+\s*\}/g, "")    // remove {var} ou {var-name}
      .replace(/[ \t]{2,}/g, " ")            // colapsa espaços duplos
      .replace(/\s+([.,!?])/g, "$1")         // tira espaço antes de pontuação
      .trim();
  }

  // 5. Envia via Evolution
  try {
    // Picota a mensagem em chunks se humanize_messages estiver ativo
    // (mesma lógica do campaign-worker e agente de IA).
    const chunks = camp.humanize_messages ? splitMessage(text) : [text];
    if (chunks.length === 0) chunks.push(text);
    let msgId: string = `followup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Sessão criada uma vez e reusada em todos os chunks.
    const sess = await findOrCreateContactSession(
      camp.client_id,
      target.remote_jid,
      camp.instance_name,
      target.nome_negocio
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      if (!chunkText) continue;

      // Delay de digitação entre chunks (2 a 5s) — pula no primeiro.
      if (i > 0) {
        const typingSeconds = Math.min(Math.max(chunkText.length / 15, 2), 5);
        await new Promise((r) => setTimeout(r, typingSeconds * 1000));
      }

      registerPendingAutomatedSend(camp.instance_name, target.remote_jid, chunkText);
      const result = await channel.sendMessage(target.remote_jid, chunkText, camp.instance_name);
      if (!result || result.ok === false) {
        throw new Error(result?.error || "Provider recusou o envio do follow-up");
      }

      // Persiste cada chunk no chat (pra IA ter contexto de todas as partes).
      const chunkMsgId = (result as any)?.messageId || (result as any)?.key?.id || (result as any)?.data?.key?.id || `followup-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      msgId = chunkMsgId;
      try {
        await persistOutgoingMessage({
          sessionId: sess?.sessionId || null,
          remoteJid: target.remote_jid,
          instanceName: camp.instance_name,
          msgId: chunkMsgId,
          text: chunkText,
          clientId: camp.client_id,
        });
      } catch (persistErr: any) {
        const m = `⚠ Follow-up enviado no WhatsApp mas falhou ao salvar no chats_dashboard: ${persistErr?.message}.`;
        console.warn(`[FOLLOWUP ${camp.name}] ${m}`);
        await addFollowupLog(camp.id, camp.client_id, m, "warning");
      }
    }

    // ── Mídia anexa (apenas no último step) ──
    const isLastStep = !camp.steps[target.current_step + 1];
    if (isLastStep && camp.media_url && camp.media_type) {
      try {
        await new Promise((r) => setTimeout(r, 1500));
        const mediaResult = await channel.sendMedia(
          target.remote_jid,
          camp.media_caption || "",
          {
            type: camp.media_type as "image" | "video" | "audio" | "document",
            mediaUrl: camp.media_url,
            fileName: camp.media_file_name || undefined,
            mimetype: camp.media_mimetype || undefined,
          },
          camp.instance_name,
        );
        if (!mediaResult || mediaResult.ok === false) {
          throw new Error(mediaResult?.error || "Provider recusou o envio da mídia");
        }
        const mediaMsgId = (mediaResult as any)?.messageId || (mediaResult as any)?.key?.id || `media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await addFollowupLog(camp.id, camp.client_id, `📎 Mídia enviada → ${target.nome_negocio || target.remote_jid}`, "info");
        try {
          await persistOutgoingMessage({
            sessionId: sess?.sessionId || null,
            remoteJid: target.remote_jid,
            instanceName: camp.instance_name,
            msgId: mediaMsgId,
            text: camp.media_caption || "",
            clientId: camp.client_id,
          });
        } catch { /* best-effort */ }
      } catch (mediaErr: any) {
        console.warn(`[FOLLOWUP ${camp.name}] Mídia falhou: ${mediaErr?.message}`);
        await addFollowupLog(camp.id, camp.client_id, `⚠ Mídia falhou: ${mediaErr?.message}`, "warning");
      }
    }

    const nextStep = target.current_step + 1;
    const hasMore = !!camp.steps[nextStep];
    const nowIso = new Date().toISOString();
    // Quantos dias esperar antes do próximo tick:
    //   - Se tem próximo step: usa day_offset do próximo
    //   - Se foi o último envio: espera o day_offset do step que acabou de ser enviado
    //     (dar ao cliente tempo de responder antes de marcar exhausted)
    const daysToWait = hasMore
      ? Math.max(1, camp.steps[nextStep].day_offset)
      : Math.max(1, step.day_offset ?? 3);
    const nextSendAt = new Date(Date.now() + daysToWait * 24 * 60 * 60 * 1000).toISOString();

    const updatePayload: Record<string, any> = {
      current_step: nextStep,
      last_sent_at: nowIso,
      next_send_at: nextSendAt,
      status: "waiting",
      last_message_id: msgId,
      last_rendered: text,
      error_message: null,
      updated_at: nowIso,
    };
    if (aiInputText) updatePayload.ai_input = aiInputText;
    const targetScope = {
      id: target.id,
      client_id: camp.client_id,
      current_step: target.current_step,
      status: "processing",
    };
    let upd = await supabase
      .from("followup_targets")
      .update(updatePayload)
      .eq("id", targetScope.id)
      .eq("client_id", targetScope.client_id)
      .eq("current_step", targetScope.current_step)
      .eq("status", targetScope.status);
    if (upd.error && (upd.error as any).code === "PGRST204" && "ai_input" in updatePayload) {
      delete updatePayload.ai_input;
      upd = await supabase
        .from("followup_targets")
        .update(updatePayload)
        .eq("id", targetScope.id)
        .eq("client_id", targetScope.client_id)
        .eq("current_step", targetScope.current_step)
        .eq("status", targetScope.status);
    }
    if (upd.error) {
      console.error(`[FOLLOWUP] falha ao persistir avanço do target ${target.id}:`, upd.error.message);
      return "failed";
    }

    await supabase
      .from("followup_campaigns")
      .update({ total_sent: (await countSentTotal(camp.id, camp.client_id)) })
      .eq("id", camp.id)
      .eq("client_id", camp.client_id);

    // Mantém o lead em "follow-up" no CRM e deixa um rastro no histórico (pra quem
    // olha o kanban ver "1 follow-up feito agora"). Só mexe se estiver em estados
    // anteriores ou no próprio follow-up.
    try {
      const nowIso2 = nowIso;
      const { data: lead } = await supabase
        .from("leads_extraidos")
        .select("id, status")
        .eq("remoteJid", target.remote_jid)
        .eq("client_id", camp.client_id)
        .maybeSingle();
      if (lead) {
        const orderRank: Record<string, number> = {
          "": 0, "novo": 0, "primeiro_contato": 1, "interessado": 2, "follow-up": 3, "agendado": 4, "fechado": 5,
        };
        const cur = orderRank[lead.status || ""] ?? 0;
        const isTerminal = ["sem_interesse", "descartado"].includes(lead.status || "");
        if (!isTerminal && cur <= 3) {
          await supabase.from("leads_extraidos").update({
            status: "follow-up",
            resumo_ia: `Follow-up ${nextStep}/${camp.steps.length} enviado agora ("${camp.name}"). Aguardando resposta do cliente.`,
            ia_last_analyzed_at: nowIso2,
            updated_at: nowIso2,
          }).eq("id", lead.id).eq("client_id", camp.client_id);
        }
      }
      await supabase.from("historico_ia_leads").insert({
        client_id: camp.client_id,
        remote_jid: target.remote_jid,
        nome_negocio: target.nome_negocio,
        status_antigo: "follow-up",
        status_novo: "follow-up",
        razao: `Follow-up step ${nextStep}/${camp.steps.length} enviado via campanha "${camp.name}".`,
        resumo: `Mensagem enviada (${aiInputText ? "IA" : "template"}): "${text.slice(0, 180)}${text.length > 180 ? "…" : ""}"`,
        batch_id: `followup-${camp.id}`,
      });
    } catch (leadErr: any) {
      console.warn(`[FOLLOWUP ${camp.name}] atualização do kanban falhou: ${leadErr?.message}`);
    }

    console.log(`[FOLLOWUP ${camp.name}] ✓ Step ${nextStep} → ${target.remote_jid}`);
    // Inclui a MENSAGEM REAL enviada (truncada). Operador precisa ver o conteúdo.
    const fuPreview = String(text || "").replace(/\s+/g, " ").slice(0, 240);
    await addFollowupLog(
      camp.id,
      camp.client_id,
      `✓ Follow-up ${nextStep}/${camp.steps.length} → ${nomeLead}\n📨 "${fuPreview}${(text || "").length > 240 ? "…" : ""}"\nPróximo: ${new Date(nextSendAt).toLocaleDateString("pt-BR")}`,
      "success",
    );
    return "sent";
  } catch (err: any) {
    await supabase
      .from("followup_targets")
      .update({
        status: "failed",
        error_message: String(err?.message || err).slice(0, 300),
        updated_at: new Date().toISOString(),
      })
      .eq("id", target.id)
      .eq("client_id", camp.client_id);
    console.error(`[FOLLOWUP ${camp.name}] ✗ ${target.remote_jid}: ${err?.message || err}`);
    await addFollowupLog(camp.id, camp.client_id, `✗ Falha ao enviar p/ ${nomeLead}: ${err?.message || err}`, "error");
    return "failed";
  }
}

async function countByStatus(campaignId: string, clientId: string, status: string): Promise<number> {
  const { count } = await supabase
    .from("followup_targets")
    .select("*", { count: "exact", head: true })
    .eq("followup_campaign_id", campaignId)
    .eq("client_id", clientId)
    .eq("status", status);
  return count || 0;
}

async function countSentTotal(campaignId: string, clientId: string): Promise<number> {
  // Sent total = soma dos current_step de todos os targets (cada step == 1 envio feito)
  const { data } = await supabase
    .from("followup_targets")
    .select("current_step")
    .eq("followup_campaign_id", campaignId)
    .eq("client_id", clientId);
  if (!data) return 0;
  return data.reduce((acc, t: any) => acc + (t.current_step || 0), 0);
}

// ============================================================
// tickCampaign: processa todos os targets elegíveis de uma campanha
// ============================================================

export async function tickCampaign(campaignId: string, clientId: string): Promise<{
  ok: boolean;
  processed: number;
  error?: string;
}> {
  if (!clientId?.trim()) return { ok: false, processed: 0, error: "clientId é obrigatório" };
  const camp = await loadCampaign(campaignId, clientId);
  if (!camp) return { ok: false, processed: 0, error: "Campanha não encontrada" };
  if (camp.status !== "active" && camp.status !== "draft") {
    return { ok: false, processed: 0, error: `Campanha está ${camp.status}` };
  }
  if (!(await isInstanceOwnedByClient(camp.instance_name, camp.client_id))) {
    const error = `Instância "${camp.instance_name}" não pertence ao cliente da campanha`;
    await addFollowupLog(camp.id, camp.client_id, error, "error");
    await supabase.from("followup_campaigns").update({ status: "paused" }).eq("id", camp.id).eq("client_id", camp.client_id);
    return { ok: false, processed: 0, error };
  }
  if (!isWithinHourWindow(camp.allowed_start_hour, camp.allowed_end_hour)) {
    return { ok: false, processed: 0, error: "Fora da janela permitida" };
  }

  const apiKey = camp.ai_enabled ? await getApiKey() : null;

  // Targets elegíveis: status IN (pending, waiting, failed) AND (next_send_at IS NULL OR next_send_at <= now)
  const nowIso = new Date().toISOString();
  const { data: targets } = await supabase
    .from("followup_targets")
    .select("*")
    .eq("followup_campaign_id", campaignId)
    .eq("client_id", clientId)
    .in("status", ["pending", "waiting", "failed"])
    .or(`next_send_at.is.null,next_send_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(200);

  if (!targets || targets.length === 0) {
    return { ok: true, processed: 0 };
  }

  let processed = 0;
  for (const t of targets as FollowupTarget[]) {
    // Janela pode fechar no meio; re-checa antes de cada envio
    if (!isWithinHourWindow(camp.allowed_start_hour, camp.allowed_end_hour)) break;

    // CLAIM ATÔMICO: vira o status pra "processing" só se ainda estiver elegível.
    // Se 2 ticks rodam concorrentes (ou 2 instâncias), só uma vence o UPDATE.
    // O .select() retorna a linha SE conseguiu atualizar, senão data=[].
    const claim = await supabase
      .from("followup_targets")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", t.id)
      .eq("client_id", clientId)
      .eq("current_step", t.current_step)
      .eq("status", t.status) // CAS: outro ciclo pode ter avançado/pulado depois do SELECT inicial
      .in("status", ["pending", "waiting", "failed"])
      .select("id")
      .maybeSingle();
    if (!claim.data) {
      // Outro tick já pegou esse target — pula sem incrementar processed
      continue;
    }

    const claimedStep = t.current_step;
    let r: string | null = null;
    try {
      r = await processTarget(camp, t, apiKey);
    } catch (err: any) {
      // processTarget jogou exception — destrava o claim pra não ficar "processing" eterno.
      console.error(`[FOLLOWUP] processTarget exception (target ${t.id}):`, err?.message);
      await supabase
        .from("followup_targets")
        .update({ status: "failed", last_error: err?.message?.slice(0, 500) || "exception", updated_at: new Date().toISOString() })
        .eq("id", t.id)
        .eq("client_id", clientId)
        .eq("status", "processing");
      r = "failed";
    }

    // Confirma posse depois do processamento, antes de contar/agendar o próximo.
    // Se recovery/outro ciclo reassumiu, este resultado é descartado — não se
    // conta como processado nem se sobrescreve o novo estado.
    const { data: stillOwned } = await supabase
      .from("followup_targets")
      .select("id, status, current_step")
      .eq("id", t.id)
      .eq("client_id", clientId)
      .maybeSingle();
    if (!stillOwned) {
      console.warn(`[FOLLOWUP] target ${t.id} desapareceu durante o processamento — resultado descartado.`);
      continue;
    }
    if (r === "sent" && !(stillOwned.status === "waiting" && stillOwned.current_step === claimedStep + 1)) {
      console.warn(`[FOLLOWUP] target ${t.id} mudou de dono durante o envio — resultado desta execução descartado.`);
      continue;
    }
    if (r === "sent" || r === "failed") {
      processed++;
      const wait = jitterMs(camp.min_interval_seconds, camp.max_interval_seconds);
      await new Promise((res) => setTimeout(res, wait));
    } else {
      // responded/exhausted/skipped — sem envio, sem jitter
      processed++;
    }
  }

  await supabase
    .from("followup_campaigns")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("client_id", clientId);

  return { ok: true, processed };
}

/**
 * Enroll: adiciona leads em follow-up como targets de uma campanha.
 * Usa upsert para não duplicar.
 */
export async function enrollLeads(opts: {
  campaignId: string;
  leadIds: number[];
  clientId: string;
}): Promise<{ ok: boolean; enrolled: number; error?: string }> {
  const { leadIds, campaignId, clientId } = opts;
  if (!clientId?.trim()) return { ok: false, enrolled: 0, error: "clientId é obrigatório" };

  const { data: campaign } = await supabase
    .from("followup_campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!campaign) return { ok: false, enrolled: 0, error: "Campanha não encontrada" };
  if (leadIds.length === 0) return { ok: true, enrolled: 0 };

  const { data: leads, error } = await supabase
    .from("leads_extraidos")
    .select("id, remoteJid, nome_negocio, ramo_negocio")
    .eq("client_id", clientId)
    .in("id", leadIds);
  if (error) return { ok: false, enrolled: 0, error: error.message };

  const rows = (leads || [])
    .filter((l: any) => l.remoteJid)
    .map((l: any) => ({
      followup_campaign_id: campaignId,
      client_id: clientId,
      lead_id: l.id,
      remote_jid: l.remoteJid,
      nome_negocio: l.nome_negocio,
      ramo_negocio: l.ramo_negocio,
      current_step: 0,
      next_send_at: new Date().toISOString(), // elegível imediatamente
      status: "pending",
    }));

  if (rows.length === 0) return { ok: true, enrolled: 0 };

  const { error: upErr } = await supabase
    .from("followup_targets")
    .upsert(rows, { onConflict: "followup_campaign_id,remote_jid", ignoreDuplicates: true });
  if (upErr) return { ok: false, enrolled: 0, error: upErr.message };

  // Recount
  const { count } = await supabase
    .from("followup_targets")
    .select("*", { count: "exact", head: true })
    .eq("followup_campaign_id", campaignId)
    .eq("client_id", clientId);
  await supabase
    .from("followup_campaigns")
    .update({ total_enrolled: count || 0, updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("client_id", clientId);

  return { ok: true, enrolled: rows.length };
}

/**
 * Tick global: roda uma vez, processa todas as campanhas active+auto_execute.
 * Chamado pelo scheduler.
 */
export async function tickAllAutoCampaigns(): Promise<number> {
  const { data: camps } = await supabase
    .from("followup_campaigns")
    .select("id, client_id")
    .eq("status", "active")
    .eq("auto_execute", true);
  if (!camps || camps.length === 0) return 0;

  let total = 0;
  for (const c of camps) {
    try {
      const r = await tickCampaign(c.id, c.client_id);
      total += r.processed;
    } catch (e: any) {
      console.error(`[FOLLOWUP TICK-ALL] Campanha ${c.id} falhou:`, e.message);
    }
  }
  return total;
}
