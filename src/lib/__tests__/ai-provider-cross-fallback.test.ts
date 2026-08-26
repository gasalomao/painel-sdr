/**
 * ESCADA DE FALLBACK CROSS-PROVIDER — o "nunca quebra" de verdade.
 *
 * Cobertura (contrato: só falha quando NENHUMA conta/provider atende):
 *  - generateText: provider pedido morre com erro de CONTA (quota/429/auth/
 *    rede) → tenta rungs de outros providers configurados.
 *  - startAiChat: idem, migrando a SESSÃO no 1º turno.
 *  - Erro de REQUEST (400 puro) NÃO sobe a escada — outro provider daria o
 *    mesmo erro.
 *  - noGatewayFallback (passos de combo) → escada desligada, cascata manda.
 *
 * Sem rede real: fetch, @google/generative-ai e ai-keys mockados.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateText, startAiChat } from "../ai-provider";
import { resetGatewayCooldown } from "../gateway-cooldown";
import { invalidateGatewayModelsCache } from "../gateway-model-discovery";

const st = vi.hoisted(() => ({
  keys: null as any,
  /** Respostas do POST /chat/completions do OpenRouter: fila de resultados. */
  orQueue: [] as Array<{ status: number; content?: string; msg?: string }>,
  orCalls: 0,
  /** Se true, generateContent/sendMessage do Gemini lançam erro de quota. */
  geminiFails: false,
  geminiCalls: 0,
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: async () => st.keys,
  invalidateAiKeysCache: () => {},
}));

vi.mock("@/lib/gateway-proxy-manager", () => ({
  ensureProxyRunning: async () => ({ running: true, installed: true }),
}));

vi.mock("@/lib/gemini-model-discovery", async () => {
  const actual: any = await vi.importActual("@/lib/gemini-model-discovery");
  return { ...actual, pickBestFlashModel: async () => "gemini-2.5-flash" };
});

const QUOTA_ERR = Object.assign(new Error("429 You exceeded your current quota"), { status: 429 });

vi.mock("@google/generative-ai", () => ({
  SchemaType: { OBJECT: "object", STRING: "string", NUMBER: "number", ARRAY: "array", BOOLEAN: "boolean", INTEGER: "integer" },
  GoogleGenerativeAI: class {
    constructor(_key: string) {}
    getGenerativeModel(_cfg: any) {
      return {
        startChat: () => ({
          sendMessage: async () => {
            st.geminiCalls++;
            if (st.geminiFails) throw QUOTA_ERR;
            return { response: { text: () => "GEMINI-OK", functionCalls: () => [], usageMetadata: {} } };
          },
        }),
        generateContent: async () => {
          st.geminiCalls++;
          if (st.geminiFails) throw QUOTA_ERR;
          return { response: { text: () => "GEMINI-OK", usageMetadata: {} } };
        },
      };
    }
  },
}));

function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const realFetch = global.fetch;

