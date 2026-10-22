import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/layout/header", () => ({ Header: () => <header>Salomão AI</header> }));
vi.mock("@/components/ai-module-shared", () => ({ ModelOptions: () => <option value="modelo-teste">Modelo de teste</option> }));

import OrganizadorPage from "./page";

const fetchMock = vi.fn<typeof fetch>();
let admin = true;
const organizer = {
  ok: true, enabled: true, globalEnabled: true, prompt: "", defaultPrompt: "Regras padrão R1-R17",
  effectivePrompt: "Regras completas", executionHour: 20, lastRun: "2026-10-21T23:00:00Z",
  model: "modelo-teste", provider: "Gemini", agents: [{ id: 7, name: "Agente de teste", role: "Atendimento" }],
};
const columns = [
  { id: "1", status_key: "novo", label: "Novo", color: "#3b82f6", order_index: 0, is_system: true, is_terminal: false },
  { id: "2", status_key: "concluido", label: "Concluído", color: "#10b981", order_index: 1, is_system: false, is_terminal: true },
];

beforeEach(() => {
  admin = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method && init.method !== "GET") {
      if (url === "/api/organizer/suggest-kanban") return Response.json({ ok: true, suggestion: {
        business_type: "Serviços", columns: [{ status_key: "proposta", label: "Proposta", color: "#3b82f6" }], organizer_prompt: "Sugestão para revisão",
      } });
      return Response.json({ ok: true, updatedCount: 1 });
    }
    if (url === "/api/organizer") return Response.json({ ...organizer, isAdmin: admin });
    if (url === "/api/kanban-columns") return Response.json({ ok: true, columns });
    if (String(url).startsWith("/api/organizer/history")) return Response.json({ ok: true, runs: [], history: [{
      id: 9, remote_jid: "5511000000000", nome_negocio: "Lead de teste", status_antigo: "novo", status_novo: "concluido",
      razao: "Atendimento concluído", resumo: "Resumo de teste", batch_id: "lote-teste", created_at: "2026-10-21T23:00:00Z",
    }] });
    if (url === "/api/organizer/effective-prompt") return Response.json({ ok: true, fullPrompt: "Prompt completo", customPrompt: null, defaultBasePrompt: "Regras padrão R1-R17", kanbanAppendix: "Colunas reais", dateContext: "Data de hoje" });
    if (url === "/api/auth/session") return Response.json({ defaultAiModel: "modelo-teste" });
    if (url === "/api/ai-models") return Response.json({ success: true, models: [{ id: "modelo-teste", name: "Modelo de teste" }] });
    throw new Error(`Requisição inesperada: ${url}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("button", { name: "Rodar agora", exact: true })).toBeEnabled());
}

describe("Organizador IA: contratos da interface", () => {
  it("mantém rascunhos entre seções e salva o mesmo payload da conta", async () => {
    render(<OrganizadorPage />);
    await ready();
    const prompt = screen.getByRole("textbox", { name: "Instruções personalizadas" });
    fireEvent.change(prompt, { target: { value: "Minha regra" } });
    fireEvent.change(screen.getByLabelText("Horário da execução"), { target: { value: "21" } });
    fireEvent.click(screen.getByRole("button", { name: "Kanban", exact: true }));
    expect(screen.getByLabelText("Nome da coluna Novo")).toHaveValue("Novo");
    fireEvent.click(screen.getByRole("button", { name: "Configuração", exact: true }));
    expect(screen.getByRole("textbox", { name: "Instruções personalizadas" })).toHaveValue("Minha regra");
    fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/organizer", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ enabled: true, prompt: "Minha regra", executionHour: 21 }),
    })));
  });

  it("preserva a confirmação da execução manual e a atualização do histórico", async () => {
    render(<OrganizadorPage />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Rodar agora", exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/organizer/run-now", { method: "POST", credentials: "include" }));
    expect(confirm).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Execução concluída");
  });

  it("mantém controles globais exclusivos do admin e o modelo de sugestão bloqueado para clientes", async () => {
    admin = false;
    render(<OrganizadorPage />);
    await ready();
    expect(screen.queryByRole("switch", { name: "Organizador ativo em todo o sistema" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sugestões IA", exact: true }));
    expect(screen.getByLabelText("Modelo para a sugestão de Kanban")).toBeDisabled();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("preserva CRUD, ordenação e proteção das colunas de sistema", async () => {
    render(<OrganizadorPage />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Kanban", exact: true }));
    expect(screen.getByRole("button", { name: "Apagar coluna Novo" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nome da nova coluna"), { target: { value: "Em negociação" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar", exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/kanban-columns", expect.objectContaining({
      method: "POST", body: JSON.stringify({ status_key: "em_negociacao", label: "Em negociação", color: "#6b7280", is_terminal: false }),
    })));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Mover coluna Concluído para cima" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/kanban-columns", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ columns: [{ id: "2", order_index: 0 }, { id: "1", order_index: 1 }] }),
    })));
  });

  it("mantém filtro, expansão e exclusão de uma movimentação", async () => {
    render(<OrganizadorPage />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Histórico", exact: true }));
    fireEvent.change(screen.getByLabelText("Buscar movimentações"), { target: { value: "inexistente" } });
    expect(screen.queryByText("Lead de teste")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Buscar movimentações"), { target: { value: "Lead de teste" } });
    fireEvent.click(screen.getByRole("button", { name: /Lead de teste/ }));
    expect(screen.getByText("Resumo de teste")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apagar", exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/organizer/history?id=9", { method: "DELETE" }));
  });

  it("só gera sugestões por ação explícita, permite revisar e não aplica automaticamente", async () => {
    render(<OrganizadorPage />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Sugestões IA", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Gerar sugestão", exact: true }));
    expect(await screen.findByText("Serviços")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt sugerido" })).toHaveValue("Sugestão para revisão");
    expect(fetchMock).toHaveBeenCalledWith("/api/organizer/suggest-kanban", expect.objectContaining({ method: "POST", body: JSON.stringify({ agentId: 7, model: "modelo-teste" }) }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH" || init?.method === "DELETE")).toHaveLength(0);
  });

  it("preserva a inspeção do prompt efetivo e o editor do padrão", async () => {
    render(<OrganizadorPage />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Prompt completo", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Ver / editar" }));
    expect(screen.getByText("Colunas reais")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Editar padrão pra essa conta" }));
    expect(screen.getByRole("textbox", { name: "Editar prompt padrão para esta conta" })).toHaveValue("Regras padrão R1-R17");
  });
});
