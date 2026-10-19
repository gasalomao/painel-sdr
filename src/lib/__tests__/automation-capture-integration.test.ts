// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only I/O boundaries are replaced. Worker, engine, CRM dedup, search memory and CAS stay real.
const io = vi.hoisted(() => ({
  from: vi.fn(), launch: vi.fn(), startCampaign: vi.fn(), pauseCampaign: vi.fn(),
  checkNumbers: vi.fn(), fetch: vi.fn(), summarize: vi.fn(), enroll: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: io.from }, supabaseAdmin: { from: io.from } }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: io.from } }));
vi.mock("@/lib/campaign-worker", () => ({ startCampaign: io.startCampaign, pauseCampaign: io.pauseCampaign }));
vi.mock("@/lib/followup-worker", () => ({ enrollLeads: io.enroll }));
vi.mock("@/lib/channel", () => ({ checkWhatsAppNumbersDetailed: io.checkNumbers }));
vi.mock("@/lib/evolution", () => ({ evolution: {}, getEvolutionConfig: async () => ({ instance: "offline" }) }));
vi.mock("@/lib/reviews-ai", () => ({ summarizeReviewsForLead: io.summarize }));
vi.mock("@/lib/safe-url", () => ({ fetchPublicHttpUrl: io.fetch }));
vi.mock("puppeteer-extra", () => ({ default: { use: vi.fn(), launch: io.launch } }));
vi.mock("puppeteer-extra-plugin-stealth", () => ({ default: vi.fn(() => ({})) }));

type Row = Record<string, unknown>;
type Table = "automations" | "leads_extraidos" | "contacts" | "automation_logs" | "campaigns" | "campaign_targets" | "app_settings";
type Result = { data: Row | Row[] | null; count: number; error: { message: string } | null };
const CLIENT = "integration-tenant";
const ID = "integration-automation";
let tables: Record<Table, Row[]>;
let worker: typeof import("../automation-worker");
let engine: typeof import("../scraper-engine");
let nextLeadId: number;
let places: number[];
let searches: string[];
let holdCardAt: number | null;
let cardBlocked: boolean;
let releaseCard: (() => void) | undefined;
let failAppend: boolean;
let casMisses: number;

function automation(): Row { return tables.automations[0]; }
function filters(): Row { return automation().scrape_filters as Row; }
function capturedIds(): number[] { return filters()._capturedLeadIds as number[]; }
function jid(place: number): string { return `551199999${String(place).padStart(4, "0")}@s.whatsapp.net`; }
function name(place: number): string { return `Negócio ${place}`; }
function lead(place: number): Row {
  return { id: place, client_id: CLIENT, remoteJid: jid(place), nome_negocio: name(place), ramo_negocio: "Dentista", status: "novo" };
}
function seed(saved = 0): void {
  tables.automations.push({
    id: ID, client_id: CLIENT, name: "Integração offline", status: "paused", phase: "scraping",
    niches: ["dentista"], regions: ["Offline"], scrape_max_leads: 20, scraped_count: saved,
    instance_name: "offline", dispatch_template: "Olá, {{nome_negocio}}", dispatch_min_interval: 30,
    dispatch_max_interval: 60, allowed_start_hour: 8, allowed_end_hour: 18,
    dispatch_personalize: false, lead_intelligence_enabled: false, followup_enabled: false,
    campaign_id: null, followup_campaign_id: null, started_at: null,
    scrape_filters: { minReviews: 100, filterEmpty: true, filterDuplicates: false,
      _captureSessionId: "persistent-session", _capturedLeadIds: Array.from({ length: saved }, (_, i) => i + 1), _rejectedLeadIds: [] },
  });
  // More than the goal already exists in the CRM; none belongs to this capture.
  tables.leads_extraidos.push(...Array.from({ length: 21 }, (_, i) => lead(i + 100)));
  tables.leads_extraidos.push(...Array.from({ length: saved }, (_, i) => lead(i + 1)));
}

