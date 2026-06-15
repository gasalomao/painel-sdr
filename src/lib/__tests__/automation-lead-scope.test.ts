import { describe, it, expect } from "vitest";
import { resolveCapturedLeadScope, type CapturedLeadScope } from "../automation-lead-scope";

// ===========================================================================
// Lead = forma mínima da linha de leads_extraidos relevante pro disparo.
// ===========================================================================
type Lead = {
  id: number;
  client_id: string;
  remoteJid: string | null;
  created_at: string;
};

/**
 * applyScope — espelha, 1:1, a query que o startDispatchPhase monta:
 *
 *   .from("leads_extraidos").not("remoteJid","is",null)
 *   [.gt("id", scope.baselineMaxId)]      // se baselineMaxId !== null
 *   [.eq("client_id", a.client_id)]       // se a automação tem client_id
 *   [.gte("created_at", scope.startedAt)] // se startedAt definido
 *
 * Se o startDispatchPhase mudar os filtros, este helper precisa mudar junto —
 * por isso o comentário "espelha o applyScope" lá no worker.
 */
function applyScope(scope: Extract<CapturedLeadScope, { ok: true }>, leads: Lead[], clientId: string | null): Lead[] {
  return leads.filter((l) => {
    if (l.remoteJid == null) return false;
    if (scope.baselineMaxId !== null && !(l.id > scope.baselineMaxId)) return false;
    if (clientId && l.client_id !== clientId) return false;
    if (scope.startedAt && !(l.created_at >= scope.startedAt)) return false;
    return true;
  });
}

// ===========================================================================
// resolveCapturedLeadScope — resolução dos marcadores
// ===========================================================================
describe("resolveCapturedLeadScope", () => {
  const SCRAPE_START = "2026-05-22T03:00:00.000Z";

  it("marcadores normais → ok, com baselineMaxId e startedAt", () => {
    const s = resolveCapturedLeadScope({ _baselineMaxId: 1226, _scrapeStartedAt: SCRAPE_START });
    expect(s).toEqual({ ok: true, baselineMaxId: 1226, startedAt: SCRAPE_START });
  });

  it("_baselineMaxId = 0 é válido (CRM vazio antes do scrape)", () => {
    const s = resolveCapturedLeadScope({ _baselineMaxId: 0, _scrapeStartedAt: SCRAPE_START });
    expect(s).toEqual({ ok: true, baselineMaxId: 0, startedAt: SCRAPE_START });
  });

  it("só _baselineMaxId (sem data) → ok — o filtro por id basta", () => {
    const s = resolveCapturedLeadScope({ _baselineMaxId: 1226 });
    expect(s).toEqual({ ok: true, baselineMaxId: 1226, startedAt: null });
  });

  it("sem _baselineMaxId mas com _scrapeStartedAt → ok (automação antiga)", () => {
    const s = resolveCapturedLeadScope({ _scrapeStartedAt: SCRAPE_START });
    expect(s).toEqual({ ok: true, baselineMaxId: null, startedAt: SCRAPE_START });
  });

  it("sem _scrapeStartedAt mas com fallback started_at → ok", () => {
    const s = resolveCapturedLeadScope({}, SCRAPE_START);
    expect(s).toEqual({ ok: true, baselineMaxId: null, startedAt: SCRAPE_START });
  });

  it("NENHUM marcador → aborta (não dispara pro CRM inteiro)", () => {
    const s = resolveCapturedLeadScope({});
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toMatch(/não foi possível identificar/i);
  });

  it("scrapeFilters null/undefined → aborta", () => {
    expect(resolveCapturedLeadScope(null).ok).toBe(false);
    expect(resolveCapturedLeadScope(undefined).ok).toBe(false);
  });

  it("marcadores lixo (string 'undefined', NaN) → tratados como ausentes → aborta", () => {
    const s = resolveCapturedLeadScope({ _baselineMaxId: "xyz", _scrapeStartedAt: "undefined" });
    expect(s.ok).toBe(false);
  });

  it("config do usuário no scrape_filters não interfere na resolução", () => {
    const s = resolveCapturedLeadScope({
      filterEmpty: true,
      filterLandlines: true,
      _baselineMaxId: 5000,
      _scrapeStartedAt: SCRAPE_START,
    });
    expect(s).toEqual({ ok: true, baselineMaxId: 5000, startedAt: SCRAPE_START });
  });
});

