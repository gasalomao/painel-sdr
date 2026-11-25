/**
 * Guardas determinísticas (0 tokens) para proteger o agente contra:
 * 1. Loops de URA / robôs automáticos do destinatário;
 * 2. Reinício da prospecção após despedida ou recusa clara do lead.
 */

export interface GuardHistoryMessage {
  role?: string | null;
  sender?: string | null;
  sender_type?: string | null;
  content?: string | null;
  message_id?: string | null;
}

export interface LoopDetectionResult {
  isLoop: boolean;
  reason: "ura_or_auto_reply_repeated" | "identical_customer_message_loop" | null;
}

export interface ClosingPauseResult {
  shouldPause: boolean;
  reason: "explicit_closing" | "customer_refusal_closing" | null;
}

const URA_MENU_OR_ERROR_REGEX =
  /(?:n[aã]o entendemos sua mensagem|op[cç][aã]o inv[aá]lida|digite (?:uma )?op[cç][aã]o v[aá]lida|escolha uma das (?:seguintes )?op[cç][oõ]es|selecione uma das op[cç][oõ]es|menu principal|voltar ao menu|para alterar seu nome|digite\s*[*#]?[a-z0-9]{2,}|(?:^|\n)\s*[?•]?\s*\*?seu\s+(?:id|protocolo|c[oó]digo)\s*:?\*?\s*\S+|(?:^|\n)\s*\*?[1-9]\*?\s*[-–.)]\s*\S+[\s\S]*\n\s*\*?[2-9]\*?\s*[-–.)]\s*\S+)/i;

const AUTO_REPLY_GREETING_REGEX =
  /(?:seja bem[- ]?vind[oa]|agradece(?:mos)? (?:o )?seu contato|nossa equipe (?:j[aá] )?vai (?:lhe |te )?atender|em breve (?:um de nossos|algu[eé]m|nossa equipe)|aguarde.{0,30}(?:atendido|momento)|fora do (?:nosso )?hor[aá]rio de atendimento|atendimento autom[aá]tico|assistente virtual|chatbot|recebemos sua mensagem)/i;

const EXPLICIT_CLOSING_PHRASE_REGEX =
  /(?:respeit(?:o|amos) (?:totalmente )?sua decis[aã]o|n[aã]o (?:te |lhe |vamos )?incomod(?:o|ar|aremos) mais|a gente para por aqui|encerr(?:o|amos)(?: o contato| o atendimento| a conversa)? por aqui|muito sucesso(?: para| pra)? voc[eê]s?|sucesso (?:nos neg[oó]cios|(?:para|pra) voc[eê]s?)|desculp[ae] (?:qualquer |o )?inc[oô]modo|remov(?:i|emos|endo) (?:o )?seu (?:contato|n[uú]mero))/i;

const CUSTOMER_REFUSAL_REGEX =
  /(?:^|\b)(?:n[aã]o[,.\s!]*(?:tenho interesse|me interesso|quero|precis[ao]|obrigad[oa]|valeu)|sem interesse|agora n[aã]o|no momento n[aã]o|j[aá] temos (?:um )?site|pode (?:tirar|remover|parar)|pare de (?:mandar|enviar)|n[aã]o (?:me )?(?:mande|envie|chame) mais|n[aã]o obrigad[oa])(?:\b|$)/i;

/**
 * Pedido explícito de saída / bloqueio (Anti-Denúncia + LGPD).
 * Mais estrito que CUSTOMER_REFUSAL_REGEX: não marca opt-out permanente em objeções
 * brandas como "agora não" ou "já temos site", evitando perder leads recuperáveis.
 */
const EXPLICIT_OPT_OUT_REGEX =
  /(?:^|\b)(?:par[ae]\s+de\s+(?:mandar|enviar|chamar)|n[aã]o\s+(?:me\s+)?(?:mande|envie|chame)\s*mais|n[aã]o\s+(?:quero|desejo)\s+(?:mais\s+)?receber|tir[ae]\s+(?:meu\s+)?(?:n[uú]mero|contato)|remov[ae]\s+(?:meu\s+)?(?:n[uú]mero|contato)|descadastr\w*|sair\s+da\s+lista|opt[- ]?out|n[uú]mero\s+bloqueado|vou\s+(?:te\s+)?bloquear|para\s+com\s+isso|sem\s+interesse\s+algum)(?:\b|$)/i;

export function isExplicitOptOutRequest(text: string): boolean {
  const clean = (text || "").trim();
  if (!clean) return false;
  return EXPLICIT_OPT_OUT_REGEX.test(clean);
}

const POLITE_FAREWELL_REGEX =
  /(?:agrade[cç]o(?: a aten[cç][aã]o)?|combinado|entendido|compreendo|fico [àa] disposi[cç][aã]o|se precisar (?:no futuro|de algo)|tenha um (?:[oó]timo|bom|excelente) (?:dia|restante|fim de semana)|at[eé] mais|tudo de bom|sucesso)/i;

function normalizeForComparison(raw: string): string {
  return (raw || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(?:seu\s+id|id|protocolo|chamado|ticket)[:\s*#-]*\d{3,}\b/gi, "#id")
    .replace(/\s+/g, " ")
    .trim();
}

function isCustomerEntry(msg: GuardHistoryMessage): boolean {
  if (msg.role === "user") return true;
  if (msg.role === "model" || msg.role === "assistant") return false;
  const sender = (msg.sender_type || msg.sender || "").toLowerCase();
  return sender === "customer";
}

function isAgentOrOutboundEntry(msg: GuardHistoryMessage): boolean {
  if (msg.role === "model" || msg.role === "assistant" || msg.role === "agent") return true;
  const sender = (msg.sender_type || msg.sender || "").toLowerCase();
  return sender === "ai" || sender === "human";
}

function extractBlocks(text: string): string[] {
  const blocks = new Set<string>();
  const full = normalizeForComparison(text);
  if (full.length >= 15) blocks.add(full);

  for (const part of text.split(/\n{2,}|\n/)) {
    const norm = normalizeForComparison(part);
    if (norm.length >= 15) blocks.add(norm);
  }
  return Array.from(blocks);
}

/**
 * Detecta quando a conversa entrou em loop com URA / menu numérico / resposta
 * automática repetitiva do destinatário após já ter recebido resposta da IA.
 */
export function detectBotOrUraLoop(params: {
  currentText: string;
  history: GuardHistoryMessage[];
  currentMessageId?: string | null;
}): LoopDetectionResult {
  const currentText = (params.currentText || "").trim();
  const history = Array.isArray(params.history) ? params.history : [];
  const currentMessageId = params.currentMessageId ? String(params.currentMessageId).trim() : "";
  if (!currentText || history.length === 0) {
    return { isLoop: false, reason: null };
  }

  const recentHistory = history.slice(-18);
  const currentIsUra = URA_MENU_OR_ERROR_REGEX.test(currentText);
  const currentIsAutoReply = currentIsUra || AUTO_REPLY_GREETING_REGEX.test(currentText);
  const currentBlocks = extractBlocks(currentText);

  let priorUraOrAutoAfterAi = 0;
  let seenOutboundYet = false;
  const blockCountsWithAiBetween = new Map<string, number>();
  const lastSeenBlockOrder = new Map<string, number>();

  for (let i = 0; i < recentHistory.length; i++) {
    const msg = recentHistory[i];
    const content = String(msg.content || "").trim();
    if (!content) continue;

    if (isAgentOrOutboundEntry(msg)) {
      seenOutboundYet = true;
      continue;
    }

    if (!isCustomerEntry(msg)) continue;
    if (currentMessageId && msg.message_id && String(msg.message_id).trim() === currentMessageId) {
      continue;
    }

    const matchesAuto = URA_MENU_OR_ERROR_REGEX.test(content) || AUTO_REPLY_GREETING_REGEX.test(content);
    // Só conta URA/auto-reply se houver resposta nossa depois (ou antes) no histórico.
    const hasAiAfter = recentHistory.slice(i + 1).some(isAgentOrOutboundEntry);
    if (matchesAuto && (seenOutboundYet || hasAiAfter)) {
      priorUraOrAutoAfterAi++;
    }

    if (hasAiAfter) {
      for (const block of extractBlocks(content)) {
        if (lastSeenBlockOrder.get(block) === i) continue;
        lastSeenBlockOrder.set(block, i);
        blockCountsWithAiBetween.set(block, (blockCountsWithAiBetween.get(block) || 0) + 1);
      }
    }
  }

  // 1. Mensagem atual é URA (erro/menu) e já houve URA/auto-saudação + interação nossa antes.
  if (currentIsUra && priorUraOrAutoAfterAi >= 1) {
    return { isLoop: true, reason: "ura_or_auto_reply_repeated" };
  }

  // 2. Mensagem atual é saudação automática idêntica repetida após resposta da IA.
  if (currentIsAutoReply && seenOutboundYet) {
    for (const block of currentBlocks) {
      if ((blockCountsWithAiBetween.get(block) || 0) >= 1) {
        return { isLoop: true, reason: "ura_or_auto_reply_repeated" };
      }
    }
  }

  // 3. Qualquer mensagem longa (>= 25 chars) repetida identicamente 3+ vezes com IA no meio.
  for (const block of currentBlocks) {
    if (block.length >= 25 && (blockCountsWithAiBetween.get(block) || 0) >= 2) {
      return { isLoop: true, reason: "identical_customer_message_loop" };
    }
  }

  return { isLoop: false, reason: null };
}

/**
 * Identifica quando a própria IA concluiu uma despedida / encerramento após recusa
 * (sem fazer nova pergunta aberta), permitindo pausar a sessão antes que uma auto-resposta
 * do WhatsApp Business reinicie o funil do zero.
 */
export function shouldAutoPauseAfterClosing(params: {
  customerText: string;
  assistantText: string;
}): ClosingPauseResult {
  const customerText = (params.customerText || "").trim();
  const assistantText = (params.assistantText || "").trim();
  if (!assistantText) return { shouldPause: false, reason: null };

  // Se a IA fez qualquer pergunta, a conversa continua ativa esperando o lead.
  if (assistantText.includes("?")) {
    return { shouldPause: false, reason: null };
  }

  if (EXPLICIT_CLOSING_PHRASE_REGEX.test(assistantText)) {
    return { shouldPause: true, reason: "explicit_closing" };
  }

  const saysMissingSite = /(?:n[aã]o temos|ainda n[aã]o tem(?:os)?)\s+site/i.test(customerText);
  if (!saysMissingSite && CUSTOMER_REFUSAL_REGEX.test(customerText) && POLITE_FAREWELL_REGEX.test(assistantText)) {
    return { shouldPause: true, reason: "customer_refusal_closing" };
  }

  return { shouldPause: false, reason: null };
}

