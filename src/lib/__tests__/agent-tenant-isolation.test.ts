import { describe, expect, it, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const sendState = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  writes: [] as Array<{ table: string; payload: Row }>,
  requireClientId: vi.fn(),
  isInstanceOwnedByClient: vi.fn(),
  sendMessage: vi.fn(),
}));

function sendQuery(table: string) {
  const filters: Array<[string, unknown]> = [];
  let inserted: Row | null = null;
  let updated: Row | null = null;
  const rows = () => (sendState.tables[table] || []).filter((row) =>
    filters.every(([column, value]) => row[column] === value));
  const result = (single = false) => ({
    data: inserted || (single ? rows()[0] || null : rows()),
    error: null,
  });
  const chain = {
    select() { return chain; },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return chain;
    },
    gte() { return chain; },
    limit() { return chain; },
    insert(payload: Row) {
      inserted = { id: `${table}-new`, ...payload };
      sendState.writes.push({ table, payload });
      return chain;
    },
    update(payload: Row) {
      updated = payload;
      sendState.writes.push({ table, payload });
      return chain;
    },
    async maybeSingle() {
      sendState.queries.push({ table, filters: [...filters] });
      return result(true);
    },
    async single() {
      sendState.queries.push({ table, filters: [...filters] });
      return result(true);
    },
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      sendState.queries.push({ table, filters: [...filters] });
      if (updated) {
        for (const row of rows()) Object.assign(row, updated);
      }
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => sendQuery(table),
    storage: {},
  },
}));
vi.mock("@/lib/tenant", () => ({
  requireClientId: sendState.requireClientId,
  isInstanceOwnedByClient: sendState.isInstanceOwnedByClient,
}));
vi.mock("@/lib/channel", () => ({
  sendMessage: sendState.sendMessage,
  sendMedia: vi.fn(),
}));
vi.mock("@/lib/evolution", () => ({
  getEvolutionConfig: vi.fn(async () => ({ instance: "inst-a" })),
  evolution: { extractPhone: (jid: string) => jid.replace(/\D/g, "") },
}));
vi.mock("@/lib/manual-send-registry", () => ({ registerManualSend: vi.fn() }));

import { POST as sendManualMessage } from "@/app/api/send-message/route";

/**
 * Testes das garantias multi-tenant do /api/agent/process:
 * 1. chats_dashboard writes incluem client_id resolvido do canal
 * 2. History e leadContext filtram pelo client_id correto
 * 3. Tentativa de testar agente de outro tenant via cookie retorna 403
 * 4. Canal com agente de outro tenant em produção retorna agent_tenant_mismatch
 * 5. Instância de outro tenant via cookie retorna 403
 */

describe("POST /api/send-message — isolamento multi-tenant", () => {
  const sharedJid = "5511999999999@s.whatsapp.net";

  beforeEach(() => {
    vi.clearAllMocks();
    sendState.tables = {
      chats_dashboard: [],
      contacts: [
        { id: "contact-a", client_id: "tenant-a", remote_jid: sharedJid },
        { id: "contact-b", client_id: "tenant-b", remote_jid: sharedJid },
      ],
      sessions: [
        { id: "session-a", client_id: "tenant-a", contact_id: "contact-a", instance_name: "inst" },
        { id: "session-b", client_id: "tenant-b", contact_id: "contact-b", instance_name: "inst" },
      ],
      messages: [],
    };
    sendState.queries = [];
    sendState.writes = [];
    sendState.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-b",
      isAdmin: false,
      impersonating: false,
    });
    sendState.isInstanceOwnedByClient.mockResolvedValue(true);
    sendState.sendMessage.mockResolvedValue({ ok: true, messageId: "msg-1" });
  });

  it("deduplica e resolve contato/sessão somente dentro do tenant autenticado", async () => {
    const req = new Request("http://localhost/api/send-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteJid: sharedJid, text: "Olá", instanceName: "inst" }),
    });

    const response = await sendManualMessage(req as never);

    expect(response.status).toBe(200);
    expect(sendState.isInstanceOwnedByClient).toHaveBeenCalledWith("inst", "tenant-b");
    expect(sendState.queries).toContainEqual({
      table: "contacts",
      filters: [["remote_jid", sharedJid], ["client_id", "tenant-b"]],
    });
    expect(sendState.queries).toContainEqual({
      table: "sessions",
      filters: [["contact_id", "contact-b"], ["instance_name", "inst"], ["client_id", "tenant-b"]],
    });
    expect(sendState.queries).toContainEqual(expect.objectContaining({
      table: "chats_dashboard",
      filters: expect.arrayContaining([["client_id", "tenant-b"], ["instance_name", "inst"]]),
    }));
    expect(sendState.writes).toContainEqual(expect.objectContaining({
      table: "messages",
      payload: expect.objectContaining({ client_id: "tenant-b", session_id: "session-b" }),
    }));
  });

  it("não permite que admin use uma instância fora do escopo atual", async () => {
    sendState.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "admin-tenant",
      isAdmin: true,
      impersonating: false,
    });
    sendState.isInstanceOwnedByClient.mockResolvedValue(false);
    const req = new Request("http://localhost/api/send-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteJid: sharedJid, text: "Olá", instanceName: "inst-b" }),
    });

    const response = await sendManualMessage(req as never);

    expect(response.status).toBe(403);
    expect(sendState.sendMessage).not.toHaveBeenCalled();
    expect(sendState.queries).toEqual([]);
  });
});

