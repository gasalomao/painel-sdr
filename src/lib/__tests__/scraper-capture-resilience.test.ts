// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), launch: vi.fn(), fetch: vi.fn(), loadMemory: vi.fn(), markMemory: vi.fn(), expand: vi.fn(), summarize: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from }, supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/evolution", () => ({ getEvolutionConfig: async () => ({ instance: "offline" }) }));
vi.mock("@/lib/reviews-ai", () => ({ summarizeReviewsForLead: mocks.summarize }));
vi.mock("@/lib/safe-url", () => ({ fetchPublicHttpUrl: mocks.fetch }));
vi.mock("puppeteer-extra", () => ({ default: { use: vi.fn(), launch: mocks.launch } }));
vi.mock("puppeteer-extra-plugin-stealth", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@/lib/scraper-search-memory", () => ({
  makeSearchKey: (niche: string, region: string) => `${niche}:${region}`,
  loadExhaustedSearches: mocks.loadMemory, markSearchExhausted: mocks.markMemory,
}));
vi.mock("@/lib/geo-regions", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/geo-regions")>(), computeExpansionCandidates: mocks.expand,
}));

import { attachSseClient, checkCrmDuplicate, detachSseClient, getLeads, getStatus, clearLeads, pauseScraper, resumeScraper, startScraperRun, stopScraper, type StartOpts } from "../scraper-engine";

type Row = Record<string, unknown>;
const clientId = "capture-offline";
const automationId = "automation-offline";
let tables: Record<string, Row[]>;
let places: string[];
let events: Row[];
let writes: string[];
let insertError: boolean;
let checkpointError: boolean;
let duplicateError: boolean;
let afterInsert: (() => void) | undefined;
let closeBrowser: () => Promise<void>;
let failNavigation: boolean;
let noFeed: boolean;
let explicitEmpty: boolean;
let searchTerms: string[];
let detailVisits: string[];
let rejectWithWebsite: boolean;
let detailError: boolean;
let singlePlaceMock: any;
const controller = { enqueue: (chunk: Uint8Array) => {
  const event = JSON.parse(new TextDecoder().decode(chunk).replace(/^data: /, "").trim()) as Row;
  events.push(event);
  if (event.event === "new_lead") writes.push("event");
} } as unknown as ReadableStreamDefaultController;

