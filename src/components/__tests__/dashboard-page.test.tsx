import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import DashboardPage from "@/app/page";

vi.mock("@/components/layout/header", () => ({ Header: () => <header>Dashboard</header> }));
vi.mock("@/components/dashboard-reminders-widget", () => ({ DashboardRemindersWidget: () => <section aria-label="Tarefas e lembretes" /> }));
vi.mock("@/components/dashboard-calendar-widget", () => ({ DashboardCalendarWidget: () => <section aria-label="Próximos agendamentos" /> }));
const { from, summaryCalls } = vi.hoisted(() => ({ from: vi.fn(), summaryCalls: [] as string[] }));
vi.mock("@/lib/supabase", () => ({ supabase: { from } }));
let features: Record<string, boolean>;
let empty: boolean;

beforeEach(() => {
  features = { captador: true };
  empty = false;
  summaryCalls.length = 0;
  from.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/account/usage")) {
      return new Response(
        JSON.stringify({
          ok: true,
          isAdmin: false,
          plan: "starter",
          limits: {
            plan: "starter",
            max_instances: 1,
            max_agents: 2,
            max_kb_docs: 15,
            max_kb_chars: 15000,
            max_prompt_chars: 12000,
            max_output_tokens: 1024,
            max_upload_mb: 15,
            monthly_token_limit: 500000,
            monthly_usd_limit: 5,
          },
          usage: { tokens: 100000, usd: 1, tokenPercent: 20, usdPercent: 20 },
          resources: { agents: 1, instances: 1, kbDocs: 2 },
          status: "ok",
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("/api/dashboard/summary")) {
      summaryCalls.push(url);
      return new Response(
        JSON.stringify({
          success: true,
          metrics: empty
            ? { totalLeads: 0, leadsHoje: 0, conversasHoje: 0, agendamentosHoje: 0, instanciasOnline: 0, disparosAtivos: 0, followUpCampanhas: 0, iaInteracoesHoje: 0 }
            : { totalLeads: 4, leadsHoje: 4, conversasHoje: 2, agendamentosHoje: 4, instanciasOnline: 4, disparosAtivos: 4, followUpCampanhas: 4, iaInteracoesHoje: 4 },
          recentLeads: empty
            ? []
            : [{ id: 7, nome_negocio: "Clínica Horizonte", ramo_negocio: "Saúde", created_at: "2026-10-19T10:00:00Z" }],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ authenticated: true, clientId: "client-a", name: "Marina Teste", features }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Dashboard — regressão do refinamento visual", () => {
  it("preserva métricas, links, widgets e usa BFF seguro sem queries diretas no browser", async () => {
    const { container } = render(<DashboardPage />);
    await screen.findByRole("link", { name: /Clínica Horizonte/ });
    const summary = screen.getByRole("region", { name: "Resumo da operação" });
    expect(within(summary).getByRole("link", { name: /Conversas 2 movimentadas hoje/ }).getAttribute("href")).toBe("/chat");
    expect(screen.getByRole("link", { name: "Captar leads" }).getAttribute("href")).toBe("/captador");
    expect(screen.getByRole("link", { name: "Novo lead" }).getAttribute("href")).toBe("/leads");
    expect(screen.getByRole("link", { name: /Clínica Horizonte/ }).getAttribute("href")).toBe("/leads?openLeadId=7");
    expect(screen.getByRole("region", { name: "Tarefas e lembretes" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Próximos agendamentos" })).toBeDefined();
    expect(summaryCalls).toHaveLength(1);
    expect(from).not.toHaveBeenCalled();
    expect(container.querySelector("a button, button a")).toBeNull();
  });

  it("respeita módulos desabilitados sem remover lembretes", async () => {
    features = { captador: false, leads: false, chat: false, calendario: false, whatsapp: false, followup: false, disparo: false };
    render(<DashboardPage />);
    await screen.findByText(/, Marina\. Acompanhe/);
    expect(screen.queryByRole("link", { name: "Captar leads" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Novo lead" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Resumo da operação" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Próximos agendamentos" })).toBeNull();
    expect(screen.getByRole("region", { name: "Tarefas e lembretes" })).toBeDefined();
    expect(await screen.findByText("Nenhuma ação urgente")).toBeDefined();
  });

  it("mantém orientação inicial e lista vazia sem métricas fictícias", async () => {
    empty = true;
    render(<DashboardPage />);
    expect(await screen.findByText("Nenhum lead cadastrado")).toBeDefined();
    expect(screen.getByRole("link", { name: "Conectar WhatsApp" }).getAttribute("href")).toBe("/whatsapp");
    expect(screen.getByText("Comece conectando seu canal de atendimento")).toBeDefined();
    expect(screen.getByRole("region", { name: "Resumo da operação" }).textContent).toContain("Conversas0");
  });

  it("oculta Captar leads para cliente SaaS sem feature restrita e exibe consumo do plano", async () => {
    features = {};
    render(<DashboardPage />);
    await screen.findByText("Consumo do Plano");
    expect(screen.queryByRole("link", { name: "Captar leads" })).toBeNull();
    expect(screen.getByText(/100\.000 \/ 500\.000/)).toBeDefined();
  });
});
