import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth-edge", () => ({
  SESSION_COOKIE: "painel_session",
  verifySession: vi.fn(async () => null),
}));

import { GET } from "../route";
import { proxy } from "@/proxy";

describe("GET /api/health e bypass de liveness no proxy", () => {
  it("retorna 200 ok com Cache-Control no-store e sem segredos", async () => {
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(json).toMatchObject({ ok: true, status: "ok" });
    expect(typeof json.timestamp).toBe("string");
  });

  it("permite /api/health sem sessão no proxy enquanto bloqueia rotas privadas", async () => {
    const healthReq = new NextRequest("http://localhost/api/health");
    const healthRes = await proxy(healthReq);
    expect(healthRes.status).toBe(200);

    const privReq = new NextRequest("http://localhost/api/agents");
    const privRes = await proxy(privReq);
    expect(privRes.status).toBe(401);
  });
});