beforeEach(() => {
  resetGatewayCooldown();
  invalidateGatewayModelsCache();
  st.orQueue = [];
  st.orCalls = 0;
  st.geminiFails = false;
  st.geminiCalls = 0;
  st.keys = {
    gemini: null,
    openrouter: "fake-or-key",
    openrouterKeys: null,
    gatewayBaseUrl: null,
    gatewayApiKey: null,
    gatewayFallbackModel: null,
    gatewayEndpoints: [],
    aiCombos: [],
  };
  global.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("openrouter.ai")) {
      st.orCalls++;
      const r = st.orQueue.length > 0 ? st.orQueue.shift()! : { status: 200, content: "OR-OK" };
      if (r.status === 200) {
        return jsonRes(200, {
          choices: [{ message: { content: r.content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return jsonRes(r.status, { error: { message: r.msg || `HTTP ${r.status}` } });
    }
    return jsonRes(404, {});
  }) as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe("generateText — escada cross-provider", () => {
  it("Gemini com quota estourada e chave OpenRouter disponível → cai pro OpenRouter", async () => {
    st.keys.gemini = "fake-gemini-key";
    st.geminiFails = true;
    const res = await generateText({ modelRef: "gemini:gemini-2.5-flash", prompt: "oi", geminiApiKey: st.keys.gemini });
    expect(res.text).toBe("OR-OK");
    expect(res.didFallback).toBe(true);
    expect(res.modelUsed).toBe("openai/gpt-4o-mini");
    expect(st.orCalls).toBe(1);
  });

  it("Gemini sem chave configurada → erro de conta → OpenRouter atende", async () => {
    st.keys.gemini = null;
    const res = await generateText({ modelRef: "gemini:gemini-2.5-flash", prompt: "oi" });
    expect(res.text).toBe("OR-OK");
    expect(res.didFallback).toBe(true);
  });

  it("400 bad request puro NÃO sobe a escada (outro provider daria o mesmo erro)", async () => {
    st.orQueue = [{ status: 400, msg: "invalid model" }];
    st.keys.gemini = "fake-gemini-key";
    await expect(
      generateText({ modelRef: "openrouter:algum/modelo", prompt: "oi", openrouterApiKey: st.keys.openrouter }),
    ).rejects.toThrow(/invalid model/);
    expect(st.geminiCalls).toBe(0); // não chegou a queimar o rung Gemini
  });

  it("esgota a escada inteira → aí sim lança (só falha quando nenhuma conta atende)", async () => {
    st.keys.gemini = "fake-gemini-key";
    st.geminiFails = true;
    st.orQueue = [{ status: 429, msg: "rate limited" }, { status: 429, msg: "rate limited" }];
    await expect(
      generateText({ modelRef: "gemini:gemini-2.5-flash", prompt: "oi", geminiApiKey: st.keys.gemini }),
    ).rejects.toThrow(/quota/i);
    expect(st.orCalls).toBe(1); // tentou o rung OpenRouter com a única chave antes de falhar
  });

  it("noGatewayFallback=true desliga a escada (passos de combo propagam a falha)", async () => {
    st.keys.gemini = "fake-gemini-key";
    st.geminiFails = true;
    await expect(
      generateText({ modelRef: "gemini:gemini-2.5-flash", prompt: "oi", noGatewayFallback: true, geminiApiKey: st.keys.gemini }),
    ).rejects.toThrow(/quota/i);
    expect(st.orCalls).toBe(0);
  });
});

describe("startAiChat — migração de sessão no 1º turno", () => {
  it("1º turno falha no Gemini (quota) → sessão migra pro OpenRouter e responde", async () => {
    st.keys.gemini = "fake-gemini-key";
    st.geminiFails = true;
    const session = await startAiChat({
      modelRef: "gemini:gemini-2.5-flash",
      systemInstruction: "sys",
      history: [],
      tools: [],
      geminiApiKey: st.keys.gemini,
    });
    const r = await session.sendUser("oi");
    expect(r.text).toBe("OR-OK");
    expect(session.modelUsed()).toBe("openai/gpt-4o-mini");
  });

  it("depois do 1º turno bem-sucedido NÃO migra mais (contexto preservado)", async () => {
    st.keys.gemini = "fake-gemini-key";
    const session = await startAiChat({
      modelRef: "gemini:gemini-2.5-flash",
      systemInstruction: "sys",
      history: [],
      tools: [],
      geminiApiKey: st.keys.gemini,
    });
    const r1 = await session.sendUser("oi");
    expect(r1.text).toBe("GEMINI-OK");
    st.geminiFails = true; // morre DEPOIS do 1º turno
    await expect(session.sendUser("de novo")).rejects.toThrow(/quota/i);
    expect(st.orCalls).toBe(0); // não migrou no meio da conversa
  });

  it("OpenRouter todo em cooldown + Gemini OK → makeFallback interno resolve (não duplica rung)", async () => {
    st.keys.gemini = "fake-gemini-key";
    st.orQueue = [{ status: 429, msg: "cooldown" }];
    const session = await startAiChat({
      modelRef: "openrouter:algum/modelo",
      systemInstruction: "sys",
      history: [],
      tools: [],
      openrouterApiKey: st.keys.openrouter,
      geminiApiKey: st.keys.gemini,
    });
    const r = await session.sendUser("oi");
    expect(r.text).toBe("GEMINI-OK");
  });
});
