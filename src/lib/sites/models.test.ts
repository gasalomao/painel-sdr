import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageGenerationProvider, listWebsiteModels, selectWebsiteModels, websiteChatAttempt, type WebsiteModel } from "./models";
import { DEFAULT_WEBSITE_SETTINGS } from "./prompts";
import type { WebsiteSettings } from "./types";

const models: WebsiteModel[] = [
  { id: "anthropic/claude-3.5-sonnet", name: "Claude Sonnet", supportsTools: true, contextLength: 200_000, pricing: { prompt: "0.000003", completion: "0.000015" } },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", supportsTools: true, inputModalities: ["text", "image"], contextLength: 128_000, pricing: { prompt: "0.00000015", completion: "0.0000006" } },
  { id: "google/gemini-flash-1.5", name: "Gemini Flash", supportsTools: true, inputModalities: ["text", "image"], contextLength: 1_000_000, pricing: { prompt: "0.000000075", completion: "0.0000003" } },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", supportsTools: true, contextLength: 64_000, pricing: { prompt: "0.00000014", completion: "0.00000028" } },
];

const settings: WebsiteSettings = {
  ...DEFAULT_WEBSITE_SETTINGS,
  quality_model: "anthropic/claude-3.5-sonnet",
  economy_model: "openai/gpt-4o-mini",
  image_model: "black-forest-labs/flux-1-schnell",
  image_generation_enabled: true,
  max_images_per_day: 10,
};

vi.mock("@/lib/gemini-model-discovery", () => ({
  listAvailableGeminiModels: async () => [],
}));
vi.mock("@/lib/gateway-model-discovery", () => ({
  listAvailableGatewayModels: async () => [],
}));
vi.mock("@/lib/nvidia-model-discovery", () => ({
  listAvailableNvidiaModels: async () => [],
}));
vi.mock("@/lib/openrouter-model-discovery", () => ({
  listAvailableOpenRouterModels: async (_force = false, includeImage = false) => {
    if (includeImage) {
      return [{ id: "black-forest-labs/flux-1-schnell", name: "FLUX Schnell", supportsTools: false, outputModalities: ["image"] }];
    }
    return models;
  },
}));

const mockFailover = vi.fn();
const mockGateway = vi.fn();
const mockCreds = vi.fn();
const mockKeys = vi.fn();
vi.mock("@/lib/ai-keys", () => ({ getAiKeys: () => mockKeys() }));
beforeEach(() => {
  vi.resetAllMocks();
  mockKeys.mockResolvedValue({ gemini: "test", nvidia: "test" });
  mockCreds.mockResolvedValue({ baseUrl: "https://gateway.invalid/v1", apiKey: null, endpointId: "test" });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
});
afterEach(() => vi.unstubAllGlobals());
vi.mock("@/lib/ai-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-provider")>("@/lib/ai-provider");
  return {
    ...actual,
    openRouterChatWithFailover: (...args: unknown[]) => mockFailover(...args),
    gatewayChatWithFailover: (...args: unknown[]) => mockGateway(...args),
    resolveGatewayCreds: (...args: unknown[]) => mockCreds(...args),
  };
});

