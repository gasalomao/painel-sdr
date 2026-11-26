import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dbState: Record<string, Array<Record<string, unknown>>> = {
  whatsapp_warmup_configs: [],
  channel_connections: [],
  app_settings: [],
  campaign_targets: [],
  leads_extraidos: [],
  contacts: [],
  scheduled_preview_deliveries: [],
  campaigns: [],
  followup_campaigns: [],
  automations: [],
  sessions: [],
};

const sendMessageMock = vi.fn(async () => ({ ok: true, messageId: "msg-prev-1" }));
const registerAiSendMock = vi.fn();
const registerPendingAutomatedSendMock = vi.fn();
const validateCampaignInstanceAccessMock = vi.fn(async (_clientId: string, inst: string) => {
  if (inst === "other_tenant_chip") {
    return { ok: false as const, status: 403, error: "Instância pertence a outro cliente" };
  }
  return { ok: true as const };
});

vi.mock("@/lib/supabase_admin", () => {
  function makeBuilder(table: string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
    let onConflictCols: string[] = [];

    const execute = async () => {
      if (!dbState[table]) dbState[table] = [];
      if (op === "insert" && payload) {
        const items = (Array.isArray(payload) ? payload : [payload]).map((it, idx) => ({
          id: it.id ?? `${table}-${dbState[table].length + idx + 1}`,
          ...it,
        }));
        dbState[table].push(...items);
        return { data: items, error: null };
      }
      if (op === "upsert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const it of items) {
          const idx = dbState[table].findIndex(
            (r) => onConflictCols.length > 0 && onConflictCols.every((c) => r[c] === it[c])
          );
          if (idx >= 0) dbState[table][idx] = { ...dbState[table][idx], ...it };
          else dbState[table].push({ id: `${table}-${dbState[table].length + 1}`, ...it });
        }
        return { data: items, error: null };
      }
      if (op === "update" && payload && !Array.isArray(payload)) {
        const matches = dbState[table].filter((r) => filters.every((f) => f(r)));
        for (const row of matches) Object.assign(row, payload);
        return { data: matches, error: null };
      }
      if (op === "delete") {
        const removed = dbState[table].filter((r) => filters.every((f) => f(r)));
        dbState[table] = dbState[table].filter((r) => !filters.every((f) => f(r)));
        return { data: removed, error: null };
      }
      const rows = dbState[table].filter((r) => filters.every((f) => f(r)));
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (data: Record<string, unknown> | Array<Record<string, unknown>>) => {
        op = "insert";
        payload = data;
        return builder;
      },
      upsert: (data: Record<string, unknown> | Array<Record<string, unknown>>, opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = data;
        onConflictCols = String(opts?.onConflict || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
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
      lte: (col: string, val: unknown) => {
        filters.push((r) => String(r[col] ?? "") <= String(val ?? ""));
        return builder;
      },
      gte: (col: string, val: unknown) => {
        filters.push((r) => String(r[col] ?? "") >= String(val ?? ""));
        return builder;
      },
      like: (col: string, pat: string) => {
        const prefix = pat.replace(/%$/, "");
        filters.push((r) => String(r[col] ?? "").startsWith(prefix));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
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

  return {
    supabaseAdmin: {
      from: (table: string) => makeBuilder(table),
    },
  };
});

vi.mock("@/lib/channel", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  sendMedia: vi.fn(async () => ({ ok: true, messageId: "media-1" })),
  resolveChannel: vi.fn(async () => ({ provider: "evolution" })),
  getStatus: vi.fn(async () => ({ state: "open" })),
  checkWhatsAppNumbersDetailed: vi.fn(async () => ({})),
}));

vi.mock("@/lib/manual-send-registry", () => ({
  registerAiSend: (...args: unknown[]) => registerAiSendMock(...args),
  registerPendingAutomatedSend: (...args: unknown[]) => registerPendingAutomatedSendMock(...args),
  registerPendingAutomatedMedia: vi.fn(),
}));

vi.mock("@/lib/agent-config-cache", () => ({
  invalidateAgentConfigCache: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => ({ ok: true, clientId: "tenant-1", isAdmin: false })),
  isInstanceOwnedByClient: vi.fn(async () => true),
}));

vi.mock("@/lib/saas-limits", () => ({
  requireFeatureAccess: vi.fn(() => null),
  checkTenantAiQuota: vi.fn(async () => ({ allowed: true })),
  isClientActiveCached: vi.fn(async () => true),
  isClientAdminCached: vi.fn(async () => false),
}));

vi.mock("@/lib/campaign-instance-access", () => ({
  validateCampaignInstanceAccess: (...args: unknown[]) =>
    validateCampaignInstanceAccessMock(...(args as [string, string])),
}));

import {
  __resetCampaignAntiBanStateForTests,
  resolveHealthyCampaignChip,
} from "../campaign-worker";
import { computeCampaignAbSummary } from "../campaign-ab-testing";
import { tickScheduledPreviewDeliveries } from "../preview-delivery-queue";
import { hotswapBannedInstance } from "../whatsapp-hotswap";
import { POST as optOutPost } from "@/app/api/prospeccao-sites/opt-out/route";
import { POST as previewQueuePost } from "@/app/api/prospeccao-sites/preview-queue/route";

const CLIENT_ID = "tenant-1";

describe("Prospecting Audit Regressions", () => {
  beforeEach(() => {
    for (const k of Object.keys(dbState)) dbState[k] = [];
    __resetCampaignAntiBanStateForTests();
    sendMessageMock.mockClear();
    registerAiSendMock.mockClear();
    registerPendingAutomatedSendMock.mockClear();
    validateCampaignInstanceAccessMock.mockClear();
  });

  it("exclui chips em receive_only (MMZap-only) e desconectados no __auto_pool__", async () => {
    dbState.whatsapp_warmup_configs.push(
      {
        client_id: CLIENT_ID,
        instance_name: "chip_mmzap_only",
        enabled: true,
        stage: 4,
        days_active: 20,
        health_score: 100,
        is_quarantined: false,
        external_warmup_mode: "receive_only",
      },
      {
        client_id: CLIENT_ID,
        instance_name: "chip_offline",
        enabled: true,
        stage: 4,
        days_active: 20,
        health_score: 100,
        is_quarantined: false,
        external_warmup_mode: "off",
      }
    );
    dbState.channel_connections.push(
      { client_id: CLIENT_ID, instance_name: "chip_mmzap_only", status: "open" },
      { client_id: CLIENT_ID, instance_name: "chip_offline", status: "close" }
    );

    const res = await resolveHealthyCampaignChip(CLIENT_ID, "__auto_pool__", { dryRun: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_eligible_pool_chip");

    // Mesmo quando TODOS os chips estão desconectados (openSet.size === 0), nunca faz fail-open
    dbState.whatsapp_warmup_configs[0].external_warmup_mode = "off";
    dbState.channel_connections[0].status = "close";
    const allOffline = await resolveHealthyCampaignChip(CLIENT_ID, "__auto_pool__", { dryRun: true });
    expect(allOffline.ok).toBe(false);
  });

  it("atribui replies no Teste A/B via status='replied' e variantes BR 8/9º dígito", async () => {
    dbState.app_settings.push(
      {
        key: "campaign_ab_config:camp-ab-1",
        value: JSON.stringify({
          enabled: true,
          variantA_label: "A",
          variantA_template: "Oi A",
          variantB_label: "B",
          variantB_template: "Oi B",
          auto_pause_below_pct: 10,
          min_sample_size: 20,
          paused_variant: null,
          paused_reason: null,
        }),
      },
      {
        key: "campaign_ab_stats:camp-ab-1",
        value: JSON.stringify({
          sends: {
            "5511988887777@s.whatsapp.net": "A",
            "551188886666@s.whatsapp.net": "B", // sem 9º dígito
          },
          counts: { A: 1, B: 1 },
        }),
      }
    );
    dbState.campaign_targets.push(
      {
        campaign_id: "camp-ab-1",
        client_id: CLIENT_ID,
        remote_jid: "5511988887777@s.whatsapp.net",
        status: "replied",
      },
      {
        campaign_id: "camp-ab-1",
        client_id: CLIENT_ID,
        remote_jid: "5511988886666@s.whatsapp.net", // com 9º dígito
        status: "sent",
      }
    );
    dbState.leads_extraidos.push({
      client_id: CLIENT_ID,
      remoteJid: "551188886666@s.whatsapp.net",
      status: "em_conversa",
      previa_status: "PREVIA_SOLICITADA",
    });

    const { summary } = await computeCampaignAbSummary(CLIENT_ID, "camp-ab-1", "Teste AB");
    expect(summary).not.toBeNull();
    expect(summary?.variants[0].sent).toBe(1);
    expect(summary?.variants[0].replied).toBe(1);
    expect(summary?.variants[1].sent).toBe(1);
    expect(summary?.variants[1].replied).toBe(1);
    expect(summary?.variants[1].preview_accepted).toBe(1);
  });

  it("evita duplo envio na fila de prévias via CAS atômico e registra registerAiSend", async () => {
    dbState.scheduled_preview_deliveries.push({
      id: "prev-1",
      client_id: CLIENT_ID,
      remote_jid: "5511999990000@s.whatsapp.net",
      instance_name: "chip_1",
      preview_url: "https://preview.example.com/1",
      message_text: "Sua prévia está pronta!",
      delivery_slot: "now",
      scheduled_for: new Date(Date.now() - 60_000).toISOString(),
      status: "pending",
    });

    const [r1, r2] = await Promise.all([
      tickScheduledPreviewDeliveries(Date.now()),
      tickScheduledPreviewDeliveries(Date.now()),
    ]);

    expect(r1.sent + r2.sent).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(registerAiSendMock).toHaveBeenCalledWith("msg-prev-1");
  });

  it("hotswap migra entregas de prévias agendadas pendentes para o chip substituto", async () => {
    dbState.channel_connections.push(
      { instance_name: "chip_ban", agent_id: 5, client_id: CLIENT_ID, status: "close" },
      { instance_name: "chip_ok", agent_id: null, client_id: CLIENT_ID, status: "open" }
    );
    dbState.scheduled_preview_deliveries.push(
      { id: "p-pending", client_id: CLIENT_ID, instance_name: "chip_ban", status: "pending" },
      { id: "p-sent", client_id: CLIENT_ID, instance_name: "chip_ban", status: "sent" }
    );

    const swap = await hotswapBannedInstance({
      clientId: CLIENT_ID,
      oldInstanceName: "chip_ban",
      newInstanceName: "chip_ok",
    });

    expect(swap.ok).toBe(true);
    expect(dbState.scheduled_preview_deliveries[0].instance_name).toBe("chip_ok");
    expect(dbState.scheduled_preview_deliveries[1].instance_name).toBe("chip_ban");
  });

  it("POST /api/prospeccao-sites/opt-out aplica opt_out em múltiplos lead_ids via .in()", async () => {
    dbState.leads_extraidos.push(
      { id: 10, client_id: CLIENT_ID, remoteJid: "5511911112222@s.whatsapp.net", opt_out: false },
      { id: 20, client_id: CLIENT_ID, remoteJid: "5511933334444@s.whatsapp.net", opt_out: false },
      { id: 30, client_id: "other-tenant", remoteJid: "5511955556666@s.whatsapp.net", opt_out: false }
    );

    const req = new NextRequest("http://localhost/api/prospeccao-sites/opt-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_ids: [10, 20, 30] }),
    });
    const res = await optOutPost(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.updated).toBe(2);
    expect(dbState.leads_extraidos[0].opt_out).toBe(true);
    expect(dbState.leads_extraidos[1].opt_out).toBe(true);
    expect(dbState.leads_extraidos[2].opt_out).toBe(false);
  });

  it("POST /api/prospeccao-sites/preview-queue bloqueia chip de outro tenant", async () => {
    const req = new NextRequest("http://localhost/api/prospeccao-sites/preview-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_jid: "5511999990000@s.whatsapp.net",
        instance_name: "other_tenant_chip",
        preview_url: "https://preview.example.com/x",
        delivery_slot: "plus_3h",
      }),
    });
    const res = await previewQueuePost(req);
    expect(res.status).toBe(403);
  });
});
