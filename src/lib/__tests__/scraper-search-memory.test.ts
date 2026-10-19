// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), admin: true }));
vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() { return mocks.admin ? { from: mocks.from } : null; },
}));

import { loadExhaustedSearches, makeSearchKey, markSearchExhausted } from "@/lib/scraper-search-memory";

type Setting = { key: string; value: string; updated_at: string };
const NOW = new Date("2026-10-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
let rows: Setting[];
let reads: number;
let readErrorAt: number;
let writeError: boolean;
let unconfirmedWrite: boolean;
let readScopes: string[];
let afterRead: ((data: Setting[]) => void) | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.admin = true;
  rows = []; reads = 0; readErrorAt = 0; writeError = false; unconfirmedWrite = false; readScopes = []; afterRead = null;
  mocks.from.mockImplementation((table: string) => {
    expect(table).toBe("app_settings");
    let scope = "";
    let since = "";
    let until = "";
    let afterKey = "";
    let payload: Setting | null = null;
    const query = {
      select: () => query,
      like: (column: string, value: string) => {
        expect(column).toBe("key");
        scope = value;
        readScopes.push(value);
        return query;
      },
      gte: (column: string, value: string) => { expect(column).toBe("updated_at"); since = value; return query; },
      lte: (column: string, value: string) => { expect(column).toBe("updated_at"); until = value; return query; },
      order: (column: string, options: { ascending: boolean }) => {
        expect(column).toBe("key");
        expect(options.ascending).toBe(true);
        return query;
      },
      gt: (column: string, value: string) => { expect(column).toBe("key"); afterKey = value; return query; },
      range: async (from: number, to: number) => {
        reads++;
        if (reads === readErrorAt) return { data: null, error: { message: "read offline" } };
        // Implement the same prefix/date/range semantics as PostgREST, not canned rows.
        const prefix = scope.slice(0, -1);
        const data = rows.filter(row => row.key.startsWith(prefix) && row.key > afterKey && row.updated_at >= since && row.updated_at <= until)
          .sort((a, b) => a.key.localeCompare(b.key))
          .slice(from, to + 1);
        const snapshot = structuredClone(data);
        afterRead?.(snapshot);
        return { data: snapshot, error: null };
      },
      upsert: (value: Setting, options: { onConflict: string }) => {
        expect(options.onConflict).toBe("key");
        payload = value;
        return query;
      },
      single: async () => {
        if (writeError) return { data: null, error: { message: "write offline" } };
        if (!payload || unconfirmedWrite) return { data: null, error: null };
        const existing = rows.findIndex(row => row.key === payload!.key);
        if (existing === -1) rows.push({ ...payload }); else rows[existing] = { ...payload };
        return { data: { key: payload.key }, error: null };
      },
    };
    return query;
  });
});

afterEach(() => vi.useRealTimers());

