// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type FilterTuple = [string, unknown];

interface RecordedOp {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: FilterTuple[];
}

const state = vi.hoisted(() => ({
  ops: [] as RecordedOp[],
  selectResolver: null as ((table: string, filters: FilterTuple[]) => { data: unknown; error: unknown; count?: number }) | null,
  requireClientId: vi.fn(),
  isInstanceOwnedByClient: vi.fn(),
  enforceClientDefaultModel: vi.fn(),
  fetchMock: vi.fn(),
}));

function makeChain(table: string) {
  let op: RecordedOp["op"] = "select";
  let payload: unknown;
  const filters: FilterTuple[] = [];
  let recorded = false;

  const commit = () => {
    if (!recorded) {
      recorded = true;
      state.ops.push({ table, op, ...(payload !== undefined ? { payload } : {}), filters: [...filters] });
    }
    if (op === "select" && state.selectResolver) {
      return state.selectResolver(table, filters);
    }
    if (op === "insert" || op === "update") {
      return { data: { id: `${table}-1`, ...(payload as object) }, error: null };
    }
    return { data: null, error: null, count: 1 };
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
    is: () => chain,
    gte: () => chain,
    gt: () => chain,
    lt: () => chain,
    order: () => chain,
    limit: () => chain,
    single: async () => commit(),
    maybeSingle: async () => commit(),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(commit()).then(resolve, reject),
  };

  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (table: string) => makeChain(table) },
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: state.requireClientId,
  isInstanceOwnedByClient: state.isInstanceOwnedByClient,
}));

vi.mock("@/lib/enforce-model", () => ({
  enforceClientDefaultModel: state.enforceClientDefaultModel,
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({
    gemini: "gem-key",
    openrouter: "or-key",
    openrouterKeys: ["sk-or-v1-secret1234"],
    nvidia: "",
    nvidiaAccounts: [{ id: "nv1", label: "NV1", apiKey: "nvapi-secret1234" }],
    gatewayBaseUrl: "http://127.0.0.1:8317/v1",
    gatewayApiKey: "gw-secret",
    gatewayFallbackModel: "gpt-4o-mini",
    gatewayEndpoints: [{ id: "gw1", label: "GW", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "gw-secret" }],
    defaultAiModel: "gemini-2.5-flash",
  })),
  parseGatewayEndpoints: vi.fn(() => [{ id: "gw1", label: "GW", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "gw-secret" }]),
  parseOpenRouterKeys: vi.fn(() => ["sk-or-v1-secret1234"]),
  parseNvidiaAccounts: vi.fn(() => [{ id: "nv1", label: "NV1", apiKey: "nvapi-secret1234" }]),
  invalidateAiKeysCache: vi.fn(),
}));

vi.mock("@/lib/organizer-config-cache", () => ({
  invalidateOrganizerConfigCache: vi.fn(),
}));

vi.mock("@/lib/internal-auth", () => ({
  getInternalSecret: vi.fn(() => "sec-123"),
  INTERNAL_SECRET_HEADER: "x-internal-secret",
  hasInternalSecret: vi.fn(() => false),
}));

vi.mock("@/lib/ai-provider", () => ({
  providerOf: vi.fn(() => "gemini"),
  providerDisplayName: vi.fn(() => "Google Gemini"),
  generateText: vi.fn(async () => ({ text: "[]", provider: "gemini" })),
}));

