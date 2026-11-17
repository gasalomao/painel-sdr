// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type FilterTuple = [string, unknown];

interface RecordedOp {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  filters: FilterTuple[];
}

const state = vi.hoisted(() => ({
  ops: [] as RecordedOp[],
  selectResolver: null as ((table: string, filters: FilterTuple[]) => { data: unknown; error: unknown }) | null,
  selectThrow: null as Error | null,
  upsertError: null as { message: string } | null,
  requireClientId: vi.fn(),
  getAiKeys: vi.fn(),
  analyzeLead: vi.fn(),
  analyzeBatch: vi.fn(),
  generateText: vi.fn(),
  resolveModel: vi.fn(),
  logTokenUsage: vi.fn(),
}));

function makeChain(table: string) {
  let op: RecordedOp["op"] = "select";
  const filters: FilterTuple[] = [];
  let recorded = false;

  const commit = () => {
    if (!recorded) {
      recorded = true;
      state.ops.push({
        table,
        op,
        filters: [...filters],
      });
    }
    if (op === "select" && state.selectThrow) {
      throw state.selectThrow;
    }
    if ((op === "upsert" || op === "update") && state.upsertError) {
      return { data: null, error: state.upsertError };
    }
    if (op === "select" && state.selectResolver) {
      return state.selectResolver(table, filters);
    }
    return { data: null, error: null };
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
      filters.push([col, vals]);
      return chain;
    },
    neq: () => chain,
    ilike: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    single: async () => commit(),
    maybeSingle: async () => commit(),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(commit()).then(resolve, reject),
  };

  return chain;
}

vi.mock("@/lib/tenant", () => ({
  requireClientId: (...args: unknown[]) => state.requireClientId(...args),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => makeChain(table),
  },
}));

vi.mock("@/lib/ai-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-keys")>();
  return {
    ...actual,
    getAiKeys: (...args: unknown[]) => state.getAiKeys(...args),
    invalidateAiKeysCache: vi.fn(),
  };
});

vi.mock("@/lib/organizer-config-cache", () => ({
  invalidateOrganizerConfigCache: vi.fn(),
  getOrganizerConfig: vi.fn(async () => null),
}));

vi.mock("@/lib/lead-intelligence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lead-intelligence")>();
  return {
    ...actual,
    analyzeLead: (...args: unknown[]) => state.analyzeLead(...args),
    analyzeBatch: (...args: unknown[]) => state.analyzeBatch(...args),
  };
});

vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return {
    ...actual,
    generateText: (...args: unknown[]) => state.generateText(...args),
  };
});

vi.mock("@/lib/ai-default-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-default-model")>();
  return {
    ...actual,
    resolveModel: (...args: unknown[]) => state.resolveModel(...args),
  };
});

vi.mock("@/lib/token-usage", () => ({
  logTokenUsage: (...args: unknown[]) => state.logTokenUsage(...args),
}));

