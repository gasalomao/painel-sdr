// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_FREE_FAST_MODEL_REF,
  AUTO_FREE_MODEL_REF,
  areAllOpenRouterKeysFreeOnly,
  extractModelParameterBillions,
  isModelQuarantined,
  rankFreeModelsFromCatalogs,
  recordModelFailure,
  recordModelSuccess,
  resetSmartRouterHealth,
  scoreFreeModelCandidate,
} from "@/lib/ai-smart-free-router";
import {
  invalidateOpenRouterModelsCache,
  seedOpenRouterModelsCache,
} from "@/lib/openrouter-model-discovery";
import {
  invalidateNvidiaModelsCache,
  seedNvidiaModelsCache,
} from "@/lib/nvidia-model-discovery";
import {
  invalidateGatewayModelsCache,
  seedGatewayModelsCache,
} from "@/lib/gateway-model-discovery";
import { generateText, parseModelRef, startAiChat } from "@/lib/ai-provider";
import { resetGatewayCooldown } from "@/lib/gateway-cooldown";

const mockKeysState = vi.hoisted(() => ({
  keys: {
    gemini: null as string | null,
    openrouter: "sk-or-key-1" as string | null,
    openrouterKeys: ["sk-or-key-1", "sk-or-key-2", "sk-or-key-3"] as string[] | null,
    nvidia: "nvapi-key-1" as string | null,
    nvidiaAccounts: [{ id: "nv1", label: "NV Principal", apiKey: "nvapi-key-1" }] as Array<{
      id: string;
      label: string;
      apiKey: string;
    }> | null,
    gatewayBaseUrl: null as string | null,
    gatewayApiKey: null as string | null,
    gatewayFallbackModel: null as string | null,
    gatewayEndpoints: [] as Array<{ id: string; label: string; baseUrl: string; apiKey: string | null }>,
    aiCombos: [] as unknown[],
  },
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: async () => mockKeysState.keys,
  invalidateAiKeysCache: () => {},
}));

vi.mock("@/lib/gateway-proxy-manager", () => ({
  ensureProxyRunning: async () => ({ running: false, installed: false }),
}));

const realFetch = global.fetch;

beforeEach(() => {
  resetGatewayCooldown();
  resetSmartRouterHealth();
  invalidateOpenRouterModelsCache();
  invalidateNvidiaModelsCache();
  invalidateGatewayModelsCache();
  mockKeysState.keys = {
    gemini: null,
    openrouter: "sk-or-key-1",
    openrouterKeys: ["sk-or-key-1", "sk-or-key-2", "sk-or-key-3"],
    nvidia: "nvapi-key-1",
    nvidiaAccounts: [{ id: "nv1", label: "NV Principal", apiKey: "nvapi-key-1" }],
    gatewayBaseUrl: null,
    gatewayApiKey: null,
    gatewayFallbackModel: null,
    gatewayEndpoints: [],
    aiCombos: [],
  };
});

afterEach(() => {
  global.fetch = realFetch;
  resetGatewayCooldown();
  resetSmartRouterHealth();
});

