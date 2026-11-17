import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  writes: [] as Array<{ table: string; action: string; payload: Record<string, unknown>; eqs: Array<[string, unknown]> }>,
  from: vi.fn(),
  hasInternalSecret: vi.fn(),
  requireClientId: vi.fn(),
  startAiChat: vi.fn(),
  logTokenUsage: vi.fn(),
  sendMessage: vi.fn(),
  sendMedia: vi.fn(),
  searchKnowledge: vi.fn(),
  calendarEventsList: vi.fn(),
  getOAuthClient: vi.fn(),
}));

function queryFor(table: string) {
  const filters: Array<[string, unknown]> = [];
  const result = () => {
    const rows = state.rows[table] ?? null;
    if (table === "agent_settings") {
      const agents = Array.isArray(rows) ? rows : rows ? [rows] : [];
      return {
        data: agents.find((row: Record<string, unknown>) => filters.every(([col, val]) => row[col] === val)) ?? null,
        error: null,
      };
    }
    return { data: rows, error: null };
  };
  const query: Record<string, unknown> = {};
  for (const method of ["select", "order", "limit", "in", "gte", "gt", "lte", "lt", "neq", "ilike", "or", "not"]) {
    query[method] = vi.fn(() => query);
  }
  query.eq = vi.fn((col: string, val: unknown) => {
    filters.push([col, val]);
    return query;
  });
  query.single = vi.fn(async () => result());
  query.maybeSingle = vi.fn(async () => result());
  query.delete = vi.fn(() => query);
  query.insert = vi.fn((payload: Record<string, unknown>) => {
    state.writes.push({ table, action: "insert", payload, eqs: filters });
    return Promise.resolve({ data: null, error: null });
  });
  query.update = vi.fn((payload: Record<string, unknown>) => {
    state.writes.push({ table, action: "update", payload, eqs: filters });
    return query;
  });
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return query;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: state.from },
}));
vi.mock("@/lib/tenant", () => ({ requireClientId: state.requireClientId }));
vi.mock("@/lib/internal-auth", () => ({ hasInternalSecret: state.hasInternalSecret }));
vi.mock("@/lib/evolution", () => ({
  getEvolutionConfig: vi.fn(async () => ({ instance: "inst-a" })),
}));
vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({ gemini: "test-gem", openrouter: null, nvidia: null })),
}));
vi.mock("@/lib/ai-default-model", () => ({
  resolveModel: vi.fn(async () => "gemini-2.5-flash"),
  mapModelAsync: vi.fn(async (model: string) => model),
}));
vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-provider")>();
  return { ...actual, startAiChat: state.startAiChat };
});
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: state.logTokenUsage }));
vi.mock("@/lib/channel", () => ({
  sendMessage: state.sendMessage,
  sendMedia: state.sendMedia,
}));
vi.mock("@/lib/rag", () => ({
  searchKnowledge: state.searchKnowledge,
  indexKnowledgeDocument: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/google-calendar", () => ({
  getOAuthClientForAgentOptions: state.getOAuthClient,
}));
vi.mock("googleapis", () => ({
  google: {
    calendar: vi.fn(() => ({
      events: { list: state.calendarEventsList },
    })),
  },
}));

import { POST } from "../../app/api/agent/process/route";

const CLIENT_A = "00000000-0000-0000-0000-00000000a001";
const USAGE = { promptTokens: 20, completionTokens: 10, totalTokens: 30 };

function baseAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    client_id: CLIENT_A,
    name: "Sarah SDR",
    is_active: true,
    is_24h: true,
    disable_groups: false,
    main_prompt: "Atenda com excelência.",
    role: "SDR",
    personality: "direta",
    tone: "profissional",
    target_model: "gemini-2.5-flash",
    options: {},
    ...overrides,
  };
}

