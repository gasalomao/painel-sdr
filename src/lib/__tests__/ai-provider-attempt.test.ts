import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAiUsage, gatewayChatWithFailover, openRouterChatWithFailover, openRouterResponseUsage } from "@/lib/ai-provider";

const state = vi.hoisted(() => ({ alts: vi.fn(), unavailable: vi.fn() }));
vi.mock("@/lib/gateway-model-discovery", () => ({ listEndpointsForModel: (...args: unknown[]) => state.alts(...args) }));
vi.mock("@/lib/gateway-cooldown", () => ({ markEndpointCooldown: vi.fn(), markEndpointDead: vi.fn(), isEndpointUnavailable: (...args: unknown[]) => state.unavailable(...args) }));
beforeEach(() => {
  vi.resetAllMocks();
  state.alts.mockResolvedValue([{ id: "second", baseUrl: "https://second.invalid/v1", apiKey: null }]);
  state.unavailable.mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
});
afterEach(() => vi.unstubAllGlobals());
const primary = { baseUrl: "https://first.invalid/v1", apiKey: null, endpointId: "first" };
const body = { model: "code", messages: [{ role: "user", content: "hi" }] };
const success = () => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

describe("controlled physical attempts", () => {
  it.each([400, 401, 429, 503])("gateway HTTP %s does not send to a second account with maxAttempts 1", async (status) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: "Rejected" } }, { status }));
    await expect(gatewayChatWithFailover("code", body, primary, { maxAttempts: 1 })).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("gateway keeps default failover for existing consumers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 })).mockImplementationOnce(async () => success());
    await expect(gatewayChatWithFailover("code", body, primary)).resolves.toMatchObject({ choices: [{ message: { content: "ok" } }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("gateway propagates cancellation without starting alternative accounts", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Cancelled", "AbortError");
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeDefined();
      controller.abort(reason);
      init?.signal?.throwIfAborted();
      return success();
    });
    await expect(gatewayChatWithFailover("code", body, primary, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("pre-aborted gateway does not discover accounts or send", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(gatewayChatWithFailover("code", body, primary, { signal: controller.signal, maxAttempts: 1 })).rejects.toBe(controller.signal.reason);
    expect(state.alts).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects internal DeepSeek multi-request transport in single attempt mode", async () => {
    await expect(gatewayChatWithFailover("code", body, { ...primary, endpointId: "ds_internal" }, { maxAttempts: 1 })).rejects.toThrow("tentativa");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("exposes Retry-After and unknown failure usage without an internal retry", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: "Quota" } }, { status: 429, headers: { "Retry-After": "12" } }));
    await expect(gatewayChatWithFailover("code", body, primary, { maxAttempts: 1 })).rejects.toMatchObject({ status: 429, retryAfterMs: 12_000, usage: { usageUnknown: true } });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("OpenRouter cannot rotate API keys with maxAttempts 1", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: "Quota" } }, { status: 429 }));
    await expect(openRouterChatWithFailover(body, { openrouterKeys: ["test-first", "test-second"], maxAttempts: 1 })).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("usage provenance", () => {
  it.each([undefined, {}, { prompt_tokens: -1, completion_tokens: 0 }, { prompt_tokens: "12", completion_tokens: null }])("absent or invalid usage %j is unknown", (usage) => {
    expect(openRouterResponseUsage({ usage })).toMatchObject({ usageUnknown: true, estimated: true });
  });
  it("preserves optional metrics and exact reported zero cost", () => {
    expect(openRouterResponseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } })).toMatchObject({ promptTokens: 10, completionTokens: 5, cachedTokens: 4, cacheWriteTokens: 3, reasoningTokens: 2, costUsd: 0 });
  });
  it("retains physical attempts separately and never claims complete cost when one is unknown", () => {
    const first = { promptTokens: 1, completionTokens: 2, totalTokens: 3, costUsd: 0.1, reasoningTokens: 1, attempts: [{ provider: "openrouter" as const, model: "code", promptTokens: 1, completionTokens: 2, totalTokens: 3 }] };
    const second = { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageUnknown: true, estimated: true, attempts: [{ ...first.attempts[0], usageUnknown: true }] };
    const merged = addAiUsage(first, second);
    expect(merged.attempts).toHaveLength(2);
    expect(merged).toMatchObject({ usageUnknown: true, estimated: true, reasoningTokens: 1 });
    expect(merged.costUsd).toBeUndefined();
    expect(first.costUsd).toBe(0.1);
  });
});
