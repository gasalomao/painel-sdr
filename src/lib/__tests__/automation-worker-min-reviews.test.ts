// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Table = "automations" | "leads_extraidos" | "automation_logs" | "campaigns" | "campaign_targets" | "followup_campaigns" | "followup_targets";
type QueryResult = { data: Row | Row[] | null; count: number; error: null };

const state = vi.hoisted(() => ({
  tables: {
    automations: [], leads_extraidos: [], automation_logs: [], campaigns: [], campaign_targets: [], followup_campaigns: [], followup_targets: [],
  } as Record<Table, Row[]>,
  startScraperRun: vi.fn(),
  getScraperStatus: vi.fn(),
  startCampaign: vi.fn(),
  pauseCampaign: vi.fn(),
  stopScraper: vi.fn(),
  failCaptureWrite: false,
  beforeQuery: vi.fn(),
  enrollLeads: vi.fn(),
  checkWhatsAppNumbersDetailed: vi.fn(),
}));

// Fake da fronteira Supabase: executa filtros/claims reais montados pelo worker,
// sem reproduzir o mapper de opções nem a decisão de conclusão da captação.
class Query implements PromiseLike<QueryResult> {
  private filters: Array<(row: Row) => boolean> = [];
  private patch: Row | null = null;
  private inserts: Row[] | null = null;
  private selected = "*";
  private one = false;
  private maximum = Infinity;
  private sort: { column: string; ascending: boolean } | null = null;

  constructor(private table: Table) {}

