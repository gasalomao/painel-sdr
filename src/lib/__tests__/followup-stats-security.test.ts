// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const state = vi.hoisted(() => ({ tenant: vi.fn(), from: vi.fn(), eq: vi.fn(), single: vi.fn(), followups: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ requireClientId: state.tenant }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: state.from } }));
import { GET } from "@/app/api/followup/stats/route";
beforeEach(() => {
  state.tenant.mockResolvedValue({ ok: true, clientId: "tenant-a" });
  state.single.mockResolvedValue({ data: { id: 1, name: "Agent" }, error: null });
  state.followups.mockResolvedValue({ data: [{ status: "pending", current_step: 1, next_send_at: new Date().toISOString() }], error: null });
  state.from.mockImplementation(table => {
    const chain = { select: vi.fn(() => chain), eq: state.eq, single: state.single, then: (resolve: (value: unknown) => unknown) => state.followups().then(resolve) };
    state.eq.mockReturnValue(chain);
    return chain;
  });
});
const req = (id = "1") => new NextRequest(`https://app.example.test/api/followup/stats?agent_id=${id}`);
describe("followup stats tenant boundary", () => {
  it("uses the application session and tenant-scoped server queries", async () => {
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(state.tenant).toHaveBeenCalled();
    expect(state.eq.mock.calls.filter(([key]) => key === "client_id")).toEqual([["client_id", "tenant-a"], ["client_id", "tenant-a"]]);
    expect(await response.json()).toMatchObject({ success: true, stats: { pending: 1 } });
  });
  it("rejects unauthenticated requests before database access", async () => {
    state.tenant.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) });
    expect((await GET(req())).status).toBe(401);
    expect(state.from).not.toHaveBeenCalled();
  });
  it.each(["", "1junk", "0", "-1", "9007199254740992"])("rejects invalid agent ID %s", async id => {
    expect((await GET(req(id))).status).toBe(400);
    expect(state.from).not.toHaveBeenCalled();
  });
  it("returns not found for foreign agents and sanitizes database failure", async () => {
    state.single.mockResolvedValueOnce({ data: null, error: null });
    expect((await GET(req())).status).toBe(404);
    state.followups.mockResolvedValue({ data: null, error: { message: "private-secret" } });
    const response = await GET(req());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private-secret");
  });
});
