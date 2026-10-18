// @vitest-environment node
/** Offline integration: real Chromium DOM/evaluate; fixture-only navigation, no Google/API/DB. */
import { once } from "node:events";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type BrowserContext } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  evolution: vi.fn(),
  summarize: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("puppeteer-extra", () => ({ default: { use: vi.fn(), launch: mocks.launch } }));
vi.mock("puppeteer-extra-plugin-stealth", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: mocks.from }, supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/evolution", () => ({ getEvolutionConfig: mocks.evolution }));
vi.mock("@/lib/reviews-ai", () => ({ summarizeReviewsForLead: mocks.summarize }));
vi.mock("@/lib/safe-url", () => ({ fetchPublicHttpUrl: mocks.fetch }));

import {
  getLeads, getStatus, startScraperRun, stopScraper, type StartOpts,
} from "../scraper-engine";

const clientId = "offline-review-count-pipeline";
const browserPath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

interface PlaceFixture {
  id: string;
  cardCount?: number;
  detailCount?: number | string;
  stars?: string;
  comments?: number;
  reviewerCount?: number;
  jslogReviewer?: boolean;
  aggregateControl?: number;
  otherBusinessCount?: number;
  plainSummary?: boolean;
  instagramLinks?: string[];
  reviewerInstagram?: string;
  otherBusinessInstagram?: string;
  outsideInstagram?: string;
  visitorInstagram?: string;
  recommendationInstagram?: string;
  website?: string;
}
interface ReviewWork { tabs: number; expansions: number; scrolls: number }

