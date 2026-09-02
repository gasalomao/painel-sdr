import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type QueryResult = { data: Row | Row[] | null; error: null };

const tables: Record<string, Row[]> = {
  channel_connections: [],
  contacts: [],
  leads_extraidos: [],
  sessions: [],
  campaigns: [],
  campaign_targets: [],
};

const tenantMocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  isInstanceOwnedByClient: vi.fn(),
}));

function query(tableName: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let inserted: Row[] | null = null;
  let updatePayload: Row | null = null;
  let deleting = false;
  let single = false;

  const chain = {
    select() {
      return chain;
    },
    insert(value: Row | Row[]) {
      inserted = Array.isArray(value) ? value : [value];
      for (const row of inserted) {
        if (!row.id) row.id = `${tableName}-${tables[tableName].length + 1}`;
        tables[tableName].push(row);
      }
      return chain;
    },
    upsert(value: Row | Row[]) {
      return chain.insert(value);
    },
    update(value: Row) {
      updatePayload = value;
      return chain;
    },
    delete() {
      deleting = true;
      return chain;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return chain;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return chain;
    },
    is(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return chain;
    },
    order() {
      return chain;
    },
    maybeSingle() {
      single = true;
      return chain;
    },
    single() {
      single = true;
      return chain;
    },
    then(resolve: (result: QueryResult) => void) {
      const rows = inserted ?? tables[tableName].filter((row) => filters.every((filter) => filter(row)));
      if (updatePayload) rows.forEach((row) => Object.assign(row, updatePayload));
      if (deleting) {
        for (const row of rows) tables[tableName].splice(tables[tableName].indexOf(row), 1);
      }
      resolve({ data: single ? rows[0] ?? null : rows, error: null });
    },
  };

  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (tableName: string) => query(tableName) },
}));
vi.mock("@/lib/evolution", () => ({ evolution: {} }));
vi.mock("@/lib/channel", () => ({}));
vi.mock("@/lib/template-vars", () => ({ renderTemplate: (value: string) => value }));
vi.mock("@/lib/web-search", () => ({ webSearch: vi.fn(), formatResultsForAI: vi.fn() }));
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: vi.fn() }));
vi.mock("@/lib/tenant", () => ({
  clientIdFromInstance: vi.fn(),
  requireClientId: tenantMocks.requireClientId,
  isInstanceOwnedByClient: tenantMocks.isInstanceOwnedByClient,
}));
vi.mock("@/lib/enforce-model", () => ({ enforceClientDefaultModel: vi.fn() }));
vi.mock("@/lib/manual-send-registry", () => ({
  registerAiSend: vi.fn(),
  registerPendingAutomatedSend: vi.fn(),
}));
vi.mock("@/lib/agent-format", () => ({ splitMessage: (value: string) => [value] }));

import { POST as createCampaign } from "@/app/api/campaigns/route";
import { PATCH as updateCampaign } from "@/app/api/campaigns/[id]/route";
import { findOrCreateContactSession } from "../campaign-worker";
import { getCachedIntelligence } from "../lead-intelligence";

const sharedJid = "5511999999999@s.whatsapp.net";

beforeEach(() => {
  for (const rows of Object.values(tables)) rows.length = 0;
  vi.clearAllMocks();
  tenantMocks.requireClientId.mockResolvedValue({
    ok: true,
    clientId: "tenant-a",
    isAdmin: false,
    impersonating: false,
  });
  tenantMocks.isInstanceOwnedByClient.mockResolvedValue(true);
});

