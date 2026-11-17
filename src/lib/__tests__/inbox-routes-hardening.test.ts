// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type FilterTuple = [string, unknown];

interface RecordedOp {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filters: FilterTuple[];
}

const state = vi.hoisted(() => ({
  ops: [] as RecordedOp[],
  selectResults: new Map<string, { data: unknown; error: unknown; count?: number }>(),
  mutationErrors: new Map<string, { message: string }>(),
  requireClientId: vi.fn(),
  isInstanceOwnedByClient: vi.fn(),
  invalidateInstanceCache: vi.fn(),
  hasInternalSecret: vi.fn(),
  deleteInstance: vi.fn(),
  sendMedia: vi.fn(),
  storageUpload: vi.fn(),
  storageGetBucket: vi.fn(),
  storageGetPublicUrl: vi.fn((path: string) => ({
    data: { publicUrl: `https://cdn.example/whatsapp_media/${path}` },
  })),
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
    if (op === "select") {
      return state.selectResults.get(table) ?? { data: null, error: null, count: 0 };
    }
    const err = state.mutationErrors.get(`${table}:${op}`) ?? null;
    if (op === "insert") {
      return { data: err ? null : { id: `${table}-1`, ...(payload as object) }, error: err };
    }
    return { data: null, error: err };
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
    delete: () => {
      op = "delete";
      return chain;
    },
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return chain;
    },
    gte: () => chain,
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
    storage: {
      getBucket: state.storageGetBucket,
      createBucket: vi.fn(async () => ({ error: null })),
      from: () => ({
        upload: state.storageUpload,
        getPublicUrl: state.storageGetPublicUrl,
      }),
    },
  },
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: state.requireClientId,
  isInstanceOwnedByClient: state.isInstanceOwnedByClient,
  invalidateInstanceCache: state.invalidateInstanceCache,
  clientIdFromInstance: vi.fn(async () => null),
}));

vi.mock("@/lib/internal-auth", () => ({
  hasInternalSecret: state.hasInternalSecret,
}));

vi.mock("@/lib/evolution", () => ({
  getEvolutionConfig: vi.fn(async () => ({ instance: "inst-default" })),
  evolution: {
    extractPhone: (jid: string) => jid.replace(/\D/g, ""),
    deleteInstance: state.deleteInstance,
  },
}));

vi.mock("@/lib/channel", () => ({
  sendMessage: vi.fn(async () => ({ ok: true, messageId: "m-1" })),
  sendMedia: state.sendMedia,
}));

vi.mock("@/lib/manual-send-registry", () => ({
  registerManualSend: vi.fn(),
}));

vi.mock("@/lib/organizer-config-cache", () => ({
  getOrganizerConfig: vi.fn(async () => null),
}));

