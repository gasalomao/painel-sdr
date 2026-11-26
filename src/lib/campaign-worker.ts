/**
 * Worker in-process pra disparo em massa.
 *
 * Princípio: pra cada campanha 'running', rodamos um loop que:
 *   1. pega o próximo target pending
 *   2. respeita horário permitido (allowed_start_hour..allowed_end_hour)
 *   3. envia via Evolution API com presence "composing" antes
 *   4. grava em sessions+messages+chats_dashboard pra IA ter contexto
 *   5. agenda o próximo com delay = random(min_interval, max_interval)
 *   6. backoff em erro 429 (até 240s) e parar após 3 falhas seguidas
 *
 * Resilient: cada target tem next_send_at no DB. Se o processo reiniciar,
 * podemos retomar (futuro: tick endpoint).
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import * as channel from "@/lib/channel";
import { leadRowToTemplateContext, renderTemplate } from "@/lib/template-vars";
import { webSearch, formatResultsForAI } from "@/lib/web-search";
import { logTokenUsage } from "@/lib/token-usage";
import { registerAiSend, registerPendingAutomatedMedia, registerPendingAutomatedSend } from "@/lib/manual-send-registry";
import { splitMessage } from "@/lib/agent-format";
import { isInstanceOwnedByClient } from "@/lib/tenant";
import { checkTenantAiQuota, isClientActiveCached, isClientAdminCached } from "@/lib/saas-limits";
import {
  evaluateWeekendB2BGuard,
  isAutoPoolInstance,
  parseWeekendB2BGuardMode,
  type WeekendB2BGuardMode,
  type WeekendB2BGuardResult,
} from "@/lib/campaign-pool";
import {
  computeCampaignAbSummary,
  getCampaignAbConfig,
  recordCampaignAbSend,
  selectCampaignAbVariant,
  type AbVariantKey,
} from "@/lib/campaign-ab-testing";
import { getBrazilPhoneVariants } from "@/lib/jid-utils";
import { isChatRowInbound } from "@/lib/chat-direction";
import { calculateChunkTypingMs, calculateTypingDelayMs, DEFAULT_TYPING_DELAY_CONFIG } from "@/lib/agent-delay";
import {
  applyAntiBanMixer,
  cleanCompanyNameForApproach,
  effectiveDateForWindow,
  enforceShortHandshakeGuard,
  exportAntiBanHistory,
  isPersonalizedPraiseOpenerTemplate,
  isShortIcebreakerTemplate,
  seedAntiBanHistory,
  syncGreetingToCurrentHour,
} from "@/lib/antiban-mixer";

export type ColdOutreachPolicy = {
  allowed: boolean;
  dailyColdCap: number;
  hourlyColdCap: number;
  dailyFollowupCap: number;
  hourlyFollowupCap: number;
  minSafeIntervalSec: number;
  symbioticEveryN: number;
  zeroReplyThreshold: number;
  veteranTier?: boolean;
  throttledByHealth?: boolean;
  throttledByReplyRate?: boolean;
  boostedByReplyRate?: boolean;
  reason?: string;
};

/**
 * Extrai os 2 dígitos de DDD de um telefone ou JID brasileiro (ex: "5511999..." -> "11").
 */
export function extractBrazilDdd(phoneOrJid?: string | null): string | null {
  if (!phoneOrJid) return null;
  let digits = String(phoneOrJid).replace(/@.*$/, "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("55") && digits.length >= 12) {
    digits = digits.slice(2);
  }
  if (digits.length >= 10 && digits.length <= 11) {
    return digits.slice(0, 2);
  }
  return null;
}

/**
 * Política Anti-Ban Nov 2026 para Prospecção Fria (First-Contact Outbound) baseada
 * no estágio de maturação (`stage 1..4`), dias ativos (`daysActive`), saúde (`health_score`)
 * e taxa de resposta recente (`recentReplyRate`):
 * - Fase 1 ou `daysActive < 7`: BLOQUEADO de disparos frios (risco extremo de ban em chip novo).
 * - Fase 2 (Dias 7–10): 15 frios/dia, 4/hora, 120s, pulso simbiótico a cada 3, freio zero-reply em 8.
 * - Fase 3 (Dias 11–14): 30 frios/dia, 6/hora, 75s, pulso simbiótico a cada 3, freio zero-reply em 10.
 * - Fase 4A (Dias 15–20): 50 frios/dia, 10/hora, 55s, pulso simbiótico a cada 4, freio zero-reply em 12.
 * - Fase 4B Veterano (stage 4, >= 21 dias, saúde >= 90): 80 frios/dia, 14/hora, 45s, pulso a cada 4, freio em 14.
 * - Saúde < 40: BLOQUEADO até recuperar no aquecimento.
 * - Saúde 40..74: Freio Dinâmico (cota diária/horária pela metade e mais pulsos simbióticos).
 */
export type ColdOutreachPolicyOptions = {
  daysActive?: number;
  careerMode?: string | null;
  coldOutreachLockedUntil?: string | null;
  recentReplyRate?: number | null;
  nowMs?: number;
};

export function getColdOutreachPolicyForStage(
  stage: number,
  healthScore = 100,
  opts?: ColdOutreachPolicyOptions
): ColdOutreachPolicy {
  const normalizedStage = Math.max(1, Math.min(4, Math.floor(Number(stage) || 1)));
  const nowMs = opts?.nowMs ?? Date.now();
  if (opts?.careerMode === "rehab") {
    return {
      allowed: false,
      dailyColdCap: 0,
      hourlyColdCap: 0,
      dailyFollowupCap: 0,
      hourlyFollowupCap: 0,
      minSafeIntervalSec: 300,
      symbioticEveryN: 2,
      zeroReplyThreshold: 8,
      reason: "post_ban_rehab",
    };
  }
  if (opts?.coldOutreachLockedUntil) {
    const lockMs = new Date(opts.coldOutreachLockedUntil).getTime();
    if (Number.isFinite(lockMs) && lockMs > nowMs) {
      return {
        allowed: false,
        dailyColdCap: 0,
        hourlyColdCap: 0,
        dailyFollowupCap: 0,
        hourlyFollowupCap: 0,
        minSafeIntervalSec: 300,
        symbioticEveryN: 2,
        zeroReplyThreshold: 8,
        reason: "post_ban_rehab",
      };
    }
  }
  if (normalizedStage <= 1) {
    return {
      allowed: false,
      dailyColdCap: 0,
      hourlyColdCap: 0,
      dailyFollowupCap: 0,
      hourlyFollowupCap: 0,
      minSafeIntervalSec: 300,
      symbioticEveryN: 2,
      zeroReplyThreshold: 8,
      reason: "nursery_stage_1",
    };
  }
  if (opts?.daysActive !== undefined && opts.daysActive < 7) {
    return {
      allowed: false,
      dailyColdCap: 0,
      hourlyColdCap: 0,
      dailyFollowupCap: 0,
      hourlyFollowupCap: 0,
      minSafeIntervalSec: 300,
      symbioticEveryN: 2,
      zeroReplyThreshold: 8,
      reason: "insufficient_active_days",
    };
  }
  if (healthScore < 40) {
    return {
      allowed: false,
      dailyColdCap: 0,
      hourlyColdCap: 0,
      dailyFollowupCap: 0,
      hourlyFollowupCap: 0,
      minSafeIntervalSec: 300,
      symbioticEveryN: 2,
      zeroReplyThreshold: 8,
      reason: "low_health",
    };
  }

  let policy: ColdOutreachPolicy;
  if (opts?.daysActive !== undefined) {
    // Paridade estrita com computeChipReadinessSummary (warmup-engine.ts) e computeChipColdReadiness (types.ts):
    // Dia 7–10 = 15/dia · Dia 11–14 (Fase 3+) = 30/dia · Dia 15–20 (Fase 4+) = 50/dia · Dia 21+ & saúde >= 90 = 80/dia
    if (normalizedStage >= 4 && opts.daysActive >= 21 && healthScore >= 90) {
      policy = {
        allowed: true,
        dailyColdCap: 80,
        hourlyColdCap: 14,
        dailyFollowupCap: 40,
        hourlyFollowupCap: 10,
        minSafeIntervalSec: 45,
        symbioticEveryN: 4,
        zeroReplyThreshold: 14,
        veteranTier: true,
      };
    } else if (normalizedStage >= 4 && opts.daysActive >= 15) {
      policy = {
        allowed: true,
        dailyColdCap: 50,
        hourlyColdCap: 10,
        dailyFollowupCap: 35,
        hourlyFollowupCap: 8,
        minSafeIntervalSec: 55,
        symbioticEveryN: 4,
        zeroReplyThreshold: 12,
      };
    } else if (normalizedStage >= 3 && opts.daysActive >= 11) {
      policy = {
        allowed: true,
        dailyColdCap: 30,
        hourlyColdCap: 6,
        dailyFollowupCap: 25,
        hourlyFollowupCap: 6,
        minSafeIntervalSec: 75,
        symbioticEveryN: 3,
        zeroReplyThreshold: 10,
      };
    } else {
      policy = {
        allowed: true,
        dailyColdCap: 15,
        hourlyColdCap: 4,
        dailyFollowupCap: 15,
        hourlyFollowupCap: 4,
        minSafeIntervalSec: 120,
        symbioticEveryN: 3,
        zeroReplyThreshold: 8,
      };
    }
  } else if (normalizedStage === 2) {
    policy = {
      allowed: true,
      dailyColdCap: 15,
      hourlyColdCap: 4,
      dailyFollowupCap: 15,
      hourlyFollowupCap: 4,
      minSafeIntervalSec: 120,
      symbioticEveryN: 3,
      zeroReplyThreshold: 8,
    };
  } else if (normalizedStage === 3) {
    policy = {
      allowed: true,
      dailyColdCap: 30,
      hourlyColdCap: 6,
      dailyFollowupCap: 25,
      hourlyFollowupCap: 6,
      minSafeIntervalSec: 75,
      symbioticEveryN: 3,
      zeroReplyThreshold: 10,
    };
  } else {
    // Stage 4A padrão quando daysActive não foi informado
    policy = {
      allowed: true,
      dailyColdCap: 50,
      hourlyColdCap: 10,
      dailyFollowupCap: 35,
      hourlyFollowupCap: 8,
      minSafeIntervalSec: 55,
      symbioticEveryN: 4,
      zeroReplyThreshold: 12,
    };
  }

  // Freio Dinâmico por Saúde: se health_score cair abaixo de 75, corta ritmo pela metade antes da crise
  if (healthScore < 75) {
    return {
      ...policy,
      dailyColdCap: Math.max(2, Math.floor(policy.dailyColdCap / 2)),
      hourlyColdCap: Math.max(1, Math.floor(policy.hourlyColdCap / 2)),
      dailyFollowupCap: Math.max(2, Math.floor(policy.dailyFollowupCap / 2)),
      hourlyFollowupCap: Math.max(1, Math.floor(policy.hourlyFollowupCap / 2)),
      minSafeIntervalSec: policy.minSafeIntervalSec + 60,
      symbioticEveryN: 2,
      zeroReplyThreshold: Math.max(5, policy.zeroReplyThreshold - 2),
      throttledByHealth: true,
    };
  }

  // Escalonamento Adaptativo por Taxa de Resposta (Adaptive Reply-Rate Scaling):
  // - < 5% de resposta recente: reduz ritmo em ~35% e aperta intervalo/freio para proteger reputação.
  // - >= 25% de resposta recente (saúde >= 90, estágio >= 3): bônus seguro de até +15% na cota fria.
  if (
    opts?.recentReplyRate !== undefined &&
    opts.recentReplyRate !== null &&
    Number.isFinite(opts.recentReplyRate)
  ) {
    const rate = Math.max(0, Math.min(1, Number(opts.recentReplyRate)));
    if (rate < 0.05) {
      return {
        ...policy,
        dailyColdCap: Math.max(3, Math.floor(policy.dailyColdCap * 0.65)),
        hourlyColdCap: Math.max(1, Math.floor(policy.hourlyColdCap * 0.7)),
        dailyFollowupCap: Math.max(3, Math.floor(policy.dailyFollowupCap * 0.7)),
        hourlyFollowupCap: Math.max(1, Math.floor(policy.hourlyFollowupCap * 0.75)),
        minSafeIntervalSec: policy.minSafeIntervalSec + 30,
        symbioticEveryN: Math.min(policy.symbioticEveryN, 2),
        zeroReplyThreshold: Math.max(6, policy.zeroReplyThreshold - 2),
        throttledByReplyRate: true,
      };
    }
    if (rate >= 0.25 && healthScore >= 90 && normalizedStage >= 3) {
      return {
        ...policy,
        dailyColdCap: Math.round(policy.dailyColdCap * 1.15),
        hourlyColdCap: Math.min(16, policy.hourlyColdCap + 2),
        boostedByReplyRate: true,
      };
    }
  }

  return policy;
}

export const STAGE_COMBINED_DAILY_CAP: Record<number, number> = { 1: 0, 2: 35, 3: 65, 4: 115 };

export { evaluateWeekendB2BGuard, type WeekendB2BGuardResult };

type ColdBatchState = {
  countInBatch: number;
  batchLimit: number;
  sendsSincePulse: number;
};

const _coldSendTimestampsByInstance = new Map<string, number[]>();
const _followupSendTimestampsByInstance = new Map<string, number[]>();
const _coldBatchStateByInstance = new Map<string, ColdBatchState>();
const _verifiedCanonicalJids = new Map<string, { jid: string; exists: boolean; verifiedAt: number }>();
const _hydratedColdQuotaTenants = new Set<string>();
const _hydratedExtraAntiBanTenants = new Set<string>();
const _coldQuotaClientInstances = new Map<string, Set<string>>();
const _recentColdJidsByInstance = new Map<string, Array<{ jid: string; sentAt: number }>>();
const _zeroReplyBrakeUntil = new Map<string, number>();
const _zeroReplyClientInstances = new Map<string, Set<string>>();
const _recentReplyRateByInstance = new Map<
  string,
  { rate: number; repliedCount: number; sampleSize: number; updatedAt: number }
>();
const CANONICAL_JID_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REPLY_RATE_TELEMETRY_TTL_MS = 6 * 60 * 60 * 1000;
const ZERO_REPLY_BATCH_THRESHOLD = 12;
const MAX_ZERO_REPLY_TRACKED = 20;
const ZERO_REPLY_BRAKE_MS = 25 * 60 * 1000;
const MAX_COMBINED_HOURLY_PER_CHIP = 20;

export function getStartOfBrtDayMs(nowMs = Date.now()): number {
  const spDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const parsed = Date.parse(`${spDay}T00:00:00-03:00`);
  return Number.isFinite(parsed) ? parsed : nowMs - 24 * 60 * 60 * 1000;
}

export function __resetCampaignAntiBanStateForTests(): void {
  _coldSendTimestampsByInstance.clear();
  _followupSendTimestampsByInstance.clear();
  _coldBatchStateByInstance.clear();
  _verifiedCanonicalJids.clear();
  _hydratedColdQuotaTenants.clear();
  _hydratedExtraAntiBanTenants.clear();
  _coldQuotaClientInstances.clear();
  _recentColdJidsByInstance.clear();
  _zeroReplyBrakeUntil.clear();
  _zeroReplyClientInstances.clear();
  _recentReplyRateByInstance.clear();
  _lastSelectedInstanceByCampaign.clear();
}

export function clearZeroReplyBrakeForInstance(instanceName: string): void {
  if (!instanceName) return;
  _zeroReplyBrakeUntil.delete(instanceName);
  _recentColdJidsByInstance.delete(instanceName);
  _recentReplyRateByInstance.delete(instanceName);
}

export function getRecentReplyRateForInstance(
  instanceName: string,
  nowMs = Date.now()
): { rate: number; repliedCount: number; sampleSize: number } | null {
  if (!instanceName) return null;
  const hit = _recentReplyRateByInstance.get(instanceName);
  if (!hit) return null;
  if (nowMs - hit.updatedAt > REPLY_RATE_TELEMETRY_TTL_MS) {
    _recentReplyRateByInstance.delete(instanceName);
    return null;
  }
  return { rate: hit.rate, repliedCount: hit.repliedCount, sampleSize: hit.sampleSize };
}

function buildJidLookupVariants(remoteJid: string): string[] {
  const clean = String(remoteJid || "").trim();
  const variants = new Set<string>();
  if (clean) variants.add(clean);
  if (clean && !clean.includes("@g.us") && !clean.includes("@lid")) {
    for (const digits of getBrazilPhoneVariants(clean)) {
      variants.add(digits);
      variants.add(`${digits}@s.whatsapp.net`);
    }
  }
  return Array.from(variants);
}

async function hydrateZeroReplyAndMixerIfNeeded(clientId: string, nowMs = Date.now()): Promise<void> {
  if (
    !clientId ||
    _hydratedExtraAntiBanTenants.has(clientId) ||
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return;
  }
  _hydratedExtraAntiBanTenants.add(clientId);

  try {
    const { data: rows } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", [`zero_reply_state_${clientId}`, `antiban_mixer_${clientId}`]);

    for (const row of rows || []) {
      if (!row?.value) continue;
      if (row.key === `zero_reply_state_${clientId}`) {
        const parsed = JSON.parse(String(row.value)) as {
          recent?: Record<string, string[]>;
          brakeUntil?: Record<string, number>;
        };
        const instSet = _zeroReplyClientInstances.get(clientId) || new Set<string>();
        if (parsed.recent && typeof parsed.recent === "object") {
          for (const [inst, list] of Object.entries(parsed.recent)) {
            if (!Array.isArray(list)) continue;
            instSet.add(inst);
            if (!_recentColdJidsByInstance.has(inst)) {
              const normalized = (list as Array<string | { jid?: string; sentAt?: number }>)
                .map((item) =>
                  typeof item === "string"
                    ? { jid: item, sentAt: nowMs }
                    : item && typeof item.jid === "string"
                      ? { jid: item.jid, sentAt: Number.isFinite(item.sentAt) ? Number(item.sentAt) : nowMs }
                      : null
                )
                .filter((x): x is { jid: string; sentAt: number } => Boolean(x?.jid))
                .slice(-MAX_ZERO_REPLY_TRACKED);
              _recentColdJidsByInstance.set(inst, normalized);
            }
          }
        }
        if (parsed.brakeUntil && typeof parsed.brakeUntil === "object") {
          for (const [inst, until] of Object.entries(parsed.brakeUntil)) {
            instSet.add(inst);
            if (Number.isFinite(until) && until > nowMs) {
              _zeroReplyBrakeUntil.set(inst, until);
            }
          }
        }
        _zeroReplyClientInstances.set(clientId, instSet);
      } else if (row.key === `antiban_mixer_${clientId}`) {
        const parsed = JSON.parse(String(row.value)) as Record<string, number[]>;
        seedAntiBanHistory(parsed);
      }
    }
  } catch {
    /* persistência em app_settings é best-effort */
  }
}

function persistZeroReplyStateAsync(clientId: string, instanceName: string, nowMs = Date.now()): void {
  if (!clientId || process.env.VITEST === "true" || process.env.NODE_ENV === "test") return;

  const instSet = _zeroReplyClientInstances.get(clientId) || new Set<string>();
  instSet.add(instanceName);
  _zeroReplyClientInstances.set(clientId, instSet);

  const recent: Record<string, Array<{ jid: string; sentAt: number }>> = {};
  const brakeUntil: Record<string, number> = {};
  for (const inst of instSet) {
    const jids = _recentColdJidsByInstance.get(inst);
    if (jids && jids.length > 0) recent[inst] = jids.slice(-MAX_ZERO_REPLY_TRACKED);
    const until = _zeroReplyBrakeUntil.get(inst) || 0;
    if (until > nowMs) brakeUntil[inst] = until;
  }

  supabase
    .from("app_settings")
    .upsert(
      {
        key: `zero_reply_state_${clientId}`,
        value: JSON.stringify({ recent, brakeUntil }),
        updated_at: new Date(nowMs).toISOString(),
      },
      { onConflict: "key" }
    )
    .then(() => {}, () => {});
}