describe("POST /api/campaigns — isolamento de targets", () => {
  function request(leadIds: number[], remoteJids: string[] = []) {
    return new Request("http://localhost/api/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Campanha",
        instance_name: "instance-a",
        message_template: "Olá {nome}",
        lead_ids: leadIds,
        remote_jids: remoteJids,
      }),
    });
  }

  it("rejeita instance_name de outro tenant no POST antes de criar dados", async () => {
    tenantMocks.isInstanceOwnedByClient.mockResolvedValue(false);

    const response = await createCampaign(request([]) as never);

    expect(response.status).toBe(403);
    expect(tables.campaigns).toEqual([]);
    expect(tables.campaign_targets).toEqual([]);
  });

  it("rejeita instance_name de outro tenant no PATCH", async () => {
    tables.campaigns.push({
      id: "campaign-1",
      client_id: "tenant-a",
      name: "Original",
      instance_name: "instance-a",
    });
    tenantMocks.isInstanceOwnedByClient.mockResolvedValue(false);
    const req = new Request("http://localhost/api/campaigns/campaign-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance_name: "instance-b" }),
    });

    const response = await updateCampaign(req as never, {
      params: Promise.resolve({ id: "campaign-1" }),
    });

    expect(response.status).toBe(403);
    expect(tables.campaigns[0].instance_name).toBe("instance-a");
  });

  it("rejeita o lote inteiro quando um lead pertence a outro tenant", async () => {
    tables.leads_extraidos.push(
      { id: 1, client_id: "tenant-a", remoteJid: "551100000001@s.whatsapp.net" },
      { id: 2, client_id: "tenant-b", remoteJid: "551100000002@s.whatsapp.net" },
    );

    const response = await createCampaign(request([1, 2]) as never);

    expect(response.status).toBe(403);
    expect(tables.campaigns).toEqual([]);
    expect(tables.campaign_targets).toEqual([]);
  });

  it("grava client_id em todos os targets de um lote válido", async () => {
    tables.leads_extraidos.push({
      id: 1,
      client_id: "tenant-a",
      remoteJid: "551100000001@s.whatsapp.net",
      nome_negocio: "Lead A",
      ramo_negocio: "Varejo",
    });

    const response = await createCampaign(request([1], ["551100000003@s.whatsapp.net"]) as never);

    expect(response.status).toBe(200);
    expect(tables.campaigns).toHaveLength(1);
    expect(tables.campaigns[0].client_id).toBe("tenant-a");
    expect(tables.campaign_targets).toHaveLength(2);
    expect(tables.campaign_targets.every((target) => target.client_id === "tenant-a")).toBe(true);
  });
});

describe("isolamento multi-tenant por JID", () => {
  it("retorna somente a intelligence do tenant solicitado", async () => {
    tables.leads_extraidos.push(
      { client_id: "tenant-a", remoteJid: sharedJid, intelligence: { briefing_md: "tenant A" } },
      { client_id: "tenant-b", remoteJid: sharedJid, intelligence: { briefing_md: "tenant B" } },
    );

    const result = await getCachedIntelligence(sharedJid, "tenant-b");

    expect(result?.briefing_md).toBe("tenant B");
  });

  it("seleciona o contato do tenant solicitado para um JID compartilhado", async () => {
    tables.contacts.push(
      { id: "contact-a", client_id: "tenant-a", remote_jid: sharedJid, push_name: "A" },
      { id: "contact-b", client_id: "tenant-b", remote_jid: sharedJid, push_name: "B" },
    );
    tables.sessions.push(
      { id: "session-a", client_id: "tenant-a", contact_id: "contact-a", instance_name: "instance" },
      { id: "session-b", client_id: "tenant-b", contact_id: "contact-b", instance_name: "instance" },
    );

    const result = await findOrCreateContactSession("tenant-b", sharedJid, "instance");

    expect(result).toEqual({ contactId: "contact-b", sessionId: "session-b" });
  });

  it("cria no tenant solicitado sem reatribuir o contato de outro tenant", async () => {
    tables.channel_connections.push({ client_id: "tenant-c", instance_name: "instance", agent_id: 7 });
    tables.contacts.push({ id: "contact-a", client_id: "tenant-a", remote_jid: sharedJid, push_name: "A" });

    const result = await findOrCreateContactSession("tenant-c", sharedJid, "instance", "C");

    expect(tables.contacts).toContainEqual(expect.objectContaining({
      id: result?.contactId,
      client_id: "tenant-c",
      remote_jid: sharedJid,
      push_name: "C",
    }));
    expect(tables.contacts[0]).toEqual({
      id: "contact-a",
      client_id: "tenant-a",
      remote_jid: sharedJid,
      push_name: "A",
    });
    expect(tables.sessions).toContainEqual(expect.objectContaining({
      client_id: "tenant-c",
      contact_id: result?.contactId,
      instance_name: "instance",
      agent_id: 7,
    }));
  });
});