  select(columns = "*") { this.selected = columns; return this; }
  update(data: Row) { this.patch = data; return this; }
  insert(data: Row | Row[]) { this.inserts = Array.isArray(data) ? data : [data]; return this; }
  upsert(data: Row | Row[]) { return this.insert(data); }
  eq(column: string, value: unknown) {
    this.filters.push(row => column.includes("->")
      ? column.split(/->>?/).reduce<unknown>((part, key) => part && typeof part === "object" ? (part as Row)[key] : undefined, row) === value
      : row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) { this.filters.push(row => values.includes(row[column])); return this; }
  neq(column: string, value: unknown) { this.filters.push(row => row[column] !== value); return this; }
  is(column: string, value: unknown) { return this.eq(column, value); }
  not(column: string, operator: string, value: unknown) {
    if (operator === "in") {
      const excluded = String(value).slice(1, -1).split(",").map(Number);
      this.filters.push(row => !excluded.includes(Number(row[column])));
      return this;
    }
    return this.neq(column, value);
  }
  gt(column: string, value: number) { this.filters.push(row => Number(row[column]) > value); return this; }
  gte(column: string, value: string) { this.filters.push(row => String(row[column]) >= value); return this; }
  order(column: string, options: { ascending: boolean }) { this.sort = { column, ...options }; return this; }
  limit(maximum: number) { this.maximum = maximum; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { return this.maybeSingle(); }

  private execute(): QueryResult {
    const table = state.tables[this.table];
    let rows = table.filter(row => this.filters.every(filter => filter(row)));
    if (this.patch) rows.forEach(row => Object.assign(row, structuredClone(this.patch)));
    if (this.inserts) {
      rows = this.inserts.map(row => ({ id: `${this.table}-${table.length + 1}`, ...structuredClone(row) }));
      table.push(...rows);
    }
    if (this.sort) {
      const { column, ascending } = this.sort;
      rows.sort((a, b) => (Number(a[column]) - Number(b[column])) * (ascending ? 1 : -1));
    }
    const projected = rows.slice(0, this.maximum).map(row => this.selected === "*"
      ? structuredClone(row)
      : Object.fromEntries(this.selected.split(",").map(column => [column.trim(), structuredClone(row[column.trim()])])));
    return { data: this.one ? projected[0] ?? null : projected, count: rows.length, error: null };
  }

  then<T = QueryResult, U = never>(
    fulfilled?: ((value: QueryResult) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => U | PromiseLike<U>) | null,
  ): Promise<T | U> {
    return Promise.resolve(state.beforeQuery(this.table, this.patch, this.inserts)).then(() => this.execute()).then(fulfilled, rejected);
  }
}

vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: (table: Table) => new Query(table) } }));
vi.mock("@/lib/scraper-engine", () => ({
  startScraperRun: state.startScraperRun,
  getStatus: state.getScraperStatus,
  stopScraper: state.stopScraper,
}));
vi.mock("@/lib/automation-capture", () => {
  const ids = (filters: Row, key: string): number[] => [...new Set(
    (Array.isArray(filters[key]) ? filters[key] : []).filter((id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0),
  )];
  return {
    readCaptureIds: (filters: Row) => ids(filters, "_capturedLeadIds"),
    readRejectedCaptureIds: (filters: Row) => ids(filters, "_rejectedLeadIds"),
    updateAutomationCapture: async (clientId: string, id: string, mutate: (current: Row) => Row | null) => {
      if (state.failCaptureWrite) throw new Error("checkpoint indisponível");
      const row = state.tables.automations.find(item => item.id === id && item.client_id === clientId);
      if (!row) return null;
      const patch = mutate(structuredClone(row));
      if (!patch) return null;
      Object.assign(row, structuredClone(patch));
      return structuredClone(row);
    },
  };
});
vi.mock("@/lib/campaign-worker", () => ({ startCampaign: state.startCampaign, pauseCampaign: state.pauseCampaign }));
vi.mock("@/lib/followup-worker", () => ({ enrollLeads: state.enrollLeads }));
vi.mock("@/lib/channel", () => ({ checkWhatsAppNumbersDetailed: state.checkWhatsAppNumbersDetailed }));
vi.mock("@/lib/evolution", () => ({ evolution: {} }));
vi.mock("@/lib/reviews-ai", () => ({ summarizeReviewsForLead: vi.fn() }));

const CLIENT = "tenant-a";
const ID = "automation-a";
const NOW = new Date("2026-10-18T12:00:00.000Z");
const INVALID_PHONE = "5511999990011";
let worker: typeof import("../automation-worker");

function automation(overrides: Row = {}): Row {
  return {
    id: ID,
    client_id: CLIENT,
    name: "Prospecção",
    status: "paused",
    phase: "paused",
    niches: ["Dentistas"],
    regions: ["Curitiba, PR"],
    scrape_max_leads: 20,
    scrape_filters: {},
    scraped_count: 0,
    instance_name: "whatsapp-teste",
    dispatch_template: "Olá, {{nome_negocio}}",
    dispatch_min_interval: 30,
    dispatch_max_interval: 60,
    allowed_start_hour: 8,
    allowed_end_hour: 18,
    dispatch_personalize: false,
    lead_intelligence_enabled: false,
    followup_enabled: false,
    ...overrides,
  };
}

function lead(id: number, clientId = CLIENT): Row {
  return {
    id,
    client_id: clientId,
    remoteJid: `551199999${String(id).padStart(4, "0")}@s.whatsapp.net`,
    nome_negocio: `Negócio ${id}`,
    ramo_negocio: "Dentista",
    created_at: "2026-10-18T11:59:00.000Z",
  };
}

function seedScraping(saved: number, elapsedMinutes = 6, filters: Row = {}, maximum = 20): Row {
  const started = new Date(NOW.getTime() - elapsedMinutes * 60_000).toISOString();
  const row = automation({
    status: "running",
    phase: "scraping",
    started_at: started,
    scrape_max_leads: maximum,
    scraped_count: saved,
    scrape_filters: {
      minReviews: 100,
      _captureSessionId: "session-a",
      _captureAttemptId: "attempt-a",
      _capturedLeadIds: Array.from({ length: saved }, (_, i) => 11 + i),
      _rejectedLeadIds: [],
      _baselineCount: 1,
      _baselineMaxId: 10,
      _scrapeStartedAt: started,
      _lastProgressAt: started,
      ...filters,
    },
  });
  state.tables.automations.push(row);
  state.tables.leads_extraidos.push(
    { ...lead(10), created_at: "2026-10-18T10:00:00.000Z" },
    lead(1000, "tenant-b"),
    ...Array.from({ length: saved }, (_, i) => lead(11 + i)),
  );
  return row;
}

function expectNoDispatch(row: Row, saved: number): void {
  expect(row).toMatchObject({ status: "running", phase: "scraping", scraped_count: saved });
  expect(state.tables.campaigns).toHaveLength(0);
  expect(state.tables.campaign_targets).toHaveLength(0);
  expect(state.startCampaign).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Rede externa proibida neste teste"); }));
  for (const table of Object.values(state.tables)) table.length = 0;
  state.startScraperRun.mockReset().mockReturnValue({ ok: true });
  state.getScraperStatus.mockReset().mockReturnValue({ isScraping: false, isPaused: false, leadCount: 0 });
  state.startCampaign.mockReset().mockImplementation(async (id: string) => {
    const campaign = state.tables.campaigns.find(row => row.id === id);
    if (campaign) campaign.status = "running";
    return { ok: true };
  });
  state.pauseCampaign.mockReset().mockResolvedValue(undefined);
  state.stopScraper.mockReset().mockReturnValue(true);
  state.failCaptureWrite = false;
  state.beforeQuery.mockReset();
  state.enrollLeads.mockReset().mockResolvedValue({ ok: true, enrolled: 1 });
  state.checkWhatsAppNumbersDetailed.mockReset().mockImplementation(async (phones: string[]) =>
    Object.fromEntries(phones.map(phone => [phone, { exists: true, jid: `${phone}@s.whatsapp.net` }])));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  worker = await import("../automation-worker");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("automation-worker — minReviews pelas entradas reais", () => {
  it.each([120, 0, undefined])("startAutomation encaminha mínimo %s (legado usa 0)", async minimum => {
    const row = automation({
      scrape_filters: {
        ...(minimum === undefined ? {} : { minReviews: minimum }),
        filterEmpty: false,
        filterDuplicates: false,
        filterLandlines: true,
        filterWithWebsite: true,
        captureAllReviews: true,
        _scrapeFinishedAt: "2026-10-17T12:00:00.000Z",
      },
    });
    state.tables.automations.push(row);

    expect(await worker.startAutomation(ID, CLIENT)).toEqual({ ok: true, phase: "scraping" });
    expect(state.startScraperRun).toHaveBeenCalledOnce();
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({
      niches: ["Dentistas"], regions: ["Curitiba, PR"],
      minReviews: minimum ?? 0,
      filterEmpty: false, filterDuplicates: false, filterLandlines: true,
      filterWithWebsite: true, captureAllReviews: true,
      client_id: CLIENT, automation_id: ID, maxLeads: 20, forceRestart: false, webhookEnabled: false,
    }));
    expect((row.scrape_filters as Row)._scrapeFinishedAt).toBeFalsy();
    if (minimum !== undefined) expect(row.scrape_filters).toHaveProperty("minReviews", minimum);
    state.getScraperStatus.mockReturnValue({ isScraping: true });
    await worker.tickAllAutomations();
    expectNoDispatch(row, 0);
  });

  it.each([null, false, "", "100", -1, 1.5, Number.NaN])("não transforma mínimo malformado %s em filtro desligado", async minimum => {
    const row = automation({ scrape_filters: { minReviews: minimum } });
    state.tables.automations.push(row);
    state.startScraperRun.mockReturnValue({ ok: false, error: "minReviews inválido" });

    const result = await worker.startAutomation(ID, CLIENT);

    expect(state.startScraperRun.mock.calls[0][0].minReviews).toBe(minimum);
    expect(result).toEqual({ ok: false, error: "Scraper rejeitou: minReviews inválido" });
    expect(row).toMatchObject({ status: "error", phase: "error" });
    expect(state.startCampaign).not.toHaveBeenCalled();
  });

  it.each([150, undefined])("reposição usa o mesmo mínimo %s e mantém escopo do tenant", async minimum => {
    const row = seedScraping(2, 6, { _scrapeFinishedAt: NOW.toISOString() }, 2);
    const filters = row.scrape_filters as Row;
    if (minimum === undefined) delete filters.minReviews;
    else filters.minReviews = minimum;
    state.checkWhatsAppNumbersDetailed.mockImplementation(async (phones: string[]) =>
      Object.fromEntries(phones.map(phone => [phone, { exists: phone !== INVALID_PHONE, jid: `${phone}@s.whatsapp.net` }])));
    state.startScraperRun.mockImplementation(() => {
      state.tables.leads_extraidos.push(lead(13));
      return { ok: true };
    });

    expect(await worker.tickAllAutomations()).toBe(1);
    expectNoDispatch(row, 1);
    expect(state.startScraperRun).not.toHaveBeenCalled();
    expect(row.scrape_filters).toHaveProperty("_rejectedLeadIds", [11]);
    vi.advanceTimersByTime(60_000);
    await worker.tickAllAutomations();

    expect(state.startScraperRun).toHaveBeenCalledOnce();
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({
      minReviews: minimum ?? 0, client_id: CLIENT, automation_id: ID,
      maxLeads: 1, topup: true, forceRestart: false, webhookEnabled: false,
    }));
    expectNoDispatch(row, 1);
    expect(state.getScraperStatus).toHaveBeenCalledWith(CLIENT, ID);
  });

  it.each([null, false])("reposição deixa a engine rejeitar mínimo malformado %s sem desativá-lo", async minimum => {
    seedScraping(2, 6, { minReviews: minimum, _scrapeFinishedAt: NOW.toISOString() }, 2);
    state.checkWhatsAppNumbersDetailed.mockResolvedValue({ [INVALID_PHONE]: { exists: false } });
    state.startScraperRun.mockReturnValue({ ok: false, error: "minReviews inválido" });

    await worker.tickAllAutomations();
    vi.advanceTimersByTime(60_000);
    await worker.tickAllAutomations();

    expect(state.startScraperRun.mock.calls[0][0].minReviews).toBe(minimum);
    expect(state.tables.automation_logs).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("minReviews inválido"),
    }));
  });
});

