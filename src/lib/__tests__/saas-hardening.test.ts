// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEFAULT_SAAS_CLIENT_FEATURES,
  PATH_TO_FEATURE,
  SAAS_PLAN_PRESETS,
  isFeatureEnabledForSession,
  normalizeSaasLimits,
} from "@/lib/saas-policy";
import {
  checkTenantAiQuota,
  checkTenantRateLimit,
  recordTenantUsageDelta,
  requireFeatureAccess,
  resetSaasLimitsStateForTests,
} from "@/lib/saas-limits";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  verifySession: vi.fn(),
  isSessionLiveStrict: vi.fn(async () => true),
  from: vi.fn(),
  rpc: vi.fn(),
  startScraperRun: vi.fn(() => ({ ok: true })),
  getStatus: vi.fn(() => ({ isScraping: false, isPaused: false, leadCount: 0, logs: [] })),
  getAiKeys: vi.fn(async () => ({ gemini: "g-key", openrouter: "or-key", openrouterKeys: ["k1"], nvidia: null, nvidiaAccounts: [], gatewayBaseUrl: null })),
  resolveModelForClient: vi.fn(async () => "openrouter:google/gemini-2.5-flash"),
  summarizeReviewsForLead: vi.fn(async () => ({ lead_id: 1, summary: "ok" })),
  executarCicloDePrevias: vi.fn(async () => ({ ok: true, geradas: 0 })),
}));

const dbState = {
  selectHandler: null as ((table: string, filters: Array<[string, unknown]>) => { data: unknown; error: unknown; count?: number }) | null,
  inserts: [] as Array<{ table: string; payload: unknown }>,
  updates: [] as Array<{ table: string; payload: unknown }>,
};

function makeDbChain(table: string) {
  let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  let payload: unknown;
  const filters: Array<[string, unknown]> = [];

  const commit = () => {
    if (op === "insert") dbState.inserts.push({ table, payload });
    if (op === "update") dbState.updates.push({ table, payload });
    if (op === "select" && dbState.selectHandler) {
      return dbState.selectHandler(table, filters);
    }
    return { data: null, error: null, count: 0 };
  };

  const chain: Record<string, unknown> = {
    select: () => chain,
    insert: (p: unknown) => {
      op = "insert";
      payload = p;
      return chain;
    },
    update: (p: unknown) => {
      op = "update";
      payload = p;
      return chain;
    },
    upsert: (p: unknown) => {
      op = "upsert";
      payload = p;
      return chain;
    },
    delete: () => {
      op = "delete";
      return chain;
    },
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return chain;
    },
    in: () => chain,
    gte: () => chain,
    gt: () => chain,
    lt: () => chain,
    neq: () => chain,
    order: () => chain,
    limit: () => chain,
    single: async () => commit(),
    maybeSingle: async () => commit(),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(commit()).then(resolve, reject),
  };
  return chain;
}

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => ({ value: "session-token" }),
  })),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (t: string) => {
      mocks.from(t);
      return makeDbChain(t);
    },
    rpc: (...args: unknown[]) => mocks.rpc(...args),
  },
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    verifySession: mocks.verifySession,
    isSessionLiveStrict: mocks.isSessionLiveStrict,
  };
});

vi.mock("@/lib/scraper-engine", () => ({
  startScraperRun: mocks.startScraperRun,
  getStatus: mocks.getStatus,
  stopScraping: vi.fn(),
  togglePause: vi.fn(() => false),
  attachSseClient: vi.fn(),
  detachSseClient: vi.fn(),
  loadAutomationRunSettings: vi.fn(),
  validateMinReviews: vi.fn(() => 0),
  validateMaxReviews: vi.fn(() => 0),
  validateRatingBound: vi.fn(() => 0),
  validateGoogleYear: vi.fn(() => 0),
  validateReviewRange: vi.fn(() => null),
  validateRatingRange: vi.fn(() => null),
  validateGoogleYearRange: vi.fn(() => null),
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: mocks.getAiKeys,
}));

vi.mock("@/lib/ai-default-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-default-model")>();
  return {
    ...actual,
    resolveModelForClient: mocks.resolveModelForClient,
  };
});

vi.mock("@/lib/reviews-ai", () => ({
  summarizeReviewsForLead: mocks.summarizeReviewsForLead,
  getCachedReviewsSummary: vi.fn(async () => null),
}));