describe("websiteChatAttempt", () => {
  const signal = () => new AbortController().signal;
  const response = { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  const body = { messages: [{ role: "user", content: "Olá 🌱" }], tools: [{ type: "function" }], tool_choice: "auto" };

  it("limits OpenRouter to one physical attempt and preserves tool-capable reasoners", async () => {
    mockFailover.mockResolvedValue(response);
    const abort = signal();
    await websiteChatAttempt({ ...models[0], id: "vendor/reasoner-r1", supportsTools: true }, body, abort);
    expect(mockFailover).toHaveBeenCalledOnce();
    expect(mockFailover).toHaveBeenCalledWith(expect.objectContaining({ model: "vendor/reasoner-r1", tools: body.tools, stream: false }), expect.objectContaining({ signal: abort, maxAttempts: 1, allowEmptyContent: true }));
    expect(body).toHaveProperty("tools");
  });

  it("bounds gateway account failover and passes cancellation", async () => {
    mockGateway.mockResolvedValue(response);
    const abort = signal();
    await websiteChatAttempt({ ...models[0], id: "gateway:code" }, body, abort);
    expect(mockGateway).toHaveBeenCalledOnce();
    expect(mockGateway).toHaveBeenCalledWith("code", expect.objectContaining({ model: "code" }), expect.any(Object), expect.objectContaining({ signal: abort, maxAttempts: 1 }));
  });

  it("does not fall back to OpenRouter when a Gemini key is missing", async () => {
    mockKeys.mockResolvedValue({});
    await expect(websiteChatAttempt({ ...models[0], id: "gemini:code" }, body, signal())).rejects.toThrow("configurada");
    expect(mockFailover).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([400, 429, 503])("NVIDIA HTTP %s makes only one request without dropping supported tools", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Rejected" } }, { status })));
    await expect(websiteChatAttempt({ ...models[0], id: "nvidia:deepseek/reasoner", supportsTools: true }, body, signal())).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "deepseek/reasoner", tools: body.tools });
  });

  it("removes tools only when capabilities deny them", async () => {
    mockFailover.mockResolvedValue(response);
    await websiteChatAttempt({ ...models[0], supportsTools: false }, body, signal());
    expect(mockFailover.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(mockFailover.mock.calls[0][0]).not.toHaveProperty("tool_choice");
    expect(body).toHaveProperty("tools");
  });

  it("preserves cache, reasoning, cache write and reported zero cost", async () => {
    mockFailover.mockResolvedValue({ ...response, usage: { ...response.usage, estimated: true, cost: 0, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } } });
    const result = await websiteChatAttempt(models[0], body, signal());
    expect(result.usage).toMatchObject({ cachedTokens: 4, cacheWriteTokens: 3, reasoningTokens: 1, costUsd: 0, estimated: true });
  });

  it("marks absent usage unknown rather than proved zero", async () => {
    mockFailover.mockResolvedValue({ choices: response.choices });
    const result = await websiteChatAttempt(models[0], body, signal());
    expect(result.usage).toMatchObject({ estimated: true, usageUnknown: true });
    expect(result.usage.costUsd).toBeUndefined();
  });

  it.each([null, {}, { choices: [] }, { choices: [{ message: { content: null, reasoning: "not executable" } }] }, { choices: [{ message: { tool_calls: [{ id: "x", type: "function", function: { name: "write", arguments: "bad json" } }] } }] }])("rejects invalid structured response %j without retry", async (invalid) => {
    mockFailover.mockResolvedValue(invalid);
    await expect(websiteChatAttempt(models[0], body, signal())).rejects.toThrow();
    expect(mockFailover).toHaveBeenCalledOnce();
  });

  it("preserves failure usage as unknown", async () => {
    mockFailover.mockRejectedValue(new Error("Network failed"));
    await expect(websiteChatAttempt(models[0], body, signal())).rejects.toMatchObject({ usage: { usageUnknown: true, estimated: true } });
  });

  it("aborted input makes no provider request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(websiteChatAttempt(models[0], body, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(mockFailover).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Website Models and Image Generation", () => {
  it("manual selection cannot reintroduce allowlist-excluded or incompatible models", () => {
    expect(() => selectWebsiteModels(models, { ...settings, model_allowlist: [models[1].id] }, "manual", models[0].id)).toThrow("indisponível");
    expect(() => selectWebsiteModels([{ ...models[0], supportsTools: false }], settings, "manual", models[0].id)).toThrow("indisponível");
    expect(() => selectWebsiteModels(models, settings, "manual", "gateway:unknown")).toThrow("indisponível");
  });

  it("explicit free-only policy rejects paid targets and textual vision fallbacks", () => {
    const free = { ...models[0], id: "vendor/free", pricing: { prompt: "0", completion: "0" }, provider: "openrouter" as const };
    expect(() => selectWebsiteModels([free, ...models], settings, "manual", models[0].id, false, { freeOnly: true })).toThrow();
    expect(() => selectWebsiteModels([free, ...models], settings, "manual", free.id, true, { freeOnly: true })).toThrow();
    expect(selectWebsiteModels([free, ...models], { ...settings, quality_model: "" }, "auto", undefined, false, { freeOnly: true })).toEqual([free]);
  });

  it("filters and orders up to 3 candidates respecting allowlist and mode", async () => {
    const list = await listWebsiteModels(settings);
    expect(list.length).toBe(4);
    const economy = selectWebsiteModels(list, settings, "economy");
    expect(economy[0].id).toBe("openai/gpt-4o-mini");
    expect(economy.length).toBe(3);
    const vision = selectWebsiteModels(list, settings, "auto", undefined, true);
    expect(vision.every((model) => model.inputModalities?.includes("image"))).toBe(true);
  });

  it.each(["auto", "quality", "economy", "manual"] as const)("keeps free OpenRouter fallbacks free in %s mode", (mode) => {
    const free: WebsiteModel = { id: "vendor/code:free", name: "Free code", supportsTools: true, contextLength: 128_000, pricing: { prompt: "0", completion: "0" }, provider: "openrouter", isFree: true };
    const freeVision: WebsiteModel = { ...free, id: "vendor/vision:free", inputModalities: ["text", "image"] };
    const gateway: WebsiteModel = { ...free, id: "gateway:paid-subscription", provider: "gateway" };
    const list = [free, freeVision, gateway, ...models];
    const configured = { ...settings, quality_model: free.id, economy_model: free.id };
    expect(selectWebsiteModels(list, configured, mode, free.id).map((model) => model.id)).toEqual([free.id, freeVision.id]);
    expect(selectWebsiteModels(list, configured, mode, free.id, true).map((model) => model.id)).toEqual([freeVision.id]);
  });

  it.each(["auto", "quality", "economy", "manual"] as const)("rejects unknown configured or selected suffixless targets in %s mode, including vision", (mode) => {
    const lost = "stealth/space-bunny-alpha";
    const configured = { ...settings, quality_model: lost, economy_model: lost };
    for (const vision of [false, true]) {
      expect(() => selectWebsiteModels(models, settings, mode, lost, vision)).toThrow("indisponível");
      expect(() => selectWebsiteModels(models, configured, mode, undefined, vision)).toThrow("indisponível");
    }
  });

  it("still selects candidates when no target is configured", () => {
    const configured = { ...settings, quality_model: "", economy_model: "" };
    expect(selectWebsiteModels(models, configured, "auto")).toHaveLength(3);
    expect(selectWebsiteModels(models, configured, "economy")[0].id).toBe("deepseek/deepseek-chat");
  });

  it("fails closed with a ready-credentials signal when no vision model is available", () => {
    const textOnly = models.map((model) => ({ ...model, inputModalities: ["text"] }));
    expect(() => selectWebsiteModels(textOnly, settings, "auto", undefined, true)).toThrow("READY — AWAITING CREDENTIALS");
  });

  it("handles image generation and records token usage via OpenRouter modalities", async () => {
    mockFailover.mockResolvedValueOnce({
      choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }] } }],
      usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
    });
    const record = vi.fn(async () => undefined);
    const provider = createImageGenerationProvider(record);
    const result = await provider.generate({ prompt: "Padaria moderna", settings }, new AbortController().signal);
    expect(result.images).toHaveLength(1);
    expect(record).toHaveBeenCalledOnce();
    expect(mockFailover).toHaveBeenCalledWith(
      expect.objectContaining({ model: "black-forest-labs/flux-1-schnell", modalities: ["image"] }),
      expect.objectContaining({ allowImages: true })
    );
  });

  it("selects gateway and free models seamlessly in economy, quality, and manual modes", () => {
    const list: WebsiteModel[] = [
      { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 Free", supportsTools: true, pricing: { prompt: "0", completion: "0" }, isFree: true },
      { id: "gateway:deepseek-chat", name: "DeepSeek (Gateway)", supportsTools: true, pricing: { prompt: "0", completion: "0" }, provider: "gateway", isFree: true },
      { id: "openai/gpt-4o", name: "GPT-4o", supportsTools: true, pricing: { prompt: "0.000005", completion: "0.000015" } },
    ];
    const customSettings: WebsiteSettings = {
      ...DEFAULT_WEBSITE_SETTINGS,
      quality_model: "gateway:deepseek-chat",
    };
    const manualGateway = selectWebsiteModels(list, customSettings, "manual", "gateway:deepseek-chat");
    expect(manualGateway[0].id).toBe("gateway:deepseek-chat");

    const qualityAuto = selectWebsiteModels(list, customSettings, "quality");
    expect(qualityAuto[0].id).toBe("gateway:deepseek-chat");
  });
});
