import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  extractYearFromRelativeDate,
  leadExtraFilterReason,
  parseGoogleYear,
  parseMaxReviews,
  parseRatingBound,
  resolveLeadGoogleYear,
  validateGoogleYearRange,
  validateRatingRange,
  validateReviewCountRange,
} from "../scraper-lead-filters";
import { evaluateLeadFilters, type Lead } from "../scraper-engine";
import { makeSearchKey } from "../scraper-search-memory";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
          then: (cb: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve(cb({ data: [], error: null })),
        }),
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    channel: () => ({
      on: function () { return this; },
      subscribe: function () { return this; },
    }),
    removeChannel: () => { },
  },
  supabaseAdmin: null,
}));

import CaptadorPage from "@/app/captador/page";
import AutomacaoPage from "@/app/automacao/page";
import ProspeccaoSitesPage from "@/app/prospeccao-sites/page";

const REF_DATE = new Date("2026-06-15T12:00:00Z");

describe("scraper-lead-filters — validadores e extratores de ano no Google", () => {
  it("valida anos do Google (0 = desativado, 1900..anoAtual+1)", () => {
    expect(parseGoogleYear(undefined, REF_DATE)).toBe(0);
    expect(parseGoogleYear(null, REF_DATE)).toBe(0);
    expect(parseGoogleYear("", REF_DATE)).toBe(0);
    expect(parseGoogleYear(0, REF_DATE)).toBe(0);
    expect(parseGoogleYear("0", REF_DATE)).toBe(0);
    expect(parseGoogleYear(2019, REF_DATE)).toBe(2019);
    expect(parseGoogleYear("2019", REF_DATE)).toBe(2019);
    expect(parseGoogleYear(2026, REF_DATE)).toBe(2026);
    expect(parseGoogleYear(1899, REF_DATE)).toBeNull();
    expect(parseGoogleYear(2099, REF_DATE)).toBeNull();
    expect(parseGoogleYear("abc", REF_DATE)).toBeNull();
  });

  it("valida intervalo de anos (ex.: 2019 até 2026)", () => {
    expect(validateGoogleYearRange(2019, 2026, REF_DATE)).toBeNull();
    expect(validateGoogleYearRange(2019, 0, REF_DATE)).toBeNull();
    expect(validateGoogleYearRange(0, 2022, REF_DATE)).toBeNull();
    expect(validateGoogleYearRange(2025, 2019, REF_DATE)).toContain("não pode ser maior");
  });

  it("valida máximo de avaliações e faixa de nota (0 a 5)", () => {
    expect(parseMaxReviews(undefined)).toBe(0);
    expect(parseMaxReviews("150")).toBe(150);
    expect(parseMaxReviews(-1)).toBeNull();
    expect(validateReviewCountRange(10, 50)).toBeNull();
    expect(validateReviewCountRange(100, 50)).toContain("não pode ser maior");

    expect(parseRatingBound("4,5")).toBe(4.5);
    expect(parseRatingBound(4.8)).toBe(4.8);
    expect(parseRatingBound(5.5)).toBeNull();
    expect(validateRatingRange(3.5, 4.9)).toBeNull();
    expect(validateRatingRange(4.8, 4.0)).toContain("não pode ser maior");
  });

  it("extrai ano de datas relativas e explícitas das avaliações do Google Maps", () => {
    expect(extractYearFromRelativeDate("há 7 anos", REF_DATE)).toBe(2019);
    expect(extractYearFromRelativeDate("7\u00a0anos atrás", REF_DATE)).toBe(2019);
    expect(extractYearFromRelativeDate("Editado há 7 anos", REF_DATE)).toBe(2019);
    expect(extractYearFromRelativeDate("7 years ago", REF_DATE)).toBe(2019);
    expect(extractYearFromRelativeDate("há um ano", REF_DATE)).toBe(2025);
    expect(extractYearFromRelativeDate("um ano atrás", REF_DATE)).toBe(2025);
    expect(extractYearFromRelativeDate("a year ago", REF_DATE)).toBe(2025);
    expect(extractYearFromRelativeDate("há 2 meses", REF_DATE)).toBe(2026);
    expect(extractYearFromRelativeDate("2 meses atrás", REF_DATE)).toBe(2026);
    expect(extractYearFromRelativeDate("há 3 semanas", REF_DATE)).toBe(2026);
    expect(extractYearFromRelativeDate("3 semanas atrás", REF_DATE)).toBe(2026);
    expect(extractYearFromRelativeDate("desde 2019", REF_DATE)).toBe(2019);
  });

  it("resolve o ano mais antigo em que o lead está no Google (texto + anos no mercado + avaliações)", () => {
    expect(
      resolveLeadGoogleYear({
        bodyText: "Empresa tradicional · 7+ anos no mercado",
        refDate: REF_DATE,
      }),
    ).toBe(2019);

    expect(
      resolveLeadGoogleYear({
        reviews: [
          { data: "há 2 meses", texto: "Ótimo" },
          { data: "há 7 anos", texto: "Excelente desde a abertura" },
          { data: "há 3 anos", texto: "Muito bom" },
        ],
        refDate: REF_DATE,
      }),
    ).toBe(2019);

    expect(
      resolveLeadGoogleYear({
        yearEstablished: "2021",
        reviews: [{ data: "há 7 anos", texto: "Primeira avaliação" }],
        refDate: REF_DATE,
      }),
    ).toBe(2019);
  });

  it("filtra leads por ano no Google (ex.: desde 2019 até data atual), máximo de avaliações e nota", () => {
    const emptyLeads: Lead[] = [];
    // Lead de 2019 com 45 avaliações e nota 4.6 -> passa no filtro 2019..2026
    const pass2019 = evaluateLeadFilters(
      "27999998888",
      "",
      {
        googleYearFrom: 2019,
        googleYearTo: 2026,
        minReviews: 10,
        maxReviews: 200,
        minRating: 4.0,
        maxRating: 4.9,
      },
      emptyLeads,
      "45",
      "",
      { averageRating: "4.6", yearEstablished: "2019" },
    );
    expect(pass2019).toEqual({ pass: true, reason: "" });

    // Lead de 2016 -> descartado quando filtro pede desde 2019
    const reject2016 = evaluateLeadFilters(
      "27999998888",
      "",
      { googleYearFrom: 2019, googleYearTo: 2026 },
      emptyLeads,
      "45",
      "",
      { averageRating: "4.6", yearEstablished: "2016" },
    );
    expect(reject2016.pass).toBe(false);
    expect(reject2016.reason).toContain("No Google desde 2016 (anterior a 2019)");

    // Lead com mais avaliações que maxReviews -> descartado
    const rejectMaxReviews = evaluateLeadFilters(
      "27999998888",
      "",
      { maxReviews: 100 },
      emptyLeads,
      "250",
      "",
      { averageRating: "4.6", yearEstablished: "2021" },
    );
    expect(rejectMaxReviews.pass).toBe(false);
    expect(rejectMaxReviews.reason).toContain("Mais de 100 avaliações no Google");

    // Lead com nota abaixo de minRating -> descartado
    const rejectLowRating = evaluateLeadFilters(
      "27999998888",
      "",
      { minRating: 4.2 },
      emptyLeads,
      "50",
      "",
      { averageRating: "3.8", yearEstablished: "2021" },
    );
    expect(rejectLowRating.pass).toBe(false);
    expect(rejectLowRating.reason).toContain("Nota 3.8 abaixo do mínimo (4.2)");

    // Em estágio de cartão (cardStage=true), não descarta por ano ainda desconhecido
    expect(
      leadExtraFilterReason({
        googleYearFrom: 2019,
        googleYearTo: 2026,
        cardStage: true,
        refDate: REF_DATE,
      }),
    ).toBeNull();
  });

  it("diferencia chave de memória de busca quando filtros novos estão ativos sem quebrar o hash padrão", () => {
    const baseKey = makeSearchKey("dentista", "Vitória/ES", { minReviews: 0 });
    const zeroExtrasKey = makeSearchKey("dentista", "Vitória/ES", {
      minReviews: 0,
      maxReviews: 0,
      minRating: 0,
      maxRating: 0,
      googleYearFrom: 0,
      googleYearTo: 0,
    });
    expect(zeroExtrasKey).toBe(baseKey);

    const yearKey = makeSearchKey("dentista", "Vitória/ES", {
      minReviews: 0,
      googleYearFrom: 2019,
      googleYearTo: 2026,
    });
    expect(yearKey).not.toBe(baseKey);
  });
});

