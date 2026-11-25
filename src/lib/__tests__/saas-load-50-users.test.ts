// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEFAULT_SAAS_CLIENT_FEATURES,
  SAAS_PLAN_PRESETS,
} from "@/lib/saas-policy";
import {
  checkTenantAiQuota,
  checkTenantRateLimit,
  invalidateClientStatusCache,
  isClientActiveCached,
  recordTenantUsageDelta,
  resetSaasLimitsStateForTests,
} from "@/lib/saas-limits";

type SessionAuth = {
  ok: true;
  clientId: string;
  isAdmin: boolean;
  impersonating: boolean;
  claims: {
    clientId: string;
    isAdmin: boolean;
    impersonating: boolean;
    features: Record<string, boolean>;
  };
};

const TENANT_COUNT = 50;

const envState = vi.hoisted(() => ({
  tenants: new Map<
    string,
    {
      clientId: string;
      isAdmin: boolean;
      isActive: boolean;
      plan: "starter" | "pro" | "enterprise" | "unlimited";
      tokensUsed: number;
      usdUsed: number;
      features: Record<string, boolean>;
    }
  >(),
  tokenStorage: new Set<string>(),
}));

function makeDbChain(table: string) {
  let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  const filters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];

  const commit = () => {
    const eqMap = Object.fromEntries(filters);
    const cid =
      (typeof eqMap.client_id === "string" ? eqMap.client_id : null) ||
      (typeof eqMap.id === "string" ? eqMap.id : null) ||
      (typeof eqMap.key === "string" && eqMap.key.startsWith("saas_limits:")
        ? eqMap.key.slice("saas_limits:".length)
        : null);

    if (op === "select") {
      if (table === "app_settings" && cid) {
        const tenant = envState.tenants.get(cid);
        if (!tenant) return { data: null, error: null };
        const limits = SAAS_PLAN_PRESETS[tenant.plan];
        return { data: { value: JSON.stringify(limits) }, error: null };
      }
      if (table === "clients" && cid) {
        const tenant = envState.tenants.get(cid);
        if (!tenant) return { data: null, error: null };
        return {
          data: { id: tenant.clientId, is_admin: tenant.isAdmin, is_active: tenant.isActive },
          error: null,
        };
      }
      if (table === "ai_token_usage" && cid) {
        const tenant = envState.tenants.get(cid);
        if (!tenant) return { data: [], error: null };
        return {
          data: [{ total_tokens: tenant.tokensUsed, cost_usd: tenant.usdUsed, created_at: new Date().toISOString() }],
          error: null,
        };
      }
      if (table === "agent_settings") {
        return { data: [], error: null, count: 1 };
      }
      if (table === "channel_connections") {
        return { data: [], error: null, count: 1 };
      }
      if (table === "agent_knowledge") {
        return { data: [], error: null, count: 2 };
      }
      if (table === "followup_campaigns") {
        return { data: [], error: null };
      }
      if (table === "webhook_logs") {
        return { data: [], error: null };
      }
      if (table === "sessions") {
        return { data: [{ id: `sess-${cid || "1"}`, client_id: cid, remote_jid: "5511999990001@s.whatsapp.net" }], error: null };
      }
      if (table === "chats_dashboard") {
        return {
          data: [
            { remote_jid: "5511999990001@s.whatsapp.net", content: "Mais recente", created_at: "2026-11-25T14:00:00Z" },
            { remote_jid: "5511999990001@s.whatsapp.net", content: "Antiga 1", created_at: "2026-11-25T13:00:00Z" },
            { remote_jid: "5511999990002@s.whatsapp.net", content: "Lead 2", created_at: "2026-11-25T12:00:00Z" },
          ],
          error: null,
        };
      }
      if (table === "kanban_columns") {
        return { data: [], error: null };
      }
      if (table === "leads_extraidos") {
        return {
          data: [
            { id: 1, remoteJid: "5511999990001@s.whatsapp.net", photos: ["foto1.jpg", "foto2.jpg", "foto3.jpg"] },
          ],
          error: null,
        };
      }
    }
    if (op === "insert" || op === "update" || op === "upsert") {
      return { data: [], error: null };
    }
    return { data: null, error: null, count: 0 };
  };

  const chain: Record<string, unknown> = {
    select: () => chain,
    insert: () => {
      op = "insert";
      return chain;
    },
    update: () => {
      op = "update";
      return chain;
    },
    upsert: () => {
      op = "upsert";
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
    in: (col: string, vals: unknown[]) => {
      inFilters.push([col, vals]);
      return chain;
    },
    gte: () => chain,
    gt: () => chain,
    lt: () => chain,
    lte: () => chain,
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

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (t: string) => makeDbChain(t),
    storage: {
      listBuckets: vi.fn(async () => ({ data: [{ name: "chat-media" }] })),
      createBucket: vi.fn(async () => ({ error: null })),
      from: () => ({
        upload: vi.fn(async (path: string) => {
          envState.tokenStorage.add(path);
          return { error: null };
        }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example/${path}` } }),
      }),
    },
  },
}));

// Cada request carrega header "x-sim-client" para simular 50 usuários simultâneos de verdade
vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async (req: NextRequest): Promise<SessionAuth> => {
    const cid = req.headers.get("x-sim-client") || "tenant-01";
    const t = envState.tenants.get(cid)!;
    return {
      ok: true,
      clientId: cid,
      isAdmin: t.isAdmin,
      impersonating: false,
      claims: {
        clientId: cid,
        isAdmin: t.isAdmin,
        impersonating: false,
        features: t.features,
      },
    };
  }),
  clientIdFromInstance: vi.fn(async () => null),
  isInstanceOwnedByClient: vi.fn(async () => true),
}));

vi.mock("@/lib/channel", () => ({
  sendMessage: vi.fn(async () => ({ ok: true, id: "msg-out-1" })),
  sendMedia: vi.fn(async () => ({ ok: true, id: "msg-media-1" })),
  resolveChannel: vi.fn(async () => ({ provider: "whatsapp_cloud" })),
  invalidateChannelCache: vi.fn(),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    findMessages: vi.fn(async () => ({ records: [] })),
    fetchInstances: vi.fn(async () => []),
  },
  getEvolutionConfig: vi.fn(async () => ({ instance: "inst-sim" })),
}));

vi.mock("@/lib/manual-send-registry", () => ({
  registerManualSend: vi.fn(),
}));

vi.mock("@/lib/whatsapp-cloud", () => ({
  whatsappCloud: {
    verifyConnection: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: "sess" }) })),
}));

vi.mock("@/lib/auth", async (orig) => {
  const actual = await orig<typeof import("@/lib/auth")>();
  return {
    ...actual,
    verifySession: vi.fn(async () => ({
      clientId: "tenant-01",
      sessionId: "sess-1",
      isAdmin: false,
      impersonating: false,
      features: { ...DEFAULT_SAAS_CLIENT_FEATURES },
    })),
    isSessionLiveStrict: vi.fn(async () => true),
  };
});

vi.mock("@/lib/pricing", () => ({
  ensurePricing: vi.fn(async () => {}),
  ensureFxRate: vi.fn(async () => {}),
  getFxState: vi.fn(async () => ({ rate: 5.5, source: "test" })),
  lookupPriceSync: vi.fn(() => null),
  computeCost: vi.fn(() => 0),
  getCacheState: vi.fn(async () => ({ source: "test", fetchedAt: 1, modelCount: 1 })),
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({ gemini: "g-key", openrouter: "or-key", openrouterKeys: ["k1"] })),
}));

vi.mock("@/lib/ai-default-model", () => ({
  resolveModel: vi.fn(async () => "openrouter:google/gemini-2.5-flash"),
}));

vi.mock("@/lib/ai-provider", () => ({
  providerOf: vi.fn(() => "openrouter"),
  providerDisplayName: vi.fn(() => "OpenRouter"),
  generateText: vi.fn(async () => ({
    text: "Mensagem personalizada!",
    modelUsed: "openrouter:google/gemini-2.5-flash",
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
  })),
}));

vi.mock("@/lib/token-usage", () => ({
  logTokenUsage: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetSaasLimitsStateForTests();
  envState.tenants.clear();
  envState.tokenStorage.clear();

  for (let i = 1; i <= TENANT_COUNT; i++) {
    const cid = `tenant-${String(i).padStart(2, "0")}`;
    const isAdmin = i === 1;
    const isInactive = i === 49 || i === 50;
    const isOverQuota = i >= 46 && i <= 48;
    const plan = isAdmin
      ? "unlimited"
      : i % 3 === 0
        ? "enterprise"
        : i % 2 === 0
          ? "pro"
          : "starter";

    const limitTokens = SAAS_PLAN_PRESETS[plan].monthly_token_limit ?? 0;
    envState.tenants.set(cid, {
      clientId: cid,
      isAdmin,
      isActive: !isInactive,
      plan,
      tokensUsed: isOverQuota ? limitTokens + 10_000 : i * 5_000,
      usdUsed: isOverQuota ? 10 : 0.25,
      features: isAdmin
        ? { ...DEFAULT_SAAS_CLIENT_FEATURES, captador: true, organizador: true, tokens: true }
        : { ...DEFAULT_SAAS_CLIENT_FEATURES },
    });
  }
});

describe("Stress & Escalabilidade SaaS — 50 usuários simultâneos", () => {
  it("atende 50 tenants concorrentes no /api/account/usage com isolamento estrito e status corretos", async () => {
    const { GET: getUsage } = await import("@/app/api/account/usage/route");
    const t0 = Date.now();

    const responses = await Promise.all(
      Array.from({ length: TENANT_COUNT }, (_, idx) => {
        const cid = `tenant-${String(idx + 1).padStart(2, "0")}`;
        return getUsage(
          new NextRequest("http://localhost/api/account/usage", {
            headers: { "x-sim-client": cid },
          }),
        ).then(async (res) => ({ cid, status: res.status, body: await res.json() }));
      }),
    );

    const elapsedMs = Date.now() - t0;
    expect(responses).toHaveLength(50);
    expect(elapsedMs).toBeLessThan(5000);

    for (const item of responses) {
      expect(item.status).toBe(200);
      const expected = envState.tenants.get(item.cid)!;
      expect(item.body.plan).toBe(expected.plan);
      if (expected.isAdmin) {
        expect(item.body.status).toBe("ok");
      } else if (expected.tokensUsed >= (SAAS_PLAN_PRESETS[expected.plan].monthly_token_limit ?? Infinity)) {
        expect(item.body.status).toBe("exceeded");
      } else {
        expect(item.body.usage.tokens).toBe(expected.tokensUsed);
      }
    }
  });

  it("bloqueia módulos restritos (tokens, organizador), cota excedida e uploads grandes sob carga de 50 usuários sem afetar vizinhos", async () => {
    const { GET: getTokens } = await import("@/app/api/tokens/route");
    const { POST: postSuggest } = await import("@/app/api/organizer/suggest-prompt/route");
    const { POST: postCalRewrite } = await import("@/app/api/calendario/rewrite-message/route");
    const { POST: postUpload } = await import("@/app/api/upload-media/route");

    const tasks = Array.from({ length: TENANT_COUNT }, async (_, idx) => {
      const cid = `tenant-${String(idx + 1).padStart(2, "0")}`;
      const t = envState.tenants.get(cid)!;

      // 1) /api/tokens: apenas admin (tenant-01) pode ler; 49 não-admins levam 403
      const tokRes = await getTokens(
        new NextRequest("http://localhost/api/tokens", { headers: { "x-sim-client": cid } }),
      );
      expect(tokRes.status).toBe(t.isAdmin ? 200 : 403);

      // 2) /api/organizer/suggest-prompt: 49 não-admins sem módulo organizador levam 403
      const orgRes = await postSuggest(
        new NextRequest("http://localhost/api/organizer/suggest-prompt", {
          method: "POST",
          headers: { "x-sim-client": cid, "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      if (!t.isAdmin) expect(orgRes.status).toBe(403);

      // 3) /api/calendario/rewrite-message: clientes com cota estourada (46..48) levam 429; demais não-inativos levam 200
      const calRes = await postCalRewrite(
        new NextRequest("http://localhost/api/calendario/rewrite-message", {
          method: "POST",
          headers: { "x-sim-client": cid, "content-type": "application/json" },
          body: JSON.stringify({ message: "Oi {nome}, confirmando amanhã!" }),
        }),
      );
      if (!t.isAdmin && idx + 1 >= 46 && idx + 1 <= 48) {
        expect(calRes.status).toBe(429);
      } else {
        expect(calRes.status).toBe(200);
      }

      // 4) /api/upload-media: Starter tem teto 15MB -> upload de 16MB dá 413; Pro (30MB) passa com 200
      const form = new FormData();
      const bigBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const fakeBigFile = {
        name: "catalogo.png",
        type: "image/png",
        size: 16 * 1024 * 1024,
        arrayBuffer: async () => bigBytes.buffer,
      } as unknown as File;
      vi.spyOn(form, "get").mockReturnValue(fakeBigFile);
      const upReq = new NextRequest("http://localhost/api/upload-media", {
        method: "POST",
        headers: { "x-sim-client": cid },
      });
      vi.spyOn(upReq, "formData").mockResolvedValue(form);
      const upRes = await postUpload(upReq);
      if (t.plan === "starter") {
        expect(upRes.status).toBe(413);
      } else {
        expect(upRes.status).toBe(200);
        expect(envState.tokenStorage.has(`${cid}/`) || [...envState.tokenStorage].some((p) => p.startsWith(`${cid}/`))).toBe(true);
      }
    });

    await Promise.all(tasks);
  });

  it("isola rate-limit ('noisy neighbor') e invalida status de contas desativadas imediatamente", async () => {
    // tenant-02 dispara rajada de 15 chamadas no rate-limit -> bloqueia na 16ª sem afetar tenant-03
    for (let i = 0; i < 15; i++) {
      expect(checkTenantRateLimit("cal_rewrite:tenant-02", 15, 60_000, 100_000 + i).allowed).toBe(true);
    }
    expect(checkTenantRateLimit("cal_rewrite:tenant-02", 15, 60_000, 100_020).allowed).toBe(false);
    expect(checkTenantRateLimit("cal_rewrite:tenant-03", 15, 60_000, 100_020).allowed).toBe(true);

    // Contas 49 e 50 estão desativadas; reativar + invalidar cache libera imediatamente
    expect(await isClientActiveCached("tenant-49")).toBe(false);
    expect(await isClientActiveCached("tenant-02")).toBe(true);
    envState.tenants.get("tenant-49")!.isActive = true;
    invalidateClientStatusCache("tenant-49");
    expect(await isClientActiveCached("tenant-49")).toBe(true);

    // 50 tenants acumulando deltas concorrentemente atualizam o próprio cache de cota com precisão
    await Promise.all(
      Array.from({ length: TENANT_COUNT }, (_, idx) => checkTenantAiQuota(`tenant-${String(idx + 1).padStart(2, "0")}`, idx === 0)),
    );
    recordTenantUsageDelta("tenant-05", 10_000, 0.5);
    const q5 = await checkTenantAiQuota("tenant-05", false);
    expect(q5.usage.tokens).toBe(5 * 5_000 + 10_000);
  });

  it("aplica trava max_instances em /api/whatsapp/cloud, rate limits em send-message/sync-evolution e otimiza Inbox para 50 operadores", async () => {
    const { POST: postCloud } = await import("@/app/api/whatsapp/cloud/route");
    const { POST: postSend } = await import("@/app/api/send-message/route");
    const { POST: postSync } = await import("@/app/api/chat/sync-evolution/route");
    const { GET: getInbox } = await import("@/app/api/inbox/conversations/route");

    // 1) 50 clientes simultâneos abrindo /api/inbox/conversations?mode=full e poll -> dedup de msgs (2 em vez de 3) e photos reduzido a 1 item
    const inboxResults = await Promise.all(
      Array.from({ length: TENANT_COUNT }, (_, idx) => {
        const cid = `tenant-${String(idx + 1).padStart(2, "0")}`;
        return getInbox(
          new NextRequest("http://localhost/api/inbox/conversations?mode=full", {
            headers: { "x-sim-client": cid },
          }),
        ).then(async (r) => ({ status: r.status, body: await r.json() }));
      }),
    );
    for (const r of inboxResults) {
      expect(r.status).toBe(200);
      expect(r.body.messages).toHaveLength(2);
      expect(r.body.messages[0].content).toBe("Mais recente");
      expect(r.body.leads[0].photos).toEqual(["foto1.jpg"]);
    }

    // 2) WhatsApp Cloud save acima do limite max_instances=1 para Starter (tenant-03 = enterprise 10 OK vs tenant-05 = starter 1 bloqueado 403)
    const cloudStarterBlocked = await postCloud(
      new NextRequest("http://localhost/api/whatsapp/cloud", {
        method: "POST",
        headers: { "x-sim-client": "tenant-05", "content-type": "application/json" },
        body: JSON.stringify({
          action: "save",
          instanceName: "cloud-extra",
          config: { phone_number_id: "123", access_token: "tok" },
        }),
      }),
    );
    expect(cloudStarterBlocked.status).toBe(403);

    // 3) Conta inativa bloqueada no /api/send-message com 403; conta ativa respeita rate limit após 60 mensagens/min
    const inactiveSend = await postSend(
      new NextRequest("http://localhost/api/send-message", {
        method: "POST",
        headers: { "x-sim-client": "tenant-49", "content-type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999990001@s.whatsapp.net", text: "Olá", instanceName: "inst-49" }),
      }),
    );
    expect(inactiveSend.status).toBe(403);

    for (let i = 0; i < 60; i++) {
      const okSend = await postSend(
        new NextRequest("http://localhost/api/send-message", {
          method: "POST",
          headers: { "x-sim-client": "tenant-02", "content-type": "application/json" },
          body: JSON.stringify({ remoteJid: `551199999${String(i).padStart(4, "0")}@s.whatsapp.net`, text: `Oi ${i}`, instanceName: "inst-2" }),
        }),
      );
      expect(okSend.status).toBe(200);
    }
    const burstSend = await postSend(
      new NextRequest("http://localhost/api/send-message", {
        method: "POST",
        headers: { "x-sim-client": "tenant-02", "content-type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999999999@s.whatsapp.net", text: "Excesso", instanceName: "inst-2" }),
      }),
    );
    expect(burstSend.status).toBe(429);

    // 4) Sync Evolution bloqueia após 10 chamadas/min por tenant
    for (let i = 0; i < 10; i++) {
      const syncOk = await postSync(
        new NextRequest("http://localhost/api/chat/sync-evolution", {
          method: "POST",
          headers: { "x-sim-client": "tenant-04", "content-type": "application/json" },
          body: JSON.stringify({ remoteJid: "5511999990001@s.whatsapp.net" }),
        }),
      );
      expect(syncOk.status).toBe(200);
    }
    const syncBlocked = await postSync(
      new NextRequest("http://localhost/api/chat/sync-evolution", {
        method: "POST",
        headers: { "x-sim-client": "tenant-04", "content-type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999990001@s.whatsapp.net" }),
      }),
    );
    expect(syncBlocked.status).toBe(429);
  });
});
