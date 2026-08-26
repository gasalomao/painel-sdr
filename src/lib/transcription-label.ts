/**
 * Rótulo amigável do provedor de transcrição de áudio pra exibir na UI
 * (badge discreto embaixo do áudio no chat).
 *
 * IMPORTANTE: esse dado é EXCLUSIVAMENTE visual — vive na coluna
 * chats_dashboard.transcription_provider e NUNCA entra no texto enviado
 * ao agente de IA (o agente recebe só a transcrição, sem o provider).
 */
export function transcriptionProviderLabel(provider: string | null | undefined): string | null {
  const p = (provider || "").trim();
  if (!p || p === "none") return null;
  if (p === "whisper") return "Whisper (local)";
  if (p === "gemini") return "Gemini";
  if (p.startsWith("openrouter:")) {
    const model = p.slice("openrouter:".length);
    const short = model.includes("/") ? model.split("/").pop()! : model;
    return `OpenRouter · ${short}`;
  }
  return p;
}
