import { describe, expect, it, vi } from "vitest";
import {
  createFreeTestQuota, reserveFreeTestTokens, startFreeTestRequest,
  settleFreeTestUsage, assertFreeTestQuota, validateFreeTestModel,
} from "../../../../scripts/test-site-free";

const catalogModel = {
  id: "test/code:free", name: "Synthetic code model", context_length: 256_000,
  pricing: { prompt: "0", completion: "0", request: "0", image: "0", internal_reasoning: "0" },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools", "max_tokens"],
};

const usage = (totalTokens: number) => ({ promptTokens: totalTokens - 1, completionTokens: 1, totalTokens });

describe("free live catalog policy", () => {
  it("accepts only an explicitly selected catalog entry with confirmed zero pricing", () => {
    expect(validateFreeTestModel(catalogModel, catalogModel.id)).toMatchObject({
      id: catalogModel.id, provider: "openrouter", isFree: true, supportsTools: true, contextLength: 256_000,
    });
  });

  it.each([undefined, null, [], "", 3, {}])("rejects malformed or absent catalog data %s", (value) => {
    expect(() => validateFreeTestModel(value, catalogModel.id)).toThrow();
  });

  it.each([undefined, null, "", "0.01", "NaN", "-1", 0, true])("rejects unknown/paid prompt pricing %s", (prompt) => {
    expect(() => validateFreeTestModel({ ...catalogModel, pricing: { ...catalogModel.pricing, prompt } }, catalogModel.id)).toThrow();
  });

  it.each(["completion", "request", "image", "internal_reasoning", "web_search", "future_charge"])("rejects nonzero additional billable field %s", (field) => {
    expect(() => validateFreeTestModel({ ...catalogModel, pricing: { ...catalogModel.pricing, [field]: "0.0001" } }, catalogModel.id)).toThrow();
  });

  it("does not trust a :free suffix or isFree flag without prices", () => {
    expect(() => validateFreeTestModel({ ...catalogModel, pricing: undefined, isFree: true }, catalogModel.id)).toThrow();
    expect(() => validateFreeTestModel({ ...catalogModel, pricing: { prompt: "0" } }, catalogModel.id)).toThrow();
  });

  it.each(["gateway:test", "gemini:test", "nvidia:test", "openrouter:test", "test/other:free", "test/code:free​", ""])("rejects mismatched or prefixed model %s", (id) => {
    expect(() => validateFreeTestModel(catalogModel, id)).toThrow();
  });

  it("allows nvidia/ on OpenRouter, not the nvidia: provider", () => {
    const model = { ...catalogModel, id: "nvidia/synthetic:free" };
    expect(validateFreeTestModel(model, model.id).provider).toBe("openrouter");
    expect(() => validateFreeTestModel({ ...model, id: "nvidia:synthetic" }, "nvidia:synthetic")).toThrow();
  });

  it.each([
    { supported_parameters: [] }, { supported_parameters: undefined },
    { architecture: { input_modalities: ["image"], output_modalities: ["text"] } },
    { architecture: { input_modalities: ["text"], output_modalities: ["audio"] } },
    { architecture: undefined }, { context_length: 0 }, { context_length: undefined },
    { context_length: "256000" }, { context_length: Infinity },
  ])("fails closed without tools, text, or reliable context %s", (patch) => {
    expect(() => validateFreeTestModel({ ...catalogModel, ...patch }, catalogModel.id)).toThrow();
  });
});

