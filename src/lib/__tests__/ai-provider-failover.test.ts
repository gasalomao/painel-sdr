/**
 * Testa o roteamento de failover do ai-provider (isFailoverableStatus +
 * ProviderHttpError). São as peças que decidem "trocar de conta conectada"
 * vs "erro do request, não adianta trocar".
 *
 * Cobertura:
 *  - HTTP 429, 402 → failover (quota esgotou em uma conta)
 *  - HTTP 401, 403 → failover (credencial morta)
 *  - HTTP 5xx, 0 (rede) → failover (transitório)
 *  - HTTP 400 com msg de quota → failover
 *  - HTTP 400 bad request puro → NÃO (outra conta dá o mesmo erro)
 *  - HTTP 404 → NÃO (modelo/rota inexistente — não é falha de conta)
 *  - ProviderHttpError preserva status + endpointId
 *
 * INTEGRAÇÃO (sem rede real — fetch/ai-keys/proxy-manager/SDK Gemini mockados):
 *  - 429 na conta 1 → cooldown + resposta pela conta 2 (MESMO modelo)
 *  - 401 na conta 1 → marcada MORTA e pulada nas chamadas seguintes
 *  - 400 bad request puro → relança (não troca conta, não marca cooldown)
 *  - Combo: contas do modelo 1 esgotam → avança pro modelo 2 (NÃO pro fallback
 *    global — o refill do banco não pode "resolver" o passo sozinho)
 *  - Combo inteiro falha → fallback global (API key) UMA vez, no fim
 *  - startAiChat combo: falha no 1º turno → cascata pro próximo modelo
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ProviderHttpError,
  isFailoverableStatus,
  resolveReasoningMode,
  applyReasoning,
  generateText,
  startAiChat,
} from "../ai-provider";
import { resetGatewayCooldown, isEndpointUnavailable, isEndpointDead } from "../gateway-cooldown";
import { invalidateGatewayModelsCache } from "../gateway-model-discovery";

describe("isFailoverableStatus — quando trocar de conta?", () => {
  it("429 (rate limit) → troca", () => {
    expect(isFailoverableStatus(429)).toBe(true);
  });

  it("402 (payment required) → troca (quota)", () => {
    expect(isFailoverableStatus(402)).toBe(true);
  });

  it("401 e 403 (auth) → troca (credencial morta)", () => {
    expect(isFailoverableStatus(401)).toBe(true);
    expect(isFailoverableStatus(403)).toBe(true);
  });

  it("5xx (server error) → troca (transitório)", () => {
    expect(isFailoverableStatus(500)).toBe(true);
    expect(isFailoverableStatus(502)).toBe(true);
    expect(isFailoverableStatus(503)).toBe(true);
    expect(isFailoverableStatus(599)).toBe(true);
  });

  it("status 0 (rede/timeout) → troca", () => {
    expect(isFailoverableStatus(0)).toBe(true);
  });

  it("400 com mensagem de quota → troca (alguns proxies devolvem 400 em vez de 429)", () => {
    expect(isFailoverableStatus(400, "You exceeded your quota")).toBe(true);
    expect(isFailoverableStatus(400, "rate limit exceeded")).toBe(true);
    expect(isFailoverableStatus(400, "too many requests")).toBe(true);
    expect(isFailoverableStatus(400, "insufficient credits")).toBe(true);
  });

  it("400 bad request puro → NÃO troca (outra conta daria o mesmo erro)", () => {
    expect(isFailoverableStatus(400, "invalid model")).toBe(false);
    expect(isFailoverableStatus(400, "malformed payload")).toBe(false);
  });

  it("404 (not found) → NÃO troca (modelo/rota inexistente)", () => {
    expect(isFailoverableStatus(404)).toBe(false);
  });

  it("200 (OK) → NÃO troca (não é erro)", () => {
    expect(isFailoverableStatus(200)).toBe(false);
  });
});

describe("ProviderHttpError — preserva status + endpointId", () => {
  it("carrega status e message", () => {
    const err = new ProviderHttpError(429, "quota exceeded");
    expect(err.status).toBe(429);
    expect(err.message).toBe("quota exceeded");
    expect(err.name).toBe("ProviderHttpError");
    expect(err instanceof Error).toBe(true);
  });

  it("carrega endpointId quando fornecido", () => {
    const err = new ProviderHttpError(401, "not authorized", "conn-42");
    expect(err.endpointId).toBe("conn-42");
  });

  it("endpointId fica undefined quando não fornecido", () => {
    const err = new ProviderHttpError(500, "boom");
    expect(err.endpointId).toBeUndefined();
  });
});

describe("resolveReasoningMode — retrocompat com thinkingBudget", () => {
  it("mode explícito sempre vence", () => {
    expect(resolveReasoningMode(0)).toBe(0);
    expect(resolveReasoningMode(1)).toBe(1);
    expect(resolveReasoningMode(2)).toBe(2);
  });

  it("thinkingBudget = 0 vira econômico (mode 0)", () => {
    expect(resolveReasoningMode(undefined, 0)).toBe(0);
  });

  it("thinkingBudget > 0 vira equilibrado (mode 1)", () => {
    expect(resolveReasoningMode(undefined, 256)).toBe(1);
    expect(resolveReasoningMode(undefined, 8192)).toBe(1);
  });

  it("thinkingBudget = -1 (dinâmico) vira intenso (mode 2)", () => {
    expect(resolveReasoningMode(undefined, -1)).toBe(2);
  });

  it("sem nada → econômico (default seguro)", () => {
    expect(resolveReasoningMode(undefined, undefined)).toBe(0);
    expect(resolveReasoningMode(null, null)).toBe(0);
  });
});

describe("applyReasoning — mapa por provedor", () => {
  it("Gemini é no-op (thinkingBudget tratado em outro lugar)", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 2, "gemini", "gemini-2.5-flash");
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("GPT-5 / OpenAI recebe reasoning.effort", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 0, "openrouter", "openai/gpt-5");
    expect(body.reasoning).toEqual({ effort: "minimal" });

    const body2: Record<string, any> = {};
    applyReasoning(body2, 1, "openrouter", "openai/gpt-5");
    expect(body2.reasoning).toEqual({ effort: "medium" });

    const body3: Record<string, any> = {};
    applyReasoning(body3, 2, "openrouter", "openai/gpt-5");
    expect(body3.reasoning).toEqual({ effort: "high" });
  });

  it("Claude recebe thinking.budget_tokens só quando NÃO econômico", () => {
    const body0: Record<string, any> = {};
    applyReasoning(body0, 0, "gateway", "claude-3-5-sonnet");
    expect(body0.thinking).toBeUndefined();

    const body1: Record<string, any> = {};
    applyReasoning(body1, 1, "gateway", "claude-3-5-sonnet");
    expect(body1.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });

    const body2: Record<string, any> = {};
    applyReasoning(body2, 2, "gateway", "claude-3-5-sonnet");
    expect(body2.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });

  it("DeepSeek e outros — sem campo de raciocínio (no-op)", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 2, "openrouter", "deepseek-chat");
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });
});

// =====================================================================
// Integração: failover de CONTAS × cascata de COMBOS (estilo 9Router).
// =====================================================================

const EP1 = "http://gw1.test/v1";
const EP2 = "http://gw2.test/v1";

const st = vi.hoisted(() => ({
  keys: null as any,
  endpoints: [] as Array<{ id: string; label: string; baseUrl: string; apiKey: string | null }>,
  /** endpointId → modelIds (resposta do GET /models de cada conta). */
  modelsByEp: {} as Record<string, string[]>,
  /** Roteador de chat: (baseUrl, model) => { status: 200, content } | { status, msg }. */
  chat: (..._a: any[]) => ({}) as any,
  /** Chamadas POST /chat/completions efetivamente feitas. */
  calls: [] as Array<{ base: string; model: string }>,
  geminiCalls: 0,
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: async () => st.keys,
  invalidateAiKeysCache: () => {},
}));

