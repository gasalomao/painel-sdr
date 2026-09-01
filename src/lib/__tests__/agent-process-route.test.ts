import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  writes: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  from: vi.fn(),
  requireClientId: vi.fn(),
  startAiChat: vi.fn(),
  logTokenUsage: vi.fn(),
  sendMessage: vi.fn(),
  sendMedia: vi.fn(),
}));

function queryFor(table: string) {
  const result = () => ({ data: state.rows[table] ?? null, error: null });
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "in", "gte", "gt", "lt", "neq", "ilike", "or"]) {
    query[method] = vi.fn(() => query);
  }
  query.single = vi.fn(async () => result());
  query.maybeSingle = vi.fn(async () => result());
  query.insert = vi.fn((payload: Record<string, unknown>) => {
    state.writes.push({ table, payload });
    return Promise.resolve({ data: null, error: null });
  });
  query.update = vi.fn((payload: Record<string, unknown>) => {
    state.writes.push({ table, payload });
    return query;
  });
  query.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result()).then(resolve, reject);
  return query;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: state.from },
}));
vi.mock("@/lib/tenant", () => ({ requireClientId: state.requireClientId }));
vi.mock("@/lib/internal-auth", () => ({ hasInternalSecret: vi.fn(() => false) }));
vi.mock("@/lib/evolution", () => ({
  getEvolutionConfig: vi.fn(async () => ({ instance: "fallback-instance" })),
}));
vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({ gemini: "test-key", openrouter: null })),
}));
vi.mock("@/lib/ai-default-model", () => ({
  resolveModel: vi.fn(async () => "gemini-test"),
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

import { POST } from "../../app/api/agent/process/route";
import { AiEmptyResponseError } from "../ai-provider";

const CLIENT_A = "00000000-0000-0000-0000-00000000a001";
const CLIENT_B = "00000000-0000-0000-0000-00000000b002";
const REMOTE_JID = "5511999999999@s.whatsapp.net";

function agentConfig(options: Record<string, unknown> = {}) {
  return {
    id: 7,
    client_id: CLIENT_A,
    name: "Agente Teste",
    is_active: true,
    disable_groups: false,
    main_prompt: "Atenda o cliente.",
    role: "SDR",
    personality: "objetiva",
    tone: "natural",
    target_model: "gemini-test",
    options,
  };
}

function request(instanceName = "inst-a") {
  return new Request("http://localhost/api/agent/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instanceName,
      remoteJid: REMOTE_JID,
      text: "oi",
      isTestMode: true,
    }),
  });
}

function webhookEvents() {
  return state.writes
    .filter((write) => write.table === "webhook_logs")
    .map((write) => write.payload.event);
}

beforeEach(() => {
  state.rows = {
    channel_connections: { agent_id: 7, client_id: CLIENT_A },
    agent_settings: agentConfig(),
    agent_stages: [],
    agent_knowledge: [],
  };
  state.writes = [];
  state.from.mockImplementation((table: string) => queryFor(table));
  state.requireClientId.mockResolvedValue({ ok: true, clientId: CLIENT_A });
  state.sendMessage.mockResolvedValue({ ok: true, messageId: "unexpected-send" });
  state.sendMedia.mockResolvedValue({ ok: true, messageId: "unexpected-media" });
});

