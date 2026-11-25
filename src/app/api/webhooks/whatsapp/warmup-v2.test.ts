// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  channel_connections: [] as Row[],
  webhook_logs: [] as Row[],
  messages: [] as Row[],
  chats_dashboard: [] as Row[],
  sessions: [] as Row[],
}));

const mocks = vi.hoisted(() => ({
  recordDeliveryFeedback: vi.fn().mockResolvedValue(undefined),
  handleConnectionClosed: vi.fn().mockResolvedValue({ severe: true, pausedCampaigns: 0 }),
  autoLinkAgentOnConnect: vi.fn().mockResolvedValue({ linked: false }),
  reconcileWarmupIdentityByPhone: vi.fn().mockResolvedValue({ restored: true }),
  getStatus: vi.fn().mockResolvedValue({ state: "open", data: { owner: "5511961607625@s.whatsapp.net" } }),
}));

function makeWebhookBuilder(tableName: keyof typeof db) {
  let op: "select" | "insert" | "update" = "select";
  let payload: any = null;
  const filters: Array<(row: Row) => boolean> = [];

  const exec = () => {
    const rows = db[tableName];
    if (op === "select") {
      return { data: rows.filter((r) => filters.every((f) => f(r))), error: null };
    }
    if (op === "insert") {
      const items = Array.isArray(payload) ? payload : [payload];
      for (const item of items) rows.push({ ...item });
      return { data: items, error: null };
    }
    if (op === "update") {
      const updated: Row[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (filters.every((f) => f(rows[i]))) {
          rows[i] = { ...rows[i], ...payload };
          updated.push({ ...rows[i] });
        }
      }
      return { data: updated, error: null };
    }
    return { data: [], error: null };
  };

  const b: any = {
    select: () => {
      op = "select";
      return b;
    },
    insert: (data: any) => {
      op = "insert";
      payload = data;
      return b;
    },
    update: (data: any) => {
      op = "update";
      payload = data;
      return b;
    },
    eq: (col: string, val: any) => {
      filters.push((r) => r[col] === val);
      return b;
    },
    maybeSingle: async () => {
      const res = exec();
      return { data: res.data[0] || null, error: null };
    },
    then: (resolve: any, reject: any) => Promise.resolve(exec()).then(resolve, reject),
  };
  return b;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: keyof typeof db) => makeWebhookBuilder(table),
  },
}));

vi.mock("@/lib/evolution", () => ({
  evolution: { getStatus: mocks.getStatus },
}));

vi.mock("@/lib/warmup/warmup-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/warmup/warmup-engine")>();
  return {
    ...actual,
    recordWebhookDeliveryFeedback: mocks.recordDeliveryFeedback,
    handleWebhookConnectionClosed: mocks.handleConnectionClosed,
  };
});

vi.mock("@/lib/auto-link-agent", () => ({
  autoLinkAgentOnConnect: mocks.autoLinkAgentOnConnect,
}));

vi.mock("@/lib/warmup/warmup-phone-memory", () => ({
  reconcileWarmupIdentityByPhone: mocks.reconcileWarmupIdentityByPhone,
}));

import { POST, STATUS_MAP } from "./route";

describe("Webhook Evolution v2.3.7 — messages.update (keyId/DELIVERY_ACK) e connection.update", () => {
  const clientId = "tenant-wh-v2";
  const secret = "sec-123";

  beforeEach(() => {
    db.channel_connections.length = 0;
    db.webhook_logs.length = 0;
    db.messages.length = 0;
    db.chats_dashboard.length = 0;
    db.sessions.length = 0;

    db.channel_connections.push({
      client_id: clientId,
      instance_name: "inst-v2",
      status: "connecting",
      provider_config: { webhook_secret: secret, webhook_strict: true },
    });

    mocks.recordDeliveryFeedback.mockReset().mockResolvedValue(undefined);
    mocks.handleConnectionClosed.mockReset().mockResolvedValue({ severe: true, pausedCampaigns: 0 });
    mocks.autoLinkAgentOnConnect.mockReset().mockResolvedValue({ linked: false });
    mocks.reconcileWarmupIdentityByPhone.mockReset().mockResolvedValue({ restored: true });
    mocks.getStatus.mockReset().mockResolvedValue({ state: "open", data: { owner: "5511961607625@s.whatsapp.net" } });
  });

  it("mapeia todos os status v2.3.7 corretamente em STATUS_MAP", () => {
    expect(STATUS_MAP["SERVER_ACK"]).toBe("sent");
    expect(STATUS_MAP["DELIVERY_ACK"]).toBe("delivered");
    expect(STATUS_MAP["READ"]).toBe("read");
    expect(STATUS_MAP["PLAYED"]).toBe("played");
    expect(STATUS_MAP["ERROR"]).toBe("error");
    expect(STATUS_MAP["FAILED"]).toBe("error");
  });

  it("processa messages.update v2.3.7 usando data.keyId e array de status (DELIVERY_ACK e READ)", async () => {
    db.messages.push(
      { client_id: clientId, message_id: "msg-v2-1", delivery_status: "sent" },
      { client_id: clientId, message_id: "msg-v2-2", delivery_status: "delivered" }
    );
    db.chats_dashboard.push(
      { client_id: clientId, message_id: "msg-v2-1", status_envio: "sent" },
      { client_id: clientId, message_id: "msg-v2-2", status_envio: "delivered" }
    );

    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify({
        event: "messages.update",
        instance: "inst-v2",
        data: [
          { keyId: "msg-v2-1", status: "DELIVERY_ACK" },
          { keyId: "msg-v2-2", status: "READ" },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(db.messages[0].delivery_status).toBe("delivered");
    expect(db.messages[1].delivery_status).toBe("read");
    expect(db.chats_dashboard[0].status_envio).toBe("delivered");
    expect(db.chats_dashboard[1].status_envio).toBe("read");

    await new Promise((r) => setTimeout(r, 15));
    expect(mocks.recordDeliveryFeedback).toHaveBeenCalledTimes(2);
    expect(mocks.recordDeliveryFeedback).toHaveBeenCalledWith({
      clientId,
      instanceName: "inst-v2",
      statusText: "delivered",
    });
    expect(mocks.recordDeliveryFeedback).toHaveBeenCalledWith({
      clientId,
      instanceName: "inst-v2",
      statusText: "read",
    });
  });

  it("trata connection.update state=refused como close severo e reconcilia passaporte quando state=open", async () => {
    const refusedReq = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify({
        event: "connection.update",
        instance: "inst-v2",
        data: { state: "refused", statusReason: 428 },
      }),
    });

    const r1 = await POST(refusedReq);
    expect(r1.status).toBe(200);
    expect(db.channel_connections[0].status).toBe("close");
    await new Promise((r) => setTimeout(r, 15));
    expect(mocks.handleConnectionClosed).toHaveBeenCalledWith({
      clientId,
      instanceName: "inst-v2",
      statusReason: 428,
    });

    const openReq = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify({
        event: "connection.update",
        instance: "inst-v2",
        data: { state: "open" },
      }),
    });

    const r2 = await POST(openReq);
    expect(r2.status).toBe(200);
    expect(db.channel_connections[0].status).toBe("open");
    expect(mocks.reconcileWarmupIdentityByPhone).toHaveBeenCalledWith({
      clientId,
      instanceName: "inst-v2",
      phone: "5511961607625",
    });
  });
});
