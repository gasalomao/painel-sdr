import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatBRL } from "@/lib/token-format";

vi.mock("@/components/layout/header", () => ({ Header: () => <h1>Salomão AI</h1> }));
vi.mock("next/dynamic", () => ({ default: () => () => <span>Gráfico de consumo</span> }));

import TokensPage from "./page";

const fetchMock = vi.fn<typeof fetch>();
const fixture = {
  success: true,
  totals: { prompt: 8000, completion: 2000, total: 10000, cost: 2, costBrl: 10.2, calls: 5, brlRate: 5.1 },
  bySource: [{ source: "agent", total: 10000, cost: 2, calls: 5, prompt: 8000, completion: 2000 }],
  bySourceLabel: [{ source: "agent", label: "Agente de teste", total: 10000, cost: 2, calls: 5 }],
  byModel: [{ model: "modelo-teste", total: 10000, cost: 2, calls: 5, prompt: 8000, completion: 2000, priceKnown: false, input_per_1m: null, output_per_1m: null }],
  byDayStacked: [],
  pricingState: { source: "db", fetchedAt: 1, modelCount: 100 },
  isAdminView: true,
  byClient: [{ client_id: "client-test", name: "Cliente de teste", total: 10000, cost: 2, costBrl: 10.2, calls: 5, prompt: 8000, completion: 2000 }],
  recent: [{ id: 1, source: "agent", source_label: "Atendimento de teste", model: "modelo-teste", prompt_tokens: 8000, completion_tokens: 2000, total_tokens: 10000, cost_usd: 2, cost_brl: 10.2, priceKnown: false, created_at: "2026-10-21T12:00:00Z" }],
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url) => {
    if (url === "/api/tokens/pricing") return Response.json({ success: true, ...fixture.pricingState });
    if (url === "/api/tokens/recalc") return Response.json({ success: true, updated: 4, scanned: 5, unknownModels: ["modelo-teste"] });
    if (url === "/api/tokens/diagnose") return Response.json({ ok: false, checks: [{ ok: false, step: "Preço", message: "Atualize os preços." }] });
    return Response.json(fixture);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar dados" })).not.toBeDisabled());
}

describe("Tokens IA: contratos e estados da interface", () => {
  it("preserva métricas, tabelas, preços desconhecidos e o detalhamento exclusivo do administrador", async () => {
    render(<TokensPage />);
    await ready();
    expect(screen.getByRole("heading", { name: "Tokens IA", exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(formatBRL(10.2).replace(/\s/g, " ")).length).toBeGreaterThan(0);
    expect(screen.getByText("Cliente de teste")).toBeInTheDocument();
    expect(screen.getByText("Atendimento de teste")).toBeInTheDocument();
    expect(screen.getByText(/Custos sem preço são registrados como zero/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "7 dias" })).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("mantém limites de Hoje, 7 dias, 30 dias e a consulta sem limites de Todo o período", async () => {
    render(<TokensPage />);
    await ready();
    const initialUrl = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(initialUrl.searchParams.has("from")).toBe(true);
    expect(initialUrl.searchParams.has("to")).toBe(true);
    for (const [label, days] of [["Hoje", 0], ["30 dias", 30]] as const) {
      fireEvent.click(screen.getByRole("button", { name: label, exact: true }));
      await ready();
      const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), "http://localhost");
      const start = new Date(url.searchParams.get("from")!);
      const end = new Date(url.searchParams.get("to")!);
      if (days) expect((end.getTime() - start.getTime()) / 86400000).toBeCloseTo(days, 1);
      else expect(start.getHours()).toBe(0);
    }
    fireEvent.click(screen.getByRole("button", { name: "Todo o período", exact: true }));
    await ready();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/tokens?");
    expect(screen.getByRole("button", { name: "Todo o período" })).toHaveAttribute("aria-pressed", "true");
  });

  it("mantém preços, recálculo e diagnóstico nos endpoints originais e apresenta seus resultados", async () => {
    render(<TokensPage />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Atualizar preços", exact: true }));
    await ready();
    expect(fetchMock).toHaveBeenCalledWith("/api/tokens/pricing", { method: "POST", cache: "no-store" });
    fireEvent.click(screen.getByRole("button", { name: "Recalcular histórico", exact: true }));
    await ready();
    expect(fetchMock).toHaveBeenCalledWith("/api/tokens/recalc", { method: "POST" });
    expect(screen.getByText(/4 de 5 chamadas/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Diagnosticar", exact: true }));
    await ready();
    expect(fetchMock).toHaveBeenCalledWith("/api/tokens/diagnose", { cache: "no-store" });
    expect(screen.getByText("Atualize os preços.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar diagnóstico" }));
    expect(screen.queryByText("Atualize os preços.")).not.toBeInTheDocument();
  });

  it("oculta o detalhamento por cliente quando isAdminView é falso mesmo se byClient estiver presente", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...fixture, isAdminView: false }));
    render(<TokensPage />);
    await ready();
    expect(screen.queryByRole("heading", { name: "Custos por cliente" })).not.toBeInTheDocument();
    expect(screen.queryByText("Cliente de teste")).not.toBeInTheDocument();
  });

  it("distingue erro inicial de consumo zero e libera nova tentativa sem apagar dados após falha", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    render(<TokensPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar o consumo");
    expect(screen.queryByText("R$ 0,00")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Atualizar dados" }));
    await ready();
    expect(screen.getByText("Cliente de teste")).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(Response.json({ success: true }, { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar dados" }));
    await ready();
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar o consumo");
    expect(screen.getByText("Cliente de teste")).toBeInTheDocument();
  });

  it("informa a ausência de registros e não apresenta tabela inexistente como gasto zero", async () => {
    const empty = { ...fixture, bySource: [], bySourceLabel: [], byModel: [], byDayStacked: [], byClient: [], recent: [] };
    fetchMock.mockResolvedValueOnce(Response.json(empty));
    render(<TokensPage />);
    expect(await screen.findByText("Nenhuma chamada neste período.")).toBeInTheDocument();
    await ready();
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, notReady: true }));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar dados" }));
    await ready();
    expect(screen.getByText("Registro de tokens indisponível")).toBeInTheDocument();
    expect(screen.getByText("Aguardando dados de consumo")).toBeInTheDocument();
  });

  it("mostra falhas das ações e a restrição de diagnóstico, sem sucesso fictício", async () => {
    render(<TokensPage />);
    await ready();
    fetchMock.mockResolvedValueOnce(Response.json({ success: false }, { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar preços", exact: true }));
    await ready();
    expect(screen.getByRole("alert")).toHaveTextContent("Os valores anteriores foram mantidos");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Recalcular histórico", exact: true }));
    await ready();
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível recalcular o histórico");
    expect(screen.queryByText(/Histórico recalculado:/)).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: "Apenas admin" }, { status: 403 }));
    fireEvent.click(screen.getByRole("button", { name: "Diagnosticar", exact: true }));
    await ready();
    expect(screen.getByText("Diagnóstico disponível apenas para administradores.")).toBeInTheDocument();
  });
});
