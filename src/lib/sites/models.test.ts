import { describe, expect, it, vi } from "vitest";
import { createImageGenerationProvider, listWebsiteModels, selectWebsiteModels, type WebsiteModel } from "./models";
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
vi.mock("@/lib/ai-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-provider")>("@/lib/ai-provider");
  return {
    ...actual,
    openRouterChatWithFailover: (...args: unknown[]) => mockFailover(...args),
  };
});

describe("Website Models and Image Generation", () => {
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
