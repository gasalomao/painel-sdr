import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ insert: vi.fn(), price: vi.fn(), ensure: vi.fn() }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: () => ({ insert: state.insert }) } }));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/pricing", () => ({
  ensurePricing: state.ensure,
  lookupPriceSync: state.price,
  computeCost: (price: { input_per_token: number; output_per_token: number } | null, input: number, output: number) => price ? price.input_per_token * input + price.output_per_token * output : 0,
}));

import { logTokenUsage } from "../token-usage";

beforeEach(() => {
  vi.clearAllMocks();
  state.insert.mockResolvedValue({ error: null });
  state.ensure.mockResolvedValue(undefined);
  state.price.mockReturnValue(null);
});

const input = { source: "other" as const, clientId: "tenant", model: "test/model", promptTokens: 100, completionTokens: 10, totalTokens: 110 };

describe("token cost provenance", () => {
  it("marks missing price as unknown rather than reporting free inference", async () => {
    await logTokenUsage(input);
    expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({ cost_usd: null, metadata: expect.objectContaining({ cost_status: "unknown", cost_usd: null }) }));
  });

  it("preserves provider-reported zero cost and skips unrelated price discovery", async () => {
    await logTokenUsage({ ...input, costUsd: 0 });
    expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({ cost_usd: 0, metadata: expect.objectContaining({ cost_status: "reported", cost_usd: 0 }) }));
    expect(state.ensure).not.toHaveBeenCalled();
  });

  it("accounts for cached input when its price is known", async () => {
    state.price.mockReturnValue({ input_per_token: 0.01, output_per_token: 0.02, cache_read_per_token: 0.001 });
    await logTokenUsage({ ...input, cachedTokens: 80 });
    expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({ cost_usd: 0.48, metadata: expect.objectContaining({ cost_status: "estimated", cached_tokens: 80 }) }));
  });

  it("keeps invalid reported cost unknown rather than accepting negative prices", async () => {
    await logTokenUsage({ ...input, costUsd: -1 });
    expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({ cost_usd: null, metadata: expect.objectContaining({ cost_status: "unknown", cost_usd: null }) }));
  });
});
