/**
 * Badge de transcrição de áudio — qual modelo transcreveu (só UI, NÃO entra
 * no contexto da IA).
 *
 * Contrato:
 *  - "whisper" → "Whisper (local)"
 *  - "openrouter:vendor/model" → "OpenRouter · model"
 *  - "gemini" → "Gemini"
 *  - encodeTranscriptionMime + extractProviderFromMime codificam e decodificam de forma transparente
 */
import { describe, it, expect } from "vitest";
import {
  transcriptionProviderLabel,
  encodeTranscriptionMime,
  extractProviderFromMime,
} from "@/lib/transcription-label";

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

describe("encodeTranscriptionMime & extractProviderFromMime", () => {
  it("codifica e extrai provider do mimetype sem quebrar o formato", () => {
    const encoded = encodeTranscriptionMime("audio/ogg; codecs=opus", "whisper");
    expect(encoded).toBe("audio/ogg; codecs=opus; provider=whisper");

    const extracted = extractProviderFromMime(encoded);
    expect(extracted).toBe("whisper");
    expect(transcriptionProviderLabel(extracted)).toBe("Whisper (local)");
  });

  it("codifica e extrai provider OpenRouter do mimetype", () => {
    const encoded = encodeTranscriptionMime("audio/mp3", "openrouter:meta-llama/llama-3.1-8b-instruct:free");
    expect(encoded).toBe("audio/mp3; provider=openrouter:meta-llama/llama-3.1-8b-instruct:free");

    const extracted = extractProviderFromMime(encoded);
    expect(extracted).toBe("openrouter:meta-llama/llama-3.1-8b-instruct:free");
    expect(transcriptionProviderLabel(extracted)).toBe("OpenRouter · llama-3.1-8b-instruct:free");
  });

  it("mimetype sem provider retorna null", () => {
    expect(extractProviderFromMime("audio/ogg; codecs=opus")).toBeNull();
    expect(extractProviderFromMime(null)).toBeNull();
  });
});
