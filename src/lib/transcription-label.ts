/**
 * Rótulo amigável do provedor de transcrição de áudio pra exibir na UI
 * (badge discreto embaixo do áudio no chat).
 *
 * IMPORTANTE: esse dado é EXCLUSIVAMENTE visual —
 * e NUNCA entra no texto enviado ao agente de IA
 * (o agente recebe só a transcrição limpa, sem o provider).
 */
export function transcriptionProviderLabel(provider: string | null | undefined): string | null {
  const p = (provider || "").trim();
  if (!p || p === "none") return null;
  if (p.toLowerCase() === "whisper") return "Whisper (local)";
  if (p.toLowerCase() === "gemini") return "Gemini";
  if (p.startsWith("openrouter:")) {
    const model = p.slice("openrouter:".length);
    const short = model.includes("/") ? model.split("/").pop()! : model;
    return `OpenRouter (${short})`;
  }
  return p;
}

/**
 * Codifica o provider de transcrição no mimetype de forma segura e padronizada.
 * Ex: encodeTranscriptionMime("audio/ogg; codecs=opus", "whisper")
 *     → "audio/ogg; codecs=opus; provider=whisper"
 */
export function encodeTranscriptionMime(mimetype: string | null | undefined, provider: string | null | undefined): string {
  const base = (mimetype || "audio/ogg").trim();
  if (!provider || provider === "none") return base;
  if (base.includes("provider=")) return base;
  return `${base}; provider=${provider}`;
}

/**
 * Extrai o provider de transcrição caso tenha sido codificado no mimetype.
 * Ex: extractProviderFromMime("audio/ogg; codecs=opus; provider=whisper") → "whisper"
 */
export function extractProviderFromMime(mimetype: string | null | undefined): string | null {
  if (!mimetype) return null;
  const match = mimetype.match(/(?:^|;\s*)provider=([^;]+)/i);
  return match ? match[1].trim() : null;
}
