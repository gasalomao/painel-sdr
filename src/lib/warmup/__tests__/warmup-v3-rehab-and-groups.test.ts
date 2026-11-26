import { beforeEach, describe, expect, it, vi } from "vitest";

const state: Record<string, Array<Record<string, unknown>>> = {
  whatsapp_warmup_configs: [],
  whatsapp_warmup_groups: [],
  whatsapp_warmup_group_members: [],
  whatsapp_warmup_logs: [],
  whatsapp_phone_passports: [],
  channel_connections: [],
  campaigns: [],
  app_settings: [],
  proxy_pool: [],
  webhook_logs: [],
};

const evolutionMock = vi.hoisted(() => ({
  markMessageAsRead: vi.fn(async () => true),
  sendReaction: vi.fn(async () => ({ key: { id: "REACT-1" } })),
  sendTextMessage: vi.fn(async () => ({ key: { id: "GRP-MSG-1" } })),
  createGroup: vi.fn(async () => ({
    success: true,
    groupJid: "120363999000111@g.us",
    subject: "Networking & Negócios Locais",
  })),
  getGroupInviteCode: vi.fn(async () => "INTERNALCODE99"),
  fetchAllGroups: vi.fn(async () => [
    { id: "120363111222333@g.us", subject: "Empreendedores SP", size: 42, restrict: false },
    { id: "120363444555666@g.us", subject: "Avisos Admin", size: 10, restrict: true },
  ]),
  leaveGroup: vi.fn(async () => true),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: evolutionMock,
}));

