import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
import CaptadorPage from "@/app/captador/page";

const fetchMock = vi.fn<typeof fetch>();
let emit: (data: Record<string, unknown>) => void;
const minimumLabel = "Mínimo de avaliações no Google";
const minimumHelp = "Quantidade de pessoas que deram estrelas, com ou sem comentário. Não filtra pela nota. 0 = sem mínimo.";

function starts(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/scraper" && init?.body)
    .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
    .filter(body => body.action === "start");
}

function fillCapture(): void {
  fireEvent.change(screen.getByLabelText("Nichos (um por linha)"), { target: { value: "padaria\ncafeteria" } });
  fireEvent.change(screen.getByLabelText("Regiões (uma por linha)"), { target: { value: "Vitória/ES" } });
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async input => Response.json(input === "/api/ai-models"
    ? { success: true, models: [{ id: "modelo-teste", name: "Modelo teste" }] }
    : { success: true, leads: [] }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class {
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    constructor() { emit = data => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) })); }
    close() {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
  vi.unstubAllGlobals();
});

describe("paridade da captura no Captador Maps", () => {
  it("oferece os mesmos filtros da Prospecção, sem ligar IA ou comentários", async () => {
    render(<CaptadorPage />);
    const minimum = screen.getByRole("spinbutton", { name: minimumLabel });
    expect(minimum).toHaveValue(0);
    expect(minimum).toHaveAttribute("min", "0");
    expect(minimum).toHaveAttribute("step", "1");
    expect(minimum).toHaveAttribute("max", "2147483647");
    expect(minimum).toHaveAccessibleDescription(minimumHelp);
    expect(screen.getByRole("checkbox", { name: "Somente com Instagram" })).toHaveAccessibleDescription("Exige perfil informado no Google Maps; não busca no site.");
    expect(screen.getByRole("checkbox", { name: "Somente com Instagram" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Remover leads sem telefone" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Remover telefones duplicados" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Remover telefones fixos" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Capturar somente leads sem site" })).not.toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Quantidade máxima de leads" })).toHaveValue(50);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/ai-models")).toBe(false);
  });

  it.each(["0", "25", "2147483647"])("encaminha mínimo %s e meta positiva para a continuidade do motor existente", async value => {
    render(<CaptadorPage />);
    fillCapture();
    fireEvent.change(screen.getByRole("spinbutton", { name: minimumLabel }), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]).toMatchObject({
      niches: ["padaria", "cafeteria"], regions: ["Vitória/ES"], minReviews: Number(value),
      maxLeads: 50, filterEmpty: true, filterDuplicates: true, filterLandlines: false,
      filterWithWebsite: false, filterWithInstagram: false, captureAllReviews: false,
      webhookEnabled: false, mode: "realtime",
    });
    expect(starts()[0]).not.toHaveProperty("reviews_ai");
  });

  it("encaminha filtros combinados e captura ampliada independente da IA", async () => {
    render(<CaptadorPage />);
    fillCapture();
    fireEvent.click(screen.getByRole("checkbox", { name: "Somente com Instagram" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Capturar somente leads sem site" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Remover telefones fixos" }));
    fireEvent.click(screen.getByText("Avaliações completas e análise com IA", { exact: true }));
    fireEvent.click(screen.getByRole("switch", { name: "Capturar todas as avaliações" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantidade máxima de leads" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]).toMatchObject({ maxLeads: 3, filterWithInstagram: true, filterWithWebsite: true, filterLandlines: true, captureAllReviews: true });
    expect(starts()[0]).not.toHaveProperty("reviews_ai");
  });

  it.each(["", "-1", "1.5", "2147483648"])("bloqueia mínimo inválido %s antes de iniciar", async value => {
    render(<CaptadorPage />);
    fillCapture();
    const minimum = screen.getByRole("spinbutton", { name: minimumLabel });
    fireEvent.change(minimum, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));
    expect(starts()).toHaveLength(0);
    expect(minimum).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Informe um inteiro entre 0 e 2147483647.");
  });

  it.each(["", "0", "-1", "1.5", "5001"])("não transforma meta inválida %s em captura sem limite", async value => {
    render(<CaptadorPage />);
    fillCapture();
    const limit = screen.getByRole("spinbutton", { name: "Quantidade máxima de leads" });
    fireEvent.change(limit, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));
    expect(starts()).toHaveLength(0);
    expect(limit).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Informe um inteiro entre 1 e 5000.");
  });

  it("desliga o limite apenas por escolha explícita, como na Prospecção", async () => {
    render(<CaptadorPage />);
    fillCapture();
    fireEvent.click(screen.getByRole("switch", { name: "Limite de leads" }));
    expect(screen.queryByRole("spinbutton", { name: "Quantidade máxima de leads" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]).toMatchObject({ maxLeads: 0 });
  });

  it.each([false, true])("bloqueia configurações durante captura com pausa SSE=%s, sem bloquear ações", async isPaused => {
    render(<CaptadorPage />);
    fillCapture();
    fireEvent.change(screen.getByRole("spinbutton", { name: minimumLabel }), { target: { value: "25" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantidade máxima de leads" }), { target: { value: "3" } });
    fireEvent.click(screen.getByText("Avaliações completas e análise com IA", { exact: true }));
    fireEvent.click(screen.getByRole("switch", { name: "Resumir avaliações com IA" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Modelo de IA para avaliações" })).toHaveValue("modelo-teste"));
    fireEvent.change(screen.getByLabelText("Instruções para resumir avaliações"), { target: { value: "Resuma as dores" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));
    await screen.findByText("Clientes Extraídos");
    act(() => emit({ event: "status", isScraping: true, isPaused }));
    fireEvent.click(screen.getByRole("button", { name: "Configuração" }));
    fireEvent.click(screen.getByText("Avaliações completas e análise com IA", { exact: true }));
    const controls = [
      screen.getByLabelText("Nichos (um por linha)"),
      screen.getByLabelText("Regiões (uma por linha)"),
      screen.getByRole("spinbutton", { name: minimumLabel }),
      ...screen.getAllByRole("checkbox"),
      ...screen.getAllByRole("switch"),
      screen.getByRole("combobox", { name: "Modelo de IA para avaliações" }),
      screen.getByLabelText("Instruções para resumir avaliações"),
      screen.getByRole("spinbutton", { name: "Quantidade máxima de leads" }),
    ];
    for (const control of controls) {
      if (control.getAttribute("role") === "switch") expect(control).toHaveAttribute("aria-disabled", "true");
      else expect(control).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: isPaused ? "Retomar" : "Pausar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Parar" })).toBeEnabled();
    act(() => emit({ event: "status", isScraping: false, isPaused: false }));
    for (const control of controls) {
      if (control.getAttribute("role") === "switch") expect(control).not.toHaveAttribute("aria-disabled", "true");
      else expect(control).toBeEnabled();
    }
    expect(screen.getByRole("spinbutton", { name: minimumLabel })).toHaveValue(25);
    expect(screen.getByRole("spinbutton", { name: "Quantidade máxima de leads" })).toHaveValue(3);
    expect(screen.getByLabelText("Instruções para resumir avaliações")).toHaveValue("Resuma as dores");
  });

  it.each(["http", "conexão"])("descarta modelo antigo e bloqueia início se reload da IA falha por %s", async failure => {
    render(<CaptadorPage />);
    fillCapture();
    fireEvent.click(screen.getByText("Avaliações completas e análise com IA", { exact: true }));
    const toggle = screen.getByRole("switch", { name: "Resumir avaliações com IA" });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Modelo de IA para avaliações" })).toHaveValue("modelo-teste"));
    fireEvent.click(toggle);
    expect(screen.queryByRole("combobox", { name: "Modelo de IA para avaliações" })).not.toBeInTheDocument();
    if (failure === "http") fetchMock.mockResolvedValueOnce(Response.json({ success: false, error: "IA indisponível" }, { status: 503 }));
    else fetchMock.mockRejectedValueOnce(new Error("IA indisponível"));
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("IA indisponível");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" })); });
    expect(starts()).toHaveLength(0);
    expect(screen.getByRole("combobox", { name: "Modelo de IA para avaliações" })).toHaveValue("");
    expect(screen.queryByRole("option", { name: "Modelo teste" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/ai-models")).toHaveLength(2);
  });

  it("ativa IA somente por opção explícita, carregando modelo e encaminhando prompt", async () => {
    render(<CaptadorPage />);
    fillCapture();
    fireEvent.click(screen.getByText("Avaliações completas e análise com IA", { exact: true }));
    fireEvent.click(screen.getByRole("switch", { name: "Resumir avaliações com IA" }));
    const model = await screen.findByRole("option", { name: "Modelo teste" });
    expect(model).toHaveValue("modelo-teste");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Modelo de IA para avaliações" })).toHaveValue("modelo-teste"));
    expect(screen.getByRole("switch", { name: "Capturar todas as avaliações" })).toBeChecked();
    fireEvent.change(screen.getByLabelText("Instruções para resumir avaliações"), { target: { value: "Resuma as dores" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]).toMatchObject({ captureAllReviews: true, reviews_ai: { enabled: true, model: "modelo-teste", prompt: "Resuma as dores" } });
  });
});