function automation(): Row { return tables.automations[0]; }
function filters(): Row { return automation().scrape_filters as Row; }
function seed(count: number, goal: number): void {
  tables.automations.push({ id: automationId, client_id: clientId, status: "running", phase: "scraping", scrape_max_leads: goal,
    scraped_count: count, campaign_id: null, followup_campaign_id: null, started_at: new Date().toISOString(),
    scrape_filters: { _capturedLeadIds: Array.from({ length: count }, (_, i) => i + 1), _rejectedLeadIds: [],
      _captureSessionId: "session-a", _captureAttemptId: "attempt-a" } });
  tables.leads_extraidos.push(...Array.from({ length: count }, (_, i) => ({ id: i + 1, client_id: clientId, remoteJid: `55118888${String(i).padStart(4, "0")}@s.whatsapp.net` })));
}
function query(table: string) {
  const matches: ((row: Row) => boolean)[] = [];
  let operation = "select";
  let payload: Row = {};
  let first = 0, last = Infinity;
  const result = async (): Promise<{ data: Row | Row[] | null; error: { message: string } | null }> => {
    if (operation === "insert") {
      if (table === "leads_extraidos" && insertError) return { data: null, error: { message: "insert indisponível" } };
      const row = { ...payload, id: table === "leads_extraidos" ? 100 + tables[table].length : tables[table].length + 1 };
      tables[table].push(row);
      if (table === "leads_extraidos") { writes.push(`insert:${row.id}`); afterInsert?.(); }
      return { data: row, error: null };
    }
    if (duplicateError && ["leads_extraidos", "contacts"].includes(table)) return { data: null, error: { message: "lookup indisponível" } };
    if (operation === "update" && table === "automations" && checkpointError && Array.isArray((payload.scrape_filters as Row)?._capturedLeadIds)
      && ((payload.scrape_filters as Row)._capturedLeadIds as number[]).length > 13) return { data: null, error: { message: "checkpoint indisponível" } };
    const rows = tables[table].filter(row => matches.every(match => match(row))).slice(first, last + 1);
    if (operation === "update") {
      for (const row of rows) Object.assign(row, payload);
      if (table === "automations") writes.push(`checkpoint:${rows[0]?.scraped_count}`);
    }
    return { data: structuredClone(rows), error: null };
  };
  const q = {
    select: vi.fn(() => q),
    eq: vi.fn((key: string, value: unknown) => { matches.push(row => key === "scrape_filters" ? JSON.stringify(row[key]) === value : row[key] === value); return q; }),
    is: vi.fn((key: string, value: unknown) => { matches.push(row => row[key] === value); return q; }),
    ilike: vi.fn((key: string, pattern: string) => {
      const re = new RegExp(`^${pattern.split("%").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
      matches.push(row => typeof row[key] === "string" && re.test(row[key] as string)); return q;
    }),
    range: vi.fn((start: number, end: number) => { first = start; last = end; return q; }),
    limit: vi.fn((count: number) => { last = count - 1; return q; }),
    insert: vi.fn((value: Row) => { operation = "insert"; payload = value; return q; }),
    update: vi.fn((value: Row) => { operation = "update"; payload = value; return q; }),
    maybeSingle: async () => { const r = await result(); return { ...r, data: Array.isArray(r.data) ? r.data[0] || null : r.data }; },
    single: async () => { const r = await result(); return { ...r, data: Array.isArray(r.data) ? r.data[0] || null : r.data }; },
    then: (resolve: (value: unknown) => unknown) => result().then(resolve),
  };
  return q;
}

beforeEach(() => {
  tables = { automations: [], automation_logs: [], leads_extraidos: [], contacts: [] };
  places = ["novo"];
  events = []; writes = []; searchTerms = []; detailVisits = [];
  rejectWithWebsite = false; detailError = false;
  mocks.loadMemory.mockReset().mockResolvedValue(new Set<string>());
  mocks.markMemory.mockReset().mockResolvedValue(true);
  mocks.expand.mockReset().mockReturnValue([]);
  insertError = false; checkpointError = false; duplicateError = false; failNavigation = false; noFeed = false;
  singlePlaceMock = null; explicitEmpty = true;
  afterInsert = undefined;
  closeBrowser = async () => {};
  mocks.from.mockReset().mockImplementation(query);
  mocks.launch.mockReset();
  mocks.fetch.mockReset();
  mocks.summarize.mockReset().mockResolvedValue({ cached: false });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    return realTimeout(callback, /at sleep \([^\n]*scraper-engine\.ts:/.test(new Error().stack || "") ? 0 : delay, ...args);
  }) as typeof setTimeout);
  mocks.launch.mockImplementation(async () => ({
    newPage: async () => {
      let detailName = "";
      return {
      setViewport: async () => {}, setExtraHTTPHeaders: async () => {}, setRequestInterception: async () => {}, on: () => {}, close: async () => {},
      goto: async (url: string) => { detailName = url.includes("/place/") ? url.split("/place/")[1] : ""; if (detailName) { detailVisits.push(detailName); if (detailError) throw new Error("Protocol error: Session closed"); } if (url.includes("/search/")) searchTerms.push(decodeURIComponent(url.split("/search/")[1].split("?")[0]).replace(/\+/g, " ")); if (failNavigation) throw new Error("Protocol error: Target closed"); },
      waitForSelector: async (selector: string) => { if (noFeed && selector.includes("feed")) { const e = new Error("Waiting for selector timeout"); e.name = "TimeoutError"; throw e; } return {}; },
      evaluate: async (fn: (...args: never[]) => unknown, arg?: string) => {
        const source = fn.toString();
        if (source.includes("isConsentUrl")) return false;
        if (source.includes("isPlaceUrl")) return singlePlaceMock;
        if (source.includes("const leadName") || typeof arg === "string" && places.includes(arg)) return { name: arg, fullAddress: "Rua Offline, 1", categories: "Dentista", averageRating: "4.9", reviewCount: "100", reviewCountSources: ["100 avaliações"], website: "" };
        if (source.includes("const items = Array.from(document.querySelectorAll(\".Nv2PK\"))")) return places.map(name => ({ name, url: `https://www.google.com/maps/place/${name}` }));
        if (source.includes("const redesAdicionais")) return { phone: `(11) 99999-${String(places.indexOf(detailName)).padStart(4, "0")}`, website: rejectWithWebsite ? "https://offline.test" : "", instagram: "", facebook: "", instagramLinks: [], reviews: Array.from({ length: 50 }, () => ({ texto: "offline" })), businessDetails: { about: "Preservar detalhes" }, reviewCountSources: ["100 avaliações"], placeId: "", mapsUrl: "" };
        if (source.includes("Você chegou ao final")) return true;
        if (/nenhum resultado|no results/i.test(source)) return noFeed && explicitEmpty;
        return undefined;
      },
    }; },
    close: () => closeBrowser(),
  }));
  attachSseClient(controller, clientId);
});
afterEach(async () => {
  stopScraper(clientId, automationId); stopScraper(clientId);
  await vi.waitFor(() => { expect(getStatus(clientId, automationId).isScraping).toBe(false); expect(getStatus(clientId).isScraping).toBe(false); });
  detachSseClient(controller);
  vi.restoreAllMocks();
});
async function run(opts: Partial<StartOpts> = {}): Promise<void> {
  expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, maxLeads: 1, ...opts })).toEqual({ ok: true });
  await vi.waitFor(() => expect(getStatus(clientId, opts.automation_id || null).isScraping).toBe(false), { timeout: 3000 });
}
const autoOpts = { automation_id: automationId, captureAttemptId: "attempt-a" };