describe("automation-worker — filterWithInstagram pelas entradas reais", () => {
  it.each([undefined, false, true])("início encaminha Instagram %s (legado usa false)", async filterWithInstagram => {
    const filters = {
      ...(filterWithInstagram === undefined ? {} : { filterWithInstagram }),
      minReviews: 100, filterEmpty: true, filterDuplicates: true,
      filterLandlines: true, filterWithWebsite: true, _source: "prospeccao-sites",
    };
    const row = automation({ scrape_filters: filters });
    state.tables.automations.push(row);

    expect(await worker.startAutomation(ID, CLIENT)).toEqual({ ok: true, phase: "scraping" });
    expect(state.startScraperRun).toHaveBeenCalledOnce();
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({
      filterWithInstagram: filterWithInstagram ?? false,
      minReviews: 100, filterEmpty: true, filterDuplicates: true,
      filterLandlines: true, filterWithWebsite: true, captureAllReviews: false,
      client_id: CLIENT, automation_id: ID, forceRestart: false, webhookEnabled: false,
    }));
    expect(state.startScraperRun.mock.calls[0][0].reviews_ai).toBeUndefined();
    expect(row.scrape_filters).toMatchObject(filters);
    expect(row.scrape_filters).toHaveProperty("_captureSessionId", expect.any(String));
    expect(row.scrape_filters).toHaveProperty("_capturedLeadIds", []);
  });

  it.each([null, 0, 1, "true", "false", "", [], {}].map(filterWithInstagram => ({ filterWithInstagram })))
    ("início deixa a engine rejeitar Instagram inválido $filterWithInstagram", async ({ filterWithInstagram }) => {
      const row = automation({ scrape_filters: { filterWithInstagram } });
      state.tables.automations.push(row);
      state.startScraperRun.mockReturnValue({ ok: false, error: "filterWithInstagram inválido" });

      const result = await worker.startAutomation(ID, CLIENT);

      expect(state.startScraperRun.mock.calls[0][0].filterWithInstagram).toEqual(filterWithInstagram);
      expect(result).toEqual({ ok: false, error: "Scraper rejeitou: filterWithInstagram inválido" });
      expect(row).toMatchObject({ status: "error", phase: "error" });
      expect(state.startCampaign).not.toHaveBeenCalled();
    });

  it.each([undefined, false, true])("reposição encaminha Instagram %s junto dos filtros e escopo", async filterWithInstagram => {
    const row = seedScraping(2, 6, {
      ...(filterWithInstagram === undefined ? {} : { filterWithInstagram }),
      filterWithWebsite: true, _source: "prospeccao-sites", _scrapeFinishedAt: NOW.toISOString(),
    }, 2);
    state.checkWhatsAppNumbersDetailed.mockImplementation(async (phones: string[]) =>
      Object.fromEntries(phones.map(phone => [phone, { exists: phone !== INVALID_PHONE, jid: `${phone}@s.whatsapp.net` }])));
    state.startScraperRun.mockImplementation(() => {
      state.tables.leads_extraidos.push(lead(13));
      return { ok: true };
    });

    await worker.tickAllAutomations();
    expectNoDispatch(row, 1);
    vi.advanceTimersByTime(60_000);
    await worker.tickAllAutomations();

    expect(state.startScraperRun).toHaveBeenCalledOnce();
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({
      filterWithInstagram: filterWithInstagram ?? false,
      minReviews: 100, filterWithWebsite: true, captureAllReviews: false,
      client_id: CLIENT, automation_id: ID, maxLeads: 1, topup: true, forceRestart: false,
    }));
    expect(state.startScraperRun.mock.calls[0][0].reviews_ai).toBeUndefined();
    expect(row.scrape_filters).toMatchObject({ minReviews: 100, _baselineMaxId: 10, _source: "prospeccao-sites", _rejectedLeadIds: [11] });
    if (filterWithInstagram !== undefined) expect(row.scrape_filters).toHaveProperty("filterWithInstagram", filterWithInstagram);
    expectNoDispatch(row, 1);
  });

  it.each([null, 0, 1, "true", "false", "", [], {}].map(filterWithInstagram => ({ filterWithInstagram })))
    ("reposição não converte Instagram inválido $filterWithInstagram para false", async ({ filterWithInstagram }) => {
      seedScraping(2, 6, { filterWithInstagram, _scrapeFinishedAt: NOW.toISOString() }, 2);
      state.checkWhatsAppNumbersDetailed.mockResolvedValue({ [INVALID_PHONE]: { exists: false } });
      state.startScraperRun.mockReturnValue({ ok: false, error: "filterWithInstagram inválido" });

      await worker.tickAllAutomations();
      vi.advanceTimersByTime(60_000);
      await worker.tickAllAutomations();

      expect(state.startScraperRun.mock.calls[0][0].filterWithInstagram).toEqual(filterWithInstagram);
      expect(state.tables.automation_logs).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("filterWithInstagram inválido"),
      }));
    });

  it.each([0, 2])("não avança por inatividade com Instagram ligado e %s aprovados enquanto engine ativa", async saved => {
    const row = seedScraping(saved, 16, { filterWithInstagram: true });
    state.getScraperStatus.mockReturnValue({ isScraping: true, automationId: ID });

    await worker.tickAllAutomations();

    expectNoDispatch(row, saved);
    expect(state.getScraperStatus).toHaveBeenCalledWith(CLIENT, ID);
  });
});