vi.mock("@/lib/proxy-pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/proxy-pool")>();
  return {
    ...actual,
    getProxyPoolOverviewCache: vi.fn(async () => ({ hasPool: true, brHosts: new Set<string>() })),
    recordInstanceProxyStrike: vi.fn(async () => null),
    blacklistInstanceProxy: vi.fn(async (inst: string, reason = "banned") => {
      for (const r of state.proxy_pool) {
        if (r.assigned_instance === inst && r.status === "assigned") {
          r.status = "blacklisted";
          r.blacklist_reason = reason;
          r.assigned_instance = null;
        }
      }
      return { host: "1.2.3.4" };
    }),
  };
});

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
        const items = (Array.isArray(payload) ? payload : [payload]).map((it) => ({
          id: (it.id as string) || `${table}-${state[table].length + 1}`,
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
        const kept = state[table].filter((r) => !filters.every((f) => f(r)));
        const removed = state[table].filter((r) => filters.every((f) => f(r)));
        state[table] = kept;
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
      not: (col: string, opStr: string, val: unknown) => {
        if (opStr === "is" && val === null) {
          filters.push((r) => r[col] !== null && r[col] !== undefined);
        }
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

  return {
    supabaseAdmin: {
      from: (table: string) => makeBuilder(table),
    },
  };
});

import {
  evaluateRehabGraduation,
  handleWebhookConnectionClosed,
  resetDisconnectAlertCooldownForTests,
} from "../warmup-engine";
import { resetPendingWarmupActionsForTests } from "../warmup-pending-actions";
import { selectAsymmetricWarmupPairs } from "../warmup-worker";
import { getEffectiveDailyTarget } from "../warmup-config-service";
import {
  cleanupDeadWarmupGroups,
  discoverExistingGroupsForChip,
  processIncomingGroupMessage,
  resetGroupReceiveBufferForTests,
  runInternalSwarmGroupCycle,
} from "../warmup-groups";
import { findPhoneMemory } from "../warmup-phone-memory";
import { getColdOutreachPolicyForStage } from "@/lib/campaign-worker";
import { runAssignedProxyHealthWatchdog } from "@/lib/proxy-pool";
import type { WarmupConfig } from "../warmup-types";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

function baseChip(overrides: Partial<WarmupConfig> = {}): WarmupConfig {
  return {
    client_id: CLIENT_ID,
    instance_name: "chip-1",
    phone_number: "5511999990001",
    enabled: true,
    stage: 3,
    stage_auto_progress: true,
    days_active: 10,
    consecutive_successful_days: 5,
    health_score: 95,
    is_quarantined: false,
    purpose: "outbound",
    daily_target: 50,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 90,
    max_interval_seconds: 180,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 8,
    allowed_end_hour: 21,
    ai_model: "auto:free",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
    ...overrides,
  };
}

describe("Aquecedor Blindado 3.0 — Reabilitação Pós-Ban, Grupos v2 & Proxy Watchdog", () => {
  beforeEach(() => {
    for (const k of Object.keys(state)) state[k] = [];
    vi.clearAllMocks();
    resetDisconnectAlertCooldownForTests();
    resetGroupReceiveBufferForTests();
    resetPendingWarmupActionsForTests();
  });

  it("ativa reabilitação pós-ban 401/403 preservando days_active/stage, trava disparo frio 96h e gera blacklist do proxy", async () => {
    const nowMs = Date.now();
    state.whatsapp_warmup_configs.push(
      baseChip({ instance_name: "sarah_ban_01", phone_number: "5511988881111", stage: 3, days_active: 14 })
    );
    state.proxy_pool.push({
      id: "proxy-1",
      host: "198.51.100.10",
      port: 8000,
      protocol: "http",
      status: "assigned",
      assigned_instance: "sarah_ban_01",
      assigned_client_id: CLIENT_ID,
    });

    const closeRes = await handleWebhookConnectionClosed({
      clientId: CLIENT_ID,
      instanceName: "sarah_ban_01",
      statusReason: 403,
      nowMs,
    });

    expect(closeRes.severe).toBe(true);
    expect(state.proxy_pool[0].status).toBe("blacklisted");
    expect(state.proxy_pool[0].blacklist_reason).toBe("banned");

    const updatedCfg = state.whatsapp_warmup_configs[0] as unknown as WarmupConfig;
    expect(updatedCfg.career_mode).toBe("rehab");
    expect(updatedCfg.stage).toBe(3);
    expect(updatedCfg.days_active).toBe(14);
    expect(getEffectiveDailyTarget(updatedCfg)).toBe(20); // 40% de 50

    const memory = await findPhoneMemory(CLIENT_ID, "5511988881111");
    expect(memory?.banCount).toBe(1);
    expect(memory?.careerMode).toBe("rehab");
    expect(memory?.daysActive).toBe(14);

    // Campanha fria deve bloquear durante rehab/trava 96h e exigir 4 dias no estágio 2
    const blockedRehab = getColdOutreachPolicyForStage(3, 85, {
      careerMode: "rehab",
      coldOutreachLockedUntil: updatedCfg.cold_outreach_locked_until,
      nowMs,
    });
    expect(blockedRehab.allowed).toBe(false);
    expect(blockedRehab.reason).toBe("post_ban_rehab");

    const blockedDays = getColdOutreachPolicyForStage(2, 95, { daysActive: 2 });
    expect(blockedDays.allowed).toBe(false);
    expect(blockedDays.reason).toBe("insufficient_active_days");

    // Pareamento assimétrico empurra o chip em rehab para RECEBER do veterano
    const veteran = baseChip({ instance_name: "veterano_01", stage: 4, days_active: 30, career_mode: "maturing" });
    const rehabChip = baseChip({ instance_name: "sarah_ban_01", stage: 3, days_active: 14, career_mode: "rehab" });
    const pairs = selectAsymmetricWarmupPairs([rehabChip, veteran], new Set(), 1, nowMs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].initiator.instance_name).toBe("veterano_01");
    expect(pairs[0].partner.instance_name).toBe("sarah_ban_01");

    // Graduação de rehab após 72h + saúde >= 75 + 3 dias limpos
    const stillLocked = evaluateRehabGraduation(
      { ...rehabChip, health_score: 80, consecutive_successful_days: 3, rehab_until: new Date(nowMs + 3600_000).toISOString() },
      new Date(nowMs).toISOString()
    );
    expect(stillLocked.graduated).toBe(false);

    const graduated = evaluateRehabGraduation(
      { ...rehabChip, health_score: 80, consecutive_successful_days: 3, rehab_until: new Date(nowMs - 1000).toISOString() },
      new Date(nowMs).toISOString()
    );
    expect(graduated.graduated).toBe(true);
    expect(graduated.nextCareerMode).toBe("maturing");
  });

  it("grupos v2: cooldown de leitura 120s, descobre grupos, cria grupo interno de colmeia e limpa grupos mortos", async () => {
    state.whatsapp_warmup_configs.push(
      baseChip({ instance_name: "chip_a", phone_number: "5511999990001", stage: 4, days_active: 20 }),
      baseChip({ instance_name: "chip_b", phone_number: "5511999990002", stage: 3, days_active: 10 }),
      baseChip({ instance_name: "chip_c", phone_number: "5511999990003", stage: 2, days_active: 5 })
    );

    // 1. Criação de grupo interno automático quando >= 3 chips
    const swarmRes = await runInternalSwarmGroupCycle(CLIENT_ID);
    expect(swarmRes.created).toBe(1);
    expect(swarmRes.posted).toBe(1);
    expect(evolutionMock.createGroup).toHaveBeenCalledTimes(1);
    expect(state.whatsapp_warmup_groups).toHaveLength(1);
    expect(state.whatsapp_warmup_groups[0].origin).toBe("internal_swarm");
    expect(state.whatsapp_warmup_group_members).toHaveLength(3);

    // 2. Descoberta automática de grupos existentes (ignora grupos restrict=true)
    const discRes = await discoverExistingGroupsForChip(CLIENT_ID, "chip_a");
    expect(discRes.discovered).toBe(1);
    expect(state.whatsapp_warmup_groups).toHaveLength(2);

    // 3. Cooldown de 120s nas leituras do mesmo grupo
    const targetJid = "120363111222333@g.us";
    await processIncomingGroupMessage({
      clientId: CLIENT_ID,
      instanceName: "chip_a",
      groupJid: targetJid,
      messageId: "GMSG-1",
      messageText: "Bom dia pessoal",
    });
    await processIncomingGroupMessage({
      clientId: CLIENT_ID,
      instanceName: "chip_a",
      groupJid: targetJid,
      messageId: "GMSG-2",
      messageText: "Tudo bem",
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(evolutionMock.markMessageAsRead).toHaveBeenCalledTimes(1);

    // 4. Auto-saída de grupo morto (> 120h sem atividade)
    state.whatsapp_warmup_groups[1].last_activity_at = new Date(Date.now() - 130 * 60 * 60 * 1000).toISOString();
    const cleanupRes = await cleanupDeadWarmupGroups(CLIENT_ID, Date.now(), 120);
    expect(cleanupRes.leftGroups).toBe(1);
    expect(state.whatsapp_warmup_groups[1].status).toBe("left");
    expect(evolutionMock.leaveGroup).toHaveBeenCalledTimes(1);
  });

  it("proxy watchdog testa proxies assigned e rotaciona automaticamente o proxy caído", async () => {
    state.proxy_pool.push({
      id: "px-dead",
      host: "198.51.100.55",
      port: 8000,
      protocol: "http",
      username: "u",
      password: "p",
      status: "assigned",
      assigned_instance: "chip_a",
      assigned_client_id: CLIENT_ID,
      last_checked_at: "2026-01-01T00:00:00.000Z",
    });

    const summary = await runAssignedProxyHealthWatchdog({
      maxChecks: 10,
      probeFn: vi.fn(async () => ({ ok: false, error: "ETIMEDOUT" })),
    });

    expect(summary.checked).toBe(1);
    expect(summary.fallbackVps).toBe(1);
    expect(state.proxy_pool[0].status).toBe("blacklisted");
  });
});