vi.mock("@/lib/sites/preview-pipeline", () => ({
  solicitarPreviaLead: vi.fn(async () => ({ ok: true })),
  executarCicloDePrevias: mocks.executarCicloDePrevias,
  processSingleLeadPreview: vi.fn(async () => true),
}));

vi.mock("@/lib/sites/preview-worker", () => ({
  isSitePreviewAllowedForLead: vi.fn(async () => true),
}));

vi.mock("@/lib/channel", () => ({
  getStatus: vi.fn(async () => ({ state: "close", data: {} })),
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    fetchInstances: vi.fn(async () => []),
    ensureInstanceConfigured: vi.fn(async () => ({ qrcode: { base64: "qr" } })),
  },
}));

vi.mock("@/lib/providers/evolution-go", () => ({
  evolutionGo: {},
}));

vi.mock("@/lib/agent-config-cache", () => ({
  invalidateAgentConfigCache: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetSaasLimitsStateForTests();
  mocks.isSessionLiveStrict.mockResolvedValue(true);
  dbState.selectHandler = null;
  dbState.inserts = [];
  dbState.updates = [];
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "followup_invalid_claim" } });
});

describe("saas-policy: flags restritas e presets de plano", () => {
  it("DEFAULT_SAAS_CLIENT_FEATURES desabilita todas as ferramentas de alto risco de VPS/custo", () => {
    expect(DEFAULT_SAAS_CLIENT_FEATURES.captador).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.automacao).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.prospeccao_sites).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.sites).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.aquecer_chips).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.disparo).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.organizador).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.tokens).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.configuracoes).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.historico).toBe(false);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.chat).toBe(true);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.agente).toBe(true);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.whatsapp).toBe(true);
    expect(DEFAULT_SAAS_CLIENT_FEATURES.calendario).toBe(true);
  });

  it("PATH_TO_FEATURE cobre rotas sensíveis que antes ficavam abertas", () => {
    expect(PATH_TO_FEATURE["/prospeccao-sites"]).toBe("prospeccao_sites");
    expect(PATH_TO_FEATURE["/calendario"]).toBe("calendario");
    expect(PATH_TO_FEATURE["/follow-up-control"]).toBe("followup");
    expect(PATH_TO_FEATURE["/historico-ia"]).toBe("historico");
  });

  it("isFeatureEnabledForSession falha fechado em módulos restritos, liberado apenas para admin real ou flag explícita", () => {
    const legacyClientSession = { isAdmin: false, impersonating: false, features: {} };
    expect(isFeatureEnabledForSession("captador", legacyClientSession)).toBe(false);
    expect(isFeatureEnabledForSession("prospeccao_sites", legacyClientSession)).toBe(false);
    expect(isFeatureEnabledForSession("chat", legacyClientSession)).toBe(true);

    const realAdmin = { isAdmin: true, impersonating: false, features: { captador: false } };
    expect(isFeatureEnabledForSession("captador", realAdmin)).toBe(true);

    const impersonatingAdmin = { isAdmin: true, impersonating: true, features: { captador: false } };
    expect(isFeatureEnabledForSession("captador", impersonatingAdmin)).toBe(false);
  });

  it("normalizeSaasLimits normaliza presets Starter/Pro/Enterprise/Unlimited", () => {
    const starter = normalizeSaasLimits({ plan: "starter" }, SAAS_PLAN_PRESETS.starter);
    expect(starter.monthly_token_limit).toBe(500_000);
    expect(starter.max_agents).toBe(2);
    expect(starter.max_instances).toBe(1);

    const pro = normalizeSaasLimits({ plan: "pro" }, SAAS_PLAN_PRESETS.pro);
    expect(pro.monthly_token_limit).toBe(2_000_000);
    expect(pro.max_agents).toBe(5);
  });
});