describe("makeSearchKey", () => {
  it("normalizes accents, Unicode forms, case and whitespace without collapsing niche/region boundaries", () => {
    expect(makeSearchKey("  CLÍNICA\u00a0  MÉDICA ", " SÃO\n PAULO - SP ", {}))
      .toBe(makeSearchKey("cli\u0301nica me\u0301dica", "sao paulo - sp", {}));
    expect(makeSearchKey("a b", "c", {})).not.toBe(makeSearchKey("a", "b c", {}));
  });

  it.each(["São Paulo SP", "São Paulo - SP", "São Paulo/SP", "São Paulo, SP", "São Paulo — SP"])(
    "normalizes region separators in %s while preserving niche punctuation", region => {
      expect(makeSearchKey("clínica", region, {})).toBe(makeSearchKey("clínica", "sao paulo sp", {}));
      expect(makeSearchKey("a/b", region, {})).not.toBe(makeSearchKey("a b", region, {}));
    },
  );

  it("is compatible across manual/automation settings, defaults, property order and runtime markers", () => {
    const filters = { filterEmpty: true, filterWithWebsite: true, minReviews: 10 };
    expect(makeSearchKey("Dentista", "Vitória - ES", filters)).toBe(makeSearchKey("dentista", "vitoria - es", {
      minReviews: 10, filterWithWebsite: true, filterEmpty: true, filterLandlines: false,
      filterDuplicates: false, filterWithInstagram: false, _captureAttemptId: "other", _capturedLeadIds: [1],
      _scrapeFinishedAt: NOW.toISOString(), maxLeads: 99, topup: true, forceRestart: true,
      captureAllReviews: true, mode: "batch", client_id: "other", automation_id: "other",
      reviews_ai: { enabled: true }, webhookEnabled: true, webhookUrl: "https://example.invalid",
    }));
    expect(makeSearchKey("Dentista", "Vitória", {})).toBe(makeSearchKey("Dentista", "Vitória", { minReviews: 0 }));
  });

  it.each(["filterEmpty", "filterDuplicates", "filterLandlines", "filterWithWebsite", "filterWithInstagram", "minReviews"])(
    "includes eligibility field %s", field => {
      expect(makeSearchKey("dentista", "vitoria", { [field]: field === "minReviews" ? 5 : true }))
        .not.toBe(makeSearchKey("dentista", "vitoria", {}));
    },
  );

  it("distinguishes niches and regions", () => {
    const key = makeSearchKey("dentista", "vitoria - es", {});
    expect(key).not.toBe(makeSearchKey("mecanico", "vitoria - es", {}));
    expect(key).not.toBe(makeSearchKey("dentista", "vitoria - ba", {}));
  });

  it("rejects invalid query/filter values instead of sharing another search's memory", () => {
    expect(() => makeSearchKey("  ", "vitoria", {})).toThrow();
    expect(() => makeSearchKey("dentista", "", {})).toThrow();
    expect(() => makeSearchKey("dentista", "vitoria", { minReviews: -1 })).toThrow();
    expect(() => makeSearchKey("dentista", "vitoria", { minReviews: "5" })).toThrow();
    expect(() => makeSearchKey("dentista", "vitoria", { filterWithInstagram: "false" })).toThrow();
  });
});