function makeReq(body: Record<string, unknown>, isTest = true): NextRequest {
  return new Request("http://localhost/api/agent/process", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(isTest ? { "x-test-agent-id": "7" } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("Auditoria IA — regressões /api/agent/process", () => {
  beforeEach(() => {
    state.rows = {
      channel_connections: { agent_id: 7, client_id: CLIENT_A },
      agent_settings: baseAgent(),
      agent_stages: [],
      agent_knowledge: [],
      chats_dashboard: [],
      leads_extraidos: null,
      contacts: null,
      sessions: null,
      appointments: [],
    };
    state.writes = [];
    state.from.mockImplementation((table: string) => queryFor(table));
    state.hasInternalSecret.mockReturnValue(false);
    state.requireClientId.mockResolvedValue({ ok: true, clientId: CLIENT_A });
    state.sendMessage.mockResolvedValue({ ok: true, messageId: "msg-out-1" });
    state.sendMedia.mockResolvedValue({ ok: true, messageId: "media-out-1" });
    state.searchKnowledge.mockResolvedValue([]);
    state.calendarEventsList.mockResolvedValue({ data: { items: [] } });
    state.getOAuthClient.mockResolvedValue({});
  });

  it("B5: repassa reasoning_mode = 3 (Think Máximo) integralmente para startAiChat", async () => {
    state.rows.agent_settings = baseAgent({ options: { reasoning_mode: 3 } });
    state.startAiChat.mockResolvedValue({
      provider: "gemini",
      modelUsed: () => "gemini-2.5-flash",
      sendUser: vi.fn().mockResolvedValue({ text: "Resposta com think máximo", toolCalls: [], usage: USAGE }),
      sendToolResults: vi.fn(),
    });

    const res = await POST(makeReq({ instanceName: "inst-a", remoteJid: "5511999999999@s.whatsapp.net", text: "Olá", isTestMode: true }));
    expect(res.status).toBe(200);
    expect(state.startAiChat).toHaveBeenCalledWith(expect.objectContaining({ reasoningMode: 3 }));
  });

  it("B7: remove tag [IMAGEM: ...] alucinada e preserva URLs válidas vindas do RAG", async () => {
    state.rows.agent_knowledge = [{ id: "kb-1", title: "Catálogo iPhones", content: "### PRODUTO: iPhone 15\n[IMAGEM: https://cdn.loja.test/iphone15.jpg]" }];
    state.searchKnowledge.mockResolvedValue([
      { title: "Catálogo iPhones", content: "iPhone 15 [IMAGEM: https://cdn.loja.test/iphone15.jpg]", similarity: 0.91 },
    ]);

    const sendUser = vi.fn().mockResolvedValue({
      text: "",
      toolCalls: [{ id: "c1", name: "search_knowledge_base", args: { query: "iphone 15" } }],
      usage: USAGE,
    });
    const sendToolResults = vi.fn().mockResolvedValue({
      text: "Veja a foto real:\n[IMAGEM: https://cdn.loja.test/iphone15.jpg]\nE ignore esta falsa:\n[IMAGEM: https://evil.test/alucinada.png]",
      toolCalls: [],
      usage: USAGE,
    });
    state.startAiChat.mockResolvedValue({
      provider: "gemini",
      modelUsed: () => "gemini-2.5-flash",
      sendUser,
      sendToolResults,
    });

    const res = await POST(makeReq({ instanceName: "inst-a", remoteJid: "5511999999999@s.whatsapp.net", text: "Tem foto do iPhone 15?", isTestMode: true }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.text).toContain("[IMAGEM: https://cdn.loja.test/iphone15.jpg]");
    expect(json.text).not.toContain("https://evil.test/alucinada.png");
  });

  it("T1: mantém systemInstruction byte-idêntico entre leads distintos e envia variáveis no <prompt_variables>", async () => {
    state.rows.agent_settings = baseAgent({
      main_prompt: "Olá, atenda a empresa {{nome_empresa}} do ramo {{ramo}} com simpatia.",
    });

    const capturedSys: string[] = [];
    const capturedUsers: string[] = [];
    state.startAiChat.mockImplementation(async (opts: { systemInstruction: string }) => {
      capturedSys.push(opts.systemInstruction);
      return {
        provider: "gemini",
        modelUsed: () => "gemini-2.5-flash",
        sendUser: async (msg: string) => {
          capturedUsers.push(msg);
          return { text: "Oi!", toolCalls: [], usage: USAGE };
        },
        sendToolResults: vi.fn(),
      };
    });

    await POST(makeReq({
      instanceName: "inst-a",
      remoteJid: "5511911111111@s.whatsapp.net",
      text: "Oi",
      isTestMode: true,
      testLeadData: { nome_negocio: "Padaria Alfa", ramo_negocio: "Alimentação" },
    }));

    await POST(makeReq({
      instanceName: "inst-a",
      remoteJid: "5511922222222@s.whatsapp.net",
      text: "Oi",
      isTestMode: true,
      testLeadData: { nome_negocio: "Oficina Beta", ramo_negocio: "Automotivo" },
    }));

    expect(capturedSys).toHaveLength(2);
    expect(capturedSys[0]).toBe(capturedSys[1]);
    expect(capturedSys[0]).toContain("{{nome_empresa}}");
    expect(capturedSys[0]).not.toContain("Padaria Alfa");
    expect(capturedUsers[0]).toContain("<prompt_variables>");
    expect(capturedUsers[0]).toContain("Padaria Alfa");
    expect(capturedUsers[1]).toContain("Oficina Beta");
  });

  it("T2 & T3: suprime update_product_stock e agendar_reuniao_fechamento em agentes FAQ sem catálogo nem prévia de site", async () => {
    state.rows.agent_knowledge = [{ id: "kb-faq", title: "FAQ da Clínica", content: "Atendemos planos Unimed e particular." }];
    state.rows.agent_settings = baseAgent({ options: { site_preview_auto_detect: false } });

    let toolNames: string[] = [];
    let sysPrompt = "";
    state.startAiChat.mockImplementation(async (opts: { tools: Array<{ name: string }>; systemInstruction: string }) => {
      toolNames = opts.tools.map((t) => t.name);
      sysPrompt = opts.systemInstruction;
      return {
        provider: "gemini",
        modelUsed: () => "gemini-2.5-flash",
        sendUser: async () => ({ text: "Atendemos Unimed.", toolCalls: [], usage: USAGE }),
        sendToolResults: vi.fn(),
      };
    });

    await POST(makeReq({ instanceName: "inst-a", remoteJid: "5511999999999@s.whatsapp.net", text: "Aceita Unimed?", isTestMode: true }));

    expect(toolNames).toContain("search_knowledge_base");
    expect(toolNames).not.toContain("update_product_stock");
    expect(toolNames).not.toContain("solicitar_previa_site");
    expect(toolNames).not.toContain("agendar_reuniao_fechamento");
    expect(sysPrompt).not.toContain("iPhone 15 128GB");
  });

  it("B4: envia away_message via channel.sendMessage antes do buffer quando fora do horário", async () => {
    state.hasInternalSecret.mockReturnValue(true);
    state.rows.agent_settings = baseAgent({
      is_24h: false,
      schedules: [], // lista vazia => fora do expediente em checkSchedulesSync
      away_message: "Voltamos amanhã às 08h!",
      options: { message_buffer_seconds: 60 },
    });
    state.rows.sessions = { id: "sess-1", bot_status: "bot_active", variables: {}, current_stage_id: null, client_id: CLIENT_A };

    const t0 = Date.now();
    const res = await POST(makeReq({
      instanceName: "inst-a",
      sessionId: "sess-1",
      remoteJid: "5511999999999@s.whatsapp.net",
      text: "Oi",
      isTestMode: false,
    }, false));
    const json = await res.json();

    expect(Date.now() - t0).toBeLessThan(3000);
    expect(json).toEqual({ success: true, status: "out_of_office", away_sent: true });
    expect(state.sendMessage).toHaveBeenCalledWith("5511999999999@s.whatsapp.net", "Voltamos amanhã às 08h!", "inst-a");
    expect(state.writes.some((w) => w.table === "webhook_logs" && w.payload.event === "AGENT_STOP_HOURS" && w.payload.client_id === CLIENT_A)).toBe(true);
  });

  it("S1: list_google_calendar_events filtra estritamente por contato e oculta reuniões de terceiros", async () => {
    state.rows.agent_settings = baseAgent({
      options: { calendar_enabled: true, google_tokens: { refresh_token: "rt-1" } },
    });
    state.rows.appointments = [
      { google_event_id: "ev-meu", remote_jid: "5511999999999@s.whatsapp.net", client_id: CLIENT_A, status: "confirmed" },
      { google_event_id: "ev-outro", remote_jid: "5511888888888@s.whatsapp.net", client_id: CLIENT_A, status: "confirmed" },
    ];
    state.calendarEventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "ev-meu",
            summary: "Minha Reunião",
            start: { dateTime: "2026-11-20T14:00:00-03:00" },
            end: { dateTime: "2026-11-20T14:30:00-03:00" },
            attendees: [{ email: "cliente@meu.com" }],
          },
          {
            id: "ev-outro",
            summary: "Reunião Sigilosa Terceiro",
            start: { dateTime: "2026-11-20T15:00:00-03:00" },
            end: { dateTime: "2026-11-20T15:30:00-03:00" },
            attendees: [{ email: "terceiro@concorrente.com" }],
          },
        ],
      },
    });

    const sentToolResponses: unknown[] = [];
    state.startAiChat.mockResolvedValue({
      provider: "gemini",
      modelUsed: () => "gemini-2.5-flash",
      sendUser: vi.fn().mockResolvedValue({
        text: "",
        toolCalls: [{ id: "cal-1", name: "list_google_calendar_events", args: { date_from: "2026-11-20" } }],
        usage: USAGE,
      }),
      sendToolResults: vi.fn(async (results: Array<{ response: unknown }>) => {
        sentToolResponses.push(results[0].response);
        return { text: "Encontrei sua reunião às 14h.", toolCalls: [], usage: USAGE };
      }),
    });

    const res = await POST(makeReq({ instanceName: "inst-a", remoteJid: "5511999999999@s.whatsapp.net", text: "Quais meus horários?", isTestMode: true }));
    expect(res.status).toBe(200);

    const payload = sentToolResponses[0] as { found: boolean; events: Array<Record<string, unknown>> };
    expect(payload.found).toBe(true);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].id).toBe("ev-meu");
    expect(payload.events[0]).not.toHaveProperty("attendees");
  });

  it("Funil: complete_current_stage devolve próxima etapa e zera current_stage_id ao concluir a última", async () => {
    state.hasInternalSecret.mockReturnValue(true);
    state.rows.agent_stages = [
      { id: 10, title: "Triagem", goal_prompt: "Pergunte o objetivo.", order_index: 0, captured_variables: [] },
      { id: 20, title: "Agendamento", goal_prompt: "Ofereça dois horários.", order_index: 1, captured_variables: [] },
    ];
    state.rows.sessions = { id: "sess-f", bot_status: "bot_active", variables: {}, current_stage_id: 10, client_id: CLIENT_A };

    const stageResponses: unknown[] = [];
    const sendToolResults = vi
      .fn()
      .mockImplementationOnce(async (results: Array<{ response: unknown }>) => {
        stageResponses.push(results[0].response);
        return { text: "", toolCalls: [{ id: "st-2", name: "complete_current_stage", args: {} }], usage: USAGE };
      })
      .mockImplementationOnce(async (results: Array<{ response: unknown }>) => {
        stageResponses.push(results[0].response);
        return { text: "Tudo encaminhado!", toolCalls: [], usage: USAGE };
      });

    state.startAiChat.mockResolvedValue({
      provider: "gemini",
      modelUsed: () => "gemini-2.5-flash",
      sendUser: vi.fn().mockResolvedValue({
        text: "",
        toolCalls: [{ id: "st-1", name: "complete_current_stage", args: {} }],
        usage: USAGE,
      }),
      sendToolResults,
    });

    await POST(makeReq({
      instanceName: "inst-a",
      sessionId: "sess-f",
      remoteJid: "5511999999999@s.whatsapp.net",
      text: "Quero agendar logo",
      isTestMode: false,
    }, false));

    const firstAdvance = stageResponses[0] as { next_stage?: { title?: string } };
    expect(firstAdvance.next_stage?.title).toBe("Agendamento");

    const secondAdvance = stageResponses[1] as { funnel_completed?: boolean };
    expect(secondAdvance.funnel_completed).toBe(true);
    expect(state.writes.some((w) => w.table === "sessions" && w.action === "update" && w.payload.current_stage_id === null)).toBe(true);
  });

  it("suprime resposta quando filtro anti-alucinação de imagens remove o único conteúdo e localiza lead via alternateJid", async () => {
    state.rows.leads_extraidos = {
      id: 88,
      remoteJid: "5511988887777@s.whatsapp.net",
      nome_negocio: "Padaria Central",
      ramo_negocio: "Alimentação",
      status: "novo",
    };

    const capturedTurns: string[] = [];
    state.startAiChat.mockResolvedValue({
      provider: "gemini",
      modelUsed: () => "gemini-2.5-flash",
      sendUser: vi.fn(async (msg: string) => {
        capturedTurns.push(msg);
        return {
          text: "[IMAGEM: https://malicious-invented.example.com/fake.jpg]",
          toolCalls: [],
          usage: USAGE,
        };
      }),
      sendToolResults: vi.fn(),
    });

    const res = await POST(makeReq({
      instanceName: "inst-a",
      remoteJid: "998877665544@lid",
      alternateJid: "5511988887777@s.whatsapp.net",
      text: "Me manda a foto",
      isTestMode: false,
    }, false));

    // Confirmou lookup CRM via @lid + alternateJid e bloqueou envio vazio pós-sanitização de imagem
    const leadQuery = state.rows.leads_extraidos as { nome_negocio: string };
    expect(leadQuery.nome_negocio).toBe("Padaria Central");
    expect(capturedTurns[0]).toContain("Padaria Central");
    expect(await res.json()).toEqual({ success: true, ai_responded: false, suppressed: "empty_output" });
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.sendMedia).not.toHaveBeenCalled();
    expect(state.writes.some((w) => w.table === "webhook_logs" && w.payload.event === "AGENT_EMPTY_OUTPUT")).toBe(true);
  });
});
