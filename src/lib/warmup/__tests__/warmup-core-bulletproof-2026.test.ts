// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MMZAP_GOVERNOR_SETTINGS, type WarmupConfig } from "../warmup-types";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  clients: [] as Row[],
  channel_connections: [] as Row[],
  whatsapp_warmup_configs: [] as Row[],
  whatsapp_warmup_conversations: [] as Row[],
  whatsapp_warmup_logs: [] as Row[],
  whatsapp_warmup_groups: [] as Row[],
  whatsapp_warmup_group_members: [] as Row[],
  whatsapp_phone_passports: [] as Row[],
  warmup_external_quarantine: [] as Row[],
  campaigns: [] as Row[],
  followup_campaigns: [] as Row[],
  followup_targets: [] as Row[],
  leads_extraidos: [] as Row[],
  contacts: [] as Row[],
  campaign_targets: [] as Row[],
  proxy_pool: [] as Row[],
  app_settings: [] as Row[],
  webhook_logs: [] as Row[],
  agent_settings: [] as Row[],
  forceTableErrors: {} as Record<string, { code: string; message: string } | null>,
}));

const proxyPoolMocks = vi.hoisted(() => ({
  hasPool: true,
  ensureProxyForInstance: vi.fn(async ({ instanceName }: { instanceName: string }) => ({
    ok: true,
    mode: "pool_assigned" as const,
    host: `198.51.100.${instanceName.length + 1}`,
    usedVpsFallback: false,
  })),
  blacklistInstanceProxy: vi.fn(async () => null),
  recordInstanceProxyStrike: vi.fn(async () => null),
  fallbackInstanceToVps: vi.fn(async () => {}),
}));

const evolutionMocks = vi.hoisted(() => ({
  fetchInstances: vi.fn(async () => ({ instances: [] as Row[] })),
  findWebhook: vi.fn(async () => ({
    enabled: true,
    url: "https://painel.teste.com/api/webhooks/whatsapp",
    events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"],
  })),
  setWebhook: vi.fn(async () => ({ ok: true })),
  findProxy: vi.fn(async () => ({ enabled: false, host: null as string | null, port: null as string | null })),
  fetchProfilePicture: vi.fn(async () => "https://pps.whatsapp.net/ok.jpg" as string | null),
  restartInstance: vi.fn(async () => ({ ok: true })),
  getStatus: vi.fn(async () => ({ state: "open", data: {} })),
  sendTextMessage: vi.fn(async () => ({ key: { id: "msg-1" } })),
  sendStatus: vi.fn(async () => ({ key: { id: "st-1" } })),
  leaveGroup: vi.fn(async () => true),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: evolutionMocks,
}));

vi.mock("@/lib/proxy-pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/proxy-pool")>();
  return {
    ...actual,
    getProxyPoolOverviewCache: vi.fn(async () => ({
      hasPool: proxyPoolMocks.hasPool,
      brHosts: new Set<string>(["185.72.242.10"]),
    })),
    ensureProxyForInstance: proxyPoolMocks.ensureProxyForInstance,
    blacklistInstanceProxy: proxyPoolMocks.blacklistInstanceProxy,
    recordInstanceProxyStrike: proxyPoolMocks.recordInstanceProxyStrike,
    fallbackInstanceToVps: proxyPoolMocks.fallbackInstanceToVps,
  };
});

vi.mock("@/lib/saas-limits", () => ({
  isClientActiveCached: vi.fn(async () => true),
  checkTenantAiQuota: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/warmup/warmup-pending-actions", () => ({
  enqueuePendingWarmupAction: vi.fn(async () => ({ id: "pa-1" })),
  claimAndRunPendingWarmupAction: vi.fn(async () => true),
  drainDuePendingWarmupActions: vi.fn(async () => 0),
  shouldCheckPendingWarmupActions: vi.fn(() => false),
}));