describe("ai-smart-free-router — Pontuação Future-Proof & Perfis de Tarefa", () => {
  it("pontua automaticamente modelos inéditos futuros (MoE / densos / sem número) acima de modelos pequenos ou roleplay", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    // Modelo fictício lançado hoje ("next-gen-labs/titan-480b-a45b:free")
    const brandNewFrontier = scoreFreeModelCandidate(
      {
        provider: "openrouter",
        rawId: "next-gen-labs/titan-480b-a45b:free",
        name: "Titan 480B A45B (free)",
        contextLength: 262_144,
        maxCompletionTokens: 32_768,
        created: nowSec - 3 * 86_400,
        supportsTools: true,
        supportsStructuredOutputs: true,
      },
      { profile: "agent", requireTools: true, nowSec },
    );

    // Modelo médio antigo sem tools
    const oldSmallNoTools = scoreFreeModelCandidate(
      {
        provider: "openrouter",
        rawId: "legacy/chat-8b:free",
        name: "Legacy Chat 8B",
        contextLength: 8_192,
        created: nowSec - 800 * 86_400,
        supportsTools: false,
      },
      { profile: "agent", requireTools: true, nowSec },
    );

    // Modelo 3B minúsculo (desqualificado para SDR)
    const tinyRejected = scoreFreeModelCandidate(
      {
        provider: "openrouter",
        rawId: "tiny/mini-3b-it:free",
        name: "Mini 3B",
        contextLength: 32_768,
        supportsTools: true,
      },
      { profile: "agent", requireTools: true, nowSec },
    );

    // Modelo roleplay/uncensored (fortemente penalizado)
    const roleplayFineTune = scoreFreeModelCandidate(
      {
        provider: "openrouter",
        rawId: "community/mythomax-roleplay-uncensored-70b:free",
        name: "MythoMax Roleplay Uncensored 70B",
        contextLength: 32_768,
        supportsTools: false,
      },
      { profile: "agent", requireTools: true, nowSec },
    );

    expect(extractModelParameterBillions("next-gen-labs/titan-480b-a45b:free")).toEqual({
      totalBillions: 480,
      activeBillions: 45,
    });
    expect(brandNewFrontier).toBeGreaterThanOrEqual(80);
    expect(brandNewFrontier).toBeGreaterThan(oldSmallNoTools);
    expect(brandNewFrontier).toBeGreaterThan(roleplayFineTune);
    expect(tinyRejected).toBe(-1);
  });

  it("no perfil 'fast' (avaliadores binários e resumos), prioriza modelo instruct rápido sobre modelo reasoning R1", () => {
    const fastInstruct = scoreFreeModelCandidate(
      {
        provider: "openrouter",
        rawId: "meta-llama/llama-3.3-70b-instruct:free",
        name: "Llama 3.3 70B Instruct",
        contextLength: 131_072,
        supportsTools: true,
        supportsReasoning: false,
      },
      { profile: "fast" },
    );

    const heavyReasoner = scoreFreeModelCandidate(
      {
        provider: "openrouter",
        rawId: "deepseek/deepseek-r1:free",
        name: "DeepSeek R1",
        contextLength: 131_072,
        supportsTools: false,
        supportsReasoning: true,
      },
      { profile: "fast" },
    );

    expect(fastInstruct).toBeGreaterThan(heavyReasoner + 20);
  });

  it("intercala provedores no ranking e promove automaticamente quem está mais rápido na telemetria ao vivo", async () => {
    seedOpenRouterModelsCache([
      {
        id: "qwen/qwen3-235b-a22b:free",
        name: "Qwen3 235B A22B",
        contextLength: 131_072,
        supportsTools: true,
        supportsStructuredOutputs: true,
        isFree: true,
        pricing: { prompt: "0", completion: "0" },
      },
      {
        id: "meta-llama/llama-3.3-70b-instruct:free",
        name: "Llama 3.3 70B Instruct",
        contextLength: 131_072,
        supportsTools: true,
        isFree: true,
        pricing: { prompt: "0", completion: "0" },
      },
    ]);
    seedNvidiaModelsCache([
      {
        id: "nvidia/nemotron-3.5-lightning-30b-a3b",
        name: "Nemotron 3.5 Lightning 30B",
        supportsTools: true,
        isFreeEndpoint: true,
        available: true,
        usageCount: 150_000,
        contextLength: 128_000,
      },
    ]);

    const initial = await rankFreeModelsFromCatalogs({
      profile: "agent",
      requireTools: true,
      hasOpenRouter: true,
      hasNvidia: true,
      maxResults: 3,
    });

    // 1º: melhor absoluto (OpenRouter Qwen 235B), 2º: intercalado de outro provedor (NVIDIA Free)
    expect(initial[0].modelRef).toBe("openrouter:qwen/qwen3-235b-a22b:free");
    expect(initial[1].modelRef).toBe("nvidia:nvidia/nemotron-3.5-lightning-30b-a3b");

    // Se Qwen 235B sofrer falha/vazio e Llama 70B responder em 900ms, Llama ultrapassa Qwen
    recordModelFailure("openrouter", "qwen/qwen3-235b-a22b:free", { isEmpty: true });
    recordModelSuccess("openrouter", "meta-llama/llama-3.3-70b-instruct:free", 900);

    const afterTelemetry = await rankFreeModelsFromCatalogs({
      profile: "agent",
      requireTools: true,
      hasOpenRouter: true,
      hasNvidia: false,
      maxResults: 2,
    });
    expect(afterTelemetry[0].modelRef).toBe("openrouter:meta-llama/llama-3.3-70b-instruct:free");
  });
});

