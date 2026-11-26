/**
 * Funções PURAS do histórico do agente — extraídas de
 * `app/api/agent/process/route.ts` para manter o handler menor e testável.
 *
 * Nada aqui acessa banco, rede ou env: entrada -> saída.
 */

export type HistoryMessage = {
  sender?: string | null;
  sender_type?: string | null;
  content?: string | null;
  message_id?: string | null;
  created_at?: string | null;
  _skip_marker?: boolean;
};

export interface DropTrailingOptions {
  currentMessageId?: string | null;
  allowTrailingOutbound?: boolean;
}

export type GeminiTurn = { role: "user" | "model"; parts: { text: string }[] };

export const HISTORY_MAX_CHARS_PER_MESSAGE = 600;

const MEDIA_BRACKET_RE = /\[IMAGEM:\s*https?:\/\/[^\s\]]+\]/gi;
const MEDIA_MARKDOWN_RE = /!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/gi;

/** Troca URLs de mídia por marcador curto. URL é ruído caro no histórico. */
export function stripMediaUrls(text: string): string {
  return text.replace(MEDIA_BRACKET_RE, "[foto enviada]").replace(MEDIA_MARKDOWN_RE, "[foto enviada]");
}

/** Corta uma mensagem individual do histórico. */
export function truncateHistoryMessage(text: string, max = HISTORY_MAX_CHARS_PER_MESSAGE): string {
  if (text.length <= max) return text;
  return `${text.substring(0, max)}... [cortado]`;
}

/**
 * Prepara o conteúdo de UMA mensagem do histórico para o prompt:
 * mídia vira marcador, texto vazio vira `[Mídia/Comando]`, excesso é cortado.
 */
export function historyMessageContent(msg: HistoryMessage): string {
  const raw = msg.content ? String(msg.content) : "[Mídia/Comando]";
  if (raw === "[Mídia/Comando]") return raw;
  return truncateHistoryMessage(stripMediaUrls(raw));
}

/** Prefixo que identifica quem falou quando não foi o cliente. */
export function senderPrefix(msg: HistoryMessage): string {
  const sender = msg.sender || msg.sender_type;
  if (sender === "human" || sender === "user_panel" || sender === "operator") {
    return "[Atendente Humano da Empresa]: ";
  }
  return "";
}

/** `customer` vira turno `user`; todo o resto vira `model`. */
export function historyRole(msg: HistoryMessage): "user" | "model" {
  const sender = msg.sender || msg.sender_type;
  return msg._skip_marker || sender !== "customer" ? "model" : "user";
}

function isOutboundSender(msg: HistoryMessage): boolean {
  const sender = String(msg.sender_type || msg.sender || "").toLowerCase();
  return sender === "ai" || sender === "human" || sender === "user_panel" || sender === "operator";
}

function matchesCustomerMessageContent(msg: HistoryMessage, current: string): boolean {
  const sender = String(msg.sender_type || msg.sender || "").toLowerCase();
  const lastContent = String(msg.content || "").trim();
  return (
    sender === "customer" &&
    lastContent.length > 0 &&
    (lastContent === current || (lastContent.length >= 2 && current.includes(lastContent)))
  );
}

/**
 * A mensagem atual já foi persistida antes deste run. Remove do fim do
 * histórico a(s) cópia(s) dela.
 *
 * Regra:
 * 1) Se `opts.currentMessageId` bater com um item `customer`, remove essa cópia exata.
 * 2) Só remove quando o conteúdo bate. Em contexto de lote (várias
 * mensagens consolidadas em `currentText`), as ocorrências finais também
 * batem e devem sair; fora de lote, remove no máximo uma.
 * 3) Quando `opts.allowTrailingOutbound` é true (ex.: disparo em 2 partes onde a
 * Parte 2 entrou logo após a auto-resposta inicial do cliente durante o buffer),
 * preserva até 3 mensagens outbound finais e remove a cópia logo antes delas.
 *
 * @returns novo array; a entrada não é mutada.
 */
export function dropTrailingCurrentMessage(
  chrono: HistoryMessage[],
  currentText: string,
  isBatch = false,
  opts?: DropTrailingOptions,
): HistoryMessage[] {
  let out = [...chrono];
  const current = String(currentText || "").trim();
  const currentMessageId = opts?.currentMessageId ? String(opts.currentMessageId).trim() : "";

  let removedCount = 0;
  if (currentMessageId) {
    out = out.filter((msg) => {
      const sender = String(msg.sender_type || msg.sender || "").toLowerCase();
      if (sender === "customer" && msg.message_id && String(msg.message_id).trim() === currentMessageId) {
        removedCount++;
        return false;
      }
      return true;
    });
    if (!isBatch && removedCount > 0) {
      return out;
    }
  }

  if (!current) return out;

  let poppedAtEnd = false;
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (!matchesCustomerMessageContent(last, current)) break;
    out.pop();
    poppedAtEnd = true;
    if (!isBatch) break;
  }

  if (!poppedAtEnd && removedCount === 0 && opts?.allowTrailingOutbound && out.length > 0) {
    const preservedOutboundTail: HistoryMessage[] = [];
    while (out.length > 0 && preservedOutboundTail.length < 3) {
      const tailCandidate = out[out.length - 1];
      if (!isOutboundSender(tailCandidate)) break;
      preservedOutboundTail.unshift(out.pop()!);
    }

    if (preservedOutboundTail.length > 0) {
      while (out.length > 0) {
        const prevCustomer = out[out.length - 1];
        if (!matchesCustomerMessageContent(prevCustomer, current)) break;
        out.pop();
        if (!isBatch) break;
      }
      out.push(...preservedOutboundTail);
    }
  }

  return out;
}

