import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; eqs: Array<[string, unknown]>; limit?: number }>,
  writes: [] as Array<{ table: string; action: string; payload: unknown; eqs: Array<[string, unknown]> }>,
  rows: {} as Record<string, unknown>,
  from: vi.fn(),
  generateText: vi.fn(),
  sendMessage: vi.fn(),
  logTokenUsage: vi.fn(),
  registerPendingAutomatedSend: vi.fn(),
  registerAiSend: vi.fn(),
}));

function makeQuery(table: string) {
  const eqs: Array<[string, unknown]> = [];
  let limitVal: number | undefined;
  let singleMode = false;
  const query: Record<string, unknown> = {};
  for (const m of ["select", "order", "in", "gte", "gt", "lte", "lt", "neq", "not"]) {
    query[m] = vi.fn(() => query);
  }
  query.limit = vi.fn((n: number) => {
    limitVal = n;
    return query;
  });
  query.eq = vi.fn((col: string, val: unknown) => {
    eqs.push([col, val]);
    return query;
  });
  const resolveData = () => {
    state.queries.push({ table, eqs: [...eqs], limit: limitVal });
    const raw = state.rows[table];
    if (Array.isArray(raw)) {
      return { data: singleMode ? raw[0] ?? null : raw, error: null };
    }
    return { data: raw ?? null, error: null };
  };
  query.single = vi.fn(async () => {
    singleMode = true;
    return resolveData();
  });
  query.maybeSingle = vi.fn(async () => {
    singleMode = true;
    return resolveData();
  });
  query.insert = vi.fn((payload: unknown) => {
    state.writes.push({ table, action: "insert", payload, eqs });
    return query;
  });
  query.update = vi.fn((payload: unknown) => {
    state.writes.push({ table, action: "update", payload, eqs });
    return query;
  });
  query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(resolveData()).then(resolve, reject);
  return query;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: state.from },
}));
vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-provider")>();
  return { ...actual, generateText: state.generateText };
});
vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({ gemini: "gem-key", openrouter: null, nvidia: null, gatewayEndpoints: [] })),
}));
vi.mock("@/lib/ai-default-model", () => ({
  resolveModel: vi.fn(async (m: string | null) => m || null),
}));
vi.mock("@/lib/token-usage", () => ({
  logTokenUsage: state.logTokenUsage,
}));
vi.mock("@/lib/channel", () => ({
  sendMessage: state.sendMessage,
}));
vi.mock("@/lib/manual-send-registry", () => ({
  registerPendingAutomatedSend: state.registerPendingAutomatedSend,
  registerAiSend: state.registerAiSend,
}));
vi.mock("@/lib/campaign-worker", () => ({
  findOrCreateContactSession: vi.fn(async () => ({ sessionId: "sess-1" })),
  persistOutgoingMessage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tenant", () => ({
  isInstanceOwnedByClient: vi.fn(async () => true),
}));

import { invalidateHistorySummary, summarizeMiddleMessages } from "../history-summary";
import { sendOwnerAppointmentSummary } from "../owner-summary";
import { tickAutoPromote, tickReminders } from "../appointment-worker";