const urlFor = (id: string): string => `https://www.google.com/maps/place/${id}`;
const documentHtml = (body: string): string => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>${body}</body></html>`;

function listingHtml(places: PlaceFixture[]): string {
  return documentHtml(`<div role="feed">${places.map((place) => `
    <div class="Nv2PK"><a href="${urlFor(place.id)}"><span class="qBF1Pd">${place.id}</span></a>
      <span role="img" aria-label="${place.stars || "4,9"} estrelas"></span>
      ${place.cardCount === undefined ? "" : `<span class="UY7F9">(${place.cardCount.toLocaleString("pt-BR")})</span>`}
      <div class="W4Efsd"><span>Comércio</span><span>Rua Offline, 1</span></div>
    </div>`).join("")}<p>Você chegou ao final da lista</p></div>`);
}

function detailHtml(place: PlaceFixture): string {
  const comments = Array.from({ length: place.comments ?? 50 }, (_, index) => `
    <div role="article" data-review-id="comment-${index}" aria-label="Avaliação de Autor ${index}: 5 estrelas">
      <span>Autor ${index}: comentário offline único.</span>
      ${place.reviewerInstagram ? `<a href="${place.reviewerInstagram}">Instagram do autor</a>` : ""}
      ${place.reviewerCount === undefined ? "" : `<button aria-label="${place.reviewerCount} avaliações">${place.reviewerCount} avaliações no perfil do autor</button>`}
      <button onclick="window.__reviewWork.expansions++">Mais</button>
    </div>`).join("");
  return documentHtml(`
    <script>
      window.__reviewWork = { tabs: 0, expansions: 0, scrolls: 0 };
      document.addEventListener('scroll', () => window.__reviewWork.scrolls++, true);
    </script>
    ${place.outsideInstagram ? `<aside><a href="${place.outsideInstagram}">Instagram fora do painel</a></aside>` : ""}
    <main role="main"><h1>${place.id}</h1>
    <div role="region" aria-label="Informações de ${place.id}">
      <button data-item-id="phone:tel:11999990000" aria-label="Telefone: (11) 99999-0000">Ligar</button>
      ${(place.instagramLinks || []).map(url => `<a href="${url}">Instagram</a>`).join("")}
      ${place.website ? `<a data-item-id="authority" href="${place.website}">Website</a>` : ""}
    </div>
    ${place.visitorInstagram ? `<section aria-label="Perguntas e respostas"><p>Visitante mencionando outra loja</p><a aria-label="Instagram" href="${place.visitorInstagram}">Instagram de terceiro</a></section>` : ""}
    ${place.recommendationInstagram ? `<section aria-label="Outros negócios"><a href="${place.recommendationInstagram}">Instagram do concorrente</a></section>` : ""}
    ${place.otherBusinessInstagram ? `<div role="feed"><div class="Nv2PK"><a href="${place.otherBusinessInstagram}">Instagram de outro negócio</a></div></div>` : ""}
    <div class="F7nice">${place.plainSummary
      ? `<span aria-hidden="true">${place.stars || "5"}</span><span role="img" aria-label="${place.stars || "5"} estrelas">${place.stars || "5"}</span> <span>${place.detailCount} reviews</span>`
      : `<span role="img" aria-label="${place.stars || "4,9"} estrelas"></span>${place.detailCount === undefined ? "" : `<span aria-label="${place.detailCount} avaliações">${place.detailCount} avaliações</span>`}`}
    </div>
    ${place.aggregateControl === undefined ? "" : `<button jsaction="pane.rating.moreReviews" aria-label="${place.aggregateControl} avaliações">Ver avaliações</button>`}
    <button role="tab" aria-label="Avaliações" onclick="window.__reviewWork.tabs++">Avaliações</button>
    ${place.jslogReviewer ? '<div jslog="review"><button aria-label="950 reviews">Local Guide</button></div>' : ""}
    ${place.otherBusinessCount === undefined ? "" : `<div role="feed"><div class="Nv2PK"><div class="F7nice"><span aria-label="${place.otherBusinessCount} avaliações">Outro negócio</span></div></div></div>`}
    ${comments}</main>`);
}

// A missing browser skips explicitly, never substitutes a fake DOM for Chromium.
describe.sequential.skipIf(!browserPath)("scraper review-count pipeline (Chromium offline)", () => {
  let browser: Browser;
  const browserLifetime = new AbortController();
  let context: BrowserContext;
  let closeContext: () => Promise<void>;
  let fixtures: PlaceFixture[];
  let navigations: string[];
  let unexpectedRequests: string[];
  let completedDetails: { url: string; work: ReviewWork }[];
  let acceleratedSleeps: number[];
  let diagnostics: string[];
  let startedAt: number;
  let blockedNavigation: string | undefined;
  const newPage = vi.fn();

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      signal: browserLifetime.signal,
      args: ["--no-sandbox", "--disable-background-networking", "--disable-component-update",
        "--no-first-run", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"],
    });
  }, 30000);
  afterAll(async () => {
    if (!browser) return;
    const closingAt = performance.now();
    const child = browser.process();
    let phase = "process exit";
    const exited = child && child.exitCode === null && child.signalCode === null
      ? once(child, "exit") : Promise.resolve();
    // Shutdown gracioso libera LevelDB antes da remoção do perfil (EBUSY no Windows).
    // ponytail: fallback após 2s só para esta árvore; close() nunca é abandonado.
    const forceStop = setTimeout(() => {
      if (child?.exitCode === null && child.signalCode === null) browserLifetime.abort();
    }, 2000);
    const diagnostic = setTimeout(() => console.error(
      `[offline browser cleanup] waiting for ${phase}; pid=${child?.pid}; elapsed=${Math.round(performance.now() - closingAt)}ms`,
    ), 8000);
    try {
      await Promise.all([
        browser.close(),
        exited.then(() => { clearTimeout(forceStop); phase = "profile cleanup"; }),
      ]);
    } finally {
      clearTimeout(forceStop);
      clearTimeout(diagnostic);
    }
  });

  beforeEach(async () => {
    startedAt = performance.now();
    diagnostics = [];
    // Allocate before starting the engine: teardown always owns even an in-flight newPage().
    context = await browser.createBrowserContext();
    let closing: Promise<void> | undefined;
    closeContext = () => closing ||= context.close();
    fixtures = [];
    navigations = [];
    unexpectedRequests = [];
    completedDetails = [];
    acceleratedSleeps = [];
    blockedNavigation = undefined;
    newPage.mockReset();
    mocks.insert.mockReset();
    mocks.from.mockImplementation((table: string) => {
      if (!["leads_extraidos", "contacts"].includes(table)) throw new Error(`Unexpected table: ${table}`);
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query),
        insert: vi.fn((payload: unknown) => { mocks.insert(payload); return query; }),
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        single: vi.fn(async () => ({ data: { id: mocks.insert.mock.calls.length }, error: null })),
      };
      return query;
    });
    mocks.evolution.mockResolvedValue({ instance: "offline" });
    mocks.summarize.mockResolvedValue({ cached: false });
    mocks.fetch.mockImplementation(() => { throw new Error("External HTTP is forbidden in this suite"); });
    vi.stubGlobal("fetch", mocks.fetch);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      // Only the engine's sleep() is accelerated. Puppeteer's selector/navigation deadlines stay real.
      const stack = new Error().stack || "";
      const engineSleep = /at sleep \([^\n]*scraper-engine\.ts:/.test(stack);
      if (engineSleep && typeof delay === "number") acceleratedSleeps.push(delay);
      return realTimeout(callback, engineSleep ? 0 : delay, ...args);
    }) as typeof setTimeout);

    mocks.launch.mockImplementation(async () => {
      const runContext = context;
      newPage.mockImplementation(async () => {
        diagnostics.push(`${Math.round(performance.now() - startedAt)}ms newPage start`);
        const page = await runContext.newPage();
        diagnostics.push(`${Math.round(performance.now() - startedAt)}ms newPage ready`);
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          const url = request.url();
          const place = fixtures.find((candidate) => url === urlFor(candidate.id));
          const isSearch = url.startsWith("https://www.google.com/maps/search/");
          if (request.isNavigationRequest()) {
            navigations.push(url);
            diagnostics.push(`${Math.round(performance.now() - startedAt)}ms fixture ${url}`);
          }
          if (url === blockedNavigation) return; // Cleanup regression deliberately holds this local response.
          if (request.isNavigationRequest() && (isSearch || place)) {
            void request.respond({ status: 200, contentType: "text/html; charset=utf-8",
              body: isSearch ? listingHtml(fixtures) : detailHtml(place!) });
          } else {
            unexpectedRequests.push(url);
            void request.abort();
          }
        });
        return {
          setViewport: page.setViewport.bind(page),
          setExtraHTTPHeaders: page.setExtraHTTPHeaders.bind(page),
          // Fixture transport owns interception; do not add the engine's competing continue() listener.
          setRequestInterception: async () => {}, on: () => {},
          goto: page.goto.bind(page), waitForSelector: page.waitForSelector.bind(page),
          evaluate: page.evaluate.bind(page),
          close: async () => {
            completedDetails.push({ url: page.url(), work: await page.evaluate(() =>
              (window as unknown as { __reviewWork: ReviewWork }).__reviewWork) });
            await page.close();
          },
        };
      });
      return { newPage, close: closeContext };
    });
  });

  afterEach(async () => {
    stopScraper(clientId);
    try {
      // Share one close promise with the engine's finally; never close the same context twice.
      await closeContext();
      await vi.waitFor(() => expect(getStatus(clientId).isScraping).toBe(false), { timeout: 5000 });
      expect(unexpectedRequests).toEqual([]);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(acceleratedSleeps).toContain(2000);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  }, 10000);

  async function run(options: Partial<StartOpts> = {}): Promise<void> {
    expect(startScraperRun({
      niches: ["comércio"], regions: ["Offline"], client_id: clientId,
      minReviews: 100, maxLeads: 2, filterEmpty: true,
      reviews_ai: { enabled: true, model: "offline-model" }, ...options,
    })).toEqual({ ok: true });
    try {
      await vi.waitFor(() => expect(getStatus(clientId).isScraping).toBe(false), { timeout: 15000, interval: 20 });
    } catch (error) {
      throw new Error(`Pipeline did not finish: ${diagnostics.join("; ")}; accelerated sleeps=${acceleratedSleeps.join(",")}`, { cause: error });
    }
    expect(acceleratedSleeps).toEqual([2000, ...completedDetails.map(() => 2000)]);
  }

  it("requires a business profile before deep reviews and counts only accepted leads toward quota", async () => {
    fixtures = [
      { id: "no-instagram", cardCount: 100, comments: 1 },
      { id: "fake-domain", cardCount: 100, instagramLinks: ["https://fakeinstagram.com/shop/"] },
      { id: "post-not-profile", cardCount: 100, instagramLinks: ["https://instagram.com/p/abc/"] },
      { id: "unrelated-profile", cardCount: 100, reviewerInstagram: "https://instagram.com/reviewer/", otherBusinessInstagram: "https://instagram.com/other/", outsideInstagram: "https://instagram.com/outside/" },
      { id: "accepted", cardCount: 100, instagramLinks: ["https://instagram.com/", "https://www.instagram.com/shop/?igsh=test"] },
      { id: "past-quota", cardCount: 100, instagramLinks: ["https://instagram.com/later/"] },
    ];
    await run({ filterWithInstagram: true, maxLeads: 1 });
    expect(getLeads(clientId).leads.map(lead => [lead.name, lead.instagram])).toEqual([["accepted", "https://www.instagram.com/shop/"]]);
    expect(navigations).not.toContain(urlFor("past-quota"));
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ nome_negocio: "accepted", instagram: "https://www.instagram.com/shop/", client_id: clientId }));
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    for (const detail of completedDetails.filter(detail => detail.url !== urlFor("accepted"))) {
      expect(detail.work).toEqual({ tabs: 0, expansions: 0, scrolls: 0 });
    }
  }, 20000);

  it("ignores visitor and recommendation links outside the business contacts even without review/feed markers", async () => {
    fixtures = [
      { id: "visitor-link-not-contact", cardCount: 100, visitorInstagram: "https://instagram.com/another_shop/" },
      { id: "recommendation-not-contact", cardCount: 100, recommendationInstagram: "https://instagram.com/competitor/" },
      { id: "business-contact", cardCount: 100, instagramLinks: ["https://instagram.com/business/"] },
    ];
    await run({ filterWithInstagram: true, maxLeads: 1 });
    expect(getLeads(clientId).leads.map(lead => lead.name)).toEqual(["business-contact"]);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    for (const detail of completedDetails.slice(0, 2)) {
      expect(detail.work).toEqual({ tabs: 0, expansions: 0, scrolls: 0 });
    }
  }, 20000);

  it("rejects reserved contact URLs and accepts percent-encoded business profiles", async () => {
    fixtures = [
      { id: "login-not-profile", cardCount: 100, instagramLinks: ["https://instagram.com/login/"] },
      { id: "robots-not-profile", cardCount: 100, instagramLinks: ["https://instagram.com/robots.txt"] },
      { id: "encoded-dot", cardCount: 100, instagramLinks: ["https://instagram.com/loja%2Eexemplo/"] },
      { id: "encoded-letter", cardCount: 100, instagramLinks: ["https://instagram.com/%6Coja/"] },
    ];
    await run({ filterWithInstagram: true });
    expect(getLeads(clientId).leads.map(lead => [lead.name, lead.instagram])).toEqual([
      ["encoded-dot", "https://www.instagram.com/loja.exemplo/"], ["encoded-letter", "https://www.instagram.com/loja/"],
    ]);
    expect(mocks.insert.mock.calls.map(([payload]) => payload.nome_negocio)).toEqual(["encoded-dot", "encoded-letter"]);
    expect(mocks.summarize).toHaveBeenCalledTimes(2);
  }, 20000);

  it("rejects missing Instagram before deep reviews even when captureAllReviews is enabled", async () => {
    fixtures = [{ id: "no-profile-deep-reviews", cardCount: 100, comments: 2 }];
    await run({ filterWithInstagram: true, captureAllReviews: true });
    expect(getLeads(clientId)).toEqual({ leads: [], count: 0 });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.evolution).not.toHaveBeenCalled();
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect(completedDetails).toEqual([{ url: urlFor(fixtures[0].id), work: { tabs: 0, expansions: 0, scrolls: 0 } }]);
  }, 20000);

  it("keeps the existing website-authority definition when Instagram occupies that button", async () => {
    fixtures = [{ id: "instagram-website-button", cardCount: 100, website: "https://instagram.com/shop/" }];
    await run({ filterWithInstagram: true, filterWithWebsite: true });
    expect(getLeads(clientId).count).toBe(0);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(completedDetails[0].work).toEqual({ tabs: 0, expansions: 0, scrolls: 0 });
  }, 20000);

  it("keeps legacy capture without Instagram when the filter is disabled", async () => {
    fixtures = [{ id: "legacy-no-instagram", cardCount: 100 }];
    await run({ filterWithInstagram: false, reviews_ai: { enabled: false } });
    expect(getLeads(clientId).leads.map(lead => lead.name)).toEqual(["legacy-no-instagram"]);
    expect(mocks.summarize).not.toHaveBeenCalled();
  }, 20000);

  it("accepts a locally decoded Google profile redirect and combines with minimum reviews", async () => {
    fixtures = [
      { id: "below-minimum", cardCount: 99, instagramLinks: ["https://instagram.com/shop/"] },
      { id: "redirect-profile", cardCount: 100, instagramLinks: ["https://www.google.com/url?q=https%3A%2F%2Finstagram.com%2Fshop%2F"] },
    ];
    await run({ filterWithInstagram: true });
    expect(getLeads(clientId).leads.map(lead => lead.instagram)).toEqual(["https://www.instagram.com/shop/"]);
    expect(navigations).not.toContain(urlFor("below-minimum"));
  }, 20000);

  it("preserves the independent website exclusion with Instagram enabled", async () => {
    fixtures = [{ id: "with-website", cardCount: 100, instagramLinks: ["https://instagram.com/shop/"], website: "https://shop.test/" }];
    await run({ filterWithInstagram: true, filterWithWebsite: true });
    expect(getLeads(clientId).leads).toEqual([]);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect(completedDetails[0].work).toEqual({ tabs: 0, expansions: 0, scrolls: 0 });
  }, 20000);

  it("cleans up pending navigation deterministically and permits the next run", async () => {
    fixtures = [{ id: "held-detail-navigation" }];
    blockedNavigation = urlFor(fixtures[0].id);
    expect(startScraperRun({
      niches: ["comércio"], regions: ["Offline"], client_id: clientId, minReviews: 100,
    })).toEqual({ ok: true });
    await vi.waitFor(() => expect(navigations).toContain(blockedNavigation), { timeout: 5000 });

    expect(stopScraper(clientId)).toBe(true);
    await closeContext(); // Cancels real Chromium's pending goto, not its timeout clock.
    await vi.waitFor(() => expect(getStatus(clientId).isScraping).toBe(false), { timeout: 5000 });
    expect(getLeads(clientId)).toEqual({ leads: [], count: 0 });
    expect(mocks.insert).not.toHaveBeenCalled();
  }, 15000);

  it("rejects 99 before opening details; 100 low-star and 200 high-star leads alone fill maxLeads=2", async () => {
    fixtures = [
      { id: "rejected-99", cardCount: 99, detailCount: 999, stars: "5,0" },
      { id: "boundary-100", cardCount: 100, detailCount: 100, stars: "2,1" },
      { id: "qualified-200", cardCount: 200, detailCount: 200, stars: "4,9" },
      { id: "after-cap", cardCount: 999, detailCount: 999 },
    ];
    await run();

    const { leads, count } = getLeads(clientId);
    expect(count).toBe(2);
    expect(leads.map(({ name, reviewCount, averageRating }) => ({ name, reviewCount, averageRating }))).toEqual([
      { name: "boundary-100", reviewCount: "100", averageRating: "2.1" },
      { name: "qualified-200", reviewCount: "200", averageRating: "4.9" },
    ]);
    expect(leads.map((lead) => lead.reviewsDetalhes?.length)).toEqual([50, 50]);
    expect(newPage).toHaveBeenCalledTimes(3); // Search + two qualified details, not the rejected card.
    expect(navigations.slice(1)).toEqual([urlFor("boundary-100"), urlFor("qualified-200")]);
    expect(mocks.insert.mock.calls.map(([payload]) => [payload.nome_negocio, payload.reviews, payload.client_id])).toEqual([
      ["boundary-100", 100, clientId], ["qualified-200", 200, clientId],
    ]);
    expect(mocks.summarize).toHaveBeenCalledTimes(2);
    expect(completedDetails.map(({ work }) => work)).toEqual([
      { tabs: 0, expansions: 0, scrolls: 0 }, { tabs: 0, expansions: 0, scrolls: 0 },
    ]);
  }, 20000);

  it("uses the aggregate from the already-open detail when the card has no count", async () => {
    fixtures = [{ id: "detail-fallback", detailCount: 123, stars: "1,2" }];
    await run({ maxLeads: 1 });

    expect(getLeads(clientId)).toMatchObject({ count: 1, leads: [{ name: "detail-fallback", reviewCount: "123", averageRating: "1.2" }] });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ reviews: 123 }));
    expect(newPage).toHaveBeenCalledTimes(2);
    expect(navigations.slice(1)).toEqual([urlFor("detail-fallback")]);
  }, 20000);

  it("keeps a space-grouped count separate from the summary rating", async () => {
    fixtures = [{ id: "space-grouped-summary", plainSummary: true, stars: "5", detailCount: "5 123" }];
    await run({ minReviews: 5000, maxLeads: 1 });

    expect(getLeads(clientId)).toMatchObject({ count: 1, leads: [{ reviewCount: "5 123" }] });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ reviews: 5123 }));
  }, 20000);

  it("uses the business aggregate control without reading unrelated controls", async () => {
    fixtures = [{ id: "aggregate-control", aggregateControl: 123 }];
    await run({ maxLeads: 1 });

    expect(getLeads(clientId)).toMatchObject({ count: 1, leads: [{ reviewCount: "123" }] });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ reviews: 123 }));
  }, 20000);

  it("keeps exact card count 1.234 when the detail only reports rounded 1,2 mil", async () => {
    fixtures = [{ id: "exact-card-rounded-detail", cardCount: 1234, detailCount: "1,2 mil" }];
    await run({ minReviews: 1200, maxLeads: 1 });

    expect(getLeads(clientId)).toMatchObject({ count: 1, leads: [{ reviewCount: "1.234" }] });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ reviews: 1234 }));
    expect(navigations.slice(1)).toEqual([urlFor("exact-card-rounded-detail")]);
  }, 20000);

  it.each([
    { id: "detail-below-minimum", detailCount: 99, comments: 2, minReviews: 100 },
    { id: "unknown-jslog-profile-not-total", jslogReviewer: true, comments: 2, minReviews: 100 },
    { id: "unknown-other-business-not-total", otherBusinessCount: 950, comments: 2, minReviews: 100 },
    { id: "integer-rating-not-thousands", plainSummary: true, stars: "5", detailCount: 123, comments: 2, minReviews: 1000 },
    { id: "unknown-profile-not-total", reviewerCount: 200, comments: 150, minReviews: 100 },
    // The initial extractor caps comments at 50: use 40 to catch a false count=comments.length fallback too.
    { id: "unknown-comments-not-total", reviewerCount: 200, comments: 150, minReviews: 40 },
  ])("rejects $id without deep review work even with captureAllReviews=true", async (place) => {
    fixtures = [place];
    await run({ minReviews: place.minReviews, captureAllReviews: true });

    expect(getLeads(clientId)).toEqual({ leads: [], count: 0 });
    expect(getStatus(clientId)).toMatchObject({ isScraping: false, leadCount: 0 });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.evolution).not.toHaveBeenCalled();
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect(newPage).toHaveBeenCalledTimes(2);
    expect(navigations.slice(1)).toEqual([urlFor(place.id)]);
    expect(completedDetails).toEqual([{ url: urlFor(place.id), work: { tabs: 0, expansions: 0, scrolls: 0 } }]);
  }, 20000);
});
