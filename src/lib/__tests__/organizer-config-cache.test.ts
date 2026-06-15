import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockMaybeSingle = vi.fn();

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockMaybeSingle,
        }),
      }),
    }),
  },
}));

describe("getOrganizerConfig + cache TTL", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    mockMaybeSingle.mockReset();
    const mod = await import("../organizer-config-cache");
    mod.invalidateOrganizerConfigCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cacheia resultado entre chamadas dentro do TTL", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { api_key: "k", model: "gemini-2.5-flash", provider: "google", enabled: true, execution_hour: 20, last_run: null },
      error: null,
    });
    const { getOrganizerConfig } = await import("../organizer-config-cache");
    const a = await getOrganizerConfig();
    const b = await getOrganizerConfig();
    expect(a).toEqual(b);
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it("refaz query após TTL (60s) expirar", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { api_key: "k", model: "x", provider: "google", enabled: true, execution_hour: 20, last_run: null },
      error: null,
    });
    const { getOrganizerConfig } = await import("../organizer-config-cache");
    await getOrganizerConfig();
    vi.advanceTimersByTime(61_000);
    await getOrganizerConfig();
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("invalidateOrganizerConfigCache força refetch imediato", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { api_key: "k", model: "x", provider: "google", enabled: true, execution_hour: 20, last_run: null },
      error: null,
    });
    const mod = await import("../organizer-config-cache");
    await mod.getOrganizerConfig();
    mod.invalidateOrganizerConfigCache();
    await mod.getOrganizerConfig();
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("não cacheia erro do Supabase (tenta de novo na próxima)", async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: { message: "fail" } })
      .mockResolvedValueOnce({
        data: { api_key: "k", model: "x", provider: "google", enabled: true, execution_hour: 20, last_run: null },
        error: null,
      });
    const { getOrganizerConfig } = await import("../organizer-config-cache");
    const first = await getOrganizerConfig();
    expect(first).toBeNull();
    const second = await getOrganizerConfig();
    expect(second?.model).toBe("x");
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("normaliza enabled=false explícito", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { api_key: null, model: null, provider: null, enabled: false, execution_hour: 7, last_run: "2026-01-01" },
      error: null,
    });
    const { getOrganizerConfig } = await import("../organizer-config-cache");
    const cfg = await getOrganizerConfig();
    expect(cfg?.enabled).toBe(false);
    expect(cfg?.execution_hour).toBe(7);
  });

  it("default execution_hour=20 quando não é número", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { api_key: "k", model: "x", provider: "google", enabled: true, execution_hour: null, last_run: null },
      error: null,
    });
    const { getOrganizerConfig } = await import("../organizer-config-cache");
    const cfg = await getOrganizerConfig();
    expect(cfg?.execution_hour).toBe(20);
  });
});