function persistAntiBanMixerAsync(clientId: string): void {
  if (!clientId || process.env.VITEST === "true" || process.env.NODE_ENV === "test") return;
  const snapshot = exportAntiBanHistory();
  supabase
    .from("app_settings")
    .upsert(
      {
        key: `antiban_mixer_${clientId}`,
        value: JSON.stringify(snapshot),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    )
    .then(() => {}, () => {});
}

/**
 * Auditoria de "Vácuo Silencioso" (Zero-Reply Brake) + Telemetria de Taxa de Resposta:
 * Acompanha os últimos N contatos frios abordados pelo chip (conforme estágio: 8/10/12/14).
 * - Filtra outbound no banco (exclui `sender_type` ai/human/system) e valida timestamp contra
 *   o início do lote para que chunks outbound nem respostas antigas mascarem o vácuo real.
 * - Se nenhum respondeu (0 de N), ativa descanso preventivo de 25 min.
 * - Atualiza a taxa de resposta recente (`replyRate`) para escalonamento adaptativo de ritmo.
 */
export async function checkZeroReplyBrakeForInstance(
  clientId: string,
  instanceName: string,
  sentRemoteJid: string,
  nowMs = Date.now(),
  threshold = ZERO_REPLY_BATCH_THRESHOLD
): Promise<{ brakeTriggered: boolean; checkedCount: number; threshold: number; replyRate: number | null }> {
  await hydrateZeroReplyAndMixerIfNeeded(clientId, nowMs);

  const effectiveThreshold = Math.max(4, Math.min(MAX_ZERO_REPLY_TRACKED, Math.floor(Number(threshold) || ZERO_REPLY_BATCH_THRESHOLD)));
  const entries = _recentColdJidsByInstance.get(instanceName) || [];
  if (sentRemoteJid && !entries.some((e) => e.jid === sentRemoteJid)) {
    entries.push({ jid: sentRemoteJid, sentAt: nowMs });
  }
  _recentColdJidsByInstance.set(instanceName, entries);

  if (entries.length < effectiveThreshold) {
    persistZeroReplyStateAsync(clientId, instanceName, nowMs);
    return { brakeTriggered: false, checkedCount: entries.length, threshold: effectiveThreshold, replyRate: null };
  }

  const batch = entries.splice(0, entries.length);
  _recentColdJidsByInstance.set(instanceName, []);
  const minSentAtMs = batch.reduce((min, item) => Math.min(min, item.sentAt), nowMs);
  const replyCutoffMs = minSentAtMs - 60_000; // 60s tolerância de clock skew
  const variantToTargetIdx = new Map<string, number>();
  batch.forEach((entry, idx) => {
    for (const v of buildJidLookupVariants(entry.jid)) {
      variantToTargetIdx.set(v, idx);
    }
  });
  const expandedBatch = Array.from(variantToTargetIdx.keys());

  try {
    let { data, error } = await supabase
      .from("chats_dashboard")
      .select("id, remote_jid, sender_type, is_from_me, created_at")
      .eq("client_id", clientId)
      .in("remote_jid", expandedBatch)
      .neq("sender_type", "ai")
      .neq("sender_type", "human")
      .neq("sender_type", "system")
      .limit(200);

    if (error && /is_from_me|column/i.test(String(error.message || ""))) {
      const retry = await supabase
        .from("chats_dashboard")
        .select("id, remote_jid, sender_type, created_at")
        .eq("client_id", clientId)
        .in("remote_jid", expandedBatch)
        .neq("sender_type", "ai")
        .neq("sender_type", "human")
        .neq("sender_type", "system")
        .limit(200);
      data = retry.data as any;
      error = retry.error;
    }

    if (error) {
      persistZeroReplyStateAsync(clientId, instanceName, nowMs);
      return { brakeTriggered: false, checkedCount: batch.length, threshold: effectiveThreshold, replyRate: null };
    }

    const inboundRows = Array.isArray(data)
      ? data.filter((row) => {
          if (!isChatRowInbound(row as any)) return false;
          const createdAt = (row as { created_at?: string | null }).created_at;
          if (createdAt) {
            const ts = new Date(createdAt).getTime();
            if (Number.isFinite(ts) && ts < replyCutoffMs) return false;
          }
          return true;
        })
      : [];
    if (inboundRows.length > 0) {
      const repliedIndices = new Set<number>();
      for (const row of inboundRows) {
        const rjid = String((row as { remote_jid?: string }).remote_jid || "");
        const mappedIdx = variantToTargetIdx.get(rjid);
        if (mappedIdx !== undefined) {
          repliedIndices.add(mappedIdx);
        }
      }
      const repliedCount = Math.max(1, repliedIndices.size);
      const replyRate = Math.min(1, repliedCount / batch.length);
      _recentReplyRateByInstance.set(instanceName, {
        rate: replyRate,
        repliedCount,
        sampleSize: batch.length,
        updatedAt: nowMs,
      });
      persistZeroReplyStateAsync(clientId, instanceName, nowMs);
      return { brakeTriggered: false, checkedCount: batch.length, threshold: effectiveThreshold, replyRate };
    }

    _recentReplyRateByInstance.set(instanceName, {
      rate: 0,
      repliedCount: 0,
      sampleSize: batch.length,
      updatedAt: nowMs,
    });
    _zeroReplyBrakeUntil.set(instanceName, nowMs + ZERO_REPLY_BRAKE_MS);
    persistZeroReplyStateAsync(clientId, instanceName, nowMs);
    return { brakeTriggered: true, checkedCount: batch.length, threshold: effectiveThreshold, replyRate: 0 };
  } catch {
    persistZeroReplyStateAsync(clientId, instanceName, nowMs);
    return { brakeTriggered: false, checkedCount: batch.length, threshold: effectiveThreshold, replyRate: null };
  }
}

async function hydrateColdSendCountsIfNeeded(clientId: string, nowMs = Date.now()): Promise<void> {
  if (!clientId || _hydratedColdQuotaTenants.has(clientId)) return;
  _hydratedColdQuotaTenants.add(clientId);

  try {
    const startOfDayMs = getStartOfBrtDayMs(nowMs);
    const pruneCutoff = Math.min(startOfDayMs, nowMs - 60 * 60 * 1000);
    const instSet = _coldQuotaClientInstances.get(clientId) || new Set<string>();

    const hydrateIntoMap = (raw: string | undefined | null, targetMap: Map<string, number[]>) => {
      if (!raw) return;
      const parsed = JSON.parse(String(raw)) as Record<string, number[]>;
      if (!parsed || typeof parsed !== "object") return;
      for (const [inst, timestamps] of Object.entries(parsed)) {
        if (!Array.isArray(timestamps)) continue;
        instSet.add(inst);
        const existing = targetMap.get(inst) || [];
        const merged = [...existing, ...timestamps]
          .filter((ts) => Number.isFinite(ts) && ts >= pruneCutoff)
          .sort((a, b) => a - b);
        targetMap.set(inst, merged);
      }
    };

    const { data: coldRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", `cold_sends_${clientId}`)
      .maybeSingle();
    hydrateIntoMap(coldRow?.value, _coldSendTimestampsByInstance);

    const { data: fuRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", `followup_sends_${clientId}`)
      .maybeSingle();
    hydrateIntoMap(fuRow?.value, _followupSendTimestampsByInstance);

    _coldQuotaClientInstances.set(clientId, instSet);
  } catch {
    /* persistência em app_settings é best-effort */
  }
}

function persistColdSendCountsAsync(clientId: string, instanceName: string, nowMs = Date.now()): void {
  if (!clientId || process.env.VITEST === "true" || process.env.NODE_ENV === "test") return;

  const instSet = _coldQuotaClientInstances.get(clientId) || new Set<string>();
  instSet.add(instanceName);
  _coldQuotaClientInstances.set(clientId, instSet);

  const pruneCutoff = Math.min(getStartOfBrtDayMs(nowMs), nowMs - 60 * 60 * 1000);
  const snapshot: Record<string, number[]> = {};
  for (const inst of instSet) {
    const valid = (_coldSendTimestampsByInstance.get(inst) || []).filter((ts) => ts >= pruneCutoff);
    if (valid.length > 0) snapshot[inst] = valid.slice(-140);
  }

  supabase
    .from("app_settings")
    .upsert(
      {
        key: `cold_sends_${clientId}`,
        value: JSON.stringify(snapshot),
        updated_at: new Date(nowMs).toISOString(),
      },
      { onConflict: "key" }
    )
    .then(() => {}, () => {});
}

function persistFollowupSendCountsAsync(clientId: string, instanceName: string, nowMs = Date.now()): void {
  if (!clientId || process.env.VITEST === "true" || process.env.NODE_ENV === "test") return;

  const instSet = _coldQuotaClientInstances.get(clientId) || new Set<string>();
  instSet.add(instanceName);
  _coldQuotaClientInstances.set(clientId, instSet);

  const pruneCutoff = Math.min(getStartOfBrtDayMs(nowMs), nowMs - 60 * 60 * 1000);
  const snapshot: Record<string, number[]> = {};
  for (const inst of instSet) {
    const valid = (_followupSendTimestampsByInstance.get(inst) || []).filter((ts) => ts >= pruneCutoff);
    if (valid.length > 0) snapshot[inst] = valid.slice(-140);
  }

  supabase
    .from("app_settings")
    .upsert(
      {
        key: `followup_sends_${clientId}`,
        value: JSON.stringify(snapshot),
        updated_at: new Date(nowMs).toISOString(),
      },
      { onConflict: "key" }
    )
    .then(() => {}, () => {});
}

function randomBatchLimit(): number {
  return 6 + Math.floor(Math.random() * 5); // 6 a 10 disparos por lote antes do Coffee-Break
}

export function getColdSendCounts(
  instanceName: string,
  nowMs = Date.now()
): { hourlyCount: number; dailyCount: number } {
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const startOfDayMs = getStartOfBrtDayMs(nowMs);
  const pruneCutoff = Math.min(startOfDayMs, oneHourAgo);
  const list = (_coldSendTimestampsByInstance.get(instanceName) || []).filter((ts) => ts >= pruneCutoff);
  _coldSendTimestampsByInstance.set(instanceName, list);
  const hourlyCount = list.filter((ts) => ts > oneHourAgo).length;
  const dailyCount = list.filter((ts) => ts >= startOfDayMs).length;
  return { hourlyCount, dailyCount };
}

export function getFollowupSendCounts(
  instanceName: string,
  nowMs = Date.now()
): { hourlyCount: number; dailyCount: number } {
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const startOfDayMs = getStartOfBrtDayMs(nowMs);
  const pruneCutoff = Math.min(startOfDayMs, oneHourAgo);
  const list = (_followupSendTimestampsByInstance.get(instanceName) || []).filter((ts) => ts >= pruneCutoff);
  _followupSendTimestampsByInstance.set(instanceName, list);
  const hourlyCount = list.filter((ts) => ts > oneHourAgo).length;
  const dailyCount = list.filter((ts) => ts >= startOfDayMs).length;
  return { hourlyCount, dailyCount };
}

export function recordFollowupOutreachSend(
  instanceName: string,
  nowMs = Date.now(),
  clientId?: string
): { hourlyCount: number; dailyCount: number } {
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const startOfDayMs = getStartOfBrtDayMs(nowMs);
  const pruneCutoff = Math.min(startOfDayMs, oneHourAgo);
  const list = (_followupSendTimestampsByInstance.get(instanceName) || []).filter((ts) => ts >= pruneCutoff);
  list.push(nowMs);
  _followupSendTimestampsByInstance.set(instanceName, list);

  if (clientId) {
    persistFollowupSendCountsAsync(clientId, instanceName, nowMs);
  }
  return {
    hourlyCount: list.filter((ts) => ts > oneHourAgo).length,
    dailyCount: list.filter((ts) => ts >= startOfDayMs).length,
  };
}

/**
 * Freio Diário de Capacidade de Prévias (Método Mentor):
 * pausa o disparo frio assim que a equipe atinge a cota máxima diária de prévias aceitas/agendadas,
 * impedindo acúmulo de promessas que o operador não conseguirá produzir no mesmo ciclo.
 */
export async function checkDailyPreviewCapacityBrake(
  clientId: string,
  maxDailyPreviews: number,
  now: Date = new Date()
): Promise<{ blocked: boolean; todayCount: number; limit: number; reason?: string }> {
  const limit = Math.max(0, Math.floor(Number(maxDailyPreviews) || 0));
  if (!clientId || limit <= 0) {
    return { blocked: false, todayCount: 0, limit };
  }

  const spDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const startOfDayIso = new Date(`${spDay}T00:00:00-03:00`).toISOString();

  let contactsCount = 0;
  let leadsCount = 0;
  let queuedCount = 0;

  try {
    const { data: cRows } = await supabase
      .from("contacts")
      .select("id")
      .eq("client_id", clientId)
      .gte("preview_accepted_at", startOfDayIso);
    if (Array.isArray(cRows)) contactsCount = cRows.length;
  } catch { /* col opcional sem 031 */ }

  try {
    const { data: lRows } = await supabase
      .from("leads_extraidos")
      .select("id")
      .eq("client_id", clientId)
      .gte("previa_solicitada_em", startOfDayIso);
    if (Array.isArray(lRows)) leadsCount = lRows.length;
  } catch { /* opcional */ }

  try {
    const { data: qRows } = await supabase
      .from("scheduled_preview_deliveries")
      .select("id, status")
      .eq("client_id", clientId)
      .gte("created_at", startOfDayIso);
    if (Array.isArray(qRows)) {
      queuedCount = qRows.filter((r) => (r as { status?: string }).status !== "cancelled").length;
    }
  } catch { /* opcional */ }

  const todayCount = Math.max(contactsCount, leadsCount, queuedCount);
  if (todayCount >= limit) {
    return {
      blocked: true,
      todayCount,
      limit,
      reason: "daily_preview_capacity_reached",
    };
  }
  return { blocked: false, todayCount, limit };
}

export function recordColdOutreachSend(
  instanceName: string,
  nowMs = Date.now(),
  clientId?: string
): ColdBatchState {
  const pruneCutoff = Math.min(getStartOfBrtDayMs(nowMs), nowMs - 60 * 60 * 1000);
  const list = (_coldSendTimestampsByInstance.get(instanceName) || []).filter((ts) => ts >= pruneCutoff);
  list.push(nowMs);
  _coldSendTimestampsByInstance.set(instanceName, list);

  if (clientId) {
    persistColdSendCountsAsync(clientId, instanceName, nowMs);
  }

  const prev = _coldBatchStateByInstance.get(instanceName) || {
    countInBatch: 0,
    batchLimit: randomBatchLimit(),
    sendsSincePulse: 0,
  };
  const next: ColdBatchState = {
    countInBatch: prev.countInBatch + 1,
    batchLimit: prev.batchLimit,
    sendsSincePulse: prev.sendsSincePulse + 1,
  };
  _coldBatchStateByInstance.set(instanceName, next);
  return next;
}

export function markSymbioticPulseTriggered(instanceName: string): void {
  const prev = _coldBatchStateByInstance.get(instanceName);
  if (prev) {
    prev.sendsSincePulse = 0;
    _coldBatchStateByInstance.set(instanceName, prev);
  }
}

export function cacheVerifiedCanonicalJid(
  instanceName: string,
  phoneDigits: string,
  entry: { exists: boolean; jid?: string | null },
  nowMs = Date.now()
): void {
  const clean = String(phoneDigits || "").replace(/\D/g, "");
  if (!clean) return;
  const jid = entry.jid || `${clean}@s.whatsapp.net`;
  _verifiedCanonicalJids.set(`${instanceName}:${clean}`, {
    jid,
    exists: entry.exists !== false,
    verifiedAt: nowMs,
  });
  _verifiedCanonicalJids.set(`*:${clean}`, {
    jid,
    exists: entry.exists !== false,
    verifiedAt: nowMs,
  });
}

export function getCachedCanonicalJid(
  instanceName: string,
  phoneDigits: string,
  nowMs = Date.now()
): { jid: string; exists: boolean } | null {
  const clean = String(phoneDigits || "").replace(/\D/g, "");
  if (!clean) return null;
  const hit =
    _verifiedCanonicalJids.get(`${instanceName}:${clean}`) ||
    _verifiedCanonicalJids.get(`*:${clean}`);
  if (!hit) return null;
  if (nowMs - hit.verifiedAt > CANONICAL_JID_CACHE_TTL_MS) {
    _verifiedCanonicalJids.delete(`${instanceName}:${clean}`);
    return null;
  }
  return { jid: hit.jid, exists: hit.exists };
}

/**
 * Delay humano (3.5s a 7.5s) entre uma consulta `onWhatsApp` (USyncQuery) ao vivo
 * e o início do `composing` ("digitando..."), eliminando a assinatura robótica de
 * consultar existência e disparar no mesmo segundo.
 */
export function calculatePreSendProfilePauseMs(): number {
  return 3500 + Math.floor(Math.random() * 4001);
}

/**
 * Calcula o delay até o próximo disparo frio da campanha:
 * - Respeita o piso seguro do estágio do chip (`stageMinIntervalSec`).
 * - A cada lote de 6 a 10 disparos (`batchLimit`), aplica automaticamente um
 *   Coffee-Break humano de 12 a 22 minutos para quebrar a distribuição uniforme.
 */
export function computeCampaignNextDelayMs(params: {
  instanceName: string;
  minIntervalSec: number;
  maxIntervalSec: number;
  stageMinIntervalSec?: number;
  /** Desliga o Coffee-Break de lote (Proteção Anti-Ban desativada na campanha). */
  bypassBatchBreak?: boolean;
}): { delayMs: number; isCoffeeBreak: boolean; batchCount: number } {
  const effectiveMin = Math.max(
    5,
    Number(params.minIntervalSec) || 30,
    Number(params.stageMinIntervalSec) || 0
  );
  const effectiveMax = Math.max(effectiveMin + 15, Number(params.maxIntervalSec) || 60);

  if (params.bypassBatchBreak) {
    return { delayMs: jitterMs(effectiveMin, effectiveMax), isCoffeeBreak: false, batchCount: 0 };
  }

  const state = _coldBatchStateByInstance.get(params.instanceName);
  if (state && state.countInBatch >= state.batchLimit) {
    const completedCount = state.countInBatch;
    state.countInBatch = 0;
    state.batchLimit = randomBatchLimit();
    _coldBatchStateByInstance.set(params.instanceName, state);

    // Pausa longa de 12 a 22 minutos (720s a 1320s)
    const coffeeBreakMs = (720 + Math.floor(Math.random() * 601)) * 1000;
    return {
      delayMs: coffeeBreakMs,
      isCoffeeBreak: true,
      batchCount: completedCount,
    };
  }

  return {
    delayMs: jitterMs(effectiveMin, effectiveMax),
    isCoffeeBreak: false,
    batchCount: state?.countInBatch || 0,
  };
}


type CampaignRow = {
  id: string;
  client_id: string;
  name: string;
  instance_name: string;
  agent_id: number | null;
  message_template: string;
  min_interval_seconds: number;
  max_interval_seconds: number;
  allowed_start_hour: number;
  allowed_end_hour: number;
  status: string;
  personalize_with_ai?: boolean;
  use_web_search?: boolean;
  ai_model?: string | null;
  ai_prompt?: string | null;
  humanize_messages?: boolean;
  media_url?: string | null;
  media_type?: string | null;
  media_caption?: string | null;
  media_file_name?: string | null;
  media_mimetype?: string | null;
};

// Estado in-memory: campanhas em execução com timer ativo
const runningTimers = new Map<string, NodeJS.Timeout>();
const consecutiveFailures = new Map<string, number>();

// Cacheia se a tabela existe, pra não martelar o banco com erros 42P01 em loop.
let campaignLogsAvailable: boolean | null = null;
const campaignClientIdCache = new Map<string, string>();

async function resolveCampaignClientId(campaignId: string): Promise<string | null> {
  const cached = campaignClientIdCache.get(campaignId);
  if (cached) return cached;
  try {
    const { data } = await supabase
      .from("campaigns")
      .select("client_id")
      .eq("id", campaignId)
      .maybeSingle();
    const cid = (data as { client_id?: string } | null)?.client_id || null;
    if (cid) {
      if (campaignClientIdCache.size > 500) campaignClientIdCache.clear();
      campaignClientIdCache.set(campaignId, cid);
    }
    return cid;
  } catch {
    return null;
  }
}

const CAMPAIGN_WARNING_COOLDOWN_MS = 30 * 60 * 1000;
const _lastCampaignWarningMap = new Map<string, { at: number; message: string }>();

export function resetCampaignWarningThrottleForTests(): void {
  _lastCampaignWarningMap.clear();
}

/**
 * Evita flood de `CAMPAIGN_WARNING` idênticos em `webhook_logs` / `campaign_logs`:
 * suprime mensagens idênticas da mesma campanha/motivo dentro de 30 min.
 */
export function shouldEmitCampaignWarning(
  campaignId: string | number,
  reasonKey: string,
  message: string,
  nowMs = Date.now(),
): boolean {
  const key = `${campaignId}:${reasonKey}`;
  const prev = _lastCampaignWarningMap.get(key);
  if (prev && prev.message === message && nowMs - prev.at < CAMPAIGN_WARNING_COOLDOWN_MS) {
    return false;
  }
  _lastCampaignWarningMap.set(key, { at: nowMs, message });
  return true;
}

async function addCampaignLog(campaignId: string, message: string, level: "info" | "success" | "warning" | "error" = "info") {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[CAMPAIGN_LOG][${timestamp}][${level.toUpperCase()}] Campaign: ${campaignId} | Msg: ${message}`);
  const clientId = await resolveCampaignClientId(campaignId);

  // 1) Fallback SEMPRE-disponível: webhook_logs (tabela que já existe no projeto).
  //    Mesmo se campaign_logs falhar, o usuário tem rastro em algum lugar.
  //    Só gravamos níveis !==info pra não poluir.
  if (level !== "info") {
    supabase.from("webhook_logs").insert({
      ...(clientId ? { client_id: clientId } : {}),
      instance_name: "campaign",
      event: `CAMPAIGN_${level.toUpperCase()}`,
      payload: { campaign_id: campaignId, message, level },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
  }

  // 2) Persistir último erro no próprio campaigns.last_error (garante visibilidade no card)
  if (level === "error") {
    supabase.from("campaigns").update({
      last_error: message.slice(0, 500),
      last_error_at: new Date().toISOString(),
    }).eq("id", campaignId).then(() => {}, () => {});
  }

  // 3) Tabela campaign_logs (detalhes em tempo real pro painel)
  if (campaignLogsAvailable === false) return;

  try {
    const { error } = await supabase.from("campaign_logs").insert({
      ...(clientId ? { client_id: clientId } : {}),
      campaign_id: campaignId,
      message,
      level
    });
    if (error) {
      if ((error as any).code === "42P01") {
        console.warn("[CAMPAIGN_LOG] Tabela campaign_logs não existe. Rode criar_campaign_logs.sql no Supabase. Logs continuarão só no console + webhook_logs.");
        campaignLogsAvailable = false;
      } else {
        console.error("[CAMPAIGN_LOG_DB_ERROR]", error);
      }
    } else {
      campaignLogsAvailable = true;
    }
  } catch (err) {
    console.error("[CAMPAIGN_LOG_FATAL_ERROR]", err);
  }
}

/**
 * Diagnostica PRÉ-envio: falha cedo e claro se Evolution/instância/API estiver capenga.
 * Chamado por startCampaign antes de agendar o primeiro envio.
 */
async function preflightCheck(campaignId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: c } = await supabase.from("campaigns").select("*").eq("id", campaignId).single();
  if (!c) return { ok: false, error: "Campanha não encontrada no banco." };
  if (!c.client_id) return { ok: false, error: "Campanha sem client_id — vincule a campanha a um cliente antes de disparar." };

  // Proteção Anti-Ban desligada nesta campanha? Então o preflight não bloqueia
  // por cota, quarentena ou chip em berçário.
  const coldShieldEnabled = await resolveCampaignColdShield(c);

  // Checa env
  const evoUrl = process.env.EVOLUTION_API_URL || "";
  if (!evoUrl || evoUrl.includes("url_aqui")) {
    return { ok: false, error: "EVOLUTION_API_URL não configurada em .env.local — impossível disparar." };
  }
  if (!process.env.EVOLUTION_API_KEY) {
    return { ok: false, error: "EVOLUTION_API_KEY não configurada em .env.local." };
  }

  // Checa se tem targets pending
  let { count: pendingCount } = await supabase
    .from("campaign_targets")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "pending");

  if (!pendingCount || pendingCount === 0) {
    const { count: totalCount } = await supabase
      .from("campaign_targets")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId);

    if (totalCount && totalCount > 0) {
      await supabase
        .from("campaign_targets")
        .update({ status: "pending", attempts: 0, error_message: null, sent_at: null })
        .eq("campaign_id", campaignId);
      
      await supabase
        .from("campaigns")
        .update({ status: "draft", sent_count: 0, failed_count: 0, skipped_count: 0, last_error: null })
        .eq("id", campaignId);

      pendingCount = totalCount;
    } else {
      return { ok: false, error: "Nenhum target pendente nesta campanha. Selecione leads e crie uma nova campanha." };
    }
  }

  // Checa se a instância existe e está conectada (ou se usa Pool Automático multi-chip)
  if (isAutoPoolInstance(c.instance_name)) {
    const poolCheck = await resolveHealthyCampaignChip(c.client_id, c.instance_name, {
      bypassColdShield: !coldShieldEnabled,
      dryRun: true,
    });
    if (!poolCheck.ok) {
      return {
        ok: false,
        error: `Nenhum chip saudável/maduro disponível no Pool Automático (${poolCheck.reason || "sem chips prontos"}). Aguarde os chips completarem 7 dias de aquecimento (Fase 2+) ou saírem da quarentena.`,
      };
    }
  } else {
    try {
      const ch = await channel.resolveChannel(c.instance_name, { fresh: true });
      if (ch.provider === "whatsapp_cloud") {
        if (!ch.cloud?.access_token || !ch.cloud?.phone_number_id) {
          return { ok: false, error: `Conexão Cloud "${c.instance_name}" sem token/phone_number_id. Configure em /whatsapp.` };
        }
      } else {
        const status = await channel.getStatus(c.instance_name);
        if (status.state === "not_found") {
          return { ok: false, error: `Instância "${c.instance_name}" não existe na Evolution API. Vai em /whatsapp e cria/conecta.` };
        }
        if (status.state !== "open") {
          return { ok: false, error: `Instância "${c.instance_name}" não está conectada (estado: ${status.state}). Escaneia o QR em /whatsapp.` };
        }
      }
    } catch (err: any) {
      return { ok: false, error: `Falha ao consultar canal: ${err.message}.` };
    }

    // Proteção cruzada com Aquecedor de Chips: impede iniciar disparo frio em massa
    // se o chip estiver em quarentena preventiva (Circuit Breaker ativo).
    // Pulado quando a campanha desligou a Proteção Anti-Ban.
    if (coldShieldEnabled) try {
      const { data: warmupCfg } = await supabase
        .from("whatsapp_warmup_configs")
        .select("is_quarantined, quarantine_until, quarantine_reason")
        .eq("client_id", c.client_id)
        .eq("instance_name", c.instance_name)
        .maybeSingle();

      if (
        warmupCfg?.is_quarantined &&
        warmupCfg.quarantine_until &&
        new Date(warmupCfg.quarantine_until) > new Date()
      ) {
        return {
          ok: false,
          error: `O chip "${c.instance_name}" está em quarentena preventiva anti-ban no Aquecedor de Chips (${warmupCfg.quarantine_reason || "múltiplas falhas recentes"}). Aguarde o término da quarentena antes de disparar campanhas.`,
        };
      }
    } catch {
      /* tabela opcional em ambientes antigos */
    }
  }

  // Se personalize_with_ai, precisa de pelo menos UMA chave de IA (Gemini ou
  // OpenRouter). O provedor real é definido pelo modelo escolhido na campanha.
  if (c.personalize_with_ai) {
    const { data: cfg } = await supabase.from("ai_organizer_config").select("api_key, openrouter_api_key").eq("id", 1).maybeSingle();
    const hasAny = !!(cfg?.api_key && String(cfg.api_key).trim())
      || !!((cfg as any)?.openrouter_api_key && String((cfg as any).openrouter_api_key).trim());
    if (!hasAny) {
      return { ok: false, error: "personalize_with_ai ligado mas sem API Key de IA. Configure Gemini ou OpenRouter em /configuracoes." };
    }
  }

  return { ok: true };
}

export function nowHourBRT(): number {
  return Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(new Date())
  );
}

function isWithinAllowedHour(c: CampaignRow): boolean {
  return isWithinHourWindow(c.allowed_start_hour, c.allowed_end_hour);
}

/**
 * Função pura para testabilidade e precisão: verifica se uma hora 'h' (0-23)
 * está dentro da janela configurada.
 *
 * Regras:
 * - Dia inteiro: (0..23 ou 0..24 ou endHour >= 24) → sempre true.
 * - Mesma hora: (10..10) → apenas durante as 10h (10:00 a 10:59).
 * - Janela regular (ex: 8h às 18h): permite de 8:00 até 17:59 (h >= 8 && h < 18).
 *   Às 18:00 encerra o expediente e bloqueia disparos.
 * - Janela invertida (ex: 22h às 6h): permite de 22:00 até 5:59 (h >= 22 || h < 6).
 */
export function isHourInWindow(h: number, startHour: number, endHour: number): boolean {
  if (startHour === 0 && endHour >= 23) return true;
  if (endHour >= 24) return true;
  if (startHour === endHour) return h === startHour;
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}

export function isWithinHourWindow(startHour: number, endHour: number): boolean {
  const h = nowHourBRT();
  return isHourInWindow(h, startHour, endHour);
}

export function jitterMs(min: number, max: number): number {
  const lo = Math.max(5, min);
  const hi = Math.max(lo + 1, max);
  return Math.floor((lo + Math.random() * (hi - lo)) * 1000);
}

function normalizeJid(jid: string): string {
  if (!jid) return jid;
  if (jid.includes("@")) return jid; // já parece um JID
  const digits = jid.replace(/\D/g, "");
  if (!digits) return jid;
  return `${digits}@s.whatsapp.net`;
}

/**
 * @param agentId  Agente que deve "dono" da conversa. Quando vem do disparo
 *                 da automação, é o agente configurado nela — assim, quando o
 *                 lead responder, é esse agente que assume a conversa no /chat.
 *                 Se omitido, cai pro agente da instância (channel_connections).
 */
export async function findOrCreateContactSession(clientId: string, remoteJidRaw: string, instanceName: string, nomeNegocio?: string | null, agentId?: number | null): Promise<{ contactId: string; sessionId: string | null } | null> {
  const remoteJid = normalizeJid(remoteJidRaw);
  const phone = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");

  const { data: chan } = await supabase
    .from("channel_connections")
    .select("agent_id")
    .eq("instance_name", instanceName)
    .eq("client_id", clientId)
    .maybeSingle();

  // 1. contact — race-safe: se o webhook da Evolution criou em paralelo, o
  // INSERT bate em 23505. Re-SELECT pra pegar o id criado pelo outro lado em
  // vez de perder a sessão (esse era o motivo da 1ª msg às vezes não salvar).
  const { data: existingContact } = await supabase
    .from("contacts").select("id, push_name, client_id")
    .eq("client_id", clientId).eq("remote_jid", remoteJid).maybeSingle();
  let contactId = existingContact?.id;

  if (!contactId) {
    const ins = await supabase.from("contacts").insert({
      client_id: clientId,
      remote_jid: remoteJid, phone_number: phone, push_name: nomeNegocio || null,
    }).select("id").single();
    if (ins.data?.id) {
      contactId = ins.data.id;
    } else if ((ins.error as any)?.code === "23505") {
      const retry = await supabase.from("contacts").select("id, push_name")
        .eq("client_id", clientId).eq("remote_jid", remoteJid).maybeSingle();
      contactId = retry.data?.id;

      // Outro processo criou o contato sem nome → preenche com o do negócio.
      if (contactId && nomeNegocio && !retry.data?.push_name) {
        await supabase.from("contacts").update({ push_name: nomeNegocio }).eq("id", contactId).eq("client_id", clientId);
      }
    }
  } else if (nomeNegocio && !existingContact?.push_name) {
    // Contato JÁ existe mas sem nome (ex: criado pelo echo do webhook antes
    // do disparo). Preenche com o nome do negócio captado pela automação —
    // sem isto, a conversa aparece no /chat só como número.
    await supabase.from("contacts").update({ push_name: nomeNegocio }).eq("id", contactId).eq("client_id", clientId);
  }
  if (!contactId) return null;

  // 2. session — mesmo cuidado de race. Se outro worker/webhook criou primeiro,
  // o unique de (contact_id, instance_name) dispara 23505 — recuperamos a
  // sessão existente em vez de devolver sessionId=null.
  const { data: existingSession } = await supabase.from("sessions")
    .select("id, agent_id").eq("contact_id", contactId).eq("instance_name", instanceName).eq("client_id", clientId).maybeSingle();
  if (existingSession?.id) return { contactId, sessionId: existingSession.id };

  // Prioridade do agente: o explícito (config do disparo/automação) →
  // o da instância → o padrão (1). Garante que a IA certa assuma a conversa.
  const sessionAgentId = agentId || chan?.agent_id || 1;
  const ins = await supabase.from("sessions").insert({
    client_id: clientId,
    contact_id: contactId, instance_name: instanceName, agent_id: sessionAgentId, bot_status: "bot_active",
  }).select("id").single();
  let sessionId = ins.data?.id || null;
  if (!sessionId && (ins.error as any)?.code === "23505") {
    const retry = await supabase.from("sessions").select("id")
      .eq("contact_id", contactId).eq("instance_name", instanceName).eq("client_id", clientId).maybeSingle();
    sessionId = retry.data?.id || null;
  }
  return { contactId, sessionId };
}

export async function persistOutgoingMessage(opts: {
  sessionId: string | null;
  remoteJid: string;
  instanceName: string;
  msgId: string;
  text: string;
  clientId?: string | null;
}) {
  // Registra que este envio é automático/AI para que o webhook não auto-pause a IA!
  registerAiSend(opts.msgId);

  const now = new Date().toISOString();
  const remoteJid = normalizeJid(opts.remoteJid);

  // CRÍTICO: resolve o client_id da instância. Sem isto, o INSERT em
  // chats_dashboard ficava com client_id=NULL → o /chat (que filtra por
  // client_id) NÃO mostrava esses disparos. Esse era o motivo dos disparos
  // sumirem da lista de conversas mesmo estando salvos no banco.
  let resolvedClientId: string | null = opts.clientId || null;
  if (!resolvedClientId) {
    try {
      const { data: chConn } = await supabase
        .from("channel_connections")
        .select("client_id")
        .eq("instance_name", opts.instanceName)
        .maybeSingle();
      resolvedClientId = chConn?.client_id || null;
    } catch { /* não-fatal */ }
  }
  if (!resolvedClientId) {
    throw new Error(`client_id ausente para persistir mensagem da instância "${opts.instanceName}"`);
  }

  // V2 messages — upsert por message_id (constraint existente no banco) com fallback
  if (opts.sessionId) {
    try {
      const msgPayload: Record<string, any> = {
        client_id: resolvedClientId,
        session_id: opts.sessionId,
        message_id: opts.msgId,
        sender: "ai",
        content: opts.text,
        media_category: "text",
        delivery_status: "sent",
        created_at: now,
      };
      let { error: msgErr } = await supabase.from("messages").upsert(msgPayload, { onConflict: "message_id" });
      if (msgErr && (msgErr.code === "42P10" || (msgErr.message && msgErr.message.includes("ON CONFLICT")))) {
        const retry = await supabase.from("messages").upsert(msgPayload, { onConflict: "client_id,message_id" });
        msgErr = retry.error;
      }
      if (msgErr && msgErr.code === "23505") {
        await supabase.from("messages").update(msgPayload).eq("message_id", opts.msgId);
      } else if (msgErr) {
        throw msgErr;
      }
      await supabase.from("sessions").update({ last_message_at: now }).eq("id", opts.sessionId);
    } catch (e: any) {
      console.warn("[persist] messages upsert falhou:", e?.message);
    }
  } else {
    // Se não veio sessionId direto, atualiza a session correspondente no banco
    try {
      const digits = remoteJid.replace(/\D/g, "");
      const jids = [remoteJid, `${digits}@s.whatsapp.net`, digits].filter(Boolean);
      const { data: matchedContacts } = await supabase
        .from("contacts")
        .select("id")
        .eq("client_id", resolvedClientId)
        .or(`remote_jid.in.(${jids.map((j) => `"${j}"`).join(",")}),phone_number.in.(${jids.map((j) => `"${j}"`).join(",")})`);
      if (matchedContacts && matchedContacts.length > 0) {
        const cIds = matchedContacts.map((c) => c.id);
        await supabase
          .from("sessions")
          .update({ last_message_at: now })
          .eq("client_id", resolvedClientId)
          .in("contact_id", cIds);
      }
    } catch { /* best-effort */ }
  }

  // chats_dashboard — onde o /chat lê.
  try {
    const dashPayload: Record<string, any> = {
      client_id: resolvedClientId,
      instance_name: opts.instanceName,
      message_id: opts.msgId,
      remote_jid: remoteJid,
      sender_type: "ai",
      content: opts.text,
      status_envio: "sent",
      created_at: now,
    };
    let { error: dashErr } = await supabase
      .from("chats_dashboard")
      .upsert(dashPayload, { onConflict: "message_id" });
    if (dashErr && (dashErr.code === "42P10" || (dashErr.message && dashErr.message.includes("ON CONFLICT")))) {
      const retry = await supabase
        .from("chats_dashboard")
        .upsert(dashPayload, { onConflict: "client_id,message_id" });
      dashErr = retry.error;
    }
    if (dashErr && dashErr.code === "23505") {
      await supabase.from("chats_dashboard").update(dashPayload).eq("message_id", opts.msgId);
    } else if (dashErr) {
      throw dashErr;
    }
  } catch (e: any) {
    console.error("[persist] chats_dashboard error:", e.message);
  }
}
const _lastSelectedInstanceByCampaign = new Map<string, { instanceName: string; stageMinIntervalSec?: number; coldShieldEnabled?: boolean }>();

/**
 * Encerra preventivamente o turno ativo do MMZap Browser antes de disparar via Evolution,
 * garantindo ZERO colisão simultânea (duplo-bot no mesmo número WhatsApp).
 */
async function stopActiveMmzapBeforeSend(clientId: string, instanceName: string): Promise<boolean> {
  if (!clientId || !instanceName) return false;
  try {
    const mod = await import("@/lib/warmup/mmzap-browser-orchestrator");
    if (typeof mod.stopMmzapSessionForChip === "function") {
      const res = await mod.stopMmzapSessionForChip(clientId, instanceName, "campaign_active");
      return Boolean(res?.stopped);
    }
  } catch {
    /* fail-open se worker/orquestrador MMZap não estiver habilitado */
  }
  return false;
}

export async function resolveHealthyCampaignChip(
  clientId: string,
  primaryInstanceName: string,
  nowMsOrOpts: number | {
    targetRemoteJid?: string | null;
    preferredInstanceName?: string | null;
    nowMs?: number;
    hourlyFactor?: number;
    /** Tipo de envio: "cold" (prospecção fria) ou "followup" (cota dedicada dentro do teto combinado). */
    mode?: "cold" | "followup";
    /** Desliga a Proteção Anti-Ban (cotas, berçário, saúde, quarentena e freio de vácuo) só para este envio. */
    bypassColdShield?: boolean;
    /** Somente consulta elegibilidade sem executar handover de parada do MMZap. */
    dryRun?: boolean;
  } = Date.now()
): Promise<{
  ok: boolean;
  instanceName: string;
  rotated: boolean;
  policy: ColdOutreachPolicy | null;
  reason?: string;
  mmzapBrowserStatus?: string | null;
  mmzapHandoverStopped?: boolean;
}> {
  const nowMs =
    typeof nowMsOrOpts === "number" ? nowMsOrOpts : nowMsOrOpts?.nowMs ?? Date.now();
  const targetRemoteJid =
    typeof nowMsOrOpts === "object" ? nowMsOrOpts?.targetRemoteJid : null;
  const preferredInstanceName =
    typeof nowMsOrOpts === "object" ? nowMsOrOpts?.preferredInstanceName || null : null;
  const hourlyFactor =
    typeof nowMsOrOpts === "object" && typeof nowMsOrOpts?.hourlyFactor === "number"
      ? Math.max(0, Math.min(1, nowMsOrOpts.hourlyFactor))
      : 1;
  const outreachMode: "cold" | "followup" =
    typeof nowMsOrOpts === "object" && nowMsOrOpts?.mode === "followup" ? "followup" : "cold";
  const bypassColdShield =
    typeof nowMsOrOpts === "object" ? Boolean(nowMsOrOpts?.bypassColdShield) : false;
  const dryRun =
    typeof nowMsOrOpts === "object" ? Boolean(nowMsOrOpts?.dryRun) : false;
  const targetDdd = extractBrazilDdd(targetRemoteJid);

  try {
    await Promise.all([
      hydrateColdSendCountsIfNeeded(clientId, nowMs),
      hydrateZeroReplyAndMixerIfNeeded(clientId, nowMs),
    ]);

    let { data: warmupRows, error } = await supabase
      .from("whatsapp_warmup_configs")
      .select("instance_name, phone_number, enabled, stage, days_active, health_score, is_quarantined, quarantine_until, purpose, sent_today, career_mode, cold_outreach_locked_until, mmzap_browser_status, external_warmup_mode")
      .eq("client_id", clientId);

    if (
      error &&
      (String(error.code || "") === "42703" ||
        String(error.code || "") === "PGRST204" ||
        /column/i.test(String(error.message || "")))
    ) {
      const legacyRes = await supabase
        .from("whatsapp_warmup_configs")
        .select("instance_name, phone_number, enabled, stage, health_score, is_quarantined, quarantine_until, purpose, sent_today")
        .eq("client_id", clientId);
      warmupRows = legacyRes.data as typeof warmupRows;
      error = legacyRes.error;
    }

    const { data: connRows } = await supabase
      .from("channel_connections")
      .select("instance_name, status, provider_config")
      .eq("client_id", clientId);

    const openConns: string[] = [];
    const openSet = new Set<string>();
    const connPhoneByInstance = new Map<string, string>();
    if (Array.isArray(connRows)) {
      for (const r of connRows) {
        const inst = String((r as any)?.instance_name || "");
        const st = String((r as any)?.status || "").toLowerCase();
        if (st === "open" || st === "connected" || st === "online") {
          openSet.add(inst);
          if (inst) openConns.push(inst);
        }
        const pCfg = (r as any)?.provider_config;
        const owner = pCfg?.owner_phone || pCfg?.owner_jid;
        if (inst && owner) connPhoneByInstance.set(inst, String(owner));
      }
    }

    if (error || !Array.isArray(warmupRows) || warmupRows.length === 0) {
      if (isAutoPoolInstance(primaryInstanceName)) {
        if (openConns.length > 0) {
          return { ok: true, instanceName: openConns[0], rotated: true, policy: null, reason: "auto_pool" };
        }
        return { ok: false, instanceName: "", rotated: false, policy: null, reason: "no_connected_pool_chip" };
      }
      return { ok: true, instanceName: primaryInstanceName, rotated: false, policy: null };
    }

    const isChipEligible = (row: any): { eligible: boolean; policy: ColdOutreachPolicy; hourlyCount: number; dailyCount: number; ddd: string | null; reason?: string } => {
      const inst = String(row.instance_name || "");
      const isQuarantined =
        Boolean(row.is_quarantined) &&
        Boolean(row.quarantine_until) &&
        new Date(String(row.quarantine_until)).getTime() > nowMs;
      const zeroReplyUntil = _zeroReplyBrakeUntil.get(inst) || 0;
      const normalizedStage = Math.max(1, Math.min(4, Math.floor(Number(row.stage || 1))));
      const parsedDaysActive =
        row.days_active !== undefined && row.days_active !== null && Number.isFinite(Number(row.days_active))
          ? Number(row.days_active)
          : undefined;
      const replyTelemetry = getRecentReplyRateForInstance(inst, nowMs);
      const policy = getColdOutreachPolicyForStage(normalizedStage, Number(row.health_score ?? 100), {
        daysActive: parsedDaysActive,
        careerMode: row.career_mode ?? null,
        coldOutreachLockedUntil: row.cold_outreach_locked_until ?? null,
        recentReplyRate: replyTelemetry && replyTelemetry.sampleSize >= 8 ? replyTelemetry.rate : null,
        nowMs,
      });
      const coldCounts = getColdSendCounts(inst, nowMs);
      const followupCounts = getFollowupSendCounts(inst, nowMs);
      const hourlyCount = outreachMode === "followup" ? followupCounts.hourlyCount : coldCounts.hourlyCount;
      const dailyCount = outreachMode === "followup" ? followupCounts.dailyCount : coldCounts.dailyCount;
      const combinedHourlyCount = coldCounts.hourlyCount + followupCounts.hourlyCount;
      const warmupSentToday = Math.max(0, Number(row.sent_today || 0));
      const baseCombinedCeiling = STAGE_COMBINED_DAILY_CAP[normalizedStage] ?? 115;
      const combinedCeiling = policy.veteranTier ? Math.max(baseCombinedCeiling, 120) : baseCombinedCeiling;
      const otherModeDailyUsed = outreachMode === "followup" ? coldCounts.dailyCount : followupCounts.dailyCount;
      const modeDailyCap = outreachMode === "followup" ? policy.dailyFollowupCap : policy.dailyColdCap;
      const modeHourlyCap = outreachMode === "followup" ? policy.hourlyFollowupCap : policy.hourlyColdCap;
      const effectiveDailyCap = Math.min(modeDailyCap, Math.max(0, combinedCeiling - warmupSentToday - otherModeDailyUsed));
      const effectiveHourlyCap =
        hourlyFactor < 1 && policy.allowed
          ? Math.max(1, Math.floor(modeHourlyCap * hourlyFactor))
          : modeHourlyCap;
      const ddd = extractBrazilDdd(row.phone_number || connPhoneByInstance.get(inst) || null);

      if (bypassColdShield) {
        // Proteção Anti-Ban desligada para esta campanha: o chip entra na fila
        // mesmo com cota cheia, berçário, saúde baixa ou quarentena.
        return { eligible: true, policy, hourlyCount, dailyCount, ddd };
      }
      if (isQuarantined) {
        return { eligible: false, policy, hourlyCount, dailyCount, ddd, reason: "quarantined" };
      }
      if (zeroReplyUntil > nowMs) {
        return { eligible: false, policy, hourlyCount, dailyCount, ddd, reason: "zero_reply_brake" };
      }
      if (!policy.allowed) {
        return { eligible: false, policy, hourlyCount, dailyCount, ddd, reason: policy.reason || "policy_blocked" };
      }
      if (hourlyCount >= effectiveHourlyCap || combinedHourlyCount >= MAX_COMBINED_HOURLY_PER_CHIP) {
        return {
          eligible: false,
          policy,
          hourlyCount,
          dailyCount,
          ddd,
          reason:
            hourlyFactor < 1
              ? "weekend_hourly_cap"
              : outreachMode === "followup"
                ? "hourly_followup_cap"
                : "hourly_cold_cap",
        };
      }
      if (dailyCount >= effectiveDailyCap) {
        return {
          eligible: false,
          policy,
          hourlyCount,
          dailyCount,
          ddd,
          reason:
            (warmupSentToday > 0 || otherModeDailyUsed > 0) && effectiveDailyCap < modeDailyCap
              ? "combined_daily_cap"
              : outreachMode === "followup"
                ? "daily_followup_cap"
                : "daily_cold_cap",
        };
      }
      return { eligible: true, policy, hourlyCount, dailyCount, ddd };
    };

    const scoreChipCandidate = (row: any, ev: ReturnType<typeof isChipEligible>, isPrimary: boolean): number => {
      let score = Number(row.health_score ?? 100);
      score -= ev.hourlyCount * 22;
      if (String(row.mmzap_browser_status || "").toLowerCase() === "running") {
        score -= 25; // Prefere chip livre para não interromper turno ativo do MMZap sem necessidade
      }
      if (preferredInstanceName && row.instance_name === preferredInstanceName) {
        score += 150; // Sticky Sender: prioriza o mesmo chip que já iniciou conversa com o lead
      }
      if (targetDdd && ev.ddd) {
        if (targetDdd === ev.ddd) {
          score += 120; // Presença local exata (mesmo DDD do lead)
        } else if (targetDdd.charAt(0) === ev.ddd.charAt(0)) {
          score += 20; // Mesma macro-região de DDD
        }
      }
      if (isPrimary && ev.hourlyCount < 2) {
        score += 10;
      }
      return score;
    };

    const isAutoPool = isAutoPoolInstance(primaryInstanceName);

    if (!isAutoPool) {
      const primaryRow = warmupRows.find((r: any) => r.instance_name === primaryInstanceName);
      if (!primaryRow) {
        return { ok: true, instanceName: primaryInstanceName, rotated: false, policy: null };
      }

      const primaryEval = isChipEligible(primaryRow);
      if (primaryEval.eligible) {
        const mmzapStatus = String((primaryRow as any).mmzap_browser_status || "").toLowerCase() || null;
        let mmzapHandoverStopped = false;
        if (!dryRun && mmzapStatus === "running") {
          mmzapHandoverStopped = await stopActiveMmzapBeforeSend(clientId, primaryInstanceName);
        }
        return {
          ok: true,
          instanceName: primaryInstanceName,
          rotated: false,
          policy: primaryEval.policy,
          mmzapBrowserStatus: mmzapStatus,
          ...(mmzapHandoverStopped ? { mmzapHandoverStopped: true } : {}),
        };
      }

      // Chip fixo selecionado: nunca rotaciona para outro chip; aguarda no próprio chip.
      return {
        ok: false,
        instanceName: primaryInstanceName,
        rotated: false,
        policy: primaryEval.policy,
        reason: primaryEval.reason || "cold_cap_reached",
      };
    }

    // Modo Pool Automático (__auto_pool__): avalia candidatos conectados e escolhe o melhor chip saudável
    const hasConnInventory = Array.isArray(connRows) && connRows.length > 0;
    const poolCandidates = warmupRows
      .filter((r: any) => {
        if (!r?.instance_name) return false;
        if (r.enabled === false && r.purpose !== "outbound") return false;
        if (!bypassColdShield && String(r.external_warmup_mode || "").toLowerCase() === "receive_only") return false;
        if (hasConnInventory && !openSet.has(r.instance_name)) return false;
        return true;
      })
      .map((r: any) => {
        const evalRes = isChipEligible(r);
        return { row: r, eval: evalRes, score: scoreChipCandidate(r, evalRes, false) };
      })
      .filter((item) => item.eval.eligible)
      .sort((a, b) => b.score - a.score);

    if (poolCandidates.length > 0) {
      const chosen = poolCandidates[0];
      const chosenName = String(chosen.row.instance_name);
      const mmzapStatus = String((chosen.row as any).mmzap_browser_status || "").toLowerCase() || null;
      let mmzapHandoverStopped = false;
      if (!dryRun && mmzapStatus === "running") {
        mmzapHandoverStopped = await stopActiveMmzapBeforeSend(clientId, chosenName);
      }
      const reason =
        preferredInstanceName && chosen.row.instance_name === preferredInstanceName
          ? "sticky_sender"
          : targetDdd && chosen.eval.ddd === targetDdd
            ? "ddd_affinity"
            : "auto_pool";
      return {
        ok: true,
        instanceName: chosenName,
        rotated: true,
        policy: chosen.eval.policy,
        reason,
        mmzapBrowserStatus: mmzapStatus,
        ...(mmzapHandoverStopped ? { mmzapHandoverStopped: true } : {}),
      };
    }

    return {
      ok: false,
      instanceName: "",
      rotated: false,
      policy: null,
      reason: "no_eligible_pool_chip",
    };
  } catch {
    return { ok: true, instanceName: primaryInstanceName, rotated: false, policy: null };
  }
}

const CROSS_CAMPAIGN_COOLDOWN_HOURS = 72;

/**
 * Impede que campanhas/automações diferentes disparem abordagem fria para o
 * mesmo lead (incluindo variante 8/9º dígito BR) em menos de `cooldownHours`.
 */
export async function findRecentCrossCampaignSend(params: {
  clientId: string;
  currentCampaignId: string;
  remoteJid: string;
  cooldownHours?: number;
  nowMs?: number;
}): Promise<{ campaignId: string; sentAt: string } | null> {
  const {
    clientId,
    currentCampaignId,
    remoteJid,
    cooldownHours = CROSS_CAMPAIGN_COOLDOWN_HOURS,
    nowMs = Date.now(),
  } = params;
  if (!clientId || !remoteJid) return null;

  const variants = buildJidLookupVariants(remoteJid);
  if (variants.length === 0) return null;

  const cutoffIso = new Date(nowMs - Math.max(1, cooldownHours) * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from("campaign_targets")
      .select("campaign_id, sent_at")
      .eq("client_id", clientId)
      .neq("campaign_id", currentCampaignId)
      .eq("status", "sent")
      .in("remote_jid", variants)
      .gte("sent_at", cutoffIso)
      .order("sent_at", { ascending: false })
      .limit(1);

    if (error || !Array.isArray(data) || data.length === 0) return null;
    const hit = data[0] as { campaign_id?: string | null; sent_at?: string | null };
    if (!hit?.campaign_id || !hit?.sent_at) return null;
    return { campaignId: String(hit.campaign_id), sentAt: String(hit.sent_at) };
  } catch {
    return null;
  }
}

async function fetchLeadFullForCampaign(remoteJid: string, clientId: string): Promise<any | null> {
  const cols =
    "nome_negocio, ramo_negocio, telefone, endereco, website, instagram, facebook, avaliacao, reviews, status, categoria, resumo_avaliacoes";
  const variants = buildJidLookupVariants(remoteJid);

  let res = await supabase
    .from("leads_extraidos")
    .select("*")
    .eq("remoteJid", remoteJid)
    .eq("client_id", clientId)
    .maybeSingle();
  if (res.error && res.error.code === "PGRST204") {
    res = await supabase
      .from("leads_extraidos")
      .select(cols.replace(", resumo_avaliacoes", ""))
      .eq("remoteJid", remoteJid)
      .eq("client_id", clientId)
      .maybeSingle();
  }
  if (res.data) return res.data;

  if (variants.length > 1) {
    let fallbackRes = await supabase
      .from("leads_extraidos")
      .select("*")
      .in("remoteJid", variants)
      .eq("client_id", clientId)
      .limit(1);
    if (fallbackRes.error && fallbackRes.error.code === "PGRST204") {
      fallbackRes = await supabase
        .from("leads_extraidos")
        .select(cols.replace(", resumo_avaliacoes", ""))
        .in("remoteJid", variants)
        .eq("client_id", clientId)
        .limit(1);
    }
    if (Array.isArray(fallbackRes.data) && fallbackRes.data[0]) {
      return fallbackRes.data[0];
    }
  }
  return null;
}

/**
 * Liga/desliga da Proteção Anti-Ban por campanha.
 * Fonte de verdade: app_settings `campaign_cold_shield:<id>`; fallback para
 * flag no próprio registro e para `scrape_filters.cold_shield` da automação
 * de origem. Chave ausente = proteção LIGADA (comportamento histórico).
 */
export async function resolveCampaignColdShield(c: any): Promise<boolean> {
  try {
    if (c?.id) {
      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", `campaign_cold_shield:${c.id}`)
        .maybeSingle();
      if (data?.value !== undefined && data?.value !== null) {
        return data.value === "true" || data.value === "1";
      }
    }
  } catch {}
  if (c?.cold_shield !== undefined && c?.cold_shield !== null) {
    return Boolean(c.cold_shield);
  }
  try {
    if (c?.automation_id) {
      const { data: auto } = await supabase
        .from("automations")
        .select("scrape_filters")
        .eq("id", c.automation_id)
        .maybeSingle();
      const flag = auto?.scrape_filters?.cold_shield;
      if (flag !== undefined && flag !== null) return Boolean(flag);
    }
  } catch {}
  return true;
}

async function resolveCampaignAntiBanContext(c: any): Promise<{
  linkedAuto: { scrape_filters?: any; agent_id?: number | null } | null;
  antibanMixerEnabled: boolean;
}> {
  let linkedAuto: { scrape_filters?: any; agent_id?: number | null } | null = null;
  let antibanMixerEnabled = false;
  try {
    if (c?.automation_id) {
      const { data: auto } = await supabase
        .from("automations")
        .select("scrape_filters, agent_id")
        .eq("id", c.automation_id)
        .maybeSingle();
      linkedAuto = auto || null;
      if (auto?.scrape_filters?.antiban_mixer !== undefined) {
        antibanMixerEnabled = Boolean(auto.scrape_filters.antiban_mixer);
      }
    } else if (c?.antiban_mixer !== undefined) {
      antibanMixerEnabled = Boolean(c.antiban_mixer);
    } else if (c?.id) {
      const { data: sysCfg } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", `campaign_antiban:${c.id}`)
        .maybeSingle();
      if (sysCfg?.value !== undefined) {
        antibanMixerEnabled = sysCfg.value === "true" || sysCfg.value === "1";
      }
    }
  } catch {}
  return { linkedAuto, antibanMixerEnabled };
}

async function processNextTarget(campaignId: string): Promise<"continue" | "done" | "stopped" | "out_of_hours" | "too_soon" | "cold_cap_rest"> {
  // Re-fetch campaign (status pode ter mudado)
  const { data: c } = await supabase.from("campaigns").select("*").eq("id", campaignId).single();
  if (!c) return "stopped";
  if (c.status !== "running") return "stopped";

  const clientId: string | null = c.client_id || null;
  if (!clientId) {
    const msg = "Campanha sem client_id — disparo abortado (fail-closed multi-tenant).";
    console.error(`[CAMPAIGN ${campaignId}] ${msg}`);
    await addCampaignLog(campaignId, msg, "error");
    await supabase.from("campaigns").update({
      status: "paused", last_error: msg, last_error_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
    return "stopped";
  }
  if (!(await isClientActiveCached(clientId))) {
    const msg = "Conta desativada — campanha pausada automaticamente.";
    await addCampaignLog(campaignId, msg, "warning");
    await supabase.from("campaigns").update({
      status: "paused", last_error: msg, last_error_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", campaignId).eq("client_id", clientId);
    return "stopped";
  }
  if (!isAutoPoolInstance(c.instance_name) && !(await isInstanceOwnedByClient(c.instance_name, clientId))) {
    const msg = `Instância "${c.instance_name}" não pertence ao cliente da campanha — disparo pausado.`;
    await addCampaignLog(campaignId, msg, "error");
    await supabase.from("campaigns").update({
      status: "paused", last_error: msg, last_error_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", campaignId).eq("client_id", clientId);
    return "stopped";
  }

  // Liga/desliga da Proteção Anti-Ban escolhido na criação/edição da campanha.
  const coldShieldEnabled = await resolveCampaignColdShield(c);

  if (!isWithinAllowedHour(c as any)) {
    const msg = `⏰ Fora do horário permitido — agora são ${nowHourBRT()}h, a janela é ${c.allowed_start_hour}h-${c.allowed_end_hour}h. O disparo retoma sozinho quando a janela abrir.`;
    if (shouldEmitCampaignWarning(campaignId, "out_of_hours", msg)) {
      console.log(`[CAMPAIGN ${c.name}] ${msg}`);
      await addCampaignLog(campaignId, msg, "warning");
    }
    return "out_of_hours";
  }

  let weekendGuardMode: WeekendB2BGuardMode = parseWeekendB2BGuardMode((c as any).weekend_guard);
  if (!weekendGuardMode && (c as any).automation_id) {
    try {
      const { data: autoRow } = await supabase
        .from("automations")
        .select("scrape_filters")
        .eq("id", (c as any).automation_id)
        .maybeSingle();
      weekendGuardMode = parseWeekendB2BGuardMode(autoRow?.scrape_filters?.weekend_guard);
    } catch {}
  }
  if (!weekendGuardMode) {
    try {
      const { data: wgCfg } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", `campaign_weekend_guard:${c.id}`)
        .maybeSingle();
      weekendGuardMode = parseWeekendB2BGuardMode(wgCfg?.value);
    } catch {}
  }
  const weekendGuard = evaluateWeekendB2BGuard(weekendGuardMode);
  if (!weekendGuard.allowed) {
    const msg = "📅 Modo Comercial B2B ativo — disparos frios pausados aos domingos para preservar reputação; retoma na segunda-feira.";
    if (shouldEmitCampaignWarning(campaignId, "weekend_b2b", msg)) {
      console.log(`[CAMPAIGN ${c.name}] ${msg}`);
      await addCampaignLog(campaignId, msg, "warning");
    }
    return "out_of_hours";
  }

  const maxDailyPreviews = Number((c as any).max_daily_previews || 0);
  if (maxDailyPreviews > 0) {
    const previewBrake = await checkDailyPreviewCapacityBrake(clientId, maxDailyPreviews);
    if (previewBrake.blocked) {
      const msg = `🛑 Freio Diário de Prévias atingido (${previewBrake.todayCount}/${previewBrake.limit} prévias hoje) — disparos pausados até amanhã para garantir entrega no X1.`;
      if (shouldEmitCampaignWarning(campaignId, "daily_preview_capacity_reached", msg)) {
        await addCampaignLog(campaignId, msg, "warning");
      }
      return "out_of_hours";
    }
  }

  // ───────── GATE ATÔMICO DE INTERVALO (anti-burst) ─────────
  // Vários loops/timers concorrentes pro MESMO disparo (deploy sobrepondo
  // containers, re-trigger, múltiplas instâncias do módulo no Next) faziam
  // 2-3 envios no mesmo minuto, furando o intervalo configurado.
  // Solução: "reservar o slot" com um UPDATE condicional ATÔMICO —
  //   UPDATE campaigns SET updated_at=now() WHERE id=X AND updated_at<=cutoff
  // O Postgres serializa o UPDATE: só UM loop consegue mover a linha; os
  // concorrentes recebem 0 linhas e abortam o ciclo. No máximo 1 envio por
  // intervalo, não importa quantos loops existam ou em quantos processos.
  // No fluxo normal (1 loop só) o gate NUNCA bloqueia: o jitter do loop
  // (min..max) é sempre >= min_interval, então o slot já está liberado.
  const minGapMs = Math.max(5, Number(c.min_interval_seconds) || 30) * 1000;
  const cutoffIso = new Date(Date.now() - minGapMs).toISOString();
  const { data: slot } = await supabase
    .from("campaigns")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("status", "running")
    .lte("updated_at", cutoffIso)
    .select("id")
    .maybeSingle();
  if (!slot) {
    // Outro loop já disparou agora há pouco — este está adiantado.
    console.log(`[CAMPAIGN ${c.name}] gate de intervalo: envio adiantado bloqueado.`);
    return "too_soon";
  }

  // CLAIM ATÔMICO (fase 1 — leitura do próximo pending antes do roteamento Multi-Chip para casar DDD)
  const { data: candidate } = await supabase
    .from("campaign_targets")
    .select("id, remote_jid")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!candidate) {
    // Sem pending pode significar dois estados bem diferentes: tudo terminal
    // (done) ou alguém enviando agora (processing). Marcar done com processing
    // ativo aborta a campanha enquanto um envio ainda está em voo.
    const { count: processingCount, error: processingErr } = await supabase
      .from("campaign_targets")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "processing");
    if (processingErr) {
      const msg = `Falha ao checar targets em processamento: ${processingErr.message}`;
      await addCampaignLog(campaignId, msg, "error");
      await supabase.from("campaigns").update({
        status: "paused", last_error: msg.slice(0, 500), last_error_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", campaignId);
      return "stopped";
    }
    if ((processingCount || 0) > 0) {
      await addCampaignLog(campaignId, "Há target em processamento — aguardando finalização antes de concluir.", "info");
      return "continue";
    }

    await supabase.from("campaigns").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", campaignId);
    await addCampaignLog(campaignId, "Campanha finalizada. Todos os leads foram processados.", "success");
    console.log(`[CAMPAIGN ${c.name}] Concluída.`);
    return "done";
  }

  // ───────── ESCUDO DE CAPACIDADE FRIA + POOL MULTI-CHIP COM AFINIDADE DE DDD ─────────
  const chipResolution = await resolveHealthyCampaignChip(clientId, c.instance_name, {
    targetRemoteJid: candidate.remote_jid,
    hourlyFactor: weekendGuard.hourlyFactor,
    bypassColdShield: !coldShieldEnabled,
  });
  if (!chipResolution.ok) {
    const restMsg =
      chipResolution.reason === "nursery_stage_1" || chipResolution.reason === "insufficient_active_days"
        ? `🍼 Proteção Berçário Anti-Ban: o chip "${c.instance_name}" ainda está em maturação inicial (dias 1–6 / Fase 1 — mínimo 7 dias antes de prospecção fria). Aguardando amadurecer ou outro chip disponível.`
        : `🛡️ Proteção Anti-Ban: chip(s) atingiram o teto seguro de prospecção fria da hora/estágio (${chipResolution.reason || "cold_cap"}). Descansando 15 min antes de retomar automaticamente.`;
    console.log(`[CAMPAIGN ${c.name}] ${restMsg}`);
    await addCampaignLog(campaignId, restMsg, "warning");
    return "cold_cap_rest";
  }

  const effectiveInstanceName = chipResolution.instanceName || c.instance_name;
  _lastSelectedInstanceByCampaign.set(campaignId, {
    instanceName: effectiveInstanceName,
    stageMinIntervalSec: coldShieldEnabled ? chipResolution.policy?.minSafeIntervalSec : undefined,
    coldShieldEnabled,
  });

  if (chipResolution.mmzapHandoverStopped) {
    await addCampaignLog(
      campaignId,
      `⏸️ Handover MMZap: turno de aquecimento pausado no chip "${effectiveInstanceName}" antes do disparo para evitar duplo-bot simultâneo.`,
      "info"
    );
  }

  if (chipResolution.rotated && effectiveInstanceName !== c.instance_name) {
    const rotLabel =
      chipResolution.reason === "ddd_affinity"
        ? "afinidade de DDD local"
        : chipResolution.reason === "load_balance"
          ? "balanceamento de carga"
          : "proteção do chip principal";
    await addCampaignLog(
      campaignId,
      `🔄 Pool Multi-Chip Anti-Ban: alternando disparo para o chip saudável "${effectiveInstanceName}" (${rotLabel}).`,
      "info"
    );
  } else if (chipResolution.policy?.throttledByHealth) {
    await addCampaignLog(
      campaignId,
      `🐢 Freio Dinâmico de Saúde ativo no chip "${effectiveInstanceName}" — ritmo reduzido em 50% e pulso simbiótico reforçado.`,
      "info"
    );
  }

  // Tenta claim. Só prossegue se ESTE chamador conseguiu mover pending→processing.
  // Não atualiza `updated_at` porque a tabela campaign_targets não tem essa coluna.
  const { data: claimed } = await supabase
    .from("campaign_targets")
    .update({ status: "processing" })
    .eq("id", candidate.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (!claimed) {
    // Outro worker pegou primeiro. Tenta de novo no próximo loop.
    return "continue";
  }
  const target = claimed;

  // Opt-out check (inclui variantes de 8/9º dígito BR) — lead pediu parar. Pula + loga. Anti-spam + LGPD.
  const optVariants = buildJidLookupVariants(target.remote_jid);
  const { data: optRows } = await supabase
    .from("leads_extraidos")
    .select("opt_out")
    .in("remoteJid", optVariants)
    .eq("client_id", clientId)
    .eq("opt_out", true)
    .limit(1);
  if (Array.isArray(optRows) && optRows.length > 0) {
    await supabase.from("campaign_targets").update({
      status: "skipped",
      error_message: "Opt-out (lead pediu parar)",
      attempts: (target.attempts || 0) + 1,
    }).eq("id", target.id);
    await supabase.from("campaigns").update({
      skipped_count: (c.skipped_count || 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
    await addCampaignLog(campaignId, `⊘ Pulado ${target.remote_jid} — opt-out`, "warning");
    return "continue";
  }

  // Cooldown Anti-Spam entre campanhas diferentes (impede 2 disparos frios para o mesmo contato em < 72h)
  const recentCrossSend = await findRecentCrossCampaignSend({
    clientId,
    currentCampaignId: campaignId,
    remoteJid: target.remote_jid,
  });
  if (recentCrossSend) {
    await supabase.from("campaign_targets").update({
      status: "skipped",
      error_message: `Cooldown entre campanhas (< ${CROSS_CAMPAIGN_COOLDOWN_HOURS}h)`,
      attempts: (target.attempts || 0) + 1,
    }).eq("id", target.id);
    await supabase.from("campaigns").update({
      skipped_count: (c.skipped_count || 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
    await addCampaignLog(
      campaignId,
      `⊘ Pulado ${target.remote_jid} — já abordado em outra campanha recentemente (${recentCrossSend.campaignId.slice(0, 8)}).`,
      "warning"
    );
    return "continue";
  }

  await addCampaignLog(campaignId, `Processando lead: ${target.nome_negocio || target.remote_jid}`, "info");

  // Validação prévia + resolução do JID canônico. Grupos (@g.us) pulam.
  // sendJid = pra ONDE enviar E sob qual JID salvar no chat. O WhatsApp pode
  // usar um JID diferente do número captado (9º dígito no Brasil) — usar o
  // canônico mantém o disparo e a resposta do cliente NO MESMO chat (era o
  // motivo da mensagem de disparo "sumir" da conversa).
  let sendJid = target.remote_jid;
  if (!target.remote_jid.includes("@g.us") && !target.remote_jid.includes("@lid")) {
    const phone = target.remote_jid.replace(/@.*$/, "").replace(/\D/g, "");
    if (phone) {
      // 1. Consulta primeiro o cache pré-validado para evitar a assinatura robótica
      //    de disparar `USyncQuery (onWhatsApp)` milissegundos antes de `sendMessage`.
      const cachedEntry = getCachedCanonicalJid(effectiveInstanceName, phone);
      let entry: { exists?: boolean; jid?: string | null } | null = cachedEntry;
      let checkedLiveNow = false;

      if (!entry) {
        const check = await channel.checkWhatsAppNumbersDetailed([phone], effectiveInstanceName);
        // A chave do retorno pode vir como número limpo OU canônico — pega a 1ª entrada.
        entry = check[phone] || Object.values(check)[0] || null;
        checkedLiveNow = true;
        if (entry) {
          cacheVerifiedCanonicalJid(effectiveInstanceName, phone, {
            exists: entry.exists !== false,
            jid: entry.jid,
          });
        }
      }

      if (entry && entry.exists === false) {
        await supabase.from("campaign_targets").update({
          status: "skipped",
          error_message: "Número não existe no WhatsApp (pré-check)",
          attempts: (target.attempts || 0) + 1,
        }).eq("id", target.id);
        await supabase.from("campaigns").update({
          skipped_count: (c.skipped_count || 0) + 1,
          updated_at: new Date().toISOString(),
        }).eq("id", campaignId);
        await addCampaignLog(campaignId, `⊘ Pulado ${target.remote_jid} — número não tem WhatsApp`, "warning");
        return "continue";
      }

      // Se consultou a existência ao vivo agora (e não veio do cache pré-validado),
      // aguarda um micro-delay humano (3.5s–7.5s) antes de iniciar o "digitando...",
      // quebrando a correlação USyncQuery -> sendMessage imediata.
      if (
        checkedLiveNow &&
        entry &&
        process.env.VITEST !== "true" &&
        process.env.NODE_ENV !== "test"
      ) {
        await new Promise((r) => setTimeout(r, calculatePreSendProfilePauseMs()));
      }

      if (entry && entry.jid) {
        sendJid = entry.jid;
        if (sendJid !== target.remote_jid) {
          console.log(`[CAMPAIGN ${c.name}] JID divergente detectado. Original: ${target.remote_jid} · Canônico: ${sendJid}. Unificando...`);

          // 1. Atualiza campaign_targets
          try {
            await supabase
              .from("campaign_targets")
              .update({ remote_jid: sendJid })
              .eq("id", target.id);
          } catch (err) {
            console.error(`[CAMPAIGN ${c.name}] Erro ao atualizar campaign_targets para o JID canônico:`, err);
          }

          // 2. Atualiza leads_extraidos de forma resiliente
          try {
            const { error: updErr } = await supabase
              .from("leads_extraidos")
              .update({ remoteJid: sendJid })
              .eq("remoteJid", target.remote_jid)
              .eq("client_id", clientId);

            if (updErr) {
              if (updErr.code === "23505" || updErr.message?.includes("unique")) {
                console.log(`[CAMPAIGN ${c.name}] JID canônico ${sendJid} já existe em leads_extraidos. Iniciando merge de inteligência e dados.`);
                const { data: oldLead } = await supabase
                  .from("leads_extraidos")
                  .select("*")
                  .eq("remoteJid", target.remote_jid)
                  .eq("client_id", clientId)
                  .maybeSingle();

                if (oldLead) {
                  const mergePayload: Record<string, any> = {};
                  const fieldsToMerge = [
                    "nome_negocio", "ramo_negocio", "categoria", "endereco", "website",
                    "instagram", "facebook", "avaliacao", "reviews", "status",
                    "intelligence", "intelligence_at", "icp_score", "lead_type",
                    "justificativa_ia", "resumo_ia", "ia_last_analyzed_at"
                  ];

                  for (const field of fieldsToMerge) {
                    if (oldLead[field] !== undefined && oldLead[field] !== null) {
                      mergePayload[field] = oldLead[field];
                    }
                  }

                  await supabase
                    .from("leads_extraidos")
                    .update(mergePayload)
                    .eq("remoteJid", sendJid)
                    .eq("client_id", clientId);

                  await supabase
                    .from("leads_extraidos")
                    .delete()
                    .eq("id", oldLead.id)
                    .eq("client_id", clientId);

                  console.log(`[CAMPAIGN ${c.name}] Merge e deleção do lead duplicado ${target.remote_jid} concluídos.`);
                }
              } else {
                throw updErr;
              }
            }
          } catch (err) {
            console.error(`[CAMPAIGN ${c.name}] Erro na unificação/merge de leads_extraidos:`, err);
          }

          target.remote_jid = sendJid;
        }
      }
    }
  }

  const leadFull: any = await fetchLeadFullForCampaign(target.remote_jid, clientId);

  // push_name do contato — vem da tabela contacts (nome do WhatsApp).
  let pushName: string | null = null;
  if (sendJid) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("push_name")
      .eq("client_id", c.client_id)
      .eq("remote_jid", sendJid)
      .maybeSingle();
    pushName = (contact as any)?.push_name || null;
  }

  const { linkedAuto, antibanMixerEnabled } = await resolveCampaignAntiBanContext(c);

  const rawCompanyName = leadFull?.nome_negocio || target.nome_negocio;
  const effectiveCompanyName = antibanMixerEnabled
    ? cleanCompanyNameForApproach(rawCompanyName) || rawCompanyName
    : rawCompanyName;

  // Contexto de render — usado no template AGORA e DE NOVO depois da IA
  // (rede de segurança: nenhuma {{variavel}} pode chegar ao cliente).
  const renderCtx = leadRowToTemplateContext(leadFull, {
    remoteJid: sendJid,
    nome_negocio: effectiveCompanyName,
    ramo_negocio: leadFull?.ramo_negocio || target.ramo_negocio,
    push_name: pushName,
  });

  // Seleção A/B automática (quando configurada na campanha)
  let chosenAbVariant: AbVariantKey | null = null;
  let effectiveTemplate = String(c.message_template || "");
  try {
    const abCfg = await getCampaignAbConfig(c.id);
    if (abCfg?.enabled) {
      const abEval = await computeCampaignAbSummary(clientId, c.id, c.name);
      if (abEval.newlyPaused) {
        await addCampaignLog(campaignId, `⏸️ Teste A/B: ${abEval.newlyPaused.reason}`, "warning");
      }
      if (abEval.newlyPaused) {
        abCfg.paused_variant = abEval.newlyPaused.variant;
      }
      chosenAbVariant = selectCampaignAbVariant(abCfg, abEval.storedCounts);
      if (chosenAbVariant === "B" && abCfg.variantB_template.trim()) {
        effectiveTemplate = abCfg.variantB_template;
      } else if (abCfg.variantA_template.trim()) {
        effectiveTemplate = abCfg.variantA_template;
      }
    }
  } catch {
    /* fail-open: mantém template padrão */
  }

  // Renderiza msg base substituindo variáveis ({{saudacao}}, {{nome_empresa}}, etc) e Spintax
  let text = renderTemplate(effectiveTemplate, renderCtx, { spintax: true });

  // Se o Misturador Anti-Ban estiver ativo (variação semântica de abordagem),
  // aplica a mistura sobre a mensagem base antes da IA ou do envio direto.
  if (antibanMixerEnabled) {
    text = applyAntiBanMixer({
      template: effectiveTemplate,
      renderedText: text,
      companyName: effectiveCompanyName,
      rating: renderCtx.avaliacao ?? renderCtx.nota ?? null,
      reviews: renderCtx.reviews ?? renderCtx.avaliacoes ?? null,
      ramo: renderCtx.ramo_negocio || renderCtx.categoria || null,
      now: new Date(),
      scopeKey: c.id,
    });
    persistAntiBanMixerAsync(clientId);
  }

  // Guarda o texto ANTES da IA — é o que foi enviado pro Gemini. Permite comparar
  // "template" vs "resposta da IA" depois no painel de histórico.
  let aiInputText: string | null = null;

  // MENSAGEM PRÉ-GERADA (pré-geração fora da janela): reaproveita o texto que
  // a IA já escreveu — sem nova chamada de IA no momento do envio.
  // Quando Teste A/B está ativo, não sobrescreve a variante sorteada com pré-geração da Variante A.
  if (c.personalize_with_ai && target.rendered_message && !chosenAbVariant) {
    text = target.rendered_message;
    aiInputText = target.ai_input || null;
    await addCampaignLog(campaignId,
      `♻️ Msg pré-gerada por IA usada para ${target.nome_negocio || target.remote_jid}: "${text.slice(0, 140)}${text.length > 140 ? "…" : ""}"`, "info");
  }
  // Se "Personalizar com IA" estiver ativo (e não há pré-gerada), passa pelo
  // Gemini ANTES de enviar
  else if (c.personalize_with_ai) {
    const adminTenant = await isClientAdminCached(clientId);
    const quota: { allowed: boolean; reason?: string } = adminTenant
      ? { allowed: true }
      : await checkTenantAiQuota(clientId, false);
    if (!quota.allowed) {
      await addCampaignLog(
        campaignId,
        `Cota mensal de IA atingida (${quota.reason || "plano"}) — usando template direto sem personalização IA.`,
        "warning",
      );
    } else {
      aiInputText = text;
      try {
        await addCampaignLog(campaignId, `Personalizando mensagem com IA para ${target.nome_negocio}...`, "info");
        const aiText = await personalizeWithAI({
          baseMessage: text,
          model: c.ai_model || "gemini-1.5-flash",
          customPrompt: c.ai_prompt ? renderTemplate(c.ai_prompt, renderCtx) : null,
          nomeEmpresa: effectiveCompanyName || "",
          ramo: target.ramo_negocio || "",
          useWebSearch: !!c.use_web_search,
          campaignId: c.id,
          campaignName: c.name,
          remoteJid: target.remote_jid,
          clientId,
        });
        if (aiText && aiText.trim()) {
          text = aiText.trim();
          await addCampaignLog(campaignId, `IA gerou: "${text.slice(0, 140)}${text.length > 140 ? "…" : ""}"`, "success");
        } else {
          await addCampaignLog(campaignId, `IA retornou resposta vazia — usando template original.`, "warning");
        }
      } catch (e: any) {
        const errMsg = `Falha ao personalizar com IA, usando template direto: ${e.message}`;
        console.warn(`[CAMPAIGN ${c.name}] ${errMsg}`);
        await addCampaignLog(campaignId, errMsg, "warning");
        // Continua com `text` original (renderTemplate)
      }
    }
  }

  // REDE DE SEGURANÇA — render final. Se a IA deixou/reintroduziu qualquer
  // {{variavel}} ou {variavel}, resolve agora. O cliente NUNCA pode receber chaves cruas.
  text = renderTemplate(text, renderCtx, { spintax: true });
  // BLINDAGEM FINAL — a IA, ao reescrever, às vezes "generaliza" o texto e
  // RE-INTRODUZ {{saudacao}}/{{nome_empresa}} como se montasse um template.
  // Aqui, qualquer {{...}} ou {...} que ainda reste (variável inventada ou desconhecida)
  // é REMOVIDA. O cliente JAMAIS pode receber chaves cruas no WhatsApp.
  if (/\{\{.*?\}\}|\{.*?\}/.test(text)) {
    await addCampaignLog(campaignId,
      `⚠️ A IA devolveu variável {{...}} ou {...} não preenchida — removida automaticamente da mensagem antes do envio.`, "warning");
    text = text
      .replace(/\{\{\s*[\w-]+\s*\}\}/g, "")  // remove {{var}} ou {{var-name}}
      .replace(/\{\s*[\w-]+\s*\}/g, "")    // remove {var} ou {var-name}
      .replace(/[ \t]{2,}/g, " ")            // colapsa espaços duplos
      .replace(/\s+([.,!?])/g, "$1")         // tira espaço antes de pontuação
      .trim();
  }

  // SINCRONIZAÇÃO INTELIGENTE DE HORÁRIO DA SAUDAÇÃO + BLINDAGEM HANDSHAKE:
  // Garante que a saudação ("Bom dia", "Boa tarde", "Boa noite", "Boa madrugada")
  // corresponda EXATAMENTE ao horário real em que o disparo está saindo agora,
  // e impede links/pitch longo quando o template é de quebra-gelo curto.
  text = enforceShortHandshakeGuard({
    template: effectiveTemplate,
    candidateText: text,
    companyName: effectiveCompanyName,
    rating: renderCtx.avaliacao ?? renderCtx.nota ?? null,
    reviews: renderCtx.reviews ?? renderCtx.avaliacoes ?? null,
    ramo: renderCtx.ramo_negocio || renderCtx.categoria || null,
    now: new Date(),
    scopeKey: c.id,
  });

  try {
    // Picota a mensagem em chunks se humanize_messages estiver ativo
    // (mesma lógica do agente de IA — splitMessage + delay de digitação).
    // Em modo OFF, segue como mensagem única.
    const chunks = c.humanize_messages ? splitMessage(text) : [text];

    // Em modo humanize com splitMessage retornando [] (texto vazio),
    // preserva o texto original pra nunca cair num "nada a enviar".
    if (chunks.length === 0) chunks.push(text);

    // Texto completo efetivamente entregue ao lead (usado em
    // log/preview/rendered_message). Em modo humanize, é a junção dos
    // chunks com linha em branco — reflete o que o contato recebeu.
    const finalText = chunks.length > 1 ? chunks.join("\n\n") : chunks[0];
    let lastMsgId: string | null = null;

    // Sessão do contato é criada uma vez e reusada em todos os chunks
    // (evita N round-trips pra mesma session).
    let sess: { sessionId: string | null } | null = null;
    try {
      sess = await findOrCreateContactSession(clientId, sendJid, effectiveInstanceName, renderCtx.nome_negocio, c.agent_id);
    } catch (sessErr: any) {
      console.warn(`[CAMPAIGN ${c.name}] findOrCreateContactSession falhou (best-effort): ${sessErr?.message || sessErr}`);
    }

    // Resolve configuração de delay & presença "digitando..." (Evolution API)
    // 1. Prioridade: scrape_filters da automação vinculada (c.automation_id)
    // 2. Fallback: options do agente vinculado (c.agent_id)
    // 3. Fallback seguro: DEFAULT_TYPING_DELAY_CONFIG (aleatório 5-25s)
    let typingDelayMs = calculateTypingDelayMs(DEFAULT_TYPING_DELAY_CONFIG);
    try {
      if (linkedAuto) {
        const sf = linkedAuto.scrape_filters;
        if (sf?.typing_delay_mode || sf?.typing_delay) {
          typingDelayMs = calculateTypingDelayMs(sf.typing_delay || sf);
        } else if (linkedAuto.agent_id) {
          const { data: ag } = await supabase
            .from("agent_settings")
            .select("options")
            .eq("id", linkedAuto.agent_id)
            .maybeSingle();
          if (ag?.options) {
            typingDelayMs = calculateTypingDelayMs(ag.options);
          }
        }
      } else if (c.agent_id) {
        const { data: ag } = await supabase
          .from("agent_settings")
          .select("options")
          .eq("id", c.agent_id)
          .maybeSingle();
        if (ag?.options) {
          typingDelayMs = calculateTypingDelayMs(ag.options);
        }
      }
    } catch (delayErr: any) {
      console.warn(`[CAMPAIGN ${c.name}] Erro ao resolver typing delay:`, delayErr?.message);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      if (!chunkText) continue;

      // Delay de digitação entre chunks (2 a 5s em ms inteiro) — pula no primeiro.
      // Mesma fórmula do agente: ~15 chars/seg, clamp [2,5].
      if (i > 0) {
        await new Promise((r) => setTimeout(r, calculateChunkTypingMs(chunkText.length)));
      }

      // Registra cada chunk anti-echo (webhook pode chegar antes de persistir).
      registerPendingAutomatedSend(effectiveInstanceName, sendJid, chunkText);

      // Envia com delay de presença "digitando..." e linkPreview desativado em 1º contato frio (anti-ban)
      const result = await channel.sendMessage(sendJid, chunkText, effectiveInstanceName, {
        delay: typingDelayMs,
        linkPreview: false,
      });
      if (!result || result.ok === false) {
        throw new Error(result?.error || "Provider recusou o envio da campanha");
      }
      const chunkMsgId = (result as any)?.messageId || (result as any)?.key?.id || (result as any)?.data?.key?.id || `bulk-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      lastMsgId = chunkMsgId;

      // Persiste cada chunk no chat (pra IA ter contexto de todas as partes).
      try {
        await persistOutgoingMessage({
          sessionId: sess?.sessionId || null,
          remoteJid: sendJid,
          instanceName: effectiveInstanceName,
          msgId: chunkMsgId,
          text: chunkText,
          clientId,
        });
      } catch (persistErr: any) {
        const m = `⚠ Mensagem foi enviada no WhatsApp mas falhou ao salvar no chats_dashboard: ${persistErr?.message || persistErr}. Vai precisar refresh no /chat pra aparecer.`;
        console.warn(`[CAMPAIGN ${c.name}] ${m}`);
        await addCampaignLog(campaignId, m, "warning");
      }
    }

    // ── Mídia anexa: envia logo após o texto ──
    if (c.media_url && c.media_type) {
      try {
        await new Promise((r) => setTimeout(r, 1500)); // gap natural entre texto e mídia
        let renderedCaption = c.media_caption
          ? syncGreetingToCurrentHour(
              renderTemplate(String(c.media_caption), renderCtx, { spintax: true }),
              new Date()
            )
          : "";
        if (renderedCaption && /\{\{.*?\}\}|\{.*?\}/.test(renderedCaption)) {
          renderedCaption = renderedCaption
            .replace(/\{\{\s*[\w-]+\s*\}\}/g, "")
            .replace(/\{\s*[\w-]+\s*\}/g, "")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\s+([.,!?])/g, "$1")
            .trim();
        }
        if (typeof registerPendingAutomatedMedia === "function") {
          registerPendingAutomatedMedia(effectiveInstanceName, sendJid);
        }
        if (renderedCaption) {
          registerPendingAutomatedSend(effectiveInstanceName, sendJid, renderedCaption);
        }
        const mediaResult = await channel.sendMedia(
          sendJid,
          renderedCaption,
          {
            type: c.media_type as "image" | "video" | "audio" | "document",
            mediaUrl: c.media_url,
            fileName: c.media_file_name || undefined,
            mimetype: c.media_mimetype || undefined,
          },
          effectiveInstanceName,
          { delay: typingDelayMs },
        );
        if (!mediaResult || mediaResult.ok === false) {
          throw new Error(mediaResult?.error || "Provider recusou o envio da mídia");
        }
        const mediaMsgId = (mediaResult as any)?.messageId || (mediaResult as any)?.key?.id || `media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        registerAiSend(mediaMsgId);
        await addCampaignLog(campaignId, `📎 Mídia enviada → ${target.nome_negocio || target.remote_jid}`, "info");
        try {
          await persistOutgoingMessage({
            sessionId: sess?.sessionId || null,
            remoteJid: sendJid,
            instanceName: effectiveInstanceName,
            msgId: mediaMsgId,
            text: renderedCaption,
            clientId,
          });
        } catch { /* best-effort */ }
      } catch (mediaErr: any) {
        console.warn(`[CAMPAIGN ${c.name}] Mídia falhou: ${mediaErr?.message}`);
        await addCampaignLog(campaignId, `⚠ Mídia falhou: ${mediaErr?.message}`, "warning");
      }
    }

    const msgId = lastMsgId || `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const targetUpdate: Record<string, any> = {
      status: "sent",
      message_id: msgId,
      rendered_message: finalText,
      sent_at: new Date().toISOString(),
      attempts: (target.attempts || 0) + 1,
    };
    if (aiInputText) targetUpdate.ai_input = aiInputText;
    let tgtUpd = await supabase.from("campaign_targets").update(targetUpdate).eq("id", target.id);
    // Fallback: se a coluna ai_input ainda não foi migrada, tenta sem ela
    if (tgtUpd.error && (tgtUpd.error as any).code === "PGRST204" && "ai_input" in targetUpdate) {
      delete targetUpdate.ai_input;
      tgtUpd = await supabase.from("campaign_targets").update(targetUpdate).eq("id", target.id);
      console.warn("[CAMPAIGN] coluna ai_input não existe. Rode criar_campaign_logs.sql pra habilitar histórico do input da IA.");
    }

    await supabase.from("campaigns").update({
      sent_count: (c.sent_count || 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);

    if (chosenAbVariant) {
      await recordCampaignAbSend(c.id, clientId, sendJid, chosenAbVariant).catch(() => {});
    }

    // ───────── CONTABILIZAÇÃO ANTI-BAN & PULSO SIMBIÓTICO + FREIO DE VÁCUO SILENCIOSO ─────────
    const batchState = recordColdOutreachSend(effectiveInstanceName, Date.now(), clientId);
    const brakeRes = coldShieldEnabled
      ? await checkZeroReplyBrakeForInstance(
          clientId,
          effectiveInstanceName,
          sendJid,
          Date.now(),
          chipResolution.policy?.zeroReplyThreshold
        )
      : { brakeTriggered: false, checkedCount: 0, threshold: ZERO_REPLY_BATCH_THRESHOLD, replyRate: null };
    if (brakeRes.brakeTriggered) {
      await addCampaignLog(
        campaignId,
        `⚠️ Freio de Vácuo Silencioso: ${brakeRes.checkedCount} abordagens seguidas sem resposta em "${effectiveInstanceName}" — descansando 25 min + acionando aquecimento simbiótico.`,
        "warning"
      );
      setTimeout(async () => {
        try {
          const { triggerSymbioticWarmupPulse } = await import("@/lib/warmup/warmup-worker");
          await triggerSymbioticWarmupPulse(clientId, effectiveInstanceName);
        } catch {}
      }, process.env.VITEST === "true" || process.env.NODE_ENV === "test" ? 0 : 8000);
    }

    const symbioticEveryN = chipResolution.policy?.symbioticEveryN ?? 3;
    if (batchState.sendsSincePulse >= symbioticEveryN) {
      markSymbioticPulseTriggered(effectiveInstanceName);
      const pulseDelayMs =
        process.env.VITEST === "true" || process.env.NODE_ENV === "test"
          ? 0
          : 12_000 + Math.floor(Math.random() * 18_000);
      setTimeout(async () => {
        try {
          const { triggerSymbioticWarmupPulse } = await import("@/lib/warmup/warmup-worker");
          const pulse = await triggerSymbioticWarmupPulse(clientId, effectiveInstanceName);
          if (pulse.triggered && pulse.peerInstance) {
            await addCampaignLog(
              campaignId,
              `🛡️ Escudo Simbiótico: interação bidirecional intercalada (${pulse.peerInstance} ⇄ ${effectiveInstanceName}) para diluir vácuo de respostas na Meta.`,
              "info"
            );
          }
        } catch {}
      }, pulseDelayMs);
    }

    // Disparo enviado com sucesso → move o lead para "primeiro_contato" no Kanban.
    // Regra: move quando o status atual está ANTES de primeiro_contato na hierarquia.
    // Preserva leads já mais avançados (interessado/follow-up/agendado/fechado).
    try {
      const { data: existingLead } = await supabase
        .from("leads_extraidos")
        .select("id, status, instance_name")
        .eq("remoteJid", target.remote_jid)
        .eq("client_id", clientId)
        .maybeSingle();

      const nowIso = new Date().toISOString();
      // Mesma hierarquia usada em /api/ai-organize
      const STATUS_RANK: Record<string, number> = {
        "": 0, "novo": 0,
        "primeiro_contato": 1,
        "interessado": 2,
        "follow-up": 3,
        "agendado": 4,
        "fechado": 5,
      };
      const PRIMEIRO_RANK = 1;

      if (existingLead) {
        const currentRank = STATUS_RANK[existingLead.status || ""] ?? 0;
        if (currentRank < PRIMEIRO_RANK) {
          const { error: updErr } = await supabase
            .from("leads_extraidos")
            .update({
              status: "primeiro_contato",
              instance_name: effectiveInstanceName,
              primeiro_contato_at: nowIso,
              primeiro_contato_source: "disparo",
              updated_at: nowIso,
            })
            .eq("id", existingLead.id)
            .eq("client_id", clientId);
          if (updErr) {
            // Fallback: algumas colunas podem não existir ainda
            if ((updErr as any).code === "PGRST204") {
              await supabase.from("leads_extraidos")
                .update({ status: "primeiro_contato", instance_name: effectiveInstanceName })
                .eq("id", existingLead.id)
                .eq("client_id", clientId);
              console.warn(`[CAMPAIGN ${c.name}] leads_extraidos sem colunas primeiro_contato_at/source. Rode a migração correspondente.`);
            } else {
              throw updErr;
            }
          }
          await addCampaignLog(campaignId, `Lead ${target.nome_negocio || target.remote_jid} movido p/ primeiro_contato`, "info");
        } else {
          // Sticky Sender: registra o chip que abordou caso o lead vindo do scraper ainda não tenha instance_name
          if (!existingLead.instance_name) {
            await supabase
              .from("leads_extraidos")
              .update({ instance_name: effectiveInstanceName })
              .eq("id", existingLead.id)
              .eq("client_id", clientId)
              .then(() => {}, () => {});
          }
          await addCampaignLog(campaignId, `Lead ${target.nome_negocio || target.remote_jid} mantido no status "${existingLead.status}" (mais avançado que primeiro_contato)`, "info");
        }
      } else {
        // Sem lead — cria no estágio primeiro_contato direto vinculando ao chip real que disparou (Sticky Sender)
        const { error: insErr } = await supabase.from("leads_extraidos").insert({
          client_id: clientId,
          instance_name: effectiveInstanceName,
          remoteJid: target.remote_jid,
          nome_negocio: target.nome_negocio || `Lead Disparo (${target.remote_jid.split("@")[0]})`,
          ramo_negocio: target.ramo_negocio || null,
          status: "primeiro_contato",
          primeiro_contato_at: nowIso,
          primeiro_contato_source: "disparo",
        });
        if (insErr && (insErr as any).code === "PGRST204") {
          await supabase.from("leads_extraidos").insert({
            client_id: clientId,
            instance_name: effectiveInstanceName,
            remoteJid: target.remote_jid,
            nome_negocio: target.nome_negocio || `Lead Disparo (${target.remote_jid.split("@")[0]})`,
            ramo_negocio: target.ramo_negocio || null,
            status: "primeiro_contato",
          });
        } else if (insErr) {
          throw insErr;
        }
        await addCampaignLog(campaignId, `Lead criado p/ ${target.remote_jid} em primeiro_contato`, "info");
      }
    } catch (leadErr: any) {
      const msg = `⚠ Falha ao mover lead para primeiro_contato: ${leadErr?.message || leadErr}`;
      console.warn(`[CAMPAIGN ${c.name}] ${msg}`);
      await addCampaignLog(campaignId, msg, "warning");
    }

    consecutiveFailures.set(campaignId, 0);
    // Log com a MENSAGEM REAL enviada (truncada pra 240 chars). Operador
    // precisa ver o que foi enviado pra cada lead, não só "OK".
    const preview = String(finalText || "").replace(/\s+/g, " ").slice(0, 240);
    const successMsg = `✓ Enviada → ${target.nome_negocio || target.remote_jid}${chunks.length > 1 ? ` (${chunks.length} partes)` : ""}\n📨 "${preview}${(finalText || "").length > 240 ? "…" : ""}"`;
    console.log(`[CAMPAIGN ${c.name}] ${successMsg}`);
    await addCampaignLog(campaignId, successMsg, "success");
    return "continue";
  } catch (err: any) {
    const msg = err?.message || String(err);
    const is429 = /429|rate|too many/i.test(msg);

    // Evolution retorna 400 com payload { exists: false } quando o número não tem WhatsApp.
    // Isso NÃO é erro nosso — é dado ruim no lead. Pula, não conta como "consecutive failure",
    // e marca como skipped pra o operador saber que o número é inválido.
    const numberDoesNotExist = /"exists"\s*:\s*false/i.test(msg) || /number does not exist|not exists/i.test(msg);

    if (numberDoesNotExist) {
      await supabase.from("campaign_targets").update({
        status: "skipped",
        error_message: "Número não existe no WhatsApp",
        attempts: (target.attempts || 0) + 1,
      }).eq("id", target.id);

      await supabase.from("campaigns").update({
        skipped_count: (c.skipped_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId);

      consecutiveFailures.set(campaignId, 0); // reseta — não é falha real
      const skipMsg = `⊘ Pulado ${target.remote_jid} — número não existe no WhatsApp`;
      console.log(`[CAMPAIGN ${c.name}] ${skipMsg}`);
      await addCampaignLog(campaignId, skipMsg, "warning");
      return "continue";
    }

    const fails = (consecutiveFailures.get(campaignId) || 0) + 1;
    consecutiveFailures.set(campaignId, fails);

    // Reporta falhas reais de transporte/rate limit para o score e disjuntor do Aquecedor
    try {
      if (is429 || /timeout|timed out|econn|disconnect|closed|401|403|50[0-4]/i.test(msg)) {
        const { data: wCfg } = await supabase
          .from("whatsapp_warmup_configs")
          .select("*")
          .eq("client_id", clientId)
          .eq("instance_name", effectiveInstanceName)
          .maybeSingle();
        if (wCfg) {
          const { handleInstanceFailure } = await import("@/lib/warmup/warmup-engine");
          await handleInstanceFailure(clientId, wCfg as any, `[Campanha] ${msg}`);
        }
      }
    } catch {}

    await supabase.from("campaign_targets").update({
      status: is429 && (target.attempts || 0) < 3 ? "pending" : "failed",
      error_message: msg.slice(0, 300),
      attempts: (target.attempts || 0) + 1,
    }).eq("id", target.id);

    if (!is429) {
      await supabase.from("campaigns").update({
        failed_count: (c.failed_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId);
    }

    const errorMsg = `✗ Falha em ${target.remote_jid}: ${msg}`;
    console.error(`[CAMPAIGN ${c.name}] ${errorMsg}`);
    await addCampaignLog(campaignId, errorMsg, "error");

    // Após 5 falhas REAIS seguidas → pausa automática
    if (fails >= 5) {
      await supabase.from("campaigns").update({ status: "paused", updated_at: new Date().toISOString() }).eq("id", campaignId);
      const pauseMsg = `5 falhas seguidas — Campanha PAUSADA automaticamente por segurança.`;
      console.warn(`[CAMPAIGN ${c.name}] ${pauseMsg}`);
      await addCampaignLog(campaignId, pauseMsg, "error");
      return "stopped";
    }
    return "continue";
  }
}

function scheduleNext(campaignId: string, delayMs: number) {
  // Limpa timer anterior se existir
  const old = runningTimers.get(campaignId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => loop(campaignId).catch(e => console.error("[CAMPAIGN loop error]", e)), delayMs);
  runningTimers.set(campaignId, t);
}

async function loop(campaignId: string) {
  try {
    const result = await processNextTarget(campaignId);
    if (result === "done" || result === "stopped") {
      runningTimers.delete(campaignId);
      return;
    }
    if (result === "out_of_hours") {
      await addCampaignLog(campaignId, "Fora da janela permitida. Aguardando 5 min para rechecar...", "info");
      scheduleNext(campaignId, 5 * 60 * 1000); // tenta em 5 min
      return;
    }
    if (result === "cold_cap_rest") {
      scheduleNext(campaignId, 15 * 60 * 1000); // descansa 15 min quando teto da hora foi atingido
      return;
    }
    // Próximo envio com jitter ou Coffee-Break em lotes
    const { data: c } = await supabase
      .from("campaigns")
      .select("instance_name, min_interval_seconds, max_interval_seconds")
      .eq("id", campaignId)
      .single();
    if (result === "too_soon") {
      // Loop concorrente adiantado — o gate de intervalo barrou o envio.
      // Reagenda no ritmo normal; o loop "dono" segue enviando sozinho.
      const wait = jitterMs(Number(c?.min_interval_seconds || 30), Number(c?.max_interval_seconds || 60));
      scheduleNext(campaignId, wait);
      return;
    }

    const lastSel = _lastSelectedInstanceByCampaign.get(campaignId);
    const activeInstance = lastSel?.instanceName || (c as any)?.instance_name || "default";
    const coldShieldOn = lastSel?.coldShieldEnabled !== false;
    const delayCalc = computeCampaignNextDelayMs({
      instanceName: activeInstance,
      minIntervalSec: Number(c?.min_interval_seconds || 30),
      maxIntervalSec: Number(c?.max_interval_seconds || 60),
      stageMinIntervalSec: coldShieldOn ? lastSel?.stageMinIntervalSec : undefined,
      bypassBatchBreak: !coldShieldOn,
    });

    const secs = Math.round(delayCalc.delayMs / 1000);
    if (delayCalc.isCoffeeBreak) {
      const mins = Math.round(secs / 60);
      console.log(`[CAMPAIGN ${campaignId}] Coffee-Break Anti-Ban: descansando ${mins} min após lote de ${delayCalc.batchCount} envios.`);
      await addCampaignLog(
        campaignId,
        `☕ Pausa anti-ban de lote (${mins} min) após ${delayCalc.batchCount} abordagens — simulando rotina humana para proteger o chip.`,
        "info"
      );
    } else {
      console.log(`[CAMPAIGN ${campaignId}] Próximo envio em ${secs}s`);
      await addCampaignLog(campaignId, `Aguardando ${secs}s até o próximo envio...`, "info");
    }
    scheduleNext(campaignId, delayCalc.delayMs);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[CAMPAIGN ${campaignId}] Erro inesperado no loop:`, msg);
    await addCampaignLog(campaignId, `Erro inesperado no loop: ${msg}. Tentando de novo em 30s.`, "error");
    // Não deixa a campanha morrer por um erro pontual — reagenda em 30s.
    scheduleNext(campaignId, 30_000);
  }
}

/**
 * Jitter humanizado (1.5s a 3.5s) entre consultas `onWhatsApp` (`USyncQuery`) na pré-validação,
 * evitando rajadas sincronizadas que levantam flag anti-automação na Meta.
 */
export function calculatePreValidateJitterMs(): number {
  return 1500 + Math.floor(Math.random() * 2001);
}

/**
 * Em modo Pool Automático (`__auto_pool__`), escolhe preferencialmente um chip standby/contingência
 * saudável (com menor carga fria e diferente do disparador principal ativo) para executar
 * `USyncQuery (onWhatsApp)`, evitando picos de consultas no chip que está disparando agora.
 */
export async function resolvePreValidationChip(
  clientId: string,
  campaignInstanceName: string,
  campaignId?: string,
  nowMs = Date.now()
): Promise<string | null> {
  if (!isAutoPoolInstance(campaignInstanceName)) {
    return campaignInstanceName || null;
  }

  try {
    let { data: warmupRows, error } = await supabase
      .from("whatsapp_warmup_configs")
      .select("instance_name, enabled, stage, health_score, is_quarantined, quarantine_until, purpose, career_mode, mmzap_browser_status")
      .eq("client_id", clientId);

    if (
      error &&
      (String(error.code || "") === "42703" ||
        String(error.code || "") === "PGRST204" ||
        /column/i.test(String(error.message || "")))
    ) {
      const legacy = await supabase
        .from("whatsapp_warmup_configs")
        .select("instance_name, enabled, stage, health_score, is_quarantined, quarantine_until, purpose")
        .eq("client_id", clientId);
      warmupRows = legacy.data as typeof warmupRows;
      error = legacy.error;
    }

    const { data: connRows } = await supabase
      .from("channel_connections")
      .select("instance_name, status")
      .eq("client_id", clientId);

    const openSet = new Set<string>();
    for (const r of connRows || []) {
      const inst = String((r as any)?.instance_name || "");
      const st = String((r as any)?.status || "").toLowerCase();
      if (inst && (st === "open" || st === "connected" || st === "online")) {
        openSet.add(inst);
      }
    }

    if (!error && Array.isArray(warmupRows) && warmupRows.length > 0) {
      const hasConnInventory = Array.isArray(connRows) && connRows.length > 0;
      const activeSender = campaignId ? _lastSelectedInstanceByCampaign.get(campaignId)?.instanceName || null : null;
      const scored = warmupRows
        .filter((r: any) => {
          const inst = String(r?.instance_name || "");
          if (!inst) return false;
          if (hasConnInventory && !openSet.has(inst)) return false;
          const quarantined =
            Boolean(r.is_quarantined) &&
            Boolean(r.quarantine_until) &&
            new Date(String(r.quarantine_until)).getTime() > nowMs;
          if (quarantined) return false;
          if (r.career_mode === "rehab") return false;
          if (Number(r.health_score ?? 100) < 50) return false;
          return true;
        })
        .map((r: any) => {
          const inst = String(r.instance_name);
          const counts = getColdSendCounts(inst, nowMs);
          const purpose = String(r.purpose || "").toLowerCase();
          const isStandby = purpose === "contingency" || purpose === "standby" || purpose === "inbound" || purpose === "backup";
          const isActiveColdSender = (activeSender && inst === activeSender) || counts.hourlyCount > 0;
          let score = Number(r.health_score ?? 100);
          if (isStandby) score += 120;
          if (!isActiveColdSender) score += 100;
          if (activeSender && inst === activeSender) score -= 180;
          score -= counts.dailyCount * 4;
          score -= counts.hourlyCount * 25;
          if (Number(r.stage || 1) <= 1) score -= 60;
          if (String(r.mmzap_browser_status || "").toLowerCase() === "running") score -= 35;
          return { inst, score };
        })
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        return scored[0].inst;
      }
    }
  } catch {
    /* fallback seguro para resolveHealthyCampaignChip */
  }

  const poolChoice = await resolveHealthyCampaignChip(clientId, campaignInstanceName, { dryRun: true, nowMs });
  return poolChoice.ok && poolChoice.instanceName ? poolChoice.instanceName : null;
}

/**
 * Pré-valida um lote reduzido (padrão 6) de números pendentes de uma campanha com antecedência
 * e jitter humanizado (1.5s–3.5s), armazenando o JID canônico em cache para desacoplar
 * `USyncQuery (onWhatsApp)` do momento do `sendMessage`.
 * Em `__auto_pool__`, prioriza chip standby/contingência em vez do disparador frio ativo.
 */
export async function preValidateCampaignNumbers(
  campaignId: string,
  maxBatch = 6
): Promise<{ checked: number; skippedInvalid: number; instanceUsed?: string | null }> {
  let checked = 0;
  let skippedInvalid = 0;
  let checkInstance: string | null = null;
  try {
    const { data: c } = await supabase
      .from("campaigns")
      .select("id, client_id, instance_name, status, skipped_count")
      .eq("id", campaignId)
      .maybeSingle();
    if (!c || c.status !== "running") return { checked: 0, skippedInvalid: 0, instanceUsed: null };

    checkInstance = await resolvePreValidationChip(c.client_id, c.instance_name, campaignId);
    if (!checkInstance) return { checked: 0, skippedInvalid: 0, instanceUsed: null };

    const { data: targets } = await supabase
      .from("campaign_targets")
      .select("id, remote_jid")
      .eq("campaign_id", campaignId)
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(maxBatch);

    if (!Array.isArray(targets) || targets.length === 0) {
      return { checked: 0, skippedInvalid: 0, instanceUsed: checkInstance };
    }

    for (let idx = 0; idx < targets.length; idx++) {
      const t = targets[idx];
      const rjid = String((t as any).remote_jid || "");
      if (!rjid || rjid.includes("@g.us") || rjid.includes("@lid")) continue;
      const phone = rjid.replace(/@.*$/, "").replace(/\D/g, "");
      if (!phone) continue;
      if (getCachedCanonicalJid(checkInstance, phone)) continue;

      if (checked > 0 && process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
        await new Promise((r) => setTimeout(r, calculatePreValidateJitterMs()));
      }

      try {
        const res = await channel.checkWhatsAppNumbersDetailed([phone], checkInstance);
        const entry = res?.[phone] || (res ? Object.values(res)[0] : null);
        checked++;
        if (entry) {
          cacheVerifiedCanonicalJid(checkInstance, phone, {
            exists: entry.exists !== false,
            jid: entry.jid,
          });
          if (entry.exists === false) {
            skippedInvalid++;
            await supabase
              .from("campaign_targets")
              .update({
                status: "skipped",
                error_message: "Número não existe no WhatsApp (pré-validação antecipada)",
                attempts: 1,
              })
              .eq("id", (t as any).id);
          } else if (entry.jid && entry.jid !== rjid) {
            await supabase
              .from("campaign_targets")
              .update({ remote_jid: entry.jid })
              .eq("id", (t as any).id);
            try {
              const { error: leadJidErr } = await supabase
                .from("leads_extraidos")
                .update({ remoteJid: entry.jid })
                .eq("remoteJid", rjid)
                .eq("client_id", c.client_id);
              if (leadJidErr && (leadJidErr.code === "23505" || String(leadJidErr.message || "").includes("unique"))) {
                // JID canônico já existe em leads_extraidos — evita duplicidade sem falhar a pré-validação
              }
            } catch {}
          }
        }
      } catch {}
    }

    if (skippedInvalid > 0) {
      await supabase
        .from("campaigns")
        .update({
          skipped_count: (Number((c as any).skipped_count) || 0) + skippedInvalid,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId);
    }
  } catch {}
  return { checked, skippedInvalid, instanceUsed: checkInstance };
}

export async function startCampaign(campaignId: string): Promise<{ ok: boolean; error?: string }> {
  // Preflight — falha cedo com mensagem clara, em vez de deixar a campanha sofrer em silêncio.
  const check = await preflightCheck(campaignId);
  if (!check.ok) {
    await addCampaignLog(campaignId, `Preflight falhou: ${check.error}`, "error");
    await supabase.from("campaigns").update({
      status: "draft", // volta pra draft — a campanha não chegou a rodar
      last_error: check.error!.slice(0, 500),
      last_error_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
    return { ok: false, error: check.error };
  }

  await supabase.from("campaigns").update({
    status: "running",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
  }).eq("id", campaignId);
  consecutiveFailures.set(campaignId, 0);

  // Primeiro envio respeita o INTERVALO CONFIGURADO da campanha — não um
  // "burst" de 1-3s. O cliente definiu o ritmo do disparo (anti-ban); a 1ª
  // mensagem também o segue.
  const { data: cfgRow } = await supabase
    .from("campaigns")
    .select("min_interval_seconds, max_interval_seconds")
    .eq("id", campaignId)
    .maybeSingle();
  const firstDelay = jitterMs(
    Number(cfgRow?.min_interval_seconds || 30),
    Number(cfgRow?.max_interval_seconds || 60),
  );
  await addCampaignLog(campaignId,
    `Preflight OK. 1º disparo em ~${Math.round(firstDelay / 1000)}s (ritmo configurado da campanha).`, "success");
  scheduleNext(campaignId, firstDelay);

  // PRÉ-VALIDAÇÃO DE JIDs + PRÉ-GERAÇÃO COM IA: começam JÁ em background,
  // desacoplando a consulta `onWhatsApp (USyncQuery)` e a geração de texto
  // do momento exato do envio.
  preValidateCampaignNumbers(campaignId).catch(() => {});

  {
    const { data: camp } = await supabase.from("campaigns").select("personalize_with_ai").eq("id", campaignId).maybeSingle();
    if (camp?.personalize_with_ai) {
      preGenerateCampaignMessages(campaignId).catch(e =>
        console.error(`[CAMPAIGN ${campaignId}] pré-geração falhou:`, (e as Error)?.message));
    }
  }
  return { ok: true };
}

/**
 * Recupera campanhas marcadas como "running" no banco mas sem timer em memória.
 * Chamado no boot do servidor (instrumentation.ts).
 */
export async function recoverRunningCampaigns(): Promise<number> {
  // ponytail: sem lease/version no banco, um target "processing" pode ter a
  // mensagem já entregue ao provider; reenfileirar aqui reenviaria o WhatsApp.
  // Preferimos pausar para revisão manual (perde envio, não duplica). Adicionar
  // reenvio quando existir idempotency/lease persistido.
  try {
    const { data: stuck, error: stuckErr } = await supabase
      .from("campaign_targets")
      .select("campaign_id")
      .eq("status", "processing");
    if (stuckErr) throw stuckErr;

    const stuckCampaignIds = [...new Set((stuck || []).map((r: any) => r.campaign_id).filter(Boolean))];
    let pausedByRecovery = 0;
    for (const stuckCampaignId of stuckCampaignIds) {
      const msg = "Recuperação encontrou target(s) em 'processing'. Para evitar reenvio duplicado após crash, a campanha foi pausada; revise o envio no WhatsApp e retome manualmente.";
      const { data: pausedRows } = await supabase
        .from("campaigns")
        .update({ status: "paused", last_error: msg, last_error_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", stuckCampaignId)
        .eq("status", "running")
        .select("id");
      if (Array.isArray(pausedRows) && pausedRows.length > 0) {
        pausedByRecovery++;
        await addCampaignLog(stuckCampaignId, msg, "error");
      }
    }
    if (pausedByRecovery > 0) {
      console.warn(`[CAMPAIGN RECOVER] ${pausedByRecovery} campanha(s) pausada(s) por processing ambíguo.`);
    }
  } catch (e) {
    console.error("[CAMPAIGN RECOVER] falha ao auditar processing — retries manuais necessários:", (e as Error).message);
    return 0;
  }

  const { data: running } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("status", "running");
  let recovered = 0;
  for (const c of running || []) {
    if (runningTimers.has(c.id)) continue;
    console.log(`[CAMPAIGN RECOVER] Retomando "${c.name}" (${c.id}) após restart do servidor.`);
    await addCampaignLog(c.id, "Servidor reiniciou — retomando a campanha automaticamente.", "warning");
    consecutiveFailures.set(c.id, 0);
    scheduleNext(c.id, 2000 + Math.floor(Math.random() * 3000));
    recovered++;
  }
  return recovered;
}

/**
 * REDE DE SEGURANÇA do disparo. Chamada por um ticker periódico
 * (instrumentation.ts). Procura campanhas `running` no banco que NÃO têm
 * timer ativo na memória do processo e as reativa.
 *
 * Por que isto existe: o avanço do disparo depende de uma corrente de
 * `setTimeout` em memória. Qualquer coisa que quebre essa corrente —
 * restart do servidor, deploy, processo dormindo, o timer de "fora de
 * horário" morrendo de madrugada — deixava a campanha `running` parada
 * PRA SEMPRE, sem ninguém pra retomar (o `recoverRunningCampaigns` só roda
 * no boot). Este tick roda a cada ~90s e ressuscita qualquer campanha órfã.
 *
 * Idempotente: se a campanha já tem timer, é ignorada. Só age em órfãs.
 */
export async function tickRunningCampaigns(): Promise<number> {
  const { data: running } = await supabase
    .from("campaigns")
    .select("id, name, max_interval_seconds, updated_at")
    .eq("status", "running");
  let revived = 0;
  for (const c of running || []) {
    if (runningTimers.has(c.id)) continue; // já tem timer — tudo certo

    // Só revive se a campanha está REALMENTE parada: última atividade
    // (updated_at) há mais que o intervalo máximo + 5min de folga. Uma
    // campanha saudável, apenas esperando entre um envio e outro, NÃO é
    // tocada — reativá-la criaria um loop concorrente e, com ele, o burst
    // de envios em rajada. O gate de intervalo ainda protege como 2ª linha.
    const maxGapMs = (Number(c.max_interval_seconds) || 60) * 1000 + 5 * 60_000;
    const idleMs = Date.now() - new Date(c.updated_at || 0).getTime();
    if (idleMs < maxGapMs) continue;

    // ponytail: sem lease, "processing" pode representar envio já aceito pelo
    // provider. Não destravamos automaticamente: pausamos para revisão e
    // preferimos perder a retomada a disparar duplicado.
    try {
      const { count: stuckCount, error: stuckErr } = await supabase
        .from("campaign_targets")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", c.id)
        .eq("status", "processing");
      if (stuckErr) throw stuckErr;
      if ((stuckCount || 0) > 0) {
        const msg = `Auto-recuperação encontrou ${stuckCount} target(s) em processing. Campanha pausada para evitar reenvio duplicado; revise manualmente.`;
        await supabase
          .from("campaigns")
          .update({ status: "paused", last_error: msg, last_error_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", c.id)
          .eq("status", "running");
        await addCampaignLog(c.id, msg, "error");
        continue;
      }
    } catch (e) {
      console.warn("[CAMPAIGN TICK] auditoria de processing falhou:", (e as Error).message);
      continue;
    }

    console.log(`[CAMPAIGN TICK] "${c.name}" (${c.id}) está running mas sem timer — reativando.`);
    await addCampaignLog(c.id, "🔄 Disparo reativado automaticamente (auto-recuperação — o timer havia sido perdido).", "warning");
    consecutiveFailures.set(c.id, 0);
    scheduleNext(c.id, 1500 + Math.floor(Math.random() * 2500));
    revived++;
  }
  return revived;
}

export async function pauseCampaign(campaignId: string): Promise<void> {
  const t = runningTimers.get(campaignId);
  if (t) { clearTimeout(t); runningTimers.delete(campaignId); }
  await supabase.from("campaigns").update({ status: "paused", updated_at: new Date().toISOString() }).eq("id", campaignId);
}

export async function cancelCampaign(campaignId: string): Promise<void> {
  const t = runningTimers.get(campaignId);
  if (t) { clearTimeout(t); runningTimers.delete(campaignId); }
  await supabase.from("campaigns").update({ status: "cancelled", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", campaignId);
}

export function isCampaignActive(campaignId: string): boolean {
  return runningTimers.has(campaignId);
}

/* ============================================================
   PERSONALIZAÇÃO COM IA (opcional, com web_search opcional)
   ============================================================ */

/**
 * PRÉ-GERAÇÃO DE MENSAGENS COM IA — roda no startCampaign (e pode ser chamada
 * fora da janela de horário). Para cada target pending, gera o texto
 * personalizado e grava em campaign_targets.rendered_message. O envio depois
 * só lê o texto pronto — sem chamada de IA no momento do disparo.
 *
 * Gravação é condicional (status=pending AND rendered_message IS NULL via
 * re-fetch): target já enviado/pré-gerado por outro caminho não é sobrescrito.
 * Falha individual de IA NÃO marca erro — o envio tenta de novo na hora.
 */
export async function preGenerateCampaignMessages(campaignId: string): Promise<{ ok: boolean; generated: number; skipped: number; failed: number; error?: string }> {
  const { data: c } = await supabase.from("campaigns").select("*").eq("id", campaignId).maybeSingle();
  if (!c) return { ok: false, generated: 0, skipped: 0, failed: 0, error: "Campanha não encontrada" };
  if (!c.client_id) return { ok: false, generated: 0, skipped: 0, failed: 0, error: "Campanha sem client_id" };
  if (!c.personalize_with_ai) return { ok: true, generated: 0, skipped: 0, failed: 0 };
  if (c.status !== "running") return { ok: false, generated: 0, skipped: 0, failed: 0, error: "Campanha não está running" };

  // Quando Teste A/B está habilitado, a variante (A ou B) e a auto-pausa precisam ser decididas no momento do envio.
  const abCfg = await getCampaignAbConfig(campaignId).catch(() => null);
  if (abCfg?.enabled) {
    return { ok: true, generated: 0, skipped: 0, failed: 0 };
  }

  const { data: targets } = await supabase
    .from("campaign_targets")
    .select("id, remote_jid, nome_negocio, ramo_negocio")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .is("rendered_message", null)
    .order("created_at", { ascending: true });
  if (!targets || targets.length === 0) {
    await addCampaignLog(campaignId, "🧠 Pré-geração: nenhuma mensagem pendente de gerar.", "info");
    return { ok: true, generated: 0, skipped: 0, failed: 0 };
  }

  const foraDaJanela = !isWithinAllowedHour(c as any);
  await addCampaignLog(campaignId,
    `🧠 Pré-gerando ${targets.length} mensagem(ns) com IA${foraDaJanela ? " (fora da janela de envio — o disparo espera, a IA não)" : ""}...`, "info");

  const { antibanMixerEnabled } = await resolveCampaignAntiBanContext(c);

  let generated = 0, failed = 0, skipped = 0;
  for (const target of targets) {
    const leadFull: any = await fetchLeadFullForCampaign(target.remote_jid, c.client_id);
    const rawCompanyName = leadFull?.nome_negocio || target.nome_negocio;
    const effectiveCompanyName = antibanMixerEnabled
      ? cleanCompanyNameForApproach(rawCompanyName) || rawCompanyName
      : rawCompanyName;
    const windowRefDate = effectiveDateForWindow(new Date(), c.allowed_start_hour, c.allowed_end_hour);
    const renderCtx = {
      ...leadRowToTemplateContext(leadFull, {
        remoteJid: target.remote_jid,
        nome_negocio: effectiveCompanyName,
        ramo_negocio: leadFull?.ramo_negocio || target.ramo_negocio,
        push_name: null,
      }),
      now: windowRefDate,
    };

    let baseText = renderTemplate(c.message_template, renderCtx, { spintax: true });
    if (antibanMixerEnabled) {
      baseText = applyAntiBanMixer({
        template: c.message_template,
        renderedText: baseText,
        companyName: effectiveCompanyName,
        rating: renderCtx.avaliacao ?? renderCtx.nota ?? null,
        reviews: renderCtx.reviews ?? renderCtx.avaliacoes ?? null,
        ramo: renderCtx.ramo_negocio || renderCtx.categoria || null,
        now: windowRefDate,
        scopeKey: c.id,
      });
    }
    let text = baseText;
    try {
      const aiText = await personalizeWithAI({
        baseMessage: baseText,
        model: c.ai_model || "gemini-1.5-flash",
        customPrompt: c.ai_prompt ? renderTemplate(c.ai_prompt, renderCtx) : null,
        nomeEmpresa: effectiveCompanyName || "",
        ramo: target.ramo_negocio || "",
        useWebSearch: !!c.use_web_search,
        campaignId: c.id,
        campaignName: c.name,
        remoteJid: target.remote_jid,
        clientId: c.client_id,
      });
      if (aiText && aiText.trim()) text = aiText.trim();
    } catch (e: any) {
      failed++;
      console.warn(`[CAMPAIGN ${c.name}] Pré-geração falhou p/ ${target.nome_negocio}: ${e?.message}`);
      continue; // envio tenta de novo na hora
    }

    // Rede de segurança — mesma blindagem do caminho de envio: nenhuma
    // {{variavel}} pode sobreviver à IA.
    text = renderTemplate(text, renderCtx, { spintax: true });
    if (/\{\{.*?\}\}|\{.*?\}/.test(text)) {
      text = text
        .replace(/\{\{\s*[\w-]+\s*\}\}/g, "")
        .replace(/\{\s*[\w-]+\s*\}/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([.,!?])/g, "$1")
        .trim();
    }

    text = enforceShortHandshakeGuard({
      template: c.message_template,
      candidateText: text,
      companyName: leadFull?.nome_negocio || target.nome_negocio,
      rating: renderCtx.avaliacao ?? renderCtx.nota ?? null,
      reviews: renderCtx.reviews ?? renderCtx.avaliacoes ?? null,
      ramo: renderCtx.ramo_negocio || renderCtx.categoria || null,
      now: windowRefDate,
      scopeKey: c.id,
    });

    // Grava SÓ se ainda pending e ainda sem mensagem (não pisa em já enviado).
    const { data: upd } = await supabase
      .from("campaign_targets")
      .update({ rendered_message: text, ai_input: baseText })
      .eq("id", target.id)
      .eq("status", "pending")
      .is("rendered_message", null)
      .select("id")
      .maybeSingle();
    if (upd) {
      generated++;
      await addCampaignLog(campaignId,
        `🧠 IA preparou msg de ${target.nome_negocio || target.remote_jid}: "${text.slice(0, 100)}${text.length > 100 ? "…" : ""}"`, "success");
    } else {
      skipped++;
    }
    await new Promise(r => setTimeout(r, 400)); // respiro entre chamadas de IA
  }

  await addCampaignLog(campaignId,
    `🧠 Pré-geração concluída: ${generated} pronta(s) · ${skipped} pulada(s) · ${failed} falha(s) (envio tenta de novo).`,
    failed > 0 ? "warning" : "success");
  return { ok: true, generated, skipped, failed };
}

async function personalizeWithAI(opts: {
  baseMessage: string;
  model: string;
  customPrompt?: string | null;
  nomeEmpresa: string;
  ramo: string;
  useWebSearch: boolean;
  campaignId?: string;
  campaignName?: string;
  /** remoteJid pra puxar o briefing cacheado de lead-intelligence (se houver). */
  remoteJid?: string;
  clientId: string;
}): Promise<string> {
  // API keys centrais — mesmas que o resto do sistema usa (Configurações).
  const { getAiKeys } = await import("@/lib/ai-keys");
  const { startAiChat, providerOf, providerDisplayName } = await import("@/lib/ai-provider");
  const { resolveModel } = await import("@/lib/ai-default-model");
  const keys = await getAiKeys();

  const modelId = (await resolveModel(opts.model)) || opts.model;
  const provider = providerOf(modelId);
  if (provider === "gemini" && !keys.gemini) throw new Error("Sem API key Gemini configurada. Salve em Configurações.");
  if (provider === "openrouter" && !keys.openrouter) throw new Error("Sem API key OpenRouter configurada. Salve em Configurações.");

  // Ferramenta web_search (opcional) — declaração neutra (JSON Schema), funciona
  // tanto no Gemini quanto no OpenRouter.
  const tools = opts.useWebSearch ? [{
    name: "web_search",
    description: "Busca rápida na internet. Use pra descobrir algo específico sobre a empresa do cliente que tornaria a mensagem mais relevante.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "O que buscar — frase curta" } },
      required: ["query"],
    },
  }] : [];

  // Se há briefing IA cacheado pra esse lead, injeta como contexto.
  // Esse pedaço entra ANTES das instruções — IA vê o ICP, dores, ângulo
  // recomendado, e personaliza muito melhor sem gastar tokens chamando outra
  // análise. O contexto é compacto (~50-100 tokens).
  let intelContext = "";
  if (opts.remoteJid) {
    try {
      const { getCachedIntelligence, intelligenceToPromptContext } = await import("@/lib/lead-intelligence");
      const intel = await getCachedIntelligence(opts.remoteJid, opts.clientId);
      if (intel) intelContext = intelligenceToPromptContext(intel) + "\n\n";
    } catch (e) {
      // Não-fatal — segue sem briefing.
    }
  }

  // Se a campanha tem um prompt custom salvo, usa ele. Senão usa o padrão.
  const isPraiseOpener = isPersonalizedPraiseOpenerTemplate(opts.baseMessage);
  const isHandshake = isShortIcebreakerTemplate(opts.baseMessage);
  const customInstructions = opts.customPrompt?.trim();
  const sys = customInstructions
    ? `${customInstructions}

${intelContext}DADOS DO LEAD:
- Empresa: ${opts.nomeEmpresa || "(não informada)"}
- Ramo: ${opts.ramo || "(não informado)"}

MENSAGEM-BASE (template do operador):
"""
${opts.baseMessage}
"""

${opts.useWebSearch ? "Ferramenta web_search disponível: use no máximo 1x pra pegar UM detalhe relevante da empresa." : ""}

Devolva APENAS a mensagem final, em PT-BR, sem aspas, sem explicação.`
    : isPraiseOpener
    ? `Você é uma pessoa real iniciando um primeiro contato de alta conversão via WhatsApp (Elogio Personalizado + Pergunta Fácil de 1 Palavra).

DADOS DO LEAD:
- Empresa: ${opts.nomeEmpresa || "(não informada)"}
- Ramo: ${opts.ramo || "(não informado)"}

MENSAGEM-BASE:
"""
${opts.baseMessage}
"""

REGRAS OBRIGATÓRIAS:
- Máximo 2 linhas curtas em PT-BR, variando a formulação de forma natural.
- Linha 1: saudação + elogio sincero à empresa/avaliação no Google (sem inventar notas).
- Linha 2: pergunta fácil de responder em 1 palavra sobre se usam site próprio ou mais Instagram e WhatsApp.
- PROIBIDO fazer pitch de vendas, falar de serviços/preços, colocar links ou fazer críticas ao negócio.
- Devolva APENAS a mensagem final, sem aspas e sem explicação.`
    : isHandshake
    ? `Você é uma pessoa real iniciando um primeiro contato rápido via WhatsApp para confirmar se está falando com a empresa certa (abordagem Two-Step Handshake anti-ban).

DADOS DO LEAD:
- Empresa: ${opts.nomeEmpresa || "(não informada)"}

MENSAGEM-BASE:
"""
${opts.baseMessage}
"""

REGRAS OBRIGATÓRIAS:
- Escreva APENAS 1 linha curta (máximo 12 palavras), natural como um cliente humano perguntando se é da empresa.
- PROIBIDO fazer oferta comercial, falar de serviços, preços ou colocar links.
- Devolva APENAS a frase final, sem aspas e sem explicação.`
    : `Você é um SDR experiente fazendo uma primeira abordagem PROFISSIONAL via WhatsApp.

${intelContext}DADOS DO LEAD:
- Empresa: ${opts.nomeEmpresa || "(não informada)"}
- Ramo: ${opts.ramo || "(não informado)"}

MENSAGEM-BASE (template do operador):
"""
${opts.baseMessage}
"""

INSTRUÇÕES:
- Reescreva a MENSAGEM-BASE de forma natural, curta (até 3 frases), em PT-BR.
- Mantenha o sentido original do template.
- Personalize SUTILMENTE pra empresa/ramo (sem inventar nada).
${opts.useWebSearch ? "- Se útil, use a tool web_search pra confirmar UM detalhe da empresa (1 chamada no máximo). NÃO repita pesquisas." : ""}
- Não use emojis exagerados.
- NÃO invente dados que não tem certeza.
- Devolva APENAS a mensagem final, sem aspas e sem explicação.`;

  // thinkingBudget=0: geração one-shot de mensagem de disparo não precisa de
  // raciocínio em cadeia (cobrado como saída, caro). Economiza sem perder nada.
  const session = await startAiChat({
    modelRef: modelId,
    systemInstruction: sys,
    history: [],
    tools,
    thinkingBudget: 0,
    geminiApiKey: keys.gemini,
    openrouterApiKey: keys.openrouter,
  });

  let turn = await session.sendUser(
    "Gere a mensagem final agora. IMPORTANTE: escreva o texto REAL e " +
    "completo, já preenchido com o nome da empresa e a saudação — " +
    "NUNCA use variáveis, chaves {{ }} nem colchetes na resposta."
  );

  // Acumula tokens
  let tp = turn.usage.promptTokens, tc = turn.usage.completionTokens, tt = turn.usage.totalTokens;
  let finalText = turn.text.replace(/^["']|["']$/g, "");

  // Trata 1 chamada de tool (web_search) se houver
  const call = turn.toolCalls[0];
  if (call && opts.useWebSearch && call.name === "web_search") {
    const q = String((call.args as any)?.query || "");
    try {
const results = await webSearch(q, 8);
        const summary = results.length > 0
          ? formatResultsForAI(results)
          : "Nenhum resultado.";
      turn = await session.sendToolResults([{ name: "web_search", id: call.id, response: { results: summary } }]);
      tp += turn.usage.promptTokens; tc += turn.usage.completionTokens; tt += turn.usage.totalTokens;
      finalText = turn.text.replace(/^["']|["']$/g, "");
    } catch {
      // mantém finalText anterior
    }
  }

  logTokenUsage({
    source: "disparo",
    sourceId: opts.campaignId || null,
    sourceLabel: opts.campaignName || "Disparo em Massa",
    model: session.modelUsed(),
    provider: providerDisplayName(provider),
    promptTokens: tp,
    completionTokens: tc,
    totalTokens: tt,
    clientId: opts.clientId,
    metadata: { useWebSearch: opts.useWebSearch, nomeEmpresa: opts.nomeEmpresa },
  });

  return finalText;
}

export interface CampaignMessagePreviewResult {
  renderedTemplate: string;
  mixedMessage: string;
  finalMessage: string;
  chunks: string[];
  usedAi: boolean;
  channelType: string;
}

/**
 * Gera uma prévia fiel de disparo (dry-run) usando exatamente o mesmo pipeline
 * de `renderTemplate`, Misturador Anti-Ban, `personalizeWithAI`, guardião
 * Two-Step Handshake e `splitMessage` — sem enviar WhatsApp nem gravar no DB.
 */
export async function previewCampaignMessageGeneration(opts: {
  lead: Record<string, unknown>;
  clientId: string;
  messageTemplate: string;
  personalizeWithAi?: boolean;
  aiModel?: string | null;
  aiPrompt?: string | null;
  useWebSearch?: boolean;
  antibanMixer?: boolean;
  humanizeMessages?: boolean;
  now?: Date;
}): Promise<CampaignMessagePreviewResult> {
  const now = opts.now || new Date();
  const lead = opts.lead || {};
  const bd =
    lead.business_details && typeof lead.business_details === "object"
      ? (lead.business_details as Record<string, unknown>)
      : {};
  const enr =
    bd.enrichment && typeof bd.enrichment === "object"
      ? (bd.enrichment as Record<string, unknown>)
      : {};
  const channelType =
    typeof enr.whatsappChannelType === "string" ? enr.whatsappChannelType : "indefinido";

  const rawCompanyName =
    typeof lead.nome_negocio === "string"
      ? lead.nome_negocio
      : typeof lead.name === "string"
        ? lead.name
        : "";
  const effectiveCompanyName = opts.antibanMixer
    ? cleanCompanyNameForApproach(rawCompanyName) || rawCompanyName
    : rawCompanyName;
  const ramoNegocio =
    typeof lead.ramo_negocio === "string"
      ? lead.ramo_negocio
      : typeof lead.categoria === "string"
        ? lead.categoria
        : "";

  const renderCtx = leadRowToTemplateContext(lead, {
    remoteJid: typeof lead.remoteJid === "string" ? lead.remoteJid : undefined,
    nome_negocio: effectiveCompanyName || rawCompanyName,
    ramo_negocio: ramoNegocio,
    now,
  });

  const renderedTemplate = renderTemplate(opts.messageTemplate, renderCtx, { spintax: true });
  let text = renderedTemplate;

  if (opts.antibanMixer) {
    text = applyAntiBanMixer({
      template: opts.messageTemplate,
      renderedText: text,
      companyName: effectiveCompanyName || rawCompanyName,
      rating: renderCtx.avaliacao ?? renderCtx.nota ?? null,
      reviews: renderCtx.reviews ?? renderCtx.avaliacoes ?? null,
      ramo: ramoNegocio || null,
      now,
      scopeKey: "dryrun-preview",
    });
  }
  const mixedMessage = text;

  let usedAi = false;
  if (opts.personalizeWithAi) {
    const aiText = await personalizeWithAI({
      baseMessage: text,
      model: opts.aiModel || "gemini-1.5-flash",
      customPrompt: opts.aiPrompt ? renderTemplate(opts.aiPrompt, renderCtx) : null,
      nomeEmpresa: effectiveCompanyName || rawCompanyName,
      ramo: ramoNegocio,
      useWebSearch: Boolean(opts.useWebSearch),
      campaignId: undefined,
      campaignName: "Dry-Run Preview",
      remoteJid: typeof lead.remoteJid === "string" ? lead.remoteJid : undefined,
      clientId: opts.clientId,
    });
    if (aiText && aiText.trim()) {
      text = aiText.trim();
      usedAi = true;
    }
  }

  text = renderTemplate(text, renderCtx, { spintax: true });
  if (/\{\{.*?\}\}|\{.*?\}/.test(text)) {
    text = text
      .replace(/\{\{\s*[\w-]+\s*\}\}/g, "")
      .replace(/\{\s*[\w-]+\s*\}/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([.,!?])/g, "$1")
      .trim();
  }

  text = enforceShortHandshakeGuard({
    template: opts.messageTemplate,
    candidateText: text,
    companyName: effectiveCompanyName || rawCompanyName,
    rating: renderCtx.avaliacao ?? renderCtx.nota ?? null,
    reviews: renderCtx.reviews ?? renderCtx.avaliacoes ?? null,
    ramo: ramoNegocio || null,
    now,
    scopeKey: "dryrun-preview",
  });

  const chunks = opts.humanizeMessages ? splitMessage(text) : [text];
  if (chunks.length === 0) chunks.push(text);

  return {
    renderedTemplate,
    mixedMessage,
    finalMessage: text,
    chunks,
    usedAi,
    channelType,
  };
}

export async function resetCampaign(campaignId: string): Promise<{ ok: boolean; error?: string }> {
  const { error: tErr } = await supabase
    .from("campaign_targets")
    .update({ status: "pending", attempts: 0, error_message: null, sent_at: null })
    .eq("campaign_id", campaignId);

  if (tErr) return { ok: false, error: tErr.message };

  const { count: pendingCount } = await supabase
    .from("campaign_targets")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "pending");

  await supabase
    .from("campaigns")
    .update({
      status: "draft",
      sent_count: 0,
      failed_count: 0,
      skipped_count: 0,
      last_error: null,
      total_targets: pendingCount || 0,
    })
    .eq("id", campaignId);

  return { ok: true };
}
