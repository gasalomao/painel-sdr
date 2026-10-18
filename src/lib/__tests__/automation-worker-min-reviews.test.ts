// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Table = "automations" | "leads_extraidos" | "automation_logs" | "campaigns" | "campaign_targets";
type QueryResult = { data: Row | Row[] | null; count: number; error: null };

const state = vi.hoisted(() => ({
  tables: {
    automations: [], leads_extraidos: [], automation_logs: [], campaigns: [], campaign_targets: [],
  } as Record<Table, Row[]>,
  startScraperRun: vi.fn(),
  getScraperStatus: vi.fn(),
  startCampaign: vi.fn(),
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
  eq(column: string, value: unknown) { this.filters.push(row => row[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push(row => row[column] !== value); return this; }
  is(column: string, value: unknown) { return this.eq(column, value); }
  not(column: string, _operator: string, value: unknown) { return this.neq(column, value); }
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
    return Promise.resolve(this.execute()).then(fulfilled, rejected);
  }
}

vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: (table: Table) => new Query(table) } }));
vi.mock("@/lib/scraper-engine", () => ({
  startScraperRun: state.startScraperRun,
  getStatus: state.getScraperStatus,
  stopScraper: vi.fn(),
}));
vi.mock("@/lib/campaign-worker", () => ({ startCampaign: state.startCampaign, pauseCampaign: vi.fn() }));
vi.mock("@/lib/followup-worker", () => ({ enrollLeads: vi.fn() }));
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
  state.startCampaign.mockReset().mockResolvedValue({ ok: true });
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
      client_id: CLIENT, automation_id: ID, maxLeads: 20, forceRestart: true, webhookEnabled: false,
    }));
    expect(row.scrape_filters).not.toHaveProperty("_scrapeFinishedAt");
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

    expect(state.startScraperRun).toHaveBeenCalledOnce();
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({
      minReviews: minimum ?? 0, client_id: CLIENT, automation_id: ID,
      maxLeads: 1, topup: true, forceRestart: false, webhookEnabled: false,
    }));
    expect(row).toMatchObject({ phase: "dispatching", scraped_count: 2 });
    expect(row.scrape_filters).toMatchObject({ _topupRounds: 1 });
    expect(state.tables.campaign_targets.map(target => target.remote_jid)).toEqual([
      lead(12).remoteJid, lead(13).remoteJid,
    ]);
    expect(state.tables.campaign_targets.every(target => target.client_id === CLIENT)).toBe(true);
    expect(state.getScraperStatus).toHaveBeenCalledWith(CLIENT, ID);
    expect(state.startCampaign).toHaveBeenCalledOnce();
  });

  it.each([null, false])("reposição deixa a engine rejeitar mínimo malformado %s sem desativá-lo", async minimum => {
    seedScraping(2, 6, { minReviews: minimum, _scrapeFinishedAt: NOW.toISOString() }, 2);
    state.checkWhatsAppNumbersDetailed.mockResolvedValue({ [INVALID_PHONE]: { exists: false } });
    state.startScraperRun.mockReturnValue({ ok: false, error: "minReviews inválido" });

    await worker.tickAllAutomations();

    expect(state.startScraperRun.mock.calls[0][0].minReviews).toBe(minimum);
    expect(state.tables.automation_logs).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("Reposição não iniciou (minReviews inválido)"),
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
      client_id: CLIENT, automation_id: ID, forceRestart: true, webhookEnabled: false,
    }));
    expect(state.startScraperRun.mock.calls[0][0].reviews_ai).toBeUndefined();
    expect(row.scrape_filters).toMatchObject(filters);
    expect(row.scrape_filters).toHaveProperty("_baselineMaxId", 0);
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

    expect(state.startScraperRun).toHaveBeenCalledOnce();
    expect(state.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({
      filterWithInstagram: filterWithInstagram ?? false,
      minReviews: 100, filterWithWebsite: true, captureAllReviews: false,
      client_id: CLIENT, automation_id: ID, maxLeads: 1, topup: true, forceRestart: false,
    }));
    expect(state.startScraperRun.mock.calls[0][0].reviews_ai).toBeUndefined();
    expect(row.scrape_filters).toMatchObject({ minReviews: 100, _baselineMaxId: 10, _source: "prospeccao-sites", _topupRounds: 1 });
    if (filterWithInstagram !== undefined) expect(row.scrape_filters).toHaveProperty("filterWithInstagram", filterWithInstagram);
    expect(state.tables.campaign_targets.map(target => target.remote_jid)).toEqual([
      lead(12).remoteJid, lead(13).remoteJid,
    ]);
    expect(state.tables.campaign_targets.every(target => target.client_id === CLIENT)).toBe(true);
  });

  it.each([null, 0, 1, "true", "false", "", [], {}].map(filterWithInstagram => ({ filterWithInstagram })))
    ("reposição não converte Instagram inválido $filterWithInstagram para false", async ({ filterWithInstagram }) => {
      seedScraping(2, 6, { filterWithInstagram, _scrapeFinishedAt: NOW.toISOString() }, 2);
      state.checkWhatsAppNumbersDetailed.mockResolvedValue({ [INVALID_PHONE]: { exists: false } });
      state.startScraperRun.mockReturnValue({ ok: false, error: "filterWithInstagram inválido" });

      await worker.tickAllAutomations();

      expect(state.startScraperRun.mock.calls[0][0].filterWithInstagram).toEqual(filterWithInstagram);
      expect(state.tables.automation_logs).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("Reposição não iniciou (filterWithInstagram inválido)"),
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

  it.each([0, 2])("preserva heurística sem engine ativa (%s aprovados)", async saved => {
    const row = seedScraping(saved);

    await worker.tickAllAutomations();

    expect(row.phase).toBe(saved === 0 ? "done" : "dispatching");
    expect(state.tables.campaign_targets).toHaveLength(saved);
    expect(state.startCampaign).toHaveBeenCalledTimes(saved === 0 ? 0 : 1);
  });

  it("marcador real de término avança imediatamente mesmo durante encerramento da engine", async () => {
    const row = seedScraping(2, 1, { _scrapeFinishedAt: NOW.toISOString() });
    state.getScraperStatus.mockReturnValue({ isScraping: true, automationId: ID });

    await worker.tickAllAutomations();

    expect(row.phase).toBe("dispatching");
    expect(state.tables.campaign_targets).toHaveLength(2);
    expect(state.tables.automation_logs).toContainEqual(expect.objectContaining({
      metadata: { scrapedNow: 2, reason: "scraper finalizou a captação" },
    }));
    expect(state.startCampaign).toHaveBeenCalledOnce();
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

  it("timeout de 15min sem leads continua valendo sem engine ativa", async () => {
    const row = seedScraping(0, 16);
    state.getScraperStatus.mockReturnValue({ isScraping: false });

    await worker.tickAllAutomations();

    expect(row).toMatchObject({ phase: "done", status: "done" });
    expect(state.tables.automation_logs).toContainEqual(expect.objectContaining({
      metadata: { scrapedNow: 0, reason: "timeout de 15min sem captar nenhum lead" },
    }));
    expect(state.startCampaign).not.toHaveBeenCalled();
  });
});