describe("saas-limits: requireFeatureAccess, rate-limit e quota mensal", () => {
  it("requireFeatureAccess aceita array de módulos e retorna 403 quando nenhum está liberado", async () => {
    const blocked = requireFeatureAccess(
      { ok: true, clientId: "t1", isAdmin: false, impersonating: false, claims: { features: { automacao: false, prospeccao_sites: false } } },
      ["automacao", "prospeccao_sites"],
    );
    expect(blocked?.status).toBe(403);

    const allowedByOne = requireFeatureAccess(
      { ok: true, clientId: "t1", isAdmin: false, impersonating: false, claims: { features: { automacao: false, prospeccao_sites: true } } },
      ["automacao", "prospeccao_sites"],
    );
    expect(allowedByOne).toBeNull();
  });

  it("checkTenantRateLimit aplica sliding window por chave de tenant", () => {
    const r1 = checkTenantRateLimit("test_key:t1", 2, 60_000);
    const r2 = checkTenantRateLimit("test_key:t1", 2, 60_000);
    const r3 = checkTenantRateLimit("test_key:t1", 2, 60_000);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfterSec).toBeGreaterThan(0);
  });

  it("checkTenantAiQuota bloqueia não-admin após atingir teto mensal de tokens e libera admin", async () => {
    dbState.selectHandler = (table) => {
      if (table === "app_settings") {
        return {
          data: { value: JSON.stringify({ ...SAAS_PLAN_PRESETS.starter, monthly_token_limit: 1000, monthly_usd_limit: 5 }) },
          error: null,
        };
      }
      if (table === "ai_token_usage") {
        return { data: [{ total_tokens: 700, cost_usd: 0.2 }], error: null };
      }
      return { data: null, error: null };
    };

    const okBefore = await checkTenantAiQuota("tenant-q", false);
    expect(okBefore.allowed).toBe(true);

    recordTenantUsageDelta("tenant-q", 400, 0.1);
    const blockedAfter = await checkTenantAiQuota("tenant-q", false);
    expect(blockedAfter.allowed).toBe(false);

    const adminBypass = await checkTenantAiQuota("tenant-q", true);
    expect(adminBypass.allowed).toBe(true);
  });
});

