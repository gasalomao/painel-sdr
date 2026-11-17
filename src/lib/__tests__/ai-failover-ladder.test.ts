// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => {
    throw new Error("DB offline");
  }),
  markOpenRouterKeyCooldown: vi.fn(),
  markOpenRouterKeyDead: vi.fn(),
  markNvidiaAccountCooldown: vi.fn(),
  markNvidiaAccountDead: vi.fn(),
}));

vi.mock("@/lib/gemini-model-discovery", () => ({
  pickBestFlashModel: vi.fn(async () => "gemini-2.5-flash"),
}));

describe("ai-provider — failover por agente + resiliência quando getAiKeys falha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prioriza fallbackModelRef do agente quando modelo primário falha com 429, mesmo sem DB de chaves global", async () => {
    const calledUrls: Array<{ url: string; model: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calledUrls.push({ url, model: String(body.model || "") });

      // Primário OpenRouter claude falha por cota/rate-limit (429)
      if (body.model === "anthropic/claude-3.5-sonnet") {
        return new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429 });
      }

      // Failover NVIDIA configurado no agente responde normalmente
      return Response.json({
        choices: [{ message: { content: "Resposta via modelo reserva!" } }],
        usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { startAiChat } = await import("@/lib/ai-provider");
    const session = await startAiChat({
      modelRef: "openrouter:anthropic/claude-3.5-sonnet",
      fallbackModelRef: "nvidia:meta/llama-3.1-70b-instruct",
      systemInstruction: "Assistente",
      history: [],
      tools: [],
      openrouterApiKey: "or-key",
      nvidiaApiKey: "nv-key",
    });

    const turn = await session.sendUser("Oi");
    expect(turn.text).toBe("Resposta via modelo reserva!");
    expect(session.provider).toBe("nvidia");
    expect(session.modelUsed()).toBe("meta/llama-3.1-70b-instruct");
    expect(calledUrls.some((c) => c.model === "meta/llama-3.1-70b-instruct")).toBe(true);
  });
});