describe("ai-provider + Smart Free Router — Soberania do Seletor, Quarentena e Interoperabilidade", () => {
  it("respeita 100% o modelo escolhido no seletor quando ele responde normalmente", async () => {
    seedOpenRouterModelsCache([
      {
        id: "future/super-500b:free",
        name: "Super 500B",
        contextLength: 262_144,
        supportsTools: true,
        isFree: true,
      },
    ]);

    const calledModels: string[] = [];
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      calledModels.push(String(body.model));
      return Response.json({
        choices: [{ message: { content: "Titular respondeu!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    }) as typeof fetch;

    const res = await generateText({
      modelRef: "openrouter:meu-modelo/escolhido:free",
      prompt: "Oi",
    });

    expect(res.text).toBe("Titular respondeu!");
    expect(res.didFallback).toBe(false);
    expect(calledModels).toEqual(["meu-modelo/escolhido:free"]);
  });

  it("quando modelo :free fica indisponível ('unavailable for free'), NÃO queima as outras chaves e pula direto pro melhor :free vivo", async () => {
    seedOpenRouterModelsCache([
      {
        id: "novo-lab/frontier-250b-a25b:free",
        name: "Frontier 250B",
        contextLength: 131_072,
        supportsTools: true,
        isFree: true,
      },
    ]);

    const calls: Array<{ key: string; model: string }> = [];
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers || {}) as Record<string, string>;
      const key = String(headers.Authorization || "").replace("Bearer ", "");
      const body = JSON.parse(String(init?.body || "{}"));
      calls.push({ key, model: String(body.model) });

      if (body.model === "velho/descontinuado:free") {
        return Response.json(
          { error: { message: "This model is unavailable for free. The paid version is available now." } },
          { status: 404 },
        );
      }
      return Response.json({
        choices: [{ message: { content: "Assumi pelo melhor modelo free novo!" } }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      });
    }) as typeof fetch;

    const res = await generateText({
      modelRef: "openrouter:velho/descontinuado:free",
      prompt: "Teste failover inteligente",
    });

    expect(res.text).toBe("Assumi pelo melhor modelo free novo!");
    expect(res.didFallback).toBe(true);
    expect(res.modelUsed).toBe("novo-lab/frontier-250b-a25b:free");
    // Tentou o modelo morto APENAS na 1ª chave (não desperdiçou chave 2 e chave 3!)
    expect(calls.filter((c) => c.model === "velho/descontinuado:free")).toHaveLength(1);
    expect(isModelQuarantined("openrouter", "velho/descontinuado:free")).toBe(true);
  });

  it("assume sessão com tools em outro provedor (OpenRouter -> NVIDIA Free) inclusive em sendToolResults sem repetir a tool", async () => {
    seedNvidiaModelsCache([
      {
        id: "deepseek-ai/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        supportsTools: true,
        isFreeEndpoint: true,
        available: true,
        usageCount: 95_000,
        contextLength: 128_000,
      },
    ]);

    let step = 0;
    const historyModels: Array<{ url: string; model: string }> = [];
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || "{}"));
      historyModels.push({ url, model: String(body.model) });
      step++;

      // Passo 1: OpenRouter titular chama tool `check_availability`
      if (step === 1) {
        return Response.json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "check_availability", arguments: JSON.stringify({ date: "2026-11-19" }) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
      }

      // Passo 2: OpenRouter cai em todas as chaves durante sendToolResults
      if (url.includes("openrouter.ai")) {
        return Response.json({ error: { message: "Rate limit exceeded" } }, { status: 429 });
      }

      // Passo 3: NVIDIA Free Endpoint assume com o resultado da ferramenta já executada!
      const lastMsg = body.messages[body.messages.length - 1]?.content || "";
      expect(lastMsg).toContain("14:30");
      return Response.json({
        choices: [{ message: { content: "Temos horário livre amanhã às 14:30! Quer confirmar?" } }],
        usage: { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 },
      });
    }) as typeof fetch;

    const session = await startAiChat({
      modelRef: "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
      systemInstruction: "Você é a Sarah SDR.",
      history: [],
      tools: [
        {
          name: "check_availability",
          description: "Checa agenda",
          parameters: { type: "OBJECT", properties: { date: { type: "STRING" } } },
        },
      ],
    });

    const firstTurn = await session.sendUser("Quais horários tem amanhã?");
    expect(firstTurn.toolCalls).toHaveLength(1);
    expect(firstTurn.toolCalls[0].name).toBe("check_availability");

    const finalTurn = await session.sendToolResults([
      { name: "check_availability", id: "call_1", response: { freeSlots: ["14:30", "16:00"] } },
    ]);

    expect(finalTurn.text).toContain("14:30");
    expect(session.provider).toBe("nvidia");
    expect(session.modelUsed()).toBe("deepseek-ai/deepseek-v4.1-flash");
  });

  it("degrada jsonMode / geminiResponseSchema automaticamente quando modelo :free rejeita response_format com HTTP 400", async () => {
    let attempts = 0;
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      attempts++;
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.response_format) {
        return Response.json(
          { error: { message: "response_format json_object is not supported by this model" } },
          { status: 400 },
        );
      }
      return Response.json({
        choices: [{ message: { content: '{"status":"qualificado"}' } }],
        usage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 },
      });
    }) as typeof fetch;

    const res = await generateText({
      modelRef: "openrouter:algum/free-sem-json-mode:free",
      prompt: "Classifique o lead",
      jsonMode: true,
      geminiResponseSchema: { type: "object", properties: { status: { type: "string" } } },
    });

    expect(attempts).toBe(2);
    expect(JSON.parse(res.text)).toEqual({ status: "qualificado" });
  });

  it("resgata chamada curta (maxOutputTokens=5) quando modelo reasoning devolve content vazio por truncamento de thinking", async () => {
    let attempts = 0;
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      attempts++;
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.max_tokens === 5) {
        return Response.json({
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 5,
            total_tokens: 35,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        });
      }
      expect(body.max_tokens).toBe(384);
      expect(body.reasoning).toEqual({ effort: "minimal" });
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: "SIM" } }],
        usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
      });
    }) as typeof fetch;

    const res = await generateText({
      modelRef: "openrouter:modelo/reasoning-obrigatorio:free",
      prompt: "Cumprido? (SIM/NAO):",
      maxOutputTokens: 5,
      reasoningMode: 0,
    });

    expect(attempts).toBe(2);
    expect(res.text).toBe("SIM");
    expect(res.usage.totalTokens).toBe(69);
  });

  it("suporta auto:free e auto:free-fast diretamente e memoriza chaves sem crédito para nunca repetir gpt-4o-mini pago", async () => {
    expect(parseModelRef(AUTO_FREE_MODEL_REF)).toEqual({ provider: "combo", model: "auto:free" });
    expect(parseModelRef(AUTO_FREE_FAST_MODEL_REF)).toEqual({ provider: "combo", model: "auto:free-fast" });

    seedGatewayModelsCache([
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        supportsTools: true,
        endpointId: "gw1",
        endpointLabel: "Gateway Local",
      },
    ]);

    global.fetch = vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.includes("openrouter.ai")) {
        return Response.json(
          { error: { message: "Insufficient credits. This account never purchased credits." } },
          { status: 402 },
        );
      }
      return Response.json({ error: { message: "offline" } }, { status: 503 });
    }) as typeof fetch;

    await generateText({
      modelRef: "openrouter:openai/gpt-4o-mini",
      prompt: "oi",
      openrouterKeys: ["sk-free-1", "sk-free-2"],
      noGatewayFallback: true,
    }).catch(() => {});

    expect(areAllOpenRouterKeysFreeOnly(["sk-free-1", "sk-free-2"])).toBe(true);
  });

  it("mantém modelo de embeddings do RAG isolado (sem auto:free em /api/ai-models/embeddings)", async () => {
    const fs = await import("fs");
    const embRouteSource = fs.readFileSync("src/app/api/ai-models/embeddings/route.ts", "utf8");
    const ragSource = fs.readFileSync("src/lib/rag.ts", "utf8");
    expect(embRouteSource).not.toContain("auto:free");
    expect(ragSource).not.toContain("ai-smart-free-router");
  });
});