vi.mock("@/lib/gateway-proxy-manager", () => ({
  ensureProxyRunning: async () => ({ running: true, installed: true }),
}));

vi.mock("@google/generative-ai", () => ({
  SchemaType: { OBJECT: "object", STRING: "string", NUMBER: "number", ARRAY: "array", BOOLEAN: "boolean", INTEGER: "integer" },
  GoogleGenerativeAI: class {
    constructor(_key: string) {}
    getGenerativeModel(_cfg: any) {
      return {
        startChat: () => ({
          sendMessage: async () => ({ response: { text: () => "GEMINI-FALLBACK-TEXT", functionCalls: () => [], usageMetadata: {} } }),
        }),
        generateContent: async () => {
          st.geminiCalls++;
          return { response: { text: () => "GEMINI-FALLBACK-TEXT", usageMetadata: {} } };
        },
      };
    }
  },
}));

function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
const ok = (content: string) => ({ status: 200, content });
const fail = (status: number, msg: string) => ({ status, msg });

const realFetch = global.fetch;

beforeEach(() => {
  resetGatewayCooldown();
  invalidateGatewayModelsCache();
  st.endpoints = [
    { id: "ep1", label: "Conta 1", baseUrl: EP1, apiKey: null },
    { id: "ep2", label: "Conta 2", baseUrl: EP2, apiKey: null },
  ];
  st.modelsByEp = {};
  st.chat = () => ok("OK");
  st.calls = [];
  st.geminiCalls = 0;
  st.keys = {
    gemini: "fake-gemini-key",
    openrouter: "fake-or-key",
    gatewayBaseUrl: null,
    gatewayApiKey: null,
    gatewayFallbackModel: "gemini-2.5-flash",
    gatewayEndpoints: st.endpoints,
    aiCombos: [] as any[],
  };
  global.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const ep = st.endpoints.find((e) => u.startsWith(e.baseUrl));
    if (u.endsWith("/models")) {
      return jsonRes(200, { object: "list", data: (st.modelsByEp[ep?.id || ""] || []).map((id) => ({ id })) });
    }
    if (u.endsWith("/chat/completions")) {
      const body = JSON.parse(init?.body || "{}");
      st.calls.push({ base: ep?.baseUrl || u, model: body.model });
      const r = st.chat(ep?.baseUrl || u, body.model);
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

describe("integração: failover de CONTAS (mesmo modelo)", () => {
  it("429 na conta 1 → cooldown + resposta pela conta 2", async () => {
    st.modelsByEp = { ep1: ["claude-3-7-sonnet"], ep2: ["claude-3-7-sonnet"] };
    st.chat = (base) => (base === EP1 ? fail(429, "Quota exceeded") : ok("EP2-OK"));
    const res = await generateText({ modelRef: "gateway:claude-3-7-sonnet", prompt: "oi" });
    expect(res.text).toBe("EP2-OK");
    expect(res.modelUsed).toBe("claude-3-7-sonnet");
    expect(st.calls).toHaveLength(2); // tentou as duas contas
    expect(isEndpointUnavailable("ep1")).toBe(true);
    expect(isEndpointUnavailable("ep2")).toBe(false);
  });

  it("401 na conta 1 → marcada MORTA e pulada nas chamadas seguintes", async () => {
    st.modelsByEp = { ep1: ["gpt-4o"], ep2: ["gpt-4o"] };
    st.chat = (base) => (base === EP1 ? fail(401, "Unauthorized") : ok("EP2-OK"));
    const r1 = await generateText({ modelRef: "gateway:gpt-4o", prompt: "oi" });
    const r2 = await generateText({ modelRef: "gateway:gpt-4o", prompt: "oi" });
    expect(r1.text).toBe("EP2-OK");
    expect(r2.text).toBe("EP2-OK");
    expect(st.calls.filter((c) => c.base === EP1)).toHaveLength(1); // 2ª chamada pulou a morta
    expect(isEndpointDead("ep1")).toBe(true);
  });

  it("resposta vazia na conta 1 → resposta pela conta 2 do mesmo modelo", async () => {
    st.modelsByEp = { ep1: ["nemotron"], ep2: ["nemotron"] };
    st.chat = (base) => base === EP1 ? ok("") : ok("EP2-OK");
    st.keys.gatewayFallbackModel = null;
    const session = await startAiChat({
      modelRef: "gateway:nemotron",
      systemInstruction: "sys",
      history: [],
      tools: [],
    });

    const result = await session.sendUser("oi");

    expect(result.text).toBe("EP2-OK");
    expect(session.modelUsed()).toBe("nemotron");
    expect(st.calls).toHaveLength(2);
  });

  it("400 bad request puro → relança sem trocar de conta e sem cooldown", async () => {
    st.endpoints = [st.endpoints[0]]; // só ep1
    st.keys.gatewayEndpoints = st.endpoints;
    st.modelsByEp = { ep1: ["m-x"] };
    st.keys.gatewayFallbackModel = null;
    st.chat = () => fail(400, "invalid model");
    await expect(generateText({ modelRef: "gateway:m-x", prompt: "oi" })).rejects.toThrow(/invalid model/);
    expect(st.calls).toHaveLength(1); // não tentou outra conta
    expect(isEndpointUnavailable("ep1")).toBe(false); // não marcou cooldown
  });
});

describe("integração: cascata de COMBOS (contas primeiro, modelo depois)", () => {
  const COMBO = {
    id: "c",
    name: "Combo Teste",
    models: [
      { modelRef: "gateway:claude-3-7-sonnet", enabled: true },
      { modelRef: "gateway:gpt-4o", enabled: true },
    ],
  };

  it("todas as contas do modelo 1 esgotam → avança pro modelo 2 (fallback global NÃO mascara a cascata)", async () => {
    st.modelsByEp = { ep1: ["claude-3-7-sonnet"], ep2: ["gpt-4o"] };
    st.chat = (_base, model) => (model === "claude-3-7-sonnet" ? fail(429, "Quota exceeded") : ok("GPT4O-OK"));
    st.keys.aiCombos = [COMBO];
    const res = await generateText({ modelRef: "combo:c", prompt: "oi", geminiApiKey: "AIza-test" });
    expect(res.text).toBe("GPT4O-OK");
    expect(res.didFallback).toBe(true); // cascata = passo 2
    expect(st.geminiCalls).toBe(0); // o fallback global NÃO pode rodar dentro do passo
  });

  it("combo INTEIRO falha → fallback global (API key) uma única vez, no fim", async () => {
    st.modelsByEp = { ep1: ["claude-3-7-sonnet", "gpt-4o"] };
    st.chat = () => fail(429, "Quota exceeded");
    st.keys.aiCombos = [COMBO];
    const res = await generateText({ modelRef: "combo:c", prompt: "oi", geminiApiKey: "AIza-test" });
    expect(res.text).toBe("GEMINI-FALLBACK-TEXT");
    expect(res.didFallback).toBe(true);
    expect(st.geminiCalls).toBe(1); // uma vez só, depois de esgotar todos os passos
  });

  it("startAiChat: 1º turno falha no modelo 1 → cascata pro modelo 2 na sessão", async () => {
    st.modelsByEp = { ep1: ["claude-3-7-sonnet"], ep2: ["gpt-4o"] };
    st.chat = (_base, model) => (model === "claude-3-7-sonnet" ? fail(429, "Quota exceeded") : ok("GPT4O-OK"));
    st.keys.aiCombos = [COMBO];
    const session = await startAiChat({
      modelRef: "combo:c",
      systemInstruction: "sys",
      history: [],
      tools: [],
      geminiApiKey: "AIza-test",
    });
    const res = await session.sendUser("oi");
    expect(res.text).toBe("GPT4O-OK");
    expect(session.modelUsed()).toBe("gpt-4o");
    expect(st.geminiCalls).toBe(0);
  });

  it("startAiChat: resposta vazia do modelo 1 → cascata pro modelo 2", async () => {
    st.modelsByEp = { ep1: ["claude-3-7-sonnet", "gpt-4o"] };
    st.chat = (_base, model) => model === "claude-3-7-sonnet" ? ok("") : ok("GPT4O-OK");
    st.keys.aiCombos = [COMBO];
    const session = await startAiChat({
      modelRef: "combo:c",
      systemInstruction: "sys",
      history: [],
      tools: [],
      geminiApiKey: "AIza-test",
    });

    const res = await session.sendUser("oi");

    expect(res.text).toBe("GPT4O-OK");
    expect(session.modelUsed()).toBe("gpt-4o");
    expect(st.calls.map((call) => call.model)).toEqual(["claude-3-7-sonnet", "gpt-4o"]);
  });

  it("startAiChat: inicialização falha, próximo modelo retorna vazio e terceiro responde", async () => {
    st.modelsByEp = { ep1: ["modelo-vazio", "modelo-ok"] };
    st.chat = (_base, model) => model === "modelo-vazio" ? ok("") : ok("TERCEIRO-OK");
    st.keys.aiCombos = [{
      id: "tres-passos",
      name: "Três passos",
      models: [
        { modelRef: "gemini:gemini-sem-chave", enabled: true },
        { modelRef: "gateway:modelo-vazio", enabled: true },
        { modelRef: "gateway:modelo-ok", enabled: true },
      ],
    }];
    const session = await startAiChat({
      modelRef: "combo:tres-passos",
      systemInstruction: "sys",
      history: [],
      tools: [],
    });

    const result = await session.sendUser("oi");

    expect(result.text).toBe("TERCEIRO-OK");
    expect(session.modelUsed()).toBe("modelo-ok");
    expect(st.calls.map((call) => call.model)).toEqual(["modelo-vazio", "modelo-ok"]);
  });
});