describe("Hardening: SSRF em lead-intelligence, auth em settings, analyze e rewrite-message", () => {
  beforeEach(() => {
    state.ops = [];
    state.selectResolver = null;
    state.selectThrow = null;
    state.upsertError = null;
    vi.clearAllMocks();

    state.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-1",
      isAdmin: false,
    });
    state.getAiKeys.mockResolvedValue({
      gemini: null,
      openrouter: "sk-or-test",
      openrouterKeys: ["sk-or-test"],
      gatewayBaseUrl: null,
      gatewayApiKey: null,
      gatewayFallbackModel: null,
      gatewayEndpoints: [],
      aiCombos: [],
      nvidia: null,
      nvidiaAccounts: [],
      defaultAiModel: null,
    });
    state.analyzeLead.mockResolvedValue({ ok: true, leadId: 101 });
    state.analyzeBatch.mockResolvedValue({ ok: true, analyzed: 1 });
    state.resolveModel.mockResolvedValue("openrouter:openai/gpt-4o-mini");
    state.generateText.mockResolvedValue({
      text: "Mensagem reescrita com sucesso",
      usage: { inputTokens: 10, outputTokens: 12 },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("lead-intelligence SSRF guards", () => {
    it("isSafePublicScrapeUrl bloqueia IPs privados, loopback, metadata e esquemas inseguros", async () => {
      const { isSafePublicScrapeUrl } = await import("@/lib/lead-intelligence");
      expect(isSafePublicScrapeUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
      expect(isSafePublicScrapeUrl("http://127.0.0.1:8080/")).toBe(false);
      expect(isSafePublicScrapeUrl("http://[::1]/")).toBe(false);
      expect(isSafePublicScrapeUrl("http://10.0.0.1/internal")).toBe(false);
      expect(isSafePublicScrapeUrl("file:///etc/passwd")).toBe(false);
      expect(isSafePublicScrapeUrl("javascript:alert(1)")).toBe(false);
      expect(isSafePublicScrapeUrl("https://clinicaexemplo.com.br/sobre")).toBe(true);
    });

    it("fetchPublicTextSafe usa redirect manual e bloqueia redirect para rede interna ou host não autorizado", async () => {
      const { fetchPublicTextSafe } = await import("@/lib/lead-intelligence");

      const fetchMock = vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const blockedRedirect = await fetchPublicTextSafe("https://clinicaexemplo.com.br/");
      expect(blockedRedirect).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });

      fetchMock.mockClear();
      const blockedPrivateInitial = await fetchPublicTextSafe("http://127.0.0.1:3000/secret");
      expect(blockedPrivateInitial).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fetchPublicTextSafe impõe allowedHostSuffix (ex: instagram.com) no host inicial e após redirect", async () => {
      const { fetchPublicTextSafe } = await import("@/lib/lead-intelligence");

      const fetchMock = vi.fn(async (url: string) => {
        if (url === "https://www.instagram.com/redir") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.com/phish" },
          });
        }
        return new Response("<html>insta ok</html>", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      expect(
        await fetchPublicTextSafe("https://evilinstagram.com/user", {
          allowedHostSuffix: "instagram.com",
        }),
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      expect(
        await fetchPublicTextSafe("https://www.instagram.com/redir", {
          allowedHostSuffix: "instagram.com",
        }),
      ).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(
        await fetchPublicTextSafe("https://www.instagram.com/clinica/", {
          allowedHostSuffix: "instagram.com",
        }),
      ).toBe("<html>insta ok</html>");
    });
  });

  describe("GET / PATCH /api/settings/lead-intelligence e /api/settings/embedding-model", () => {
    it("retorna 401 sem autenticação e 403 para não-admin no GET", async () => {
      const leadIntelRoute = await import("@/app/api/settings/lead-intelligence/route");
      const embeddingRoute = await import("@/app/api/settings/embedding-model/route");

      state.requireClientId.mockResolvedValueOnce({
        ok: false,
        response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }),
      });
      const r1 = await leadIntelRoute.GET(new NextRequest("http://localhost/api/settings/lead-intelligence"));
      expect(r1.status).toBe(401);

      state.requireClientId.mockResolvedValueOnce({
        ok: false,
        response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }),
      });
      const r2 = await embeddingRoute.GET(new NextRequest("http://localhost/api/settings/embedding-model"));
      expect(r2.status).toBe(401);

      state.requireClientId.mockResolvedValue({ ok: true, clientId: "tenant-1", isAdmin: false });
      const r3 = await leadIntelRoute.GET(new NextRequest("http://localhost/api/settings/lead-intelligence"));
      const r4 = await embeddingRoute.GET(new NextRequest("http://localhost/api/settings/embedding-model"));
      expect(r3.status).toBe(403);
      expect(r4.status).toBe(403);
    });

    it("sanitiza erros 500 de banco sem expor detalhes internos", async () => {
      const leadIntelRoute = await import("@/app/api/settings/lead-intelligence/route");
      const embeddingRoute = await import("@/app/api/settings/embedding-model/route");

      state.requireClientId.mockResolvedValue({ ok: true, clientId: "admin-1", isAdmin: true });
      state.selectThrow = new Error("column secret_pg_detail does not exist");
      state.upsertError = { message: "postgres internal stack secret_pg_detail" };

      const getIntel = await leadIntelRoute.GET(new NextRequest("http://localhost/api/settings/lead-intelligence"));
      expect(getIntel.status).toBe(500);
      expect(JSON.stringify(await getIntel.json())).not.toContain("secret_pg_detail");

      const patchIntel = await leadIntelRoute.PATCH(
        new NextRequest("http://localhost/api/settings/lead-intelligence", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openrouter:openai/gpt-4o-mini" }),
        }),
      );
      expect(patchIntel.status).toBe(500);
      expect(JSON.stringify(await patchIntel.json())).not.toContain("secret_pg_detail");

      const getEmb = await embeddingRoute.GET(new NextRequest("http://localhost/api/settings/embedding-model"));
      expect(getEmb.status).toBe(500);
      expect(JSON.stringify(await getEmb.json())).not.toContain("secret_pg_detail");

      const patchEmb = await embeddingRoute.PATCH(
        new NextRequest("http://localhost/api/settings/embedding-model", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "text-embedding-004" }),
        }),
      );
      expect(patchEmb.status).toBe(500);
      expect(JSON.stringify(await patchEmb.json())).not.toContain("secret_pg_detail");
    });
  });

  describe("POST /api/leads/analyze", () => {
    it("aceita OpenRouter/multi-provedor via getAiKeys() e ignora body.model de não-admin", async () => {
      state.selectResolver = (table) => {
        if (table === "leads_extraidos") {
          return { data: [{ id: 101 }], error: null };
        }
        return { data: null, error: null };
      };

      const { POST } = await import("@/app/api/leads/analyze/route");
      const res = await POST(
        new NextRequest("http://localhost/api/leads/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lead_id: 101,
            model: "openrouter:anthropic/claude-opus-4",
          }),
        }),
      );

      expect(res.status).toBe(200);
      expect(state.analyzeLead).toHaveBeenCalledTimes(1);
      const callArg = state.analyzeLead.mock.calls[0]?.[0];
      expect(callArg?.leadId).toBe(101);
      expect(callArg?.model).not.toBe("openrouter:anthropic/claude-opus-4");
    });

    it("permite body.model quando usuário é admin e valida lead_id inteiro positivo", async () => {
      state.requireClientId.mockResolvedValue({ ok: true, clientId: "admin-1", isAdmin: true });
      state.selectResolver = (table) => {
        if (table === "leads_extraidos") {
          return { data: [{ id: 101 }], error: null };
        }
        return { data: null, error: null };
      };

      const { POST } = await import("@/app/api/leads/analyze/route");

      const badRes = await POST(
        new NextRequest("http://localhost/api/leads/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lead_id: "101; DROP TABLE leads" }),
        }),
      );
      expect(badRes.status).toBe(400);

      const okRes = await POST(
        new NextRequest("http://localhost/api/leads/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lead_id: 101, model: "openrouter:openai/gpt-4o" }),
        }),
      );
      expect(okRes.status).toBe(200);
      expect(state.analyzeLead).toHaveBeenCalledWith(
        expect.objectContaining({ leadId: 101, model: "openrouter:openai/gpt-4o" }),
      );
    });

    it("sanitiza erro 500 inesperado", async () => {
      state.selectResolver = (table) => {
        if (table === "leads_extraidos") {
          return { data: [{ id: 101 }], error: null };
        }
        return { data: null, error: null };
      };
      state.analyzeLead.mockRejectedValueOnce(new Error("SENSITIVE_DB_HOST_STRING"));

      const { POST } = await import("@/app/api/leads/analyze/route");
      const res = await POST(
        new NextRequest("http://localhost/api/leads/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lead_id: 101 }),
        }),
      );
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain("SENSITIVE_DB_HOST_STRING");
    });
  });

  describe("POST /api/calendario/rewrite-message", () => {
    it("filtra lookup de leads_extraidos por appt.client_id e sanitiza 500", async () => {
      state.selectResolver = (table) => {
        if (table === "appointments") {
          return {
            data: {
              id: "appt-1",
              client_id: "tenant-1",
              lead_id: 101,
              remote_jid: "5511999999999@s.whatsapp.net",
              title: "Avaliação Inicial",
              service_name: "Consulta",
              start_at: "2026-11-20T14:00:00Z",
            },
            error: null,
          };
        }
        if (table === "leads_extraidos") {
          return { data: { nome_negocio: "Clinica Teste", ramo_negocio: "Odontologia" }, error: null };
        }
        if (table === "clients") {
          return { data: { name: "Empresa X" }, error: null };
        }
        return { data: null, error: null };
      };

      const { POST } = await import("@/app/api/calendario/rewrite-message/route");
      const res = await POST(
        new NextRequest("http://localhost/api/calendario/rewrite-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appointment_id: "appt-1",
            message: "Ola, confirmando nossa reuniao amanha!",
          }),
        }),
      );

      expect(res.status).toBe(200);
      const leadQueries = state.ops.filter((o) => o.table === "leads_extraidos" && o.op === "select");
      expect(leadQueries.length).toBeGreaterThan(0);
      expect(leadQueries.some((q) => q.filters.some(([c, v]) => c === "client_id" && v === "tenant-1"))).toBe(true);

      state.generateText.mockRejectedValueOnce(new Error("SENSITIVE_LLM_UPSTREAM_KEY"));
      const errRes = await POST(
        new NextRequest("http://localhost/api/calendario/rewrite-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appointment_id: "appt-1",
            message: "Ola!",
          }),
        }),
      );
      expect(errRes.status).toBe(500);
      expect(JSON.stringify(await errRes.json())).not.toContain("SENSITIVE_LLM_UPSTREAM_KEY");
    });
  });
});
