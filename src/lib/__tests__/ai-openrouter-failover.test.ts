import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateText } from "../ai-provider";
import { resetGatewayCooldown, isEndpointDead, isEndpointCooling } from "../gateway-cooldown";

const st = vi.hoisted(() => ({
  openrouterCalls: [] as Array<{ key: string; model: string }>,
  openrouterHandler: (_key: string, _model: string) => ({ status: 200, content: "DEFAULT_OK" as string, msg: "" as string }),
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: async () => ({
    gemini: "fake-gemini-key",
    openrouter: "sk-or-v1-key1",
    openrouterKeys: ["sk-or-v1-key1", "sk-or-v1-key2", "sk-or-v1-key3"],
    gatewayBaseUrl: null,
    gatewayApiKey: null,
    gatewayFallbackModel: null,
    gatewayEndpoints: [],
    aiCombos: [],
  }),
}));

function jsonRes(status: number, data: any): Response {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : `Error ${status}`,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => data,
    text: async () => text,
  } as unknown as Response;
}

const realFetch = global.fetch;

beforeEach(() => {
  resetGatewayCooldown();
  st.openrouterCalls = [];
  st.openrouterHandler = () => ({ status: 200, content: "OK", msg: "" });

  global.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("openrouter.ai/api/v1/chat/completions")) {
      const auth = String(init?.headers?.Authorization || "");
      const key = auth.replace("Bearer ", "").trim();
      const body = JSON.parse(init?.body || "{}");
      st.openrouterCalls.push({ key, model: body.model });

      const res = st.openrouterHandler(key, body.model);
      if (res.status === 200) {
        return jsonRes(200, {
          choices: [{ message: { content: res.content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      }
      return jsonRes(res.status, {
        error: { message: res.msg || `HTTP Error ${res.status}` },
      });
    }
    return jsonRes(404, {});
  }) as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe("OpenRouter Multi-Key Failover (9Router-style)", () => {
  it("rotaciona para a 2ª chave se a 1ª chave der 429 (Rate Limit / Quota)", async () => {
    st.openrouterHandler = (key) => {
      if (key === "sk-or-v1-key1") {
        return { status: 429, content: "", msg: "Rate limit exceeded: free-tier quota exhausted" };
      }
      return { status: 200, content: "KEY2_SUCCESS", msg: "" };
    };

    const res = await generateText({
      modelRef: "openrouter:anthropic/claude-3.5-haiku",
      prompt: "Olá mundo",
      openrouterKeys: ["sk-or-v1-key1", "sk-or-v1-key2"],
    });

    expect(res.text).toBe("KEY2_SUCCESS");
    expect(st.openrouterCalls).toHaveLength(2);
    expect(st.openrouterCalls[0].key).toBe("sk-or-v1-key1");
    expect(st.openrouterCalls[1].key).toBe("sk-or-v1-key2");
    // Cooldown tem escopo CHAVE+MODELO — quota 429 da OpenRouter é por modelo.
    expect(isEndpointCooling("or_sk-or-v1…key1::anthropic/claude-3.5-haiku")).toBe(true);
  });

  it("marca chave como DEAD em 401/403 e avança para a próxima", async () => {
    st.openrouterHandler = (key) => {
      if (key === "sk-or-v1-key1") {
        return { status: 401, content: "", msg: "Unauthorized: Invalid API key" };
      }
      return { status: 200, content: "KEY2_AFTER_401", msg: "" };
    };

    const res = await generateText({
      modelRef: "openrouter:meta-llama/llama-3.3-70b-instruct",
      prompt: "Teste",
      openrouterKeys: ["sk-or-v1-key1", "sk-or-v1-key2"],
    });

    expect(res.text).toBe("KEY2_AFTER_401");
    // 401/403 é problema de CREDENCIAL — vale pro modelo todos, marca a chave.
    expect(isEndpointDead("or_sk-or-v1…key1")).toBe(true);
  });

  it("429 num modelo free NÃO derruba os outros modelos da mesma chave", async () => {
    st.openrouterHandler = (_key, model) =>
      model.includes("gemma")
        ? { status: 429, content: "", msg: "Rate limit exceeded" }
        : { status: 200, content: "OTHER_MODEL_OK", msg: "" };

    // Modelo A estoura quota nas duas chaves (e o degrau gpt-4o-mini da escada é tentado)...
    await generateText({
      modelRef: "openrouter:google/gemma-x:free",
      prompt: "oi",
      openrouterKeys: ["sk-or-v1-key1", "sk-or-v1-key2"],
      noGatewayFallback: true, // Testa estritamente a rotação do modelo A sem subir a escada
    }).catch(() => {});
    expect(st.openrouterCalls).toHaveLength(2);

    st.openrouterCalls = [];
    // ...mas modelo B na MESMA chave responde na hora (sem cooldown cruzado).
    const res = await generateText({
      modelRef: "openrouter:nvidia/nemotron:free",
      prompt: "Outro modelo",
      openrouterKeys: ["sk-or-v1-key1", "sk-or-v1-key2"],
    });
    expect(res.text).toBe("OTHER_MODEL_OK");
    expect(st.openrouterCalls).toHaveLength(1);
    expect(st.openrouterCalls[0].key).toBe("sk-or-v1-key1");
  });

  it("não rotaciona em erro 400 (Bad Request - prompt inválido)", async () => {
    st.openrouterHandler = () => ({ status: 400, content: "", msg: "Bad request parameters" });

    await expect(
      generateText({
        modelRef: "openrouter:openai/gpt-4o-mini",
        prompt: "Teste 400",
        openrouterKeys: ["sk-or-v1-key1", "sk-or-v1-key2"],
      })
    ).rejects.toThrow("Bad request parameters");

    expect(st.openrouterCalls).toHaveLength(1);
    expect(st.openrouterCalls[0].key).toBe("sk-or-v1-key1");
  });

  it("pula chave em cooldown na próxima chamada", async () => {
    st.openrouterHandler = (key) => {
      if (key === "sk-or-v1-key1") {
        return { status: 429, content: "", msg: "Rate limit" };
      }
      return { status: 200, content: "KEY2_OK", msg: "" };
    };

    // Chamada 1: key1 falha (429) -> key2 responde -> key1 entra em cooldown
    await generateText({
      modelRef: "openrouter:openai/gpt-4o-mini",
      prompt: "Chamada 1",
      openrouterKeys: ["sk-or-v1-key1", "sk-or-v1-key2"],
    });
    expect(st.openrouterCalls).toHaveLength(2);

    st.openrouterCalls = [];

    // Chamada 2: key1 está em cooldown -> vai direto pra key2
    const res2 = await generateText({
      modelRef: "openrouter:openai/gpt-4o-mini",
      prompt: "Chamada 2",
      openrouterKeys: ["sk-or-v1-key1", "sk-or-v1-key2"],
    });
    expect(res2.text).toBe("KEY2_OK");
    expect(st.openrouterCalls).toHaveLength(1);
    expect(st.openrouterCalls[0].key).toBe("sk-or-v1-key2");
  });

  it("respeita a ordem de prioridade definida na lista de chaves", async () => {
    st.openrouterHandler = (_key) => ({ status: 200, content: "PRIORITY_OK", msg: "" });

    const res = await generateText({
      modelRef: "openrouter:openai/gpt-4o-mini",
      prompt: "Ordem prioridade",
      openrouterKeys: ["sk-or-v1-custom-first", "sk-or-v1-custom-second"],
    });

    expect(res.text).toBe("PRIORITY_OK");
    expect(st.openrouterCalls).toHaveLength(1);
    expect(st.openrouterCalls[0].key).toBe("sk-or-v1-custom-first");
  });
});
