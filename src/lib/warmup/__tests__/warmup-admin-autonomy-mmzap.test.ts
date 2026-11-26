// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state: Record<string, Array<Record<string, unknown>>> = {
  clients: [],
  channel_connections: [],
  whatsapp_warmup_configs: [],
  whatsapp_warmup_groups: [],
  whatsapp_warmup_group_members: [],
  whatsapp_warmup_logs: [],
  whatsapp_warmup_conversations: [],
  whatsapp_phone_passports: [],
  warmup_external_quarantine: [],
  contacts: [],
  sessions: [],
  messages: [],
  chats_dashboard: [],
  campaign_targets: [],
  webhook_logs: [],
  app_settings: [],
  proxy_pool: [],
};

const evolutionMock = vi.hoisted(() => ({
  fetchInstances: vi.fn(async () => ({ instances: [] as Array<Record<string, unknown>> })),
  findWebhook: vi.fn(async () => ({
    enabled: false,
    url: "",
    events: [] as string[],
  })),
  setWebhook: vi.fn(async () => ({ ok: true })),
  findProxy: vi.fn(async () => ({ enabled: false })),
  removeProxy: vi.fn(async () => ({ ok: true })),
  restartInstance: vi.fn(async () => ({ ok: true })),
  markMessageAsRead: vi.fn(async () => true),
  sendTextMessage: vi.fn(async () => ({ key: { id: "EVO-TX-1" } })),
  updateProfileName: vi.fn(async () => true),
  updateProfileStatus: vi.fn(async () => true),
  leaveGroup: vi.fn(async () => true),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: evolutionMock,
}));

vi.mock("@/lib/proxy-pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/proxy-pool")>();
  return {
    ...actual,
    getProxyPoolOverviewCache: vi.fn(async () => ({ hasPool: false, brHosts: new Set<string>() })),
    ensureProxyForInstance: vi.fn(async ({ instanceName }: { instanceName: string }) => ({
      ok: true,
      mode: "pool_assigned" as const,
      host: `198.51.100.${instanceName.length + 10}`,
      usedVpsFallback: false,
    })),
    fallbackInstanceToVps: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/warmup/warmup-pending-actions", () => ({
  enqueuePendingWarmupAction: vi.fn(async () => ({ id: "pa-1" })),
  claimAndRunPendingWarmupAction: vi.fn(async () => true),
  drainDuePendingWarmupActions: vi.fn(async () => 0),
  shouldCheckPendingWarmupActions: vi.fn(() => false),
}));