describe("Hardening de ai-organize/config, organizer/run-now, campaigns, automations e followup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ops = [];
    state.selectResolver = null;
    state.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-a",
      isAdmin: false,
      impersonating: false,
      claims: { features: { organizador: true, disparo: true, automacao: true } },
    });
    state.isInstanceOwnedByClient.mockResolvedValue(true);
    state.enforceClientDefaultModel.mockResolvedValue(undefined);
    state.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, updatedCount: 0, message: "ok", batch_id: "b1" }), { status: 200 })
    );
    vi.stubGlobal("fetch", state.fetchMock);
  });

  it("GET/PATCH /api/ai-organize/config exige auth, oculta detalhes sensíveis para cliente e bloqueia execução/horário global de não-admin", async () => {
    state.requireClientId.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "Não autenticado" }), { status: 401 }),
    });

    const { GET, PATCH } = await import("@/app/api/ai-organize/config/route");

    const unauth = await GET(new NextRequest("http://localhost/api/ai-organize/config"));
    expect(unauth.status).toBe(401);

    state.selectResolver = (table) => {
      if (table === "ai_organizer_config") {
        return {
          data: {
            enabled: false,
            model: "gemini-2.5-flash",
            provider: "Gemini",
            execution_hour: 20,
            api_key: "gem-key",
            gateway_base_url: "http://127.0.0.1:8317/v1",
            gateway_api_key: "gw-secret",
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };

    const nonAdminGet = await GET(new NextRequest("http://localhost/api/ai-organize/config"));
    const nonAdminJson = await nonAdminGet.json();
    expect(nonAdminGet.status).toBe(200);
    expect(nonAdminJson.config.gateway_base_url).toBeUndefined();
    expect(nonAdminJson.config.gateway_endpoints).toBeUndefined();
    expect(nonAdminJson.config.openrouter_keys).toBeUndefined();
    expect(nonAdminJson.config.nvidia_accounts).toBeUndefined();
    expect(nonAdminJson.config.execution_hour).toBe(20);

    const nonAdminPatchHour = await PATCH(
      new NextRequest("http://localhost/api/ai-organize/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ execution_hour: 3 }),
      })
    );
    expect(nonAdminPatchHour.status).toBe(403);

    state.requireClientId.mockResolvedValueOnce({
      ok: true,
      clientId: "admin-1",
      isAdmin: true,
      impersonating: false,
      claims: {},
    });
    const adminInvalidUrl = await PATCH(
      new NextRequest("http://localhost/api/ai-organize/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateway_base_url: "javascript:alert(1)" }),
      })
    );
    expect(adminInvalidUrl.status).toBe(400);
  });

  it("POST /api/organizer/run-now não reativa ai_organizer_config global quando chamado por cliente", async () => {
    state.selectResolver = (table) => {
      if (table === "ai_organizer_config") {
        return {
          data: { enabled: false, api_key: "gem", model: "gemini-2.5-flash", provider: "Google Gemini" },
          error: null,
        };
      }
      return { data: null, error: null };
    };

    const { POST } = await import("@/app/api/organizer/run-now/route");
    const res = await POST(new NextRequest("http://localhost/api/organizer/run-now", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(state.ops.some((o) => o.table === "ai_organizer_config" && o.op === "update")).toBe(false);
  });

  it("campaigns e automations rejeitam agent_id de outro tenant (403) ou inválido (400)", async () => {
    state.selectResolver = (table, filters) => {
      if (table === "agent_settings") {
        const hasTenant = filters.some(([c, v]) => c === "client_id" && v === "tenant-a");
        const id = filters.find(([c]) => c === "id")?.[1];
        return { data: hasTenant && id === 10 ? { id: 10 } : null, error: null };
      }
      if (table === "campaigns") {
        return { data: { client_id: "tenant-a" }, error: null };
      }
      return { data: null, error: null };
    };

    const { POST: createCampaign } = await import("@/app/api/campaigns/route");
    const { PATCH: patchCampaign } = await import("@/app/api/campaigns/[id]/route");
    const { POST: createAutomation } = await import("@/app/api/automations/route");

    const campCross = await createCampaign(
      new NextRequest("http://localhost/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Camp",
          instance_name: "inst-a",
          message_template: "Oi",
          agent_id: 999,
        }),
      })
    );
    expect(campCross.status).toBe(403);

    const campPatchCross = await patchCampaign(
      new NextRequest("http://localhost/api/campaigns/camp-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: 999 }),
      }),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(campPatchCross.status).toBe(403);

    const autoInvalid = await createAutomation(
      new NextRequest("http://localhost/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Auto",
          instance_name: "inst-a",
          agent_id: "abc",
        }),
      })
    );
    expect(autoInvalid.status).toBe(400);

    const autoCross = await createAutomation(
      new NextRequest("http://localhost/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Auto",
          instance_name: "inst-a",
          agent_id: 999,
        }),
      })
    );
    expect(autoCross.status).toBe(403);
  });

  it("PATCH /api/followup/[id] valida steps e intervalos contra limites e entre min/max", async () => {
    state.selectResolver = (table) => {
      if (table === "followup_campaigns") {
        return { data: { client_id: "tenant-a", min_interval_seconds: 40, max_interval_seconds: 90 }, error: null };
      }
      return { data: null, error: null };
    };

    const { PATCH } = await import("@/app/api/followup/[id]/route");

    const emptySteps = await PATCH(
      new NextRequest("http://localhost/api/followup/f1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps: [] }),
      }),
      { params: Promise.resolve({ id: "f1" }) }
    );
    expect(emptySteps.status).toBe(400);

    const badInterval = await PATCH(
      new NextRequest("http://localhost/api/followup/f1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ min_interval_seconds: 120 }),
      }),
      { params: Promise.resolve({ id: "f1" }) }
    );
    expect(badInterval.status).toBe(400);
  });

  it("POST /api/ai-organize ignora modelo e apiKey enviados por usuário comum", async () => {
    state.selectResolver = (table) => {
      if (table === "ai_organizer_runs") return { data: { id: 1 }, error: null };
      return { data: [], error: null };
    };

    const { POST } = await import("@/app/api/ai-organize/route");
    const res = await POST(
      new NextRequest("http://localhost/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: "evil-key",
          model: "openai/gpt-expensive",
          provider: "OpenRouter",
        }),
      })
    );
    expect(res.status).toBe(200);
    const runInsert = state.ops.find((o) => o.table === "ai_organizer_runs" && o.op === "insert");
    expect(runInsert?.payload).toMatchObject({ model: "gemini-2.5-flash" });
  });
});