describe("validação antes de qualquer efeito", () => {
  it.each([null, "dentista", [], [null], [1], [""], ["   "], ["válido", " "]])("rejeita nichos/regiões inválidos %j antes de assumir a sessão", input => {
    for (const key of ["niches", "regions"] as const) {
      expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, maxLeads: 1, [key]: input } as unknown as StartOpts))
        .toMatchObject({ ok: false });
    }
    expect(getStatus(clientId).isScraping).toBe(false);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Infinity, NaN, "20", null, 5001])("rejeita meta inválida %s sem iniciar sessão", maxLeads => {
    expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, maxLeads } as unknown as StartOpts))
      .toMatchObject({ ok: false });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each(["filterEmpty", "filterDuplicates", "filterLandlines", "filterWithWebsite", "filterWithInstagram"])("rejeita %s malformado sem DB/navegador", flag => {
    for (const invalid of ["false", "true", 0, 1, null, [], {}]) {
      expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, [flag]: invalid } as unknown as StartOpts).ok).toBe(false);
    }
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.loadMemory).not.toHaveBeenCalled();
    expect(getStatus(clientId).isScraping).toBe(false);
  });
});

describe("captura confirma persistência antes de contar", () => {
  it("não conta nem transmite um INSERT que falhou", async () => {
    insertError = true;
    await run({ webhookEnabled: true, mode: "batch", webhookUrl: "https://offline.test", maxLeads: undefined });
    expect(getLeads(clientId).count).toBe(0);
    expect(events.filter(event => event.event === "new_lead")).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("retoma 13/20, adiciona só 7 IDs confirmados e preserva o marcador junto aos detalhes", async () => {
    seed(13, 20);
    // O oitavo candidato nunca deve ser aberto após confirmar os sete restantes.
    places = Array.from({ length: 8 }, (_, i) => `novo-${i}`);
    await run({ ...autoOpts, maxLeads: 7, filterDuplicates: false });
    expect(automation().scraped_count).toBe(20);
    expect((filters()._capturedLeadIds as number[])).toHaveLength(20);
    expect(getLeads(clientId, automationId).count).toBe(7);
    expect(tables.leads_extraidos).toHaveLength(20);
    expect((tables.leads_extraidos[13].business_details as Row)).toMatchObject({ about: "Preservar detalhes", _automationCapture: { automationId, sessionId: "session-a", attemptId: "attempt-a" } });
    expect(filters()).toMatchObject({ _captureAttemptId: null, _captureLastOutcome: "goal_reached" });
    expect(filters()._scrapeFinishedAt).toEqual(expect.any(String));
    expect(writes.indexOf("insert:113")).toBeLessThan(writes.indexOf("checkpoint:14"));
    expect(writes.indexOf("checkpoint:14")).toBeLessThan(writes.indexOf("event"));
  });

  it("deixa marcador recuperável sem contar quando o checkpoint falha", async () => {
    seed(13, 20); checkpointError = true;
    await run({ ...autoOpts, maxLeads: 7 });
    expect(tables.leads_extraidos).toHaveLength(14);
    expect(automation().scraped_count).toBe(13);
    expect(getLeads(clientId, automationId).count).toBe(0);
    expect(events.filter(event => event.event === "new_lead")).toEqual([]);
    expect(filters()._scrapeFinishedAt).toBeFalsy();
    expect(filters()._captureLastOutcome).toBe("error");
    expect(filters()._captureRetryAt).toEqual(expect.any(String));
  });

  it("pausa persistida durante insert vence callback antigo e impede webhook", async () => {
    seed(13, 20);
    afterInsert = () => { automation().status = "paused"; filters()._captureAttemptId = null; };
    await run({ ...autoOpts, webhookEnabled: true, mode: "batch", webhookUrl: "https://offline.test" });
    expect(automation()).toMatchObject({ status: "paused", phase: "scraping", scraped_count: 13 });
    expect(filters()._scrapeFinishedAt).toBeFalsy();
    expect(getLeads(clientId, automationId).count).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("não transforma progresso positivo abaixo da meta em fim nem erro terminal", async () => {
    seed(13, 20);
    await run({ ...autoOpts, maxLeads: 7 });
    expect(automation()).toMatchObject({ status: "running", phase: "scraping", scraped_count: 14 });
    expect(filters()._scrapeFinishedAt).toBeFalsy();
    expect(filters()).toMatchObject({ _captureAttemptId: null, _captureLastOutcome: "exhausted", _captureRetryAt: expect.any(String) });
  });

  it.each(["token", "erro"])("checkpoint pré-INSERT com %s inválido não salva nem emite evento ou webhook", async failure => {
    seed(13, 20);
    let interrupted = false;
    mocks.from.mockImplementation((table: string) => {
      if (!interrupted && table === "automations" && detailVisits.length > 0) {
        interrupted = true;
        if (failure === "token") filters()._captureAttemptId = "outra-tentativa";
        else throw new Error("checkpoint temporariamente indisponível");
      }
      return query(table);
    });
    await run({ ...autoOpts, webhookEnabled: true, mode: "realtime", webhookUrl: "https://offline.test" });
    expect(interrupted).toBe(true);
    expect(tables.leads_extraidos).toHaveLength(13);
    expect(events.filter(event => event.event === "new_lead")).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(filters()._scrapeFinishedAt).toBeFalsy();
  });

  it("token invalidado antes da tentativa impede navegador e INSERT sem marcador válido", async () => {
    seed(13, 20);
    filters()._captureAttemptId = "outra-tentativa";
    await run(autoOpts);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(tables.leads_extraidos).toHaveLength(13);
    expect(automation().scraped_count).toBe(13);
    expect(filters()._captureAttemptId).toBe("outra-tentativa");
  });

  it("meta já confirmada não abre navegador nem coleta excedente", async () => {
    seed(20, 20);
    await run(autoOpts);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(tables.leads_extraidos).toHaveLength(20);
    expect(filters()._captureLastOutcome).toBe("goal_reached");
  });

  it("sessão trocada com mesmo token impede escrita e finalização antigas", async () => {
    seed(13, 20);
    afterInsert = () => { filters()._captureSessionId = "session-b"; };
    await run(autoOpts);
    expect(automation().scraped_count).toBe(13);
    expect(filters()._captureAttemptId).toBe("attempt-a");
    expect(filters()._captureLastOutcome).toBeUndefined();
  });

  it("IDs rejeitados não contam como válidos ao atualizar checkpoint", async () => {
    seed(13, 20);
    filters()._rejectedLeadIds = [1, 2];
    await run(autoOpts);
    expect(automation().scraped_count).toBe(12);
    expect((filters()._capturedLeadIds as number[])).toHaveLength(14);
    expect(filters()._captureLastOutcome).toBe("exhausted");
  });

  it("erro do Chromium não vira esgotamento bem sucedido", async () => {
    seed(13, 20); failNavigation = true;
    await run(autoOpts);
    expect(automation()).toMatchObject({ status: "running", phase: "scraping", scraped_count: 13 });
    expect(filters()).toMatchObject({ _captureLastOutcome: "error", _captureAttemptId: null });
    expect(filters()._scrapeFinishedAt).toBeFalsy();
  });

  it("mantém singleton ocupado até concluir o fechamento e ignora token substituído", async () => {
    seed(13, 20); failNavigation = true;
    let release = (): void => {};
    const closing = new Promise<void>(resolve => { release = resolve; });
    closeBrowser = () => closing;
    expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, ...autoOpts })).toEqual({ ok: true });
    await vi.waitFor(() => expect(searchTerms).toHaveLength(1));
    expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: "outro" })).toMatchObject({ busy: true });
    filters()._captureAttemptId = "attempt-b";
    release();
    await vi.waitFor(() => expect(getStatus(clientId, automationId).isScraping).toBe(false));
    expect(filters()._captureAttemptId).toBe("attempt-b");
    expect(filters()._captureLastOutcome).toBeUndefined();
  });

  it("heartbeat de 30s detecta pausa persistida durante operação longa", async () => {
    seed(13, 20);
    const interval = vi.spyOn(globalThis, "setInterval");
    let release = (): void => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    mocks.launch.mockImplementation(async () => { await blocked; throw new Error("navegador interrompido"); });
    expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, ...autoOpts })).toEqual({ ok: true });
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    const heartbeat = interval.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
    expect(heartbeat).toEqual(expect.any(Function));
    automation().status = "paused";
    filters()._captureAttemptId = null;
    if (typeof heartbeat === "function") heartbeat();
    await Promise.resolve();
    release();
    await vi.waitFor(() => expect(getStatus(clientId, automationId).isScraping).toBe(false));
    expect(automation()).toMatchObject({ status: "paused", scraped_count: 13 });
    expect(filters()._captureLastOutcome).toBeUndefined();
    expect(searchTerms).toEqual([]);
  });

  it("renova lease e heartbeat sem apagar IDs persistidos", async () => {
    seed(13, 20);
    let heartbeatAtStart: unknown;
    mocks.launch.mockImplementation(async () => { heartbeatAtStart = filters()._captureHeartbeatAt; throw new Error("Chromium indisponível"); });
    await run(autoOpts);
    expect(heartbeatAtStart).toEqual(expect.any(String));
    expect((filters()._capturedLeadIds as number[])).toHaveLength(13);
    expect(filters()._captureLeaseUntil).toBeNull();
  });
});

