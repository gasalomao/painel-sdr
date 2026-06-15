/**
 * Testes determinísticos da camada unificada de provedores (ai-provider.ts).
 * SEM rede real: fetch (OpenRouter) e o SDK do Gemini são mockados.
 *
 * Cobre o que NÃO pode quebrar ao trocar de modelo/provedor:
 *  - parse/format do modelRef (retrocompatibilidade total com Gemini "bare")
 *  - generateText nos 2 provedores (+ jsonMode)
 *  - startAiChat: tool-calling OpenRouter, fallback de modelo morto Gemini
 *  - PRESERVAÇÃO DE CONTEXTO: histórico/ordem entregues idênticos aos 2 provedores
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Holders mutáveis pro mock do SDK Gemini (vi.hoisted = seguro com hoisting).
const h = vi.hoisted(() => ({
  getModelCalls: [] as any[],
  startChatHistory: null as any,
  sendMessageCalls: [] as any[],
  sendMessageImpl: (..._a: any[]) => ({}) as any,
  generateContentImpl: (..._a: any[]) => ({}) as any,
  pickBest: null as string | null,
}));

vi.mock("@google/generative-ai", () => ({
  SchemaType: { OBJECT: "object", STRING: "string", NUMBER: "number", ARRAY: "array", BOOLEAN: "boolean", INTEGER: "integer" },
  GoogleGenerativeAI: class {
    constructor(_key: string) {}
    getGenerativeModel(cfg: any) {
      h.getModelCalls.push(cfg);
      return {
        startChat: (opts: any) => {
          h.startChatHistory = opts?.history;
          return { sendMessage: (...a: any[]) => { h.sendMessageCalls.push(a); return h.sendMessageImpl(...a); } };
        },
        generateContent: (...a: any[]) => h.generateContentImpl(...a),
      };
    }
  },
}));

vi.mock("@/lib/gemini-model-discovery", () => ({
  pickBestFlashModel: async () => h.pickBest,
}));

// fetch mockado pro OpenRouter
let fetchMock: any;
beforeEach(() => {
  h.getModelCalls = [];
  h.startChatHistory = null;
  h.sendMessageCalls = [];
  h.sendMessageImpl = () => ({ response: { text: () => "", functionCalls: () => [], usageMetadata: {} } });
  h.generateContentImpl = () => ({ response: { text: () => "", usageMetadata: {} } });
  h.pickBest = null;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function orResponse(body: any) {
  return { ok: true, status: 200, json: async () => body };
}

// ===================================================================
// parseModelRef / formatModelRef / providerOf
// ===================================================================
describe("modelRef — roteamento e retrocompatibilidade", () => {
  it("modelo Gemini 'bare' (legado) = provider gemini", async () => {
    const { parseModelRef, providerOf } = await import("../ai-provider");
    expect(parseModelRef("gemini-2.5-flash")).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
    expect(providerOf("gemini-2.5-flash")).toBe("gemini");
  });

  it("normaliza prefixo models/", async () => {
    const { parseModelRef } = await import("../ai-provider");
    expect(parseModelRef("models/gemini-2.5-flash")).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });

  it("prefixo gemini: explícito", async () => {
    const { parseModelRef } = await import("../ai-provider");
    expect(parseModelRef("gemini:gemini-2.5-pro")).toEqual({ provider: "gemini", model: "gemini-2.5-pro" });
  });

  it("prefixo openrouter: → provider openrouter, model com a barra preservada", async () => {
    const { parseModelRef, providerOf } = await import("../ai-provider");
    expect(parseModelRef("openrouter:anthropic/claude-3.5-sonnet")).toEqual({ provider: "openrouter", model: "anthropic/claude-3.5-sonnet" });
    expect(providerOf("openrouter:openai/gpt-4o")).toBe("openrouter");
  });

  it("formatModelRef ida e volta", async () => {
    const { formatModelRef, parseModelRef } = await import("../ai-provider");
    expect(formatModelRef("openrouter", "meta-llama/llama-3.1-70b")).toBe("openrouter:meta-llama/llama-3.1-70b");
    expect(formatModelRef("gemini", "gemini-2.5-flash")).toBe("gemini-2.5-flash"); // bare
    const ref = formatModelRef("openrouter", "x/y");
    expect(parseModelRef(ref)).toEqual({ provider: "openrouter", model: "x/y" });
  });

  it("vazio/null = gemini com model vazio (não explode)", async () => {
    const { parseModelRef } = await import("../ai-provider");
    expect(parseModelRef("")).toEqual({ provider: "gemini", model: "" });
    expect(parseModelRef(null)).toEqual({ provider: "gemini", model: "" });
    expect(parseModelRef(undefined)).toEqual({ provider: "gemini", model: "" });
  });
});

// ===================================================================
// generateText
// ===================================================================
describe("generateText", () => {
  it("OpenRouter: envia model/messages corretos e devolve texto + usage", async () => {
    fetchMock.mockResolvedValue(orResponse({
      choices: [{ message: { content: "olá mundo" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    const { generateText } = await import("../ai-provider");
    const out = await generateText({
      modelRef: "openrouter:openai/gpt-4o-mini",
      system: "Você é um SDR",
      prompt: "Boa tarde",
      openrouterApiKey: "sk-or-test",
    });
    expect(out.text).toBe("olá mundo");
    expect(out.provider).toBe("openrouter");
    expect(out.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect(opts.headers.Authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("openai/gpt-4o-mini"); // sem prefixo
    expect(body.messages[0]).toEqual({ role: "system", content: "Você é um SDR" });
    expect(body.messages[1]).toEqual({ role: "user", content: "Boa tarde" });
  });

  it("OpenRouter jsonMode → manda response_format json_object", async () => {
    fetchMock.mockResolvedValue(orResponse({ choices: [{ message: { content: "{}" } }], usage: {} }));
    const { generateText } = await import("../ai-provider");
    await generateText({ modelRef: "openrouter:x/y", prompt: "p", jsonMode: true, openrouterApiKey: "k" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("OpenRouter sem chave → erro claro", async () => {
    const { generateText } = await import("../ai-provider");
    await expect(generateText({ modelRef: "openrouter:x/y", prompt: "p" })).rejects.toThrow(/OpenRouter/i);
  });

  it("Gemini: usa o SDK e devolve texto + usage", async () => {
    h.generateContentImpl = () => ({
      response: { text: () => "resposta gemini", usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } },
    });
    const { generateText } = await import("../ai-provider");
    const out = await generateText({ modelRef: "gemini-2.5-flash", prompt: "oi", geminiApiKey: "AIza" });
    expect(out.text).toBe("resposta gemini");
    expect(out.provider).toBe("gemini");
    expect(out.usage.totalTokens).toBe(10);
    expect(fetchMock).not.toHaveBeenCalled(); // Gemini não usa fetch aqui
  });

  it("Gemini: modelo morto (404 generateContent) → fallback automático pro best", async () => {
    let call = 0;
    h.generateContentImpl = () => {
      call++;
      if (call === 1) throw new Error("[404] models/gemini-x is not found for API version v1beta generateContent");
      return { response: { text: () => "ok no fallback", usageMetadata: {} } };
    };
    h.pickBest = "gemini-2.5-flash";
    const { generateText } = await import("../ai-provider");
    const out = await generateText({ modelRef: "gemini-x-morto", prompt: "oi", geminiApiKey: "AIza" });
    expect(out.text).toBe("ok no fallback");
    expect(out.didFallback).toBe(true);
    expect(out.modelUsed).toBe("gemini-2.5-flash");
  });
});

// ===================================================================
// startAiChat — OpenRouter (tool-calling) + contexto
// ===================================================================
describe("startAiChat OpenRouter — ferramentas e contexto", () => {
  const tools = [{
    name: "buscar",
    description: "busca",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  }];

  it("monta system + histórico (model→assistant) e formato de tools OpenAI", async () => {
    fetchMock.mockResolvedValue(orResponse({ choices: [{ message: { content: "resposta" } }], usage: {} }));
    const { startAiChat } = await import("../ai-provider");
    const session = await startAiChat({
      modelRef: "openrouter:anthropic/claude-3.5-sonnet",
      systemInstruction: "PERSONA",
      history: [
        { role: "user", text: "primeira do cliente" },
        { role: "model", text: "resposta anterior da IA" },
      ],
      tools,
      openrouterApiKey: "k",
    });
    const turn = await session.sendUser("nova mensagem");
    expect(turn.text).toBe("resposta");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("anthropic/claude-3.5-sonnet");
    // contexto preservado, na ordem certa, com system na frente
    expect(body.messages[0]).toEqual({ role: "system", content: "PERSONA" });
    expect(body.messages[1]).toEqual({ role: "user", content: "primeira do cliente" });
    expect(body.messages[2]).toEqual({ role: "assistant", content: "resposta anterior da IA" });
    expect(body.messages[3]).toEqual({ role: "user", content: "nova mensagem" });
    // tools no formato OpenAI
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("buscar");
    expect(body.tool_choice).toBe("auto");
  });

  it("tool call → sendToolResults responde com role:tool + tool_call_id e mantém TODO o contexto", async () => {
    // 1º request: modelo pede a tool. 2º: responde texto final.
    fetchMock
      .mockResolvedValueOnce(orResponse({
        choices: [{ message: { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "buscar", arguments: '{"q":"preço"}' } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }))
      .mockResolvedValueOnce(orResponse({
        choices: [{ message: { content: "achei: R$ 99" } }],
        usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
      }));

    const { startAiChat } = await import("../ai-provider");
    const session = await startAiChat({
      modelRef: "openrouter:x/y", systemInstruction: "S", history: [], tools, openrouterApiKey: "k",
    });
    const turn1 = await session.sendUser("quanto custa?");
    expect(turn1.toolCalls).toHaveLength(1);
    expect(turn1.toolCalls[0]).toMatchObject({ name: "buscar", args: { q: "preço" }, id: "call_1" });

    const turn2 = await session.sendToolResults([{ name: "buscar", id: "call_1", response: { price: 99 } }]);
    expect(turn2.text).toBe("achei: R$ 99");

    // O 2º request deve conter: system, user, assistant(tool_calls), tool(result) — contexto íntegro.
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    const roles = body2.messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    const toolMsg = body2.messages[3];
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMsg.content)).toEqual({ price: 99 });
    // a mensagem do assistente que pediu a tool foi preservada com tool_calls
    expect(body2.messages[2].tool_calls[0].id).toBe("call_1");
  });
});

// ===================================================================
// startAiChat — Gemini (ferramentas + fallback) + contexto
// ===================================================================
describe("startAiChat Gemini — ferramentas, fallback e contexto", () => {
  const tools = [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }];

  it("passa histórico pro startChat e tools como functionDeclarations", async () => {
    h.sendMessageImpl = () => ({ response: { text: () => "oi", functionCalls: () => [], usageMetadata: { totalTokenCount: 5 } } });
    const { startAiChat } = await import("../ai-provider");
    const session = await startAiChat({
      modelRef: "gemini-2.5-flash",
      systemInstruction: "S",
      history: [{ role: "user", text: "hist" }, { role: "model", text: "ans" }],
      tools,
      geminiApiKey: "AIza",
    });
    const turn = await session.sendUser("msg");
    expect(turn.text).toBe("oi");
    // histórico preservado no formato Gemini
    expect(h.startChatHistory).toEqual([
      { role: "user", parts: [{ text: "hist" }] },
      { role: "model", parts: [{ text: "ans" }] },
    ]);
    // tools embrulhadas
    const cfg = h.getModelCalls[0];
    expect(cfg.tools[0].functionDeclarations[0].name).toBe("t");
    expect(cfg.systemInstruction).toBe("S");
  });

  it("functionCalls do Gemini viram toolCalls neutras; sendToolResults usa functionResponse", async () => {
    let n = 0;
    h.sendMessageImpl = (...a: any[]) => {
      n++;
      if (n === 1) return { response: { text: () => "", functionCalls: () => [{ name: "t", args: { x: 1 } }], usageMetadata: {} } };
      return { response: { text: () => "final", functionCalls: () => [], usageMetadata: {} } };
    };
    const { startAiChat } = await import("../ai-provider");
    const session = await startAiChat({ modelRef: "gemini-2.5-flash", systemInstruction: "S", history: [], tools, geminiApiKey: "AIza" });
    const t1 = await session.sendUser("oi");
    expect(t1.toolCalls).toEqual([{ name: "t", args: { x: 1 } }]);
    const t2 = await session.sendToolResults([{ name: "t", response: { ok: true } }]);
    expect(t2.text).toBe("final");
    // 2ª chamada enviou functionResponse
    const secondCallArg = h.sendMessageCalls[1][0];
    expect(secondCallArg[0].functionResponse).toEqual({ name: "t", response: { ok: true } });
  });

  it("modelo morto no 1º sendUser → troca de modelo e refaz", async () => {
    let n = 0;
    h.sendMessageImpl = () => {
      n++;
      if (n === 1) throw new Error("404 ... generateContent models/xx no longer available");
      return { response: { text: () => "recuperado", functionCalls: () => [], usageMetadata: {} } };
    };
    h.pickBest = "gemini-2.5-flash";
    const { startAiChat } = await import("../ai-provider");
    const session = await startAiChat({ modelRef: "gemini-morto", systemInstruction: "S", history: [], tools, geminiApiKey: "AIza" });
    const turn = await session.sendUser("oi");
    expect(turn.text).toBe("recuperado");
    expect(session.modelUsed()).toBe("gemini-2.5-flash");
  });
});

// ===================================================================
// MCP / FERRAMENTAS no OpenRouter — Google Calendar, chaining, no-params,
// e degradação graciosa (nunca quebra)
// ===================================================================
describe("ferramentas (MCP) no OpenRouter", () => {
  // Conjunto realista de tools do Agente SDR (calendar + KB + funil).
  const agentTools = [
    { name: "search_knowledge_base", description: "KB", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "check_google_calendar_availability", description: "disp", parameters: { type: "object", properties: { date: { type: "string" } }, required: ["date"] } },
    { name: "schedule_google_calendar", description: "agenda", parameters: { type: "object", properties: { summary: { type: "string" }, start_datetime: { type: "string" } }, required: ["summary", "start_datetime"] } },
    { name: "list_google_calendar_events", description: "lista", parameters: { type: "object", properties: { date_from: { type: "string" } }, required: ["date_from"] } },
    { name: "cancel_google_calendar_event", description: "cancela", parameters: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] } },
    // tool SEM parâmetros (caso real: complete_current_stage)
    { name: "complete_current_stage", description: "avança etapa" },
  ];

  it("todas as tools viram schema OpenAI válido (inclusive a sem parâmetros)", async () => {
    fetchMock.mockResolvedValue(orResponse({ choices: [{ message: { content: "ok" } }], usage: {} }));
    const { startAiChat } = await import("../ai-provider");
    const s = await startAiChat({ modelRef: "openrouter:openai/gpt-4o", systemInstruction: "S", history: [], tools: agentTools, openrouterApiKey: "k" });
    await s.sendUser("oi");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(6);
    for (const t of body.tools) {
      expect(t.type).toBe("function");
      expect(typeof t.function.name).toBe("string");
      // parameters SEMPRE presente e objeto (OpenAI exige) — mesmo a tool sem params
      expect(t.function.parameters).toBeTruthy();
      expect(t.function.parameters.type).toBe("object");
    }
    const stage = body.tools.find((t: any) => t.function.name === "complete_current_stage");
    expect(stage.function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("ENCADEAMENTO Google Calendar: list_events → cancel_event → texto final (igual ao Gemini)", async () => {
    fetchMock
      // turno 1: modelo pede pra LISTAR eventos
      .mockResolvedValueOnce(orResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "list_google_calendar_events", arguments: '{"date_from":"2026-06-10"}' } }] } }], usage: { total_tokens: 50 } }))
      // turno 2: com o resultado, pede pra CANCELAR
      .mockResolvedValueOnce(orResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "cancel_google_calendar_event", arguments: '{"event_id":"evt_42"}' } }] } }], usage: { total_tokens: 60 } }))
      // turno 3: confirma ao cliente
      .mockResolvedValueOnce(orResponse({ choices: [{ message: { content: "Pronto, sua reunião foi cancelada." } }], usage: { total_tokens: 30 } }));

    const { startAiChat } = await import("../ai-provider");
    const s = await startAiChat({ modelRef: "openrouter:anthropic/claude-3.5-sonnet", systemInstruction: "S", history: [], tools: agentTools, openrouterApiKey: "k" });

    const t1 = await s.sendUser("quero cancelar minha reunião de quarta");
    expect(t1.toolCalls[0].name).toBe("list_google_calendar_events");

    const t2 = await s.sendToolResults([{ name: "list_google_calendar_events", id: "c1", response: { events: [{ id: "evt_42", summary: "Reunião" }] } }]);
    expect(t2.toolCalls[0].name).toBe("cancel_google_calendar_event");
    expect(t2.toolCalls[0].args).toEqual({ event_id: "evt_42" });

    const t3 = await s.sendToolResults([{ name: "cancel_google_calendar_event", id: "c2", response: { cancelled: true } }]);
    expect(t3.text).toContain("cancelada");
    expect(t3.toolCalls).toHaveLength(0);

    // O 3º request carrega a cadeia inteira, sem perder nada:
    const roles = JSON.parse(fetchMock.mock.calls[2][1].body).messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "tool"]);
  });

  it("modelo SEM suporte a ferramentas → degrada pra chat puro (NUNCA quebra)", async () => {
    fetchMock
      // 1ª tentativa COM tools → OpenRouter recusa
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: { message: "No endpoints found that support tool use" } }) })
      // retry SEM tools → responde normal
      .mockResolvedValueOnce(orResponse({ choices: [{ message: { content: "Posso ajudar mesmo assim!" } }], usage: {} }));

    const { startAiChat } = await import("../ai-provider");
    const s = await startAiChat({ modelRef: "openrouter:algum/modelo-sem-tools", systemInstruction: "S", history: [], tools: agentTools, openrouterApiKey: "k" });
    const turn = await s.sendUser("oi");
    expect(turn.text).toBe("Posso ajudar mesmo assim!"); // não lançou erro
    // 1º request tinha tools; o retry (2º) NÃO tem tools
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).tools).toBeUndefined();
  });
});

// ===================================================================
// GARANTIA DE CONTEXTO: mesmo histórico entregue idêntico aos 2 provedores
// ===================================================================
describe("preservação de contexto entre provedores", () => {
  it("o MESMO histórico chega íntegro tanto no Gemini quanto no OpenRouter", async () => {
    const history = [
      { role: "user" as const, text: "msg1 cliente" },
      { role: "model" as const, text: "msg2 ia" },
      { role: "user" as const, text: "msg3 cliente" },
    ];
    const { startAiChat } = await import("../ai-provider");

    // Gemini
    h.sendMessageImpl = () => ({ response: { text: () => "g", functionCalls: () => [], usageMetadata: {} } });
    const gem = await startAiChat({ modelRef: "gemini-2.5-flash", systemInstruction: "S", history, tools: [], geminiApiKey: "AIza" });
    await gem.sendUser("nova");
    const gemTexts = h.startChatHistory.map((m: any) => m.parts[0].text);

    // OpenRouter
    fetchMock.mockResolvedValue(orResponse({ choices: [{ message: { content: "o" } }], usage: {} }));
    const orr = await startAiChat({ modelRef: "openrouter:x/y", systemInstruction: "S", history, tools: [], openrouterApiKey: "k" });
    await orr.sendUser("nova");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const orTexts = body.messages.filter((m: any) => m.role !== "system" && m.content !== "nova").map((m: any) => m.content);

    // Os textos do histórico são idênticos e na mesma ordem nos dois provedores.
    expect(gemTexts).toEqual(["msg1 cliente", "msg2 ia", "msg3 cliente"]);
    expect(orTexts).toEqual(["msg1 cliente", "msg2 ia", "msg3 cliente"]);
  });
});
