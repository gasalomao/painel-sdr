// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SAAS_PLAN_PRESETS } from "@/lib/saas-policy";
import {
  checkTenantAiQuota,
  getAllTenantsMonthlyUsage,
  getTenantMonthlyAiUsage,
  resetSaasLimitsStateForTests,
} from "@/lib/saas-limits";
import { acquireSessionLock } from "@/lib/session-lock";
import { dispatchAgentTurnBounded } from "@/lib/webhook-dispatch";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  hasInternalSecret: vi.fn(() => false),
  from: vi.fn(),
  getAiKeys: vi.fn(async () => ({
    gemini: "",
    openrouter: "or-key-active",
    openrouterKeys: ["or-key-active"],
    nvidia: "",
    nvidiaAccounts: [],
    gatewayBaseUrl: "",
    gatewayEndpoints: [],
    defaultAiModel: "openrouter:google/gemini-2.5-flash",
  })),
  generateText: vi.fn(async () => ({ text: "[]", provider: "openrouter" })),
  resolveModelForClient: vi.fn(async () => "openrouter:google/gemini-2.5-flash"),
  getOrganizerConfig: vi.fn(async () => ({ api_key: "" })),
  invalidateAgentConfigCache: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  usageRows: [] as Array<{ id: number; client_id: string; total_tokens: number; cost_usd: number }>,
  selectResolver: null as
    | ((table: string, filters: Array<[string, unknown]>, range?: [number, number]) => {
        data: unknown;
        error: unknown;
        count?: number;
      })
    | null,
  inserts: [] as Array<{ table: string; payload: unknown }>,
  upserts: [] as Array<{ table: string; payload: unknown }>,
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}));

function makePagedChain(table: string) {
  let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  let payload: unknown;
  const filters: Array<[string, unknown]> = [];
  let rangeBounds: [number, number] | undefined;

  const commit = () => {
    dbState.queries.push({ table, filters: [...filters] });
    if (op === "insert") {
      dbState.inserts.push({ table, payload });
      return { data: { id: 1, ...(payload as object) }, error: null };
    }
    if (op === "upsert") {
      dbState.upserts.push({ table, payload });
      return { data: payload, error: null };
    }
    if (op === "select" && dbState.selectResolver) {
      return dbState.selectResolver(table, filters, rangeBounds);
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
    lte: () => chain,
    lt: () => chain,
    neq: () => chain,
    order: () => chain,
    limit: () => chain,
    range: async (from: number, to: number) => {
      rangeBounds = [from, to];
      return commit();
    },
    single: async () => commit(),
    maybeSingle: async () => commit(),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(commit()).then(resolve, reject),
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      mocks.from(table);
      return makePagedChain(table);
    },
  },
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
  clientIdFromInstance: vi.fn(async () => "tenant-a"),
  DEFAULT_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
}));

vi.mock("@/lib/internal-auth", () => ({
  hasInternalSecret: mocks.hasInternalSecret,
  getInternalSecret: () => "internal-sec",
  INTERNAL_SECRET_HEADER: "x-internal-secret",
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: mocks.getAiKeys,
}));

vi.mock("@/lib/ai-provider", () => ({
  providerOf: vi.fn(() => "openrouter"),
  providerDisplayName: vi.fn(() => "OpenRouter"),
  generateText: mocks.generateText,
}));

vi.mock("@/lib/ai-default-model", () => ({
  resolveModelForClient: mocks.resolveModelForClient,
}));

vi.mock("@/lib/organizer-config-cache", () => ({
  getOrganizerConfig: mocks.getOrganizerConfig,
}));

vi.mock("@/lib/agent-config-cache", () => ({
  invalidateAgentConfigCache: mocks.invalidateAgentConfigCache,
}));

vi.mock("@/lib/channel", () => ({
  getStatus: vi.fn(async () => ({ state: "close" })),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    ensureInstanceConfigured: vi.fn(async () => ({ qrcode: { base64: "qr" } })),
  },
}));

vi.mock("@/lib/providers/evolution-go", () => ({
  evolutionGo: {},
}));

vi.mock("@/lib/warmup/warmup-phone-memory", () => ({
  reconcileWarmupIdentityByPhone: vi.fn(async () => ({ restored: false })),
}));