describe("free live in-memory global quota", () => {
  it("supports an explicit bounded creation ceiling without changing the default editing limit", () => {
    const creation = createFreeTestQuota(0, 160_000);
    let state = settleFreeTestUsage(startFreeTestRequest(reserveFreeTestTokens(creation, 80_000, 1), 1), usage(1));
    state = settleFreeTestUsage(startFreeTestRequest(reserveFreeTestTokens(state, 80_000, 2), 2), usage(1));
    expect(state.accountedTokens).toBe(160_000);
    expect(() => reserveFreeTestTokens(state, 1, 3)).toThrow(/tokens/);
    expect(() => reserveFreeTestTokens(createFreeTestQuota(0), 60_001, 1)).toThrow(/tokens/);
    expect(() => createFreeTestQuota(0, Infinity)).toThrow();
  });
  it("counts immediately before transport and rejects the eleventh physical request", () => {
    const transport = vi.fn();
    let state = createFreeTestQuota(0);
    for (let index = 0; index < 10; index++) {
      state = reserveFreeTestTokens(state, 100, 1);
      state = startFreeTestRequest(state, 1);
      transport();
      state = settleFreeTestUsage(state, usage(100));
    }
    expect(state.requests).toBe(10);
    expect(() => startFreeTestRequest(reserveFreeTestTokens(state, 100, 1), 1)).toThrow(/requests/);
    expect(transport).toHaveBeenCalledTimes(10);
  });

  it("admits exactly 60000 predicted tokens across both sequential cases, never resets", () => {
    let state = createFreeTestQuota(0);
    state = startFreeTestRequest(reserveFreeTestTokens(state, 30_000, 1), 1);
    state = settleFreeTestUsage(state, usage(1));
    state = startFreeTestRequest(reserveFreeTestTokens(state, 30_000, 2), 2);
    state = settleFreeTestUsage(state, usage(1));
    expect(state.predictedTokens).toBe(60_000);
    expect(() => reserveFreeTestTokens(state, 1, 3)).toThrow(/tokens/);
  });

  it("charges unknown or incomplete usage conservatively and never releases its prediction", () => {
    for (const incomplete of [null, { ...usage(1), estimated: true }, usage(0), { ...usage(1), totalTokens: NaN }, { ...usage(1), attempts: [{ ...usage(1), estimated: true, provider: "openrouter" as const, model: "test/model" }] }]) {
      const state = startFreeTestRequest(reserveFreeTestTokens(createFreeTestQuota(0), 1000, 1), 1);
      const settled = settleFreeTestUsage(state, incomplete);
      expect(settled.accountedTokens).toBe(1000);
      expect(settled.predictedTokens).toBe(1000);
      expect(settled.pending).toBeNull();
    }
  });

  it("uses larger observed usage, then blocks all further transport", () => {
    const state = startFreeTestRequest(reserveFreeTestTokens(createFreeTestQuota(0), 1000, 1), 1);
    const settled = settleFreeTestUsage(state, usage(60_001));
    expect(settled.accountedTokens).toBe(60_001);
    expect(() => reserveFreeTestTokens(settled, 1, 2)).toThrow(/tokens/);
  });

  it("enforces the ten-minute deadline at admission and immediately before transport", () => {
    const state = createFreeTestQuota(100);
    expect(() => assertFreeTestQuota(state, 600_099)).not.toThrow();
    expect(() => assertFreeTestQuota(state, 600_100)).toThrow(/deadline/);
    expect(() => reserveFreeTestTokens(state, 1, 600_100)).toThrow(/deadline/);
    const reserved = reserveFreeTestTokens(state, 100, 600_099);
    expect(() => startFreeTestRequest(reserved, 600_100)).toThrow(/deadline/);
  });

  it("blocks overlapping reservations and duplicate request/usage calls without mutating inputs", () => {
    const original = Object.freeze(createFreeTestQuota(0));
    const reserved = reserveFreeTestTokens(original, 100, 1);
    expect(original.pending).toBeNull();
    expect(original.predictedTokens).toBe(0);
    expect(() => reserveFreeTestTokens(reserved, 1, 1)).toThrow();
    expect(() => startFreeTestRequest(original, 1)).toThrow();
    const started = startFreeTestRequest(reserved, 1);
    expect(reserved.requests).toBe(0);
    expect(() => startFreeTestRequest(started, 1)).toThrow();
    expect(() => settleFreeTestUsage(original, usage(1))).toThrow();
    const settled = settleFreeTestUsage(started, usage(1));
    expect(() => settleFreeTestUsage(settled, usage(1))).toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity, 60_001])("rejects invalid token predictions %s", (amount) => {
    expect(() => reserveFreeTestTokens(createFreeTestQuota(0), amount, 1)).toThrow();
  });

  it.each([-1, NaN, Infinity])("rejects invalid clock values %s", (now) => {
    expect(() => createFreeTestQuota(now)).toThrow();
    expect(() => assertFreeTestQuota(createFreeTestQuota(0), now)).toThrow();
  });
});
