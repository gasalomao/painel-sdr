import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const mmzapMocks = vi.hoisted(() => ({
  stopMmzapSessionForChip: vi.fn(async () => ({ stopped: true, status: "idle" })),
}));

const tables = vi.hoisted(() => ({
  whatsapp_warmup_configs: [] as Row[],
  channel_connections: [] as Row[],
  app_settings: [] as Row[],
  chats_dashboard: [] as Row[],
  campaigns: [] as Row[],
  campaign_targets: [] as Row[],
  leads_extraidos: [] as Row[],
}));

function buildQuery(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let single = false;
  let orderBy: { col: string; ascending: boolean } | null = null;
  let maxRows = Infinity;
  let updateData: Row | null = null;

  const chain: any = {
    select() {
      return chain;
    },
    update(data: Row) {
      updateData = data;
      return chain;
    },
    upsert(data: Row) {
      const list = ((tables as any)[table] ||= []);
      const idx = list.findIndex((r: Row) => data.key && r.key === data.key);
      if (idx >= 0) Object.assign(list[idx], data);
      else list.push({ ...data });
      return chain;
    },
    eq(column: string, value: any) {
      filters.push((row) => row[column] === value);
      return chain;
    },
    neq(column: string, value: any) {
      filters.push((row) => row[column] !== value);
      return chain;
    },
    in(column: string, values: any[]) {
      filters.push((row) => values.includes(row[column]));
      return chain;
    },
    gte(column: string, value: any) {
      filters.push((row) => row[column] >= value);
      return chain;
    },
    order(column: string, opts?: { ascending?: boolean }) {
      orderBy = { col: column, ascending: opts?.ascending !== false };
      return chain;
    },
    limit(n?: number) {
      if (typeof n === "number") maxRows = n;
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
    then(resolve: any) {
      let list = ((tables as any)[table] || []).filter((r: Row) => filters.every((f) => f(r)));
      if (updateData) {
        for (const r of list) Object.assign(r, updateData);
      }
      if (orderBy) {
        const { col, ascending } = orderBy;
        list = [...list].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (Number.isFinite(maxRows)) list = list.slice(0, maxRows);
      return Promise.resolve({
        data: single ? list[0] || null : list,
        error: null,
      }).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (t: string) => buildQuery(t) },
}));
vi.mock("@/lib/evolution", () => ({ evolution: {} }));
vi.mock("@/lib/channel", () => ({
  sendMessage: vi.fn(),
  sendMedia: vi.fn(),
  checkWhatsAppNumbersDetailed: vi.fn(),
  resolveChannel: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock("@/lib/web-search", () => ({ webSearch: vi.fn(), formatResultsForAI: vi.fn() }));
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: vi.fn() }));
vi.mock("@/lib/manual-send-registry", () => ({
  registerAiSend: vi.fn(),
  registerPendingAutomatedMedia: vi.fn(),
  registerPendingAutomatedSend: vi.fn(),
}));
vi.mock("@/lib/warmup/mmzap-browser-orchestrator", () => ({
  stopMmzapSessionForChip: mmzapMocks.stopMmzapSessionForChip,
}));

import * as channel from "@/lib/channel";
import {
  __resetCampaignAntiBanStateForTests,
  cacheVerifiedCanonicalJid,
  calculatePreSendProfilePauseMs,
  calculatePreValidateJitterMs,
  checkZeroReplyBrakeForInstance,
  clearZeroReplyBrakeForInstance,
  computeCampaignNextDelayMs,
  evaluateWeekendB2BGuard,
  extractBrazilDdd,
  findRecentCrossCampaignSend,
  getCachedCanonicalJid,
  getColdOutreachPolicyForStage,
  getColdSendCounts,
  getFollowupSendCounts,
  preValidateCampaignNumbers,
  recordColdOutreachSend,
  recordFollowupOutreachSend,
  resolveCampaignColdShield,
  resolveHealthyCampaignChip,
  resolvePreValidationChip,
  STAGE_COMBINED_DAILY_CAP,
} from "../campaign-worker";
import {
  AUTO_POOL_INSTANCE,
  isB2BPeakReplyWindow,
  parseWeekendB2BGuardMode,
} from "../campaign-pool";

describe("Campaign Anti-Ban Shield (Meta Integrity Protection)", () => {
  beforeEach(() => {
    __resetCampaignAntiBanStateForTests();
    tables.whatsapp_warmup_configs.length = 0;
    tables.channel_connections.length = 0;
    tables.app_settings.length = 0;
    tables.chats_dashboard.length = 0;
    tables.campaigns.length = 0;
    tables.campaign_targets.length = 0;
    tables.leads_extraidos.length = 0;
    vi.clearAllMocks();
  });

  it("getColdOutreachPolicyForStage aplica rampa Nov 2026 (bloqueio < 7 dias, veterano 4B 80/dia, freio saúde e escalonamento adaptativo)", () => {
    const lowHealth = getColdOutreachPolicyForStage(3, 35, { daysActive: 12 });
    expect(lowHealth.allowed).toBe(false);
    expect(lowHealth.reason).toBe("low_health");

    const stage1 = getColdOutreachPolicyForStage(1, 100, { daysActive: 3 });
    expect(stage1.allowed).toBe(false);
    expect(stage1.reason).toBe("nursery_stage_1");
    expect(stage1.dailyColdCap).toBe(0);

    // Qualquer chip com < 7 dias ativos é bloqueado de prospecção fria
    const under7Days = getColdOutreachPolicyForStage(2, 100, { daysActive: 6 });
    expect(under7Days.allowed).toBe(false);
    expect(under7Days.reason).toBe("insufficient_active_days");

    const stage2Healthy = getColdOutreachPolicyForStage(2, 95, { daysActive: 8 });
    const stage3Healthy = getColdOutreachPolicyForStage(3, 95, { daysActive: 12 });
    const stage4A = getColdOutreachPolicyForStage(4, 95, { daysActive: 17 });
    const stage4BVeteran = getColdOutreachPolicyForStage(4, 95, { daysActive: 21 });

    expect(stage2Healthy).toMatchObject({
      allowed: true,
      dailyColdCap: 15,
      hourlyColdCap: 4,
      minSafeIntervalSec: 120,
      symbioticEveryN: 3,
      zeroReplyThreshold: 8,
    });
    expect(stage3Healthy).toMatchObject({
      allowed: true,
      dailyColdCap: 30,
      hourlyColdCap: 6,
      minSafeIntervalSec: 75,
      symbioticEveryN: 3,
      zeroReplyThreshold: 10,
    });
    expect(stage4A).toMatchObject({
      allowed: true,
      dailyColdCap: 50,
      hourlyColdCap: 10,
      minSafeIntervalSec: 55,
      symbioticEveryN: 4,
      zeroReplyThreshold: 12,
    });
    expect(stage4BVeteran).toMatchObject({
      allowed: true,
      dailyColdCap: 80,
      hourlyColdCap: 14,
      dailyFollowupCap: 40,
      minSafeIntervalSec: 45,
      symbioticEveryN: 4,
      zeroReplyThreshold: 14,
      veteranTier: true,
    });
    expect(STAGE_COMBINED_DAILY_CAP).toEqual({ 1: 0, 2: 35, 3: 65, 4: 115 });

    // Saúde 60 (entre 40 e 74) reduz limites pela metade e reforça pulso simbiótico
    const stage3Throttled = getColdOutreachPolicyForStage(3, 60, { daysActive: 12 });
    expect(stage3Throttled.allowed).toBe(true);
    expect(stage3Throttled.throttledByHealth).toBe(true);
    expect(stage3Throttled.hourlyColdCap).toBe(3);
    expect(stage3Throttled.dailyColdCap).toBe(15);
    expect(stage3Throttled.symbioticEveryN).toBe(2);

    // Escalonamento adaptativo por taxa de resposta
    const lowReplyThrottled = getColdOutreachPolicyForStage(4, 95, { daysActive: 25, recentReplyRate: 0.02 });
    expect(lowReplyThrottled.throttledByReplyRate).toBe(true);
    expect(lowReplyThrottled.dailyColdCap).toBeLessThan(80);

    const highReplyBoosted = getColdOutreachPolicyForStage(4, 95, { daysActive: 25, recentReplyRate: 0.35 });
    expect(highReplyBoosted.boostedByReplyRate).toBe(true);
    expect(highReplyBoosted.dailyColdCap).toBeGreaterThan(80);
  });

  it("computeCampaignNextDelayMs aplica Coffee-Break de 12 a 22 min ao completar um lote de 6-10 envios", () => {
    const inst = "00000_DD_11";
    let triggeredBreak = false;

    for (let i = 1; i <= 10; i++) {
      const state = recordColdOutreachSend(inst);
      const calc = computeCampaignNextDelayMs({
        instanceName: inst,
        minIntervalSec: 60,
        maxIntervalSec: 90,
        stageMinIntervalSec: 150,
      });

      if (calc.isCoffeeBreak) {
        triggeredBreak = true;
        expect(calc.delayMs).toBeGreaterThanOrEqual(720 * 1000);
        expect(calc.delayMs).toBeLessThanOrEqual(1320 * 1000);
        expect(calc.batchCount).toBeGreaterThanOrEqual(6);
        break;
      } else {
        expect(calc.delayMs).toBeGreaterThanOrEqual(150 * 1000);
        expect(state.countInBatch).toBe(i);
      }
    }

    expect(triggeredBreak).toBe(true);
  });

  it("cacheVerifiedCanonicalJid desacopla USyncQuery (onWhatsApp) do momento do envio e calculatePreSendProfilePauseMs gera pausa humana", () => {
    cacheVerifiedCanonicalJid("00000_DD_11", "5511999998888", {
      exists: true,
      jid: "5511999998888@s.whatsapp.net",
    });

    const hit = getCachedCanonicalJid("00000_DD_11", "5511999998888");
    expect(hit).toEqual({
      exists: true,
      jid: "5511999998888@s.whatsapp.net",
    });

    const crossHit = getCachedCanonicalJid("00000_numero2", "5511999998888");
    expect(crossHit?.jid).toBe("5511999998888@s.whatsapp.net");

    const pause = calculatePreSendProfilePauseMs();
    expect(pause).toBeGreaterThanOrEqual(3500);
    expect(pause).toBeLessThanOrEqual(7500);
  });

  it("resolveHealthyCampaignChip trava estritamente no chip fixo escolhido e só rotaciona em Pool Automático (__auto_pool__)", async () => {
    const clientId = "00000000-0000-0000-0000-00000000a001";
    expect(extractBrazilDdd("5511961607625@s.whatsapp.net")).toBe("11");
    expect(extractBrazilDdd("557391810230")).toBe("73");

    tables.channel_connections.push(
      { client_id: clientId, instance_name: "00000_DD_11", status: "open" },
      { client_id: clientId, instance_name: "00000_numero2", status: "open" }
    );
    tables.whatsapp_warmup_configs.push(
      {
        client_id: clientId,
        instance_name: "00000_DD_11",
        phone_number: "5511961607625",
        enabled: true,
        stage: 2,
        health_score: 100,
        is_quarantined: false,
        purpose: "inbound",
      },
      {
        client_id: clientId,
        instance_name: "00000_numero2",
        phone_number: "557391810230",
        enabled: true,
        stage: 2,
        health_score: 90,
        is_quarantined: false,
        purpose: "inbound",
      }
    );

    // 1. Chip fixo NÃO troca por afinidade de DDD mesmo existindo irmão com DDD 73
    const fixedDdd = await resolveHealthyCampaignChip(clientId, "00000_DD_11", {
      targetRemoteJid: "557399887766@s.whatsapp.net",
    });
    expect(fixedDdd.ok).toBe(true);
    expect(fixedDdd.instanceName).toBe("00000_DD_11");
    expect(fixedDdd.rotated).toBe(false);

    // 2. Chip fixo NÃO troca por balanceamento após 2 ou 3 envios na hora (teto Fase 2 = 4/h)
    const baseNow = Date.parse("2026-11-26T22:00:00Z"); // 19:00 BRT
    for (let sends = 1; sends <= 3; sends++) {
      recordColdOutreachSend("00000_DD_11", baseNow - (4 - sends) * 1000, clientId);
      if (sends >= 2) {
        const res = await resolveHealthyCampaignChip(clientId, "00000_DD_11", baseNow);
        expect(res.ok).toBe(true);
        expect(res.instanceName).toBe("00000_DD_11");
        expect(res.rotated).toBe(false);
      }
    }

    // 3. No modo Pool Automático (__auto_pool__), afinidade de DDD e balanceamento continuam ativos
    const poolDdd73 = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      targetRemoteJid: "557399887766@s.whatsapp.net",
      nowMs: baseNow,
    });
    expect(poolDdd73.ok).toBe(true);
    expect(poolDdd73.instanceName).toBe("00000_numero2");
    expect(poolDdd73.rotated).toBe(true);
    expect(poolDdd73.reason).toBe("ddd_affinity");

    // 4. Hidrata histórico de app_settings e ao atingir teto horário Fase 2 (4/h):
    //    - chip fixo aguarda no próprio chip (ok: false, hourly_cold_cap, rotated: false)
    //    - Pool Automático rotaciona para o irmão saudável
    __resetCampaignAntiBanStateForTests();
    tables.app_settings.push({
      key: `cold_sends_${clientId}`,
      value: JSON.stringify({
        "00000_DD_11": [baseNow - 1000, baseNow - 2000, baseNow - 3000, baseNow - 4000],
      }),
    });

    const fixedCapped = await resolveHealthyCampaignChip(clientId, "00000_DD_11", baseNow);
    expect(getColdSendCounts("00000_DD_11", baseNow).hourlyCount).toBe(4);
    expect(fixedCapped.ok).toBe(false);
    expect(fixedCapped.instanceName).toBe("00000_DD_11");
    expect(fixedCapped.rotated).toBe(false);
    expect(fixedCapped.reason).toBe("hourly_cold_cap");

    const poolFailover = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      targetRemoteJid: "5511988887777@s.whatsapp.net",
      nowMs: baseNow,
    });
    expect(poolFailover.ok).toBe(true);
    expect(poolFailover.instanceName).toBe("00000_numero2");
    expect(poolFailover.rotated).toBe(true);

    // 5. Chip fixo em Berçário (Fase 1) bloqueia no próprio chip mesmo com irmão em Fase 2 saudável
    __resetCampaignAntiBanStateForTests();
    tables.whatsapp_warmup_configs[0].stage = 1;
    const fixedNursery = await resolveHealthyCampaignChip(clientId, "00000_DD_11", baseNow);
    expect(fixedNursery.ok).toBe(false);
    expect(fixedNursery.instanceName).toBe("00000_DD_11");
    expect(fixedNursery.rotated).toBe(false);
    expect(fixedNursery.reason).toBe("nursery_stage_1");

    // E no Pool Automático pula o Berçário e escolhe o irmão em Fase 2
    const poolSkipsNursery = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      targetRemoteJid: "5511988887777@s.whatsapp.net",
      nowMs: baseNow,
    });
    expect(poolSkipsNursery.ok).toBe(true);
    expect(poolSkipsNursery.instanceName).toBe("00000_numero2");
  });

  it("ativa Freio de Vácuo Silencioso após 15 envios sem resposta e resolve Pool Automático (__auto_pool__)", async () => {
    const clientId = "00000000-0000-0000-0000-00000000a001";
    tables.channel_connections.push(
      { client_id: clientId, instance_name: "00000_DD_11", status: "open" },
      { client_id: clientId, instance_name: "00000_numero2", status: "open" }
    );
    tables.whatsapp_warmup_configs.push(
      {
        client_id: clientId,
        instance_name: "00000_DD_11",
        phone_number: "5511961607625",
        enabled: true,
        stage: 2,
        health_score: 100,
        is_quarantined: false,
      },
      {
        client_id: clientId,
        instance_name: "00000_numero2",
        phone_number: "557391810230",
        enabled: true,
        stage: 2,
        health_score: 90,
        is_quarantined: false,
      }
    );

    // 1. Pool Automático escolhe o chip real correto pelo DDD (nunca retorna "__auto_pool__")
    const autoPicked = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      targetRemoteJid: "5511988887777@s.whatsapp.net",
    });
    expect(autoPicked.ok).toBe(true);
    expect(autoPicked.instanceName).toBe("00000_DD_11");
    expect(autoPicked.reason).toBe("ddd_affinity");

    // 2. Simula 8 abordagens sem resposta no chip Fase 2 (threshold = 8) -> ativa Freio de Vácuo
    const nowMs = Date.parse("2026-11-26T18:00:00Z");
    let brakeHit = false;
    for (let i = 1; i <= 8; i++) {
      const check = await checkZeroReplyBrakeForInstance(
        clientId,
        "00000_DD_11",
        `55119000000${String(i).padStart(2, "0")}@s.whatsapp.net`,
        nowMs,
        8
      );
      if (check.brakeTriggered) brakeHit = true;
    }
    expect(brakeHit).toBe(true);

    // Em chip fixo, freio de vácuo pausa no próprio chip (não troca para irmão)
    const fixedBrake = await resolveHealthyCampaignChip(clientId, "00000_DD_11", {
      targetRemoteJid: "5511988887777@s.whatsapp.net",
      nowMs,
    });
    expect(fixedBrake.ok).toBe(false);
    expect(fixedBrake.instanceName).toBe("00000_DD_11");
    expect(fixedBrake.rotated).toBe(false);
    expect(fixedBrake.reason).toBe("zero_reply_brake");

    // Com 00000_DD_11 em freio de vácuo, Pool Automático deve rotacionar imediatamente para 00000_numero2
    const afterBrake = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      targetRemoteJid: "5511988887777@s.whatsapp.net",
      nowMs,
    });
    expect(afterBrake.ok).toBe(true);
    expect(afterBrake.instanceName).toBe("00000_numero2");

    // Sticky Sender: quando preferredInstanceName está saudável no pool, ganha preferência sobre outro DDD/saúde
    clearZeroReplyBrakeForInstance("00000_DD_11");
    const stickyPick = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      targetRemoteJid: "5573999990000@s.whatsapp.net",
      preferredInstanceName: "00000_DD_11",
      nowMs,
    });
    expect(stickyPick.ok).toBe(true);
    expect(stickyPick.instanceName).toBe("00000_DD_11");
    expect(stickyPick.reason).toBe("sticky_sender");

    // Zero-Reply Brake ignora outbound chunks e reconhece resposta inbound recente via variante de 9º dígito BR
    for (let k = 0; k < 60; k++) {
      tables.chats_dashboard.push({
        id: `out-${k}`,
        client_id: clientId,
        remote_jid: "5511988887777@s.whatsapp.net",
        sender_type: "ai",
        created_at: new Date(nowMs + 1000).toISOString(),
      });
    }
    tables.chats_dashboard.push({
      id: "reply-var-1",
      client_id: clientId,
      remote_jid: "551188887777@s.whatsapp.net",
      sender_type: "customer",
      created_at: new Date(nowMs + 5000).toISOString(),
    });
    let secondBrake = false;
    for (let i = 1; i <= 12; i++) {
      const targetJid =
        i === 7 ? "5511988887777@s.whatsapp.net" : `55119111100${String(i).padStart(2, "0")}@s.whatsapp.net`;
      const res = await checkZeroReplyBrakeForInstance(clientId, "00000_DD_11", targetJid, nowMs);
      if (res.brakeTriggered) secondBrake = true;
    }
    expect(secondBrake).toBe(false);
  });

  it("combina orçamento diário de aquecimento (sent_today) com prospecção fria sem reduzir baseline", async () => {
    const clientId = "00000000-0000-0000-0000-00000000a001";
    const baseNow = Date.parse("2026-11-26T22:00:00Z"); // 19:00 BRT
    tables.channel_connections.push(
      { client_id: clientId, instance_name: "chip-aquecido-hoje", status: "open" },
      { client_id: clientId, instance_name: "chip-reserva", status: "open" }
    );
    tables.whatsapp_warmup_configs.push(
      {
        client_id: clientId,
        instance_name: "chip-aquecido-hoje",
        phone_number: "5511961607625",
        enabled: true,
        stage: 2,
        days_active: 8,
        health_score: 100,
        sent_today: 29, // Teto combinado Fase 2 = 35 -> restam 6 envios frios hoje
      },
      {
        client_id: clientId,
        instance_name: "chip-reserva",
        phone_number: "5511977776666",
        enabled: true,
        stage: 2,
        days_active: 8,
        health_score: 95,
        sent_today: 0,
      }
    );

    // Simula 6 envios frios hoje em horas distintas do mesmo dia BRT (não atinge teto horário 4)
    for (let i = 0; i < 6; i++) {
      recordColdOutreachSend("chip-aquecido-hoje", baseNow - (i + 2) * 65 * 60 * 1000, clientId);
    }

    // Em chip fixo, bloqueia no próprio chip por combined_daily_cap sem jogar para chip-reserva
    const fixedBlocked = await resolveHealthyCampaignChip(clientId, "chip-aquecido-hoje", {
      nowMs: baseNow,
    });
    expect(fixedBlocked.ok).toBe(false);
    expect(fixedBlocked.rotated).toBe(false);
    expect(fixedBlocked.instanceName).toBe("chip-aquecido-hoje");
    expect(fixedBlocked.reason).toBe("combined_daily_cap");

    // No Pool Automático, rotaciona para o chip-reserva disponível
    const rotated = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      nowMs: baseNow,
    });
    expect(rotated.ok).toBe(true);
    expect(rotated.rotated).toBe(true);
    expect(rotated.instanceName).toBe("chip-reserva");
    expect(rotated.reason).toBe("auto_pool");
  });

  it("evaluateWeekendB2BGuard suporta sunday_only (sábado 100%, domingo pausado), full, true e false + pico noturno B2B", async () => {
    const sundayBrt = new Date("2026-11-15T15:00:00Z"); // Dom 12:00 BRT
    const saturdayBrt = new Date("2026-11-14T15:00:00Z"); // Sáb 12:00 BRT
    const mondayEveningBrt = new Date("2026-11-16T22:00:00Z"); // Seg 19:00 BRT

    expect(parseWeekendB2BGuardMode("sunday_only")).toBe("sunday_only");
    expect(parseWeekendB2BGuardMode("full")).toBe("full");
    expect(parseWeekendB2BGuardMode(true)).toBe("full");
    expect(parseWeekendB2BGuardMode(false)).toBe(false);

    expect(evaluateWeekendB2BGuard(false, sundayBrt)).toMatchObject({ allowed: true, hourlyFactor: 1 });
    expect(evaluateWeekendB2BGuard("full", sundayBrt)).toMatchObject({
      allowed: false,
      hourlyFactor: 0,
      reason: "weekend_b2b_sunday",
    });
    expect(evaluateWeekendB2BGuard("full", saturdayBrt)).toMatchObject({
      allowed: true,
      hourlyFactor: 0.5,
      reason: "weekend_b2b_saturday",
    });
    expect(evaluateWeekendB2BGuard("sunday_only", sundayBrt)).toMatchObject({
      allowed: false,
      hourlyFactor: 0,
      reason: "weekend_b2b_sunday",
    });
    expect(evaluateWeekendB2BGuard("sunday_only", saturdayBrt)).toMatchObject({
      allowed: true,
      hourlyFactor: 1,
      reason: "weekend_b2b_saturday_full",
    });
    expect(evaluateWeekendB2BGuard("sunday_only", mondayEveningBrt)).toMatchObject({ allowed: true, hourlyFactor: 1 });

    // Janela pico B2B (sábado comercial + 18h-20h dias úteis)
    expect(isB2BPeakReplyWindow(saturdayBrt).isPeak).toBe(true);
    expect(isB2BPeakReplyWindow(mondayEveningBrt).isPeak).toBe(true);
    expect(isB2BPeakReplyWindow(sundayBrt).isPeak).toBe(false);

    // Verifica aplicação de hourlyFactor = 0.5 na elegibilidade horária (Fase 2: 4/h -> 2/h)
    const clientId = "00000000-0000-0000-0000-00000000a001";
    const now = Date.parse("2026-11-14T15:00:00Z");
    tables.channel_connections.push({ client_id: clientId, instance_name: "chip-sabado", status: "open" });
    tables.whatsapp_warmup_configs.push({
      client_id: clientId,
      instance_name: "chip-sabado",
      enabled: true,
      stage: 2,
      days_active: 8,
      health_score: 100,
    });
    recordColdOutreachSend("chip-sabado", now - 5 * 60 * 1000, clientId);
    recordColdOutreachSend("chip-sabado", now - 2 * 60 * 1000, clientId);

    const saturdayBlocked = await resolveHealthyCampaignChip(clientId, "chip-sabado", {
      nowMs: now,
      hourlyFactor: 0.5,
    });
    expect(saturdayBlocked.ok).toBe(false);
    expect(saturdayBlocked.reason).toBe("weekend_hourly_cap");
  });

  it("findRecentCrossCampaignSend bloqueia duplo disparo entre campanhas em < 72h (incl. 9º dígito BR) e isola tenants", async () => {
    const nowMs = Date.parse("2026-11-16T15:00:00Z");
    const recentIso = new Date(nowMs - 6 * 60 * 60 * 1000).toISOString();
    const expiredIso = new Date(nowMs - 96 * 60 * 60 * 1000).toISOString();

    tables.campaign_targets.push(
      {
        client_id: "tenant-a",
        campaign_id: "camp-anterior",
        remote_jid: "551188887777@s.whatsapp.net",
        status: "sent",
        sent_at: recentIso,
      },
      {
        client_id: "tenant-b",
        campaign_id: "camp-outro-tenant",
        remote_jid: "5511977776666@s.whatsapp.net",
        status: "sent",
        sent_at: recentIso,
      },
      {
        client_id: "tenant-a",
        campaign_id: "camp-antiga",
        remote_jid: "5511955554444@s.whatsapp.net",
        status: "sent",
        sent_at: expiredIso,
      }
    );

    // Mesmo número com 9º dígito na outra campanha (< 72h) -> bloqueia
    const hit = await findRecentCrossCampaignSend({
      clientId: "tenant-a",
      currentCampaignId: "camp-nova",
      remoteJid: "5511988887777@s.whatsapp.net",
      nowMs,
    });
    expect(hit).toEqual({ campaignId: "camp-anterior", sentAt: recentIso });

    // Mesma campanha -> não se autobloqueia
    expect(
      await findRecentCrossCampaignSend({
        clientId: "tenant-a",
        currentCampaignId: "camp-anterior",
        remoteJid: "5511988887777@s.whatsapp.net",
        nowMs,
      })
    ).toBeNull();

    // Outro tenant -> isolamento preservado
    expect(
      await findRecentCrossCampaignSend({
        clientId: "tenant-a",
        currentCampaignId: "camp-nova",
        remoteJid: "5511977776666@s.whatsapp.net",
        nowMs,
      })
    ).toBeNull();

    // Envio antigo (> 72h) -> liberado
    expect(
      await findRecentCrossCampaignSend({
        clientId: "tenant-a",
        currentCampaignId: "camp-nova",
        remoteJid: "5511955554444@s.whatsapp.net",
        nowMs,
      })
    ).toBeNull();
  });

  it("bypassColdShield libera chip no teto combinado e em quarentena (switch desligado na campanha)", async () => {
    const clientId = "00000000-0000-0000-0000-00000000b001";
    const baseNow = Date.parse("2026-11-26T22:00:00Z"); // 19:00 BRT
    tables.whatsapp_warmup_configs.push(
      {
        client_id: clientId,
        instance_name: "chip-no-teto",
        phone_number: "5511961607626",
        enabled: true,
        stage: 2,
        days_active: 8,
        health_score: 100,
        sent_today: 29, // Teto combinado Fase 2 = 35 -> restam 6
      },
      {
        client_id: clientId,
        instance_name: "chip-quarentena",
        phone_number: "5511961607627",
        enabled: true,
        stage: 3,
        days_active: 12,
        health_score: 100,
        is_quarantined: true,
        quarantine_until: new Date(baseNow + 60 * 60 * 1000).toISOString(),
      }
    );

    for (let i = 0; i < 6; i++) {
      recordColdOutreachSend("chip-no-teto", baseNow - (i + 2) * 65 * 60 * 1000, clientId);
    }

    const blocked = await resolveHealthyCampaignChip(clientId, "chip-no-teto", { nowMs: baseNow });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("combined_daily_cap");

    const bypassed = await resolveHealthyCampaignChip(clientId, "chip-no-teto", {
      nowMs: baseNow,
      bypassColdShield: true,
    });
    expect(bypassed.ok).toBe(true);
    expect(bypassed.instanceName).toBe("chip-no-teto");

    const quarantineBlocked = await resolveHealthyCampaignChip(clientId, "chip-quarentena", { nowMs: baseNow });
    expect(quarantineBlocked.ok).toBe(false);
    expect(quarantineBlocked.reason).toBe("quarantined");

    const quarantineBypassed = await resolveHealthyCampaignChip(clientId, "chip-quarentena", {
      nowMs: baseNow,
      bypassColdShield: true,
    });
    expect(quarantineBypassed.ok).toBe(true);
    expect(quarantineBypassed.instanceName).toBe("chip-quarentena");
  });

  it("computeCampaignNextDelayMs com bypassBatchBreak nunca aciona Coffee-Break", () => {
    const inst = "chip-sem-freio";
    for (let i = 0; i < 12; i++) recordColdOutreachSend(inst);

    const calc = computeCampaignNextDelayMs({
      instanceName: inst,
      minIntervalSec: 20,
      maxIntervalSec: 40,
      bypassBatchBreak: true,
    });
    expect(calc.isCoffeeBreak).toBe(false);
    expect(calc.batchCount).toBe(0);
    expect(calc.delayMs).toBeGreaterThanOrEqual(20 * 1000);
    expect(calc.delayMs).toBeLessThanOrEqual(40 * 1000);
  });

  it("resolveCampaignColdShield lê a chave da campanha e assume LIGADO quando ausente", async () => {
    expect(await resolveCampaignColdShield({ id: "camp-sem-chave" })).toBe(true);

    tables.app_settings.push({ key: "campaign_cold_shield:camp-off", value: "false" });
    expect(await resolveCampaignColdShield({ id: "camp-off" })).toBe(false);

    tables.app_settings.push({ key: "campaign_cold_shield:camp-on", value: "true" });
    expect(await resolveCampaignColdShield({ id: "camp-on" })).toBe(true);
  });

  it("MMZap Handover Guard encerra turno running antes do disparo e evita duplo-bot simultâneo", async () => {
    const clientId = "tenant-mmzap-guard";
    tables.channel_connections.push(
      { client_id: clientId, instance_name: "chip-mmzap", status: "open" },
    );
    tables.whatsapp_warmup_configs.push({
      client_id: clientId,
      instance_name: "chip-mmzap",
      enabled: true,
      stage: 4,
      days_active: 25,
      health_score: 95,
      is_quarantined: false,
      mmzap_browser_status: "running",
    });

    // dryRun não dispara parada prematura
    const dryRes = await resolveHealthyCampaignChip(clientId, "chip-mmzap", { dryRun: true });
    expect(dryRes.ok).toBe(true);
    expect(mmzapMocks.stopMmzapSessionForChip).not.toHaveBeenCalled();

    // Envio real encerra MMZap com motivo "campaign_active"
    const liveRes = await resolveHealthyCampaignChip(clientId, "chip-mmzap");
    expect(liveRes.ok).toBe(true);
    expect(liveRes.mmzapHandoverStopped).toBe(true);
    expect(mmzapMocks.stopMmzapSessionForChip).toHaveBeenCalledWith(clientId, "chip-mmzap", "campaign_active");
  });

  it("preValidateCampaignNumbers usa maxBatch=6, jitter 1.5–3.5s, prefere chip standby em __auto_pool__ e incrementa skipped_count", async () => {
    const clientId = "tenant-preval";
    const nowMs = Date.parse("2026-11-26T18:00:00Z");

    const j = calculatePreValidateJitterMs();
    expect(j).toBeGreaterThanOrEqual(1500);
    expect(j).toBeLessThanOrEqual(3500);

    tables.channel_connections.push(
      { client_id: clientId, instance_name: "chip-sender", status: "open" },
      { client_id: clientId, instance_name: "chip-standby", status: "open" }
    );
    tables.whatsapp_warmup_configs.push(
      {
        client_id: clientId,
        instance_name: "chip-sender",
        enabled: true,
        stage: 4,
        days_active: 25,
        health_score: 100,
        purpose: "outbound",
      },
      {
        client_id: clientId,
        instance_name: "chip-standby",
        enabled: true,
        stage: 3,
        days_active: 14,
        health_score: 95,
        purpose: "contingency",
      }
    );
    recordColdOutreachSend("chip-sender", nowMs - 5 * 60 * 1000, clientId);

    const pickedForCheck = await resolvePreValidationChip(clientId, AUTO_POOL_INSTANCE, "camp-pv", nowMs);
    expect(pickedForCheck).toBe("chip-standby");

    tables.campaigns.push({
      id: "camp-pv",
      client_id: clientId,
      instance_name: AUTO_POOL_INSTANCE,
      status: "running",
      skipped_count: 0,
    });
    for (let i = 1; i <= 10; i++) {
      tables.campaign_targets.push({
        id: `t-${i}`,
        campaign_id: "camp-pv",
        remote_jid: `55119999900${String(i).padStart(2, "0")}@s.whatsapp.net`,
        status: "pending",
        priority: 10 - i,
        created_at: `2026-11-26T10:00:${String(i).padStart(2, "0")}Z`,
      });
    }

    (channel.checkWhatsAppNumbersDetailed as any).mockImplementation(async (phones: string[]) => {
      const p = phones[0];
      if (p.endsWith("02")) return { [p]: { exists: false, jid: null } };
      return { [p]: { exists: true, jid: `${p}@s.whatsapp.net` } };
    });

    const pvRes = await preValidateCampaignNumbers("camp-pv");
    expect(pvRes.checked).toBe(6); // default maxBatch = 6 (reduzido de 15)
    expect(pvRes.skippedInvalid).toBe(1);
    expect(pvRes.instanceUsed).toBe("chip-standby");
    expect(tables.campaigns[0].skipped_count).toBe(1);
  });

  it("getColdSendCounts usa dia calendário BRT e separa cota de follow-up dentro do teto combinado para 2 veteranos (160 frios + 80 follow-ups)", async () => {
    const clientId = "tenant-vet";
    // Envio ontem à tarde (18:00 BRT) NÃO bloqueia hoje de manhã (09:00 BRT)
    const yesterdayAfternoon = Date.parse("2026-11-25T21:00:00Z"); // 18:00 BRT
    const todayMorning = Date.parse("2026-11-26T12:00:00Z"); // 09:00 BRT
    for (let i = 0; i < 15; i++) {
      recordColdOutreachSend("chip-brt", yesterdayAfternoon + i * 1000, clientId);
    }
    expect(getColdSendCounts("chip-brt", todayMorning).dailyCount).toBe(0);

    // 2 chips veteranos: cota fria (80) não bloqueia cota de follow-up (40) dentro do teto combinado (120)
    tables.channel_connections.push({ client_id: clientId, instance_name: "vet-1", status: "open" });
    tables.whatsapp_warmup_configs.push({
      client_id: clientId,
      instance_name: "vet-1",
      enabled: true,
      stage: 4,
      days_active: 25,
      health_score: 96,
      sent_today: 0,
    });
    const baseToday = Date.parse("2026-11-26T22:00:00Z"); // 19:00 BRT
    for (let i = 0; i < 80; i++) {
      // Espalha nas horas anteriores de hoje BRT
      recordColdOutreachSend("vet-1", baseToday - (2 + (i % 8)) * 60 * 60 * 1000, clientId);
    }
    const coldExhausted = await resolveHealthyCampaignChip(clientId, "vet-1", { nowMs: baseToday, mode: "cold" });
    expect(coldExhausted.ok).toBe(false);
    expect(coldExhausted.reason).toBe("daily_cold_cap");

    // Follow-up continua liberado com cota dedicada de 40/dia (80 + 40 = 120)
    const fuAllowed = await resolveHealthyCampaignChip(clientId, "vet-1", { nowMs: baseToday, mode: "followup" });
    expect(fuAllowed.ok).toBe(true);
    recordFollowupOutreachSend("vet-1", baseToday - 1000, clientId);
    expect(getFollowupSendCounts("vet-1", baseToday).dailyCount).toBe(1);
  });
});
