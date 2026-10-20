import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AgentePage from "@/app/agente/page";

vi.mock("@/components/layout/header", () => ({ Header: () => <header>Agente IA</header> }));
vi.mock("@/lib/use-session", () => ({ useClientSession: () => ({ clientId: "cliente-teste" }) }));
vi.mock("next/dynamic", async () => {
  const { lazy, Suspense } = await import("react");
  return {
    default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
      const Component = lazy(async () => ({ default: await loader() }));
      return function DynamicTab(props: Record<string, unknown>) {
        return <Suspense fallback={<p>Carregando aba</p>}><Component {...props} /></Suspense>;
      };
    },
  };
});
const { from, writes, channel } = vi.hoisted(() => ({
  from: vi.fn(),
  writes: [] as { table: string; action: string; payload: unknown; filters: [string, unknown][] }[],
  channel: { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from, channel: () => channel, removeChannel: vi.fn() } }));

const days = ["Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado", "Domingo"];
const settings = {
  id: 7001, name: "Clara", role: "Atender clientes", personality: "Atenciosa", tone: "Profissional",
  main_prompt: "Responda com clareza", is_active: true, options: {},
  schedules: days.map(day => ({ day, active: day !== "Domingo", start: "08:00", end: "18:00" })),
};

beforeEach(() => {
  localStorage.clear();
  writes.length = 0;
  channel.on.mockImplementation(() => channel);
  channel.subscribe.mockImplementation(() => channel);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const data = url === "/api/auth/session" ? { authenticated: true, clientId: "cliente-teste", isAdmin: false }
      : url === "/api/whatsapp" ? { instances: [{ instanceName: "Atendimento" }] }
      : url === "/api/openrouter-audio-models" ? { success: true, models: [] }
      : { ok: true, success: true, models: [], columns: [] };
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  from.mockImplementation((table: string) => {
    let single = false;
    const filters: [string, unknown][] = [];
    const record = (action: string, payload?: unknown) => { writes.push({ table, action, payload, filters }); return query; };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      neq: () => query,
      order: () => query,
      limit: () => query,
      single: () => { single = true; return query; },
      maybeSingle: () => { single = true; return query; },
      update: (payload: unknown) => record("update", payload),
      insert: (payload: unknown) => record("insert", payload),
      delete: () => record("delete"),
      upsert: (payload: unknown) => record("upsert", payload),
      then: (resolve: (result: unknown) => void) => {
        const rows = table === "agent_settings" ? [settings, { id: 7002, name: "Outro agente" }]
          : table === "channel_connections" ? [{ instance_name: "Atendimento", agent_id: 7001 }]
          : table === "agent_knowledge" ? [{ id: "kb-1", title: "Serviços", content: "Informações dos serviços" }]
          : table === "agent_stages" ? [{ id: "stage-1", title: "Qualificação", goal_prompt: "Entenda a necessidade", order_index: 0 }]
          : [];
        resolve({ data: single ? rows[0] || {} : rows, error: null });
      },
    };
    return query;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openPage(): Promise<void> {
  render(<AgentePage />);
  // A importação inicial das abas disputa recursos com a suíte completa.
  await screen.findByDisplayValue("Clara", {}, { timeout: 4000 });
}

describe("Agente IA — regressão do refinamento visual", () => {
  it("mantém as seis seções, orientação, navegação e dados editados entre abas", async () => {
    await openPage();
    expect(screen.getByRole("combobox", { name: "Agente selecionado" })).toBeDefined();
    expect(screen.getByRole("complementary", { name: "Guia de configuração" })).toBeDefined();
    for (const title of ["Quem é sua IA?", "Conectar no WhatsApp", "Como a IA conversa", "Agenda e Reuniões", "Base de Conhecimento", "Instruções da IA"]) {
      expect(screen.getByRole("region", { name: title })).toBeDefined();
    }
    fireEvent.change(screen.getByLabelText("Nome do Agente"), { target: { value: "Clara atualizada" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajustes", exact: true }));
    await screen.findByRole("region", { name: "Ajustes de atendimento" });
    fireEvent.click(screen.getByRole("button", { name: "Informações", exact: true }));
    expect(await screen.findByDisplayValue("Clara atualizada")).toBeDefined();
    expect(writes).toHaveLength(0);
  });

  it("preserva presets, controles avançados, editor de prompt e salvar tudo com escopo", async () => {
    await openPage();
    fireEvent.click(screen.getByRole("button", { name: /Atendimento \/ Suporte/ }));
    expect((screen.getByLabelText("Função Principal") as HTMLTextAreaElement).value).toContain("atendente de suporte");
    fireEvent.click(screen.getByRole("button", { name: /Abrir ajustes de conversa/ }));
    expect(screen.getByRole("switch", { name: "Humanizar Respostas (Picotar)" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Abrir editor de instruções/ }));
    expect(screen.getByDisplayValue("Responda com clareza")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Salvar Tudo" }));
    await waitFor(() => expect(writes.filter(w => w.action === "update")).toHaveLength(3));
    for (const write of writes) {
      expect(write.table).toBe("agent_settings");
      expect(write.filters).toContainEqual(["id", 7001]);
      expect(write.filters).toContainEqual(["client_id", "cliente-teste"]);
    }
    expect(writes[2].payload).toEqual({ main_prompt: "Responda com clareza" });
  });

  it("mantém sete horários, modo 24h, grupos e salvamento dos ajustes", async () => {
    await openPage();
    fireEvent.click(screen.getByRole("button", { name: "Ajustes", exact: true }));
    const adjustments = await screen.findByRole("region", { name: "Ajustes de atendimento" });
    expect(within(adjustments).getAllByLabelText(/Início do atendimento de/)).toHaveLength(7);
    expect((screen.getByLabelText("Início do atendimento de Domingo") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Mensagem de ausência"), { target: { value: "Retornamos às 8h" } });
    fireEvent.click(screen.getByRole("switch", { name: "Modo 24h" }));
    expect(screen.queryByLabelText("Início do atendimento de Segunda-feira")).toBeNull();
    expect(screen.getByRole("switch", { name: /Atender grupos/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].payload).toMatchObject({ is_24h: true, away_message: "Retornamos às 8h", disable_groups: false });
  });

  it("mantém testes, etapas e logs acessíveis e não executa exclusão cancelada", async () => {
    await openPage();
    fireEvent.click(screen.getByRole("button", { name: "Excluir agente selecionado" }));
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Testes", exact: true }));
    await screen.findByRole("log", { name: "Conversa de teste" });
    expect(screen.getByRole("textbox", { name: "Mensagem para testar o agente" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Enviar mensagem de teste" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Limpar conversa de teste" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Avançado", exact: true }));
    expect(localStorage.getItem("sdr_agent_advanced_cliente-teste")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Etapas", exact: true }));
    await screen.findByRole("heading", { name: "1. Qualificação" });
    fireEvent.click(screen.getByRole("button", { name: "Logs", exact: true }));
    await screen.findByText("Nenhum log recebido nesta sessão.");
    fireEvent.click(screen.getByRole("button", { name: "Ocultar avançado" }));
    expect(await screen.findByDisplayValue("Clara")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Etapas", exact: true })).toBeNull();
    expect(writes).toHaveLength(0);
  });
});
