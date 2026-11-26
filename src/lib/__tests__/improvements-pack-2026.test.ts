import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, any>;

const { dbState, mockChannelSendMessage, mockEvoUpdatePic, mockEvoSetProxy, mockEvoRemoveProxy } = vi.hoisted(() => ({
  dbState: {
    tables: {} as Record<string, Row[]>,
    rpcCalls: [] as Array<{ fn: string; args: any }>,
  },
  mockChannelSendMessage: vi.fn(async () => ({ ok: true, messageId: "msg-001" })),
  mockEvoUpdatePic: vi.fn(async () => true),
  mockEvoSetProxy: vi.fn(async () => ({ ok: true })),
  mockEvoRemoveProxy: vi.fn(async () => ({ ok: true })),
}));

vi.mock("playwright", () => ({
  chromium: {},
}));

function resetDb() {
  dbState.tables = {
    app_settings: [],
    whatsapp_warmup_configs: [],
    whatsapp_warmup_logs: [],
    whatsapp_phone_passports: [],
    channel_connections: [],
    proxy_pool: [],
    proxy_pool_batches: [],
    agent_settings: [],
    campaigns: [],
    campaign_targets: [],
    leads_extraidos: [],
    contacts: [],
  };
  dbState.rpcCalls = [];
}

function getTable(name: string): Row[] {
  if (!dbState.tables[name]) dbState.tables[name] = [];
  return dbState.tables[name];
}

function makeQuery(tableName: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let orderField: string | null = null;
  let orderAsc = true;
  let limitCount: number | null = null;
  let updatePayload: Row | null = null;
  let upsertPayload: { rows: Row[]; onConflict?: string } | null = null;
  let insertPayload: Row[] | null = null;
  let headOnly = false;
  let wantCount = false;

  const execSelect = () => {
    let rows = getTable(tableName).filter((r) => filters.every((f) => f(r)));
    if (orderField) {
      const f = orderField;
      rows = [...rows].sort((a, b) => {
        const av = String(a[f] ?? "");
        const bv = String(b[f] ?? "");
        return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    const total = rows.length;
    if (limitCount !== null) rows = rows.slice(0, limitCount);
    return { rows, total };
  };

  const applyMutation = () => {
    const tbl = getTable(tableName);
    if (updatePayload) {
      const matched = tbl.filter((r) => filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, updatePayload);
      return { data: matched, error: null, count: matched.length };
    }
    if (upsertPayload) {
      const conflictCol = upsertPayload.onConflict || "id";
      const out: Row[] = [];
      for (const item of upsertPayload.rows) {
        const idx = tbl.findIndex((r) => r[conflictCol] !== undefined && r[conflictCol] === item[conflictCol]);
        if (idx >= 0) {
          tbl[idx] = { ...tbl[idx], ...item };
          out.push(tbl[idx]);
        } else {
          const rec = { id: item.id || crypto.randomUUID(), ...item };
          tbl.push(rec);
          out.push(rec);
        }
      }
      return { data: out, error: null };
    }
    if (insertPayload) {
      const out: Row[] = [];
      for (const item of insertPayload) {
        const rec = { id: item.id || crypto.randomUUID(), ...item };
        tbl.push(rec);
        out.push(rec);
      }
      return { data: out, error: null };
    }
    const { rows, total } = execSelect();
    return {
      data: headOnly ? null : rows,
      error: null,
      count: wantCount ? total : null,
    };
  };

  const q: any = {
    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.count) wantCount = true;
      if (opts?.head) headOnly = true;
      return q;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return q;
    },
    neq(col: string, val: unknown) {
      filters.push((r) => r[col] !== val);
      return q;
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]));
      return q;
    },
    not(col: string, op: string, val: unknown) {
      if (op === "is" && val === null) filters.push((r) => r[col] !== null && r[col] !== undefined);
      return q;
    },
    gte(col: string, val: string) {
      filters.push((r) => String(r[col] ?? "") >= val);
      return q;
    },
    lt(col: string, val: string) {
      filters.push((r) => String(r[col] ?? "") < val);
      return q;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderField = col;
      orderAsc = opts?.ascending !== false;
      return q;
    },
    limit(n: number) {
      limitCount = n;
      return q;
    },
    range(from: number, to: number) {
      limitCount = Math.max(0, to - from + 1);
      return q;
    },
    update(patch: Row) {
      updatePayload = patch;
      return q;
    },
    upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
      upsertPayload = { rows: Array.isArray(rows) ? rows : [rows], onConflict: opts?.onConflict };
      return q;
    },
    insert(rows: Row | Row[]) {
      insertPayload = Array.isArray(rows) ? rows : [rows];
      return q;
    },
    delete() {
      const tbl = getTable(tableName);
      const keep = tbl.filter((r) => !filters.every((f) => f(r)));
      dbState.tables[tableName] = keep;
      return Promise.resolve({ data: [], error: null });
    },
    maybeSingle() {
      const res = applyMutation();
      return Promise.resolve({
        data: Array.isArray(res.data) ? (res.data[0] ?? null) : null,
        error: res.error,
      });
    },
    single() {
      const res = applyMutation();
      return Promise.resolve({
        data: Array.isArray(res.data) ? (res.data[0] ?? null) : null,
        error: res.error,
      });
    },
    then(onFulfilled: any, onRejected?: any) {
      return Promise.resolve(applyMutation()).then(onFulfilled, onRejected);
    },
  };
  return q;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => makeQuery(table),
    rpc: vi.fn(async (fn: string, args: any) => {
      dbState.rpcCalls.push({ fn, args });
      return { data: null, error: { code: "42883", message: "rpc not mocked" } };
    }),
  },
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => ({
    ok: true,
    clientId: "00000000-0000-0000-0000-00000000a001",
    isAdmin: true,
    impersonating: false,
  })),
  isInstanceOwnedByClient: vi.fn(async () => true),
}));

