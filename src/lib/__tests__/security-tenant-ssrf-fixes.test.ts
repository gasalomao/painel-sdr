// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type FilterTuple = [string, unknown];

interface RecordedOp {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  selectCols?: unknown;
  payload?: unknown;
  filters: FilterTuple[];
  inFilters: Array<[string, unknown[]]>;
}

const state = vi.hoisted(() => ({
  ops: [] as RecordedOp[],
  selectResolver: null as ((table: string, filters: FilterTuple[]) => { data: unknown; error: unknown }) | null,
  requireClientId: vi.fn(),
  clientIdFromInstance: vi.fn(),
  getStatus: vi.fn(),
  setWebhook: vi.fn(),
  invalidateAgentConfigCache: vi.fn(),
  invalidateChannelCache: vi.fn(),
  resolveChannel: vi.fn(),
}));

function makeChain(table: string) {
  let op: RecordedOp["op"] = "select";
  let selectCols: unknown;
  let payload: unknown;
  const filters: FilterTuple[] = [];
  const inFilters: Array<[string, unknown[]]> = [];
  let recorded = false;

  const commit = () => {
    if (!recorded) {
      recorded = true;
      state.ops.push({
        table,
        op,
        ...(selectCols !== undefined ? { selectCols } : {}),
        ...(payload !== undefined ? { payload } : {}),
        filters: [...filters],
        inFilters: [...inFilters],
      });
    }
    if (op === "select" && state.selectResolver) {
      return state.selectResolver(table, filters);
    }
    return { data: null, error: null };
  };

  const chain: Record<string, unknown> = {
    select: (cols?: unknown) => {
      if (op === "select") selectCols = cols;
      return chain;
    },
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
    in: (col: string, vals: unknown[]) => {
      inFilters.push([col, vals]);
      return chain;
    },
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

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => makeChain(table),
  },
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: state.requireClientId,
  clientIdFromInstance: state.clientIdFromInstance,
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    getActiveInstance: vi.fn(async () => "inst-a"),
    fetchInstances: vi.fn(async () => []),
    setWebhook: state.setWebhook,
    ensureInstanceConfigured: vi.fn(async () => ({ qrcode: { base64: "qr" } })),
    logout: vi.fn(async () => ({})),
    deleteInstance: vi.fn(async () => ({})),
  },
}));

vi.mock("@/lib/providers/evolution-go", () => ({
  evolutionGo: {},
}));

vi.mock("@/lib/channel", () => ({
  getStatus: state.getStatus,
  invalidateChannelCache: state.invalidateChannelCache,
  resolveChannel: state.resolveChannel,
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/agent-config-cache", () => ({
  invalidateAgentConfigCache: state.invalidateAgentConfigCache,
}));