describe("Melhorias SaaS: paginação >1000 linhas, bypasses, AI Organize guard, diagnose-ai e watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSaasLimitsStateForTests();
    mocks.hasInternalSecret.mockReturnValue(false);
    dbState.usageRows = [];
    dbState.selectResolver = null;
    dbState.inserts = [];
    dbState.upserts = [];
    dbState.queries = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("soma corretamente mais de 1.500 registros de uso mensal via paginação .range() e aplica cota", async () => {
    const rows1500 = Array.from({ length: 1_500 }, (_, i) => ({
      id: i + 1,
      client_id: "tenant-heavy",
      total_tokens: 400,
      cost_usd: 0.005,
    }));
    dbState.selectResolver = (table, _filters, range) => {
      if (table === "app_settings") {
        return {
          data: { value: JSON.stringify({ ...SAAS_PLAN_PRESETS.starter, monthly_token_limit: 500_000 }) },
          error: null,
        };
      }
      if (table === "ai_token_usage" && range) {
        return { data: rows1500.slice(range[0], range[1] + 1), error: null };
      }
      return { data: [], error: null };
    };

    const singleUsage = await getTenantMonthlyAiUsage("tenant-heavy");
    expect(singleUsage.tokens).toBe(600_000);
    expect(singleUsage.usd).toBeCloseTo(7.5, 4);

    const quota = await checkTenantAiQuota("tenant-heavy", false);
    expect(quota.allowed).toBe(false);

    const batchUsage = await getAllTenantsMonthlyUsage(["tenant-heavy"]);
    expect(batchUsage["tenant-heavy"].tokens).toBe(600_000);
  });

  it("bloqueia bypass de max_instances em POST /api/instances e bind_instance em /api/agent/settings", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-starter",
      isAdmin: false,
      impersonating: false,
      claims: { features: { whatsapp: true, agente: true } },
    });
    dbState.selectResolver = (table) => {
      if (table === "app_settings") {
        return {
          data: { value: JSON.stringify({ ...SAAS_PLAN_PRESETS.starter, max_instances: 1 }) },
          error: null,
        };
      }
      if (table === "channel_connections") {
        return { data: null, error: null, count: 1 };
      }
      if (table === "agent_settings") {
        return { data: { id: 10, client_id: "tenant-starter" }, error: null, count: 1 };
      }
      return { data: null, error: null, count: 0 };
    };

    const { POST: postInstance } = await import("@/app/api/instances/route");
    const resInst = await postInstance(
      new NextRequest("http://localhost/api/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_name: "instancia_extra" }),
      }),
    );
    expect(resInst.status).toBe(403);
    expect(dbState.inserts.some((i) => i.table === "channel_connections")).toBe(false);

    const { POST: postAgent } = await import("@/app/api/agent/settings/route");
    const resBind = await postAgent(
      new NextRequest("http://localhost/api/agent/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bind_instance", agent_id: 10, instance_name: "nova_inst_via_bind" }),
      }),
    );
    expect(resBind.status).toBe(403);
    expect(dbState.upserts.some((u) => u.table === "channel_connections")).toBe(false);
  });

  it("POST /api/whatsapp valida formato de instanceName antes de conectar", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-1",
      isAdmin: false,
      impersonating: false,
      claims: { features: { whatsapp: true } },
    });
    dbState.selectResolver = () => ({ data: null, error: null, count: 0 });

    const { POST } = await import("@/app/api/whatsapp/route");
    const badRes = await POST(
      new NextRequest("http://localhost/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", instanceName: "inválido com espaço!" }),
      }),
    );
    expect(badRes.status).toBe(400);
  });

  it("POST /api/ai-organize bloqueia módulo sem permissão (403) e pula execução interna sem cota/feature", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-no-org",
      isAdmin: false,
      impersonating: false,
      claims: { features: { organizador: false } },
    });

    const { POST } = await import("@/app/api/ai-organize/route");
    const forbidden = await POST(
      new NextRequest("http://localhost/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(mocks.generateText).not.toHaveBeenCalled();

    // Chamada interna (cron) com conta sem feature "organizador" liberada -> pula sem chamar IA
    mocks.hasInternalSecret.mockReturnValue(true);
    dbState.selectResolver = (table) => {
      if (table === "clients") {
        return {
          data: {
            is_admin: false,
            is_active: true,
            features: { organizador: false },
            organizer_enabled: true,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    };

    const internalSkip = await POST(
      new NextRequest("http://localhost/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": "internal-sec" },
        body: JSON.stringify({ clientId: "tenant-no-org", triggered_by: "auto" }),
      }),
    );
    expect(internalSkip.status).toBe(200);
    const body = await internalSkip.json();
    expect(body.skipped).toBe(true);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("GET /api/agent/diagnose-ai filtra contato/sessão pelo client_id e reconhece OpenRouter em hasApiKey", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-a",
      isAdmin: false,
      impersonating: false,
      claims: { features: { agente: true } },
    });
    dbState.selectResolver = (table) => {
      if (table === "channel_connections") {
        return {
          data: { instance_name: "inst-a", provider: "evolution", status: "open", agent_id: 5, client_id: "tenant-a" },
          error: null,
        };
      }
      if (table === "agent_settings") {
        return { data: { id: 5, name: "Agente A", is_active: true, target_model: "openrouter:google/gemini-2.5-flash" }, error: null };
      }
      if (table === "contacts") {
        return { data: { id: "contact-a" }, error: null };
      }
      if (table === "sessions") {
        return { data: { id: "sess-a", bot_status: "bot_active" }, error: null };
      }
      return { data: null, error: null };
    };

    const { GET } = await import("@/app/api/agent/diagnose-ai/route");
    const res = await GET(
      new NextRequest("http://localhost/api/agent/diagnose-ai?instance=inst-a&remote_jid=5511999990001@s.whatsapp.net"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.state.hasApiKey).toBe(true);
    expect(json.verdict).toContain("Tudo parece OK");

    const contactQuery = dbState.queries.find((q) => q.table === "contacts");
    expect(contactQuery?.filters).toContainEqual(["client_id", "tenant-a"]);
    const sessionQuery = dbState.queries.find((q) => q.table === "sessions");
    expect(sessionQuery?.filters).toContainEqual(["client_id", "tenant-a"]);
  });

  it("acquireSessionLock aplica watchdog TTL contra deadlock eterno quando owner anterior não libera", async () => {
    // Primeiro dono trava sem nunca chamar release(), com TTL curto de 60ms para o teste
    await acquireSessionLock("sess-deadlock-test", 60);

    const start = Date.now();
    const releaseSecond = await acquireSessionLock("sess-deadlock-test", 500);
    const elapsed = Date.now() - start;
    releaseSecond();

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(400);
  });

  it("dispatchAgentTurnBounded retorna timedOut=true quando excede orçamento em produção sem interromper execução", async () => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "production");

    let backgroundFinished = false;
    const outcome = await dispatchAgentTurnBounded(async () => {
      await new Promise((r) => setTimeout(r, 80));
      backgroundFinished = true;
    }, 20);

    expect(outcome.timedOut).toBe(true);
    expect(backgroundFinished).toBe(false);

    await new Promise((r) => setTimeout(r, 90));
    expect(backgroundFinished).toBe(true);
  });
});
