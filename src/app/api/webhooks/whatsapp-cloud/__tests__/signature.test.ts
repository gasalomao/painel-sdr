import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
declare const process: any;
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  connections: [
    {
      client_id: "client-a",
      provider: "whatsapp_cloud",
      provider_config: { phone_number_id: "phone-a", app_secret: "secret-a" },
    },
    {
      client_id: "client-b",
      provider: "whatsapp_cloud",
      provider_config: { phone_number_id: "phone-b", app_secret: "secret-b" },
    },
  ] as any[],
  resolveConnection: (_phoneNumberId: string) => null as any,
}));

function chain(result: any = { data: [], error: null }) {
  const c: any = {};
  for (const k of ["select", "eq", "in", "neq", "update", "insert", "order", "limit", "maybeSingle", "single"]) {
    c[k] = () => (k === "eq" || k === "in" || k === "select" ? c : c);
  }
  c.select = () => c;
  c.eq = () => c;
  c.in = () => ({ promise: undefined, ...c, ...Promise.resolve(result) });
  c.update = () => c;
  c.insert = () => Promise.resolve(result);
  c.maybeSingle = () => Promise.resolve({ data: null, error: null });
  c.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return c;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "channel_connections") {
        const c: any = {};
        c.select = () => c;
        c.eq = () => c;
        c.in = (_col: string, ids: string[]) => {
          const filtered = state.connections.filter((r) => ids.includes(r.provider_config.phone_number_id));
          return { ...c, then: (res: any, rej: any) => Promise.resolve({ data: filtered, error: null }).then(res, rej) };
        };
        return c;
      }
      return chain();
    },
  },
}));

vi.mock("@/lib/whatsapp-cloud", () => ({
  whatsappCloud: {
    parseIncoming: (body: any) => body.__parsed,
  },
}));

vi.mock("@/lib/channel", () => ({
  resolveChannel: vi.fn(),
  resolveConnectionFromPhoneNumberId: (p: string) => state.resolveConnection(p),
}));

vi.mock("@/lib/bot-status", () => ({
  getEffectiveStatus: vi.fn(),
  shouldSkipGroupActions: vi.fn(),
  getTranscriptionMethod: vi.fn(),
  getTranscriptionModels: vi.fn(),
}));
vi.mock("@/lib/manual-send-registry", () => ({ isManualSend: vi.fn() }));
vi.mock("@/lib/internal-auth", () => ({ getInternalSecret: () => "x", INTERNAL_SECRET_HEADER: "x-internal" }));
vi.mock("@/lib/webhook-security", () => ({ shouldLogOnce: () => true }));

function sign(secret: string, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function makeRequest(body: any, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return new NextRequest("http://localhost/api/webhooks/whatsapp-cloud", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
  });
}

describe("whatsapp-cloud — vínculo assinatura ↔ phone_number_id", () => {
  beforeEach(async () => {
    process.env.WHATSAPP_CLOUD_APP_SECRET = "";
    process.env.NODE_ENV = "production";
    vi.resetModules();
  });

  it("rejeita quando a assinatura do tenant B é usada em evento do phone do tenant A", async () => {
    const body = {
      object: "whatsapp_business_account",
      __parsed: {
        messages: [],
        statuses: [{ phoneNumberId: "phone-a", messageId: "m1", status: "delivered" }],
      },
    };
    const raw = JSON.stringify(body);
    const req = new NextRequest("http://localhost/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": sign("secret-b", raw) },
      body: raw,
    });
    const { POST } = await import("../route");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("aceita quando a assinatura casa com o app_secret do próprio phone_number_id", async () => {
    state.resolveConnection = () => ({ instanceName: "inst-a", clientId: "client-a" });
    const body = {
      object: "whatsapp_business_account",
      __parsed: {
        messages: [],
        statuses: [{ phoneNumberId: "phone-a", messageId: "m1", status: "delivered" }],
      },
    };
    const raw = JSON.stringify(body);
    const reqSigned = new NextRequest("http://localhost/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": sign("secret-a", raw) },
      body: raw,
    });
    const { POST } = await import("../route");
    const res = await POST(reqSigned);
    expect(res.status).toBe(200);
  });

  it("rejeita evento sem header quando há secret configurado (em qualquer NODE_ENV)", async () => {
    process.env.NODE_ENV = "development";
    const body = {
      object: "whatsapp_business_account",
      __parsed: {
        messages: [],
        statuses: [{ phoneNumberId: "phone-a", messageId: "m1", status: "delivered" }],
      },
    };
    const req = makeRequest(body, {});
    const { POST } = await import("../route");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
