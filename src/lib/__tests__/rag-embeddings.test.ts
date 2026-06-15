/**
 * Testes determinísticos do RAG multi-provedor (rag.ts) — embeddings.
 * Garante que, ao trocar o modelo de embeddings (Gemini ⇄ OpenRouter), o vetor
 * SEMPRE sai em 768 dims (a coluna do banco), ou falha com erro claro — nunca
 * grava lixo que quebraria a busca.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ragModel: "gemini-embedding-001",
  keys: { gemini: "AIza", openrouter: "sk-or" } as { gemini: string | null; openrouter: string | null },
  geminiBatchImpl: (..._a: any[]) => ({ embeddings: [] }) as any,
  geminiSingleImpl: (..._a: any[]) => ({ embedding: { values: [] } }) as any,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { value: h.ragModel } }) }),
      }),
    }),
  },
}));

vi.mock("@/lib/ai-keys", () => ({ getAiKeys: async () => h.keys }));

vi.mock("@google/generative-ai", () => ({
  SchemaType: {},
  GoogleGenerativeAI: class {
    constructor(_k: string) {}
    getGenerativeModel() {
      return {
        batchEmbedContents: (...a: any[]) => h.geminiBatchImpl(...a),
        embedContent: (...a: any[]) => h.geminiSingleImpl(...a),
      };
    }
  },
}));

const vec768 = () => Array.from({ length: 768 }, (_, i) => i / 768);
const vec1536 = () => Array.from({ length: 1536 }, () => 0.1);

let fetchMock: any;
beforeEach(async () => {
  vi.resetModules();
  h.ragModel = "gemini-embedding-001";
  h.keys = { gemini: "AIza", openrouter: "sk-or" };
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("embeddings Gemini", () => {
  it("indexa em batch e valida 768 dims", async () => {
    h.ragModel = "gemini-embedding-001";
    h.geminiBatchImpl = () => ({ embeddings: [{ values: vec768() }, { values: vec768() }] });
    const { embedTexts } = await import("../rag");
    const out = await embedTexts(["a", "b"], "AIza");
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(768);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejeita dimensão errada do Gemini (defesa)", async () => {
    h.geminiBatchImpl = () => ({ embeddings: [{ values: vec1536() }] });
    const { embedTexts } = await import("../rag");
    await expect(embedTexts(["a"], "AIza")).rejects.toThrow(/dim errada/i);
  });

  it("embedQuery Gemini devolve o vetor", async () => {
    h.geminiSingleImpl = () => ({ embedding: { values: vec768() } });
    const { embedQuery } = await import("../rag");
    const v = await embedQuery("pergunta", "AIza");
    expect(v).toHaveLength(768);
  });
});

describe("embeddings OpenRouter", () => {
  beforeEach(() => { h.ragModel = "openrouter:openai/text-embedding-3-small"; });

  it("manda dimensions:768 e o model sem prefixo; devolve na ordem certa", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        data: [
          { index: 1, embedding: vec768() },
          { index: 0, embedding: vec768() },
        ],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
    });
    const { embedTexts } = await import("../rag");
    const out = await embedTexts(["t0", "t1"]);
    expect(out).toHaveLength(2);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/embeddings");
    expect(opts.headers.Authorization).toBe("Bearer sk-or");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("openai/text-embedding-3-small"); // sem prefixo
    expect(body.dimensions).toBe(768);
    expect(body.input).toEqual(["t0", "t1"]);
  });

  it("modelo OpenRouter que devolve dim ≠ 768 → erro claro (não grava lixo)", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [{ index: 0, embedding: vec1536() }], usage: {} }),
    });
    const { embedTexts } = await import("../rag");
    await expect(embedTexts(["a"])).rejects.toThrow(/768 dimensões|dim errada/i);
  });

  it("sem chave OpenRouter → erro claro", async () => {
    h.keys = { gemini: "AIza", openrouter: null };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const { embedTexts } = await import("../rag");
    await expect(embedTexts(["a"])).rejects.toThrow(/OpenRouter/i);
  });

  it("erro HTTP da API vira exceção", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: "invalid key" } }) });
    const { embedTexts } = await import("../rag");
    await expect(embedTexts(["a"])).rejects.toThrow(/invalid key/i);
  });
});