// Executes the actual PostgREST predicates, including JSONB CAS, returning detached snapshots.
class Query implements PromiseLike<Result> {
  private predicates: Array<(row: Row) => boolean> = [];
  private patch: Row | null = null;
  private inserts: Row[] | null = null;
  private selected = "*";
  private one = false;
  private first = 0;
  private maximum = Infinity;
  private sort: { column: string; ascending: boolean } | null = null;
  constructor(private table: Table) {}
  select(columns = "*") { this.selected = columns; return this; }
  update(value: Row) { this.patch = value; return this; }
  insert(value: Row | Row[]) { this.inserts = Array.isArray(value) ? value : [value]; return this; }
  upsert(value: Row | Row[]) { return this.insert(value); }
  eq(column: string, value: unknown) {
    this.predicates.push(row => column === "scrape_filters" ? JSON.stringify(row[column]) === value
      : column.split(/->>?/).reduce<unknown>((part, key) => part && typeof part === "object" ? (part as Row)[key] : undefined, row) === value);
    return this;
  }
  is(column: string, value: unknown) { return this.eq(column, value); }
  neq(column: string, value: unknown) { this.predicates.push(row => row[column] !== value); return this; }
  not(column: string, _operator: string, value: unknown) { return this.neq(column, value); }
  in(column: string, values: unknown[]) { this.predicates.push(row => values.includes(row[column])); return this; }
  gt(column: string, value: string | number) { this.predicates.push(row => typeof value === "number" ? Number(row[column]) > value : String(row[column]) > value); return this; }
  gte(column: string, value: string) { this.predicates.push(row => String(row[column]) >= value); return this; }
  lte(column: string, value: string) { this.predicates.push(row => String(row[column]) <= value); return this; }
  like(column: string, pattern: string) { return this.ilike(column, pattern, false); }
  ilike(column: string, pattern: string, insensitive = true) {
    const regex = new RegExp(`^${pattern.split("%").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, insensitive ? "i" : "");
    this.predicates.push(row => typeof row[column] === "string" && regex.test(row[column] as string)); return this;
  }
  range(first: number, last: number) { this.first = first; this.maximum = last - first + 1; return this; }
  limit(maximum: number) { this.maximum = maximum; return this; }
  order(column: string, options: { ascending: boolean }) { this.sort = { column, ...options }; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { return this.maybeSingle(); }
  private execute(): Result {
    const table = tables[this.table];
    let rows = table.filter(row => this.predicates.every(predicate => predicate(row)));
    if (this.patch && this.table === "automations") {
      if (!rows.length) casMisses++;
      if (failAppend && ((this.patch.scrape_filters as Row)?._capturedLeadIds as number[] | undefined)?.length === 14) {
        failAppend = false;
        return { data: null, count: 0, error: { message: "checkpoint indisponível após INSERT" } };
      }
    }
    if (this.patch) rows.forEach(row => Object.assign(row, structuredClone(this.patch)));
    if (this.inserts) {
      rows = this.inserts.map(row => ({ id: this.table === "leads_extraidos" ? nextLeadId++ : `${this.table}-${table.length + 1}`, ...structuredClone(row) }));
      table.push(...rows);
    }
    if (this.sort) {
      const { column, ascending } = this.sort;
      rows.sort((a, b) => String(a[column]).localeCompare(String(b[column]), "en", { numeric: true }) * (ascending ? 1 : -1));
    }
    const projected = rows.slice(this.first, this.first + this.maximum).map(row => this.selected === "*" ? structuredClone(row)
      : Object.fromEntries(this.selected.split(",").map(column => [column.trim(), structuredClone(row[column.trim()])])));
    return { data: this.one ? projected[0] ?? null : projected, count: rows.length, error: null };
  }
  then<T = Result, U = never>(fulfilled?: ((value: Result) => T | PromiseLike<T>) | null, rejected?: ((reason: unknown) => U | PromiseLike<U>) | null): Promise<T | U> {
    return Promise.resolve(this.execute()).then(fulfilled, rejected);
  }
}

function offlineBrowser() {
  return {
    close: async () => {},
    newPage: async () => {
      let detail = 0;
      return {
        setViewport: async () => {}, setExtraHTTPHeaders: async () => {}, setRequestInterception: async () => {}, on: () => {}, close: async () => {},
        goto: async (url: string) => {
          if (url.includes("/search/")) searches.push(url);
          else detail = Number(url.split("/place/")[1]);
        },
        waitForSelector: async () => ({}),
        evaluate: async (fn: (...args: never[]) => unknown, arg?: string) => {
          const source = fn.toString();
          if (typeof arg === "string") {
            const place = places.find(value => name(value) === arg);
            if (place === undefined) throw new Error(`Card não configurado: ${arg}`);
            if (place === holdCardAt) {
              holdCardAt = null; cardBlocked = true;
              await new Promise<void>(resolve => { releaseCard = resolve; });
            }
            return { name: arg, fullAddress: "Rua Offline, 1", categories: "Dentista", averageRating: "4.9", reviewCountSources: ["100 avaliações"], website: "" };
          }
          if (source.includes("isConsentUrl")) return false;
          if (source.includes("const redesAdicionais")) return {
            phone: `(11) 99999-${String(detail).padStart(4, "0")}`, website: "", instagram: "", facebook: "", instagramLinks: [],
            reviews: Array.from({ length: 50 }, (_, i) => ({ texto: `Avaliação offline ${i}` })),
            businessDetails: { about: "Detalhes preservados" }, reviewCountSources: ["100 avaliações"], placeId: `offline-${detail}`, mapsUrl: "",
          };
          if (source.includes('querySelectorAll(".Nv2PK")')) return places.map(place => ({ name: name(place), url: `https://www.google.com/maps/place/${place}` }));
          if (source.includes("Você chegou ao final")) return true;
          if (source.includes("feed.scrollBy")) return undefined;
          throw new Error(`DOM offline sem fixture: ${source.slice(0, 100)}`);
        },
      };
    },
  };
}

