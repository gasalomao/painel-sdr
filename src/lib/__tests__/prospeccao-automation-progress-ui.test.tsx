import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/app/automacao/AutomationLogs", () => ({ AutomationLogs: () => null }));
vi.mock("@/components/ai-module-shared", () => ({ ModelOptions: () => null }));

import ProspeccaoSitesPage from "@/app/prospeccao-sites/page";

const fixture = {
  id: "auto-1",
  name: "Padarias",
  status: "paused",
  phase: "scraping",
  instance_name: "whatsapp-A",
  niches: ["padaria"],
  regions: ["Vitória"],
  scraped_count: 13,
  scrape_max_leads: 20,
  last_error: null as string | null,
  campaign_id: null,
  followup_campaign_id: null,
};
const listUrl = "/api/automations?source=prospeccao-sites";
const fetchMock = vi.fn<typeof fetch>();
const actionResponse = vi.fn<typeof fetch>();
let automations: typeof fixture[];

function listCalls() {
  return fetchMock.mock.calls.filter(([input]) => input === listUrl);
}

function actionCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "DELETE");
}

async function openAutomations() {
  render(<ProspeccaoSitesPage />);
  fireEvent.click(screen.getByRole("button", { name: "Automação", exact: true }));
  await screen.findByText(fixture.name, { exact: true });
}