vi.mock("@/lib/supabase_admin", () => {
  function makeBuilder(table: string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
    let onConflictCols: string[] = [];
    let limitNum: number | null = null;

    const execute = async () => {
      if (!state[table]) state[table] = [];
      if (op === "insert" && payload) {
        const items = (Array.isArray(payload) ? payload : [payload]).map((it, idx) => ({
          id: (it.id as string) || `${table}-${state[table].length + idx + 1}`,
          ...it,
        }));
        state[table].push(...items);
        return { data: items, error: null };
      }
      if (op === "upsert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const it of items) {
          const idx = state[table].findIndex(
            (r) => onConflictCols.length > 0 && onConflictCols.every((c) => r[c] === it[c])
          );
          if (idx >= 0) {
            state[table][idx] = { ...state[table][idx], ...it };
          } else {
            state[table].push({
              id: (it.id as string) || `${table}-${state[table].length + 1}`,
              ...it,
            });
          }
        }
        return { data: items, error: null };
      }
      if (op === "update" && payload && !Array.isArray(payload)) {
        const matches = state[table].filter((r) => filters.every((f) => f(r)));
        for (const row of matches) Object.assign(row, payload);
        return { data: matches, error: null };
      }
      if (op === "delete") {
        const removed = state[table].filter((r) => filters.every((f) => f(r)));
        state[table] = state[table].filter((r) => !filters.every((f) => f(r)));
        return { data: removed, error: null };
      }

      let rows = state[table].filter((r) => filters.every((f) => f(r)));
      if (limitNum !== null) rows = rows.slice(0, limitNum);
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (data: Record<string, unknown>) => {
        op = "insert";
        payload = data;
        return builder;
      },
      upsert: (data: Record<string, unknown>, opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = data;
        onConflictCols = String(opts?.onConflict || "").split(",").map((s) => s.trim()).filter(Boolean);
        return builder;
      },
      update: (data: Record<string, unknown>) => {
        op = "update";
        payload = data;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      neq: (col: string, val: unknown) => {
        filters.push((r) => r[col] !== val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitNum = n;
        return builder;
      },
      maybeSingle: async () => {
        const r = await execute();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = await execute();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) => execute().then(res, rej),
    };
    return builder;
  }

  const client = { from: (table: string) => makeBuilder(table) };
  return { supabaseAdmin: client, supabase: client };
});

import {
  ensureWarmupConfigsForTenant,
  listWarmupTenantIds,
} from "../warmup-config-service";
import { isTenantWarmupAdmin, requireWarmupAdminAccess } from "../warmup-admin-guard";
import {
  checkExternalWarmupInbound,
  invalidateExternalShieldCache,
} from "../warmup-external-shield";
import {
  readSelfHealingLog,
  resetSelfHealingForTests,
  runWarmupSelfHealingForTenant,
} from "../warmup-self-healing";
import { POST as whatsappWebhookPost } from "@/app/api/webhooks/whatsapp/route";

const ADMIN_ID = "00000000-0000-0000-0000-00000000a001";
const CLIENT_USER_ID = "9f1f8ffc-f550-4427-862f-de8a475b16b0";

describe("Aquecedor Exclusivo ADM + Auto-Cura Autônoma + Chegada Real MMZap no Webhook", () => {
  beforeEach(() => {
    for (const k of Object.keys(state)) state[k] = [];
    vi.clearAllMocks();
    resetSelfHealingForTests();
    invalidateExternalShieldCache();
  });

  it("trava 100% para ADM: nenhum chip de cliente comum entra no aquecedor, worker ou Escudo MMZap", async () => {
    state.clients.push(
      { id: ADMIN_ID, name: "Gabriel ADM", is_admin: true, is_active: true },
      { id: CLIENT_USER_ID, name: "Jaqueline Cliente", is_admin: false, is_active: true }
    );
    state.channel_connections.push(
      { instance_name: "adm_chip_1", client_id: ADMIN_ID, status: "open", provider_config: { owner_phone: "5511999990001" } },
      { instance_name: "cliente_chip_1", client_id: CLIENT_USER_ID, status: "open", provider_config: { owner_phone: "5511988887777" } }
    );
    state.whatsapp_warmup_configs.push({
      client_id: CLIENT_USER_ID,
      instance_name: "cliente_chip_1",
      external_warmup_mode: "receive_only",
      enabled: true,
    });

    // listWarmupTenantIds só devolve ADM
    const eligibleTenants = await listWarmupTenantIds();
    expect(eligibleTenants).toEqual([ADMIN_ID]);

    // ensureWarmupConfigsForTenant ignora cliente comum e cadastra apenas ADM
    expect(await isTenantWarmupAdmin(CLIENT_USER_ID)).toBe(false);
    expect(await isTenantWarmupAdmin(ADMIN_ID)).toBe(true);

    const clientEnsure = await ensureWarmupConfigsForTenant(CLIENT_USER_ID);
    expect(clientEnsure.created).toHaveLength(0);

    const adminEnsure = await ensureWarmupConfigsForTenant(ADMIN_ID);
    expect(adminEnsure.created).toEqual(["adm_chip_1"]);
    const admCfg = state.whatsapp_warmup_configs.find((r) => r.instance_name === "adm_chip_1");
    // Chip ADM novo já nasce com Escudo MMZap receive_only armado
    expect(admCfg?.external_warmup_mode).toBe("receive_only");

    // Escudo MMZap não intercepta chip de cliente comum
    const clientShield = await checkExternalWarmupInbound({
      clientId: CLIENT_USER_ID,
      instanceName: "cliente_chip_1",
      remoteJid: "5521999991111@s.whatsapp.net",
      messageText: "Oi",
    });
    expect(clientShield.blocked).toBe(false);

    // Guard HTTP bloqueia cliente comum e admin impersonando cliente
    expect(requireWarmupAdminAccess({ isAdmin: false, impersonating: false })?.status).toBe(403);
    expect(requireWarmupAdminAccess({ isAdmin: true, impersonating: true })?.status).toBe(403);
    expect(requireWarmupAdminAccess({ isAdmin: true, impersonating: false })).toBeNull();
  });

  it("auto-cura detecta e repara webhook desligado, status preso, proxy morto e colisão de proxy entre chips ADM", async () => {
    state.clients.push({ id: ADMIN_ID, name: "Gabriel ADM", is_admin: true, is_active: true });
    state.channel_connections.push(
      {
        instance_name: "adm_01",
        client_id: ADMIN_ID,
        status: "close",
        provider_config: { owner_phone: "5511999990001", webhook_secret: "sec-123" },
      },
      {
        instance_name: "adm_02",
        client_id: ADMIN_ID,
        status: "open",
        provider_config: { owner_phone: "5511999990002" },
      }
    );

    evolutionMock.fetchInstances.mockResolvedValue({
      instances: [
        { instance: { instanceName: "adm_01", connectionStatus: "open", owner: "5511999990001@s.whatsapp.net" } },
        { instance: { instanceName: "adm_02", connectionStatus: "open", owner: "5511999990002@s.whatsapp.net" } },
      ],
    });

    evolutionMock.findWebhook.mockResolvedValue({
      enabled: false,
      url: "",
      events: [],
    });

    // Colisão idêntica ao cenário real observado (23.129.254.193:6175 nos 2 chips) + falha no teste de conectividade
    evolutionMock.findProxy.mockResolvedValue({
      enabled: true,
      host: "23.129.254.193",
      port: "6175",
      protocol: "http",
    });

    const report = await runWarmupSelfHealingForTenant(ADMIN_ID, {
      force: true,
      appBaseUrl: "https://painel.teste.com",
      proxyProbeFn: vi.fn(async () => ({ ok: false, error: "ETIMEDOUT" })),
    });

    expect(report.checkedChips).toBe(2);
    expect(report.fixedCount).toBeGreaterThanOrEqual(4);
    expect(evolutionMock.setWebhook).toHaveBeenCalledWith(
      "https://painel.teste.com/api/webhooks/whatsapp",
      "adm_01",
      "sec-123"
    );
    expect(state.channel_connections[0].status).toBe("open");

    const log = await readSelfHealingLog(ADMIN_ID);
    expect(log.length).toBeGreaterThanOrEqual(4);
    expect(log.some((entry) => entry.issue.includes("Webhook"))).toBe(true);
    expect(log.some((entry) => entry.issue.includes("23.129.254.193:6175"))).toBe(true);
  });

  it("teste real de chegada HTTP POST /api/webhooks/whatsapp com payload MMZap: blinda CRM/Sarah e contabiliza inbound", async () => {
    state.clients.push({ id: ADMIN_ID, name: "Gabriel ADM", is_admin: true, is_active: true });
    state.channel_connections.push({
      instance_name: "00000_numero2",
      client_id: ADMIN_ID,
      status: "open",
      provider_config: {
        owner_phone: "5511977770000",
        webhook_secret: "secret-mmzap-test",
        webhook_strict: true,
      },
    });
    state.whatsapp_warmup_configs.push({
      client_id: ADMIN_ID,
      instance_name: "00000_numero2",
      phone_number: "5511977770000",
      enabled: true,
      stage: 2,
      days_active: 17,
      health_score: 85,
      external_warmup_mode: "receive_only",
      enable_blue_ticks: true,
      received_today: 0,
      external_warmup_inbound_today: 0,
      external_warmup_inbound_total: 0,
    });

    const evoPayload = {
      event: "messages.upsert",
      instance: "00000_numero2",
      data: {
        key: {
          remoteJid: "5531988884444@s.whatsapp.net",
          fromMe: false,
          id: "MMZAP-REAL-MSG-991",
        },
        pushName: "Participante MMZap",
        message: {
          conversation: "Bom dia! Ótima quinta-feira pra você e sua família 🙏",
        },
        messageType: "conversation",
      },
    };

    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": "secret-mmzap-test",
      },
      body: JSON.stringify(evoPayload),
    });

    const res = await whatsappWebhookPost(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      ignored: true,
      reason: "external_warmup_receive_only",
      classification: "external_warmup_inbound",
    });

    // Garantia absoluta: zero criação de contato/sessão/chat e zero resposta enviada
    expect(state.contacts).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
    expect(state.messages).toHaveLength(0);
    expect(state.chats_dashboard).toHaveLength(0);
    expect(evolutionMock.sendTextMessage).not.toHaveBeenCalled();

    // Garantia de contabilização real no chip + quarentena auditável
    expect(state.whatsapp_warmup_configs[0].received_today).toBe(1);
    expect(state.whatsapp_warmup_configs[0].external_warmup_inbound_today).toBe(1);
    expect(state.warmup_external_quarantine).toHaveLength(1);
    expect(state.warmup_external_quarantine[0].canonical_sender_phone).toBe("5531988884444");
  });
});