describe("Hardening de rotas de instância, send-message, chat/sync e webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ops = [];
    state.selectResults.clear();
    state.mutationErrors.clear();
    state.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-a",
      isAdmin: true,
      claims: { email: "admin@example.com" },
    });
    state.isInstanceOwnedByClient.mockResolvedValue(true);
    state.hasInternalSecret.mockReturnValue(true);
    state.deleteInstance.mockResolvedValue({});
    state.sendMedia.mockResolvedValue({ ok: true, key: { id: "media-1" } });
    state.storageGetBucket.mockResolvedValue({ data: { name: "whatsapp_media" }, error: null });
    state.storageUpload.mockResolvedValue({ error: null });
  });

  it("instance/delete escopa counts, purge e channel_connections ao client_id da instância mesmo para admin", async () => {
    state.selectResults.set("channel_connections", {
      data: {
        instance_name: "inst-a",
        client_id: "tenant-b",
        status: "close",
        provider: "evolution",
        provider_config: { owner_phone: "5511999990000" },
      },
      error: null,
    });

    const { POST } = await import("@/app/api/whatsapp/instance/delete/route");
    const res = await POST(
      new NextRequest("http://localhost/api/whatsapp/instance/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName: "inst-a", force: true, purgeMessages: true }),
      })
    );

    expect(res.status).toBe(200);
    for (const table of ["chats_dashboard", "sessions", "webhook_logs"]) {
      const selectOp = state.ops.find((o) => o.table === table && o.op === "select");
      const deleteOp = state.ops.find((o) => o.table === table && o.op === "delete");
      expect(selectOp?.filters).toContainEqual(["client_id", "tenant-b"]);
      expect(deleteOp?.filters).toContainEqual(["client_id", "tenant-b"]);
    }
    const connDelete = state.ops.find((o) => o.table === "channel_connections" && o.op === "delete");
    expect(connDelete?.filters).toContainEqual(["client_id", "tenant-b"]);
  });

  it("instance/delete em modo preservação escopa updates phone: por client_id e reporta erro parcial", async () => {
    state.selectResults.set("channel_connections", {
      data: {
        instance_name: "inst-a",
        client_id: "tenant-b",
        status: "close",
        provider: "whatsapp_cloud",
        provider_config: { owner_phone: "5511999990000" },
      },
      error: null,
    });
    state.mutationErrors.set("sessions:update", { message: "db lock" });

    const { POST } = await import("@/app/api/whatsapp/instance/delete/route");
    const res = await POST(
      new NextRequest("http://localhost/api/whatsapp/instance/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName: "inst-a", force: true, purgeMessages: false }),
      })
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(json.details).toEqual([{ step: "sessions_remap", error: "db lock" }]);
    for (const table of ["chats_dashboard", "sessions", "messages"]) {
      const upd = state.ops.find((o) => o.table === table && o.op === "update");
      expect(upd?.filters).toContainEqual(["client_id", "tenant-b"]);
    }
  });

  it("chat/sync exige tenant, resolve via instanceName e bloqueia divergência cross-tenant com 403", async () => {
    const { POST } = await import("@/app/api/chat/sync/route");

    const missingTenant = await POST(
      new NextRequest("http://localhost/api/chat/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999990000@s.whatsapp.net", type: "client", content: "Oi" }),
      })
    );
    expect(missingTenant.status).toBe(400);

    state.selectResults.set("channel_connections", { data: { client_id: "tenant-b" }, error: null });
    const crossTenant = await POST(
      new NextRequest("http://localhost/api/chat/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid: "5511999990000@s.whatsapp.net",
          type: "client",
          content: "Oi",
          client_id: "tenant-a",
          instanceName: "inst-b",
        }),
      })
    );
    expect(crossTenant.status).toBe(403);

    const okRes = await POST(
      new NextRequest("http://localhost/api/chat/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid: "5511999990000@s.whatsapp.net",
          type: "client",
          content: "Oi",
          instanceName: "inst-b",
        }),
      })
    );
    expect(okRes.status).toBe(200);
    const ins = state.ops.find((o) => o.table === "chats_dashboard" && o.op === "insert");
    expect(ins?.payload).toMatchObject({ client_id: "tenant-b", instance_name: "inst-b" });
  });

  it("send-message usa uploadMediaBase64 sanitizado com prefixo clientId e oculta detalhe em 500", async () => {
    const { POST } = await import("@/app/api/send-message/route");

    const badMediaRes = await POST(
      new NextRequest("http://localhost/api/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid: "phone:5511999990000",
          instanceName: "inst-a",
          media: { type: "document", base64: "PHN2Zz4=", fileName: "xss.svg", mimetype: "image/svg+xml" },
        }),
      })
    );
    expect(badMediaRes.status).toBe(200);
    expect(state.storageUpload).not.toHaveBeenCalled();

    const okMediaRes = await POST(
      new NextRequest("http://localhost/api/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid: "5511999990000@s.whatsapp.net",
          instanceName: "inst-a",
          media: { type: "image", base64: "iVBORw0KGgo=", fileName: "foto.png", mimetype: "image/png" },
        }),
      })
    );
    const okJson = await okMediaRes.json();
    expect(okMediaRes.status).toBe(200);
    expect(okJson.mediaUrl).toMatch(/^https:\/\/cdn\.example\/whatsapp_media\/tenant-a\/5511999990000@s\.whatsapp\.net\/\d+\.png$/);

    const errRes = await POST(
      new NextRequest("http://localhost/api/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{invalid-json",
      })
    );
    const errJson = await errRes.json();
    expect(errRes.status).toBe(500);
    expect(errJson.error).toBe("Erro interno ao enviar mensagem");
  });

  it("webhooks/whatsapp não vaza mensagem de exceção interna no HTTP 500", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      body: "{json-malformado-segredo",
    });

    const res = await POST(req);
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.error).toBe("Erro interno ao processar webhook");
  });
});
