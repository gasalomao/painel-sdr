import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { from: (...args: unknown[]) => mocks.from(...args) },
  supabaseAdmin: { from: (...args: unknown[]) => mocks.from(...args) },
}));

vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mocks.from(...args) } }));

vi.mock("puppeteer-extra", () => ({
  default: {
    use: vi.fn(),
    launch: vi.fn(async () => {
      throw new Error("browser fake indisponível");
    }),
  },
}));
vi.mock("puppeteer-extra-plugin-stealth", () => ({ default: vi.fn(() => ({})) }));

import {
  attachSseClient,
  detachSseClient,
  getStatus,
  pauseScraper,
  startScraperRun,
  stopScraper,
} from "../scraper-engine";

const tenantA = "tenant-A";
const tenantB = "tenant-B";

function queryResult(result: unknown = { data: null, error: null }) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "insert", "update", "delete", "eq", "maybeSingle", "single"]) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return query;
}

describe("SEC-H8 scraper tenant isolation", () => {
  beforeEach(() => {
    mocks.from.mockImplementation(() => queryResult());
  });

  afterEach(async () => {
    stopScraper(tenantA, "automation-A");
    stopScraper(tenantA, "automation-B");
    stopScraper(tenantA);
    stopScraper(tenantB);
    await vi.waitFor(() => {
      expect(getStatus(tenantA).isScraping).toBe(false);
      expect(getStatus(tenantA, "automation-A").isScraping).toBe(false);
      expect(getStatus(tenantA, "automation-B").isScraping).toBe(false);
      expect(getStatus(tenantB).isScraping).toBe(false);
    });
  });

  it("rejeita run sem tenant explícito", () => {
    const result = startScraperRun({ niches: ["padaria"], regions: ["Vitória"], client_id: null });

    expect(result).toMatchObject({ ok: false });
    expect(getStatus(null).isScraping).toBe(false);
  });

  it("rejeita mínimo inválido também nas chamadas diretas da automação", () => {
    for (const minReviews of [-1, 1.5, NaN, Infinity, 2147483648]) {
      expect(startScraperRun({ niches: ["padaria"], regions: ["Vitória"], client_id: tenantA, minReviews })).toMatchObject({ ok: false });
    }
    expect(getStatus(tenantA).isScraping).toBe(false);
  });

  it.each([null, "true", "false", 0, 1, [], {}])("rejeita filtro Instagram inválido na entrada direta: %j", (filterWithInstagram) => {
    expect(startScraperRun({
      niches: ["padaria"], regions: ["Vitória"], client_id: tenantA,
      filterWithInstagram: filterWithInstagram as unknown as boolean,
    })).toEqual({ ok: false, error: "Somente com Instagram deve ser um booleano." });
    expect(getStatus(tenantA).isScraping).toBe(false);
  });

  it("impede automações do mesmo tenant de assumir ou controlar o mesmo run", () => {
    const first = startScraperRun({
      niches: ["padaria"],
      regions: ["Vitória"],
      client_id: tenantA,
      automation_id: "automation-A",
    });

    expect(first.ok).toBe(true);
    expect(getStatus(tenantA, "automation-A").isScraping).toBe(true);

    const second = startScraperRun({
      niches: ["clínica"],
      regions: ["Serra"],
      client_id: tenantA,
      automation_id: "automation-B",
      forceRestart: true,
    });

    expect(second).toMatchObject({ ok: false, busy: true });
    expect(pauseScraper(tenantA)).toBe(false);
    expect(stopScraper(tenantA, "automation-B")).toBe(false);
    expect(getStatus(tenantA, "automation-A").isScraping).toBe(true);
  });

  it("mantém singleton ocupado enquanto aguarda checkpoint protegido da automação", async () => {
    let releaseUpdate = (): void => {};
    const pendingUpdate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    mocks.from.mockImplementation((table: string) => {
      const query = queryResult();
      if (table === "automations") {
        query.then = (resolve: (value: unknown) => unknown) => pendingUpdate.then(() => resolve({ data: null, error: null }));
      }
      return query;
    });

    const first = startScraperRun({
      niches: ["padaria"],
      regions: ["Vitória"],
      client_id: tenantA,
      automation_id: "automation-A",
      captureAttemptId: "attempt-a",
    });
    expect(first.ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(getStatus(tenantA, "automation-A").isScraping).toBe(true);
    expect(startScraperRun({ niches: ["clínica"], regions: ["Serra"], client_id: tenantB })).toMatchObject({ ok: false, busy: true });
    releaseUpdate();
    await vi.waitFor(() => expect(getStatus(tenantA, "automation-A").isScraping).toBe(false));
    expect(startScraperRun({ niches: ["clínica"], regions: ["Serra"], client_id: tenantB }).ok).toBe(true);
  });

  it("impede restart e stop do run ativo por outro tenant", () => {
    const first = startScraperRun({
      niches: ["padaria"],
      regions: ["Vitória"],
      client_id: tenantA,
    });

    expect(first.ok).toBe(true);
    expect(getStatus(tenantA).isScraping).toBe(true);

    const foreignRestart = startScraperRun({
      niches: ["clínica"],
      regions: ["Serra"],
      client_id: tenantB,
      forceRestart: true,
    });

    expect(foreignRestart.ok).toBe(false);
    expect(stopScraper(tenantB)).toBe(false);
    expect(getStatus(tenantB)).toEqual({ isScraping: false, isPaused: false, leadCount: 0 });
    expect(getStatus(tenantA).isScraping).toBe(true);
  });

  it("não transmite eventos SSE do run para outro tenant", () => {
    const chunks: Uint8Array[] = [];
    const controller = {
      enqueue: vi.fn((chunk: Uint8Array) => chunks.push(chunk)),
    } as unknown as ReadableStreamDefaultController;

    attachSseClient(controller, tenantB);
    startScraperRun({ niches: ["padaria"], regions: ["Vitória"], client_id: tenantA });
    pauseScraper(tenantA);

    const events = chunks.map((chunk) => new TextDecoder().decode(chunk));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"isScraping":false');
    detachSseClient(controller);
  });
});
