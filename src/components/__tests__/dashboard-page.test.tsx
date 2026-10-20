import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import DashboardPage from "@/app/page";

vi.mock("@/components/layout/header", () => ({ Header: () => <header>Dashboard</header> }));
vi.mock("@/components/dashboard-reminders-widget", () => ({ DashboardRemindersWidget: () => <section aria-label="Tarefas e lembretes" /> }));
vi.mock("@/components/dashboard-calendar-widget", () => ({ DashboardCalendarWidget: () => <section aria-label="Próximos agendamentos" /> }));
const { from, scopedQueries } = vi.hoisted(() => ({ from: vi.fn(), scopedQueries: [] as string[] }));
vi.mock("@/lib/supabase", () => ({ supabase: { from } }));
let features: Record<string, boolean>;
let empty: boolean;

beforeEach(() => {
  features = {};
  empty = false;
  scopedQueries.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ authenticated: true, clientId: "client-a", name: "Marina Teste", features }), { status: 200 })));
  from.mockImplementation((table: string) => {
    let head = false;
    const query = {
      select: (_fields: string, options?: { head?: boolean }) => { head = !!options?.head; return query; },
      gte: () => query,
      lt: () => query,
      in: () => query,
      order: () => query,
      limit: () => query,
      eq: (field: string, value: string) => { if (field === "client_id" && value === "client-a") scopedQueries.push(table); return query; },
      then: (resolve: (value: unknown) => void) => resolve({
        count: empty ? 0 : 4,
        data: empty || head ? [] : table === "leads_extraidos" ? [{ id: 7, nome_negocio: "Clínica Horizonte", ramo_negocio: "Saúde", created_at: "2026-10-19T10:00:00Z" }] : table === "chats_dashboard" ? [{ remote_jid: "contact-1" }, { remote_jid: "contact-1" }, { remote_jid: "contact-2" }] : [],
        error: null,
      }),
    };
    return query;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Dashboard — regressão do refinamento visual", () => {
  it("preserva métricas, links, widgets e escopo do cliente", async () => {
    const { container } = render(<DashboardPage />);
    await screen.findByRole("link", { name: /Clínica Horizonte/ });
    const summary = screen.getByRole("region", { name: "Resumo da operação" });
    expect(within(summary).getByRole("link", { name: /Conversas 2 movimentadas hoje/ }).getAttribute("href")).toBe("/chat");
    expect(screen.getByRole("link", { name: "Captar leads" }).getAttribute("href")).toBe("/captador");
    expect(screen.getByRole("link", { name: "Novo lead" }).getAttribute("href")).toBe("/leads");
    expect(screen.getByRole("link", { name: /Clínica Horizonte/ }).getAttribute("href")).toBe("/leads?openLeadId=7");
    expect(screen.getByRole("region", { name: "Tarefas e lembretes" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Próximos agendamentos" })).toBeDefined();
    expect(scopedQueries).toHaveLength(9);
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
});