describe("automation-worker — checkpoint resiliente", () => {
  it("retoma 13/20 sem cancelar campanhas nem perder sessão e solicita somente 7", async () => {
    const row = seedScraping(13);
    row.status = "paused";
    const original = structuredClone(row.scrape_filters) as Row;
    state.startScraperRun.mockImplementation((opts: Row) => {
      expect(row.scrape_filters).toMatchObject({ _captureSessionId: original._captureSessionId, _captureAttemptId: opts.captureAttemptId });
      return { ok: true };
    });
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: true });
    expectNoDispatch(row, 13);
    expect(row.scrape_filters).toMatchObject({ _scrapeStartedAt: original._scrapeStartedAt, _baselineMaxId: 10, _capturedLeadIds: original._capturedLeadIds });
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({ maxLeads: 7, forceRestart: false, captureAttemptId: expect.any(String) }));
    expect(state.pauseCampaign).not.toHaveBeenCalled();
  });

  it("retoma DONE antigo abaixo da meta quando existe vínculo exato", async () => {
    const row = seedScraping(13, 1, { _captureAttemptId: null, _scrapeFinishedAt: NOW.toISOString() });
    row.status = "done";
    row.phase = "done";
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: true, phase: "scraping" });
    expectNoDispatch(row, 13);
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({ maxLeads: 7 }));
  });

  it("DONE legado abaixo da meta sem vínculo devolve erro sem perder a contagem", async () => {
    const row = automation({ status: "done", phase: "done", scraped_count: 13 });
    state.tables.automations.push(row);
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: false, error: expect.stringMatching(/legado|vínculo/i) });
    expect(row.scraped_count).toBe(13);
    expect(state.startScraperRun).not.toHaveBeenCalled();
  });

  it("retoma na meta sem abrir scraper e inicia disparo imediatamente", async () => {
    const row = seedScraping(20, 1, { _captureAttemptId: null });
    row.status = "paused";
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: true, phase: "dispatching" });
    expect(state.startScraperRun).not.toHaveBeenCalled();
    expect(state.startCampaign).toHaveBeenCalledOnce();
    expect(state.tables.campaign_targets).toHaveLength(20);
  });

  it("reconcilia INSERT confirmado sem checkpoint só pelo marcador da sessão/tenant", async () => {
    const row = seedScraping(13);
    row.status = "paused";
    state.tables.leads_extraidos.push(
      { ...lead(30), business_details: { _automationCapture: { automationId: ID, sessionId: "session-a", attemptId: "old-attempt" } } },
      { ...lead(31), business_details: { _automationCapture: { automationId: "other", sessionId: "session-a" } } },
      { ...lead(32, "tenant-b"), business_details: { _automationCapture: { automationId: ID, sessionId: "session-a" } } },
    );
    await worker.startAutomation(ID, CLIENT);
    expectNoDispatch(row, 14);
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({ maxLeads: 6 }));
    expect((row.scrape_filters as Row)._capturedLeadIds).toContain(30);
  });

  it("legado 13 sem vínculo é erro recuperável sem zerar ou anexar o CRM", async () => {
    const row = automation({ scraped_count: 13, scrape_filters: { _baselineMaxId: 1 } });
    state.tables.automations.push(row);
    state.tables.leads_extraidos.push(...Array.from({ length: 20 }, (_, i) => lead(2 + i)));
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: false, error: expect.stringMatching(/vínculo|legad|propriedade/i) });
    expect(row.scraped_count).toBe(13);
    expect(state.startScraperRun).not.toHaveBeenCalled();
    expect(state.tables.campaigns).toHaveLength(0);
  });

  it("contagem de outra automação no mesmo CRM não satisfaz a meta", async () => {
    const row = seedScraping(13);
    state.tables.leads_extraidos.push(...Array.from({ length: 30 }, (_, i) => lead(100 + i)));
    state.getScraperStatus.mockReturnValue({ isScraping: true, automationId: ID });
    await worker.tickAllAutomations();
    expectNoDispatch(row, 13);
  });

  it("lease de outro processo impede roubar tentativa ainda ativa", async () => {
    const row = seedScraping(13, 1, { _captureLeaseUntil: new Date(NOW.getTime() + 120_000).toISOString() });
    await worker.tickAllAutomations();
    expectNoDispatch(row, 13);
    expect(row.scrape_filters).not.toHaveProperty("_captureRetryAt");
    expect((row.scrape_filters as Row)._captureAttemptId).toBe("attempt-a");
    expect(state.startScraperRun).not.toHaveBeenCalled();
  });

  it("retry persistido sobrevive restart e respeita espera limitada", async () => {
    const row = seedScraping(13);
    await worker.tickAllAutomations();
    const retry = (row.scrape_filters as Row)._captureRetryAt;
    vi.resetModules();
    worker = await import("../automation-worker");
    await worker.tickAllAutomations();
    expect((row.scrape_filters as Row)._captureRetryAt).toBe(retry);
    expect(state.startScraperRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    await worker.tickAllAutomations();
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({ maxLeads: 7 }));
    expectNoDispatch(row, 13);
  });

  it("persiste pausa e invalida tentativa antes de parar scraper, independente da fase", async () => {
    const row = seedScraping(13);
    row.phase = "dispatching";
    state.getScraperStatus.mockReturnValue({ isScraping: true, automationId: ID });
    state.stopScraper.mockImplementation(() => {
      expect(row).toMatchObject({ status: "paused", phase: "dispatching", scraped_count: 13 });
      expect((row.scrape_filters as Row)._captureAttemptId).toBeNull();
      return true;
    });
    expect(await worker.pauseAutomation(ID, CLIENT)).toMatchObject({ ok: true, stopped: { scraper: true } });
    expect(state.stopScraper).toHaveBeenCalledWith(CLIENT, ID);
  });

  it("falha de checkpoint não inicia engine", async () => {
    state.tables.automations.push(automation());
    state.failCaptureWrite = true;
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: false });
    expect(state.startScraperRun).not.toHaveBeenCalled();
  });

  it.each(["done", "running", "paused"])("retomar dispatch %s não reinicia targets sem pending ou com processing", async status => {
    const row = seedScraping(20, 1, { _captureAttemptId: null });
    row.phase = "dispatching";
    row.campaign_id = "camp-a";
    state.tables.campaigns.push({ id: "camp-a", client_id: CLIENT, status });
    state.tables.campaign_targets.push({ campaign_id: "camp-a", client_id: CLIENT, status: "processing", remote_jid: lead(11).remoteJid });
    await worker.startAutomation(ID, CLIENT);
    expect(row.campaign_id).toBe("camp-a");
    expect(state.tables.campaigns[0].status).toBe(status);
    expect(state.startCampaign).not.toHaveBeenCalled();
    expect(state.pauseCampaign).not.toHaveBeenCalled();
    expect(state.startScraperRun).not.toHaveBeenCalled();
  });

  it("pausa durante follow-up não altera campanha de disparo já concluída", async () => {
    const row = automation({ status: "running", phase: "following", campaign_id: "camp-a", followup_campaign_id: "follow-a" });
    state.tables.automations.push(row);
    state.tables.campaigns.push({ id: "camp-a", client_id: CLIENT, status: "done" });
    state.tables.followup_campaigns.push({ id: "follow-a", client_id: CLIENT, status: "active" });
    await worker.pauseAutomation(ID, CLIENT);
    expect(state.pauseCampaign).not.toHaveBeenCalled();
    expect(state.tables.campaigns[0].status).toBe("done");
    expect(state.tables.followup_campaigns[0].status).toBe("paused");
  });

  it("não retoma disparo legado abaixo da meta nem recria sua campanha", async () => {
    const row = automation({ phase: "dispatching", campaign_id: "camp-a", scraped_count: 13 });
    state.tables.automations.push(row);
    state.tables.campaigns.push({ id: "camp-a", client_id: CLIENT, status: "paused" });
    state.tables.campaign_targets.push({ campaign_id: "camp-a", client_id: CLIENT, status: "pending" });
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: false, error: expect.stringMatching(/meta|legado|vínculo/i) });
    expect(row).toMatchObject({ campaign_id: "camp-a", scraped_count: 13 });
    expect(state.startCampaign).not.toHaveBeenCalled();
  });

  it("recusa campanha pausada com contagem completa mas sem vínculo comprovado", async () => {
    const row = automation({ phase: "dispatching", campaign_id: "camp-a", scraped_count: 20 });
    state.tables.automations.push(row);
    state.tables.campaigns.push({ id: "camp-a", client_id: CLIENT, status: "paused" });
    state.tables.campaign_targets.push({ campaign_id: "camp-a", client_id: CLIENT, status: "pending", remote_jid: lead(11).remoteJid });
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: false, error: expect.stringMatching(/vínculo|propriedade/i) });
    expect(row).toMatchObject({ campaign_id: "camp-a", scraped_count: 20 });
    expect(state.startCampaign).not.toHaveBeenCalled();
  });

  it("retoma campanha pausada somente com pending vinculado e sem processing", async () => {
    const row = seedScraping(20, 1, { _captureAttemptId: null });
    row.status = "paused";
    row.phase = "dispatching";
    row.campaign_id = "camp-a";
    state.tables.campaigns.push({ id: "camp-a", client_id: CLIENT, status: "paused" });
    state.tables.campaign_targets.push({ campaign_id: "camp-a", client_id: CLIENT, status: "pending", remote_jid: lead(11).remoteJid });
    await worker.startAutomation(ID, CLIENT);
    expect(state.startCampaign).toHaveBeenCalledOnce();
    expect(state.startScraperRun).not.toHaveBeenCalled();
  });

  it("não retoma campanha cujos pending contêm lead estranho à captura", async () => {
    const row = seedScraping(20);
    row.status = "paused";
    row.phase = "dispatching";
    row.campaign_id = "camp-a";
    state.tables.leads_extraidos.push(lead(500));
    state.tables.campaigns.push({ id: "camp-a", client_id: CLIENT, status: "paused" });
    state.tables.campaign_targets.push({ campaign_id: "camp-a", client_id: CLIENT, status: "pending", remote_jid: lead(500).remoteJid });
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: false, error: expect.stringMatching(/vínculo|captura|propriedade/i) });
    expect(state.startCampaign).not.toHaveBeenCalled();
  });

  it("seleciona só IDs vinculados e exclui rejeitados e outro tenant", async () => {
    const row = seedScraping(2, 1, { _capturedLeadIds: [11, 12, 99, 1000], _rejectedLeadIds: [99] }, 2);
    state.tables.leads_extraidos.push(lead(99), lead(200));
    await worker.tickAllAutomations();
    expect(row.phase).toBe("dispatching");
    expect(state.tables.campaign_targets.map(target => target.remote_jid)).toEqual([lead(11).remoteJid, lead(12).remoteJid]);
  });

  it("13/20 retoma, confirma sete IDs e dispara só vinte uma única vez", async () => {
    const row = seedScraping(13);
    row.status = "paused";
    await worker.startAutomation(ID, CLIENT);
    const filters = row.scrape_filters as Row;
    state.tables.leads_extraidos.push(...Array.from({ length: 7 }, (_, i) => lead(24 + i)), lead(500));
    filters._capturedLeadIds = Array.from({ length: 20 }, (_, i) => 11 + i);
    filters._captureAttemptId = null;
    filters._captureLeaseUntil = null;
    filters._scrapeFinishedAt = NOW.toISOString();
    await worker.tickAllAutomations();
    expect(row).toMatchObject({ phase: "dispatching", scraped_count: 20 });
    expect(state.tables.campaign_targets).toHaveLength(20);
    expect(state.tables.campaign_targets.some(target => target.remote_jid === lead(500).remoteJid)).toBe(false);
    await worker.tickAllAutomations();
    expect(state.tables.campaigns).toHaveLength(1);
    expect(state.startCampaign).toHaveBeenCalledOnce();
  });

  it("falha de persistência no tick mantém checkpoint e não bloqueia demais automações", async () => {
    const row = seedScraping(13);
    state.failCaptureWrite = true;
    await expect(worker.tickAllAutomations()).resolves.toBe(1);
    expectNoDispatch(row, 13);
  });

  it("falha de pausa durável não para engine e é devolvida ao chamador", async () => {
    const row = seedScraping(13);
    state.failCaptureWrite = true;
    expect(await worker.pauseAutomation(ID, CLIENT)).toMatchObject({ ok: false, error: expect.any(String) });
    expectNoDispatch(row, 13);
    expect(state.stopScraper).not.toHaveBeenCalled();
  });

  it("pausa durante conclusão do follow-up prevalece sobre tick atrasado", async () => {
    const row = seedScraping(20, 1, { _captureAttemptId: null });
    row.status = "running";
    row.phase = "following";
    row.campaign_id = "camp-a";
    row.followup_campaign_id = "follow-a";
    state.tables.followup_campaigns.push({ id: "follow-a", client_id: CLIENT, status: "active" });
    state.beforeQuery.mockImplementation(async (table: Table) => {
      if (table !== "followup_targets") return;
      state.beforeQuery.mockReset();
      await worker.pauseAutomation(ID, CLIENT);
    });
    await worker.tickAllAutomations();
    expect(row).toMatchObject({ status: "paused", phase: "following", scraped_count: 20 });
    expect(state.tables.followup_campaigns[0].status).toBe("paused");
  });

  it("pausa durante criação do follow-up impede ativação e preserva o vínculo", async () => {
    const row = seedScraping(20, 1, { _captureAttemptId: null });
    row.status = "running";
    row.phase = "dispatching";
    row.campaign_id = "camp-a";
    row.followup_enabled = true;
    row.followup_steps = [{ day_offset: 1, template: "Olá" }];
    state.tables.campaigns.push({ id: "camp-a", client_id: CLIENT, status: "done" });
    state.tables.campaign_targets.push({ campaign_id: "camp-a", client_id: CLIENT, status: "sent", remote_jid: lead(11).remoteJid });
    state.beforeQuery.mockImplementation(async (table: Table, _patch: Row | null, inserts: Row[] | null) => {
      if (table !== "followup_campaigns" || !inserts) return;
      state.beforeQuery.mockReset();
      await worker.pauseAutomation(ID, CLIENT);
    });
    await worker.tickAllAutomations();
    expect(row.status).toBe("paused");
    expect(row.followup_campaign_id).toEqual(expect.any(String));
    expect(state.tables.followup_campaigns[0].status).toBe("paused");
    expect(state.startCampaign).not.toHaveBeenCalled();
  });

  it("pausa durante retomada do follow-up desfaz ativação tardia", async () => {
    const row = seedScraping(20, 1, { _captureAttemptId: null });
    row.status = "paused";
    row.phase = "following";
    row.campaign_id = "camp-a";
    row.followup_campaign_id = "follow-a";
    state.tables.followup_campaigns.push({ id: "follow-a", client_id: CLIENT, status: "paused" });
    state.beforeQuery.mockImplementation(async (table: Table, patch: Row | null) => {
      if (table !== "followup_campaigns" || patch?.status !== "active") return;
      state.beforeQuery.mockReset();
      await worker.pauseAutomation(ID, CLIENT);
    });
    await worker.startAutomation(ID, CLIENT);
    expect(row.status).toBe("paused");
    expect(state.tables.followup_campaigns[0].status).toBe("paused");
  });

  it("retoma follow-up sem trocar campanha ou reativar disparo", async () => {
    const row = seedScraping(20, 1, { _captureAttemptId: null });
    row.status = "paused";
    row.phase = "following";
    row.campaign_id = "camp-a";
    row.followup_campaign_id = "follow-a";
    state.tables.followup_campaigns.push({ id: "follow-a", client_id: CLIENT, status: "paused" });
    await worker.startAutomation(ID, CLIENT);
    expect(row).toMatchObject({ phase: "following", campaign_id: "camp-a", followup_campaign_id: "follow-a", scraped_count: 20 });
    expect(state.tables.followup_campaigns[0].status).toBe("active");
    expect(state.startCampaign).not.toHaveBeenCalled();
    expect(state.startScraperRun).not.toHaveBeenCalled();
  });

  it("pausa durante validação impede campanha e envio", async () => {
    const row = seedScraping(2, 1, {}, 2);
    state.checkWhatsAppNumbersDetailed.mockImplementation(async () => {
      await worker.pauseAutomation(ID, CLIENT);
      return {};
    });
    await worker.tickAllAutomations();
    expect(row.status).toBe("paused");
    expect(state.startCampaign).not.toHaveBeenCalled();
    expect(state.tables.campaigns).toHaveLength(0);
  });
});

