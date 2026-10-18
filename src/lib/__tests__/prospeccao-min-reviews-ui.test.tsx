import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/app/automacao/AutomationLogs", () => ({ AutomationLogs: () => null }));
vi.mock("@/components/ai-module-shared", () => ({ ModelOptions: () => null }));

import ProspeccaoSitesPage from "@/app/prospeccao-sites/page";

const label = "Mínimo de avaliações no Google";
const helper = "Quantidade de pessoas que deram estrelas, com ou sem comentário. Não filtra pela nota. 0 = sem mínimo.";
const instagramLabel = "Somente com Instagram";
const instagramHelper = "Exige perfil informado no Google Maps; não busca no site.";
const fetchMock = vi.fn<typeof fetch>();
let emitScraperEvent: (data: Record<string, unknown>) => void;

function posts(url: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => input === url && init?.method === "POST")
    .map(([, init]) => init!);
}

async function openAutomation() {
  fireEvent.click(screen.getByRole("button", { name: "Automação", exact: true }));
  fireEvent.change(screen.getByPlaceholderText("Ex: Pizzarias SP - Outubro"), { target: { value: "Teste" } });
  fireEvent.change(screen.getByPlaceholderText(/pizzaria/), { target: { value: "padaria" } });
  fireEvent.change(screen.getByPlaceholderText(/São Paulo SP/), { target: { value: "Vitória" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/instances", expect.anything()));
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: "whatsapp-A" }));
}

function fillCapture() {
  fireEvent.change(screen.getByPlaceholderText(/pizzaria/), { target: { value: "padaria" } });
  fireEvent.change(screen.getByPlaceholderText(/São Paulo SP/), { target: { value: "Vitória" } });
}

