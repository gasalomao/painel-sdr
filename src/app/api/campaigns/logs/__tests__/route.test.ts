// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  clientId: "tenant-1",
  ownedCampaign: true,
  deletedCampaignIds: [] as string[],
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => ({ ok: true, clientId: state.clientId, isAdmin: false })),
}));
vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let isDelete = false;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        delete: () => {
          isDelete = true;
          return chain;
        },
        maybeSingle: async () => ({
          data: table === "campaigns" && state.ownedCampaign ? { id: filters.id } : null,
          error: null,
        }),
        then: (res: (v: { data?: unknown[]; error: null }) => void) => {
          if (isDelete && filters.campaign_id) {
            state.deletedCampaignIds.push(String(filters.campaign_id));
          }
          return Promise.resolve({
            data: table === "campaign_logs" ? [{ id: "l1", campaign_id: "camp-1", message: "ok" }] : [],
            error: null,
          }).then(res);
        },
      };
      return chain;
    },
  },
}));

describe("/api/campaigns/logs BFF", () => {
  beforeEach(() => {
    state.ownedCampaign = true;
    state.deletedCampaignIds = [];
  });

  it("bloqueia leitura e deleção cross-tenant com 404", async () => {
    state.ownedCampaign = false;
    const { GET, DELETE } = await import("../route");
    const getRes = await GET(new NextRequest("http://localhost/api/campaigns/logs?campaign_id=other"));
    const delRes = await DELETE(new NextRequest("http://localhost/api/campaigns/logs?campaign_id=other", { method: "DELETE" }));
    expect(getRes.status).toBe(404);
    expect(delRes.status).toBe(404);
    expect(state.deletedCampaignIds).toHaveLength(0);
  });

  it("permite leitura e limpeza quando campanha pertence ao tenant", async () => {
    const { GET, DELETE } = await import("../route");
    const getRes = await GET(new NextRequest("http://localhost/api/campaigns/logs?campaign_id=camp-1"));
    expect(getRes.status).toBe(200);
    const delRes = await DELETE(new NextRequest("http://localhost/api/campaigns/logs?campaign_id=camp-1", { method: "DELETE" }));
    expect(delRes.status).toBe(200);
    expect(state.deletedCampaignIds).toEqual(["camp-1"]);
  });
});

