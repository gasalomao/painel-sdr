import { beforeEach, describe, expect, it, vi } from "vitest";
import { needsFreshWebSearch, webFetchPage } from "../web-search";
import { cheapModelForSummary } from "../history-summary";

const mockState = vi.hoisted(() => ({
  appSettings: new Map<string, string>(),
  sessionWrites: [] as Array<{ action: string; payload: Record<string, unknown>; eqs: Array<[string, unknown]> }>,
  supabaseFrom: vi.fn(),
  axiosMock: vi.fn(),
  evoInstances: [] as Array<{ name?: string; instanceName?: string }>,
}));

vi.mock("axios", () => ({
  default: mockState.axiosMock,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: mockState.supabaseFrom },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { from: mockState.supabaseFrom },
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({
    gemini: "gem-test-key",
    openrouter: "or-test-key",
    nvidia: null,
    gatewayEndpoints: [],
  })),
}));

vi.mock("@/lib/safe-url", () => ({
  assertPublicHttpUrlResolved: vi.fn(async () => ({ ok: true })),
  fetchPublicHttpUrl: vi.fn(async () => new Response("", { status: 404 })),
}));

function buildMockQuery(table: string) {
  const eqs: Array<[string, unknown]> = [];
  let inValues: unknown[] | null = null;
  const query: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "or", "gte", "gt", "lt", "neq"]) {
    query[m] = vi.fn(() => query);
  }
  query.eq = vi.fn((col: string, val: unknown) => {
    eqs.push([col, val]);
    return query;
  });
  query.in = vi.fn((_col: string, vals: unknown[]) => {
    inValues = vals;
    return query;
  });
  query.maybeSingle = vi.fn(async () => {
    if (table === "sessions") return { data: null, error: null };
    if (table === "app_settings") {
      const keyFilter = eqs.find(([c]) => c === "key")?.[1];
      const val = typeof keyFilter === "string" ? mockState.appSettings.get(keyFilter) : undefined;
      return { data: val !== undefined ? { key: keyFilter, value: val } : null, error: null };
    }
    return { data: null, error: null };
  });
  query.single = vi.fn(async () => {
    if (table === "sessions") {
      return { data: { id: "sess-1", bot_status: "bot_active" }, error: null };
    }
    return { data: { id: "row-1" }, error: null };
  });
  query.insert = vi.fn((payload: Record<string, unknown>) => {
    mockState.sessionWrites.push({ action: "insert", payload, eqs });
    return query;
  });
  query.update = vi.fn((payload: Record<string, unknown>) => {
    mockState.sessionWrites.push({ action: "update", payload, eqs });
    return query;
  });
  query.upsert = vi.fn(async (payload: { key: string; value: string }) => {
    mockState.appSettings.set(payload.key, payload.value);
    return { data: null, error: null };
  });
  query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    if (table === "app_settings" && inValues) {
      const rows = inValues
        .filter((k): k is string => typeof k === "string" && mockState.appSettings.has(k))
        .map((k) => ({ key: k, value: mockState.appSettings.get(k) }));
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
    return Promise.resolve({ data: [], error: null }).then(resolve, reject);
  };
  return query;
}