describe("descoberta recuperável e memória por nicho", () => {
  it("expande mesmo quando a região original não tem feed e confirma vazio explícito", async () => {
    seed(0, 2); noFeed = true;
    mocks.expand.mockImplementation(({ alreadySearched }: { alreadySearched: Set<string> }) => alreadySearched.has("vizinha sp") ? [] : ["Vizinha - SP"]);
    await run({ ...autoOpts, mode: "batch", maxLeads: 2 });
    expect(searchTerms).toContain("dentista Vizinha - SP");
    expect(mocks.markMemory).toHaveBeenCalledWith(clientId, "dentista", "Offline", expect.any(Object), "exhausted");
    expect(mocks.expand.mock.calls.every(([options]) => JSON.stringify(options.regions) === '["Offline"]')).toBe(true);
  });

  it("pula buscas esgotadas sem pular expansão e mantém cada nicho independente", async () => {
    seed(0, 2); noFeed = true;
    mocks.loadMemory.mockResolvedValue(new Set(["dentista:Offline"]));
    mocks.expand.mockImplementation(({ alreadySearched }: { alreadySearched: Set<string> }) => alreadySearched.has("vizinha sp") ? [] : ["Vizinha - SP"]);
    await run({ ...autoOpts, niches: ["dentista", "ortodontista"], mode: "batch", maxLeads: 2 });
    expect(searchTerms).not.toContain("dentista Offline");
    expect(searchTerms).toEqual(expect.arrayContaining(["ortodontista Offline", "dentista Vizinha - SP", "ortodontista Vizinha - SP"]));
  });

  it("limita cada tentativa a 20 consultas sem teto global de cidades", async () => {
    seed(0, 2); noFeed = true;
    mocks.expand.mockImplementation(({ alreadySearched }: { alreadySearched: Set<string> }) => [`Vizinha ${alreadySearched.size} - SP`]);
    await run({ ...autoOpts, mode: "batch", maxLeads: 2 });
    expect(searchTerms).toHaveLength(20);
    expect(mocks.markMemory).toHaveBeenCalledTimes(20);
  });

  it("captura estabelecimento único diretamente quando o Google Maps não renderiza feed", async () => {
    noFeed = true;
    singlePlaceMock = {
      name: "Vidraçaria Única",
      url: "https://www.google.com/maps/place/Vidra%C3%A7aria+%C3%9Anica",
      cardData: {
        name: "Vidraçaria Única",
        fullAddress: "R. Principal, 100 - Centro, Sete Lagoas - MG, 35700-000",
        categories: ["Vidraçaria"],
        phone: "(31) 3771-0000",
        website: "",
        averageRating: "4.8",
        reviewCount: 50,
        reviewCountSources: ["50 avaliações"],
      },
    };
    places = ["Vidraçaria Única"];
    await run({ niches: ["vidraçaria"], regions: ["Minas Gerais"], mode: "batch", maxLeads: 1 });
    expect(tables.leads_extraidos).toHaveLength(1);
    expect(tables.leads_extraidos[0].nome_negocio).toBe("Vidraçaria Única");
  });

  it("recupera sem falhar quando lista de resultados estiver indisponível e avança expansão", async () => {
    noFeed = true;
    singlePlaceMock = null;
    seed(0, 5);
    mocks.expand.mockImplementation(({ alreadySearched }: { alreadySearched: Set<string> }) => alreadySearched.has("vizinha sp") ? [] : ["Vizinha - SP"]);
    await run({ ...autoOpts, mode: "batch", maxLeads: 2 });
    expect(searchTerms).toContain("dentista Vizinha - SP");
    expect(filters()._captureLastOutcome).not.toBe("error");
  });

  it("feed indisponível sem vazio explícito não consome região na memória", async () => {
    noFeed = true; explicitEmpty = false; seed(0, 5);
    await run({ ...autoOpts, maxLeads: 5 });
    expect(mocks.markMemory).not.toHaveBeenCalled();
    expect(filters()._scrapeFinishedAt).toBeFalsy();
    expect(filters()._captureRetryAt).toEqual(expect.any(String));
  });

  it("falha da memória não é substituída por histórico vazio", async () => {
    seed(13, 20);
    mocks.loadMemory.mockRejectedValue(new Error("memória indisponível"));
    await run(autoOpts);
    expect(searchTerms).toEqual([]);
    expect(filters()._captureLastOutcome).toBe("error");
    expect(mocks.markMemory).not.toHaveBeenCalled();
  });

  it("retoma cursor de descartes sem abrir novamente detalhes e sem misturar filtros", async () => {
    seed(13, 20); rejectWithWebsite = true;
    places = ["descartado", "descartado-novo"];
    filters()._captureSearchCursor = { key: "dentista:Offline", seenURLs: ["https://www.google.com/maps/place/descartado"] };
    await run({ ...autoOpts, maxLeads: undefined, filterWithWebsite: true });
    expect(detailVisits).toEqual(["descartado-novo"]);
    expect((filters()._captureSearchCursor as Row).seenURLs).toHaveLength(2);
    expect(automation().scraped_count).toBe(13);
  });

  it("erro no detalhe não consome candidato nem marca consulta esgotada", async () => {
    seed(13, 20); detailError = true;
    await run(autoOpts);
    expect(filters()._captureSearchCursor).toBeUndefined();
    expect(filters()._captureLastOutcome).toBe("error");
    expect(mocks.markMemory).not.toHaveBeenCalled();
    expect(tables.leads_extraidos).toHaveLength(13);
  });

  it("stop local após INSERT não contabiliza nem envia webhook", async () => {
    afterInsert = () => { stopScraper(clientId); };
    await run({ mode: "batch", webhookEnabled: true, webhookUrl: "https://offline.test" });
    expect(getLeads(clientId).count).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("paridade de recuperação nas capturas manuais", () => {
  it("pausa no último lead impede lote e conclusão até retomar", async () => {
    const completed = vi.fn();
    mocks.summarize.mockImplementation(async () => {
      expect(pauseScraper(clientId)).toBe(true);
      return { cached: false };
    });
    expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, maxLeads: 1,
      reviews_ai: { enabled: true, model: "offline" }, mode: "batch", webhookEnabled: true,
      webhookUrl: "https://offline.test", onComplete: completed })).toEqual({ ok: true });
    await vi.waitFor(() => expect(mocks.summarize).toHaveBeenCalledOnce());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(getStatus(clientId)).toMatchObject({ isScraping: true, isPaused: true, leadCount: 1 });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(resumeScraper(clientId)).toBe(true);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ goalReached: true, totalLeads: 1 }));
  });

  it("limpar durante captura é rejeitado sem perder contagem nem exceder a meta", async () => {
    const cleared = vi.fn(() => clearLeads(clientId));
    const completed = vi.fn();
    places = ["primeiro", "segundo"];
    afterInsert = () => { if (tables.leads_extraidos.length === 2) cleared(); };
    await run({ maxLeads: 2, onComplete: completed, mode: "batch", webhookEnabled: true, webhookUrl: "https://offline.test" });
    expect(cleared).toHaveReturnedWith(false);
    expect(tables.leads_extraidos).toHaveLength(2);
    expect(getLeads(clientId).count).toBe(2);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ totalLeads: 2, goalReached: true }));
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toHaveLength(2);
    expect(clearLeads(clientId)).toBe(true);
    expect(getLeads(clientId).count).toBe(0);
  });

  it("orçamento sem limite não anuncia esgotamento nem envia lote parcial", async () => {
    const completed = vi.fn();
    await run({ regions: Array.from({ length: 21 }, (_, i) => `Região ${i}`), maxLeads: undefined,
      mode: "batch", webhookEnabled: true, webhookUrl: "https://offline.test", onComplete: completed });
    expect(searchTerms).toHaveLength(20);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ goalReached: false, error: expect.stringContaining("consultas") }));
    expect(events.some(event => event.event === "log" && String(event.message).includes("Captação concluída"))).toBe(false);
  });

  it.each(["batch", "realtime"])("expande até a meta sem depender do modo %s de webhook", async mode => {
    mocks.expand.mockImplementation(({ alreadySearched }: { alreadySearched: Set<string> }) => alreadySearched.has("vizinha sp") ? [] : ["Vizinha - SP"]);
    const completed = vi.fn();
    afterInsert = () => { places = ["novo", "novo-vizinha"]; };
    await run({ mode, maxLeads: 2, onComplete: completed });
    expect(searchTerms).toContain("dentista Vizinha - SP");
    expect(getLeads(clientId).count).toBe(2);
    expect(tables.leads_extraidos).toHaveLength(2);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ goalReached: true, totalLeads: 2 }));
  });

  it("retenta INSERT transitório reprocessando candidato e envia um único lote exato", async () => {
    const launch = mocks.launch.getMockImplementation()!;
    const completed = vi.fn();
    mocks.launch.mockImplementation(async (...args) => {
      insertError = mocks.launch.mock.calls.length === 1;
      return launch(...args);
    });
    await run({ maxLeads: 1, mode: "batch", webhookEnabled: true, webhookUrl: "https://offline.test", onComplete: completed });
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(detailVisits).toEqual(["novo", "novo"]);
    expect(tables.leads_extraidos).toHaveLength(1);
    expect(getLeads(clientId).count).toBe(1);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ goalReached: true, totalLeads: 1 }));
  });

  it("retenta após falha do navegador preservando leads e emite um único webhook batch", async () => {
    const completed = vi.fn();
    const launch = mocks.launch.getMockImplementation()!;
    mocks.launch.mockImplementation(async (...args) => {
      places = mocks.launch.mock.calls.length === 1 ? ["primeiro"] : ["primeiro", "segundo"];
      failNavigation = false;
      return launch(...args);
    });
    afterInsert = () => { failNavigation = tables.leads_extraidos.length === 1; };
    await run({ mode: "batch", maxLeads: 2, onComplete: completed, webhookEnabled: true, webhookUrl: "https://offline.test" });
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(getLeads(clientId).count).toBe(2);
    expect(tables.leads_extraidos.map(row => row.nome_negocio)).toEqual(["primeiro", "segundo"]);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toHaveLength(2);
    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ goalReached: true, totalLeads: 2 }));
  });

  it("Parar durante a espera cancela retomada sem enviar lote ou sinalizar sucesso", async () => {
    const completed = vi.fn();
    const sleepTimer = globalThis.setTimeout;
    let stopDuringWait = false;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      if (delay === 1000 && /at sleep \([^\n]*scraper-engine\.ts:/.test(new Error().stack || "")) {
        stopDuringWait = stopScraper(clientId);
      }
      return sleepTimer(callback, delay, ...args);
    }) as typeof setTimeout);
    await run({ mode: "batch", maxLeads: 2, onComplete: completed, webhookEnabled: true, webhookUrl: "https://offline.test" });
    expect(stopDuringWait).toBe(true);
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(getLeads(clientId).count).toBe(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ goalReached: false }));
  });

  it("pausa durante retry mantém sessão ocupada e só reabre navegador após retomar", async () => {
    let release = (): void => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn().mockImplementationOnce(() => waiting).mockResolvedValue(undefined);
    closeBrowser = close;
    mocks.expand.mockImplementation(({ alreadySearched }: { alreadySearched: Set<string> }) =>
      mocks.launch.mock.calls.length > 1 && !alreadySearched.has("vizinha sp") ? ["Vizinha - SP"] : []);
    expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, maxLeads: 2 })).toEqual({ ok: true });
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(pauseScraper(clientId)).toBe(true);
    } finally {
      release();
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(getStatus(clientId)).toMatchObject({ isScraping: true, isPaused: true, leadCount: 1 });
    expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: "outro" })).toMatchObject({ busy: true });
    expect(mocks.launch).toHaveBeenCalledOnce();
    places = ["novo", "segundo"];
    expect(resumeScraper(clientId)).toBe(true);
    await vi.waitFor(() => expect(getStatus(clientId).isScraping).toBe(false));
    expect(getLeads(clientId).count).toBe(2);
  });

  it("forceRestart durante fechamento de tentativa manual não finaliza a sessão nova", async () => {
    let release = (): void => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn().mockImplementationOnce(() => waiting).mockResolvedValue(undefined);
    closeBrowser = close;
    const oldCompleted = vi.fn();
    const newCompleted = vi.fn();
    expect(startScraperRun({ niches: ["dentista"], regions: ["Offline"], client_id: clientId, maxLeads: 2,
      onComplete: oldCompleted })).toEqual({ ok: true });
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      places = ["novo", "substituto"];
      expect(startScraperRun({ niches: ["dentista"], regions: ["Outra região"], client_id: clientId, maxLeads: 1,
        forceRestart: true, onComplete: newCompleted })).toEqual({ ok: true });
      await vi.waitFor(() => expect(newCompleted).toHaveBeenCalledOnce());
    } finally {
      release();
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(oldCompleted).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(getStatus(clientId)).toMatchObject({ isScraping: false, leadCount: 1 });
    expect(getLeads(clientId).leads.map(lead => lead.name)).toEqual(["substituto"]);
  });

  it("forceRestart durante espera substitui a sessão sem callback antigo nem terceira tentativa", async () => {
    const oldCompleted = vi.fn();
    const newCompleted = vi.fn();
    const sleepTimer = globalThis.setTimeout;
    let restarted = false;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      if (!restarted && delay === 1000 && /at sleep \([^\n]*scraper-engine\.ts:/.test(new Error().stack || "")) {
        restarted = true;
        places = ["novo", "substituto"];
        expect(startScraperRun({ niches: ["dentista"], regions: ["Outra região"], client_id: clientId, maxLeads: 1,
          forceRestart: true, onComplete: newCompleted })).toEqual({ ok: true });
      }
      return sleepTimer(callback, delay, ...args);
    }) as typeof setTimeout);
    await run({ mode: "batch", maxLeads: 2, onComplete: oldCompleted });
    expect(restarted).toBe(true);
    expect(oldCompleted).not.toHaveBeenCalled();
    expect(newCompleted).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(getLeads(clientId).leads.map(lead => lead.name)).toEqual(["substituto"]);
  });

  it("sem limite ativo encerra esgotamento sem expandir nem repetir e não mascara erros", async () => {
    const completed = vi.fn();
    await run({ mode: "batch", maxLeads: undefined, onComplete: completed });
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(mocks.expand).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ goalReached: false, totalLeads: 1 }));
  });

  it("falha sem limite não emite Captação concluída", async () => {
    failNavigation = true;
    await run({ maxLeads: undefined });
    expect(events.some(event => event.event === "log" && String(event.message).includes("Captação concluída"))).toBe(false);
  });
});

