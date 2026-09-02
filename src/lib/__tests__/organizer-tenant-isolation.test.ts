import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queries: [] as Array<{
    table: string;
    calls: Array<{ method: string; args: unknown[] }>;
    operation: string | null;
    payload: unknown;
  }>,
  requireClientId: vi.fn(),
  hasInternalSecret: vi.fn(),
  from: vi.fn(),
  deleteData: [{ id: 1 }] as Array<{ id: number }>,
}));

const CLIENT_ID = "00000000-0000-0000-0000-00000000a001";
const REMOTE_JID = "5511999999999@s.whatsapp.net";

function resultFor(query: (typeof mocks.queries)[number]) {
  if (query.operation === "delete") return { data: mocks.deleteData, error: null };
  if (query.operation) return { data: null, error: null };
  const selected = query.calls.find((call) => call.method === "select")?.args[0];
  if (query.table === "chats_dashboard" && selected === "*") {
    return {
      data: [{
        id: 1,
        remote_jid: REMOTE_JID,
        is_from_me: false,
        sender_type: "client",
        content: "não tenho interesse",
        created_at: new Date().toISOString(),
      }],
      error: null,
    };
  }
  if (query.table === "leads_extraidos") {
    return {
      data: [{
        remoteJid: REMOTE_JID,
        status: "novo",
        nome_negocio: "Lead A",
        primeiro_contato_source: "webhook",
        primeiro_contato_at: null,
        created_at: new Date().toISOString(),
        last_analysis_hash: null,
        lead_type: "novo",
        client_id: CLIENT_ID,
      }],
      error: null,
    };
  }
  if (query.table === "kanban_columns") {
    return {
      data: [
        { status_key: "novo", label: "Novo", order_index: 0, is_terminal: false },
        { status_key: "sem_interesse", label: "Sem interesse", order_index: 1, is_terminal: true },
      ],
      error: null,
    };
  }
  return { data: [], error: null };
}

function queryFor(table: string) {
  const query = {
    table,
    calls: [] as Array<{ method: string; args: unknown[] }>,
    operation: null as string | null,
    payload: undefined as unknown,
  };
  mocks.queries.push(query);
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "in", "gte", "gt", "lt"]) {
    builder[method] = vi.fn((...args: unknown[]) => {
      query.calls.push({ method, args });
      return builder;
    });
  }
  for (const method of ["insert", "update", "upsert", "delete"]) {
    builder[method] = vi.fn((payload?: unknown) => {
      query.operation = method;
      query.payload = payload;
      query.calls.push({ method, args: payload === undefined ? [] : [payload] });
      return builder;
    });
  }
  builder.single = vi.fn(async () => query.table === "ai_organizer_runs"
    ? { data: { id: 77 }, error: null }
    : resultFor(query));
  builder.maybeSingle = vi.fn(async () => {
    if (query.table === "clients") return { data: { organizer_enabled: true, organizer_prompt: null }, error: null };
    return { data: null, error: null };
  });
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(resultFor(query)).then(resolve, reject);
  return builder;
}

vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: mocks.from },
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/tenant", () => ({ requireClientId: mocks.requireClientId }));
vi.mock("@/lib/internal-auth", () => ({ hasInternalSecret: mocks.hasInternalSecret }));
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: vi.fn() }));
vi.mock("@/lib/ai-provider", () => ({ providerOf: vi.fn(() => "gemini") }));

import { DELETE, GET } from "@/app/api/organizer/history/route";
import { POST } from "@/app/api/ai-organize/route";

function request(url: string, init?: RequestInit) {
  return {
    nextUrl: new URL(url),
    json: async () => JSON.parse(String(init?.body || "{}")),
  } as never;
}

function expectClientFilter(query: (typeof mocks.queries)[number]) {
  expect(query.calls).toContainEqual({ method: "eq", args: ["client_id", CLIENT_ID] });
}