vi.mock("@/lib/warmup/warmup-admin-guard", () => ({
  requireWarmupAdminAccess: vi.fn(() => null),
  isTenantWarmupAdmin: vi.fn(async () => true),
  listAdminClientIds: vi.fn(async () => ["00000000-0000-0000-0000-00000000a001"]),
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    setProxy: (...args: any[]) => mockEvoSetProxy(...args),
    removeProxy: (...args: any[]) => mockEvoRemoveProxy(...args),
    setSettings: vi.fn(async () => true),
    updateProfileStatus: vi.fn(async () => true),
    updateProfilePicture: (...args: any[]) => mockEvoUpdatePic(...args),
    fetchProfilePicture: vi.fn(async () => null),
    sendStatus: vi.fn(async () => ({ ok: true })),
    findProxy: vi.fn(async () => ({ enabled: false })),
  },
}));

vi.mock("@/lib/providers/evolution-go", () => ({
  setEvolutionGoProxy: vi.fn(async () => ({ ok: true })),
  removeEvolutionGoProxy: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/channel", () => ({
  sendMessage: (...args: any[]) => mockChannelSendMessage(...args),
  sendMedia: vi.fn(async () => ({ ok: true })),
  checkWhatsAppNumbersDetailed: vi.fn(async () => ({})),
}));

import {
  clearPhonePostBanRehab,
  markPhonePostBanRehab,
  readPhoneMemoryMap,
} from "@/lib/warmup/warmup-phone-memory";
import { POST as mmzapBrowserPost } from "@/app/api/warmup/mmzap-browser/route";
import { getColdOutreachPolicyForStage } from "@/lib/campaign-worker";
import { computeChipReadinessSummary } from "@/lib/warmup/warmup-engine";
import { computeChipColdReadiness, type InstanceItem } from "@/components/warmup/types";
import {
  parseWeekendB2BGuardMode,
  serializeWeekendB2BGuardMode,
} from "@/lib/campaign-pool";
import {
  MENTOR_VIDEO_PRAISE_TEMPLATE,
  MENTOR_VIDEO_PRAISE_VARIANTS,
  POST_PREVIEW_FOLLOWUP_PRESET,
} from "@/lib/mentor-presets";
import {
  auditProxyPoolGeoAsn,
  ensureProxyForInstance,
  invalidateProxyPoolCache,
  isFalse428BlacklistRow,
  manageProxyBlacklist,
  saveProxyPoolSettings,
} from "@/lib/proxy-pool";
import {
  buildDailyWarmupOwnerReportText,
  maybeSendDailyWarmupOwnerSummary,
} from "@/lib/warmup/warmup-owner-report";
import { varyOggOpusDuration, verifyOggPageCrc } from "@/lib/warmup/warmup-audio";
import { hydrateChipProfile } from "@/lib/warmup/warmup-groups";
import { saveGlobalWarmupSettings } from "@/lib/warmup/warmup-config-service";
import {
  computeCampaignAbSummary,
  evaluateAbAutoPause,
  recordCampaignAbSend,
  saveCampaignAbConfig,
  selectCampaignAbVariant,
} from "@/lib/campaign-ab-testing";

