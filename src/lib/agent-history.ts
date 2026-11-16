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
  _skip_marker?: boolean;
};

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

/**
 * A mensagem atual já foi persistida antes deste run. Remove do fim do
 * histórico a(s) cópia(s) dela.
 *
 * Regra: só remove quando o conteúdo bate. Em contexto de lote (várias
 * mensagens consolidadas em `currentText`), as ocorrências finais também
 * batem e devem sair; fora de lote, remove no máximo uma.
 *
 * @returns novo array; a entrada não é mutada.
 */
export function dropTrailingCurrentMessage(
  chrono: HistoryMessage[],
  currentText: string,
  isBatch = false,
): HistoryMessage[] {
  const out = [...chrono];
  const current = String(currentText || "").trim();
  if (!current) return out;

  while (out.length > 0) {
    const last = out[out.length - 1];
    const sender = last.sender_type || last.sender;
    const lastContent = String(last.content || "").trim();
    const matches =
      sender === "customer" &&
      lastContent.length > 0 &&
      (lastContent === current || (lastContent.length >= 2 && current.includes(lastContent)));
    if (!matches) break;
    out.pop();
    if (!isBatch) break;
  }
  return out;
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
