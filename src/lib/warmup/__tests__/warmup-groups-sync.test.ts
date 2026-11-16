import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = vi.hoisted(() => ({
  whatsapp_warmup_configs: [],
  whatsapp_warmup_groups: [],
  whatsapp_warmup_group_members: [],
  whatsapp_warmup_logs: [],
  app_settings: [],
}));

const mocks = vi.hoisted(() => ({
  acceptGroupInvite: vi.fn(),
  markMessageAsRead: vi.fn().mockResolvedValue({}),
  sendReaction: vi.fn().mockResolvedValue({}),
}));

type Chain = {
  select: () => Chain;
  insert: (data: Row | Row[]) => Chain;
  upsert: (data: Row) => Chain;
  update: (patch: Row) => Chain;
  eq: (col: string, val: unknown) => Chain;
  in: (col: string, vals: unknown[]) => Chain;
  maybeSingle: () => Chain;
  then: <TResult1 = { data: Row | Row[] | null; error: null }, TResult2 = never>(
    resolve?: ((value: { data: Row | Row[] | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) => Promise<TResult1 | TResult2>;
};

function buildQuery(table: string): Chain {
  const filters: Array<(row: Row) => boolean> = [];
  let updateData: Row | null = null;
  let single = false;

  const chain: Chain = {
    select() {
      return chain;
    },
    insert(data) {
      const list = (tables[table] ||= []);
      const rows = Array.isArray(data) ? data : [data];
      for (const r of rows) list.push({ ...r });
      return chain;
    },
    upsert(data) {
      const list = (tables[table] ||= []);
      const idx = list.findIndex((r) => data.key && r.key === data.key);
      if (idx >= 0) Object.assign(list[idx], data);
      else list.push({ ...data });
      return chain;
    },
    update(patch) {
      updateData = patch;
      return chain;
    },
    eq(col, val) {
      filters.push((row) => row[col] === val);
      return chain;
    },
    in(col, vals) {
      filters.push((row) => vals.includes(row[col]));
      return chain;
    },
    maybeSingle() {
      single = true;
      return chain;
    },
    then(resolve, reject) {
      const list = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
      if (updateData) {
        for (const r of list) Object.assign(r, updateData);
      }
      return Promise.resolve({
        data: single ? list[0] || null : list,
        error: null,
      }).then(resolve, reject);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (t: string) => buildQuery(t) },
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    acceptGroupInvite: mocks.acceptGroupInvite,
    markMessageAsRead: mocks.markMessageAsRead,
    sendReaction: mocks.sendReaction,
  },
}));

import {
  processIncomingGroupMessage,
  processPassiveOrganicGroupMessage,
  resetGroupReceiveBufferForTests,
  syncGroupMembershipForChips,
} from "../warmup-groups";

describe("syncGroupMembershipForChips — Prioridade Berçário & Links Mortos", () => {
  beforeEach(() => {
    resetGroupReceiveBufferForTests();
    mocks.acceptGroupInvite.mockReset();
    mocks.markMessageAsRead.mockClear();
    mocks.sendReaction.mockClear();
    for (const key of Object.keys(tables)) {
      tables[key].length = 0;
    }
  });

  it("prioriza chips Berçário (stage 1) antes de veteranos e marca convite revogado como invalid sem insistir", async () => {
    const clientId = "tenant-groups";
    tables.whatsapp_warmup_configs.push(
      { client_id: clientId, instance_name: "veterano-1", stage: 3, enabled: true, is_quarantined: false },
      { client_id: clientId, instance_name: "bercario-1", stage: 1, enabled: true, is_quarantined: false }
    );
    tables.whatsapp_warmup_groups.push(
      { id: "g-ok", client_id: clientId, invite_code: "VALID123", name: "Grupo Bom", status: "pending" },
      { id: "g-dead", client_id: clientId, invite_code: "DEAD404", name: "Grupo Morto", status: "pending" }
    );

    mocks.acceptGroupInvite.mockImplementation(async (code: string) => {
      if (code === "VALID123") return { success: true, groupJid: "1203630001@g.us" };
      return { success: false, error: "Invite link revoked (404)" };
    });

    const res = await syncGroupMembershipForChips(clientId);

    // Grupo válido aceita ambos os chips (berçário primeiro!), e grupo morto falha uma única vez e para no break
    expect(res.joinedCount).toBe(2);
    expect(mocks.acceptGroupInvite).toHaveBeenNthCalledWith(1, "VALID123", "bercario-1");
    expect(mocks.acceptGroupInvite).toHaveBeenNthCalledWith(2, "VALID123", "veterano-1");
    expect(mocks.acceptGroupInvite).toHaveBeenCalledTimes(3);
    expect(mocks.acceptGroupInvite).toHaveBeenNthCalledWith(3, "DEAD404", "bercario-1");

    const deadGroup = tables.whatsapp_warmup_groups.find((g) => g.id === "g-dead");
    expect(deadGroup?.status).toBe("invalid");
  });

  it("incrementa received_today em grupos de aquecimento e orgânicos passivos com deduplicação por messageId", async () => {
    const clientId = "tenant-recv";
    tables.whatsapp_warmup_configs.push({
      client_id: clientId,
      instance_name: "bercario-rx",
      enabled: true,
      is_quarantined: false,
      enable_blue_ticks: true,
      received_today: 2,
    });
    tables.whatsapp_warmup_groups.push({
      id: "g-1",
      client_id: clientId,
      group_jid: "120363999@g.us",
      total_messages_received: 5,
      total_reactions_sent: 1,
    });

    await processIncomingGroupMessage({
      clientId,
      instanceName: "bercario-rx",
      groupJid: "120363999@g.us",
      messageId: "msg-grupo-1",
      messageText: "Olá pessoal!",
    });
    // Mesmo messageId duplicado não incrementa 2x
    await processIncomingGroupMessage({
      clientId,
      instanceName: "bercario-rx",
      groupJid: "120363999@g.us",
      messageId: "msg-grupo-1",
      messageText: "Olá pessoal!",
    });
    // Grupo orgânico real também soma em received_today
    await processPassiveOrganicGroupMessage({
      clientId,
      instanceName: "bercario-rx",
      groupJid: "120363888@g.us",
      messageId: "msg-org-1",
    });

    expect(tables.whatsapp_warmup_configs[0].received_today).toBe(4);
  });
});