describe("automation-worker — conclusão da captação filtrada", () => {
  it.each([
    { saved: 0, minutes: 6, captureAllReviews: false },
    { saved: 0, minutes: 16, captureAllReviews: false },
    { saved: 2, minutes: 6, captureAllReviews: false },
    { saved: 2, minutes: 8, captureAllReviews: true },
    { saved: 2, minutes: 16, captureAllReviews: false },
  ])("mantém captação ativa com $saved aprovados após $minutes min", async ({ saved, minutes, captureAllReviews }) => {
    const row = seedScraping(saved, minutes, { captureAllReviews });
    state.getScraperStatus.mockReturnValue({ isScraping: true, automationId: ID });

    expect(await worker.tickAllAutomations()).toBe(1);

    expectNoDispatch(row, saved);
    expect(state.getScraperStatus).toHaveBeenCalledWith(CLIENT, ID);
    expect(row.scrape_filters).toMatchObject({ minReviews: 100 });
  });

  // O término da tentativa não satisfaz a meta; os fallbacks antigos disparavam abaixo dela.
  it.each([0, 2])("reagenda abaixo da meta sem engine ativa (%s aprovados)", async saved => {
    const row = seedScraping(saved);

    await worker.tickAllAutomations();

    expectNoDispatch(row, saved);
    expect(row.scrape_filters).toHaveProperty("_captureRetryAt", expect.any(String));
    expect(state.startScraperRun).not.toHaveBeenCalled();
  });

  it("marcador de término abaixo da meta não avança durante encerramento da engine", async () => {
    const row = seedScraping(2, 1, { _scrapeFinishedAt: NOW.toISOString() });
    state.getScraperStatus.mockReturnValue({ isScraping: true, automationId: ID });

    await worker.tickAllAutomations();

    expectNoDispatch(row, 2);
    expect(row.scrape_filters).toHaveProperty("_captureRetryAt", expect.any(String));
  });

  it("limite de leads continua encerrando captação com engine ativa", async () => {
    const row = seedScraping(2, 1, {}, 2);
    state.getScraperStatus.mockReturnValue({ isScraping: true, automationId: ID });

    await worker.tickAllAutomations();

    expect(row.phase).toBe("dispatching");
    expect(state.tables.automation_logs).toContainEqual(expect.objectContaining({
      metadata: { scrapedNow: 2, reason: "limite de 2 leads atingido" },
    }));
    expect(state.startCampaign).toHaveBeenCalledOnce();
  });

  it("timeout sem leads preserva progresso e agenda retry em vez de DONE", async () => {
    const row = seedScraping(0, 16);
    state.getScraperStatus.mockReturnValue({ isScraping: false });

    await worker.tickAllAutomations();

    expectNoDispatch(row, 0);
    expect(row.scrape_filters).toHaveProperty("_captureRetryAt", expect.any(String));
  });

  it("interrupção em dispatching antes de criar campanha não bloqueia retomada e gera campanha", async () => {
    const row = seedScraping(2, 1, { _captureAttemptId: null }, 2);
    row.status = "paused";
    row.phase = "dispatching";
    row.campaign_id = null;

    const res = await worker.startAutomation(ID, CLIENT);
    expect(res.ok).toBe(true);
    expect(row.status).toBe("running");
    expect(row.phase).toBe("dispatching");

    await worker.tickAllAutomations();
    expect(state.startCampaign).toHaveBeenCalled();
  });

  it("reconciliação com 300 IDs conhecidos não adiciona duplicatas nem falha", async () => {
    const known = Array.from({ length: 300 }, (_, i) => i + 1);
    const row = seedScraping(300, 1, {
      _capturedLeadIds: known,
      _captureSessionId: "session-big",
    }, 305);
    // 2 leads gravados no banco que ainda não constavam no checkpoint
    state.tables.leads_extraidos.push(
      { ...lead(301, CLIENT), business_details: { _automationCapture: { automationId: ID, sessionId: "session-big" } } },
      { ...lead(302, CLIENT), business_details: { _automationCapture: { automationId: ID, sessionId: "session-big" } } }
    );

    await worker.tickAllAutomations();
    const ids = (row.scrape_filters as Record<string, unknown>)._capturedLeadIds as number[];
    expect(ids).toContain(301);
    expect(ids).toContain(302);
    expect(ids.length).toBe(302);
  });
});
