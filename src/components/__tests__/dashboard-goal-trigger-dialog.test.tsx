import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { DashboardGoalTriggerDialog } from "../dashboard-goal-trigger-dialog";

vi.mock("@/hooks/use-ai-models", () => ({
  useAiModels: () => ({
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini" },
      { id: "openrouter:google/gemini-2.5-flash", name: "Gemini OpenRouter", provider: "openrouter" },
    ],
    loading: false,
    error: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("DashboardGoalTriggerDialog", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    cleanup();
  });

  it("renderiza o botão discreto 'Gatilho IA' no estado fechado", () => {
    render(<DashboardGoalTriggerDialog />);
    expect(screen.getByRole("button", { name: /gatilho ia/i })).toBeInTheDocument();
  });

  it("abre o diálogo e carrega as configurações existentes ao clicar", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/tasks/goal-trigger") {
        return new Response(
          JSON.stringify({
            ok: true,
            config: {
              enabled: true,
              deadline_value: 3,
              deadline_unit: "business_days",
              model: "gemini-2.5-flash",
              prompt: "Prompt personalizado de teste",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    render(<DashboardGoalTriggerDialog />);
    const button = screen.getByRole("button", { name: /gatilho ia/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Gatilho de Tarefas por IA")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByRole("spinbutton", { name: /quantidade/i })).toHaveValue(3);
      expect(screen.getByDisplayValue("Prompt personalizado de teste")).toBeInTheDocument();
    });
  });

  it("salva as alterações via POST ao submeter o formulário", async () => {
    let capturedBody: any = null;

    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/tasks/goal-trigger") {
        if (init?.method === "POST") {
          capturedBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({ ok: true, config: capturedBody }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            config: {
              enabled: false,
              deadline_value: 2,
              deadline_unit: "business_days",
              model: "",
              prompt: "Prompt default",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    render(<DashboardGoalTriggerDialog />);
    fireEvent.click(screen.getByRole("button", { name: /gatilho ia/i }));

    await waitFor(() => {
      expect(screen.getByText("Gatilho de Tarefas por IA")).toBeInTheDocument();
    });

    // Ativa o switch
    const switchEl = screen.getByRole("switch", { name: /ativar gatilho de tarefa/i });
    fireEvent.click(switchEl);

    // Altera valor de prazo
    const inputNumber = screen.getByRole("spinbutton", { name: /quantidade/i });
    fireEvent.change(inputNumber, { target: { value: "4" } });

    // Salva
    const saveBtn = screen.getByRole("button", { name: /salvar configuração/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
      expect(capturedBody.enabled).toBe(true);
      expect(capturedBody.deadline_value).toBe(4);
      expect(capturedBody.deadline_unit).toBe("business_days");
    });
  });
});
