import { createHash } from "crypto";

export interface RawChatMessageLike {
  sender_type?: string | null;
  is_from_me?: boolean | null;
  content?: string | null;
  media_type?: string | null;
  mimetype?: string | null;
  file_name?: string | null;
  created_at?: string | null;
}

const SDR_SENDER_TYPES = new Set(["ai", "human", "assistant", "agent", "sdr", "bot"]);

/**
 * Classifica o remetente e formata uma linha padronizada de histórico (`SDR:` vs `CLIENTE:`),
 * preservando marcadores de mídia quando o texto vier vazio (áudio/imagem/comprovante/PDF).
 */
export function formatChatMessageLine(
  msg: RawChatMessageLike
): { line: string; isSdr: boolean; textForStats: string } | null {
  const senderType = String(msg.sender_type || "").toLowerCase();
  const isSdr = Boolean(msg.is_from_me) || SDR_SENDER_TYPES.has(senderType);
  const prefix = isSdr ? "SDR:" : "CLIENTE:";

  const rawContent = String(msg.content || "").trim();
  const mediaType = String(msg.media_type || "").trim();
  const fileName = String(msg.file_name || "").trim();

  let renderedBody = rawContent;
  if (!renderedBody && mediaType) {
    renderedBody = fileName ? `[MÍDIA: ${mediaType} (${fileName})]` : `[MÍDIA: ${mediaType}]`;
  } else if (renderedBody && mediaType && !rawContent.startsWith("🎤")) {
    renderedBody = `[MÍDIA: ${mediaType}] ${renderedBody}`;
  }

  if (!renderedBody) return null;

  const createdDate = msg.created_at ? new Date(msg.created_at) : new Date();
  const timeStr = Number.isNaN(createdDate.getTime())
    ? "--/-- --:--"
    : createdDate.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

  return {
    line: `[${timeStr}] ${prefix} ${renderedBody}`,
    isSdr,
    textForStats: renderedBody,
  };
}

/**
 * Hash determinístico das mensagens recentes de um chat + status atual no Kanban.
 */
export function hashChatContent(messages: string[], statusAtual: string): string {
  return createHash("sha256")
    .update(`${statusAtual}|${messages.join("||")}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Divide arrays grandes em lotes menores para evitar estouro de URL em filtros `.in(...)` do PostgREST.
 */
export function chunkArray<T>(items: T[], size: number = 80): T[][] {
  if (items.length === 0) return [];
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

