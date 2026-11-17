// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  insertedLogs: [] as Record<string, unknown>[],
  agentProcessCalls: [] as Record<string, unknown>[],
  optOutResult: false,
  botActive: true,
  existingContact: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: (_col: string, values: string[]) => {
          if (table === "channel_connections") {
            return Promise.resolve({
              data: [
                {
                  client_id: "client-a",
                  provider: "whatsapp_cloud",
                  provider_config: { phone_number_id: "phone-a", app_secret: "secret-a" },
                },
              ],
              error: null,
            });
          }
          if (table === "contacts" && state.existingContact && values.includes(String(state.existingContact.remote_jid))) {
            return {
              limit: async () => ({ data: [state.existingContact], error: null }),
            };
          }
          return { limit: async () => ({ data: [], error: null }) };
        },
        limit: () => chain,
        maybeSingle: async () => {
          if (table === "sessions") {
            return {
              data: { id: "sess-1", bot_status: state.botActive ? "bot_active" : "human_takeover", agent_id: 1, unread_count: 0 },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        single: async () => ({
          data: { id: table === "contacts" ? "contact-1" : "sess-1", bot_status: "bot_active", agent_id: 1, unread_count: 0 },
          error: null,
        }),
        insert: (row: Record<string, unknown>) => {
          if (table === "webhook_logs") {
            state.insertedLogs.push(row);
            return Promise.resolve({ data: null, error: null });
          }
          return {
            select: () => ({
              single: async () => ({ data: { id: `${table}-1`, bot_status: "bot_active", agent_id: 1 }, error: null }),
            }),
            then: (res: (v: { error: null }) => void) => Promise.resolve({ error: null }).then(res),
          };
        },
        update: () => chain,
        then: (res: (v: { data: null; error: null }) => void, rej?: (e: unknown) => void) =>
          Promise.resolve({ data: null, error: null }).then(res, rej),
      };
      return chain;
    },
  },
}));

vi.mock("@/lib/whatsapp-cloud", () => ({
  whatsappCloud: {
    parseIncoming: (body: Record<string, unknown>) => body.__parsed,
    markRead: vi.fn(async () => { }),
  },
}));

vi.mock("@/lib/channel", () => ({
  resolveChannel: vi.fn(async () => ({ agent_id: 1, cloud: null })),
  resolveConnectionFromPhoneNumberId: vi.fn(async () => ({ instanceName: "cloud-inst", clientId: "client-a" })),
}));

vi.mock("@/lib/bot-status", () => ({
  getEffectiveStatus: vi.fn(async () => ({ isActive: state.botActive })),
  shouldSkipGroupActions: vi.fn(async () => false),
  getTranscriptionMethod: vi.fn(async () => "auto"),
  getTranscriptionModels: vi.fn(async () => []),
}));

vi.mock("@/lib/manual-send-registry", () => ({ isManualSend: vi.fn(() => false) }));
vi.mock("@/lib/internal-auth", () => ({ getInternalSecret: () => "sec-1", INTERNAL_SECRET_HEADER: "x-internal-secret" }));
vi.mock("@/lib/webhook-security", () => ({ shouldLogOnce: () => true }));
vi.mock("@/lib/opt-out", () => ({
  handleIncomingOptOutIfDetected: vi.fn(async () => state.optOutResult),
}));
vi.mock("@/lib/campaign-worker", () => ({ clearZeroReplyBrakeForInstance: vi.fn(async () => { }) }));
vi.mock("@/app/api/agent/process/route", () => ({
  POST: vi.fn(async (req: NextRequest) => {
    const body = await req.json();
    state.agentProcessCalls.push(body);
    return Response.json({ success: true });
  }),
}));

function signedReq(body: Record<string, unknown>): NextRequest {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", "secret-a").update(raw, "utf8").digest("hex");
  return new NextRequest("http://localhost/api/webhooks/whatsapp-cloud", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
}

describe("whatsapp-cloud — paridade operacional com Evolution", () => {
  beforeEach(() => {
    state.insertedLogs = [];
    state.agentProcessCalls = [];
    state.optOutResult = false;
    state.botActive = true;
    state.existingContact = null;
  });

  it("bloqueia disparo da IA e registra log com client_id e maskJid quando opt-out é detectado", async () => {
    state.optOutResult = true;
    const { POST } = await import("../route");
    const res = await POST(
      signedReq({
        object: "whatsapp_business_account",
        __parsed: {
          statuses: [],
          messages: [
            {
              phoneNumberId: "phone-a",
              messageId: "wamid-1",
              remoteJid: "5511999887766@s.whatsapp.net",
              from: "5511999887766",
              pushName: "Maria",
              type: "text",
              text: "PARAR",
              timestamp: 1700000000,
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(state.agentProcessCalls).toHaveLength(0);
    const rawLog = state.insertedLogs.find((l) => l.event === "CLOUD_WEBHOOK_RAW");
    expect(rawLog?.client_id).toBe("client-a");
    const optOutLog = state.insertedLogs.find((l) => l.event === "OPT_OUT_BLOCKED_AI");
    expect(optOutLog?.client_id).toBe("client-a");
    expect(JSON.stringify(optOutLog?.payload)).not.toContain("5511999887766");
  });

  it("unifica contato BR existente com/sem 9º dígito e mascara JID em AGENT_SKIP_PAUSED", async () => {
    state.botActive = false;
    state.existingContact = {
      id: "contact-9digit",
      remote_jid: "5511999887766@s.whatsapp.net",
      push_name: "João",
      phone_number: "5511999887766",
    };

    const { POST } = await import("../route");
    const res = await POST(
      signedReq({
        object: "whatsapp_business_account",
        __parsed: {
          statuses: [],
          messages: [
            {
              phoneNumberId: "phone-a",
              messageId: "wamid-2",
              // Meta Cloud enviou sem o 9º dígito
              remoteJid: "551199887766@s.whatsapp.net",
              from: "551199887766",
              pushName: "João",
              type: "text",
              text: "Oi",
              timestamp: 1700000001,
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    const skipLog = state.insertedLogs.find((l) => l.event === "AGENT_SKIP_PAUSED");
    expect(skipLog?.client_id).toBe("client-a");
    expect(JSON.stringify(skipLog?.payload)).not.toContain("5511999887766");
    expect(JSON.stringify(skipLog?.payload)).not.toContain("551199887766");
  });
});