async function loadPipeline(): Promise<void> {
  vi.resetModules();
  worker = await import("../automation-worker");
  engine = await import("../scraper-engine");
}
async function waitForEngine(): Promise<void> {
  await vi.waitFor(() => expect(engine.getStatus(CLIENT, ID).isScraping).toBe(false), { timeout: 5000, interval: 10 });
}
function expectNoDispatch(saved: number): void {
  expect(automation()).toMatchObject({ status: "running", phase: "scraping", scraped_count: saved, campaign_id: null });
  expect(tables.campaigns).toHaveLength(0);
  expect(tables.campaign_targets).toHaveLength(0);
  expect(io.startCampaign).not.toHaveBeenCalled();
}
function expectSingleDispatch(): void {
  expect(automation()).toMatchObject({ phase: "dispatching", scraped_count: 20, campaign_id: tables.campaigns[0]?.id });
  expect(tables.campaigns).toHaveLength(1);
  expect(tables.campaign_targets).toHaveLength(20);
  expect(new Set(tables.campaign_targets.map(row => row.remote_jid))).toEqual(new Set(Array.from({ length: 20 }, (_, i) => jid(i + 1))));
  expect(io.startCampaign).toHaveBeenCalledOnce();
}

beforeEach(async () => {
  vi.resetAllMocks();
  tables = { automations: [], leads_extraidos: [], contacts: [], automation_logs: [], campaigns: [], campaign_targets: [], app_settings: [] };
  nextLeadId = 1000; places = [100, ...Array.from({ length: 21 }, (_, i) => i + 1)]; searches = [];
  holdCardAt = null; cardBlocked = false; releaseCard = undefined; failAppend = false; casMisses = 0;
  const forbidden = () => { throw new Error("Chamada externa proibida na integração offline"); };
  vi.stubGlobal("fetch", vi.fn(forbidden));
  io.fetch.mockImplementation(forbidden); io.summarize.mockImplementation(forbidden); io.enroll.mockImplementation(forbidden);
  io.from.mockImplementation((table: Table) => {
    if (!tables[table]) throw new Error(`Tabela sem fake: ${table}`);
    return new Query(table);
  });
  io.launch.mockImplementation(async () => offlineBrowser());
  io.checkNumbers.mockImplementation(async (phones: string[]) => Object.fromEntries(phones.map(phone => [phone, { exists: true, jid: `${phone}@s.whatsapp.net` }])));
  io.startCampaign.mockImplementation(async (id: string) => {
    const campaign = tables.campaigns.find(row => row.id === id);
    if (!campaign) throw new Error("Campanha não persistida");
    campaign.status = "running";
    return { ok: true };
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) =>
    realTimeout(callback, /at sleep \([^\n]*scraper-engine\.ts:/.test(new Error().stack || "") ? 0 : delay, ...args)) as typeof setTimeout);
  await loadPipeline();
});
afterEach(async () => {
  engine?.stopScraper(CLIENT, ID);
  releaseCard?.();
  await waitForEngine();
  expect(io.fetch).not.toHaveBeenCalled();
  expect(io.summarize).not.toHaveBeenCalled();
  expect(io.enroll).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("automação e scraper reais com persistência offline", () => {
  it("pausa em 13/20, reinicia o processo e salva só 7 novos antes de um único disparo", async () => {
    seed(); holdCardAt = 14;
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(cardBlocked).toBe(true), { timeout: 5000, interval: 10 });
    await worker.tickAllAutomations();
    expectNoDispatch(13);
    expect(engine.getLeads(CLIENT, ID).count).toBe(13);
    const firstIds = [...capturedIds()];
    const firstAttempt = filters()._captureAttemptId;
    expect(filters()._captureLeaseUntil).toEqual(expect.any(String));
    expect(await worker.pauseAutomation(ID, CLIENT)).toMatchObject({ ok: true, stopped: { scraper: true } });
    expect(automation()).toMatchObject({ status: "paused", scraped_count: 13 });
    expect(filters()).toMatchObject({ _captureSessionId: "persistent-session", _captureAttemptId: null, _capturedLeadIds: firstIds });
    releaseCard?.(); await waitForEngine();
    expect(tables.leads_extraidos).toHaveLength(34);

    // Discard both modules' in-memory stores, retaining only the durable DB fake.
    await loadPipeline();
    expect(engine.getLeads(CLIENT, ID).count).toBe(0);
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: true });
    await waitForEngine();
    expectNoDispatch(20);
    expect(capturedIds()).toEqual([...firstIds, ...Array.from({ length: 7 }, (_, i) => 1013 + i)]);
    expect(engine.getLeads(CLIENT, ID).count).toBe(7);
    expect(tables.leads_extraidos).toHaveLength(41);
    expect(searches).toHaveLength(2);
    expect(searches[0]).toBe(searches[1]); // Repeated search still encounters all 13 CRM duplicates.
    const newRows = tables.leads_extraidos.filter(row => Number(row.id) >= 1013);
    expect(newRows).toHaveLength(7);
    expect(newRows[0].business_details).toMatchObject({ about: "Detalhes preservados", _automationCapture: {
      automationId: ID, sessionId: "persistent-session", attemptId: expect.any(String),
    } });
    expect(((newRows[0].business_details as Row)._automationCapture as Row).attemptId).not.toBe(firstAttempt);
    expect(filters()).toMatchObject({ _captureLastOutcome: "goal_reached", _scrapeFinishedAt: expect.any(String) });

    await Promise.all([worker.tickAllAutomations(), worker.tickAllAutomations()]);
    await worker.tickAllAutomations();
    expectSingleDispatch();
    expect(io.checkNumbers).toHaveBeenCalledOnce();
    tables.campaigns[0].status = "done";
    tables.campaign_targets.forEach(target => { target.status = "sent"; });
    await worker.tickAllAutomations();
    await worker.tickAllAutomations();
    expect(automation()).toMatchObject({ status: "done", phase: "done", scraped_count: 20 });
    expect(io.startCampaign).toHaveBeenCalledOnce();
  });

  it("reconcilia o marcador gravado pelo engine após falhar o checkpoint sem anexar outros tenants ou sessões", async () => {
    seed(13); failAppend = true;
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: true });
    await waitForEngine();
    expectNoDispatch(13);
    expect(capturedIds()).not.toContain(1000);
    expect(engine.getLeads(CLIENT, ID).count).toBe(0);
    const orphan = tables.leads_extraidos.find(row => row.id === 1000)!;
    expect(orphan).toMatchObject({ remoteJid: jid(14), business_details: { about: "Detalhes preservados", _automationCapture: {
      automationId: ID, sessionId: "persistent-session", attemptId: expect.any(String),
    } } });
    expect(filters()).toMatchObject({ _captureLastOutcome: "error", _scrapeFinishedAt: null });
    tables.leads_extraidos.push(
      { ...lead(2000), business_details: { _automationCapture: { automationId: ID, sessionId: "other-session" } } },
      { ...lead(2001), client_id: "other-tenant", business_details: { _automationCapture: { automationId: ID, sessionId: "persistent-session" } } },
      { ...lead(2002), business_details: { _automationCapture: { automationId: "other-automation", sessionId: "persistent-session" } } },
    );
    expect(await worker.pauseAutomation(ID, CLIENT)).toMatchObject({ ok: true });
    await loadPipeline(); holdCardAt = 15;
    expect(await worker.startAutomation(ID, CLIENT)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(cardBlocked).toBe(true), { timeout: 5000, interval: 10 });
    expectNoDispatch(14);
    expect(capturedIds()).toEqual([...Array.from({ length: 13 }, (_, i) => i + 1), 1000]);
    releaseCard?.(); await waitForEngine();
    expectNoDispatch(20);
    expect(engine.getLeads(CLIENT, ID).count).toBe(6);
    expect(tables.leads_extraidos.filter(row => row.client_id === CLIENT && row.nome_negocio === name(14))).toHaveLength(1);
    expect(capturedIds().filter(id => [2000, 2001, 2002].includes(id))).toEqual([]);
    await worker.tickAllAutomations();
    await worker.tickAllAutomations();
    expectSingleDispatch();
  });

  it("CAS real reexecuta mutações concorrentes e não perde IDs nem filtros", async () => {
    seed(13);
    const { updateAutomationCapture, readCaptureIds } = await import("../automation-capture");
    await Promise.all([14, 15].map(id => updateAutomationCapture(CLIENT, ID, current => {
      const ids = [...readCaptureIds(current.scrape_filters), id];
      return { scraped_count: ids.length, scrape_filters: { ...current.scrape_filters, _capturedLeadIds: ids, [`confirmed${id}`]: true } };
    })));
    expect(casMisses).toBeGreaterThan(0);
    expect(automation().scraped_count).toBe(15);
    expect(new Set(capturedIds())).toEqual(new Set(Array.from({ length: 15 }, (_, i) => i + 1)));
    expect(filters()).toMatchObject({ minReviews: 100, confirmed14: true, confirmed15: true });
  });
});
