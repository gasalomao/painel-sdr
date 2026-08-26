import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks de infra (mesmo padrão do whisper-transcription.test.ts) ----
vi.mock("@/lib/whisper-manager", () => ({
  transcribeAudioWithWhisper: vi.fn(),
  isWhisperInstalled: vi.fn(() => false),
  ensureWhisper: vi.fn(),
  getWhisperStatus: vi.fn(async () => ({ installed: false, disabled: false, model: "ggml-base.bin" })),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null })) })) })),
    })),
    storage: { getBucket: vi.fn(), createBucket: vi.fn(), from: vi.fn() },
  },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null })) })) })),
    })),
  },
  supabaseAdmin: null,
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => "test-client"),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn(),
}));

vi.mock("@/lib/organizer-config-cache", () => ({
  getOrganizerConfig: vi.fn(async () => null),
}));

vi.mock("@/lib/gemini-model-discovery", () => ({
  buildFallbackChain: vi.fn(async () => []),
}));

const MOCK_KEYS = ["key-A", "key-B"];
vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({
    gemini: null,
    openrouter: "key-A",
    openrouterKeys: MOCK_KEYS,
    gatewayBaseUrl: null,
    gatewayApiKey: null,
    gatewayFallbackModel: null,
    gatewayEndpoints: [],
    aiCombos: [],
  })),
}));

// Modelos OpenRouter simulados: 1 grátis com áudio, 2 pagos (1 com áudio), 1 sem áudio.
// NOTA: sobrescrevemos TAMBÉM listOpenRouterAudioModels porque dentro do módulo
// ela chama a listAvailableOpenRouterModels real diretamente (mock de export
// não altera referências internas).
vi.mock("@/lib/openrouter-model-discovery", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/openrouter-model-discovery")>();
  const MODELS = [
    { id: "paid/audio-a", name: "Paid Audio A", supportsTools: false, pricing: { prompt: "0.0001" }, inputModalities: ["text", "audio"] },
    { id: "free/audio-b", name: "Free Audio B", supportsTools: false, pricing: { prompt: "0" }, inputModalities: ["text", "audio"] },
    { id: "free/no-audio-c", name: "Free NoAudio C", supportsTools: false, pricing: { prompt: "0" }, inputModalities: ["text"] },
    { id: "paid/no-modality-d", name: "Paid D", supportsTools: false, pricing: { prompt: "0.001" } },
  ];
  return {
    ...mod,
    listAvailableOpenRouterModels: vi.fn(async () => MODELS as any),
    listOpenRouterAudioModels: vi.fn(async () =>
      mod.sortAudioModelsFreeFirst(MODELS.filter((m) => mod.isOpenRouterAudioModel(m as any))) as any),
    __MODELS: MODELS,
  };
});

describe("openrouter-model-discovery — helpers de áudio", () => {
  it("isOpenRouterAudioModel filtra por input_modalities", async () => {
    const { isOpenRouterAudioModel } = await import("@/lib/openrouter-model-discovery");
    expect(isOpenRouterAudioModel({ id: "x", name: "x", supportsTools: false, inputModalities: ["text", "audio"] })).toBe(true);
    expect(isOpenRouterAudioModel({ id: "x", name: "x", supportsTools: false, inputModalities: ["text"] })).toBe(false);
    expect(isOpenRouterAudioModel({ id: "x", name: "x", supportsTools: false })).toBe(false);
  });

  it("listOpenRouterAudioModels retorna só áudio, grátis primeiro", async () => {
    const { listOpenRouterAudioModels } = await import("@/lib/openrouter-model-discovery");
    const list = await listOpenRouterAudioModels(true);
    expect(list.map((m) => m.id)).toEqual(["free/audio-b", "paid/audio-a"]);
  });
});

