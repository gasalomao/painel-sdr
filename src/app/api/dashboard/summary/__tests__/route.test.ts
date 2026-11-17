// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const scopedClientIds: Array<{ table: string; value: string }> = [];

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => ({ ok: true, clientId: "tenant-dash-1", isAdmin: false })),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        gte: () => chain,
        lt: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (col: string, val: string) => {
          if (col === "client_id") scopedClientIds.push({ table, value: val });
          return chain;
        },
        then: (res: (v: { count?: number; data: unknown[]; error: null }) => void) =>
          Promise.resolve({
            count: 3,
            data:
              table === "chats_dashboard"
                ? [{ remote_jid: "a@s.whatsapp.net" }, { remote_jid: "a@s.whatsapp.net" }, { remote_jid: "b@s.whatsapp.net" }]
                : [{ id: 10, nome_negocio: "Empresa X", ramo_negocio: "Serviços", created_at: "2026-11-16T10:00:00Z" }],
            error: null,
          }).then(res),
      };
      return chain;
    },
  },
}));

describe("GET /api/dashboard/summary", () => {
  it("escopa todas as 9 consultas por client_id e agrega métricas corretamente", async () => {
    const { GET } = await import("../route");
    const res = await GET(new NextRequest("http://localhost/api/dashboard/summary"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.metrics.conversasHoje).toBe(2);
    expect(json.metrics.totalLeads).toBe(3);
    expect(json.recentLeads).toHaveLength(1);
    expect(scopedClientIds).toHaveLength(9);
    expect(scopedClientIds.every((s) => s.value === "tenant-dash-1")).toBe(true);
  });
});

