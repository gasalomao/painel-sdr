import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupDiagnosticsPanel } from "../backup-diagnostics-panel";

const fetchMock = vi.fn();
const report = {
  id: "test-1", status: "failed", created_at: "2026-10-19T10:00:00Z", completed_at: "2026-10-19T10:00:01Z",
  checks: [{ name: "PostgreSQL", status: "failed", message: "DATABASE_URL não configurada no serviço SDR." }],
};
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(response({ success: true, diagnostics: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Diagnósticos do backup", () => {
  it("indica imediatamente o teste em andamento e mostra os checks junto ao botão", async () => {
    let finish!: (result: Response) => void;
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => options?.method === "POST"
      ? new Promise<Response>(resolve => { finish = resolve; })
      : Promise.resolve(response({ success: true, diagnostics: [] })));
    render(<BackupDiagnosticsPanel />);
    const button = await screen.findByRole("button", { name: "Testar ferramentas e conexão remota" });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Testando ferramentas e conexão…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toContain("Nenhum backup será criado");
    await act(async () => { finish(response({ success: true, diagnostic: report })); });
    const area = screen.getByRole("region", { name: "Diagnósticos de conexão" });
    expect(within(area).getByText(report.checks[0].message)).toBeDefined();
    expect(within(area).getByText(/· Falhou$/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Testar ferramentas e conexão remota" })).toHaveProperty("disabled", false);
    expect(fetchMock).toHaveBeenCalledWith("/api/backup/diagnostics", expect.objectContaining({ method: "POST" }));
  });

  it("recarrega o histórico persistido sem executar novo teste", async () => {
    fetchMock.mockImplementation(async () => response({ success: true, diagnostics: [report] }));
    const page = render(<BackupDiagnosticsPanel />);
    expect(await screen.findByText(report.checks[0].message)).toBeDefined();
    page.unmount();
    render(<BackupDiagnosticsPanel />);
    expect(await screen.findByText(report.checks[0].message)).toBeDefined();
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
  });

  it("mostra erro de migration no próprio diagnóstico e permite tentar novamente", async () => {
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => Promise.resolve(options?.method === "POST"
      ? response({ success: false, error: "Aplique migrations/022_backup_diagnostics.sql com autorização." }, 503)
      : response({ success: true, diagnostics: [] })));
    render(<BackupDiagnosticsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Testar ferramentas e conexão remota" }));
    expect((await screen.findByRole("alert")).textContent).toContain("022_backup_diagnostics.sql");
    expect(screen.getByRole("button", { name: "Testar ferramentas e conexão remota" })).toHaveProperty("disabled", false);
  });

  it("não imprime HTML nem erro bruto de rede recebido do servidor", async () => {
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => options?.method === "POST"
      ? Promise.resolve(new Response("<html>private-token</html>", { status: 502 }))
      : Promise.resolve(response({ success: true, diagnostics: [] })));
    render(<BackupDiagnosticsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Testar ferramentas e conexão remota" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("HTTP 502");
    expect(document.body.textContent).not.toContain("private-token");
  });

  it("distingue diagnóstico interrompido de teste aprovado", async () => {
    fetchMock.mockResolvedValue(response({ success: true, diagnostics: [{ ...report, status: "running", checks: [], completed_at: null }] }));
    render(<BackupDiagnosticsPanel />);
    expect(await screen.findByText(/Sem conclusão registrada:/)).toBeDefined();
    expect(screen.queryByText("Aprovado")).toBeNull();
  });

  it("encerra a espera com erro visível quando o servidor excede o prazo", async () => {
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => options?.method === "POST"
      ? Promise.reject(new DOMException("private-network-details", "TimeoutError"))
      : Promise.resolve(response({ success: true, diagnostics: [] })));
    render(<BackupDiagnosticsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Testar ferramentas e conexão remota" }));
    expect((await screen.findByRole("alert")).textContent).toContain("O teste excedeu 90 segundos");
    expect(screen.getByRole("button", { name: "Testar ferramentas e conexão remota" })).toHaveProperty("disabled", false);
    expect(document.body.textContent).not.toContain("private-network-details");
  });

  it("recusa diagnóstico duplicado enquanto a requisição está pendente", async () => {
    fetchMock.mockImplementation((_url: string, options?: RequestInit) => options?.method === "POST"
      ? new Promise(() => {}) : Promise.resolve(response({ success: true, diagnostics: [] })));
    render(<BackupDiagnosticsPanel />);
    const button = await screen.findByRole("button", { name: "Testar ferramentas e conexão remota" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1));
  });
});