beforeEach(() => {
  mocks.queries.length = 0;
  mocks.deleteData = [{ id: 1 }];
  mocks.from.mockImplementation((table: string) => queryFor(table));
  mocks.requireClientId.mockResolvedValue({
    ok: true,
    clientId: CLIENT_ID,
    isAdmin: false,
    impersonating: true,
    claims: {},
  });
  mocks.hasInternalSecret.mockReturnValue(false);
});

describe("GET /api/organizer/history", () => {
  it("filtra histórico e runs diretamente pelo tenant impersonado", async () => {
    const response = await GET(request("http://localhost/api/organizer/history"));

    expect(response.status).toBe(200);
    expectClientFilter(mocks.queries.find((query) => query.table === "historico_ia_leads")!);
    expectClientFilter(mocks.queries.find((query) => query.table === "ai_organizer_runs")!);
    expect(mocks.from).not.toHaveBeenCalledWith("leads_extraidos");
  });

  it("mantém a visão global para admin real", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: CLIENT_ID,
      isAdmin: true,
      impersonating: false,
      claims: {},
    });

    await GET(request("http://localhost/api/organizer/history"));

    for (const query of mocks.queries.filter((item) => ["historico_ia_leads", "ai_organizer_runs"].includes(item.table))) {
      expect(query.calls).not.toContainEqual({ method: "eq", args: ["client_id", CLIENT_ID] });
    }
  });
});

describe("DELETE /api/organizer/history", () => {
  it("filtra por id e client_id e retorna a contagem real", async () => {
    mocks.deleteData = [];

    const response = await DELETE(request("http://localhost/api/organizer/history?id=9"));
    const query = mocks.queries.find((item) => item.table === "historico_ia_leads")!;

    expect(query.calls).toContainEqual({ method: "eq", args: ["id", 9] });
    expectClientFilter(query);
    expect(query.calls.some((call) => call.method === "in")).toBe(false);
    expect(await response.json()).toEqual({ ok: true, deleted: 0 });
  });

  it("limpa somente o tenant e retorna quantos registros apagou", async () => {
    mocks.deleteData = [{ id: 1 }, { id: 2 }];

    const response = await DELETE(request("http://localhost/api/organizer/history"));
    const query = mocks.queries.find((item) => item.table === "historico_ia_leads")!;

    expectClientFilter(query);
    expect(await response.json()).toEqual({ ok: true, deleted: 2 });
  });
});

describe("POST /api/ai-organize", () => {
  it("escopa runs, histórico recente, pré-histórico e inserts pelo clientId", async () => {
    const response = await POST(request("http://localhost/api/ai-organize", {
      method: "POST",
      body: JSON.stringify({
        apiKey: "test-key",
        model: "gemini-test",
        provider: "Gemini",
        clientId: CLIENT_ID,
      }),
    }));

    expect(response.status).toBe(200);
    const runInsert = mocks.queries.find((query) => query.table === "ai_organizer_runs" && query.operation === "insert")!;
    expect(runInsert.payload).toMatchObject({ client_id: CLIENT_ID });

    const runUpdate = mocks.queries.find((query) => query.table === "ai_organizer_runs" && query.operation === "update")!;
    expectClientFilter(runUpdate);

    const recentChanges = mocks.queries.find((query) =>
      query.table === "historico_ia_leads" && query.operation === null
    )!;
    expectClientFilter(recentChanges);

    const preHistory = mocks.queries.find((query) =>
      query.table === "chats_dashboard" && query.calls.some((call) => call.method === "lt")
    )!;
    expectClientFilter(preHistory);

    const historyInsert = mocks.queries.find((query) =>
      query.table === "historico_ia_leads" && query.operation === "insert"
    )!;
    expect(historyInsert.payload).toEqual([
      expect.objectContaining({ client_id: CLIENT_ID, remote_jid: REMOTE_JID }),
    ]);
  });
});
