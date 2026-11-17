export type DeliverySegment =
  | { kind: "text"; content: string; consumed?: boolean }
  | { kind: "image"; url: string; caption: string };

const IMAGE_COLLECT_REGEX =
  /(?:\[(?:IMAGEM|IMAGE|MEDIA|FOTO):\s*(https?:\/\/[^\s\]]+)\]|!\[[^\]]*\]\((https?:\/\/[^\s\)]+)\)|(https?:\/\/[^\s\]\)]+(?:\.(?:jpg|jpeg|png|webp|gif)|\/chat-media\/[^\s\]\)]+)))/gi;

const MEDIA_TAG_REGEX = /\[(?:IMAGEM|IMAGE|MEDIA|FOTO):\s*(https?:\/\/[^\s\]]+)\]/gi;

/**
 * Extrai URLs de mídia válidas presentes no prompt base ou em chunks reais do RAG.
 */
export function collectValidImageUrls(text: string, target: Set<string>): void {
  if (!text) return;
  const re = new RegExp(IMAGE_COLLECT_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const url = (match[1] || match[2] || match[3] || "").trim();
    if (url) target.add(url);
  }
}

/**
 * Normaliza imagens Markdown / URLs autorizadas para `[IMAGEM: url]` e remove tags
 * inventadas pela IA fora da whitelist `validImageUrls`.
 */
export function sanitizeHallucinatedImages(rawAnswer: string, validImageUrls: Set<string>): string {
  let answer = rawAnswer.replace(/!\[[^\]]*\]\((https?:\/\/[^\s\)]+)\)/gi, "[IMAGEM: $1]");
  answer = answer.replace(/\[(?:IMAGEM|IMAGE|MEDIA|FOTO):\s*(https?:\/\/[^\s\]]+)\]/gi, (_full, rawUrl: string) => {
    const cleanUrl = String(rawUrl).trim();
    return validImageUrls.has(cleanUrl) ? `[IMAGEM: ${cleanUrl}]` : "";
  });
  for (const validUrl of validImageUrls) {
    const escaped = validUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (answer.includes(validUrl) && !new RegExp(`\\[(?:IMAGEM|IMAGE|MEDIA|FOTO):\\s*${escaped}\\]`, "i").test(answer)) {
      answer = answer.replace(validUrl, `\n[IMAGEM: ${validUrl}]\n`);
    }
  }
  return answer.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Divide um bloco de resposta em segmentos intercalados de texto e imagem,
 * convertendo texto curto imediatamente anterior em legenda da foto.
 */
export function splitChunkSegmentsWithCaptions(chunkText: string): {
  segments: DeliverySegment[];
  hasImages: boolean;
} {
  const segments: DeliverySegment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(MEDIA_TAG_REGEX.source, "gi");

  while ((m = re.exec(chunkText)) !== null) {
    const before = chunkText.slice(lastIndex, m.index).trim();
    if (before) segments.push({ kind: "text", content: before });
    segments.push({ kind: "image", url: m[1].trim(), caption: "" });
    lastIndex = m.index + m[0].length;
  }

  const tail = chunkText.slice(lastIndex).trim();
  if (tail) segments.push({ kind: "text", content: tail });

  const hasImages = segments.some((s) => s.kind === "image");
  if (!hasImages) {
    return { segments, hasImages: false };
  }

  for (let idx = 0; idx < segments.length; idx++) {
    const s = segments[idx];
    if (s.kind !== "image" || idx === 0) continue;
    const prev = segments[idx - 1];
    if (prev.kind !== "text" || prev.consumed) continue;

    const lines = prev.content.split(/\n+/).filter(Boolean);
    const lastLine = lines[lines.length - 1] || "";
    if (lines.length <= 3 && prev.content.length <= 250) {
      s.caption = prev.content;
      prev.consumed = true;
    } else if (lastLine.length > 0 && lastLine.length <= 200) {
      s.caption = lastLine;
      lines.pop();
      prev.content = lines.join("\n").trim();
      if (!prev.content) prev.consumed = true;
    }
  }

  return { segments, hasImages: true };
}

