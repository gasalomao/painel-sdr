import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BackupAdminPage from "@/app/admin/backup/page";

vi.mock("@/lib/use-session", () => ({ useClientSession: () => ({ session: { isAdmin: true }, loading: false }) }));
vi.mock("@/components/backup-diagnostics-panel", () => ({ BackupDiagnosticsPanel: () => <div>Diagnósticos locais ao botão</div> }));
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes("/config") ? {
    success: true, config: { enabled: false, connected: false, interval_hours: 24, retention_days: 7 },
    latestRun: { id: "run-failed", status: "failed", stage: "failed", error_message: "Senha do PostgreSQL remoto rejeitada." },
  } : url.includes("/progress") ? {
    success: true, run: { id: "run-failed", status: "failed", stage: "failed", error_message: "Senha do PostgreSQL remoto rejeitada." },
    events: [{ id: 1, message: "Falha de conexão registrada no servidor.", level: "error", created_at: "2026-10-19T10:00:00Z" }],
  } : { success: true, backups: [] }), { headers: { "Content-Type": "application/json" } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Página administrativa de backup", () => {
  it("carrega a última execução com falha e seus eventos depois de reabrir a página", async () => {
    render(<BackupAdminPage />);
    expect(await screen.findByText(/Falha de conexão registrada no servidor\./)).toBeDefined();
    const area = screen.getByRole("region", { name: "Execução e progresso real" });
    expect(within(area).getByRole("alert").textContent).toContain("Senha do PostgreSQL remoto rejeitada.");
    expect(screen.getByText("Diagnósticos locais ao botão")).toBeDefined();
  });

  it("preserva a falha da execução quando o progresso está indisponível e não repete consulta terminal", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string) => url.includes("/progress")
      ? Promise.resolve(new Response(JSON.stringify({ success: false, error: "Progresso indisponível." }), { status: 503 }))
      : normalFetch(url));
    vi.useFakeTimers();
    await act(async () => { render(<BackupAdminPage />); });
    expect(screen.getAllByText("Progresso indisponível.").length).toBeGreaterThan(0);
    const area = screen.getByRole("region", { name: "Execução e progresso real" });
    expect(within(area).getByText("Senha do PostgreSQL remoto rejeitada.")).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/progress"))).toHaveLength(1);
  });

  it("mantém a falha persistida depois de atualizar o histórico", async () => {
    render(<BackupAdminPage />);
    await screen.findByText(/Falha de conexão registrada no servidor\./);
    fireEvent.click(screen.getByRole("button", { name: "Atualizar histórico" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar histórico" })).toHaveProperty("disabled", false));
    const area = screen.getByRole("region", { name: "Execução e progresso real" });
    expect(within(area).getByRole("alert").textContent).toContain("Senha do PostgreSQL remoto rejeitada.");
  });

  it("recupera todos os eventos de uma execução concluída com mais de uma página", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/progress")) return normalFetch(url);
      const after = Number(new URL(url, "http://localhost").searchParams.get("after"));
      const events = after === 0
        ? Array.from({ length: 200 }, (_, index) => ({ id: index + 1, message: `Evento ${index + 1}`, level: "info", created_at: "2026-10-19T10:00:00Z" }))
        : [{ id: 201, message: "Evento final da falha.", level: "error", created_at: "2026-10-19T10:00:01Z" }];
      return Promise.resolve(new Response(JSON.stringify({ success: true, run: { id: "run-failed", status: "failed", stage: "failed", error_message: "Falha persistida." }, events })));
    });
    render(<BackupAdminPage />);
    expect(await screen.findByText(/Evento final da falha\./)).toBeDefined();
    expect(within(screen.getByRole("log")).getAllByText(/Evento/)).toHaveLength(201);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/progress"))).toHaveLength(2);
  });

  it("continua acompanhando uma nova execução sem voltar à execução concluída", async () => {
    let finishOldReload!: (response: Response) => void;
    let configReads = 0;
    let currentRun = { id: "run-a", status: "running", stage: "export", error_message: null };
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/config")) {
        configReads++;
        if (configReads === 2) return new Promise<Response>(resolve => { finishOldReload = resolve; });
        return json({ success: true, config: { enabled: false, connected: true, interval_hours: 24, retention_days: 7 }, activeRun: currentRun, latestRun: currentRun });
      }
      if (url.includes("/progress")) {
        if (url.includes("run-a")) currentRun = { ...currentRun, status: "success", stage: "complete" };
        return json({ success: true, run: currentRun, events: [{ id: 1, message: currentRun.id === "run-b" ? "Nova execução acompanhada." : "Execução anterior concluída.", level: "info", created_at: "2026-10-19T10:00:00Z" }] });
      }
      return json({ success: true, backups: [] });
    });
    render(<BackupAdminPage />);
    expect(await screen.findByText(/Execução anterior concluída\./)).toBeDefined();
    await act(async () => {
      currentRun = { ...currentRun, id: "run-b", status: "running", stage: "export" };
      finishOldReload(json({ success: true, config: { enabled: false }, activeRun: currentRun, latestRun: currentRun }));
    });
    expect(await screen.findByText(/Nova execução acompanhada\./)).toBeDefined();
  });
});