describe("CRM fail closed com escopo de cliente", () => {
  it("propaga erro retornado pelo banco em vez de aceitar candidato", async () => {
    duplicateError = true;
    await expect(checkCrmDuplicate("5511999990000@s.whatsapp.net", clientId)).rejects.toThrow("lookup indisponível");
  });
  it("reconhece telefone formatado sem JID e ignora outro cliente", async () => {
    tables.leads_extraidos.push({ id: 1, client_id: "outro", telefone: "(11) 99999-0000" });
    const identity = { phones: "+55 11 99999-0000", mapsUrl: "", placeId: "" };
    expect(await checkCrmDuplicate("5511999990000@s.whatsapp.net", clientId, identity)).toBeNull();
    tables.contacts.push({ id: 2, client_id: clientId, phone_number: "(11) 99999-0000" });
    expect(await checkCrmDuplicate("5511999990000@s.whatsapp.net", clientId, identity)).toBe("contacts");
  });
  it("deduplica negócio sem telefone por place ID e URL canônica", async () => {
    tables.leads_extraidos.push({ id: 1, client_id: clientId, place_id: "ChIJ-known", maps_url: "https://www.google.com/maps/place/Loja/@1,2,15z/data=x?hl=pt-BR" });
    expect(await checkCrmDuplicate("", clientId, { phones: "", placeId: "ChIJ-known", mapsUrl: "" })).toBe("leads_extraidos");
    expect(await checkCrmDuplicate("", clientId, { phones: "", placeId: "", mapsUrl: "https://www.google.com/maps/place/Loja/@5,6,12z/data=x?hl=en" })).toBe("leads_extraidos");
  });
});
