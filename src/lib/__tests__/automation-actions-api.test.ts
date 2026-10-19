import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  isSessionLiveStrict: vi.fn(),
  from: vi.fn(),
  lookup: vi.fn(),
  startAutomation: vi.fn(),
  pauseAutomation: vi.fn(),
}));

vi.mock("@/lib/auth-edge", () => ({
  SESSION_COOKIE: "session",
  verifySession: mocks.verifySession,
}));
vi.mock("@/lib/auth", () => ({
  isSessionLiveStrict: mocks.isSessionLiveStrict,
}));
vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/automation-worker", () => ({
  startAutomation: mocks.startAutomation,
  pauseAutomation: mocks.pauseAutomation,
}));

import { POST as start } from "@/app/api/automations/[id]/start/route";
import { POST as pause } from "@/app/api/automations/[id]/pause/route";

const automations = [
  { id: "automation-A", client_id: "tenant-A" },
  { id: "automation-B", client_id: "tenant-B" },
];

function request(action: string, authenticated = true): NextRequest {
  return new NextRequest(`http://localhost/api/automations/automation-A/${action}`, {
    method: "POST",
    headers: authenticated ? { Cookie: "session=session-token" } : {},
  });
}

const context = { params: Promise.resolve({ id: "automation-A" }) };

describe.each([
  { action: "start", POST: start, worker: mocks.startAutomation },
  { action: "pause", POST: pause, worker: mocks.pauseAutomation },
])("/api/automations/[id]/$action", ({ action, POST, worker }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.verifySession.mockResolvedValue({ clientId: "tenant-A", sessionId: "session-A" });
    mocks.isSessionLiveStrict.mockResolvedValue(true);
    mocks.startAutomation.mockResolvedValue({ ok: true });
    mocks.pauseAutomation.mockResolvedValue({ ok: true });
    mocks.lookup.mockImplementation(async (filters: Record<string, string>) => ({
      data: automations.find(row => row.id === filters.id && row.client_id === filters.client_id) ?? null,
      error: null,
    }));
    mocks.from.mockImplementation(() => {
      const filters: Record<string, string> = {};
      return {
        select() { return this; },
        eq(column: string, value: string) { filters[column] = value; return this; },
        maybeSingle() { return mocks.lookup(filters); },
      };
    });
  });

  it("rejeita requisição sem autenticação antes de consultar o banco ou chamar workers", async () => {
    const response = await POST(request(action, false), context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Não autenticado" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.startAutomation).not.toHaveBeenCalled();
    expect(mocks.pauseAutomation).not.toHaveBeenCalled();
  });

  it("impede tenant B de controlar a automação do tenant A", async () => {
    mocks.verifySession.mockResolvedValue({ clientId: "tenant-B", sessionId: "session-B" });

    const response = await POST(request(action), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "Automação não encontrada" });
    expect(mocks.lookup).toHaveBeenCalledWith({ id: "automation-A", client_id: "tenant-B" });
    expect(mocks.startAutomation).not.toHaveBeenCalled();
    expect(mocks.pauseAutomation).not.toHaveBeenCalled();
  });

  it.each([null, { id: "automation-A" }])("trata erro na consulta de propriedade como indisponibilidade, mesmo com data=%j", async (data) => {
    mocks.lookup.mockResolvedValueOnce({ data, error: { message: "database unavailable" } });

    const response = await POST(request(action), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "DB indisponível" });
    expect(mocks.startAutomation).not.toHaveBeenCalled();
    expect(mocks.pauseAutomation).not.toHaveBeenCalled();
  });

  it("retorna 409 com o resultado da recusa do worker", async () => {
    const result = { ok: false, error: "Ação recusada pelo worker" };
    worker.mockResolvedValueOnce(result);

    const response = await POST(request(action), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(result);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith("automation-A", "tenant-A");
  });

  it.each(["autenticação", "consulta", "worker"])("controla exceção inesperada de %s em JSON", async (stage) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("internal failure");
    if (stage === "autenticação") mocks.verifySession.mockRejectedValueOnce(failure);
    else if (stage === "consulta") mocks.lookup.mockRejectedValueOnce(failure);
    else worker.mockRejectedValueOnce(failure);

    const response = await POST(request(action), context);

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: false, error: expect.any(String) });
    if (stage !== "worker") {
      expect(mocks.startAutomation).not.toHaveBeenCalled();
      expect(mocks.pauseAutomation).not.toHaveBeenCalled();
    }
  });

  it("retorna o sucesso real do worker sem alterar o contrato", async () => {
    const response = await POST(request(action), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.from).toHaveBeenCalledWith("automations");
    expect(mocks.isSessionLiveStrict).toHaveBeenCalledWith("session-A", "session-token");
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith("automation-A", "tenant-A");
  });
});
