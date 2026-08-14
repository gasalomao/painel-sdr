import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/whisper-manager", () => ({
  transcribeAudioWithWhisper: vi.fn(),
  isWhisperInstalled: vi.fn(() => false),
  ensureWhisper: vi.fn(),
  getWhisperStatus: vi.fn(async () => ({ installed: false, disabled: false, model: "ggml-base.bin" })),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null })) })) })),
    })),
    storage: { getBucket: vi.fn(), createBucket: vi.fn(), from: vi.fn() },
  },
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => "test-client"),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn(),
}));

vi.mock("@/lib/organizer-config-cache", () => ({
  getOrganizerConfig: vi.fn(async () => null),
}));

vi.mock("@/lib/gemini-model-discovery", () => ({
  buildFallbackChain: vi.fn(async () => []),
}));

describe("shared-helpers transcribeAudio — whisper primeiro, Gemini fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("usa whisper primeiro (gratis) quando disponivel", async () => {
    const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
    (transcribeAudioWithWhisper as any).mockResolvedValue("ola mundo");

    const { transcribeAudio } = await import("@/app/api/webhooks/shared-helpers");
    const result = await transcribeAudio("dGVzdA==", "audio/ogg", "msg-1");

    expect(result).toBe("ola mundo");
    expect(transcribeAudioWithWhisper).toHaveBeenCalledWith("dGVzdA==", "audio/ogg");
  });

  it("cai pro Gemini quando whisper falha", async () => {
    const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
    (transcribeAudioWithWhisper as any).mockResolvedValue(null);

    const { transcribeAudio } = await import("@/app/api/webhooks/shared-helpers");
    const result = await transcribeAudio("dGVzdA==", "audio/ogg", "msg-1");

    // sem config de Gemini → retorna null
    expect(result).toBeNull();
    expect(transcribeAudioWithWhisper).toHaveBeenCalled();
  });

  it("retorna null quando whisper falha e nao tem config Gemini", async () => {
    const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
    (transcribeAudioWithWhisper as any).mockResolvedValue(null);

    const { transcribeAudio } = await import("@/app/api/webhooks/shared-helpers");
    const result = await transcribeAudio("dGVzdA==", "audio/mpeg", "msg-2");

    expect(result).toBeNull();
  });
});

describe("whisper-manager getWhisperStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("retorna disabled=false por padrao", async () => {
    const { getWhisperStatus } = await import("@/lib/whisper-manager");
    const status = await getWhisperStatus();
    expect(status.disabled).toBe(false);
    expect(typeof status.installed).toBe("boolean");
    expect(status.model).toBe("ggml-base.bin");
  });
});
