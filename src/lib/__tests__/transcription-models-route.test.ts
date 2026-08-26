/**
 * Testes da rota /api/agent/transcription-models:
 *   - auth obrigatória (GET e POST)
 *   - agente de outro cliente → 404
 *   - POST faz read-modify-write preservando outras chaves do options
 *   - sanitização: strings ≤200, máx 10 itens
 *   - invalida cache do bot-status ao salvar
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown> | null;
let maybeSingleResult: { data: Row } = { data: null };
const updateCalls: Array<Record<string, unknown>> = [];

const chainForSelect = () => ({
  select: vi.fn(() => ({
    eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => maybeSingleResult) })),
  })),
});

vi.mock("@/lib/supabase_admin", () => {
  const adminClient = {
    from: vi.fn((table: string) => {
      if (table === "agent_settings") {
        return {
          ...chainForSelect(),
          update: vi.fn((payload: Record<string, unknown>) => {
            updateCalls.push(payload);
            return { eq: vi.fn(async () => ({ error: null })) };
          }),
        };
      }
      return chainForSelect();
    }),
  };
  return { supabaseAdmin: adminClient };
});
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => AUTH_RESULT),
}));
let AUTH_RESULT: any = { ok: true, clientId: "client-1", isAdmin: false };
vi.mock("@/lib/bot-status", () => ({
  getTranscriptionModels: vi.fn(async () => ["ja/salvo"]),
  invalidateTranscriptionModelsCache: vi.fn(),
}));

import { GET, POST } from "@/app/api/agent/transcription-models/route";
import { invalidateTranscriptionModelsCache } from "@/lib/bot-status";

function fakeReq(opts: { url: string; body?: unknown }): any {
  return {
    nextUrl: new URL(opts.url),
    json: async () => opts.body,
  } as any;
}

describe("/api/agent/transcription-models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateCalls.length = 0;
    maybeSingleResult = { data: null };
    AUTH_RESULT = { ok: true, clientId: "client-1", isAdmin: false };
  });

  it("GET sem auth → devolve a resposta de auth (401)", async () => {
    AUTH_RESULT = { ok: false, response: new Response(JSON.stringify({ error: "unauth" }), { status: 401 }) };
    const res = await GET(fakeReq({ url: "http://x/api/agent/transcription-models?agent_id=1" }));
    expect(res.status).toBe(401);
  });

  it("GET sem agent_id → 400", async () => {
    const res = await GET(fakeReq({ url: "http://x/api/agent/transcription-models" }));
    expect(res.status).toBe(400);
  });

  it("GET de agente de OUTRO cliente → 404", async () => {
    maybeSingleResult = { data: { id: 1, client_id: "outro-cliente" } };
    const res = await GET(fakeReq({ url: "http://x/api/agent/transcription-models?agent_id=1" }));
    expect(res.status).toBe(404);
  });

  it("GET feliz → models lidos", async () => {
    maybeSingleResult = { data: { id: 1, client_id: "client-1" } };
    const res = await GET(fakeReq({ url: "http://x/api/agent/transcription-models?agent_id=1" }));
    const json = await res.json();
    expect(json).toEqual({ success: true, models: ["ja/salvo"] });
  });

  it("POST de agente de outro cliente → 404 e NÃO salva", async () => {
    maybeSingleResult = { data: { id: 1, client_id: "outro" } };
    const res = await POST(fakeReq({ url: "http://x/api/agent/transcription-models", body: { agent_id: 1, models: ["m/a"] } }));
    expect(res.status).toBe(404);
    expect(updateCalls.length).toBe(0);
  });

  it("POST admin pode salvar agente de qualquer cliente", async () => {
    AUTH_RESULT = { ok: true, clientId: "admin", isAdmin: true };
    maybeSingleResult = { data: { id: 9, client_id: "qualquer", options: { gemini_api_key: "g" } } };
    const res = await POST(fakeReq({ url: "http://x/api/agent/transcription-models", body: { agent_id: 9, models: ["m/a"] } }));
    expect(res.status).toBe(200);
    expect(updateCalls[0]?.options).toMatchObject({
      gemini_api_key: "g",           // preservado
      transcription_models: ["m/a"], // adicionado
    });
  });

  it("POST feliz: merge preserva outras chaves do options + invalida cache", async () => {
    maybeSingleResult = { data: { id: 1, client_id: "client-1", options: { gemini_api_key: "g", openrouter_api_key: "o" } } };
    const res = await POST(fakeReq({ url: "http://x/api/agent/transcription-models", body: { agent_id: 1, models: ["m/a", "m/b"] } }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(updateCalls[0]?.options).toEqual({
      gemini_api_key: "g",
      openrouter_api_key: "o",
      transcription_models: ["m/a", "m/b"],
    });
    expect(vi.mocked(invalidateTranscriptionModelsCache)).toHaveBeenCalledWith(1);
  });

  it("POST sanitiza: corta strings longas, máx 10, remove vazios", async () => {
    maybeSingleResult = { data: { id: 1, client_id: "client-1", options: {} } };
    const long = "x".repeat(500);
    const models = [long, "", "   ", null, ...Array.from({ length: 12 }, (_, i) => `m/${i}`)];
    await POST(fakeReq({ url: "http://x/api/agent/transcription-models", body: { agent_id: 1, models } }));
    const saved = (updateCalls[0]?.options as any).transcription_models;
    expect(saved.length).toBe(10);
    expect(saved.every((s: string) => s.length <= 200)).toBe(true);
    expect(saved.some((s: string) => s.trim() === "")).toBe(false);
  });

  it("POST com body não-JSON → 400", async () => {
    const req = fakeReq({ url: "http://x/api/agent/transcription-models" });
    (req as any).json = async () => { throw new Error("bad json"); };
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("POST models não-array → salva [] (volta ao padrão grátis-primeiro)", async () => {
    maybeSingleResult = { data: { id: 1, client_id: "client-1", options: { gemini_api_key: "g" } } };
    const res = await POST(fakeReq({ url: "http://x/api/agent/transcription-models", body: { agent_id: 1, models: "lixo" } }));
    expect(res.status).toBe(200);
    expect((updateCalls[0]?.options as any).transcription_models).toEqual([]);
  });
});