const CLIENT_ID = "00000000-0000-0000-0000-00000000a001";

describe("Pacote de 8 melhorias (autonomia, anti-ban, proxies, A/B e áudio)", () => {
  beforeEach(() => {
    resetDb();
    invalidateProxyPoolCache();
    mockChannelSendMessage.mockClear();
    mockEvoUpdatePic.mockClear();
    mockEvoSetProxy.mockClear();
    mockEvoRemoveProxy.mockClear();
  });

  it("1. release_quarantine e clearPhonePostBanRehab limpam quarentena + reabilitação pós-falso-428 preservando histórico", async () => {
    const inst = "00000_DD_11";
    const phone = "5511961607625";
    dbState.tables.whatsapp_warmup_configs.push({
      id: "cfg-1",
      client_id: CLIENT_ID,
      instance_name: inst,
      phone_number: phone,
      stage: 3,
      days_active: 17,
      health_score: 35,
      is_quarantined: true,
      quarantine_reason: "false_428",
      quarantine_until: new Date(Date.now() + 86400_000).toISOString(),
      career_mode: "rehab",
      rehab_until: new Date(Date.now() + 72 * 3600_000).toISOString(),
      cold_outreach_locked_until: new Date(Date.now() + 96 * 3600_000).toISOString(),
      error_count_today: 4,
    });

    await markPhonePostBanRehab({
      clientId: CLIENT_ID,
      instanceName: inst,
      phone,
      reason: "old_428",
    });

    const req = new NextRequest("http://localhost/api/warmup/mmzap-browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release_quarantine", instance_name: inst }),
    });
    const res = await mmzapBrowserPost(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.rehab_cleared).toBe(true);

    const cfgAfter = dbState.tables.whatsapp_warmup_configs[0];
    expect(cfgAfter.is_quarantined).toBe(false);
    expect(cfgAfter.quarantine_reason).toBeNull();
    expect(cfgAfter.career_mode).toBe("maturing");
    expect(cfgAfter.rehab_until).toBeNull();
    expect(cfgAfter.cold_outreach_locked_until).toBeNull();
    expect(cfgAfter.health_score).toBe(65);

    const memMap = await readPhoneMemoryMap(CLIENT_ID);
    const passport = memMap["5511961607625"];
    expect(passport.careerMode).toBe("maturing");
    expect(passport.rehabUntil).toBeNull();
    expect(passport.coldOutreachLockedUntil).toBeNull();
    expect(passport.banCount).toBe(1);
    expect(passport.daysActive).toBe(17);

    await markPhonePostBanRehab({ clientId: CLIENT_ID, instanceName: inst, phone, reason: "test2" });
    const cleared = await clearPhonePostBanRehab({ clientId: CLIENT_ID, instanceName: inst, phone });
    expect(cleared?.careerMode).toBe("maturing");
    expect(cleared?.coldOutreachLockedUntil).toBeNull();
  });

  it("2. Paridade estrita Dia 1..25 × Fase 1..4 entre campaign-worker, warmup-engine e ChipAutopilot UI", () => {
    const cases: Array<{ stage: 1 | 2 | 3 | 4; days: number; health: number }> = [
      { stage: 1, days: 2, health: 100 },
      { stage: 2, days: 6, health: 95 },
      { stage: 2, days: 7, health: 95 },
      { stage: 3, days: 8, health: 95 },
      { stage: 3, days: 10, health: 95 },
      { stage: 3, days: 11, health: 95 },
      { stage: 4, days: 14, health: 95 },
      { stage: 4, days: 15, health: 95 },
      { stage: 4, days: 18, health: 65 },
      { stage: 4, days: 21, health: 90 },
      { stage: 4, days: 21, health: 85 },
      { stage: 4, days: 25, health: 35 },
    ];

    for (const c of cases) {
      const workerPol = getColdOutreachPolicyForStage(c.stage, c.health, { daysActive: c.days });
      const engineSum = computeChipReadinessSummary({
        stage: c.stage,
        days_active: c.days,
        health_score: c.health,
        is_quarantined: false,
      });
      const uiItem: InstanceItem = {
        instance_name: "chip-parity",
        connection_status: "open",
        phone_number: "5511999999999",
        orphan: false,
        config: {
          client_id: CLIENT_ID,
          instance_name: "chip-parity",
          phone_number: "5511999999999",
          enabled: true,
          stage: c.stage,
          stage_auto_progress: true,
          days_active: c.days,
          health_score: c.health,
          is_quarantined: false,
          quarantine_reason: null,
          daily_target: 30,
          sent_today: 0,
          received_today: 0,
          error_count_today: 0,
          last_activity_at: null,
          min_interval_seconds: 90,
          max_interval_seconds: 180,
          min_typing_seconds: 3,
          max_typing_seconds: 8,
          allowed_start_hour: 8,
          allowed_end_hour: 21,
          ai_model: "fallback",
          ai_theme: "dia_a_dia",
          enable_typing: true,
          enable_blue_ticks: true,
          enable_reactions: true,
          enable_audio: true,
          enable_vcard: true,
          enable_status_posts: true,
          continuous_warmup: true,
          custom_prompt: null,
        },
        day0_warnings: [],
        day0_status: "ok",
        network_warnings: [],
        flaps_24h: 0,
        soft_recovery: false,
        metrics: null,
        proxy: { enabled: true, host: "1.1.1.1", port: "80", protocol: "http" },
      };
      const uiReady = computeChipColdReadiness(uiItem);

      expect(workerPol.dailyColdCap).toBe(engineSum.safeDailyColdCapacity);
      expect(uiReady.safeDailyCold).toBe(engineSum.safeDailyColdCapacity);
    }

    expect(getColdOutreachPolicyForStage(3, 95, { daysActive: 9 }).dailyColdCap).toBe(15);
  });

  it("3. weekend_guard='sunday_only' serializa sem coerção + Presets Abridor Vídeo e Pós-Prévia Break-up", () => {
    expect(serializeWeekendB2BGuardMode("sunday_only")).toBe("sunday_only");
    expect(parseWeekendB2BGuardMode(serializeWeekendB2BGuardMode("sunday_only"))).toBe("sunday_only");
    expect(serializeWeekendB2BGuardMode("full")).toBe("true");
    expect(serializeWeekendB2BGuardMode(true)).toBe("true");
    expect(serializeWeekendB2BGuardMode(false)).toBe("false");

    expect(MENTOR_VIDEO_PRAISE_TEMPLATE).toContain("{{avaliacao}}");
    expect(MENTOR_VIDEO_PRAISE_TEMPLATE).toContain("WhatsApp ou Instagram");
    expect(MENTOR_VIDEO_PRAISE_VARIANTS.length).toBeGreaterThanOrEqual(3);

    expect(POST_PREVIEW_FOLLOWUP_PRESET.source_status).toBe("previa_enviada");
    expect(POST_PREVIEW_FOLLOWUP_PRESET.weekend_guard).toBe("sunday_only");
    expect(POST_PREVIEW_FOLLOWUP_PRESET.steps.map((s) => s.day_offset)).toEqual([1, 3, 6]);
    expect(POST_PREVIEW_FOLLOWUP_PRESET.steps[2].template.toLowerCase()).toContain("não te incomodar");
  });

  it("4. Pool de proxies: auditoria Geo/ASN, prioridade BR residencial, clear_false_428 e bloqueio anti-dominó", async () => {
    dbState.tables.proxy_pool.push(
      {
        id: "px-dc",
        host: "104.252.92.10",
        port: 6001,
        protocol: "http",
        username: "u1",
        password: "p1",
        provider_label: "webshare:unverified",
        country_code: "UNVERIFIED",
        status: "available",
        fail_count: 0,
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
      },
      {
        id: "px-res",
        host: "177.88.20.15",
        port: 6002,
        protocol: "http",
        username: "u2",
        password: "p2",
        provider_label: "webshare:unverified",
        country_code: "UNVERIFIED",
        status: "available",
        fail_count: 0,
        created_at: "2026-11-02T00:00:00Z",
        updated_at: "2026-11-02T00:00:00Z",
      },
      {
        id: "px-428",
        host: "104.252.92.22",
        port: 6022,
        protocol: "http",
        username: "u3",
        password: "p3",
        provider_label: "webshare:datacenter",
        country_code: "BR",
        status: "blacklisted",
        blacklist_reason: "banned",
        last_error: "connection_closed_428 precondition",
        fail_count: 1,
        created_at: "2026-11-03T00:00:00Z",
        updated_at: "2026-11-03T00:00:00Z",
      },
      {
        id: "px-real-ban",
        host: "104.252.92.99",
        port: 6099,
        protocol: "http",
        username: "u4",
        password: "p4",
        provider_label: "webshare:datacenter",
        country_code: "BR",
        status: "blacklisted",
        blacklist_reason: "banned",
        last_error: "401 logged out",
        fail_count: 1,
        created_at: "2026-11-04T00:00:00Z",
        updated_at: "2026-11-04T00:00:00Z",
      },
    );

    const geoProbeFn = vi.fn(async (host: string) => {
      if (host === "177.88.20.15") {
        return { countryCode: "BR", country: "Brazil", hosting: false, proxy: false, mobile: false, isp: "Vivo Fibra", checkedAt: Date.now() };
      }
      return { countryCode: "BR", country: "Brazil", hosting: true, proxy: false, mobile: false, isp: "Datacenter X", checkedAt: Date.now() };
    });

    const audit = await auditProxyPoolGeoAsn({ geoProbeFn, forceInTests: true });
    expect(audit.brResidentialCount).toBe(1);
    expect(audit.datacenterCount).toBe(1);

    expect(isFalse428BlacklistRow(dbState.tables.proxy_pool[2])).toBe(true);
    expect(isFalse428BlacklistRow(dbState.tables.proxy_pool[3])).toBe(false);
    const unbanRes = await manageProxyBlacklist({ action: "clear_false_428" });
    expect(unbanRes.updated).toBe(1);
    expect(dbState.tables.proxy_pool.find((r) => r.id === "px-428")?.status).toBe("available");
    expect(dbState.tables.proxy_pool.find((r) => r.id === "px-real-ban")?.status).toBe("blacklisted");

    dbState.tables.channel_connections.push({
      client_id: CLIENT_ID,
      instance_name: "chip-novo",
      provider: "evolution",
      provider_config: {},
    });
    const ensured = await ensureProxyForInstance({
      instanceName: "chip-novo",
      clientId: CLIENT_ID,
      reason: "warmup",
      probeFn: async () => ({ ok: true }),
      geoProbeFn,
      forceProbeInTests: true,
      forceGeoInTests: true,
    });
    expect(ensured.mode).toBe("pool_assigned");
    expect(ensured.host).toBe("177.88.20.15");

    dbState.tables.proxy_pool = [];
    invalidateProxyPoolCache();
    await saveProxyPoolSettings({ blockSharedVpsDomino: true, allowVpsFallback: true });
    dbState.tables.channel_connections.push(
      { client_id: CLIENT_ID, instance_name: "chip-vps-1", provider: "evolution", provider_config: { proxy_mode: "direct" } },
      { client_id: CLIENT_ID, instance_name: "chip-vps-2", provider: "evolution", provider_config: {} },
    );
    const dominoRes = await ensureProxyForInstance({
      instanceName: "chip-vps-2",
      clientId: CLIENT_ID,
      reason: "connect",
    });
    expect(dominoRes.ok).toBe(false);
    expect(dominoRes.usedVpsFallback).toBe(false);
    expect(dominoRes.reason).toContain("anti-dominó");
  });

  it("5. Resumo diário às 20h BRT: texto enxuto, trava de horário (<20h) e idempotência diária", async () => {
    const text = buildDailyWarmupOwnerReportText({
      dayKey: "2026-11-26",
      coldSentToday: 120,
      coldRepliedToday: 24,
      replyRatePct: 20,
      acceptedPreviewsToday: 7,
      promotionsToday: ["00000_numero2"],
      alerts: [],
      chips: [
        { instanceName: "00000_DD_11", stage: 4, healthScore: 95, sentToday: 40, coldSentToday: 60, replyRatePct: 21.7, alert: null },
      ],
    });
    expect(text).toContain("120");
    expect(text).toContain("20%");
    expect(text).toContain("Prévias aceitas hoje: 7");

    await saveGlobalWarmupSettings(CLIENT_ID, {
      daily_owner_summary_enabled: true,
      daily_owner_summary_phone: "5511988887777",
    });
    dbState.tables.channel_connections.push({ client_id: CLIENT_ID, instance_name: "00000_DD_11", status: "open" });
    dbState.tables.whatsapp_warmup_configs.push({
      client_id: CLIENT_ID,
      instance_name: "00000_DD_11",
      stage: 4,
      health_score: 96,
      sent_today: 20,
      is_quarantined: false,
    });

    const earlyRes = await maybeSendDailyWarmupOwnerSummary(CLIENT_ID, {
      now: new Date("2026-11-26T17:00:00Z"),
    });
    expect(earlyRes.sent).toBe(false);
    expect(earlyRes.reason).toBe("before_20h_brt");

    const okRes = await maybeSendDailyWarmupOwnerSummary(CLIENT_ID, {
      now: new Date("2026-11-26T23:05:00Z"),
    });
    expect(okRes.sent).toBe(true);
    expect(mockChannelSendMessage).toHaveBeenCalledTimes(1);

    const dupRes = await maybeSendDailyWarmupOwnerSummary(CLIENT_ID, {
      now: new Date("2026-11-26T23:15:00Z"),
    });
    expect(dupRes.sent).toBe(false);
    expect(dupRes.reason).toBe("already_sent_today");
  });

  it("6. Áudio Ogg Opus duração variável (CRC válido em todas as páginas), avatar Dia-0 e reciclagem 03h BRT MMZap", async () => {
    const sampleBuf = fs.readFileSync(path.join(process.cwd(), "public", "warmup_voice_sample.ogg"));
    const verifyAllPages = (buf: Buffer) => {
      let pos = 0;
      let pageCount = 0;
      while (pos < buf.length) {
        expect(verifyOggPageCrc(buf, pos)).toBe(true);
        const segs = buf[pos + 26];
        let dLen = 0;
        for (let i = 0; i < segs; i++) dLen += buf[pos + 27 + i];
        pos += 27 + segs + dLen;
        pageCount++;
      }
      expect(pos).toBe(buf.length);
      return pageCount;
    };

    const shortBuf = varyOggOpusDuration(sampleBuf, { mode: "short", seed: "s1" });
    const normBuf = varyOggOpusDuration(sampleBuf, { mode: "normal", seed: "n1" });
    const extBuf = varyOggOpusDuration(sampleBuf, { mode: "extended", seed: "e1" });

    expect(verifyAllPages(shortBuf)).toBeGreaterThanOrEqual(3);
    expect(verifyAllPages(normBuf)).toBeGreaterThanOrEqual(3);
    expect(verifyAllPages(extBuf)).toBeGreaterThanOrEqual(3);
    expect(shortBuf.length).toBeLessThan(extBuf.length);

    await saveGlobalWarmupSettings(CLIENT_ID, {
      default_profile_avatar_urls: "https://cdn.example.com/avatar-comercial.jpg",
    });
    dbState.tables.whatsapp_warmup_configs.push({
      client_id: CLIENT_ID,
      instance_name: "chip-avatar",
      phone_number: "5511912345678",
    });
    await hydrateChipProfile(CLIENT_ID, "chip-avatar");
    expect(mockEvoUpdatePic).toHaveBeenCalledWith(
      "https://cdn.example.com/avatar-comercial.jpg",
      "chip-avatar"
    );

    const mmzapMgr = await import("../../../services/mmzap-browser-worker/src/session-manager.mjs");
    expect(mmzapMgr.shouldRunDailyRecycleBrt(new Date("2026-11-26T06:05:00Z").getTime(), null)).toBe(true);
    expect(mmzapMgr.shouldRunDailyRecycleBrt(new Date("2026-11-26T06:10:00Z").getTime(), "2026-11-26")).toBe(false);
    expect(mmzapMgr.shouldRunDailyRecycleBrt(new Date("2026-11-26T15:00:00Z").getTime(), null)).toBe(false);
  });

  it("7. Teste A/B nativo: divisão 50/50, pausa automática (<10% após 20 envios) e redirecionamento 100% para vencedora", async () => {
    const campId = "camp-ab-01";
    await saveCampaignAbConfig(campId, {
      enabled: true,
      variantA_label: "2-Step",
      variantA_template: "Oi, tudo bem? Falo com {{nome_empresa}}?",
      variantB_label: "Vídeo Nota Google",
      variantB_template: MENTOR_VIDEO_PRAISE_TEMPLATE,
      min_sample_size: 20,
      auto_pause_below_pct: 10,
    });

    expect(
      selectCampaignAbVariant(
        {
          enabled: true,
          variantA_label: "A",
          variantA_template: "a",
          variantB_label: "B",
          variantB_template: "b",
          auto_pause_below_pct: 10,
          min_sample_size: 20,
          paused_variant: null,
          paused_reason: null,
        },
        { A: 5, B: 5 }
      )
    ).toBe("A");
    expect(
      selectCampaignAbVariant(
        {
          enabled: true,
          variantA_label: "A",
          variantA_template: "a",
          variantB_label: "B",
          variantB_template: "b",
          auto_pause_below_pct: 10,
          min_sample_size: 20,
          paused_variant: null,
          paused_reason: null,
        },
        { A: 6, B: 5 }
      )
    ).toBe("B");

    for (let i = 0; i < 20; i++) {
      const jidA = `55119000000${String(i).padStart(2, "0")}@s.whatsapp.net`;
      const jidB = `55119100000${String(i).padStart(2, "0")}@s.whatsapp.net`;
      await recordCampaignAbSend(campId, CLIENT_ID, jidA, "A");
      await recordCampaignAbSend(campId, CLIENT_ID, jidB, "B");
      dbState.tables.campaign_targets.push(
        { campaign_id: campId, client_id: CLIENT_ID, remote_jid: jidA, status: i === 0 ? "replied" : "sent" },
        { campaign_id: campId, client_id: CLIENT_ID, remote_jid: jidB, status: i < 5 ? "replied" : "sent" },
      );
    }

    const res = await computeCampaignAbSummary(CLIENT_ID, campId, "Teste A/B");
    expect(res.newlyPaused?.variant).toBe("A");
    expect(res.summary?.paused_variant).toBe("A");
    expect(res.summary?.winner_variant).toBe("B");
    expect(res.summary?.variants[0].reply_rate_pct).toBe(5);
    expect(res.summary?.variants[1].reply_rate_pct).toBe(25);

    expect(
      selectCampaignAbVariant(
        {
          enabled: true,
          variantA_label: "A",
          variantA_template: "a",
          variantB_label: "B",
          variantB_template: "b",
          auto_pause_below_pct: 10,
          min_sample_size: 20,
          paused_variant: "A",
          paused_reason: "auto",
        },
        { A: 20, B: 99 }
      )
    ).toBe("B");

    const bothLow = evaluateAbAutoPause(
      {
        enabled: true,
        variantA_label: "A",
        variantA_template: "a",
        variantB_label: "B",
        variantB_template: "b",
        auto_pause_below_pct: 10,
        min_sample_size: 20,
        paused_variant: null,
        paused_reason: null,
      },
      [
        { variant: "A", label: "A", sent: 20, replied: 0, preview_accepted: 0, reply_rate_pct: 0, paused: false },
        { variant: "B", label: "B", sent: 20, replied: 1, preview_accepted: 0, reply_rate_pct: 5, paused: false },
      ]
    );
    expect(bothLow.shouldPause).toBe(true);
    expect(bothLow.pausedVariant).toBe("A");
  });
});