describe("Auditoria IA — history-summary, owner-summary e appointment-worker", () => {
  beforeEach(() => {
    state.queries = [];
    state.writes = [];
    state.rows = {};
    state.from.mockImplementation((table: string) => makeQuery(table));
    state.generateText.mockReset();
    state.sendMessage.mockReset();
    state.logTokenUsage.mockReset();
    state.registerPendingAutomatedSend.mockReset();
    state.registerAiSend.mockReset();
    invalidateHistorySummary("tenant-1", "5511999999999@s.whatsapp.net");
  });

  it("history-summary: curto-circuita < 4 mensagens sem gastar IA e registra logTokenUsage quando sumariza", async () => {
    const shortMiddle = [
      { sender_type: "customer", content: "Meu nome é Marcos" },
      { sender_type: "ai", content: "Prazer Marcos, como posso ajudar?" },
    ];
    const shortRes = await summarizeMiddleMessages("tenant-1", "5511999999999@s.whatsapp.net", shortMiddle);
    expect(shortRes).toContain("Marcos");
    expect(state.generateText).not.toHaveBeenCalled();

    state.generateText.mockResolvedValue({
      text: "Marcos pediu orçamento do plano Pro.",
      provider: "gemini",
      modelUsed: "gemini-2.5-flash",
      usage: { promptTokens: 120, completionTokens: 18, totalTokens: 138, cachedTokens: 40, costUsd: 0.0001 },
    });
    const fiveMsgs = [
      { sender_type: "customer", content: "Oi" },
      { sender_type: "ai", content: "Olá" },
      { sender_type: "customer", content: "Sou Marcos" },
      { sender_type: "ai", content: "Qual plano busca?" },
      { sender_type: "customer", content: "Plano Pro" },
    ];
    const longRes = await summarizeMiddleMessages("tenant-1", "5511999999999@s.whatsapp.net", fiveMsgs, {
      sessionId: "sess-1",
      sessionVariables: { existente: "ok" },
    });
    expect(longRes).toBe("Marcos pediu orçamento do plano Pro.");
    // Garante flush da microtask de logTokenUsage
    await new Promise((r) => setTimeout(r, 15));
    expect(state.logTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "tenant-1",
        cachedTokens: 40,
        costUsd: 0.0001,
        sourceLabel: "Resumo de histórico (agente)",
      }),
    );
  });

  it("owner-summary: filtra chats_dashboard por client_id, usa limite enxuto (16) e registra registerAiSend", async () => {
    state.rows.chats_dashboard = [
      { sender_type: "customer", content: "Quero marcar quinta às 14h", created_at: new Date().toISOString() },
    ];
    state.generateText.mockResolvedValue({
      text: "Cliente pediu horário quinta às 14h.",
      provider: "gemini",
      modelUsed: "gemini-2.5-flash",
      usage: { promptTokens: 90, completionTokens: 15, totalTokens: 105 },
    });
    state.sendMessage.mockResolvedValue({ ok: true, messageId: "owner-msg-77" });

    await sendOwnerAppointmentSummary({
      kind: "agendamento",
      agentConfig: {
        scheduler_config: {
          owner_summary_enabled: true,
          owner_phone: "5511988887777",
        },
      },
      clientId: "tenant-owner",
      remoteJid: "5511999999999@s.whatsapp.net",
      instanceName: "inst-a",
      appointment: { title: "Reunião", start_at: new Date().toISOString() },
    });

    const chatQ = state.queries.find((q) => q.table === "chats_dashboard");
    expect(chatQ?.eqs).toContainEqual(["client_id", "tenant-owner"]);
    expect(chatQ?.limit).toBe(16);
    expect(state.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 350, reasoningMode: 0 }),
    );
    expect(state.registerPendingAutomatedSend).toHaveBeenCalledWith(
      "inst-a",
      "5511988887777@s.whatsapp.net",
      expect.stringContaining("Cliente pediu horário"),
    );
    expect(state.registerAiSend).toHaveBeenCalledWith("owner-msg-77");
  });

  it("appointment-worker: cacheia agent_settings no tick, registra registerAiSend e grava historico_ia_leads válido", async () => {
    const startSoon = new Date(Date.now() + 20 * 60_000).toISOString();
    state.rows.appointments = [
      {
        id: "a1",
        client_id: "tenant-w",
        agent_id: 5,
        lead_id: null,
        remote_jid: "5511911111111@s.whatsapp.net",
        instance_name: "inst-w",
        title: "Consulta 1",
        service_name: "Avaliação",
        start_at: startSoon,
        end_at: startSoon,
        status: "confirmed",
        reminders_sent: [],
        google_event_id: null,
        metadata: {},
      },
      {
        id: "a2",
        client_id: "tenant-w",
        agent_id: 5,
        lead_id: null,
        remote_jid: "5511922222222@s.whatsapp.net",
        instance_name: "inst-w",
        title: "Consulta 2",
        service_name: "Avaliação",
        start_at: startSoon,
        end_at: startSoon,
        status: "confirmed",
        reminders_sent: [],
        google_event_id: null,
        metadata: {},
      },
    ];
    state.rows.agent_settings = {
      scheduler_config: {
        reminders: [{ offset_minutes: 60, message: "Lembrete {servico}" }],
      },
    };
    state.sendMessage.mockResolvedValue({ ok: true, messageId: "rem-msg-1" });

    const res = await tickReminders();
    expect(res.sent).toBe(2);
    // Dois appointments com agent_id=5 fazem APENAS 1 consulta em agent_settings dentro do tick
    expect(state.queries.filter((q) => q.table === "agent_settings")).toHaveLength(1);
    expect(state.registerAiSend).toHaveBeenCalledWith("rem-msg-1");

    // Agora testa tickAutoPromote com historico_ia_leads schema válido e escopo de client_id
    state.queries = [];
    state.writes = [];
    const endedAgo = new Date(Date.now() - 90 * 60_000).toISOString();
    state.rows.appointments = [
      {
        id: "a3",
        client_id: "tenant-w",
        agent_id: 5,
        lead_id: 99,
        remote_jid: "5511933333333@s.whatsapp.net",
        status: "confirmed",
        end_at: endedAgo,
      },
    ];
    state.rows.agent_settings = {
      scheduler_config: { auto_promote_kanban_after_minutes: 30, auto_promote_to_status: "atendido" },
    };
    state.rows.kanban_columns = [{ status_key: "atendido", label: "Atendido", order_index: 3 }];

    const promo = await tickAutoPromote();
    expect(promo.promoted).toBe(1);

    const claimUpd = state.writes.find((w) => w.table === "appointments" && w.action === "update");
    expect(claimUpd?.eqs).toContainEqual(["client_id", "tenant-w"]);

    const histInsert = state.writes.find((w) => w.table === "historico_ia_leads" && w.action === "insert");
    expect(histInsert?.payload).toEqual(
      expect.objectContaining({
        client_id: "tenant-w",
        remote_jid: "5511933333333@s.whatsapp.net",
        status_novo: "atendido",
        razao: expect.any(String),
        resumo: expect.any(String),
        batch_id: "appt-promote-a3",
      }),
    );
    expect(histInsert?.payload).not.toHaveProperty("justificativa");
  });
});