vi.mock("@/lib/supabase_admin", () => {
  function makeBuilder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let onConflictCols: string[] = [];
    let limitNum: number | null = null;

    const execute = async () => {
      const forcedErr = state.forceTableErrors[table];
      if (forcedErr) {
        return { data: null, error: forcedErr };
      }
      const list = ((state as unknown as Record<string, Row[]>)[table] ||= []);
      if (op === "insert" && payload) {
        const items = (Array.isArray(payload) ? payload : [payload]).map((it, idx) => ({
          id: (it.id as string) || `${table}-${list.length + idx + 1}`,
          ...it,
        }));
        list.push(...items);
        return { data: items, error: null };
      }
      if (op === "upsert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const it of items) {
          const idx = list.findIndex(
            (r) => onConflictCols.length > 0 && onConflictCols.every((c) => r[c] === it[c])
          );
          if (idx >= 0) {
            list[idx] = { ...list[idx], ...it };
          } else {
            list.push({
              id: (it.id as string) || `${table}-${list.length + 1}`,
              ...it,
            });
          }
        }
        return { data: items, error: null };
      }
      if (op === "update" && payload && !Array.isArray(payload)) {
        const matches = list.filter((r) => filters.every((f) => f(r)));
        for (const row of matches) Object.assign(row, payload);
        return { data: matches, error: null };
      }
      if (op === "delete") {
        const kept = list.filter((r) => !filters.every((f) => f(r)));
        const removed = list.filter((r) => filters.every((f) => f(r)));
        (state as unknown as Record<string, Row[]>)[table] = kept;
        return { data: removed, error: null };
      }
      let rows = list.filter((r) => filters.every((f) => f(r)));
      if (limitNum !== null) rows = rows.slice(0, limitNum);
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (data: Row | Row[]) => {
        op = "insert";
        payload = data;
        return builder;
      },
      upsert: (data: Row | Row[], opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = data;
        onConflictCols = String(opts?.onConflict || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return builder;
      },
      update: (data: Row) => {
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
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      lte: (col: string, val: string) => {
        filters.push((r) => String(r[col] ?? "") <= String(val));
        return builder;
      },
      lt: (col: string, val: string) => {
        filters.push((r) => Boolean(r[col]) && String(r[col]) < String(val));
        return builder;
      },
      gte: (col: string, val: string) => {
        filters.push((r) => String(r[col] ?? "") >= String(val));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitNum = n;
        return builder;
      },
      maybeSingle: async () => {
        const res = await execute();
        return { data: Array.isArray(res.data) ? res.data[0] ?? null : res.data, error: res.error };
      },
      single: async () => {
        const res = await execute();
        return { data: Array.isArray(res.data) ? res.data[0] ?? null : res.data, error: res.error };
      },
      then: (res: (v: unknown) => void, rej?: (e: unknown) => void) => execute().then(res, rej),
    };
    return builder;
  }

  const client = { from: (table: string) => makeBuilder(table) };
  return { supabaseAdmin: client, supabase: client };
});

import {
  computeChipReadinessSummary,
  evaluateDailyAutoProgress,
  evaluateExternalShieldGraduation,
  getMaxStageForDaysActive,
  handleWebhookConnectionClosed,
  isSevereDisconnectReason,
  resetDisconnectAlertCooldownForTests,
} from "../warmup-engine";
import {
  checkExternalWarmupInbound,
  evaluateMmzapShiftGovernor,
  invalidateExternalShieldCache,
  MMZAP_UNANSWERED_GRACE_MS,
} from "../warmup-external-shield";
import {
  MMZAP_ERROR_AUTO_RECOVERY_MS,
  tickMmzapBrowserOrchestrator,
} from "../mmzap-browser-orchestrator";
import {
  enablePairAutopilot,
  enableSwarmAutopilot,
  filterChipsWithoutActiveCampaign,
  resetWarmupWorkerRuntimeState,
  tickWarmupWorker,
} from "../warmup-worker";
import {
  analyzeChipClusterHealth,
  auditChipDay0Hygiene,
  resetProxyIntelCacheForTests,
} from "../warmup-groups";
import {
  resetSelfHealingForTests,
  runWarmupSelfHealingForTenant,
} from "../warmup-self-healing";
import {
  findPhoneMemory,
  markPhoneDisconnected,
  resetPhoneMemoryRuntimeForTests,
  savePhoneMemoryFromConfig,
} from "../warmup-phone-memory";
import { createDynamicWarmupImage } from "../warmup-media";
import { uniquifyOggOpusBuffer, verifyOggPageCrc } from "../warmup-audio";
import { STATUS_MAP } from "@/app/api/webhooks/whatsapp/route";

const ADMIN_ID = "00000000-0000-0000-0000-00000000a001";
const NOON_BRT_MS = new Date("2026-11-26T17:00:00.000Z").getTime(); // 14:00 BRT

function makeChip(overrides: Partial<WarmupConfig> = {}): WarmupConfig {
  return {
    id: `cfg-${overrides.instance_name || "chip-1"}`,
    client_id: ADMIN_ID,
    instance_name: "chip-1",
    phone_number: "5511999990001",
    enabled: true,
    stage: 2,
    stage_auto_progress: true,
    days_active: 5,
    consecutive_successful_days: 3,
    health_score: 95,
    is_quarantined: false,
    purpose: "inbound",
    daily_target: 25,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 120,
    max_interval_seconds: 240,
    min_typing_seconds: 3,
    max_typing_seconds: 7,
    allowed_start_hour: 0,
    allowed_end_hour: 24,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: false,
    enable_blue_ticks: true,
    enable_reactions: false,
    enable_audio: false,
    enable_vcard: false,
    enable_status_posts: false,
    continuous_warmup: true,
    profile_hydrated: true,
    career_mode: "maturing",
    external_warmup_mode: "receive_only",
    mmzap_browser_enabled: true,
    mmzap_browser_status: "idle",
    mmzap_shifts_today: 0,
    mmzap_minutes_today: 0,
    external_mmzap_sent_today: 0,
    external_warmup_inbound_today: 0,
    last_activity_at: new Date(NOON_BRT_MS).toISOString(),
    created_at: new Date(NOON_BRT_MS - 5 * 86_400_000).toISOString(),
    ...overrides,
  };
}