export interface UnansweredAfterAiResult {
  answeredByNewerAi: boolean;
  latestAiCreatedAt: string | null;
  unansweredCustomerMessages: HistoryMessage[];
}

/**
 * Resolve o "atropelamento de turnos": quando um Turno 2 acorda do buffer/lock,
 * verifica se já houve resposta da IA *depois* da fronteira inicial do lote.
 * Se sim, preserva apenas mensagens do cliente que ainda não foram respondidas.
 */
export function extractUnansweredCustomerMessagesAfterAi(
  chrono: HistoryMessage[],
  batchStartIso: string | null | undefined,
  options?: {
    currentMessageId?: string | null;
    isMessageHandled?: (messageId: string | null | undefined) => boolean;
  },
): UnansweredAfterAiResult {
  if (!Array.isArray(chrono) || chrono.length === 0 || !batchStartIso) {
    return { answeredByNewerAi: false, latestAiCreatedAt: null, unansweredCustomerMessages: [] };
  }

  const batchStartMs = new Date(batchStartIso).getTime();
  if (!Number.isFinite(batchStartMs)) {
    return { answeredByNewerAi: false, latestAiCreatedAt: null, unansweredCustomerMessages: [] };
  }

  let latestAiIdx = -1;
  let latestAiMs = -Infinity;
  let latestAiCreatedAt: string | null = null;

  for (let i = 0; i < chrono.length; i++) {
    const msg = chrono[i];
    const sender = String(msg.sender_type || msg.sender || "").toLowerCase();
    if (sender !== "ai") continue;
    const msgMs = msg.created_at ? new Date(msg.created_at).getTime() : NaN;
    if (Number.isFinite(msgMs) && msgMs > batchStartMs && msgMs >= latestAiMs) {
      latestAiMs = msgMs;
      latestAiIdx = i;
      latestAiCreatedAt = msg.created_at || null;
    }
  }

  if (latestAiIdx === -1) {
    return { answeredByNewerAi: false, latestAiCreatedAt: null, unansweredCustomerMessages: [] };
  }

  const isHandled = options?.isMessageHandled ?? (() => false);
  const unanswered: HistoryMessage[] = [];

  for (let i = latestAiIdx + 1; i < chrono.length; i++) {
    const msg = chrono[i];
    const sender = String(msg.sender_type || msg.sender || "").toLowerCase();
    if (sender !== "customer") continue;
    if (isHandled(msg.message_id)) continue;
    unanswered.push(msg);
  }

  return {
    answeredByNewerAi: true,
    latestAiCreatedAt,
    unansweredCustomerMessages: unanswered,
  };
}

export type HistoryWindow = { messages: HistoryMessage[]; skipped: number };

/**
 * Janela adaptativa: mantém os primeiros turnos (contexto fundador) e os
 * últimos (diálogo recente). O meio é substituído por um marcador `system`.
 * Conversa curta passa intacta.
 */
export function windowHistory(
  chrono: HistoryMessage[],
  opts: { keepHead?: number; keepTail?: number; middleContent: string },
): HistoryWindow {
  const keepHead = opts.keepHead ?? 3;
  const keepTail = opts.keepTail ?? 12;
  if (chrono.length <= keepHead + keepTail) return { messages: chrono, skipped: 0 };

  const skipped = chrono.length - keepHead - keepTail;
  return {
    skipped,
    messages: [
      ...chrono.slice(0, keepHead),
      { sender: "system", content: opts.middleContent, _skip_marker: true },
      ...chrono.slice(-keepTail),
    ],
  };
}

/** Converte o histórico em turnos do Gemini: começa em `user` e alterna. */
export function toGeminiTurns(history: GeminiTurn[], startedByAssistant = true): GeminiTurn[] {
  const out: GeminiTurn[] = [];
  for (const msg of history) {
    if (out.length === 0) {
      if (startedByAssistant && msg.role === "model") {
        out.push({ role: "user", parts: [{ text: "(Contato iniciado pela IA/SDR com disparo ativo)" }] });
      }
      out.push({ role: msg.role, parts: [{ text: msg.parts[0]?.text ?? "" }] });
      continue;
    }
    const last = out[out.length - 1];
    if (last.role === msg.role) {
      last.parts[0].text += `\n\n${msg.parts[0]?.text ?? ""}`;
    } else {
      out.push({ role: msg.role, parts: [{ text: msg.parts[0]?.text ?? "" }] });
    }
  }
  return out;
}