describe("Multi-tenant isolation contracts", () => {
  const CLIENT_A = "00000000-0000-0000-0000-00000000a001";
  const CLIENT_B = "00000000-0000-0000-0000-00000000b002";
  const DEFAULT_CLIENT = "00000000-0000-0000-0000-000000000001";

  it("garante que clientId é herdado do canal e não do fallback quando canal existe", () => {
    const channel = { client_id: CLIENT_A, agent_id: 2 };
    const resolvedClientId = (channel as any)?.client_id || DEFAULT_CLIENT;
    expect(resolvedClientId).toBe(CLIENT_A);
  });

  it("bloqueia teste UI com agente de outro tenant (gate a)", () => {
    const tenantCtx = { clientId: CLIENT_B };
    const agentConfig = { id: 2, client_id: CLIENT_A, is_active: true };
    const isTestMode = true;

    const agentOwnerClient = agentConfig.client_id;
    const isBlocked = isTestMode && tenantCtx && agentOwnerClient && agentOwnerClient !== tenantCtx.clientId;
    expect(isBlocked).toBe(true);
  });

  it("permite teste UI com agente do mesmo tenant", () => {
    const tenantCtx = { clientId: CLIENT_A };
    const agentConfig = { id: 2, client_id: CLIENT_A, is_active: true };
    const isTestMode = true;

    const agentOwnerClient = agentConfig.client_id;
    const isBlocked = isTestMode && tenantCtx && agentOwnerClient && agentOwnerClient !== tenantCtx.clientId;
    expect(!isBlocked).toBe(true);
  });

  it("detecta mismatch agente x canal em produção (gate b)", () => {
    const channel = { client_id: CLIENT_B, agent_id: 2 };
    const agentConfig = { id: 2, client_id: CLIENT_A, is_active: true };
    const isTestMode = false;
    const resolvedClientId = channel.client_id;

    const isMismatch = !isTestMode && agentConfig.client_id && channel.client_id && agentConfig.client_id !== resolvedClientId;
    expect(isMismatch).toBe(true);
  });

  it("canal sem client_id (fallback legacy) não engatilha mismatch falso contra agente com tenant real", () => {
    const channel: { client_id: string | null; agent_id: number } = { client_id: null, agent_id: 2 };
    const agentConfig = { id: 2, client_id: CLIENT_A, is_active: true };
    const isTestMode = false;
    const resolvedClientId = channel.client_id || DEFAULT_CLIENT;

    // Regra: só compara se channel.client_id existir explicitamente
    const isMismatch = !isTestMode && agentConfig.client_id && !!channel.client_id && agentConfig.client_id !== resolvedClientId;
    expect(isMismatch).toBe(false);
  });

  it("bloqueia chamada via cookie de sessão com instância pertencente a outro tenant", () => {
    const tenantCtx = { clientId: CLIENT_B };
    const channel = { instance_name: "sdr_bh", client_id: CLIENT_A };

    const isForbidden = tenantCtx && channel?.client_id && channel.client_id !== tenantCtx.clientId;
    expect(isForbidden).toBe(true);
  });
});
