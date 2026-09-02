import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  isSessionLiveStrict: vi.fn(),
  isAdminRequest: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "sdr_session",
  verifySession: mocks.verifySession,
  isSessionLiveStrict: mocks.isSessionLiveStrict,
  isAdminRequest: mocks.isAdminRequest,
}));

vi.mock("@/lib/ai-default-model", () => ({
  resolveModelForClient: vi.fn(async () => "openrouter/auto"),
}));

import { GET } from "@/app/api/auth/session/route";

function req(token = "jwt") {
  return {
    cookies: { get: vi.fn(() => ({ value: token })) },
  } as any;
}

describe("sessão autenticada exige registro ativo no banco", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifySession.mockResolvedValue({
      clientId: "tenant-A",
      actorId: "tenant-A",
      sessionId: "session-1",
      name: "Cliente",
      email: "cliente@example.com",
      isAdmin: false,
      impersonating: false,
      features: {},
    });
  });

  it("rejeita JWT válido quando a sessão não existe ou o banco falha", async () => {
    mocks.isSessionLiveStrict.mockResolvedValue(false);
    const res = await GET(req());
    expect(await res.json()).toEqual({ authenticated: false, reason: "revoked_or_expired" });
    expect(mocks.isSessionLiveStrict).toHaveBeenCalledWith("session-1", "jwt");
  });

  it("aceita JWT válido somente com sessão ativa", async () => {
    mocks.isSessionLiveStrict.mockResolvedValue(true);
    const res = await GET(req());
    expect((await res.json()).authenticated).toBe(true);
  });
});
