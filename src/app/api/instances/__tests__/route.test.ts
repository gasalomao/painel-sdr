// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  clientId: "tenant-1",
  isAdmin: false,
  instanceOwned: true,
  agentOwned: true,
  previousAgentId: 10,
  updatedPayloads: [] as Array<Record<string, unknown>>,
  invalidatedAgents: [] as number[],
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => ({ ok: true, clientId: state.clientId, isAdmin: state.isAdmin })),
}));
vi.mock("@/lib/agent-config-cache", () => ({
  invalidateAgentConfigCache: vi.fn((id: number) => state.invalidatedAgents.push(id)),
}));
vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (payload: Record<string, unknown>) => {
          state.updatedPayloads.push({ table, ...payload });
          return chain;
        },
        maybeSingle: async () => {
          if (table === "channel_connections") {
            return {
              data: state.instanceOwned ? { id: "c1", client_id: state.clientId, agent_id: state.previousAgentId, status: "open" } : null,
              error: null,
            };
          }
          if (table === "agent_settings") {
            return { data: state.agentOwned ? { id: 20 } : null, error: null };
          }
          return { data: null, error: null };
        },
        then: (res: (v: { data: unknown[]; error: null }) => void) =>
          Promise.resolve({
            data:
              table === "channel_connections"
                ? [
                    {
                      id: "c1",
                      instance_name: "inst-1",
                      client_id: state.clientId,
                      agent_id: 10,
                      status: "open",
                      provider: "whatsapp_cloud",
                      provider_config: { phone_number_id: "pn-1", access_token: "SECRET_TOKEN", webhook_secret: "SECRET_WH" },
                    },
                  ]
                : [{ id: 10, name: "Agente 10" }],
            error: null,
          }).then(res),
      };
      return chain;
    },
  },
}));

describe("/api/instances BFF", () => {
  beforeEach(() => {
    state.clientId = "tenant-1";
    state.isAdmin = false;
    state.instanceOwned = true;
    state.agentOwned = true;
    state.previousAgentId = 10;
    state.updatedPayloads = [];
    state.invalidatedAgents = [];
  });

  it("GET sanitiza provider_config removendo segredos e expõe apenas phone_number_id", async () => {
    const { GET } = await import("../route");
    const res = await GET(new NextRequest("http://localhost/api/instances?include_agents=1&scope=tenant"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.instances).toHaveLength(1);
    expect(json.instances[0].phone_number_id).toBe("pn-1");
    expect(JSON.stringify(json)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(json)).not.toContain("SECRET_WH");
  });

  it("PATCH bloqueia vincular agente de outro tenant (403) e invalida cache antigo + novo no sucesso", async () => {
    const { PATCH } = await import("../route");
    state.agentOwned = false;
    const forbidden = await PATCH(
      new NextRequest("http://localhost/api/instances", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_name: "inst-1", agent_id: 999 }),
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(state.updatedPayloads).toHaveLength(0);

    state.agentOwned = true;
    const ok = await PATCH(
      new NextRequest("http://localhost/api/instances", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_name: "inst-1", agent_id: 20 }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(state.invalidatedAgents).toEqual([10, 20]);
  });
});