describe("UI — filtros de ano no Google (desde 2019 até hoje) e qualificação em todas as telas de captura", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/auth/session")) {
        return Response.json({ authenticated: true, clientId: "c1", isAdmin: true });
      }
      if (url.includes("/api/instances") || url.includes("/api/whatsapp")) {
        return Response.json({ instances: [{ instance_name: "inst-1", instanceName: "inst-1" }] });
      }
      if (url.includes("/api/ai-models")) {
        return Response.json({ success: true, models: [{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }] });
      }
      if (url.includes("/api/automations")) {
        return Response.json({ success: true, ok: true, automations: [], automation: { id: "auto-1" } });
      }
      if (url.includes("/api/prospeccao-sites/leads")) {
        return Response.json({
          ok: true,
          leads: [
            {
              id: 101,
              remoteJid: "5527999998888@s.whatsapp.net",
              nome_negocio: "Clínica Sorriso 2019",
              telefone: "5527999998888",
              ramo_negocio: "Dentista",
              endereco: "Vitória - ES",
              rating: "4.8",
              reviews: 45,
              year_established: "2019",
              website: null,
              created_at: "2026-06-15T10:00:00Z",
              opt_out: false,
            },
          ],
          total: 1,
          disparoJids: [],
        });
      }
      if (url.includes("/api/prospeccao-sites/campaigns")) {
        return Response.json({ success: true, campaigns: [] });
      }
      return Response.json({ success: true, ok: true, leads: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close() { }
    });
    vi.stubGlobal("alert", vi.fn());
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await act(async () => { });
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Captador Maps (/captador): envia googleYearFrom=2019, googleYearTo=anoAtual, maxReviews e minRating para /api/scraper", async () => {
    render(<CaptadorPage />);
    fireEvent.change(screen.getByLabelText("Nichos (um por linha)"), { target: { value: "odontologia" } });
    fireEvent.change(screen.getByLabelText("Regiões (uma por linha)"), { target: { value: "Vitória/ES" } });
    fireEvent.click(screen.getByRole("button", { name: "Desde 2019 até hoje" }));
    fireEvent.change(screen.getByLabelText("Máximo de avaliações"), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText("Nota mínima (0 a 5)"), { target: { value: "4.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));

    await waitFor(() => {
      const startCalls = fetchMock.mock.calls
        .filter(([url, init]) => url === "/api/scraper" && init?.body)
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
        .filter((b) => b.action === "start");
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0]).toMatchObject({
        niches: ["odontologia"],
        regions: ["Vitória/ES"],
        googleYearFrom: 2019,
        googleYearTo: new Date().getFullYear(),
        maxReviews: 300,
        minRating: 4.2,
      });
    });
  });

  it("Prospecção de Sites — Aba Captura e Aba Automação (/prospeccao-sites): envia filtro 'Desde 2019 até hoje' e filtros extras", async () => {
    render(<ProspeccaoSitesPage />);
    // 1. Aba Captura
    fireEvent.change(screen.getByLabelText("Nichos (1 por linha)"), { target: { value: "clínica estética" } });
    fireEvent.change(screen.getByLabelText("Regiões (1 por linha)"), { target: { value: "Belo Horizonte MG" } });
    fireEvent.click(screen.getByRole("button", { name: "Desde 2019 até hoje" }));
    fireEvent.change(screen.getByLabelText("Máximo de avaliações"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: /Iniciar captura/i }));

    await waitFor(() => {
      const startCalls = fetchMock.mock.calls
        .filter(([url, init]) => url === "/api/scraper" && init?.body)
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
        .filter((b) => b.action === "start");
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0]).toMatchObject({
        niches: ["clínica estética"],
        regions: ["Belo Horizonte MG"],
        googleYearFrom: 2019,
        googleYearTo: new Date().getFullYear(),
        maxReviews: 150,
      });
    });

    // 2. Aba Leads dentro de Prospecção de Sites
    fireEvent.click(screen.getByRole("button", { name: /^Leads/i }));
    const leadsYearFromInput = await screen.findByLabelText("No Google desde (ano) nos leads");
    const leadsYearToInput = screen.getByLabelText("Até o ano no Google nos leads");
    const leadsReviewsMaxInput = screen.getByLabelText("Máximo de avaliações dos leads");
    fireEvent.change(leadsYearFromInput, { target: { value: "2019" } });
    fireEvent.change(leadsYearToInput, { target: { value: "2026" } });
    fireEvent.change(leadsReviewsMaxInput, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: /Aplicar/i }));

    await waitFor(() => {
      const leadUrls = fetchMock.mock.calls
        .map(([url]) => (typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url))
        .filter((u) => u.includes("/api/prospeccao-sites/leads?"));
      expect(leadUrls.some((u) => u.includes("googleYearFrom=2019") && u.includes("googleYearTo=2026") && u.includes("reviewsMax=250"))).toBe(true);
    });
    expect(await screen.findByText("Desde 2019")).toBeTruthy();

    // 3. Aba Automação dentro de Prospecção de Sites
    fireEvent.click(screen.getByRole("button", { name: /Automação/i }));
    const yearFromInput = await screen.findByLabelText("No Google desde (ano)");
    const yearToInput = screen.getByLabelText("Até o ano (0 = atual)");
    fireEvent.click(screen.getByRole("button", { name: "Desde 2019 até hoje" }));
    expect(yearFromInput).toHaveValue(2019);
    expect(yearToInput).toHaveValue(new Date().getFullYear());
  });

  it("Automação Completa (/automacao): salva googleYearFrom, googleYearTo, maxReviews e minRating em scrape_filters", async () => {
    render(<AutomacaoPage />);
    const newBtn = await screen.findByRole("button", { name: /Nova Automação/i });
    fireEvent.click(newBtn);

    fireEvent.change(screen.getByLabelText("Nome da automação"), { target: { value: "Campanha Google 2019+" } });
    const instanceSelect = screen.getByLabelText("Instância WhatsApp");
    await waitFor(() => {
      if (!instanceSelect.querySelector('option[value="inst-1"]')) {
        const opt = document.createElement("option");
        opt.value = "inst-1";
        instanceSelect.appendChild(opt);
      }
      fireEvent.change(instanceSelect, { target: { value: "inst-1" } });
      expect(instanceSelect).toHaveValue("inst-1");
    });
    fireEvent.click(screen.getByRole("button", { name: /Captação e análise/i }));

    fireEvent.change(screen.getByLabelText("Nichos (um por linha)"), { target: { value: "advocacia" } });
    fireEvent.change(screen.getByLabelText("Regiões (uma por linha)"), { target: { value: "São Paulo/SP" } });
    fireEvent.click(screen.getByText("Desde 2019 até hoje"));
    fireEvent.change(screen.getByLabelText("Máximo de avaliações"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Nota mínima (0 a 5)"), { target: { value: "4.5" } });

    const saveDraftBtn = screen.getByRole("button", { name: /Salvar rascunho/i });
    fireEvent.click(saveDraftBtn);

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls
        .filter(([url, init]) => url === "/api/automations" && init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].scrape_filters).toMatchObject({
        googleYearFrom: 2019,
        googleYearTo: new Date().getFullYear(),
        maxReviews: 500,
        minRating: 4.5,
      });
    });
  }, 15000);
});
