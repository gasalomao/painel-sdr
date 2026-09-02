import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.revokeSession.mockResolvedValue(undefined);
});

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  isSessionLiveStrict: vi.fn(),
  isAdminRequest: vi.fn(),
  findClientById: vi.fn(),
  signSession: vi.fn(),
  createAuthSession: vi.fn(),
  revokeSession: vi.fn(),
  revokeAllClientSessions: vi.fn(),
  hashPassword: vi.fn(),
  supabaseFrom: vi.fn(),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: mocks.supabaseFrom },
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: mocks.supabaseFrom },
}));

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "sdr_session",
  SESSION_TTL: 60 * 60 * 24 * 30,
  verifySession: mocks.verifySession,
  isSessionLiveStrict: mocks.isSessionLiveStrict,
  isAdminRequest: mocks.isAdminRequest,
  findClientById: mocks.findClientById,
  signSession: mocks.signSession,
  createAuthSession: mocks.createAuthSession,
  revokeSession: mocks.revokeSession,
  revokeAllClientSessions: mocks.revokeAllClientSessions,
  hashPassword: mocks.hashPassword,
}));

import { POST as stopImpersonate } from "@/app/api/admin/stop-impersonate/route";
import { GET as listClients, POST as createClient } from "@/app/api/admin/clients/route";
import {
  GET as getClient,
  PATCH as patchClient,
  DELETE as deleteClient,
} from "@/app/api/admin/clients/[id]/route";
import { POST as impersonate } from "@/app/api/admin/clients/[id]/impersonate/route";

function fakeReq(cookies: Record<string, string>) {
  return {
    cookies: {
      get: (name: string) => (cookies[name] !== undefined ? { value: cookies[name] } : undefined),
    },
    headers: { get: () => null },
  } as any;
}

const adminClaims = {
  sessionId: "s-admin",
  clientId: "admin-1",
  actorId: "admin-1",
  email: "admin@test.dev",
  name: "Admin",
  isAdmin: true,
  impersonating: false,
  features: {},
};

const impersonatedClaims = {
  sessionId: "s-imp",
  clientId: "tenant-b",
  actorId: "admin-1",
  email: "b@test.dev",
  name: "Tenant B",
  isAdmin: false,
  impersonating: true,
  features: {},
};

const adminRow = {
  id: "admin-1",
  name: "Admin",
  email: "admin@test.dev",
  password_hash: null,
  is_admin: true,
  is_active: true,
  default_ai_model: null,
  features: {},
  organizer_prompt: null,
};

