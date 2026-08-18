/**
 * Testes unitários para o sistema de Combos de IA, Cascata e Resiliência 9Router-Style.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitizeCombos, resolveComboSteps, COMBO_PREFIX, DEFAULT_AI_COMBOS, type AiCombo } from "../ai-combos";
import { parseModelRef, formatModelRef, providerDisplayName, generateText, startAiChat } from "../ai-provider";
import { resetGatewayCooldown } from "../gateway-cooldown";
import { invalidateGatewayModelsCache } from "../gateway-model-discovery";

const EP1 = "http://gw1.test/v1";
const EP2 = "http://gw2.test/v1";

// Estado compartilhado via vi.hoisted — mesmo padrão do ai-provider-failover.test.ts
// (vi.fn().mockImplementation em factory de vi.mock perde a implementação com
// clearMocks/restoreMocks:true do vitest.config).
const st = vi.hoisted(() => ({ keys: null as any }));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: async () => st.keys,
  invalidateAiKeysCache: vi.fn(),
}));
vi.mock("@/lib/gateway-proxy-manager", () => ({
  ensureProxyRunning: async () => ({ running: true, installed: true }),
}));

st.keys = {
  gemini: "fake-gemini-key",
  openrouter: "fake-or-key",
  gatewayBaseUrl: null,
  gatewayApiKey: null,
  gatewayFallbackModel: "gemini-2.5-flash",
  gatewayEndpoints: [
    { id: "ep1", label: "Conta 1", baseUrl: EP1, apiKey: null },
    { id: "ep2", label: "Conta 2", baseUrl: EP2, apiKey: null },
  ],
  aiCombos: [
    {
      id: "test-combo",
      name: "Combo de Teste",
      models: [
        { modelRef: "gateway:claude-3-7-sonnet", enabled: true },
        { modelRef: "gateway:gpt-4o", enabled: true },
        { modelRef: "gemini-2.5-flash", enabled: true },
      ],
    },
    {
      id: "combo-with-disabled",
      name: "Combo com Desativado",
      models: [
        { modelRef: "gateway:model-a", enabled: false },
        { modelRef: "gateway:model-b", enabled: true },
      ],
    },
  ],
};

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
          sendMessage: async () => ({ response: { text: () => "GEMINI-NATIVE-OK", functionCalls: () => [], usageMetadata: {} } }),
        }),
        generateContent: async () => ({ response: { text: () => "GEMINI-NATIVE-OK", usageMetadata: {} } }),
      };
    }
  },
}));

describe("ai-combos logic", () => {
  it("sanitizeCombos retorna defaults quando entrada é vazia ou inválida", () => {
    expect(sanitizeCombos(null)).toEqual(DEFAULT_AI_COMBOS);
    expect(sanitizeCombos([])).toEqual(DEFAULT_AI_COMBOS);
    expect(sanitizeCombos("invalid-json")).toEqual(DEFAULT_AI_COMBOS);
  });

  it("sanitizeCombos preserva combos customizados válidos", () => {
    const raw = [
      {
        id: "custom_1",
        name: "Meu Combo",
        models: [
          { modelRef: "gateway:gpt-4o", label: "GPT 4o", enabled: true },
          { modelRef: "gemini-2.5-flash", enabled: false },
        ],
      },
    ];
    const res = sanitizeCombos(raw);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe("custom_1");
    expect(res[0].models).toHaveLength(2);
    expect(res[0].models[0].enabled).toBe(true);
    expect(res[0].models[1].enabled).toBe(false);
  });

  it("resolveComboSteps filtra modelos desativados e resolve corretamente", () => {
    const combos: AiCombo[] = [
      {
        id: "meu-combo",
        name: "Teste",
        models: [
          { modelRef: "gateway:m1", enabled: true },
          { modelRef: "gateway:m2", enabled: false },
          { modelRef: "gateway:m3", enabled: true },
        ],
      },
    ];

    const steps = resolveComboSteps("meu-combo", combos);
    expect(steps).toEqual(["gateway:m1", "gateway:m3"]);

    const stepsWithPrefix = resolveComboSteps("combo:meu-combo", combos);
    expect(stepsWithPrefix).toEqual(["gateway:m1", "gateway:m3"]);
  });
});

describe("ai-provider combo routing", () => {
  it("parseModelRef identifica corretamente 'combo:' como provedor combo", () => {
    expect(parseModelRef("combo:principal")).toEqual({ provider: "combo", model: "principal" });
    expect(parseModelRef("combo:rapido")).toEqual({ provider: "combo", model: "rapido" });
    expect(formatModelRef("combo", "principal")).toBe("combo:principal");
    expect(providerDisplayName("combo")).toBe("Combo Virtual");
  });

  it("generateText com combo: resolve steps e executa em cascata", async () => {
    // Mock fetch: 2 contas (ep1=claude, ep2=gpt-4o). ep1 devolve 429 COM corpo
    // JSON parseável (o Response precisa de .json() — sem isso o erro vira
    // TypeError de rede e o cooldown de conta nunca é exercitado).
    const originalFetch = global.fetch;
    const chatCalls: Array<{ base: string; model: string }> = [];
    const modelsByEp: Record<string, string[]> = {
      ep1: ["claude-3-7-sonnet"],
      ep2: ["gpt-4o"],
    };
    resetGatewayCooldown();
    invalidateGatewayModelsCache();
    global.fetch = vi.fn().mockImplementation((url: string, init: any) => {
      const u = String(url);
      const base = u.startsWith(EP1) ? EP1 : EP2;
      if (u.endsWith("/models")) {
        const ep = base === EP1 ? "ep1" : "ep2";
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ object: "list", data: (modelsByEp[ep] || []).map((id) => ({ id })) }),
        });
      }
      const body = JSON.parse(init?.body || "{}");
      chatCalls.push({ base, model: body.model });
      if (base === EP1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve({ error: { message: "Quota exceeded" } }),
          text: () => Promise.resolve(JSON.stringify({ error: { message: "Quota exceeded" } })),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Resposta gerada com sucesso pelo fallback do combo" } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
      });
    }) as any;

    try {
      const res = await generateText({
        modelRef: "combo:test-combo",
        prompt: "Olá",
      });

      expect(res.text).toBe("Resposta gerada com sucesso pelo fallback do combo");
      expect(res.didFallback).toBe(true); // resolveu no passo 2 (cascata real)
      // claude só na ep1 (que entrou em cooldown), gpt-4o na ep2
      const claudeCalls = chatCalls.filter((c) => c.model === "claude-3-7-sonnet");
      const gptCalls = chatCalls.filter((c) => c.model === "gpt-4o");
      expect(claudeCalls).toHaveLength(1);
      expect(claudeCalls[0].base).toBe(EP1);
      expect(gptCalls).toHaveLength(1);
      expect(gptCalls[0].base).toBe(EP2);
    } finally {
      global.fetch = originalFetch;
      resetGatewayCooldown();
      invalidateGatewayModelsCache();
    }
  });
});