describe("mínimo de avaliações na Prospecção Sites", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => Response.json(
      input === "/api/instances"
        ? { instances: [{ instance_name: "whatsapp-A" }] }
        : { success: true, ok: true, leads: [], total: 0, campaigns: [], automations: [], models: [] },
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      constructor() {
        emitScraperEvent = data => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
      }
      close() {}
    });
    vi.spyOn(window, "alert").mockImplementation(() => {});
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {});
    cleanup();
    vi.unstubAllGlobals();
  });

  it("atualiza o contador com count do evento SSE new_lead do engine", async () => {
    render(<ProspeccaoSitesPage />);

    act(() => emitScraperEvent({ event: "new_lead", lead: { nome: "Padaria teste" }, count: 7 }));

    expect(screen.getByRole("button", { name: /Captura\s*7 leads/ })).toBeInTheDocument();
  });

  it("preserva a precedência de leadCount e o fallback para leads nos eventos SSE", async () => {
    render(<ProspeccaoSitesPage />);

    act(() => emitScraperEvent({ event: "leads_update", leadCount: 3, count: 9, leads: [{}] }));
    expect(screen.getByRole("button", { name: /Captura\s*3 leads/ })).toBeInTheDocument();

    act(() => emitScraperEvent({ event: "leads_update", leads: [{}, {}] }));
    expect(screen.getByRole("button", { name: /Captura\s*2 leads/ })).toBeInTheDocument();

    act(() => emitScraperEvent({ event: "new_lead", leadCount: 0, count: 9, leads: [{}] }));
    expect(screen.getByRole("button", { name: "Captura", exact: true })).toBeInTheDocument();

    act(() => emitScraperEvent({ event: "new_lead", count: 0, leads: [{}, {}] }));
    expect(screen.getByRole("button", { name: "Captura", exact: true })).toBeInTheDocument();
  });

  it("mantém controles acessíveis, independentes e com padrão zero", async () => {
    render(<ProspeccaoSitesPage />);
    const capture = screen.getByRole("spinbutton", { name: label });
    expect(capture).toHaveValue(0);
    expect(capture).toHaveAttribute("min", "0");
    expect(capture).toHaveAttribute("step", "1");
    expect(capture).toHaveAttribute("max", "2147483647");
    expect(capture).toHaveAccessibleDescription(helper);
    fireEvent.change(capture, { target: { value: "25" } });

    fireEvent.click(screen.getByRole("button", { name: "Automação", exact: true }));
    const automation = screen.getByRole("spinbutton", { name: label });
    expect(automation).toHaveValue(0);
    expect(automation).toHaveAttribute("min", "0");
    expect(automation).toHaveAttribute("step", "1");
    expect(automation).toHaveAttribute("max", "2147483647");
    expect(automation).toHaveAccessibleDescription(helper);
    fireEvent.change(automation, { target: { value: "50" } });

    fireEvent.click(screen.getByRole("button", { name: "Captura", exact: true }));
    expect(screen.getByRole("spinbutton", { name: label })).toHaveValue(25);
    fireEvent.click(screen.getByRole("button", { name: "Automação", exact: true }));
    expect(screen.getByRole("spinbutton", { name: label })).toHaveValue(50);
  });

  it("mantém o filtro Instagram acessível, desligado por padrão e independente entre formulários", async () => {
    render(<ProspeccaoSitesPage />);
    const capture = screen.getByRole("checkbox", { name: instagramLabel });
    expect(capture).not.toBeChecked();
    expect(capture).toHaveAccessibleDescription(instagramHelper);
    fireEvent.change(screen.getByRole("spinbutton", { name: label }), { target: { value: "25" } });
    fireEvent.click(screen.getByText(instagramLabel, { exact: true }));
    expect(capture).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: label })).toHaveValue(25);

    fireEvent.click(screen.getByRole("button", { name: "Automação", exact: true }));
    const automation = screen.getByRole("checkbox", { name: instagramLabel });
    expect(automation).not.toBeChecked();
    expect(automation).toHaveAccessibleDescription(instagramHelper);
    fireEvent.change(screen.getByRole("spinbutton", { name: label }), { target: { value: "50" } });
    fireEvent.click(screen.getByText(instagramLabel, { exact: true }));
    expect(automation).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: label })).toHaveValue(50);

    fireEvent.click(screen.getByRole("button", { name: "Captura", exact: true }));
    expect(screen.getByRole("checkbox", { name: instagramLabel })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: instagramLabel }));
    expect(screen.getByRole("checkbox", { name: instagramLabel })).not.toBeChecked();
    expect(screen.getByRole("spinbutton", { name: label })).toHaveValue(25);

    fireEvent.click(screen.getByRole("button", { name: "Automação", exact: true }));
    expect(screen.getByRole("checkbox", { name: instagramLabel })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: label })).toHaveValue(50);
  });

  it.each([false, true])("encaminha filterWithInstagram=%s da Captura sem alterar outros filtros", async (withInstagram) => {
    render(<ProspeccaoSitesPage />);
    fillCapture();
    const checkbox = screen.getByRole("checkbox", { name: instagramLabel });
    if (withInstagram) fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole("spinbutton", { name: label }), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar captura" }));

    await waitFor(() => expect(posts("/api/scraper")).toHaveLength(1));
    const body = JSON.parse(String(posts("/api/scraper")[0].body));
    expect(body).toMatchObject({
      filterWithInstagram: withInstagram,
      minReviews: 25,
      filterEmpty: true,
      filterDuplicates: true,
      filterLandlines: false,
      filterWithWebsite: false,
      captureAllReviews: false,
    });
    expect(body).not.toHaveProperty("reviews_ai");
  });

  it.each([false, true])("persiste filterWithInstagram=%s da Automação sem alterar outros filtros", async (withInstagram) => {
    render(<ProspeccaoSitesPage />);
    await openAutomation();
    const checkbox = screen.getByRole("checkbox", { name: instagramLabel });
    if (withInstagram) fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole("spinbutton", { name: label }), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar automação", exact: true }));

    await waitFor(() => expect(posts("/api/automations")).toHaveLength(1));
    const body = JSON.parse(String(posts("/api/automations")[0].body));
    expect(body.scrape_filters).toMatchObject({
      _source: "prospeccao-sites",
      filterWithInstagram: withInstagram,
      minReviews: 50,
      filterEmpty: true,
      filterDuplicates: true,
      filterLandlines: false,
      filterWithWebsite: true,
      captureAllReviews: false,
      reviews_ai: { enabled: false },
    });
  });

  it.each(["0", "25", "2147483647"])("encaminha mínimo %s da Captura sem ligar comentários/IA", async (value) => {
    render(<ProspeccaoSitesPage />);
    fillCapture();
    fireEvent.change(screen.getByRole("spinbutton", { name: label }), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar captura" }));

    await waitFor(() => expect(posts("/api/scraper")).toHaveLength(1));
    const body = JSON.parse(String(posts("/api/scraper")[0].body));
    expect(body).toMatchObject({ minReviews: Number(value), captureAllReviews: false });
    expect(body).not.toHaveProperty("reviews_ai");
  });

  it.each(["", "-1", "1.5", "2147483648"])("bloqueia mínimo inválido %s da Captura antes do POST", async (value) => {
    render(<ProspeccaoSitesPage />);
    fillCapture();
    const input = screen.getByRole("spinbutton", { name: label });
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar captura" }));

    expect(posts("/api/scraper")).toHaveLength(0);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("inteiro entre 0 e 2147483647");
  });

  it("encaminha mínimo da Automação sem ligar comentários/IA", async () => {
    render(<ProspeccaoSitesPage />);
    await openAutomation();
    fireEvent.change(screen.getByRole("spinbutton", { name: label }), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar automação", exact: true }));

    await waitFor(() => expect(posts("/api/automations")).toHaveLength(1));
    const body = JSON.parse(String(posts("/api/automations")[0].body));
    expect(body.scrape_filters).toMatchObject({ minReviews: 50, captureAllReviews: false, reviews_ai: { enabled: false } });
  });

  it.each(["", "-1", "1.5", "2147483648"])("bloqueia mínimo inválido %s da Automação antes do POST", async (value) => {
    render(<ProspeccaoSitesPage />);
    await openAutomation();
    const input = screen.getByRole("spinbutton", { name: label });
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Criar automação", exact: true }));

    expect(posts("/api/automations")).toHaveLength(0);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("inteiro entre 0 e 2147483647");
  });
});