describe("Correções de isolamento multi-tenant, SSRF e schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ops = [];
    state.selectResolver = null;
    state.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-a",
      isAdmin: false,
      impersonating: false,
      claims: {},
    });
    state.getStatus.mockResolvedValue({ state: "open", data: { jid: "secret-jid" } });
    state.setWebhook.mockResolvedValue({ ok: true });
  });

  it("webhooks/register bloqueia agentId de outro tenant, impede app_settings global para não-admin e inclui client_id no upsert", async () => {
    state.selectResolver = (table, filters) => {
      if (table === "channel_connections") {
        return { data: { client_id: "tenant-a", provider: "evolution", provider_config: {} }, error: null };
      }
      if (table === "agent_settings") {
        const hasTenantFilter = filters.some(([c, v]) => c === "client_id" && v === "tenant-a");
        return { data: hasTenantFilter ? null : { id: 99, client_id: "tenant-b", options: {} }, error: null };
      }
      return { data: null, error: null };
    };

    const { POST } = await import("@/app/api/webhooks/register/route");

    const badQueryInjection = await POST(
      new NextRequest("http://localhost/api/webhooks/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName: "inst-a", appUrl: "https://app.example.com", agentId: "1&evil=1" }),
      })
    );
    expect(badQueryInjection.status).toBe(400);

    const crossTenantAgent = await POST(
      new NextRequest("http://localhost/api/webhooks/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName: "inst-a", appUrl: "https://app.example.com", agentId: 99 }),
      })
    );
    expect(crossTenantAgent.status).toBe(403);
    expect(state.ops.some((o) => o.table === "agent_settings" && o.op === "update")).toBe(false);

    const ownOk = await POST(
      new NextRequest("http://localhost/api/webhooks/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName: "inst-a", appUrl: "https://tenant-a.example.com" }),
      })
    );
    expect(ownOk.status).toBe(200);
    // Usuário comum não sobrescreve app_settings global
    expect(state.ops.some((o) => o.table === "app_settings" && o.op === "upsert")).toBe(false);
    // channel_connections upsert inclui client_id
    const ccUpsert = state.ops.find((o) => o.table === "channel_connections" && o.op === "upsert");
    expect(ccUpsert?.payload).toMatchObject({ instance_name: "inst-a", client_id: "tenant-a" });
  });

  it("DELETE /api/chat/messages resolve conversa via contacts e sessions.id sem consultar coluna inexistente sessions.remote_jid", async () => {
    const convUuid = "11111111-1111-1111-1111-111111111111";
    state.selectResolver = (table, filters) => {
      if (table === "sessions") {
        const isById = filters.some(([c]) => c === "id");
        if (isById) {
          return {
            data: {
              id: convUuid,
              contact_id: "contact-a",
              contact: { id: "contact-a", phone_number: "5511999998888", remote_jid: "5511999998888@s.whatsapp.net" },
            },
            error: null,
          };
        }
        return { data: [{ id: convUuid }], error: null };
      }
      if (table === "contacts") {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    };

    const { DELETE } = await import("@/app/api/chat/messages/route");
    const res = await DELETE(
      new NextRequest("http://localhost/api/chat/messages", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convUuid }),
      })
    );

    expect(res.status).toBe(200);
    // Nenhuma query em sessions pode mencionar coluna inexistente sessions.remote_jid
    const sessionOps = state.ops.filter((o) => o.table === "sessions");
    for (const op of sessionOps) {
      const ownCols = String(op.selectCols || "").replace(/contact:contacts\([^)]*\)/g, "");
      expect(ownCols).not.toContain("remote_jid");
      expect(op.inFilters.some(([col]) => col === "remote_jid")).toBe(false);
      expect(op.filters.some(([col]) => col === "remote_jid")).toBe(false);
    }
    const delDash = state.ops.find((o) => o.table === "chats_dashboard" && o.op === "delete");
    expect(delDash?.filters).toContainEqual(["client_id", "tenant-a"]);
    const delSessByContact = state.ops.find(
      (o) => o.table === "sessions" && o.op === "delete" && o.inFilters.some(([c]) => c === "contact_id")
    );
    expect(delSessByContact?.inFilters[0][1]).toContain("contact-a");
  });

  it("POST /api/whatsapp bloqueia connect em instância de outro tenant antes de consultar getStatus", async () => {
    state.selectResolver = (table) => {
      if (table === "channel_connections") {
        return { data: { id: "conn-b", client_id: "tenant-b", provider: "evolution" }, error: null };
      }
      return { data: null, error: null };
    };

    const { POST } = await import("@/app/api/whatsapp/route");
    const res = await POST(
      new NextRequest("http://localhost/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", instanceName: "inst-do-b" }),
      })
    );

    expect(res.status).toBe(403);
    expect(state.getStatus).not.toHaveBeenCalled();
  });

  it("whatsapp/cloud bloqueia legado sem dono, valida agent_id no save e escopa delete por client_id", async () => {
    state.selectResolver = (table, filters) => {
      if (table === "channel_connections") {
        const instFilter = filters.find(([c]) => c === "instance_name")?.[1];
        if (instFilter === "legacy-null") return { data: { client_id: null }, error: null };
        if (instFilter === "own-cloud") return { data: { client_id: "tenant-a", provider_config: {} }, error: null };
        return { data: null, error: null };
      }
      if (table === "agent_settings") {
        const hasTenant = filters.some(([c, v]) => c === "client_id" && v === "tenant-a");
        const idFilter = filters.find(([c]) => c === "id")?.[1];
        if (idFilter === 999 || !hasTenant) return { data: null, error: null };
        return { data: { id: 7 }, error: null };
      }
      return { data: null, error: null };
    };

    const { GET, POST } = await import("@/app/api/whatsapp/cloud/route");

    const legacyGet = await GET(new NextRequest("http://localhost/api/whatsapp/cloud?instance=legacy-null"));
    expect(legacyGet.status).toBe(403);

    const badAgentSave = await POST(
      new NextRequest("http://localhost/api/whatsapp/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          instanceName: "new-cloud",
          agent_id: 999,
          config: { phone_number_id: "123", access_token: "tok-1234567890" },
        }),
      })
    );
    expect(badAgentSave.status).toBe(403);

    const newSave = await POST(
      new NextRequest("http://localhost/api/whatsapp/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          instanceName: "new-cloud",
          config: { phone_number_id: "123", access_token: "tok-1234567890" },
        }),
      })
    );
    expect(newSave.status).toBe(200);
    const saveUpsert = state.ops.find((o) => o.table === "channel_connections" && o.op === "upsert");
    expect(saveUpsert?.payload).toMatchObject({ client_id: "tenant-a", agent_id: 7 });

    const delRes = await POST(
      new NextRequest("http://localhost/api/whatsapp/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", instanceName: "own-cloud" }),
      })
    );
    expect(delRes.status).toBe(200);
    const delOp = state.ops.find((o) => o.table === "channel_connections" && o.op === "delete");
    expect(delOp?.filters).toContainEqual(["client_id", "tenant-a"]);
  });
});