describe("/api/admin/clients — autorização no handler", () => {
  it("bloqueia todos os handlers quando a sessão admin não está ativa", async () => {
    mocks.isAdminRequest.mockResolvedValue(false);
    const request = fakeReq({ sdr_session: "jwt-revogado" });
    const context = { params: Promise.resolve({ id: "tenant-b" }) };

    const responses = await Promise.all([
      listClients(request),
      createClient(request),
      getClient(request, context),
      patchClient(request, context),
      deleteClient(request, context),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect(mocks.isAdminRequest).toHaveBeenCalledTimes(5);
    expect(mocks.supabaseFrom).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/stop-impersonate", () => {
  it("sem cookie de sessão → 401", async () => {
    mocks.verifySession.mockResolvedValue(null);
    const res = await stopImpersonate(fakeReq({}));
    expect(res.status).toBe(401);
  });

  it("sessão revogada no DB → 401", async () => {
    mocks.verifySession.mockResolvedValue(impersonatedClaims);
    mocks.isSessionLiveStrict.mockResolvedValue(false);
    const res = await stopImpersonate(fakeReq({ sdr_session: "tok" }));
    expect(res.status).toBe(401);
  });

  it("sessão comum NÃO restaura cookie admin legado (ataca CRITICAL-2)", async () => {
    mocks.verifySession.mockResolvedValue({ ...adminClaims, impersonating: false });
    mocks.isSessionLiveStrict.mockResolvedValue(true);
    // Cenário do ataque: navegador tem ADMIN_SESSION_COOKIE com o JWT do admin
    const res = await stopImpersonate(fakeReq({ sdr_session: "tok", ADMIN_SESSION_COOKIE: "admin-jwt-vivo" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restored).toBe(false);
    // A sessão atual NÃO pode virar o token do cookie legado
    expect(res.cookies.get("sdr_session")?.value).not.toBe("admin-jwt-vivo");
    // E o cookie legado é removido
    expect(res.cookies.get("ADMIN_SESSION_COOKIE")?.value ?? "").toBe("");
    expect(mocks.signSession).not.toHaveBeenCalled();
  });

  it("impersonado + actorId admin → reemite sessão admin nova e revoga a impersonada", async () => {
    mocks.verifySession.mockResolvedValue(impersonatedClaims);
    mocks.isSessionLiveStrict.mockResolvedValue(true);
    mocks.findClientById.mockResolvedValue(adminRow);
    mocks.signSession.mockResolvedValue("novo-jwt-admin");
    mocks.createAuthSession.mockResolvedValue("novo-id");

    const res = await stopImpersonate(fakeReq({ sdr_session: "tok-imp" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restored).toBe(true);

    expect(mocks.signSession).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "admin-1", actorId: "admin-1", isAdmin: true, impersonating: false })
    );
    expect(mocks.revokeSession).toHaveBeenCalledWith("s-imp");
    expect(res.cookies.get("sdr_session")?.value).toBe("novo-jwt-admin");
    expect(res.cookies.get("ADMIN_SESSION_COOKIE")?.value ?? "").toBe("");
  });

  it("actorId perdeu admin → revoga sessão e manda pro login", async () => {
    mocks.verifySession.mockResolvedValue(impersonatedClaims);
    mocks.isSessionLiveStrict.mockResolvedValue(true);
    mocks.findClientById.mockResolvedValue({ ...adminRow, is_admin: false });

    const res = await stopImpersonate(fakeReq({ sdr_session: "tok-imp" }));
    const body = await res.json();
    expect(body.redirectedToLogin).toBe(true);
    expect(mocks.revokeSession).toHaveBeenCalledWith("s-imp");
    expect(mocks.signSession).not.toHaveBeenCalled();
    expect(res.cookies.get("sdr_session")?.value).toBe("");
  });
});

describe("POST /api/admin/clients/[id]/impersonate", () => {
  it("revoga a sessão do admin e NÃO grava cookie com o token antigo", async () => {
    mocks.verifySession.mockResolvedValue(adminClaims);
    mocks.isSessionLiveStrict.mockResolvedValue(true);
    mocks.findClientById.mockResolvedValue({ ...adminRow, id: "tenant-b", is_admin: false, name: "Tenant B" });
    mocks.signSession.mockResolvedValue("imp-jwt");
    mocks.createAuthSession.mockResolvedValue("s-imp");

    const res = await impersonate(fakeReq({ sdr_session: "admin-jwt-original" }), {
      params: Promise.resolve({ id: "tenant-b" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.revokeSession).toHaveBeenCalledWith("s-admin");
    // Cookie de restore legado não pode conter o token original:
    expect(res.cookies.get("ADMIN_SESSION_COOKIE")?.value ?? "").toBe("");
    // Sessão nova é a impersonada:
    expect(res.cookies.get("sdr_session")?.value).toBe("imp-jwt");
  });

  it("não-admin → 403", async () => {
    mocks.verifySession.mockResolvedValue({ ...adminClaims, isAdmin: false });
    mocks.isSessionLiveStrict.mockResolvedValue(true);
    const res = await impersonate(fakeReq({ sdr_session: "tok" }), {
      params: Promise.resolve({ id: "tenant-b" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.signSession).not.toHaveBeenCalled();
  });
});
