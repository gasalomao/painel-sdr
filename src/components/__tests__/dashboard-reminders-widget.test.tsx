import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DashboardRemindersWidget } from "../dashboard-reminders-widget";
import type { DashboardTask, DashboardTasksResponse } from "@/types/dashboard-tasks";

vi.mock("@/lib/use-session", () => ({
  useClientSession: () => ({ session: { clientId: "client-abc" }, loading: false }),
}));

const task: DashboardTask = {
  id: "11111111-1111-4111-8111-111111111111",
  text: "Entregar projeto X",
  due_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  completed_at: null,
  lead_id: null,
  lead_name: null,
  created_at: "2026-10-18T10:00:00Z",
  updated_at: "2026-10-18T10:00:00Z",
};
const mockFetch = vi.fn();
let tasks: DashboardTask[];
let failWrite: boolean;
let missingSchema: boolean;

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  tasks = [{ ...task }];
  failWrite = false;
  missingSchema = false;
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/leads/reminders")) return response({
      totalOverdue: 1, totalUpcomingToday: 0,
      overdue: [{ id: 101, nome_negocio: "Padaria Estrela", next_follow_up: "2020-10-17T10:00:00Z", lembrete_texto: "Revisar proposta antiga" }],
      upcomingToday: [],
    });
    if (url === "/api/leads/101/crm") return response({ success: true });
    if (url.startsWith("/api/tasks/leads")) return response({ leads: [{ id: 102, nome_negocio: "Clínica Vida" }] });
    if (missingSchema) return response({ code: "TASKS_SETUP_REQUIRED", error: "Execute migrations/017_dashboard_tasks.sql" }, 503);
    if (init?.method === "POST") {
      if (failWrite) return response({ error: "Não foi possível salvar" }, 500);
      const input = JSON.parse(String(init.body));
      tasks = [{ ...task, ...input, id: `new-task-${tasks.length}` }, ...tasks];
      return response({ task: tasks[0] }, 201);
    }
    if (init?.method === "PATCH") {
      if (failWrite) return response({ error: "Não foi possível salvar" }, 500);
      const input = JSON.parse(String(init.body));
      tasks = tasks.map(t => ({ ...t, ...input, completed_at: input.completed === undefined ? t.completed_at : input.completed ? new Date().toISOString() : null }));
      return response({ task: tasks[0] });
    }
    const completed = new URL(url, "http://localhost").searchParams.get("status") === "completed";
    const filtered = tasks.filter(t => Boolean(t.completed_at) === completed);
    const data: DashboardTasksResponse = {
      tasks: filtered, total: filtered.length,
      counts: { pending: tasks.filter(t => !t.completed_at).length, overdue: 0, dueSoon: 1, upcoming: 0, completed: tasks.filter(t => t.completed_at).length },
    };
    return response(data);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("DashboardRemindersWidget — lista de tarefas", () => {
  it("mostra texto, proximidade e lembretes legados com link correto", async () => {
    render(<DashboardRemindersWidget />);
    expect(await screen.findByText("Entregar projeto X")).toBeDefined();
    expect(screen.getByText("EM ATÉ 30 MIN")).toBeDefined();
    expect(screen.getByText("Revisar proposta antiga")).toBeDefined();
    expect(screen.getByRole("link", { name: /Padaria Estrela/i }).getAttribute("href")).toBe("/leads?openLeadId=101");
  });

  it("cria tarefa livre com texto e vencimento e persiste via POST", async () => {
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Preparar contrato" } });
    fireEvent.change(screen.getByLabelText("Data e horário"), { target: { value: "2026-11-03T15:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar tarefa" }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({
      method: "POST", body: JSON.stringify({ text: "Preparar contrato", due_at: new Date("2026-11-03T15:30").toISOString(), lead_id: null }),
    })));
    expect(await screen.findByText("Preparar contrato")).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Nova tarefa" })));
  });

  it("conclui por checkbox e permite reabrir no histórico", async () => {
    render(<DashboardRemindersWidget />);
    const check = await screen.findByRole("checkbox", { name: "Concluir: Entregar projeto X" });
    fireEvent.click(check);
    await waitFor(() => expect(screen.queryByText("Entregar projeto X")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Concluídas/ }));
    const reopen = await screen.findByRole("checkbox", { name: "Reabrir: Entregar projeto X" });
    expect((reopen as HTMLInputElement).checked).toBe(true);
    fireEvent.click(reopen);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`/api/tasks/${task.id}`, expect.objectContaining({ body: JSON.stringify({ completed: false }) })));
  });

  it("não remove tarefa nem afirma sucesso quando falha a conclusão", async () => {
    failWrite = true;
    render(<DashboardRemindersWidget />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Concluir: Entregar projeto X" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Não foi possível salvar");
    expect(screen.getByText("Entregar projeto X")).toBeDefined();
    expect((screen.getByRole("checkbox", { name: "Concluir: Entregar projeto X" }) as HTMLInputElement).checked).toBe(false);
  });

  it("edita texto e prazo de uma tarefa salva", async () => {
    render(<DashboardRemindersWidget />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar: Entregar projeto X" }));
    fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Entregar revisão final" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar tarefa" }));
    expect(await screen.findByText("Entregar revisão final")).toBeDefined();
  });

  it("vincula tarefa ao lead do resultado da busca", async () => {
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Revisar contrato" } });
    fireEvent.change(screen.getByLabelText("Data e horário"), { target: { value: "2026-11-03T15:30" } });
    fireEvent.change(screen.getByLabelText("Buscar lead (opcional)"), { target: { value: "Clínica" } });
    await screen.findByRole("option", { name: "Clínica Vida" });
    fireEvent.change(screen.getByLabelText("Vincular a um lead"), { target: { value: "102" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar tarefa" }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({ body: expect.stringContaining('"lead_id":102') })));
  });

  it("clicar no filtro ativo não apaga os dados nem prende o carregamento", async () => {
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    fireEvent.click(screen.getByRole("button", { name: /Pendentes/ }));
    expect(screen.getByText("Entregar projeto X")).toBeDefined();
    expect(screen.queryByText("Carregando tarefas…")).toBeNull();
  });

  it("aplica a conclusão confirmada mesmo se a releitura falhar", async () => {
    const base = mockFetch.getMockImplementation()!;
    let saved = false;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (saved && url.startsWith("/api/tasks?")) return response({ error: "Falha ao atualizar lista" }, 500);
      const result = await base(url, init);
      if (init?.method === "PATCH") saved = true;
      return result;
    });
    render(<DashboardRemindersWidget />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Concluir: Entregar projeto X" }));
    await screen.findByText("Tarefa concluída.");
    await screen.findByRole("alert");
    expect(screen.queryByRole("checkbox", { name: "Concluir: Entregar projeto X" })).toBeNull();
    expect(screen.getByRole("button", { name: "Concluídas (1)" })).toBeDefined();
  });

  it("impede trocar de formulário e perder um rascunho aberto", async () => {
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Meu rascunho" } });
    expect((screen.getByRole("button", { name: "Editar: Entregar projeto X" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Nova tarefa" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("não consulta periodicamente com a aba oculta e atualiza ao retornar", async () => {
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    const intervalSpy = vi.spyOn(window, "setInterval");
    cleanup();
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    const poll = intervalSpy.mock.calls.find(call => call[1] === 30_000)?.[0] as (() => void) | undefined;
    expect(poll).toBeTypeOf("function");
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    mockFetch.mockClear();
    await act(async () => poll?.());
    expect(mockFetch).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/tasks?"), expect.any(Object)));
    visibility.mockRestore();
    intervalSpy.mockRestore();
  });

  it("ignora leitura antiga que termina depois de concluir uma tarefa", async () => {
    let finishOldRead: (value: Response) => void = () => {};
    const intervalSpy = vi.spyOn(window, "setInterval");
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    const poll = intervalSpy.mock.calls.find(call => call[1] === 30_000)?.[0] as () => void;
    const base = mockFetch.getMockImplementation()!;
    let holdNextRead = true;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (holdNextRead && url.startsWith("/api/tasks?")) {
        holdNextRead = false;
        return new Promise<Response>(resolve => { finishOldRead = resolve; });
      }
      return base(url, init);
    });
    act(() => poll());
    fireEvent.click(screen.getByRole("checkbox", { name: "Concluir: Entregar projeto X" }));
    await waitFor(() => expect(screen.queryByText("Entregar projeto X")).toBeNull());
    await act(async () => finishOldRead(response({ tasks: [task], total: 1, counts: { pending: 1, overdue: 0, dueSoon: 1, upcoming: 0, completed: 0 } })));
    expect(screen.queryByText("Entregar projeto X")).toBeNull();
    intervalSpy.mockRestore();
  });

  it("pagina tarefas sem confundir o total com a quantidade visível", async () => {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/tasks?") && !init?.method) {
        const page = Number(new URL(url, "http://localhost").searchParams.get("page"));
        return response({ tasks: [{ ...task, text: page ? "Última tarefa" : "Primeira tarefa" }], total: 9, counts: { pending: 9, overdue: 0, dueSoon: 9, upcoming: 0, completed: 0 } });
      }
      return base(url, init);
    });
    render(<DashboardRemindersWidget />);
    await screen.findByText("Primeira tarefa");
    expect(screen.getByText(/Página 1 de 2/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    expect(await screen.findByText("Última tarefa")).toBeDefined();
    expect(screen.getByText(/Página 2 de 2/)).toBeDefined();
  });

  it("mantém a seleção do lead ao refazer a busca", async () => {
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    fireEvent.change(screen.getByLabelText("Buscar lead (opcional)"), { target: { value: "Clínica" } });
    await screen.findByRole("option", { name: "Clínica Vida" });
    fireEvent.change(screen.getByLabelText("Vincular a um lead"), { target: { value: "102" } });
    fireEvent.change(screen.getByLabelText("Buscar lead (opcional)"), { target: { value: "" } });
    expect((screen.getByLabelText("Vincular a um lead") as HTMLSelectElement).value).toBe("102");
  });

  it("abre pendentes após criar uma tarefa a partir do histórico", async () => {
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    fireEvent.click(screen.getByRole("button", { name: /Concluídas/ }));
    await screen.findByText("As tarefas que você concluir ficam aqui.");
    fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Tarefa criada do histórico" } });
    fireEvent.change(screen.getByLabelText("Data e horário"), { target: { value: "2026-11-03T15:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar tarefa" }));
    expect(await screen.findByText("Tarefa criada do histórico")).toBeDefined();
    expect(screen.getByRole("button", { name: /Pendentes/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("preserva a tarefa criada pelo histórico se a releitura falhar", async () => {
    const base = mockFetch.getMockImplementation()!;
    let saved = false;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (saved && url.startsWith("/api/tasks?")) return response({ error: "Falha ao atualizar lista" }, 500);
      const result = await base(url, init);
      if (init?.method === "POST") saved = true;
      return result;
    });
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    fireEvent.click(screen.getByRole("button", { name: /Concluídas/ }));
    await screen.findByText("As tarefas que você concluir ficam aqui.");
    fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Persistida mesmo sem releitura" } });
    fireEvent.change(screen.getByLabelText("Data e horário"), { target: { value: "2026-11-03T15:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar tarefa" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Persistida mesmo sem releitura")).toBeDefined();
    expect(screen.getByRole("button", { name: "Pendentes (2)" })).toBeDefined();
  });

  it("não conta PATCH de item deslocado pelo polling como criação", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    const base = mockFetch.getMockImplementation()!;
    let displaced = false;
    let saved = false;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/tasks?")) {
        if (saved) return response({ error: "Falha ao atualizar lista" }, 500);
        return response({ tasks: displaced ? [{ ...task, id: "other", text: "Outro item na página" }] : [task], total: 9, counts: { pending: 9, overdue: 0, dueSoon: 9, upcoming: 0, completed: 0 } });
      }
      const result = await base(url, init);
      if (init?.method === "PATCH") saved = true;
      return result;
    });
    render(<DashboardRemindersWidget />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar: Entregar projeto X" }));
    displaced = true;
    const poll = intervalSpy.mock.calls.find(call => call[1] === 30_000)?.[0] as () => void;
    await act(async () => poll());
    await screen.findByText("Outro item na página");
    fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Tarefa atualizada fora da página" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar tarefa" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Pendentes (9)" })).toBeDefined();
    intervalSpy.mockRestore();
  });

  it.each(["complete", "edit"])("mantém paginação coerente após %s na última página e falha de leitura", async action => {
    const base = mockFetch.getMockImplementation()!;
    let saved = false;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/tasks?")) {
        if (saved) return response({ error: "Falha ao atualizar lista" }, 500);
        const page = Number(new URL(url, "http://localhost").searchParams.get("page"));
        return response({ tasks: [{ ...task, text: page ? "Última tarefa" : "Primeira tarefa" }], total: 9, counts: { pending: 9, overdue: 0, dueSoon: 9, upcoming: 0, completed: 0 } });
      }
      const result = await base(url, init);
      if (init?.method === "PATCH") saved = true;
      return result;
    });
    render(<DashboardRemindersWidget />);
    await screen.findByText("Primeira tarefa");
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    await screen.findByText("Última tarefa");
    if (action === "complete") fireEvent.click(screen.getByRole("checkbox", { name: "Concluir: Última tarefa" }));
    else {
      fireEvent.click(screen.getByRole("button", { name: "Editar: Última tarefa" }));
      fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Última tarefa editada" } });
      fireEvent.click(screen.getByRole("button", { name: "Salvar tarefa" }));
    }
    await screen.findByRole("alert");
    if (action === "complete") {
      expect(screen.getByRole("button", { name: "Pendentes (8)" })).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("status=pending&page=0"), expect.any(Object));
      expect(screen.queryByText("Nenhuma tarefa pendente. Adicione o que precisa fazer.")).toBeNull();
    } else {
      expect(screen.getByText(/Página 2 de 2/)).toBeDefined();
      expect(screen.getByText("Última tarefa editada")).toBeDefined();
    }
  });

  it("preserva o rascunho quando a gravação falha", async () => {
    failWrite = true;
    render(<DashboardRemindersWidget />);
    await screen.findByText("Entregar projeto X");
    fireEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    fireEvent.change(screen.getByLabelText("O que precisa fazer?"), { target: { value: "Não perder este rascunho" } });
    fireEvent.change(screen.getByLabelText("Data e horário"), { target: { value: "2026-11-03T15:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar tarefa" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("O que precisa fazer?") as HTMLTextAreaElement).value).toBe("Não perder este rascunho");
  });

  it("mostra falha de leitura em vez de afirmar que não há tarefas", async () => {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => url.startsWith("/api/tasks?")
      ? response({ error: "Banco temporariamente indisponível" }, 500)
      : base(url, init));
    render(<DashboardRemindersWidget />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Banco temporariamente indisponível"));
    expect(screen.queryByText("Nenhuma tarefa pendente. Adicione o que precisa fazer.")).toBeNull();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeDefined();
  });

  it("mantém lembretes antigos e orienta SQL quando tabela não existe", async () => {
    missingSchema = true;
    render(<DashboardRemindersWidget />);
    expect(await screen.findByText(/migrations\/017_dashboard_tasks.sql/)).toBeDefined();
    expect(screen.getByText("Revisar proposta antiga")).toBeDefined();
    expect((screen.getByRole("button", { name: "Nova tarefa" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Concluir: Revisar proposta antiga" }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/leads/101/crm", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ next_follow_up: null }) })));
  });
});