describe("progresso e ações das automações na Prospecção Sites", () => {
  beforeEach(() => {
    automations = [{ ...fixture }];
    actionResponse.mockReset();
    actionResponse.mockImplementation(async (_input, init) => Response.json(
      init?.method === "DELETE" ? { success: true } : { ok: true },
    ));
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST" || init?.method === "DELETE") return actionResponse(input, init);
      if (input === listUrl) return Response.json({ success: true, automations });
      return Response.json({ success: true, ok: true, leads: [], total: 0, campaigns: [], instances: [], models: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class {
      close() {}
    });
    vi.spyOn(window, "alert").mockImplementation(() => {});
    vi.spyOn(window, "confirm").mockReturnValue(true);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {});
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([0, 13, 20])("mostra %i/20 leads mesmo sem capturados", async (count) => {
    automations = [{ ...fixture, scraped_count: count }];
    await openAutomations();

    expect(screen.getByText(`${count}/20 leads`, { exact: true })).toBeInTheDocument();
  });

  it.each([
    ["draft", 0, "Iniciar"],
    ["paused", 13, "Retomar"],
    ["error", 13, "Retomar"],
    ["done", 13, "Retomar"],
    ["done", 0, "Retomar"],
    ["done", 20, "Iniciar"],
  ])("oferece %s com %i capturados como %s", async (status, count, label) => {
    automations = [{ ...fixture, status, scraped_count: count }];
    await openAutomations();

    expect(screen.getByRole("button", { name: label, exact: true })).toBeEnabled();
  });

  it.each(["campaigning", "dispatching"])("traduz a fase %s sem perder compatibilidade", async (phase) => {
    automations = [{ ...fixture, status: "running", phase }];
    await openAutomations();

    expect(screen.getByText("Em execução · Disparando", { exact: true })).toBeInTheDocument();
  });

  it.each([
    ["draft", "Rascunho"],
    ["running", "Em execução"],
    ["paused", "Pausada"],
    ["error", "Erro"],
    ["done", "Concluída"],
  ])("traduz o status %s como %s", async (status, label) => {
    automations = [{ ...fixture, status, phase: "idle" }];
    await openAutomations();

    expect(screen.getByText(`${label} · Aguardando`, { exact: true })).toBeInTheDocument();
  });

  it("reserva a linha da identidade no mobile sem comprimir o nome entre os indicadores", async () => {
    await openAutomations();

    expect(screen.getByText(fixture.name, { exact: true }).parentElement).toHaveClass("basis-full", "sm:basis-0");
  });

  it("retoma pelo endpoint existente sem enviar nem zerar o progresso", async () => {
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: "Retomar", exact: true }));

    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(actionCalls()[0]).toEqual(["/api/automations/auto-1/start", { method: "POST" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retomar", exact: true })).toBeEnabled());
    expect(screen.getByText("13/20 leads", { exact: true })).toBeInTheDocument();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it.each([
    ["paused", "Retomar", "POST", "/start"],
    ["running", "Pausar", "POST", "/pause"],
    ["draft", "Deletar automação Padarias", "DELETE", ""],
  ])("exibe falha da API para %s sem ocultar o progresso", async (status, label, method, suffix) => {
    automations = [{ ...fixture, status }];
    actionResponse.mockImplementation(async () => Response.json({
      ...(method === "DELETE" ? { success: false } : { ok: false }),
      error: "Captura ocupada; tente novamente.",
    }));
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: label, exact: true }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("Erro: Captura ocupada; tente novamente."));
    expect(actionCalls()[0]).toEqual([`/api/automations/auto-1${suffix}`, { method }]);
    expect(screen.getByText("13/20 leads", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: label, exact: true })).toBeEnabled();
  });

  it.each([
    ["paused", "Retomar", { ok: false, success: true, error: "Start recusado." }, "Start recusado."],
    ["running", "Pausar", { ok: true, success: false, error: "Pause recusado." }, "Pause recusado."],
    ["draft", "Deletar automação Padarias", { success: true, ok: false, error: "Exclusão recusada." }, "Exclusão recusada."],
  ])("rejeita flags contraditórias para %s", async (status, label, body, error) => {
    automations = [{ ...fixture, status }];
    actionResponse.mockImplementation(async () => Response.json(body));
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: label, exact: true }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(`Erro: ${error}`));
    expect(screen.getByRole("button", { name: label, exact: true })).toBeEnabled();
  });

  it("rejeita HTTP de erro mesmo quando o JSON declara sucesso", async () => {
    actionResponse.mockImplementation(async () => Response.json({ ok: true, error: "Serviço indisponível." }, { status: 503 }));
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: "Retomar", exact: true }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("Erro: Serviço indisponível."));
    expect(screen.getByRole("button", { name: "Retomar", exact: true })).toBeEnabled();
  });

  it("mostra falha genérica em resposta inválida e permite tentar novamente", async () => {
    actionResponse.mockImplementationOnce(async () => new Response("indisponível", { status: 502 }));
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: "Retomar", exact: true }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("Erro: Não foi possível atualizar a automação."));
    fireEvent.click(screen.getByRole("button", { name: "Retomar", exact: true }));
    await waitFor(() => expect(actionCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retomar", exact: true })).toBeEnabled());
  });

  it("exibe falha de rede e libera os controles", async () => {
    actionResponse.mockRejectedValueOnce(new Error("Sem conexão."));
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: "Retomar", exact: true }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("Erro: Sem conexão."));
    expect(screen.getByRole("button", { name: "Retomar", exact: true })).toBeEnabled();
  });

  it("bloqueia cliques concorrentes na mesma automação sem bloquear outras", async () => {
    automations.push({ ...fixture, id: "auto-2", name: "Clínicas", status: "running" });
    let finishAction!: (response: Response) => void;
    actionResponse.mockReturnValueOnce(new Promise<Response>(resolve => { finishAction = resolve; }));
    await openAutomations();
    const resume = screen.getByRole("button", { name: "Retomar", exact: true });
    act(() => {
      fireEvent.click(resume);
      fireEvent.click(resume);
    });

    expect(actionCalls()).toHaveLength(1);
    expect(resume).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deletar automação Padarias", exact: true })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pausar", exact: true })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Pausar", exact: true }));
    await waitFor(() => expect(actionCalls()).toHaveLength(2));
    expect(actionCalls()[1][0]).toBe("/api/automations/auto-2/pause");
    expect(resume).toBeDisabled();

    await act(async () => finishAction(Response.json({ ok: true })));
    expect(resume).toBeEnabled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("atualiza o cartão após pausar sem perder os 13/20 capturados", async () => {
    automations = [{ ...fixture, status: "running" }];
    actionResponse.mockImplementation(async () => {
      automations = [{ ...fixture, status: "paused" }];
      return Response.json({ ok: true, stopped: { scraper: true, campaign: false, followup: false } });
    });
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: "Pausar", exact: true }));

    expect(await screen.findByRole("button", { name: "Retomar", exact: true })).toBeEnabled();
    expect(screen.getByText("13/20 leads", { exact: true })).toBeInTheDocument();
    expect(actionCalls()[0]).toEqual(["/api/automations/auto-1/pause", { method: "POST" }]);
  });

  it("remove o cartão somente após exclusão confirmada pela API", async () => {
    actionResponse.mockImplementation(async () => {
      automations = [];
      return Response.json({ success: true });
    });
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: "Deletar automação Padarias", exact: true }));

    expect(await screen.findByText("Nenhuma automação criada ainda.")).toBeInTheDocument();
    expect(screen.queryByText(fixture.name, { exact: true })).not.toBeInTheDocument();
    expect(actionCalls()[0]).toEqual(["/api/automations/auto-1", { method: "DELETE" }]);
  });

  it("não deleta quando a confirmação é cancelada", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await openAutomations();
    fireEvent.click(screen.getByRole("button", { name: "Deletar automação Padarias", exact: true }));

    expect(actionCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Retomar", exact: true })).toBeEnabled();
  });

  it("atualiza progresso por polling só na aba Automação e limpa ao sair/desmontar", async () => {
    const view = render(<ProspeccaoSitesPage />);
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(listCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Automação", exact: true }));
    await act(async () => {});
    const openedCalls = listCalls().length;
    automations = [{ ...fixture, scraped_count: 14 }];
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(listCalls()).toHaveLength(openedCalls + 1);
    expect(screen.getByText("14/20 leads", { exact: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Captura", exact: true }));
    const leftCalls = listCalls().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(listCalls()).toHaveLength(leftCalls);

    fireEvent.click(screen.getByRole("button", { name: "Automação", exact: true }));
    await act(async () => {});
    const reopenedCalls = listCalls().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(listCalls()).toHaveLength(reopenedCalls + 1);
    view.unmount();
    const unmountedCalls = listCalls().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(listCalls()).toHaveLength(unmountedCalls);
  });
});