describe("Auditoria IA — helpers puros e módulos de suporte", () => {
  beforeEach(() => {
    mockState.appSettings.clear();
    mockState.sessionWrites = [];
    mockState.supabaseFrom.mockImplementation((table: string) => buildMockQuery(table));
    mockState.axiosMock.mockReset();
    vi.unstubAllGlobals();
  });

  describe("T6 — web-search evita falsos positivos e limita fetch", () => {
    it("não dispara busca web para perguntas locais sobre endereço, telefone ou horário", () => {
      expect(needsFreshWebSearch("Qual o endereço de vocês?")).toBe(false);
      expect(needsFreshWebSearch("Qual o telefone e horário de funcionamento?")).toBe(false);
      expect(needsFreshWebSearch("Onde fica a clínica?")).toBe(false);
      expect(needsFreshWebSearch("Qual o horário de atendimento sábado?")).toBe(false);
    });

    it("mantém busca web quando há pedido explícito ou tópico em tempo real", () => {
      expect(needsFreshWebSearch("Pesquise na internet o endereço oficial")).toBe(true);
      expect(needsFreshWebSearch("Qual a cotação do euro hoje?")).toBe(true);
    });

    it("limita webFetchPage em 12.000 caracteres (~3k tokens)", async () => {
      const hugeMarkdown = "A".repeat(25_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify({ data: { title: "Página", content: hugeMarkdown } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      const res = await webFetchPage("https://exemplo.com/longa");
      expect(res.success).toBe(true);
      expect((res.content || "").length).toBeLessThanOrEqual(12_050);
    });
  });

  describe("B2 & S3 — bot-status escopado por tenant e auto-pausa humana", () => {
    it("isola humanPauseConfig por clientId e aplica enabled/mode corretamente", async () => {
      const { getHumanPauseConfig, setHumanPauseConfig, applyHumanAutoPause } = await import("../bot-status");

      await setHumanPauseConfig({ enabled: false, minutes: 45, mode: "timed" }, "tenant-a");
      await setHumanPauseConfig({ enabled: true, minutes: 15, mode: "manual" }, "tenant-b");

      const cfgA = await getHumanPauseConfig("tenant-a");
      const cfgB = await getHumanPauseConfig("tenant-b");
      expect(cfgA).toEqual({ enabled: false, minutes: 45, mode: "timed" });
      expect(cfgB).toEqual({ enabled: true, minutes: 15, mode: "manual" });

      // Tenant A com enabled=false NÃO deve pausar a sessão
      const resA = await applyHumanAutoPause("sess-a", "tenant-a");
      expect(resA).toEqual({ paused: false });
      expect(mockState.sessionWrites).toHaveLength(0);

      // Tenant B com mode=manual deve pausar permanentemente (bot_paused)
      const resB = await applyHumanAutoPause("sess-b", "tenant-b");
      expect(resB).toEqual({ paused: true, mode: "manual" });
      expect(mockState.sessionWrites[0].payload.bot_status).toBe("bot_paused");
      expect(mockState.sessionWrites[0].payload.resume_at).toBeNull();
    });
  });

  describe("B1 — findOrCreateSession não escreve coluna inexistente remote_jid", () => {
    it("insere sessão sem remote_jid no payload", async () => {
      const { findOrCreateSession } = await import("../../app/api/webhooks/shared-helpers");
      await findOrCreateSession("contact-1", "inst-1", "5511999999999@s.whatsapp.net", "tenant-a");

      const sessInsert = mockState.sessionWrites.find((w) => w.action === "insert");
      expect(sessInsert).toBeDefined();
      expect(sessInsert?.payload).not.toHaveProperty("remote_jid");
      expect(sessInsert?.payload.client_id).toBe("tenant-a");
    });
  });

  describe("B3 — evolution.sendMessage amplia timeout acima do delay", () => {
    it("usa timeout dinâmico (>= delay + 20s) no axios quando delay > 10s", async () => {
      process.env.EVOLUTION_API_URL = "https://evo.example.test";
      process.env.EVOLUTION_API_KEY = "evo-test-key";
      mockState.axiosMock.mockResolvedValue({
        status: 200,
        data: JSON.stringify({ key: { id: "msg-123" } }),
      });

      const { evolution } = await import("../evolution");
      await evolution.sendMessage("5511999999999@s.whatsapp.net", "Olá", "inst-1", { delay: 65_000 });

      const sendCall = mockState.axiosMock.mock.calls
        .map((args) => args[0] as { url?: string; timeout?: number })
        .find((cfg) => String(cfg?.url || "").includes("/message/sendText/"));
      expect(sendCall).toBeDefined();
      expect(sendCall?.timeout).toBeGreaterThanOrEqual(85_000);
    });
  });

  describe("T4 — cheapModelForSummary prefere chaves diretas sobre combo", () => {
    it("usa gemini-2.5-flash em vez de combo caro quando há chave Gemini direta, preservando gateway", async () => {
      const comboRes = await cheapModelForSummary({ preferredModelRef: "combo:flagship-pack" });
      expect(comboRes?.modelRef).toBe("gemini-2.5-flash");

      const gwRes = await cheapModelForSummary({ preferredModelRef: "gateway:claude-sonnet-4" });
      expect(gwRes?.modelRef).toBe("gateway:claude-sonnet-4");
    });
  });
});