describe("persistent exhaustion memory", () => {
  it("round-trips an exhausted route across calls without an automation", async () => {
    const filters = { filterEmpty: true, minReviews: 20 };
    expect(await markSearchExhausted("client-a", "Clínica", "Vitória - ES", filters, "exhausted")).toBe(true);
    const loaded = await loadExhaustedSearches("client-a", filters);
    expect(loaded).toEqual(new Set([makeSearchKey("clinica", "vitoria - es", filters)]));
    expect(rows).toHaveLength(1);
  });

  it("round-trips different region separator formats through one durable record", async () => {
    await markSearchExhausted("client-a", "Clínica", "São Paulo - SP", {}, "exhausted");
    const loaded = await loadExhaustedSearches("client-a", {});
    for (const region of ["São Paulo SP", "São Paulo - SP", "São Paulo/SP", "São Paulo, SP"]) {
      expect(loaded.has(makeSearchKey("clínica", region, {}))).toBe(true);
      await markSearchExhausted("client-a", "Clínica", region, {}, "exhausted");
    }
    expect(rows).toHaveLength(1);
  });

  it("refreshes one record rather than appending a record for every run", async () => {
    await markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted");
    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    await markSearchExhausted("client-a", "DENTÍSTA", "VITÓRIA", {}, "exhausted");
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toBe(new Date(NOW.getTime() + DAY).toISOString());
  });

  it("scopes every read and write to the tenant, including SQL wildcard characters", async () => {
    await markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted");
    await markSearchExhausted("client-b", "mecanico", "serra", {}, "exhausted");
    expect(await loadExhaustedSearches("client-a")).toEqual(new Set([makeSearchKey("dentista", "vitoria", {})]));
    expect(await loadExhaustedSearches("client-b")).toEqual(new Set([makeSearchKey("mecanico", "serra", {})]));
    expect(await loadExhaustedSearches("%_")).toEqual(new Set());
    expect(new Set(rows.map(row => row.key)).size).toBe(2);
    expect(new Set(readScopes).size).toBe(3);
    expect(readScopes.every(scope => !scope.slice(0, -1).includes("%") && !scope.includes("_"))).toBe(true);
  });

  it("loads only compatible eligibility filters when supplied, otherwise all tenant searches", async () => {
    await markSearchExhausted("client-a", "dentista", "vitoria", { filterWithWebsite: true }, "exhausted");
    await markSearchExhausted("client-a", "dentista", "vitoria", { filterWithInstagram: true }, "exhausted");
    expect(await loadExhaustedSearches("client-a", { filterWithWebsite: true, _attempt: 2, maxLeads: 5 }))
      .toEqual(new Set([makeSearchKey("dentista", "vitoria", { filterWithWebsite: true })]));
    expect((await loadExhaustedSearches("client-a")).size).toBe(2);
  });

  it("expires routes after seven days and never accepts future timestamps", async () => {
    await markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted");
    vi.setSystemTime(new Date(NOW.getTime() - 1));
    expect((await loadExhaustedSearches("client-a")).size).toBe(0);
    vi.setSystemTime(new Date(NOW.getTime() + 7 * DAY - 1));
    expect((await loadExhaustedSearches("client-a")).size).toBe(1);
    vi.setSystemTime(new Date(NOW.getTime() + 7 * DAY + 1));
    expect((await loadExhaustedSearches("client-a")).size).toBe(0);
  });

  it.each(["goal_reached", "stopped", "timeout", "error"] as const)("does not mark %s as exhausted", async outcome => {
    expect(await markSearchExhausted("client-a", "dentista", "vitoria", {}, outcome)).toBe(false);
    expect(rows).toHaveLength(0);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("does not overwrite other global application settings", async () => {
    const unrelated = { key: "evolution_instance", value: "instance-1", updated_at: NOW.toISOString() };
    rows.push(unrelated);
    await markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted");
    expect(rows[0]).toEqual(unrelated);
    expect((await loadExhaustedSearches("client-a")).size).toBe(1);
  });

  it("pages through recent records without silently truncating at PostgREST's default limit", async () => {
    for (let index = 0; index < 205; index++) {
      await markSearchExhausted("client-a", "dentista", `bairro ${index}`, {}, "exhausted");
    }
    expect((await loadExhaustedSearches("client-a")).size).toBe(205);
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(10);
  });

  it("does not skip unvisited records when a concurrent refresh removes an earlier page row", async () => {
    for (let index = 0; index < 105; index++) {
      await markSearchExhausted("client-a", "dentista", `bairro ${index}`, {}, "exhausted");
    }
    afterRead = data => {
      afterRead = null;
      rows.find(row => row.key === data[0].key)!.updated_at = new Date(NOW.getTime() + 1).toISOString();
    };
    expect((await loadExhaustedSearches("client-a")).size).toBe(105);
  });

  it("fails closed on a pagination error instead of returning partial memory", async () => {
    for (let index = 0; index < 105; index++) {
      await markSearchExhausted("client-a", "dentista", `bairro ${index}`, {}, "exhausted");
    }
    readErrorAt = 2;
    await expect(loadExhaustedSearches("client-a")).rejects.toThrow("read offline");
  });

  it("loads exactly 1000 recent records, checking the final empty page", async () => {
    for (let index = 0; index < 1000; index++) {
      await markSearchExhausted("client-a", "dentista", `bairro ${index}`, {}, "exhausted");
    }
    expect((await loadExhaustedSearches("client-a")).size).toBe(1000);
    expect(reads).toBe(11);
  });

  it("loads compatible searches beyond 1000 unrelated niche/filter records without blocking a new search", async () => {
    for (let index = 0; index < 1001; index++) {
      await markSearchExhausted("client-a", "dentista", `bairro ${index}`, { filterEmpty: true }, "exhausted");
    }
    const filters = { filterWithInstagram: true };
    await markSearchExhausted("client-a", "mecanico", "vitoria", filters, "exhausted");
    expect(await loadExhaustedSearches("client-a", filters))
      .toEqual(new Set([makeSearchKey("mecanico", "vitoria", filters)]));
    const all = await loadExhaustedSearches("client-a");
    expect(all.size).toBe(1002);
    expect(all.has(makeSearchKey("mecanico", "serra", filters))).toBe(false);
  });

  it("keeps start-time date bounds when new routes are inserted during pagination", async () => {
    for (let index = 0; index < 105; index++) {
      await markSearchExhausted("client-a", "dentista", `bairro ${index}`, {}, "exhausted");
    }
    afterRead = () => {
      afterRead = null;
      const memory = { clientId: "client-a", niche: "new", region: "new", filters: {} };
      const prefix = rows[0].key.slice(0, -makeSearchKey("dentista", "bairro 0", {}).length);
      rows.push({ key: `${prefix}${makeSearchKey("new", "new", {})}`, value: JSON.stringify(memory), updated_at: new Date(NOW.getTime() + 1).toISOString() });
      vi.setSystemTime(new Date(NOW.getTime() + DAY));
    };
    const loaded = await loadExhaustedSearches("client-a");
    expect(loaded.size).toBe(105);
    expect(loaded.has(makeSearchKey("new", "new", {}))).toBe(false);
  });

  it("fails closed immediately when a faulty page repeats the previous cursor", async () => {
    for (let index = 0; index < 105; index++) {
      await markSearchExhausted("client-a", "dentista", `bairro ${index}`, {}, "exhausted");
    }
    let previousLast: Setting;
    afterRead = data => {
      previousLast = data[data.length - 1];
      afterRead = next => {
        afterRead = null;
        next[0] = previousLast;
      };
    };
    await expect(loadExhaustedSearches("client-a")).rejects.toThrow(/cursor/i);
    expect(reads).toBe(2);
  });

  it("fails closed when page keys are out of order", async () => {
    await markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted");
    await markSearchExhausted("client-a", "dentista", "serra", {}, "exhausted");
    afterRead = data => data.reverse();
    await expect(loadExhaustedSearches("client-a")).rejects.toThrow(/cursor/i);
    expect(reads).toBe(1);
  });

  it("fails closed on storage errors or unconfirmed writes", async () => {
    readErrorAt = 1;
    await expect(loadExhaustedSearches("client-a")).rejects.toThrow("read offline");
    writeError = true;
    await expect(markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted")).rejects.toThrow("write offline");
    writeError = false; unconfirmedWrite = true;
    await expect(markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted")).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });

  it("does not silently treat corrupt or foreign-tenant payloads as empty memory", async () => {
    await markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted");
    const stored = rows[0].value;
    rows[0].value = "invalid JSON";
    await expect(loadExhaustedSearches("client-a")).rejects.toThrow();
    rows[0].value = JSON.stringify({ ...JSON.parse(stored), clientId: "client-b" });
    await expect(loadExhaustedSearches("client-a")).rejects.toThrow();
  });

  it("requires a tenant and a real admin client before touching persistence", async () => {
    await expect(loadExhaustedSearches(" ")).rejects.toThrow(/cliente/i);
    await expect(markSearchExhausted("", "dentista", "vitoria", {}, "exhausted")).rejects.toThrow(/cliente/i);
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.admin = false;
    await expect(loadExhaustedSearches("client-a")).rejects.toThrow(/supabase|admin/i);
    await expect(markSearchExhausted("client-a", "dentista", "vitoria", {}, "exhausted")).rejects.toThrow(/supabase|admin/i);
  });
});
