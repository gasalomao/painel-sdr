import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const tables = vi.hoisted(() => ({
  whatsapp_warmup_configs: [] as Row[],
  channel_connections: [] as Row[],
  app_settings: [] as Row[],
  chats_dashboard: [] as Row[],
  campaign_targets: [] as Row[],
}));

function buildQuery(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let single = false;
  let orderBy: { col: string; ascending: boolean } | null = null;
  let maxRows = Infinity;

  const chain: any = {
    select() {
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
  registerPendingAutomatedSend: vi.fn(),
}));

import {
  __resetCampaignAntiBanStateForTests,
  cacheVerifiedCanonicalJid,
  calculatePreSendProfilePauseMs,
  checkZeroReplyBrakeForInstance,
  clearZeroReplyBrakeForInstance,
  computeCampaignNextDelayMs,
  evaluateWeekendB2BGuard,
  extractBrazilDdd,
  findRecentCrossCampaignSend,
  getCachedCanonicalJid,
  getColdOutreachPolicyForStage,
  getColdSendCounts,
  recordColdOutreachSend,
  resolveCampaignColdShield,
  resolveHealthyCampaignChip,
} from "../campaign-worker";
import { AUTO_POOL_INSTANCE } from "../campaign-pool";

describe("Campaign Anti-Ban Shield (Meta Integrity Protection)", () => {
  beforeEach(() => {
    __resetCampaignAntiBanStateForTests();
    tables.whatsapp_warmup_configs.length = 0;
    tables.channel_connections.length = 0;
    tables.app_settings.length = 0;
    tables.chats_dashboard.length = 0;
    tables.campaign_targets.length = 0;
  });

  it("getColdOutreachPolicyForStage bloqueia Fase 1 (Berçário) e aplica Freio Dinâmico quando saúde < 75", () => {
    const lowHealth = getColdOutreachPolicyForStage(3, 35);
    expect(lowHealth.allowed).toBe(false);
    expect(lowHealth.reason).toBe("low_health");

    const stage1 = getColdOutreachPolicyForStage(1, 100);
    expect(stage1.allowed).toBe(false);
    expect(stage1.reason).toBe("nursery_stage_1");
    expect(stage1.dailyColdCap).toBe(0);

    const stage2Healthy = getColdOutreachPolicyForStage(2, 95);
    const stage3Healthy = getColdOutreachPolicyForStage(3, 95);
    const stage4Healthy = getColdOutreachPolicyForStage(4, 95);

    expect(stage2Healthy.hourlyColdCap).toBe(5);
    expect(stage3Healthy.hourlyColdCap).toBe(8);
    expect(stage4Healthy.hourlyColdCap).toBe(12);
    expect(stage2Healthy.minSafeIntervalSec).toBeGreaterThan(stage4Healthy.minSafeIntervalSec);

    // Saúde 60 (entre 40 e 74) reduz limites pela metade e reforça pulso simbiótico
    const stage3Throttled = getColdOutreachPolicyForStage(3, 60);
    expect(stage3Throttled.allowed).toBe(true);
    expect(stage3Throttled.throttledByHealth).toBe(true);
    expect(stage3Throttled.hourlyColdCap).toBe(4);
    expect(stage3Throttled.dailyColdCap).toBe(17);
    expect(stage3Throttled.symbioticEveryN).toBe(2);
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

    // 2. Chip fixo NÃO troca por balanceamento após 2, 3 ou 4 envios na hora
    const baseNow = Date.now();
    for (let sends = 1; sends <= 4; sends++) {
      recordColdOutreachSend("00000_DD_11", baseNow - (5 - sends) * 1000, clientId);
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

    // 4. Hidrata histórico de app_settings e ao atingir teto horário (5/h):
    //    - chip fixo aguarda no próprio chip (ok: false, hourly_cold_cap, rotated: false)
    //    - Pool Automático rotaciona para o irmão saudável
    __resetCampaignAntiBanStateForTests();
    tables.app_settings.push({
      key: `cold_sends_${clientId}`,
      value: JSON.stringify({
        "00000_DD_11": [baseNow - 1000, baseNow - 2000, baseNow - 3000, baseNow - 4000, baseNow - 5000],
      }),
    });

    const fixedCapped = await resolveHealthyCampaignChip(clientId, "00000_DD_11", baseNow);
    expect(getColdSendCounts("00000_DD_11", baseNow).hourlyCount).toBe(5);
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

    // 2. Simula 15 abordagens sem resposta no chip 00000_DD_11 -> ativa Freio de Vácuo
    let brakeHit = false;
    for (let i = 1; i <= 15; i++) {
      const check = await checkZeroReplyBrakeForInstance(
        clientId,
        "00000_DD_11",
        `55119000000${String(i).padStart(2, "0")}@s.whatsapp.net`
      );
      if (check.brakeTriggered) brakeHit = true;
    }
    expect(brakeHit).toBe(true);

    // Em chip fixo, freio de vácuo pausa no próprio chip (não troca para irmão)
    const fixedBrake = await resolveHealthyCampaignChip(clientId, "00000_DD_11", {
      targetRemoteJid: "5511988887777@s.whatsapp.net",
    });
    expect(fixedBrake.ok).toBe(false);
    expect(fixedBrake.instanceName).toBe("00000_DD_11");
    expect(fixedBrake.rotated).toBe(false);
    expect(fixedBrake.reason).toBe("zero_reply_brake");

    // Com 00000_DD_11 em freio de vácuo, Pool Automático deve rotacionar imediatamente para 00000_numero2
    const afterBrake = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      targetRemoteJid: "5511988887777@s.whatsapp.net",
    });
    expect(afterBrake.ok).toBe(true);
    expect(afterBrake.instanceName).toBe("00000_numero2");

    // Sticky Sender: quando preferredInstanceName está saudável no pool, ganha preferência sobre outro DDD/saúde
    clearZeroReplyBrakeForInstance("00000_DD_11");
    const stickyPick = await resolveHealthyCampaignChip(clientId, AUTO_POOL_INSTANCE, {
      targetRemoteJid: "5573999990000@s.whatsapp.net",
      preferredInstanceName: "00000_DD_11",
    });
    expect(stickyPick.ok).toBe(true);
    expect(stickyPick.instanceName).toBe("00000_DD_11");
    expect(stickyPick.reason).toBe("sticky_sender");

    // Zero-Reply Brake também reconhece respostas via sender_type="customer" + variante de 9º dígito BR
    tables.chats_dashboard.push({
      id: "reply-var-1",
      client_id: clientId,
      remote_jid: "551188887777@s.whatsapp.net",
      sender_type: "customer",
    });
    let secondBrake = false;
    for (let i = 1; i <= 15; i++) {
      const targetJid =
        i === 7 ? "5511988887777@s.whatsapp.net" : `55119111100${String(i).padStart(2, "0")}@s.whatsapp.net`;
      const res = await checkZeroReplyBrakeForInstance(clientId, "00000_DD_11", targetJid);
      if (res.brakeTriggered) secondBrake = true;
    }
    expect(secondBrake).toBe(false);
  });

  it("combina orçamento diário de aquecimento (sent_today) com prospecção fria sem reduzir baseline", async () => {
    const clientId = "00000000-0000-0000-0000-00000000a001";
    const baseNow = Date.now();
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
        health_score: 100,
        sent_today: 26, // Teto combinado Fase 2 = 32 -> restam 6 envios frios hoje
      },
      {
        client_id: clientId,
        instance_name: "chip-reserva",
        phone_number: "5511977776666",
        enabled: true,
        stage: 2,
        health_score: 95,
        sent_today: 0,
      }
    );

    // Simula 6 envios frios hoje em horas distintas (não atinge teto horário 5)
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

  it("evaluateWeekendB2BGuard é opt-in (não bloqueia domingos por padrão) e reduz sábado em 50% quando ativo", async () => {
    const sundayBrt = new Date("2026-11-15T15:00:00Z"); // Dom 12:00 BRT
    const saturdayBrt = new Date("2026-11-14T15:00:00Z"); // Sáb 12:00 BRT
    const mondayBrt = new Date("2026-11-16T15:00:00Z"); // Seg 12:00 BRT

    expect(evaluateWeekendB2BGuard(false, sundayBrt)).toMatchObject({ allowed: true, hourlyFactor: 1 });
    expect(evaluateWeekendB2BGuard(true, sundayBrt)).toMatchObject({
      allowed: false,
      hourlyFactor: 0,
      reason: "weekend_b2b_sunday",
    });
    expect(evaluateWeekendB2BGuard(true, saturdayBrt)).toMatchObject({
      allowed: true,
      hourlyFactor: 0.5,
      reason: "weekend_b2b_saturday",
    });
    expect(evaluateWeekendB2BGuard(true, mondayBrt)).toMatchObject({ allowed: true, hourlyFactor: 1 });

    // Verifica aplicação de hourlyFactor = 0.5 na elegibilidade horária (Fase 2: 5/h -> 2/h)
    const clientId = "00000000-0000-0000-0000-00000000a001";
    const now = Date.now();
    tables.channel_connections.push({ client_id: clientId, instance_name: "chip-sabado", status: "open" });
    tables.whatsapp_warmup_configs.push({
      client_id: clientId,
      instance_name: "chip-sabado",
      enabled: true,
      stage: 2,
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
    const baseNow = Date.now();
    tables.whatsapp_warmup_configs.push(
      {
        client_id: clientId,
        instance_name: "chip-no-teto",
        phone_number: "5511961607626",
        enabled: true,
        stage: 2,
        health_score: 100,
        sent_today: 26, // Teto combinado Fase 2 = 32 -> restam 6
      },
      {
        client_id: clientId,
        instance_name: "chip-quarentena",
        phone_number: "5511961607627",
        enabled: true,
        stage: 3,
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
});
