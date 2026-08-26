/**
 * Badge de transcrição de áudio — qual modelo transcreveu (só UI, NÃO entra
 * no contexto da IA).
 *
 * Contrato:
 *  - "whisper" → "Whisper (local)"
 *  - "openrouter:vendor/model" → "OpenRouter · model"
 *  - "gemini" → "Gemini"
 *  - desconhecido/null → null (não renderiza badge)
 */
import { describe, it, expect } from "vitest";
import { transcriptionProviderLabel } from "@/lib/transcription-label";

describe("transcriptionProviderLabel", () => {
  it("whisper local", () => {
    expect(transcriptionProviderLabel("whisper")).toBe("Whisper (local)");
  });

  it("openrouter com modelo", () => {
    expect(transcriptionProviderLabel("openrouter:z-ai/glm-5.2")).toBe("OpenRouter · glm-5.2");
    expect(transcriptionProviderLabel("openrouter:openai/gpt-4o-mini")).toBe("OpenRouter · gpt-4o-mini");
  });

  it("gemini", () => {
    expect(transcriptionProviderLabel("gemini")).toBe("Gemini");
  });

  it("null/vazio/desconhecido → null (sem badge)", () => {
    expect(transcriptionProviderLabel(null)).toBeNull();
    expect(transcriptionProviderLabel("")).toBeNull();
    expect(transcriptionProviderLabel("none")).toBeNull();
    expect(transcriptionProviderLabel(undefined)).toBeNull();
  });
});