// ===========================================================================
// REGRESSÃO — "bug das 232": o scraper captou 5, o disparo dizia 232.
// ===========================================================================
describe("regressão: disparo NÃO pode pegar o CRM inteiro", () => {
  const CLIENT = "client-advogacia";
  const SCRAPE_START = "2026-05-22T03:00:00.000Z";

  // Cenário real: o CRM já tinha 227 leads de captações anteriores. Como a
  // tabela tem histórico, os ids NÃO começam em 1 — começam em 1000. Ou seja
  // TODO lead antigo tem id > 227 (a contagem). É exatamente isso que fazia
  // `.gt("id", _baselineCount)` deixar o CRM inteiro passar.
  const oldLeads: Lead[] = Array.from({ length: 227 }, (_, i) => ({
    id: 1000 + i, // ids 1000..1226
    client_id: CLIENT,
    remoteJid: `55119${String(1000 + i).padStart(8, "0")}@s.whatsapp.net`,
    created_at: "2026-04-10T12:00:00.000Z", // antigos
  }));

  // O scrape de AGORA captou 5 leads novos — ids 1227..1231.
  const newLeads: Lead[] = Array.from({ length: 5 }, (_, i) => ({
    id: 1227 + i,
    client_id: CLIENT,
    remoteJid: `55119${String(1227 + i).padStart(8, "0")}@s.whatsapp.net`,
    created_at: "2026-05-22T03:05:00.000Z", // durante o scrape
  }));

  const allLeads = [...oldLeads, ...newLeads];

  // Marcadores que o startScrapingPhase grava ANTES do scrape:
  const baselineCount = oldLeads.length;                       // 227  (contagem)
  const baselineMaxId = Math.max(...oldLeads.map((l) => l.id)); // 1226 (maior id)

  it("o cenário monta o caso certo: count(227) << maxId(1226)", () => {
    expect(baselineCount).toBe(227);
    expect(baselineMaxId).toBe(1226);
    expect(allLeads).toHaveLength(232);
  });

  it("BUG ANTIGO — `.gt(id, _baselineCount)` pegava 232 (o CRM inteiro)", () => {
    // Reproduz o filtro quebrado: contagem usada como id, sem filtro de data.
    const buggy = allLeads.filter((l) => l.remoteJid != null && l.id > baselineCount && l.client_id === CLIENT);
    expect(buggy).toHaveLength(232); // ← o sintoma exato que você viu
  });

  it("CORRIGIDO — scope com _baselineMaxId pega exatamente os 5 novos", () => {
    const scope = resolveCapturedLeadScope({ _baselineMaxId: baselineMaxId, _scrapeStartedAt: SCRAPE_START });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    const selected = applyScope(scope, allLeads, CLIENT);
    expect(selected).toHaveLength(5);
    expect(selected.map((l) => l.id).sort((a, b) => a - b)).toEqual([1227, 1228, 1229, 1230, 1231]);
  });

  it("CORRIGIDO — funciona mesmo SEM o filtro de data (id sozinho basta)", () => {
    const scope = resolveCapturedLeadScope({ _baselineMaxId: baselineMaxId }); // sem _scrapeStartedAt
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(applyScope(scope, allLeads, CLIENT)).toHaveLength(5);
  });

  it("multi-tenant — disparo do cliente A nunca pega leads do cliente B", () => {
    const leadOutroCliente: Lead = {
      id: 1228, // id na faixa dos novos, mas de OUTRO cliente
      client_id: "outro-cliente",
      remoteJid: "5511000000000@s.whatsapp.net",
      created_at: "2026-05-22T03:06:00.000Z",
    };
    const scope = resolveCapturedLeadScope({ _baselineMaxId: baselineMaxId, _scrapeStartedAt: SCRAPE_START });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    const selected = applyScope(scope, [...allLeads, leadOutroCliente], CLIENT);
    expect(selected).toHaveLength(5); // o lead do outro cliente NÃO entra
    expect(selected.every((l) => l.client_id === CLIENT)).toBe(true);
  });

  it("leads sem WhatsApp (remoteJid null) são ignorados no disparo", () => {
    const semZap: Lead = { id: 1300, client_id: CLIENT, remoteJid: null, created_at: "2026-05-22T03:07:00.000Z" };
    const scope = resolveCapturedLeadScope({ _baselineMaxId: baselineMaxId, _scrapeStartedAt: SCRAPE_START });
    if (!scope.ok) return;
    expect(applyScope(scope, [...allLeads, semZap], CLIENT)).toHaveLength(5);
  });

  it("marcadores perdidos (salvou a automação rodando) → aborta, NÃO dispara", () => {
    // scrape_filters foi sobrescrito pelo form save → sem marcadores `_`.
    const scope = resolveCapturedLeadScope({ filterEmpty: true, filterLandlines: true });
    expect(scope.ok).toBe(false); // melhor parar com erro do que spammar 232 leads
  });
});
