// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  autoLinkAgentOnConnect: vi.fn(async () => ({ ok: true, action: "linked", agentId: 7 })),
  handleWebhookConnectionClosed: vi.fn(async () => {}),
  eqCalls: [] as [string, unknown][],
  updatePayloads: [] as unknown[],
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "channel_connections") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          update: (payload: unknown) => {
            mocks.updatePayloads.push(payload);
            return chain;
          },
          eq: (col: string, val: unknown) => {
            mocks.eqCalls.push([col, val]);
            return chain;
          },
          maybeSingle: async () => ({
            data: {
              client_id: "tenant-go",
              provider_config: { webhook_secret: "segredo-go" },
            },
            error: null,
          }),
          then: (res: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(res),
        };
        return chain;
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      };
    },
  },
}));

vi.mock("@/lib/auto-link-agent", () => ({
  autoLinkAgentOnConnect: mocks.autoLinkAgentOnConnect,
}));

vi.mock("@/lib/warmup/warmup-engine", () => ({
  handleWebhookConnectionClosed: mocks.handleWebhookConnectionClosed,
}));

vi.mock("@/lib/manual-send-registry", () => ({
  isAiSend: () => false,
  isManualSend: () => false,
  isPendingAutomatedSend: () => false,
  isPendingAutomatedMedia: () => false,
}));

vi.mock("@/lib/bot-status", () => ({
  shouldSkipGroupActions: async () => false,
  resolveTranscriptionConfig: async () => ({ method: "auto", models: [] }),
}));

vi.mock("@/lib/opt-out", () => ({
  handleIncomingOptOutIfDetected: async () => false,
}));

vi.mock("@/lib/warmup/warmup-firewall", () => ({
  detectWarmupPeerTraffic: async () => ({ blocked: false }),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {},
}));

import { POST } from "@/app/api/webhooks/evolution-go/route";

describe("Webhook Evolution GO — connection.update multi-tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eqCalls.length = 0;
    mocks.updatePayloads.length = 0;
  });

  it("escopa update em channel_connections por client_id e chama autoLinkAgentOnConnect quando open", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/evolution-go", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": "segredo-go",
      },
      body: JSON.stringify({
        event: "connection.update",
        instance: "inst-go-1",
        data: { state: "open" },
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, event: "connection_update", state: "open" });
    expect(mocks.updatePayloads).toContainEqual({ status: "open" });
    expect(mocks.eqCalls).toContainEqual(["instance_name", "inst-go-1"]);
    expect(mocks.eqCalls).toContainEqual(["client_id", "tenant-go"]);
    expect(mocks.autoLinkAgentOnConnect).toHaveBeenCalledWith("inst-go-1");
  });
});