describe("POST /api/agent/process", () => {
  it("bloqueia instância de outro tenant antes de gravar logs", async () => {
    state.rows.channel_connections = { agent_id: 7, client_id: CLIENT_B };

    const response = await POST(request("inst-b") as never);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Instância não vinculada a este cliente.",
    });
    expect(state.writes).toEqual([]);
    expect(state.startAiChat).not.toHaveBeenCalled();
    expect(state.logTokenUsage).not.toHaveBeenCalled();
  });

  it("suprime resposta vazia sem envio e espera a contabilização", async () => {
    const usage = { promptTokens: 10, completionTokens: 0, totalTokens: 10 };
    let finishUsage!: () => void;
    const usagePersisted = new Promise<void>((resolve) => { finishUsage = resolve; });
    state.logTokenUsage.mockReturnValueOnce(usagePersisted);
    state.startAiChat.mockResolvedValue({
      provider: "gemini",
      modelUsed: () => "gemini-test",
      sendUser: vi.fn().mockRejectedValue(new AiEmptyResponseError("gemini", "gemini-test", usage)),
      sendToolResults: vi.fn(),
    });

    let settled = false;
    const responsePromise = POST(request() as never).then((response) => {
      settled = true;
      return response;
    });
    await vi.waitFor(() => expect(state.logTokenUsage).toHaveBeenCalledTimes(1));

    expect(settled).toBe(false);
    finishUsage();
    const response = await responsePromise;

    expect(await response.json()).toEqual({
      success: true,
      ai_responded: false,
      suppressed: "empty_output",
    });
    expect(webhookEvents()).toContain("AGENT_EMPTY_OUTPUT");
    expect(webhookEvents()).not.toContain("AGENT_SEND_SUCCESS");
    expect(webhookEvents()).not.toContain("AGENT_CRITICAL_ERROR");
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.sendMedia).not.toHaveBeenCalled();
    expect(state.logTokenUsage).toHaveBeenCalledTimes(1);
    expect(state.logTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
      clientId: CLIENT_A,
      model: "gemini-test",
      promptTokens: 10,
      completionTokens: 0,
      totalTokens: 10,
    }));
  });

  it("suprime tool loop esgotado sem envio e contabiliza todos os turnos uma vez", async () => {
    state.rows.agent_settings = agentConfig({
      custom_tools: [{ name: "noop", description: "Teste", webhook_url: "https://example.com/noop" }],
    });
    const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
    const pendingTurn = (index: number) => ({
      text: "",
      toolCalls: [{ id: `call-${index}`, name: "noop", args: { query: "continue" } }],
      usage,
    });
    const sendToolResults = vi.fn();
    for (let index = 1; index <= 5; index++) {
      sendToolResults.mockResolvedValueOnce(pendingTurn(index));
    }
    state.startAiChat.mockResolvedValue({
      provider: "gemini",
      modelUsed: () => "gemini-test",
      sendUser: vi.fn().mockResolvedValue(pendingTurn(0)),
      sendToolResults,
    });

    const response = await POST(request() as never);

    expect(await response.json()).toEqual({
      success: true,
      ai_responded: false,
      suppressed: "tool_loop_exhausted",
    });
    expect(sendToolResults).toHaveBeenCalledTimes(5);
    expect(webhookEvents()).toContain("AGENT_TOOL_LOOP_EXHAUSTED");
    expect(webhookEvents()).not.toContain("AGENT_EMPTY_OUTPUT");
    expect(webhookEvents()).not.toContain("AGENT_SEND_SUCCESS");
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(state.sendMedia).not.toHaveBeenCalled();
    expect(state.logTokenUsage).toHaveBeenCalledTimes(1);
    expect(state.logTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: 60,
      completionTokens: 12,
      totalTokens: 72,
    }));
    expect(state.writes.find((write) => write.payload.event === "AGENT_TOOL_LOOP_EXHAUSTED")?.payload).toMatchObject({
      payload: { tool_iterations: 5, pending_tool_calls: 1 },
    });
  });

  it("não persiste fallback Gemini transitório como modelo do agente", async () => {
    state.startAiChat.mockResolvedValue({
      provider: "gemini",
      modelUsed: () => "gemini-fallback",
      sendUser: vi.fn().mockResolvedValue({
        text: "Resposta válida",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      }),
      sendToolResults: vi.fn(),
    });

    const response = await POST(request() as never);

    expect(await response.json()).toMatchObject({ success: true, ai_responded: true });
    expect(state.writes).not.toContainEqual(expect.objectContaining({
      table: "agent_settings",
      payload: { target_model: "gemini-fallback" },
    }));
  });
});