describe("Blindagem de rotas SaaS e isolamento por módulo", () => {
  it("GET/POST /api/scraper bloqueia cliente SaaS comum com 403", async () => {
    mocks.verifySession.mockResolvedValue({
      clientId: "tenant-saas",
      sessionId: "sess-1",
      isAdmin: false,
      impersonating: false,
      features: { ...DEFAULT_SAAS_CLIENT_FEATURES },
    });
    const { GET, POST } = await import("@/app/api/scraper/route");
    const getRes = await GET();
    const postRes = await POST(new NextRequest("http://localhost/api/scraper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ niches: ["clinica"], regions: ["sp"] }),
    }));
    expect(getRes.status).toBe(403);
    expect(postRes.status).toBe(403);
    expect(mocks.startScraperRun).not.toHaveBeenCalled();
  });

  it("POST /api/prospeccao-sites/previa bloqueia executar_agora na VPS para não-admin (403)", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-prosp",
      isAdmin: false,
      impersonating: false,
      claims: { features: { prospeccao_sites: true } },
    });
    dbState.selectHandler = (table) => {
      if (table === "leads_extraidos") {
        return {
          data: {
            id: 1,
            client_id: "tenant-prosp",
            nome_negocio: "Clinica Teste",
            business_details: {},
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    const { POST } = await import("@/app/api/prospeccao-sites/previa/route");
    const res = await POST(new NextRequest("http://localhost/api/prospeccao-sites/previa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "executar_agora", leadId: 1 }),
    }));
    expect(res.status).toBe(403);
    expect(mocks.executarCicloDePrevias).not.toHaveBeenCalled();
  });

  it("POST/GET /api/prospeccao-sites/reviews-ai força modelo do tenant e bloqueia lead_id de outro tenant", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-prosp",
      isAdmin: false,
      impersonating: false,
      claims: { features: { prospeccao_sites: true } },
    });
    dbState.selectHandler = () => ({ data: null, error: null });

    const { GET, POST } = await import("@/app/api/prospeccao-sites/reviews-ai/route");
    const postRes = await POST(new NextRequest("http://localhost/api/prospeccao-sites/reviews-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_ids: [10], model: "anthropic/claude-3-opus" }),
    }));
    expect(postRes.status).toBe(200);
    expect(mocks.resolveModelForClient).toHaveBeenCalledWith("tenant-prosp");
    expect(mocks.summarizeReviewsForLead).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openrouter:google/gemini-2.5-flash" }),
    );

    const getRes = await GET(new NextRequest("http://localhost/api/prospeccao-sites/reviews-ai?lead_id=999"));
    expect(getRes.status).toBe(404);
  });

  it("PATCH/POST /api/agent/settings protege opções de custo/SSRF, valida max_prompt_chars e bloqueia max_agents", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-saas",
      isAdmin: false,
      impersonating: false,
      claims: { features: { agente: true } },
    });
    dbState.selectHandler = (table) => {
      if (table === "app_settings") {
        return {
          data: { value: JSON.stringify({ ...SAAS_PLAN_PRESETS.starter, max_agents: 1, max_prompt_chars: 1000, max_output_tokens: 700 }) },
          error: null,
        };
      }
      if (table === "agent_settings") {
        return {
          data: {
            id: 5,
            client_id: "tenant-saas",
            target_model: "gemini-2.5-flash",
            options: { web_search_enabled: false, reasoning_mode: 0, site_preview_auto_detect: false, site_preview_eval_model: "locked-model" },
            scheduler_config: {},
          },
          error: null,
          count: 1,
        };
      }
      return { data: null, error: null, count: 1 };
    };

    const { PATCH, POST } = await import("@/app/api/agent/settings/route");

    const patchIdentity = await PATCH(new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: 5,
        section: "identity",
        name: "Agente",
        options: {
          web_search_enabled: true,
          reasoning_mode: 3,
          max_output_tokens: 8192,
          custom_tools: [{ name: "hack", webhook_url: "http://169.254.169.254/" }],
          site_preview_auto_detect: true,
          site_preview_eval_model: "openai/gpt-4o",
        },
      }),
    }));
    expect(patchIdentity.status).toBe(200);
    const updatedOpts = (dbState.updates[0]?.payload as { options: Record<string, unknown> }).options;
    expect(updatedOpts.web_search_enabled).toBe(false);
    expect(updatedOpts.reasoning_mode).toBe(0);
    expect(updatedOpts.max_output_tokens).toBe(700);
    expect(updatedOpts.custom_tools).toEqual([]);
    expect(updatedOpts.site_preview_auto_detect).toBe(false);
    expect(updatedOpts.site_preview_eval_model).toBe("locked-model");

    const patchPromptTooBig = await PATCH(new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: 5, section: "prompt", main_prompt: "a".repeat(1200) }),
    }));
    expect(patchPromptTooBig.status).toBe(400);

    const createOverLimit = await POST(new NextRequest("http://localhost/api/agent/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_agent", name: "Segundo" }),
    }));
    expect(createOverLimit.status).toBe(403);
  });

  it("POST /api/whatsapp bloqueia connect acima de max_instances do plano SaaS", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-saas",
      isAdmin: false,
      impersonating: false,
      claims: { features: { whatsapp: true } },
    });
    dbState.selectHandler = (table) => {
      if (table === "app_settings") {
        return { data: { value: JSON.stringify({ ...SAAS_PLAN_PRESETS.starter, max_instances: 1 }) }, error: null };
      }
      if (table === "channel_connections") {
        return { data: null, error: null, count: 1 };
      }
      return { data: null, error: null };
    };

    const { POST } = await import("@/app/api/whatsapp/route");
    const res = await POST(new NextRequest("http://localhost/api/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "connect", instanceName: "nova-inst" }),
    }));
    expect(res.status).toBe(403);
    expect(dbState.inserts.some((i) => i.table === "channel_connections")).toBe(false);
  });

  it("GET /api/system/health oculta nomes de provedores de IA e detalhes internos de infra para não-admin", async () => {
    process.env.AGENT_FOLLOWUP_WORKER_ENABLED = "true";
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-saas",
      isAdmin: false,
      impersonating: false,
      claims: { features: {} },
    });
    dbState.selectHandler = () => ({ data: [], error: null });

    const { GET } = await import("@/app/api/system/health/route");
    const res = await GET(new NextRequest("http://localhost/api/system/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("OpenRouter");
    expect(serialized).not.toContain("Gemini");
    expect(serialized).not.toContain("Redis");
  });

  it("resolveModel falha fechado para getDefaultModel() quando clientId é informado e leitura no Supabase falha", async () => {
    vi.doUnmock("@/lib/ai-default-model");
    dbState.selectHandler = (table) => {
      if (table === "clients") {
        throw new Error("db unavailable");
      }
      return { data: null, error: null };
    };
    const { resolveModel, getDefaultModel } = await import("@/lib/ai-default-model");
    const fallback = await getDefaultModel();
    const resolved = await resolveModel("openai/gpt-4o", "tenant-x");
    expect(resolved).toBe(fallback);
  });

  it("rate-limit do simulador de agente bloqueia rajada acima de 15 req/min por tenant com 429", async () => {
    for (let i = 0; i < 15; i += 1) {
      const ok = checkTenantRateLimit("agent_sandbox:burst-tenant", 15, 60_000, 10_000 + i);
      expect(ok.allowed).toBe(true);
    }
    const blocked = checkTenantRateLimit("agent_sandbox:burst-tenant", 15, 60_000, 10_020);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });
});