describe("Warmup Core Bulletproof 2026 — Deliverables 1-7 + Audit Fixes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const [k, v] of Object.entries(state)) {
      if (Array.isArray(v)) v.length = 0;
      else if (k === "forceTableErrors") state.forceTableErrors = {};
    }
    state.clients.push({ id: ADMIN_ID, is_admin: true, is_active: true });
    vi.clearAllMocks();
    proxyPoolMocks.hasPool = true;
    resetDisconnectAlertCooldownForTests();
    resetWarmupWorkerRuntimeState();
    resetProxyIntelCacheForTests();
    resetSelfHealingForTests();
    resetPhoneMemoryRuntimeForTests();
    invalidateExternalShieldCache();
    delete process.env.MMZAP_WORKER_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("D1: 428/408/515 não são ban; flapping >= 5 em 30 min rotaciona proxy sem quarentena, sem rehab e sem blacklist 'banned'", async () => {
    expect(isSevereDisconnectReason(428)).toBe(false);
    expect(isSevereDisconnectReason("428")).toBe(false);
    expect(isSevereDisconnectReason(408)).toBe(false);
    expect(isSevereDisconnectReason(515)).toBe(false);
    expect(isSevereDisconnectReason("connectionClosed 428")).toBe(false);

    expect(isSevereDisconnectReason(401)).toBe(true);
    expect(isSevereDisconnectReason(403)).toBe(true);
    expect(isSevereDisconnectReason(405)).toBe(true);
    expect(isSevereDisconnectReason("logged_out")).toBe(true);
    expect(isSevereDisconnectReason("banned")).toBe(true);
    expect(isSevereDisconnectReason("refused")).toBe(true);

    state.whatsapp_warmup_configs.push(
      makeChip({ instance_name: "00000_DD_11", health_score: 100, is_quarantined: false }) as unknown as Row
    );
    state.campaigns.push({ client_id: ADMIN_ID, instance_name: "00000_DD_11", status: "running" });

    // 4 quedas transitórias 428 dentro de 30 min -> apenas flap leve, sem rotação, sem penalidade
    for (let i = 0; i < 4; i++) {
      const res = await handleWebhookConnectionClosed({
        clientId: ADMIN_ID,
        instanceName: "00000_DD_11",
        statusReason: 428,
        nowMs: NOON_BRT_MS + i * 60_000,
      });
      expect(res.severe).toBe(false);
      expect(res.transientFlapCount).toBe(i + 1);
      expect(res.proxyRotated).toBe(false);
    }
    expect(proxyPoolMocks.ensureProxyForInstance).not.toHaveBeenCalled();
    expect(state.whatsapp_warmup_configs[0].is_quarantined).toBe(false);
    expect(state.whatsapp_warmup_configs[0].career_mode).toBe("maturing");
    expect(state.campaigns[0].status).toBe("running");

    // 5ª queda em < 30 min -> dispara checagem/rotação de proxy (reason: "rotation") + aviso leve, ZERO rehab/blacklist banned
    const fifth = await handleWebhookConnectionClosed({
      clientId: ADMIN_ID,
      instanceName: "00000_DD_11",
      statusReason: 428,
      nowMs: NOON_BRT_MS + 5 * 60_000,
    });
    expect(fifth.severe).toBe(false);
    expect(fifth.proxyRotated).toBe(true);
    expect(proxyPoolMocks.ensureProxyForInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: "00000_DD_11", reason: "rotation" })
    );
    expect(proxyPoolMocks.blacklistInstanceProxy).not.toHaveBeenCalled();
    expect(state.whatsapp_warmup_configs[0].is_quarantined).toBe(false);
    expect(state.whatsapp_warmup_configs[0].career_mode).toBe("maturing");
    expect(
      state.whatsapp_warmup_logs.some((l) => l.receiver_instance === "socket_flapping")
    ).toBe(true);
  });

  it("D2: grace period de 15 min no unanswered_brake + janela >= allowed_end_hour + auto-recuperação 3h e detecção sessionLoggedOut/qr_pending", async () => {
    const settings = { ...DEFAULT_MMZAP_GOVERNOR_SETTINGS, allowed_start_hour: 8, allowed_end_hour: 20 };

    // 10 min após início do turno -> grace period de 15 min impede freio precoce
    const duringGrace = evaluateMmzapShiftGovernor({
      stage: 2,
      mmzapSentToday: 4,
      mmzapInboundToday: 0,
      internalSentToday: 0,
      dailyTarget: 25,
      mmzapShiftStartedAt: new Date(NOON_BRT_MS - 10 * 60_000).toISOString(),
      governorSettings: settings,
      nowMs: NOON_BRT_MS,
    });
    expect(duringGrace.shouldStop).toBe(false);

    // 16 min após início do turno -> grace period expirou, unanswered_brake dispara
    const afterGrace = evaluateMmzapShiftGovernor({
      stage: 2,
      mmzapSentToday: 4,
      mmzapInboundToday: 0,
      internalSentToday: 0,
      dailyTarget: 25,
      mmzapShiftStartedAt: new Date(NOON_BRT_MS - (MMZAP_UNANSWERED_GRACE_MS + 60_000)).toISOString(),
      governorSettings: settings,
      nowMs: NOON_BRT_MS,
    });
    expect(afterGrace.shouldStop).toBe(true);
    expect(afterGrace.reason).toBe("unanswered_brake");

    // Exatamente às 20:00 BRT com allowed_end_hour = 20 -> fora da janela (não roda 1h extra!)
    const at20BrtMs = new Date("2026-11-26T23:00:00.000Z").getTime();
    const atEnd = evaluateMmzapShiftGovernor({
      stage: 1,
      mmzapSentToday: 0,
      mmzapInboundToday: 0,
      internalSentToday: 0,
      dailyTarget: 10,
      governorSettings: settings,
      nowMs: at20BrtMs,
    });
    expect(atEnd.shouldStop).toBe(true);
    expect(atEnd.reason).toBe("outside_window");

    // Orquestrador: recupera erro transitório após 3h, preserva qr_required, e trata sessionLoggedOut/qr_pending em turno ativo
    process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";
    const chipTransientErr = makeChip({
      instance_name: "chip-err-3h",
      mmzap_browser_status: "error",
      mmzap_last_error: "worker_timeout_503",
      updated_at: new Date(NOON_BRT_MS - MMZAP_ERROR_AUTO_RECOVERY_MS - 60_000).toISOString(),
    });
    const chipQrErr = makeChip({
      instance_name: "chip-err-qr",
      mmzap_browser_status: "error",
      mmzap_last_error: "qr_required",
      updated_at: new Date(NOON_BRT_MS - MMZAP_ERROR_AUTO_RECOVERY_MS - 60_000).toISOString(),
    });
    const chipLoggedOut = makeChip({
      instance_name: "chip-logged-out",
      mmzap_browser_status: "running",
      mmzap_shift_started_at: new Date(NOON_BRT_MS - 12 * 60_000).toISOString(),
    });
    state.whatsapp_warmup_configs.push(
      chipTransientErr as unknown as Row,
      chipQrErr as unknown as Row,
      chipLoggedOut as unknown as Row
    );

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) {
        return new Response(
          JSON.stringify({
            ok: true,
            activeSessions: 1,
            maxConcurrent: 2,
            sessions: [
              {
                instanceName: "chip-logged-out",
                status: "qr_pending",
                sessionLoggedOut: true,
                lastError: "qr_required",
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/stop")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.includes("/start")) {
        return new Response(JSON.stringify({ instanceName: "chip-err-3h", status: "running" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const orchRes = await tickMmzapBrowserOrchestrator({
      clientId: ADMIN_ID,
      configs: [chipTransientErr, chipQrErr, chipLoggedOut],
      connectedInstanceNames: new Set(["chip-err-3h", "chip-err-qr", "chip-logged-out"]),
      nowMs: NOON_BRT_MS,
    });

    // chip-err-3h recuperou de "error" -> "idle" e já pôde iniciar novo turno!
    expect(orchRes.started).toContain("chip-err-3h");
    // chip-err-qr NÃO recuperou automaticamente
    expect(chipQrErr.mmzap_browser_status).toBe("error");
    // chip-logged-out parou e virou "unpaired" com "qr_required" + alerta ADM
    expect(orchRes.stopped).toContain("chip-logged-out");
    expect(chipLoggedOut.mmzap_browser_status).toBe("unpaired");
    expect(chipLoggedOut.mmzap_last_error).toBe("qr_required");
    expect(
      state.whatsapp_warmup_logs.some(
        (l) => l.sender_instance === "chip-logged-out" && String(l.message_text).includes("ALERTA ADM")
      )
    ).toBe(true);
    // Running shift proxy check é somente leitura (ensureProxyForInstance só é chamado ao INICIAR novo turno!)
    expect(proxyPoolMocks.ensureProxyForInstance).toHaveBeenCalledTimes(1);
    expect(proxyPoolMocks.ensureProxyForInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: "chip-err-3h" })
    );
  });

  it("D2+D3+Audit#1: reset diário libera paused_safety/error, e campanha/follow-up (incl. __auto_pool__) derruba MMZap antes do orchestrator", async () => {
    // filterChipsWithoutActiveCampaign com __auto_pool__: exclui Stage 2+ Dia 7+, preserva Berçário Dia 2 e Rehab
    const nursery = makeChip({ instance_name: "chip-bercario", stage: 1, days_active: 2 });
    const rehab = makeChip({ instance_name: "chip-rehab", stage: 3, days_active: 14, career_mode: "rehab" });
    const veteran = makeChip({ instance_name: "chip-vet", stage: 4, days_active: 22 });
    const poolSplit = filterChipsWithoutActiveCampaign([nursery, rehab, veteran], ["__auto_pool__"]);
    expect(poolSplit.eligible.map((c) => c.instance_name)).toEqual(["chip-bercario", "chip-rehab"]);
    expect(poolSplit.skipped.map((c) => c.instance_name)).toEqual(["chip-vet"]);

    // Cenário completo no tickWarmupWorker:
    // - chip-paused está em "paused_safety" no dia anterior -> reset diário volta para "idle"
    // - chip-camp está com MMZap "running" E tem follow-up campaign rodando -> MMZap encerrado ANTES do orchestrator!
    process.env.MMZAP_WORKER_URL = "http://worker.internal:3099";
    const yesterdayIso = new Date(Date.now() - 28 * 3600_000).toISOString();

    state.channel_connections.push(
      { client_id: ADMIN_ID, instance_name: "chip-paused", status: "open", provider_config: { owner_phone: "5511999990001" } },
      { client_id: ADMIN_ID, instance_name: "chip-camp", status: "open", provider_config: { owner_phone: "5511999990002" } }
    );
    state.whatsapp_warmup_configs.push(
      makeChip({
        instance_name: "chip-paused",
        mmzap_browser_status: "paused_safety",
        mmzap_last_error: "unanswered_brake",
        external_warmup_inbound_today: 5,
        last_activity_at: yesterdayIso,
      }) as unknown as Row,
      makeChip({
        instance_name: "chip-camp",
        mmzap_browser_status: "running",
        mmzap_shift_started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        last_activity_at: new Date().toISOString(),
      }) as unknown as Row
    );
    state.followup_campaigns.push({
      id: "fu-1",
      client_id: ADMIN_ID,
      instance_name: "chip-camp",
      status: "running",
    });

    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      fetchedUrls.push(u);
      if (u.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, activeSessions: 0, maxConcurrent: 2, sessions: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, status: "idle" }), { status: 200 });
    }) as unknown as typeof fetch;

    await tickWarmupWorker();

    // chip-paused teve reset diário saindo de paused_safety -> idle (ou iniciado se dentro janela)
    const pausedRow = state.whatsapp_warmup_configs.find((r) => r.instance_name === "chip-paused")!;
    expect(pausedRow.mmzap_browser_status).not.toBe("paused_safety");

    // chip-camp teve MMZap derrubado com stop ANTES de qualquer tentativa de start
    const stopIdx = fetchedUrls.findIndex((u) => u.includes("/sessions/chip-camp/stop"));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(fetchedUrls.some((u) => u.includes("/sessions/chip-camp/start"))).toBe(false);
    const campRow = state.whatsapp_warmup_configs.find((r) => r.instance_name === "chip-camp")!;
    expect(campRow.mmzap_browser_status).toBe("idle");
  });

  it("D4: graduação automática do Escudo Externo (receive_only -> hybrid_quarantine -> off em Fase 4 após 48h)", () => {
    // 1. Graduou para inbound/outbound -> receive_only vira hybrid_quarantine
    const onPurpose = evaluateExternalShieldGraduation({
      currentMode: "receive_only",
      stage: 2,
      purpose: "inbound",
      purposeGraduated: true,
      nowMs: NOON_BRT_MS,
    });
    expect(onPurpose).toEqual({
      shouldTransition: true,
      nextMode: "hybrid_quarantine",
      reason: "purpose_graduated",
    });

    // 2. MMZap auto-desativou por fase -> receive_only vira hybrid_quarantine
    const onAutoDisable = evaluateExternalShieldGraduation({
      currentMode: "receive_only",
      stage: 4,
      mmzapAutoDisabled: true,
      mmzapBrowserEnabled: false,
      nowMs: NOON_BRT_MS,
    });
    expect(onAutoDisable).toEqual({
      shouldTransition: true,
      nextMode: "hybrid_quarantine",
      reason: "mmzap_auto_disabled",
    });

    // 3. Fase 4 + MMZap desligado + < 48h desde último inbound externo -> mantém hybrid_quarantine
    const stillRecent = evaluateExternalShieldGraduation({
      currentMode: "hybrid_quarantine",
      stage: 4,
      mmzapBrowserEnabled: false,
      externalWarmupLastAt: new Date(NOON_BRT_MS - 24 * 3600_000).toISOString(),
      nowMs: NOON_BRT_MS,
    });
    expect(stillRecent.shouldTransition).toBe(false);

    // 4. Fase 4 + MMZap desligado + >= 48h sem tráfego externo -> desliga ("off")
    const quiet48h = evaluateExternalShieldGraduation({
      currentMode: "hybrid_quarantine",
      stage: 4,
      mmzapBrowserEnabled: false,
      externalWarmupLastAt: new Date(NOON_BRT_MS - 50 * 3600_000).toISOString(),
      nowMs: NOON_BRT_MS,
    });
    expect(quiet48h).toEqual({
      shouldTransition: true,
      nextMode: "off",
      reason: "stage4_quiet_48h",
    });
  });

  it("D5: chip solo/MMZap-only progride dias e fases normalmente + thresholds Nov 2026 (Stage 4 no Dia 15)", () => {
    expect(getMaxStageForDaysActive(3)).toBe(1);
    expect(getMaxStageForDaysActive(4)).toBe(2);
    expect(getMaxStageForDaysActive(7)).toBe(2);
    expect(getMaxStageForDaysActive(8)).toBe(3);
    expect(getMaxStageForDaysActive(14)).toBe(3);
    expect(getMaxStageForDaysActive(15)).toBe(4);

    // Solo chip aquecendo só com MMZap inbound >= 3 (sent_today = 0)
    const mmzapOnly = makeChip({
      stage: 1,
      days_active: 3,
      consecutive_successful_days: 2,
      sent_today: 0,
      received_today: 3,
      external_mmzap_sent_today: 0,
      external_warmup_inbound_today: 3,
      error_count_today: 0,
      created_at: "2026-11-23T12:00:00Z",
      last_activity_at: "2026-11-25T15:00:00Z",
    });
    const resMmzap = evaluateDailyAutoProgress(mmzapOnly, "2026-11-26T15:00:00Z", "2026-11-25");
    expect(resMmzap.newDaysActive).toBe(4);
    expect(resMmzap.newConsecutiveDays).toBe(3);
    expect(resMmzap.stagePromoted).toBe(true);
    expect(resMmzap.newStage).toBe(2);

    // Solo chip aquecendo só via grupos (received_today >= 5, sent_today = 0)
    const groupsOnly = makeChip({
      stage: 2,
      days_active: 7,
      consecutive_successful_days: 5,
      sent_today: 0,
      received_today: 6,
      external_mmzap_sent_today: 0,
      external_warmup_inbound_today: 0,
      error_count_today: 0,
      created_at: "2026-11-19T12:00:00Z",
      last_activity_at: "2026-11-25T15:00:00Z",
    });
    const resGroups = evaluateDailyAutoProgress(groupsOnly, "2026-11-26T15:00:00Z", "2026-11-25");
    expect(resGroups.newDaysActive).toBe(8);
    expect(resGroups.newConsecutiveDays).toBe(6);
    expect(resGroups.stagePromoted).toBe(true);
    expect(resGroups.newStage).toBe(3);
  });

  it("D6+Audit#4: higiene Geo/ASN honesta sem pular brHosts + auto-cura com colisão por host, secret preservado e 2 falhas consecutivas", async () => {
    // 1. Mesmo estando no managedBrPoolHosts, datacenter/foreign é sinalizado honestamente!
    const cluster = analyzeChipClusterHealth({
      clientId: ADMIN_ID,
      instanceName: "chip-dc",
      config: makeChip({ instance_name: "chip-dc" }),
      proxyByInstance: new Map([["chip-dc", { enabled: true, host: "185.72.242.10" }]]),
      proxyIntelByHost: new Map([
        [
          "185.72.242.10",
          { countryCode: "BR", country: "Brazil", hosting: true, isp: "HostRoyale", checkedAt: Date.now() },
        ],
      ]),
      managedBrPoolHosts: new Set(["185.72.242.10"]),
    });
    expect(cluster.proxyHosting).toBe(true);
    expect(cluster.warnings.some((w) => w.includes("Datacenter/ASN"))).toBe(true);

    // 2. auditChipDay0Hygiene também verifica ip-api mesmo para host que estava em brHosts
    state.whatsapp_warmup_configs.push(makeChip({ instance_name: "chip-dc", phone_number: "5511999990001" }) as unknown as Row);
    evolutionMocks.findProxy.mockResolvedValueOnce({ enabled: true, host: "185.72.242.10", port: "5847" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ status: "success", countryCode: "BR", country: "Brazil", hosting: true, isp: "HostRoyale" })
      )
    );
    const day0 = await auditChipDay0Hygiene(ADMIN_ID, "chip-dc", { forceInTests: true });
    expect(day0.ok).toBe(false);
    expect(day0.warnings.some((w) => w.includes("datacenter/ASN"))).toBe(true);

    // 3. Auto-cura: 1 falha transitória + 2ª ok NÃO rotaciona proxy; mesmo host em portas diferentes detecta colisão; webhook sem secret provisiona secret
    state.channel_connections.push(
      { client_id: ADMIN_ID, instance_name: "c1", status: "open", provider_config: { owner_phone: "5511999990011" } },
      { client_id: ADMIN_ID, instance_name: "c2", status: "open", provider_config: { owner_phone: "5511999990012" } }
    );
    evolutionMocks.fetchInstances.mockResolvedValueOnce({
      instances: [
        { instance: { instanceName: "c1", connectionStatus: "open" } },
        { instance: { instanceName: "c2", connectionStatus: "open" } },
      ],
    });
    // Webhook sem MESSAGES_UPDATE -> deve reconfigurar COM secret provisionado
    evolutionMocks.findWebhook.mockResolvedValue({
      enabled: true,
      url: "https://painel.teste.com/api/webhooks/whatsapp",
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
    });
    // Mesmo host em portas diferentes (6001 e 6002)
    evolutionMocks.findProxy.mockImplementation(async (inst?: string) => ({
      enabled: true,
      host: "45.38.101.99",
      port: inst === "c1" ? "6001" : "6002",
    }));

    const probeAttemptsByPort = new Map<number, number>();
    const flakyProbe = vi.fn(async (px: { port: number }, timeoutMs?: number) => {
      expect(timeoutMs).toBeGreaterThanOrEqual(5000);
      const count = (probeAttemptsByPort.get(px.port) || 0) + 1;
      probeAttemptsByPort.set(px.port, count);
      // 1ª tentativa falha, 2ª passa -> não deve rotacionar por hiccup único!
      if (count === 1) return { ok: false, error: "transient_timeout" };
      return { ok: true };
    });

    proxyPoolMocks.hasPool = false;
    const heal = await runWarmupSelfHealingForTenant(ADMIN_ID, {
      force: true,
      appBaseUrl: "https://painel.teste.com",
      proxyProbeFn: flakyProbe,
    });

    // Nenhuma queda de fallback por falha única
    expect(proxyPoolMocks.fallbackInstanceToVps).not.toHaveBeenCalled();
    // Colisão pelo HOST detectada apesar das portas 6001 vs 6002
    expect(heal.actions.some((a) => a.issue.includes("45.38.101.99"))).toBe(true);
    // Secret provisionado e enviado ao setWebhook (nunca null!)
    expect(evolutionMocks.setWebhook).toHaveBeenCalled();
    const lastSecretArg = (evolutionMocks.setWebhook.mock.calls[0] as unknown[])[2];
    expect(typeof lastSecretArg).toBe("string");
    expect(String(lastSecretArg).length).toBeGreaterThanOrEqual(32);
  });

  it("D7: mídia orgânica com dimensões variadas + Ogg Opus limpo + computeChipReadinessSummary Nov 2026", () => {
    const dims = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const img = createDynamicWarmupImage(`seed-${i}`);
      const buf = Buffer.from(img.base64, "base64");
      expect(Array.from(buf.subarray(0, 4))).toEqual([137, 80, 78, 71]);
      // Valida dimensões reais no chunk IHDR (bytes 16..23)
      const ihdrW = buf.readUInt32BE(16);
      const ihdrH = buf.readUInt32BE(20);
      expect(ihdrW).toBe(img.width);
      expect(ihdrH).toBe(img.height);
      expect(ihdrW).toBeGreaterThanOrEqual(240);
      dims.add(`${ihdrW}x${ihdrH}`);
      hashes.add(img.sha256);
    }
    expect(dims.size).toBeGreaterThan(2);
    expect(hashes.size).toBe(16);

    // Ogg Opus único com CRC-32 válido e sem marcador óbvio "warmup_uid="
    const sampleBuf = fs.readFileSync(path.join(process.cwd(), "public", "warmup_voice_sample.ogg"));
    const uniq = uniquifyOggOpusBuffer(sampleBuf, "20261126-a1");
    expect(verifyOggPageCrc(uniq, uniq.indexOf("OggS", 4))).toBe(true);
    expect(uniq.toString("latin1")).not.toContain("warmup_uid=");

    // Readiness summary Nov 2026
    const rNursery = computeChipReadinessSummary(makeChip({ stage: 1, days_active: 2, health_score: 100 }));
    expect(rNursery.tier).toBe("nursery");
    expect(rNursery.safeDailyColdCapacity).toBe(0);
    expect(rNursery.coldOutreachAllowed).toBe(false);

    const rStage2 = computeChipReadinessSummary(makeChip({ stage: 2, days_active: 7, health_score: 90 }));
    expect(rStage2.safeDailyColdCapacity).toBe(15);

    const rStage3 = computeChipReadinessSummary(makeChip({ stage: 3, days_active: 12, health_score: 90 }));
    expect(rStage3.safeDailyColdCapacity).toBe(30);

    const rStage4A = computeChipReadinessSummary(makeChip({ stage: 4, days_active: 17, health_score: 95 }));
    expect(rStage4A.tier).toBe("outbound_ready");
    expect(rStage4A.safeDailyColdCapacity).toBe(50);

    const rVet = computeChipReadinessSummary(makeChip({ stage: 4, days_active: 21, health_score: 95 }));
    expect(rVet.tier).toBe("veteran");
    expect(rVet.isVeteran).toBe(true);
    expect(rVet.safeDailyColdCapacity).toBe(80);
    expect(rVet.score).toBeGreaterThanOrEqual(95);

    // Saúde 40..74 reduz capacidade pela metade; quarentena/rehab zera
    const rModHealth = computeChipReadinessSummary(makeChip({ stage: 4, days_active: 18, health_score: 65 }));
    expect(rModHealth.safeDailyColdCapacity).toBe(25);

    const rQuarantined = computeChipReadinessSummary(makeChip({ stage: 4, days_active: 25, is_quarantined: true }));
    expect(rQuarantined.tier).toBe("blocked");
    expect(rQuarantined.safeDailyColdCapacity).toBe(0);
  });

  it("Audit #3, #5, #6 e #12: leads_extraidos/followup_targets liberados no shield, fallback app_settings em erro SQL, autopilot respeita days_active/quarentena, flapTimestamps preservado e STATUS_MAP numérico correto", async () => {
    // Audit #12: STATUS_MAP numérico Baileys
    expect(STATUS_MAP[0]).toBe("error");
    expect(STATUS_MAP[1]).toBe("sent");
    expect(STATUS_MAP[2]).toBe("sent");
    expect(STATUS_MAP[3]).toBe("delivered");
    expect(STATUS_MAP[4]).toBe("read");
    expect(STATUS_MAP[5]).toBe("played");

    // Audit #3A: leads_extraidos e followup_targets NUNCA são engolidos pelo receive_only
    state.whatsapp_warmup_configs.push(
      makeChip({ instance_name: "chip-shield", external_warmup_mode: "receive_only" }) as unknown as Row
    );
    state.leads_extraidos.push({
      id: "lead-maps-1",
      client_id: ADMIN_ID,
      remoteJid: "5511977771111@s.whatsapp.net",
      telefone: "5511977771111",
    });
    state.followup_targets.push({
      id: "fu-t-1",
      client_id: ADMIN_ID,
      remote_jid: "5511977772222@s.whatsapp.net",
    });

    const leadRes = await checkExternalWarmupInbound({
      clientId: ADMIN_ID,
      instanceName: "chip-shield",
      remoteJid: "5511977771111@s.whatsapp.net",
      messageText: "Oi",
    });
    expect(leadRes.blocked).toBe(false);

    const fuRes = await checkExternalWarmupInbound({
      clientId: ADMIN_ID,
      instanceName: "chip-shield",
      remoteJid: "5511977772222@s.whatsapp.net",
      messageText: "Bom dia",
    });
    expect(fuRes.blocked).toBe(false);

    // Audit #3C: erro SQL em warmup_external_quarantine aciona fallback em app_settings
    state.forceTableErrors.warmup_external_quarantine = { code: "42P01", message: "relation does not exist" };
    const unkRes = await checkExternalWarmupInbound({
      clientId: ADMIN_ID,
      instanceName: "chip-shield",
      remoteJid: "5521966669999@s.whatsapp.net",
      messageText: "Bom dia!",
    });
    expect(unkRes.blocked).toBe(true);
    const fallbackRow = state.app_settings.find((r) => r.key === `warmup_ext_quarantine_${ADMIN_ID}`);
    expect(fallbackRow).toBeDefined();
    expect(String(fallbackRow?.value || "")).toContain("5521966669999");
    state.forceTableErrors.warmup_external_quarantine = null;

    // Audit #5: enablePairAutopilot / enableSwarmAutopilot não saltam fase por created_at ocioso nem limpam quarentena ativa
    const futureQuarantine = new Date(Date.now() + 12 * 3600_000).toISOString();
    state.whatsapp_warmup_configs.push(
      makeChip({
        instance_name: "idle-quar",
        stage: 1,
        days_active: 2,
        created_at: new Date(Date.now() - 25 * 86_400_000).toISOString(),
        is_quarantined: true,
        quarantine_until: futureQuarantine,
        quarantine_reason: "Ban 401 recente",
      }) as unknown as Row,
      makeChip({
        instance_name: "idle-peer",
        stage: 1,
        days_active: 2,
        created_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      }) as unknown as Row
    );
    await enablePairAutopilot(ADMIN_ID, "idle-quar", "idle-peer");
    const rowQ = state.whatsapp_warmup_configs.find((r) => r.instance_name === "idle-quar")!;
    expect(rowQ.stage).toBe(1);
    expect(rowQ.is_quarantined).toBe(true);

    await enableSwarmAutopilot(ADMIN_ID, ["idle-quar", "idle-peer"]);
    const rowQ2 = state.whatsapp_warmup_configs.find((r) => r.instance_name === "idle-quar")!;
    expect(rowQ2.stage).toBe(1);
    expect(rowQ2.is_quarantined).toBe(true);

    // Audit #6: flapTimestamps preservado ao salvar passaporte em buildEntryFromConfig
    await savePhoneMemoryFromConfig(
      ADMIN_ID,
      makeChip({ instance_name: "chip-flap-mem", phone_number: "5511988885555" })
    );
    markPhoneDisconnected(ADMIN_ID, "chip-flap-mem", "428", NOON_BRT_MS);
    await new Promise((r) => setTimeout(r, 30));
    // Re-salva config (antes isso apagava flapTimestamps!)
    await savePhoneMemoryFromConfig(
      ADMIN_ID,
      makeChip({ instance_name: "chip-flap-mem", phone_number: "5511988885555", sent_today: 2 })
    );
    const mem = await findPhoneMemory(ADMIN_ID, "5511988885555");
    expect(Array.isArray(mem?.flapTimestamps)).toBe(true);
    expect(mem?.flapTimestamps?.length).toBeGreaterThanOrEqual(1);
  });
});