describe("openrouter-transcription — cadeia e chamadas", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  // Estado de saúde (breaker/blocked) vive no módulo — zera entre testes.
  beforeEach(async () => {
    const mod = await import("@/lib/openrouter-transcription");
    mod.__resetOpenRouterHealthForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("buildAudioAttemptChain ordena grátis primeiro e respeita cap", async () => {
    const { buildAudioAttemptChain } = await import("@/lib/openrouter-transcription");
    const chain = buildAudioAttemptChain([
      { id: "paid/a", pricing: { prompt: "0.01" } },
      { id: "free/b", pricing: { prompt: "0" } },
      { id: "free/c", pricing: { prompt: "0.0" } },
      { id: "paid/d", pricing: {} },
    ]);
    expect(chain).toEqual(["free/b", "free/c", "paid/a", "paid/d"]); // preço desconhecido = pago (vai pro fim)
    expect(buildAudioAttemptChain(
      [{ id: "a" }, { id: "b" }, { id: "c" }].map((m) => ({ id: m.id, pricing: { prompt: "0" } })),
      2,
    )).toEqual(["a", "b"]);
  });

  it("audioFormatFromMime mapeia mimetypes do WhatsApp", async () => {
    const { audioFormatFromMime } = await import("@/lib/openrouter-transcription");
    expect(audioFormatFromMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(audioFormatFromMime("audio/mpeg")).toBe("mp3");
    expect(audioFormatFromMime("audio/webm")).toBe("webm");
    expect(audioFormatFromMime(null)).toBe("ogg");
  });

  // ===== ORDEM CUSTOMIZADA (seletor de modelos na UI) =====

  it("buildAudioAttemptChain respeita ordem customizada e filtra ids desconhecidos/duplicados", async () => {
    const { buildAudioAttemptChain } = await import("@/lib/openrouter-transcription");
    const models = [
      { id: "free/b", pricing: { prompt: "0" } },
      { id: "paid/a", pricing: { prompt: "0.01" } },
      { id: "paid/c", pricing: { prompt: "0.02" } },
    ];
    // Ordem do usuário vence (mesmo pagos antes de grátis)
    expect(buildAudioAttemptChain(models, 8, ["paid/c", "free/b"])).toEqual(["paid/c", "free/b"]);
    // Id desconhecido é descartado; duplicado entra uma vez
    expect(buildAudioAttemptChain(models, 8, ["nao/existe", "paid/a", "paid/a"])).toEqual(["paid/a"]);
    // Sem customOrder → comportamento padrão (grátis primeiro)
    expect(buildAudioAttemptChain(models, 8, [])).toEqual(["free/b", "paid/a", "paid/c"]);
    expect(buildAudioAttemptChain(models, 8, undefined)).toEqual(["free/b", "paid/a", "paid/c"]);
  });

  it("transcribeAudioWithOpenRouter usa a ordem escolhida pelo usuário via opts.models", async () => {
    fetchMock = vi.fn(async (_url: any, init?: any) => {
      const model = JSON.parse(init.body).model;
      if (model === "paid/audio-a") return new Response(JSON.stringify({ choices: [{ message: { content: "ok pago" } }] }), { status: 200 });
      return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { transcribeAudioWithOpenRouter } = await import("@/lib/openrouter-transcription");
    const r = await transcribeAudioWithOpenRouter("dGVzdA==", "audio/ogg", {
      models: ["paid/audio-a", "free/audio-b"], // usuário quer o pago PRIMEIRO
    });
    expect(r).toEqual({ text: "ok pago", model: "paid/audio-a" });
    // 1ª tentativa = modelo que o usuário escolheu primeiro
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("paid/audio-a");
    // Só tenta os escolhidos — o 2º modelo nunca é chamado (1º retornou ok)
    const triedModels = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body).model);
    expect(triedModels).toEqual(["paid/audio-a"]);
  });

  it("tenta grátis primeiro; chave 429 → rotaciona pra próxima chave antes do próximo modelo", async () => {
    fetchMock = vi.fn(async (url: any, init?: any) => {
      const model = JSON.parse(init.body).model;
      const auth = init.headers.Authorization;
      if (model === "free/audio-b") {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ola gratis" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { transcribeAudioWithOpenRouter } = await import("@/lib/openrouter-transcription");
    const r = await transcribeAudioWithOpenRouter("dGVzdA==", "audio/ogg");
    expect(r).toEqual({ text: "ola gratis", model: "free/audio-b" });

    // 1ª chamada = free/audio-b com key-A (grátis primeiro)
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstBody.model).toBe("free/audio-b");
    expect(firstBody.messages[0].content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: "dGVzdA==", format: "ogg" },
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer key-A");
  });

  it("fallback entre modelos: todos falham → null; pagos tentados após grátis", async () => {
    fetchMock = vi.fn(async (_url: any, _init?: any) =>
      new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const { transcribeAudioWithOpenRouter } = await import("@/lib/openrouter-transcription");
    const r = await transcribeAudioWithOpenRouter("dGVzdA==", "audio/mpeg");

    expect(r).toBeNull();
    // 2 modelos de áudio × 2 chaves = 4 tentativas
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const triedModels = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body).model);
    expect(triedModels).toEqual([
      "free/audio-b", "free/audio-b",   // grátis × key-A, key-B
      "paid/audio-a", "paid/audio-a",   // pago × key-A, key-B
    ]);
    // formato derivado do mime
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content[1].input_audio.format).toBe("mp3");
  });

  it("403/400/404 = erro de MODELO: não queima as outras chaves, pula pro próximo modelo", async () => {
    // Caso real visto ao vivo: ":free" responde 403 "only available on agentic
    // harnesses" — trocar chave não resolve nenhum pouco.
    fetchMock = vi.fn(async (_url: any, init?: any) => {
      const model = JSON.parse(init.body).model;
      if (model === "paid/audio-a") return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "only available on agentic harnesses" } }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { transcribeAudioWithOpenRouter } = await import("@/lib/openrouter-transcription");
    const r = await transcribeAudioWithOpenRouter("dGVzdA==", "audio/ogg");

    expect(r).toEqual({ text: "ok", model: "paid/audio-a" });
    // free/audio-b: UMA tentativa só (403 pula as demais chaves e o modelo)
    const triedModels = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body).model);
    expect(triedModels).toEqual(["free/audio-b", "paid/audio-a"]);
  });

  it("modelo bloqueado fica em cache e é pulado SEM rede na próxima chamada", async () => {
    const mod = await import("@/lib/openrouter-transcription");
    mod.__resetOpenRouterHealthForTests();

    // Fase 1: free bloqueia (403), pago responde → marca só o free
    fetchMock = vi.fn(async (_url: any, init?: any) => {
      const model = JSON.parse(init.body).model;
      if (model === "paid/audio-a") return new Response(JSON.stringify({ choices: [{ message: { content: "ok1" } }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "blocked" } }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r1 = await mod.transcribeAudioWithOpenRouter("dGVzdA==", "audio/ogg");
    expect(r1?.model).toBe("paid/audio-a");

    // Fase 2: novo mock conta chamadas — free NEM PODE ser chamado (cache)
    fetchMock = vi.fn(async (_url: any, init?: any) =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok2" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r2 = await mod.transcribeAudioWithOpenRouter("dGVzdA==", "audio/ogg");

    expect(r2?.model).toBe("paid/audio-a");
    const triedModels = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body).model);
    expect(triedModels).toEqual(["paid/audio-a"]); // bloqueado pulado sem rede
  });

  it("circuit breaker: OpenRouter inteiro fora → próximas chamadas nem batem na rede", async () => {
    const mod = await import("@/lib/openrouter-transcription");
    mod.__resetOpenRouterHealthForTests();
    let calls = 0;
    fetchMock = vi.fn(async () => { calls++; return new Response("{}", { status: 500 }); });
    vi.stubGlobal("fetch", fetchMock);

    await mod.transcribeAudioWithOpenRouter("dGVzdA==", "audio/ogg"); // tudo falha → breaker abre
    const callsAfterFirst = calls;

    const r = await mod.transcribeAudioWithOpenRouter("dGVzdA==", "audio/ogg");
    expect(r).toBeNull();
    expect(calls).toBe(callsAfterFirst); // ZERO novas chamadas de rede
  });

  it("resposta vazia não é aceita como sucesso", async () => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { transcribeAudioWithOpenRouter } = await import("@/lib/openrouter-transcription");
    expect(await transcribeAudioWithOpenRouter("dGVzdA==", "audio/ogg")).toBeNull();
  });
});

describe("shared-helpers transcribeAudio — ordem de fallback com OpenRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('método "openrouter": OpenRouter primeiro; se falhar cai pro whisper', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
    (transcribeAudioWithWhisper as any).mockResolvedValue("texto do whisper");

    const { transcribeAudioDetailed } = await import("@/app/api/webhooks/shared-helpers");
    const r = await transcribeAudioDetailed("dGVzdA==", "audio/ogg", "m1", "openrouter");

    expect(r).toEqual({ text: "texto do whisper", provider: "whisper" });
    expect(transcribeAudioWithWhisper).toHaveBeenCalledOnce();
  });

  it('método "openrouter": sucesso no OpenRouter NÃO chama whisper nem gemini', async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "transcricao OR" } }] }), { status: 200 })));
    const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
    (transcribeAudioWithWhisper as any).mockResolvedValue("nao deveria");

    const { transcribeAudioDetailed } = await import("@/app/api/webhooks/shared-helpers");
    const r = await transcribeAudioDetailed("dGVzdA==", "audio/ogg", "m2", "openrouter");

    expect(r?.provider.startsWith("openrouter:")).toBe(true);
    expect(r?.text).toBe("transcricao OR");
    expect(transcribeAudioWithWhisper).not.toHaveBeenCalled();
  });

  it("extra.models é repassado ao OpenRouter — ordem escolhida pelo usuário vence no modo auto", async () => {
    const fetchSpy = vi.fn(async (_url: any, init?: any) => {
      const model = JSON.parse(init.body).model;
      if (model === "paid/audio-a") return new Response(JSON.stringify({ choices: [{ message: { content: "via custom" } }] }), { status: 200 });
      return new Response(JSON.stringify({ error: "no" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
    (transcribeAudioWithWhisper as any).mockResolvedValue(null);

    const { transcribeAudioDetailed } = await import("@/app/api/webhooks/shared-helpers");
    const r = await transcribeAudioDetailed("dGVzdA==", "audio/ogg", "m5", "auto", {
      models: ["paid/audio-a", "free/audio-b"],
    });

    expect(r).toEqual({ text: "via custom", provider: "openrouter:paid/audio-a" });
    expect(String(fetchSpy.mock.calls[0][0])).toContain("openrouter.ai");
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe("paid/audio-a");
  });

  it('método "auto": whisper → openrouter → gemini (OR tentado antes do Gemini)', async () => {
    const fetchSpy = vi.fn(async (_url: any, _init?: any) => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
    (transcribeAudioWithWhisper as any).mockResolvedValue(null);
    // Sem config Gemini (getOrganizerConfig → null) e chain vazia → gemini falha rápido.

    const { transcribeAudioDetailed } = await import("@/app/api/webhooks/shared-helpers");
    const r = await transcribeAudioDetailed("dGVzdA==", "audio/ogg", "m3", "auto");

    expect(r).toBeNull();
    // Prova da ordem: houve chamadas HTTP ao OpenRouter mesmo com Gemini desconfigurado.
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("openrouter.ai");
  });

  it("método disabled → null sem tocar em nada", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { transcribeAudioDetailed } = await import("@/app/api/webhooks/shared-helpers");
    expect(await transcribeAudioDetailed("dGVzdA==", "audio/ogg", "m4", "disabled")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
