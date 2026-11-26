import { supabaseAdmin } from "@/lib/supabase_admin";
import { isClientActiveCached } from "@/lib/saas-limits";
import { isTenantWarmupAdmin } from "./warmup-admin-guard";
import { runWarmupSelfHealingForTenant } from "./warmup-self-healing";
import {
  calculateElapsedDaysFromCreatedAt,
  evaluateDailyAutoProgress,
  evaluateRehabGraduation,
  executeWarmupTurn,
  getAutoCareerPurpose,
  getBrazilDayKey,
  getCircadianHourlyCap,
  getMaxStageForDaysActive,
  getOrganicScheduleDecision,
  isBrazilWeekend,
  isWithinOperatingHours,
  logWarmupAction,
  runIsolatedStatusPost,
} from "./warmup-engine";
import {
  calculateInterConversationCooldownSec,
  pickEffectiveConversationTheme,
} from "./warmup-dialogues";
import { STAGE_DEFAULTS, type WarmupConfig, type WarmupConversation, type WarmupStage } from "./warmup-types";
import {
  cleanupDeadWarmupGroups,
  hydrateChipProfile,
  runInternalSwarmGroupCycle,
  syncGroupMembershipForChips,
} from "./warmup-groups";
import { ensureProxyForInstance, getProxyPoolOverviewCache } from "@/lib/proxy-pool";
import {
  ensureWarmupConfigsForTenant,
  listWarmupTenantIds,
  readTenantConnections,
  readTenantWarmupConfigs,
  isConnectedStatus,
  getEffectiveDailyTarget,
  readDailyResetState,
  writeDailyResetState,
  acquireWarmupTickLock,
  releaseWarmupTickLock,
  type TenantConnection,
} from "./warmup-config-service";
import {
  canonicalBrazilPhoneKey,
  isChipInSoftRecovery,
  mapWithConcurrency,
  pruneMapToLimit,
  readPhoneMemoryMap,
} from "./warmup-phone-memory";
import {
  drainDuePendingWarmupActions,
  shouldCheckPendingWarmupActions,
} from "./warmup-pending-actions";
import { tickMmzapBrowserOrchestrator } from "./mmzap-browser-orchestrator";

const _lastWarningLogged: Record<string, number> = {};

// A entrada em grupos é custosa e sensível a banimento: no máximo 1 sincronização
// por tenant a cada 10 minutos, sem chamadas concorrentes.
const GROUP_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const _lastGroupSyncAt: Record<string, number> = {};
const _groupSyncInFlight = new Set<string>();

// Controle em memória de pacing por hora, descanso entre conversas e pulsos simbióticos
const _hourlySendTimestamps = new Map<string, number[]>();
const _pairCooldownUntil = new Map<string, number>();
const _lastSymbioticPulseAt = new Map<string, number>();
const _hydratedWarmupTenants = new Set<string>();
const SYMBIOTIC_PULSE_COOLDOWN_MS = 4 * 60 * 1000;

export function resetWarmupWorkerRuntimeState(): void {
  _hourlySendTimestamps.clear();
  _pairCooldownUntil.clear();
  _lastSymbioticPulseAt.clear();
  _hydratedWarmupTenants.clear();
  _lastCampaignSkipWarnAt.clear();
}

async function hydrateWarmupHourlyCountsIfNeeded(clientId: string, nowMs = Date.now()): Promise<void> {
  if (_hydratedWarmupTenants.has(clientId)) return;
  _hydratedWarmupTenants.add(clientId);

  try {
    const oneHourAgoIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const q = supabaseAdmin
      .from("whatsapp_warmup_logs")
      .select("sender_instance, action_type, created_at")
      .eq("client_id", clientId) as unknown as {
        gte?: (col: string, val: string) => Promise<{
          data?: Array<{ sender_instance?: string; action_type?: string; created_at?: string }> | null;
        }>;
      };

    if (typeof q?.gte !== "function") return;
    const { data } = await q.gte("created_at", oneHourAgoIso);
    if (!Array.isArray(data)) return;

    for (const row of data) {
      if (!row?.sender_instance) continue;
      if (row.action_type !== "text" && row.action_type !== "audio") continue;
      const ts = row.created_at ? new Date(String(row.created_at)).getTime() : 0;
      if (!Number.isFinite(ts) || ts <= nowMs - 60 * 60 * 1000) continue;
      const prev = _hourlySendTimestamps.get(row.sender_instance) || [];
      prev.push(ts);
      _hourlySendTimestamps.set(row.sender_instance, prev);
    }
  } catch {
    /* opcional se banco/mock não suportar query temporal */
  }
}

/**
 * Seleciona par assimétrico para novas conversas na Colmeia:
 * - Quem INICIA: prefere chip mais veterano (maior estágio/dias), maior saúde, e que
 *   tenha menor razão `sent_today / max(1, received_today)`, evitando que chips novos
 *   ou marcados como "inbound" iniciem conversas contra chips maduros.
 */
/**
 * Seleciona múltiplos pares assimétricos disjuntos para novas conversas simultâneas na Colmeia,
 * permitindo escalabilidade horizontal para qualquer quantidade N de chips sem sobreposição.
 */
export function selectAsymmetricWarmupPairs(
  idleChips: WarmupConfig[],
  activePairs: Set<string>,
  maxPairs: number = 1,
  nowMs = Date.now()
): Array<{ initiator: WarmupConfig; partner: WarmupConfig }> {
  if (idleChips.length < 2 || maxPairs <= 0) return [];

  const initiatorScore = (c: WarmupConfig): number => {
    const stageScore = (c.stage || 1) * 100;
    const daysScore = Math.min(30, c.days_active || 1) * 3;
    const healthScore = Math.round((c.health_score ?? 100) * 0.5);
    const inboundSurplus = ((c.received_today || 0) - (c.sent_today || 0)) * 4;
    const purposeBias = c.purpose === "inbound" ? -35 : c.purpose === "outbound" ? 15 : 0;
    const rehabBias = c.career_mode === "rehab" ? -180 : 0;
    return stageScore + daysScore + healthScore + inboundSurplus + purposeBias + rehabBias;
  };

  const sortedForInitiator = [...idleChips].sort(
    (a, b) => initiatorScore(b) - initiatorScore(a)
  );
  const usedInTick = new Set<string>();
  const picked: Array<{ initiator: WarmupConfig; partner: WarmupConfig }> = [];

  for (const initiator of sortedForInitiator) {
    if (picked.length >= maxPairs) break;
    if (usedInTick.has(initiator.instance_name)) continue;

    const candidates = idleChips.filter((c) => {
      if (c.instance_name === initiator.instance_name) return false;
      if (usedInTick.has(c.instance_name)) return false;
      const pairKey = [initiator.instance_name, c.instance_name].sort().join("::");
      if (activePairs.has(pairKey)) return false;
      const cooldownUntil = _pairCooldownUntil.get(pairKey) || 0;
      return nowMs >= cooldownUntil;
    });

    if (candidates.length === 0) continue;

    // Prefere parceiro em reabilitação (70%+ inbound) ou que mais precisa de mensagens recebidas
    const partnerSorted = [...candidates].sort((a, b) => {
      const aRehab = a.career_mode === "rehab" ? 1 : 0;
      const bRehab = b.career_mode === "rehab" ? 1 : 0;
      if (bRehab !== aRehab) return bRehab - aRehab;
      const recDiff = (a.received_today || 0) - (b.received_today || 0);
      if (recDiff !== 0) return recDiff;
      return (a.stage || 1) - (b.stage || 1);
    });
    const topSlice = partnerSorted.slice(0, Math.min(2, partnerSorted.length));
    const partner = topSlice[Math.floor(Math.random() * topSlice.length)];
    if (partner) {
      usedInTick.add(initiator.instance_name);
      usedInTick.add(partner.instance_name);
      picked.push({ initiator, partner });
    }
  }

  return picked;
}

export function selectAsymmetricWarmupPair(
  idleChips: WarmupConfig[],
  activePairs: Set<string>,
  nowMs = Date.now()
): { initiator: WarmupConfig; partner: WarmupConfig } | null {
  return selectAsymmetricWarmupPairs(idleChips, activePairs, 1, nowMs)[0] || null;
}

function recordChipHourSend(instanceName: string, nowMs = Date.now()): void {
  pruneMapToLimit(_hourlySendTimestamps, 3000);
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const current = (_hourlySendTimestamps.get(instanceName) || []).filter((ts) => ts > oneHourAgo);
  current.push(nowMs);
  _hourlySendTimestamps.set(instanceName, current);
}

function isChipWithinHourlyPace(
  cfg: WarmupConfig,
  nowMs = Date.now(),
  softRecovery = false
): boolean {
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const recent = (_hourlySendTimestamps.get(cfg.instance_name) || []).filter((ts) => ts > oneHourAgo);
  _hourlySendTimestamps.set(cfg.instance_name, recent);
  const now = new Date(nowMs);
  const target = effectiveTargetWithContext(cfg, now, softRecovery);
  const cap = getCircadianHourlyCap(cfg, target, now);
  return recent.length < cap;
}

function scheduleGroupSync(clientId: string): void {
  const last = _lastGroupSyncAt[clientId] || 0;
  if (Date.now() - last < GROUP_SYNC_INTERVAL_MS) return;
  if (_groupSyncInFlight.has(clientId)) return;

  _lastGroupSyncAt[clientId] = Date.now();
  _groupSyncInFlight.add(clientId);
  Promise.all([
    syncGroupMembershipForChips(clientId),
    cleanupDeadWarmupGroups(clientId),
    runInternalSwarmGroupCycle(clientId),
  ])
    .catch(() => {})
    .finally(() => _groupSyncInFlight.delete(clientId));
}

// Máximo de turnos por chip dentro do mesmo tick, para não gerar rajada.
const MAX_TURNS_PER_CHIP_PER_TICK = 1;
const _lastCampaignSkipWarnAt = new Map<string, number>();
const CAMPAIGN_SKIP_WARN_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Exclui do tick de aquecimento chips que possuem campanha ativa (`running`),
 * preservando 100% da reputação e capacidade de envio para a prospecção fria.
 */
export function filterChipsWithoutActiveCampaign<T extends { instance_name: string }>(
  configs: T[],
  runningInstances: Iterable<string>,
): { eligible: T[]; skipped: T[] } {
  const activeSet = new Set<string>();
  for (const inst of runningInstances) {
    const clean = String(inst || "").trim().toLowerCase();
    if (clean) activeSet.add(clean);
  }

  const eligible: T[] = [];
  const skipped: T[] = [];
  for (const cfg of configs) {
    const key = String(cfg.instance_name || "").trim().toLowerCase();
    if (key && activeSet.has(key)) {
      skipped.push(cfg);
    } else {
      eligible.push(cfg);
    }
  }
  return { eligible, skipped };
}

function effectiveTarget(config: WarmupConfig): number {
  return getEffectiveDailyTarget(config);
}

export function effectiveTargetWithContext(
  config: WarmupConfig,
  now: Date = new Date(),
  softRecovery: boolean = false
): number {
  const base = effectiveTarget(config);
  const afterWeekend = isBrazilWeekend(now) ? Math.max(Math.min(4, base), Math.floor(base * 0.55)) : base;
  return softRecovery ? Math.max(Math.min(3, afterWeekend), Math.floor(afterWeekend * 0.5)) : afterWeekend;
}

function getEffectiveOperatingWindow(cfg: WarmupConfig, now: Date, isTestEnv: boolean): { start: number; end: number } {
  const rawStart = cfg.allowed_start_hour ?? 8;
  const rawEnd = cfg.allowed_end_hour ?? 21;
  if (isTestEnv || !isBrazilWeekend(now)) {
    return { start: rawStart, end: rawEnd };
  }
  const shiftedStart = rawStart < rawEnd ? Math.min(rawStart + 1, Math.max(rawStart, rawEnd - 1), 10) : rawStart;
  return { start: shiftedStart, end: rawEnd };
}

/**
 * Garante que todos os chips ativos no Aquecedor tenham proxy exclusivo do pool
 * (sem colisão e com fail-open automático para o IP padrão da VPS se esgotar).
 */
async function ensureWarmupClusterProxies(clientId: string, chips: WarmupConfig[]): Promise<void> {
  if (!chips || chips.length === 0) return;
  try {
    const poolOverview = await getProxyPoolOverviewCache();
    if (!poolOverview.hasPool) return;
    const { data: assignedPoolRows } = await supabaseAdmin
      .from("proxy_pool")
      .select("assigned_instance")
      .eq("status", "assigned");
    const hasAssignedSet = new Set(
      ((assignedPoolRows || []) as Array<{ assigned_instance?: string | null }>)
        .map((r) => r.assigned_instance)
        .filter((x): x is string => Boolean(x)),
    );
    for (const cfg of chips) {
      if (!hasAssignedSet.has(cfg.instance_name)) {
        await ensureProxyForInstance({
          instanceName: cfg.instance_name,
          clientId,
          reason: "warmup",
          forWarmup: true,
        }).catch(() => null);
      }
    }
  } catch {
    // non-fatal se tabela proxy_pool não existir
  }
}

/**
 * Agendador principal de maturação.
 * Executado a cada 60s pelo instrumentation / worker pool.
 */
export async function tickWarmupWorker(): Promise<{
  processedTenants: number;
  exchangesCount: number;
}> {
  let processedTenants = 0;
  let exchangesCount = 0;

  try {
    // 1. Lista tenants com configuração de warmup ou conexão WhatsApp.
    const tenantIds = await listWarmupTenantIds();
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    if (tenantIds.length === 0) {
      return { processedTenants, exchangesCount };
    }

    const lockOwner = `warmup-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

    for (const clientId of tenantIds) {
      if (!(await isTenantWarmupAdmin(clientId))) {
        continue;
      }
      processedTenants++;

      // Lock por tenant: evita dois processos enviando no mesmo minuto.
      const locked = await acquireWarmupTickLock(clientId, lockOwner);
      if (!locked) {
        console.log(`[WarmupWorker] Tenant ${clientId} já está sendo processado por outro processo. Pulando tick.`);
        continue;
      }

      try {
        // 1.9 Ciclo autônomo de Auto-Cura (throttled 10min): repara webhook, proxy e status preso
        await runWarmupSelfHealingForTenant(clientId).catch(() => null);

        // 2. Cadastro automático de chip conectado + leitura com precedência tabela > settings
        const ensured = await ensureWarmupConfigsForTenant(clientId);
        const connections: TenantConnection[] = ensured.connections;
        const { configs: configMap } = await readTenantWarmupConfigs(clientId);

        if (ensured.created.length > 0) {
          await logWarmupAction({
            client_id: clientId,
            sender_instance: "swarm_orchestrator",
            receiver_instance: "auto_enroll",
            message_text: `🆕 ${ensured.created.length} chip(s) conectado(s) cadastrado(s) automaticamente no aquecimento: ${ensured.created.join(", ")}.`,
            action_type: "system",
          });
        }

        const enabledConfigs = Object.values(configMap).filter((c) => c.enabled);
        if (enabledConfigs.length === 0) continue;

        // 2.0 Liberação de quarentena vencida ANTES do filtro de conexão
        // (impede que um chip fique preso em quarentena eterna caso tenha oscilado para "connecting").
        for (const cfg of enabledConfigs) {
          if (cfg.is_quarantined && cfg.quarantine_until && new Date(cfg.quarantine_until) <= now) {
            cfg.is_quarantined = false;
            cfg.quarantine_reason = null;
            cfg.health_score = 60;
            cfg.error_count_today = 0;
            await supabaseAdmin
              .from("whatsapp_warmup_configs")
              .update({
                is_quarantined: false,
                quarantine_reason: null,
                health_score: 60,
                error_count_today: 0,
                updated_at: nowIso,
              })
              .eq("id", cfg.id)
              .eq("client_id", clientId);

            await logWarmupAction({
              client_id: clientId,
              sender_instance: cfg.instance_name,
              receiver_instance: "circuit_breaker",
              message_text: `✅ Quarentena preventiva de 24h concluída para o Chip ${cfg.instance_name}. Tráfego reativado em marcha reduzida (50%, saúde inicial 60%).`,
              action_type: "circuit_breaker",
            });
          }
        }

        // Chip desconectado não recebe envio. Config sem linha de conexão mantém
        // comportamento legado (evita parar tenants antigos sem channel_connections).
        const statusByInstance = new Map(connections.map((c) => [c.instance_name, c.status]));
        const configs = enabledConfigs.filter((c) => {
          const status = statusByInstance.get(c.instance_name);
          return status ? isConnectedStatus(status) : true;
        });
        if (configs.length === 0) continue;

        // Drena ações comportamentais pendentes (tique azul/reação) apenas se houver fila ou recuperação pós-boot
        if (shouldCheckPendingWarmupActions(clientId)) {
          await drainDuePendingWarmupActions(clientId, nowMs).catch(() => 0);
        }

        // 2.1 Reset diário idempotente (uma vez por dia civil) + Reconciliação de fase pela idade real
        const dailyState = await readDailyResetState(clientId);
        const nextDailyState = { ...dailyState };
        let dailyStateDirty = false;

        for (const cfg of configs) {
          // Reconciliação imediata caso o chip tenha herdado stage inflado (ex: stage 4 com 5 dias de vida)
          // ou tenha idade suficiente para graduar automaticamente sua carreira (contingency -> inbound -> outbound)
          if (cfg.stage_auto_progress !== false && cfg.created_at) {
            const realDays = calculateElapsedDaysFromCreatedAt(cfg.created_at, nowIso);
            if (realDays !== null) {
              const maxAllowedStage = getMaxStageForDaysActive(realDays);
              if (cfg.stage > maxAllowedStage) {
                const targetInfo = STAGE_DEFAULTS[maxAllowedStage];
                cfg.stage = maxAllowedStage;
                cfg.days_active = realDays;
                cfg.daily_target = targetInfo.dailyTarget;
                cfg.min_interval_seconds = targetInfo.minInterval;
                cfg.max_interval_seconds = targetInfo.maxInterval;

                await supabaseAdmin
                  .from("whatsapp_warmup_configs")
                  .update({
                    stage: maxAllowedStage,
                    days_active: realDays,
                    daily_target: targetInfo.dailyTarget,
                    min_interval_seconds: targetInfo.minInterval,
                    max_interval_seconds: targetInfo.maxInterval,
                    updated_at: nowIso,
                  })
                  .eq("id", cfg.id)
                  .eq("client_id", clientId);

                await logWarmupAction({
                  client_id: clientId,
                  sender_instance: cfg.instance_name,
                  receiver_instance: "auto_ramp",
                  message_text: `🛡️ Calibração Anti-Ban: Chip ${cfg.instance_name} ajustado para ${targetInfo.name} (${realDays} dias de idade real). Meta segura: ${targetInfo.dailyTarget} msgs/dia.`,
                  action_type: "system",
                });
              }

              const careerCheck = getAutoCareerPurpose({
                currentPurpose: cfg.purpose,
                stage: cfg.stage,
                daysActive: realDays,
                healthScore: cfg.health_score,
                autoProgress: cfg.stage_auto_progress,
              });
              if (careerCheck.graduated) {
                cfg.purpose = careerCheck.nextPurpose;
                await supabaseAdmin
                  .from("whatsapp_warmup_configs")
                  .update({ purpose: careerCheck.nextPurpose, updated_at: nowIso })
                  .eq("id", cfg.id)
                  .eq("client_id", clientId);

                await logWarmupAction({
                  client_id: clientId,
                  sender_instance: cfg.instance_name,
                  receiver_instance: "auto_career",
                  message_text: `🎓 Esteira Autônoma: Chip ${cfg.instance_name} graduou automaticamente para finalidade "${careerCheck.nextPurpose}" (${realDays} dias de maturação).`,
                  action_type: "system",
                });
              }
            }
          }

          const progress = evaluateDailyAutoProgress(
            cfg,
            nowIso,
            dailyState[cfg.instance_name] ?? null
          );
          if (!progress.isNewDay) continue;

          const {
            stagePromoted,
            stageReconciled,
            purposeGraduated,
            newStage,
            newPurpose,
            newDaysActive,
            newConsecutiveDays,
            newDailyTarget,
          } = progress;

          const update: Record<string, unknown> = {
            sent_today: 0,
            received_today: 0,
            error_count_today: 0,
            external_warmup_inbound_today: 0,
            external_mmzap_sent_today: 0,
            mmzap_minutes_today: 0,
            mmzap_shifts_today: 0,
            days_active: newDaysActive,
            consecutive_successful_days: newConsecutiveDays,
            updated_at: nowIso,
          };

          cfg.sent_today = 0;
          cfg.received_today = 0;
          cfg.error_count_today = 0;
          cfg.external_warmup_inbound_today = 0;
          cfg.external_mmzap_sent_today = 0;
          cfg.mmzap_minutes_today = 0;
          cfg.mmzap_shifts_today = 0;
          cfg.days_active = newDaysActive;
          cfg.consecutive_successful_days = newConsecutiveDays;

          if (stagePromoted || stageReconciled) {
            update.stage = newStage;
            update.daily_target = newDailyTarget;
            update.min_interval_seconds = progress.stageInfo.minInterval;
            update.max_interval_seconds = progress.stageInfo.maxInterval;

            cfg.stage = newStage;
            cfg.daily_target = newDailyTarget;
            cfg.min_interval_seconds = progress.stageInfo.minInterval;
            cfg.max_interval_seconds = progress.stageInfo.maxInterval;
          }

          if (purposeGraduated) {
            update.purpose = newPurpose;
            cfg.purpose = newPurpose;
          }

          const rehabCheck = evaluateRehabGraduation(cfg, nowIso);
          if (rehabCheck.graduated) {
            update.career_mode = rehabCheck.nextCareerMode;
            update.rehab_until = null;
            cfg.career_mode = rehabCheck.nextCareerMode;
            cfg.rehab_until = null;
          }

          const { error: updErr } = await supabaseAdmin
            .from("whatsapp_warmup_configs")
            .update(update)
            .eq("id", cfg.id)
            .eq("client_id", clientId);
          if (updErr) {
            const {
              career_mode: _c,
              rehab_until: _r,
              external_warmup_inbound_today: _ei,
              external_mmzap_sent_today: _ems,
              mmzap_minutes_today: _mm,
              mmzap_shifts_today: _ms,
              ...fallbackUpd
            } = update;
            void _c;
            void _r;
            void _ei;
            void _ems;
            void _mm;
            void _ms;
            await supabaseAdmin
              .from("whatsapp_warmup_configs")
              .update(fallbackUpd)
              .eq("id", cfg.id)
              .eq("client_id", clientId);
          }

          nextDailyState[cfg.instance_name] = getBrazilDayKey(nowIso);
          dailyStateDirty = true;

          if (stagePromoted) {
            await logWarmupAction({
              client_id: clientId,
              sender_instance: cfg.instance_name,
              receiver_instance: "auto_ramp",
              message_text: `🎉 PILOTO AUTOMÁTICO: Chip ${cfg.instance_name} promovido para a ${progress.stageInfo.name} (${newDaysActive} dias de maturação). Nova meta: ${newDailyTarget} msgs/dia!`,
              action_type: "system",
            });
          }

          if (purposeGraduated) {
            await logWarmupAction({
              client_id: clientId,
              sender_instance: cfg.instance_name,
              receiver_instance: "auto_career",
              message_text: `🎓 Esteira Autônoma: Chip ${cfg.instance_name} liberado automaticamente para "${newPurpose}" após atingir ${newDaysActive} dias saudáveis.`,
              action_type: "system",
            });
          }
        }

        if (dailyStateDirty) {
          await writeDailyResetState(clientId, nextDailyState);
        }

        // 2.2 Hidratação preventiva de perfis e sincronização de grupos
        for (const cfg of configs) {
          if (!cfg.profile_hydrated && !cfg.is_quarantined) {
            hydrateChipProfile(clientId, cfg.instance_name).catch(() => {});
          }
        }

        // Validação de chips não em quarentena
        let nonQuarantined = configs.filter((c) => !c.is_quarantined);

        // Se temos apenas 1 chip: aquece passivamente via grupos da colmeia e Status (apenas dentro do horário comercial)
        if (nonQuarantined.length < 2) {
          const soleChip = nonQuarantined[0];
          if (!soleChip) continue;

          if (
            !isWithinOperatingHours(
              soleChip.allowed_start_hour ?? 8,
              soleChip.allowed_end_hour ?? 21
            )
          ) {
            continue;
          }

          if (!(await isClientActiveCached(clientId))) {
            continue;
          }

          await ensureWarmupClusterProxies(clientId, [soleChip]);

          await tickMmzapBrowserOrchestrator({
            clientId,
            configs: nonQuarantined,
            connectedInstanceNames: new Set(nonQuarantined.map((c) => c.instance_name)),
            nowMs,
          }).catch(() => null);

          scheduleGroupSync(clientId);

          // Publica Status de forma isolada quando há apenas 1 chip conectado
          if (soleChip.enable_status_posts !== false) {
            await runIsolatedStatusPost({
              clientId,
              senderConfig: soleChip,
              peerPhones: [],
            });
          }

          const lastWarn = _lastWarningLogged[clientId] || 0;
          if (nowMs - lastWarn > 4 * 60 * 60 * 1000) {
            _lastWarningLogged[clientId] = nowMs;
            await logWarmupAction({
              client_id: clientId,
              sender_instance: soleChip.instance_name,
              receiver_instance: "grupos_colmeia",
              message_text:
                "ℹ️ Chip único ativo: aquecendo passivamente via grupos da colmeia e publicação de status. Para trocas mútuas 1x1, mantenha ao menos 2 chips conectados.",
              action_type: "system",
            });
          }
          continue;
        }

        // Sincroniza adesão nos grupos (com throttle anti-flood)
        scheduleGroupSync(clientId);

        // Orquestrador MMZap (turnos curtos no browser com mesma proxy e exclusividade temporal)
        await tickMmzapBrowserOrchestrator({
          clientId,
          configs: nonQuarantined,
          connectedInstanceNames: new Set(nonQuarantined.map((c) => c.instance_name)),
          nowMs,
        }).catch(() => null);

        // Pré-filtra pelo ritmo em RAM; se houver chips elegíveis, hidrata contadores reais do banco na 1ª passada
        const isTestEnv = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
        let availableChips = nonQuarantined.filter(
          (c) =>
            c.mmzap_browser_status !== "running" &&
            (c.sent_today || 0) + (c.external_mmzap_sent_today || 0) <
              effectiveTargetWithContext(c, now) &&
            isChipWithinHourlyPace(c, nowMs)
        );

        if (availableChips.length === 0) {
          continue;
        }

        if (!(await isClientActiveCached(clientId))) {
          continue;
        }

        await ensureWarmupClusterProxies(clientId, availableChips);

        // Identifica chips em Retomada Suave (50% da meta por 24h pós-hiato >= 48h ou quarentena)
        const softRecoverySet = new Set<string>();
        try {
          const phoneMemMap = await readPhoneMemoryMap(clientId);
          for (const chip of nonQuarantined) {
            const pKey = canonicalBrazilPhoneKey(chip.phone_number);
            const memEntry = (pKey && phoneMemMap[pKey]) || Object.values(phoneMemMap).find((e) => e.lastInstanceName === chip.instance_name);
            if (isChipInSoftRecovery(chip, memEntry, nowMs)) {
              softRecoverySet.add(chip.instance_name);
            }
          }
        } catch {}

        await hydrateWarmupHourlyCountsIfNeeded(clientId, nowMs);
        availableChips = nonQuarantined.filter((c) => {
          const inSoft = softRecoverySet.has(c.instance_name);
          return (
            c.mmzap_browser_status !== "running" &&
            (c.sent_today || 0) + (c.external_mmzap_sent_today || 0) <
              effectiveTargetWithContext(c, now, inSoft) &&
            isChipWithinHourlyPace(c, nowMs, inSoft)
          );
        });
        if (availableChips.length === 0) {
          continue;
        }

        // Não aquece chips que estão rodando campanha fria ativa (status = 'running').
        let runningInstances: string[] = [];
        try {
          const { data: runningCamps } = await supabaseAdmin
            .from("campaigns")
            .select("instance_name")
            .eq("client_id", clientId)
            .eq("status", "running");
          if (Array.isArray(runningCamps)) {
            runningInstances = runningCamps
              .map((row) => String((row as { instance_name?: string | null })?.instance_name || "").trim())
              .filter(Boolean);
          }
        } catch {}

        if (runningInstances.length > 0) {
          const availSplit = filterChipsWithoutActiveCampaign(availableChips, runningInstances);
          availableChips = availSplit.eligible;
          nonQuarantined = filterChipsWithoutActiveCampaign(nonQuarantined, runningInstances).eligible;
          for (const skippedChip of availSplit.skipped) {
            const warnKey = `${clientId}:${skippedChip.instance_name}`;
            const prevWarnAt = _lastCampaignSkipWarnAt.get(warnKey) || 0;
            if (nowMs - prevWarnAt >= CAMPAIGN_SKIP_WARN_COOLDOWN_MS) {
              _lastCampaignSkipWarnAt.set(warnKey, nowMs);
              pruneMapToLimit(_lastCampaignSkipWarnAt, 2000);
              await logWarmupAction({
                client_id: clientId,
                sender_instance: skippedChip.instance_name,
                receiver_instance: "campaign_guard",
                message_text: `⏸️ Aquecimento pausado temporariamente para ${skippedChip.instance_name} enquanto há disparo ativo em andamento.`,
                action_type: "system",
              });
            }
          }
          if (availableChips.length === 0) {
            continue;
          }
        }

        // 3. Consolida conversas ativas duplicadas do mesmo par e limpa conversas zumbis (> 12h sem atualizar)
        let activePairs = new Set<string>();
        try {
          const { data: activeAll } = await supabaseAdmin
            .from("whatsapp_warmup_conversations")
            .select("id, instance_a, instance_b")
            .eq("client_id", clientId)
            .eq("status", "active")
            .order("created_at", { ascending: true });

          const keptPairs = new Set<string>();
          const duplicateIds: string[] = [];
          for (const conv of activeAll || []) {
            const pairKey = [conv.instance_a, conv.instance_b].filter(Boolean).sort().join("::");
            if (!pairKey) continue;
            if (keptPairs.has(pairKey)) duplicateIds.push(conv.id);
            else keptPairs.add(pairKey);
          }

          // Reap opcional de conversas zumbis > 12h (somente quando o client Postgres suportar .lt)
          try {
            const cutoff12hIso = new Date(nowMs - 12 * 60 * 60 * 1000).toISOString();
            const qZombie = supabaseAdmin
              .from("whatsapp_warmup_conversations")
              .select("id, instance_a, instance_b")
              .eq("client_id", clientId)
              .eq("status", "active") as unknown as {
                lt?: (col: string, val: string) => Promise<{ data?: Array<{ id: string; instance_a?: string; instance_b?: string }> | null }>;
              };
            if (typeof qZombie?.lt === "function") {
              const { data: zombies } = await qZombie.lt("updated_at", cutoff12hIso);
              for (const z of zombies || []) {
                if (z?.id && !duplicateIds.includes(z.id)) {
                  duplicateIds.push(z.id);
                  const zKey = [z.instance_a, z.instance_b].filter(Boolean).sort().join("::");
                  if (zKey) keptPairs.delete(zKey);
                }
              }
            }
          } catch {}

          if (duplicateIds.length > 0) {
            await supabaseAdmin
              .from("whatsapp_warmup_conversations")
              .update({ status: "finished", updated_at: nowIso })
              .in("id", duplicateIds);
          }

          activePairs = keptPairs;
        } catch {}

        // 4. Processa conversas ativas pendentes em paralelo com limite escalável por quantidade N de chips
        const dynamicDueLimit = Math.min(Math.max(6, availableChips.length), 30);
        const { data: dueConvs } = await supabaseAdmin
          .from("whatsapp_warmup_conversations")
          .select("*")
          .eq("client_id", clientId)
          .eq("status", "active")
          .lte("next_turn_at", nowIso)
          .order("next_turn_at", { ascending: true })
          .limit(dynamicDueLimit);

        const busyChips = new Set<string>(
          nonQuarantined
            .filter((c) => c.mmzap_browser_status === "running")
            .map((c) => c.instance_name)
        );
        const sentThisTick = new Map<string, number>();

        if (dueConvs && dueConvs.length > 0) {
          const runnableDue: Array<{
            activeConv: WarmupConversation;
            instA: WarmupConfig;
            instB: WarmupConfig;
            senderCfg: WarmupConfig;
            receiverCfg: WarmupConfig;
          }> = [];
          const staleOrCappedIds: string[] = [];

          for (const activeConv of dueConvs as WarmupConversation[]) {
            if (
              activeConv.updated_at &&
              nowMs - new Date(activeConv.updated_at).getTime() > 12 * 60 * 60 * 1000
            ) {
              staleOrCappedIds.push(activeConv.id);
              continue;
            }

            const instA = nonQuarantined.find((c) => c.instance_name === activeConv.instance_a);
            const instB = nonQuarantined.find((c) => c.instance_name === activeConv.instance_b);
            if (!instA || !instB) continue;

            busyChips.add(instA.instance_name);
            busyChips.add(instB.instance_name);

            const senderCfg = activeConv.last_sender === instA.instance_name ? instB : instA;
            const receiverCfg = senderCfg.instance_name === instA.instance_name ? instB : instA;
            const inSoft = softRecoverySet.has(senderCfg.instance_name);

            if (
              senderCfg.mmzap_browser_status === "running" ||
              (senderCfg.sent_today || 0) + (senderCfg.external_mmzap_sent_today || 0) >=
                effectiveTargetWithContext(senderCfg, now, inSoft)
            ) {
              staleOrCappedIds.push(activeConv.id);
              continue;
            }

            if (
              (sentThisTick.get(senderCfg.instance_name) || 0) >= MAX_TURNS_PER_CHIP_PER_TICK ||
              !isChipWithinHourlyPace(senderCfg, nowMs, inSoft)
            ) {
              continue;
            }

            const win = getEffectiveOperatingWindow(senderCfg, now, isTestEnv);
            if (!isWithinOperatingHours(win.start, win.end)) {
              continue;
            }

            // Garante que dois turnos concorrentes no mesmo tick não usem o mesmo chip
            if (
              runnableDue.some(
                (t) =>
                  t.instA.instance_name === instA.instance_name ||
                  t.instA.instance_name === instB.instance_name ||
                  t.instB.instance_name === instA.instance_name ||
                  t.instB.instance_name === instB.instance_name
              )
            ) {
              continue;
            }

            sentThisTick.set(senderCfg.instance_name, (sentThisTick.get(senderCfg.instance_name) || 0) + 1);
            runnableDue.push({ activeConv, instA, instB, senderCfg, receiverCfg });
          }

          if (staleOrCappedIds.length > 0) {
            await supabaseAdmin
              .from("whatsapp_warmup_conversations")
              .update({ status: "finished", updated_at: nowIso })
              .in("id", staleOrCappedIds);
          }

          if (runnableDue.length > 0) {
            await mapWithConcurrency(runnableDue, 4, async (task, idx) => {
              // Dessincroniza o segundo exato do disparo (quebra metrônomo :10/:11 entre múltiplos pares)
              if (!isTestEnv) {
                const microJitterMs = Math.floor(Math.random() * 4500) + idx * 350;
                await new Promise((r) => setTimeout(r, Math.min(microJitterMs, 6500)));
              }
              const turnRes = await executeWarmupTurn({
                clientId,
                senderConfig: task.senderCfg,
                receiverConfig: task.receiverCfg,
                conversation: task.activeConv,
              });
              if (turnRes.success) {
                exchangesCount++;
                task.senderCfg.sent_today = (task.senderCfg.sent_today || 0) + 1;
                task.receiverCfg.received_today = (task.receiverCfg.received_today || 0) + 1;
                recordChipHourSend(task.senderCfg.instance_name, nowMs);

                if ((task.activeConv.turn_count || 0) + 1 >= (task.activeConv.max_turns || 6)) {
                  const pairKey = [task.instA.instance_name, task.instB.instance_name].sort().join("::");
                  const cooldownSec = calculateInterConversationCooldownSec(
                    Math.min(task.instA.stage || 1, task.instB.stage || 1)
                  );
                  pruneMapToLimit(_pairCooldownUntil, 3000);
                  _pairCooldownUntil.set(pairKey, nowMs + cooldownSec * 1000);
                }
              }
            });
          }
        }

        // 5. Se houver chips ociosos disponíveis, cria novas conversas em malha escalável (Mesh Swarm Assimétrico N-Chips)
        const idleChips = availableChips.filter(
          (c) => !busyChips.has(c.instance_name) && !sentThisTick.has(c.instance_name)
        );

        const maxNewPairs = Math.min(Math.max(1, Math.floor(idleChips.length / 2)), 20);
        const pickedPairs = selectAsymmetricWarmupPairs(idleChips, activePairs, maxNewPairs, nowMs);

        if (pickedPairs.length > 0) {
          await mapWithConcurrency(pickedPairs, 4, async ({ initiator, partner }, idx) => {
            const win = getEffectiveOperatingWindow(initiator, now, isTestEnv);
            const scheduleDecision = isTestEnv
              ? {
                  allowed: isWithinOperatingHours(win.start, win.end),
                  inLunchLull: false,
                }
              : getOrganicScheduleDecision(initiator.instance_name, win.start, win.end, now);

            // Durante a pausa orgânica do almoço/jantar, reduz em 65% o início de novas conversas
            const skipForLunch = scheduleDecision.inLunchLull && Math.random() < 0.65;
            if (!scheduleDecision.allowed || skipForLunch) return;

            if (!isTestEnv) {
              const microJitterMs = Math.floor(Math.random() * 5000) + idx * 400;
              await new Promise((r) => setTimeout(r, Math.min(microJitterMs, 7000)));
            }

            const effectiveTheme = pickEffectiveConversationTheme(initiator.ai_theme);
            const maxTurns = Math.floor(Math.random() * 4) + 4; // 4 a 7 turnos

            const { data: newConvData, error: convErr } = await supabaseAdmin
              .from("whatsapp_warmup_conversations")
              .insert({
                client_id: clientId,
                instance_a: initiator.instance_name,
                instance_b: partner.instance_name,
                topic: effectiveTheme,
                history: [],
                turn_count: 0,
                max_turns: maxTurns,
                status: "active",
                next_turn_at: nowIso,
              })
              .select()
              .single();

            if (!convErr && newConvData) {
              const turnRes = await executeWarmupTurn({
                clientId,
                senderConfig: initiator,
                receiverConfig: partner,
                conversation: newConvData as WarmupConversation,
              });
              if (turnRes.success) {
                exchangesCount++;
                initiator.sent_today = (initiator.sent_today || 0) + 1;
                partner.received_today = (partner.received_today || 0) + 1;
                sentThisTick.set(initiator.instance_name, 1);
                recordChipHourSend(initiator.instance_name, nowMs);
              }
            }
          });
        }

        // 6. Rotina isolada de Stories (Status): roda apenas em chips ociosos que NÃO dispararam neste tick
        if (!isTestEnv) {
          const allPeerPhones = nonQuarantined
            .map((c) => c.phone_number?.replace(/\D/g, ""))
            .filter((p): p is string => Boolean(p && p.length >= 10));

          const statusDueChips = nonQuarantined
            .filter((c) => {
              if (sentThisTick.has(c.instance_name) || c.enable_status_posts === false) return false;
              const win = getEffectiveOperatingWindow(c, now, false);
              if (!isWithinOperatingHours(win.start, win.end)) return false;
              return (
                !c.last_status_post_at ||
                nowMs - new Date(c.last_status_post_at).getTime() > 24 * 60 * 60 * 1000
              );
            })
            .slice(0, 2);

          if (statusDueChips.length > 0) {
            await mapWithConcurrency(statusDueChips, 2, async (cfg) => {
              const cleanSelf = cfg.phone_number?.replace(/\D/g, "");
              const peers = allPeerPhones.filter((p) => p !== cleanSelf);
              await runIsolatedStatusPost({
                clientId,
                senderConfig: cfg,
                peerPhones: peers,
              });
            });
          }
        }
      } catch (tenantErr) {
        const message = tenantErr instanceof Error ? tenantErr.message : String(tenantErr);
        console.error(`[WarmupWorker] Falha no tenant ${clientId}:`, message);
      } finally {
        await releaseWarmupTickLock(clientId, lockOwner);
      }
    }
  } catch (err: any) {
    console.error("[WarmupWorker] Erro no tick do worker:", err.message);
  }

  return { processedTenants, exchangesCount };
}

/**
 * Disparo manual imediato de teste entre 2 chips.
 */
export async function triggerManualWarmup(
  clientId: string,
  instanceA: string,
  instanceB: string,
  forceStatusPost: boolean = false
): Promise<{ success: boolean; message: string; error?: string }> {
  const { data: configs } = await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .select("*")
    .eq("client_id", clientId)
    .in("instance_name", [instanceA, instanceB]);

  const cfgA = configs?.find((c) => c.instance_name === instanceA);
  const cfgB = configs?.find((c) => c.instance_name === instanceB);

  const defaultCfg = (inst: string): WarmupConfig => ({
    client_id: clientId,
    instance_name: inst,
    enabled: true,
    stage: 2,
    stage_auto_progress: true,
    days_active: 1,
    consecutive_successful_days: 1,
    health_score: 100,
    is_quarantined: false,
    daily_target: 25,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 60,
    max_interval_seconds: 180,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 0,
    allowed_end_hour: 24,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
  });

  const finalA: WarmupConfig = cfgA || defaultCfg(instanceA);
  const finalB: WarmupConfig = cfgB || defaultCfg(instanceB);

  const syntheticConv: WarmupConversation = {
    id: `manual_${Date.now()}`,
    client_id: clientId,
    instance_a: instanceA,
    instance_b: instanceB,
    topic: pickEffectiveConversationTheme(finalA.ai_theme),
    history: [],
    turn_count: 0,
    max_turns: 4,
    status: "active",
    next_turn_at: new Date().toISOString(),
  };

  const res = await executeWarmupTurn({
    clientId,
    senderConfig: finalA,
    receiverConfig: finalB,
    conversation: syntheticConv,
    isManualTrigger: true,
    forceStatusPost,
  });

  if (!res.success) {
    return {
      success: false,
      message: `Falha no teste: ${res.error || "Desconhecido"}`,
      error: res.error,
    };
  }

  return {
    success: true,
    message: `Mensagem enviada com sucesso de ${instanceA} para ${instanceB}: "${res.messageText}"`,
  };
}

/**
 * Disparo mútuo simultâneo: Chip A envia para Chip B e Chip B responde para Chip A,
 * ativando todas as funcionalidades automáticas de aquecimento bilateral de 2026.
 */
export async function triggerMutualWarmup(
  clientId: string,
  instanceA: string,
  instanceB: string,
  forceStatusPost: boolean = false
): Promise<{ success: boolean; message: string; details?: { turnA: string; turnB: string }; error?: string }> {
  const { data: configs } = await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .select("*")
    .eq("client_id", clientId)
    .in("instance_name", [instanceA, instanceB]);

  const cfgA = configs?.find((c) => c.instance_name === instanceA);
  const cfgB = configs?.find((c) => c.instance_name === instanceB);

  const defaultCfg = (inst: string): WarmupConfig => ({
    client_id: clientId,
    instance_name: inst,
    enabled: true,
    stage: 2,
    stage_auto_progress: true,
    days_active: 1,
    consecutive_successful_days: 1,
    health_score: 100,
    is_quarantined: false,
    daily_target: 25,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 60,
    max_interval_seconds: 180,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 0,
    allowed_end_hour: 24,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
  });

  const finalA: WarmupConfig = cfgA || defaultCfg(instanceA);
  const finalB: WarmupConfig = cfgB || defaultCfg(instanceB);

  // Turno 1: Chip A -> Chip B
  const convId = `mutual_${Date.now()}`;
  const conversation: WarmupConversation = {
    id: convId,
    client_id: clientId,
    instance_a: instanceA,
    instance_b: instanceB,
    topic: pickEffectiveConversationTheme(finalA.ai_theme),
    history: [],
    turn_count: 0,
    max_turns: 6,
    status: "active",
    next_turn_at: new Date().toISOString(),
  };

  const resA = await executeWarmupTurn({
    clientId,
    senderConfig: finalA,
    receiverConfig: finalB,
    conversation,
    isManualTrigger: true,
    forceStatusPost,
    forceVCard: true,
  });

  if (!resA.success) {
    return {
      success: false,
      message: `Falha no envio de ${instanceA} para ${instanceB}: ${resA.error || "Desconhecido"}`,
      error: resA.error,
    };
  }

  conversation.history.push({
    sender: instanceA,
    text: resA.messageText,
    sent_at: new Date().toISOString(),
  });
  conversation.turn_count = 1;
  conversation.last_sender = instanceA;

  // Pequena pausa humana entre mensagens mútuas (1.5s)
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Turno 2: Chip B -> Chip A (Resposta Simultânea)
  const resB = await executeWarmupTurn({
    clientId,
    senderConfig: finalB,
    receiverConfig: finalA,
    conversation,
    isManualTrigger: true,
    forceStatusPost,
    forceVCard: true,
  });

  if (!resB.success) {
    return {
      success: true,
      message: `Primeiro envio de ${instanceA} concluído, mas resposta de ${instanceB} falhou: ${resB.error}`,
      details: { turnA: resA.messageText, turnB: "" },
    };
  }

  conversation.history.push({
    sender: instanceB,
    text: resB.messageText,
    sent_at: new Date().toISOString(),
  });
  conversation.turn_count = 2;
  conversation.last_sender = instanceB;

  try {
    await supabaseAdmin
      .from("whatsapp_warmup_conversations")
      .upsert(
        {
          id: convId,
          client_id: clientId,
          instance_a: instanceA,
          instance_b: instanceB,
          topic: conversation.topic,
          history: conversation.history,
          turn_count: 2,
          max_turns: 6,
          last_sender: instanceB,
          status: "active",
          next_turn_at: new Date(Date.now() + 180 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );
  } catch {}

  await logWarmupAction({
    client_id: clientId,
    sender_instance: instanceA,
    receiver_instance: instanceB,
    message_text: `🔄 Rodada mútua concluída entre ${instanceA} e ${instanceB}. Ambos trocaram mensagens e contatos.`,
    action_type: "system",
  });

  return {
    success: true,
    message: `Aquecimento mútuo concluído! ${instanceA} enviou: "${resA.messageText}" ⇄ ${instanceB} respondeu: "${resB.messageText}".`,
    details: { turnA: resA.messageText, turnB: resB.messageText },
  };
}

/**
 * Ativa o Piloto Automático 100% autônomo entre duas instâncias,
 * preservando modelo/tema já configurados e respeitando a fase real de cada chip.
 */
export async function enablePairAutopilot(
  clientId: string,
  instanceA: string,
  instanceB: string
): Promise<{ success: boolean; message: string; error?: string }> {
  const nowIso = new Date().toISOString();

  const { data: existingRows } = await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .select("*")
    .eq("client_id", clientId)
    .in("instance_name", [instanceA, instanceB]);

  const existingByInst = new Map<string, WarmupConfig>();
  for (const row of (existingRows || []) as WarmupConfig[]) {
    if (row?.instance_name) existingByInst.set(row.instance_name, row);
  }

  const pairConfigs = [instanceA, instanceB].map((name) => {
    const prev = existingByInst.get(name);
    const realDays = calculateElapsedDaysFromCreatedAt(prev?.created_at, nowIso);
    const stage: WarmupStage =
      realDays !== null ? getMaxStageForDaysActive(realDays) : ((prev?.stage || 1) as WarmupStage);
    const stageDefaults = STAGE_DEFAULTS[stage];

    return {
      client_id: clientId,
      instance_name: name,
      enabled: true,
      stage,
      daily_target: stageDefaults.dailyTarget,
      stage_auto_progress: true,
      enable_vcard: true,
      enable_audio: true,
      enable_blue_ticks: true,
      enable_reactions: true,
      enable_status_posts: true,
      continuous_warmup: true,
      is_quarantined: false,
      quarantine_reason: null,
      min_interval_seconds: stageDefaults.minInterval,
      max_interval_seconds: stageDefaults.maxInterval,
      min_typing_seconds: prev?.min_typing_seconds || 3,
      max_typing_seconds: prev?.max_typing_seconds || 8,
      allowed_start_hour: prev?.allowed_start_hour ?? 8,
      allowed_end_hour: prev?.allowed_end_hour ?? 21,
      ai_model: prev?.ai_model || "fallback",
      ai_theme: prev?.ai_theme || "dia_a_dia",
      updated_at: nowIso,
    };
  });

  for (const cfg of pairConfigs) {
    try {
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .upsert(cfg, { onConflict: "client_id,instance_name" });
    } catch {}
  }

  try {
    await supabaseAdmin
      .from("whatsapp_warmup_conversations")
      .insert({
        client_id: clientId,
        instance_a: instanceA,
        instance_b: instanceB,
        topic: pickEffectiveConversationTheme(pairConfigs[0]?.ai_theme),
        history: [],
        turn_count: 0,
        max_turns: 6,
        status: "active",
        next_turn_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      });
  } catch {}

  await logWarmupAction({
    client_id: clientId,
    sender_instance: instanceA,
    receiver_instance: instanceB,
    message_text: `🚀 Piloto Automático Mútuo ATIVADO para ${instanceA} ⇄ ${instanceB}. Ambos aquecem sozinhos com todas as proteções anti-ban.`,
    action_type: "system",
  });

  return {
    success: true,
    message: `Piloto Automático Mútuo ativado com sucesso para ${instanceA} e ${instanceB}! Ambos estão aquecendo sozinhos 24/7 com proteção máxima.`,
  };
}

/**
 * Ativa o Piloto Automático para TODOS os chips (ou lista de chips) na Colmeia:
 * 1. Habilita todas as proteções anti-ban e modo malha aberta.
 * 2. Hidrata perfis dos chips (nome comercial, status/recado, Stories iniciais).
 * 3. Sincroniza adesão nos grupos de aquecimento cadastrados.
 * 4. Inicia conversas em malha entre os chips disponíveis.
 */
export async function enableSwarmAutopilot(
  clientId: string,
  instanceNames?: string[]
): Promise<{ success: boolean; message: string; chipsActivated: number; error?: string }> {
  try {
    let targetInstances = instanceNames || [];

    const { data: existingConfigs } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("*")
      .eq("client_id", clientId);

    const existingByInst = new Map<string, WarmupConfig>();
    for (const row of (existingConfigs || []) as WarmupConfig[]) {
      if (row?.instance_name) existingByInst.set(row.instance_name, row);
    }

    if (targetInstances.length === 0 && existingConfigs && existingConfigs.length > 0) {
      targetInstances = existingConfigs.map((c: WarmupConfig) => c.instance_name);
    }

    if (targetInstances.length === 0) {
      return {
        success: false,
        chipsActivated: 0,
        message: "Nenhuma instância encontrada para ativar na colmeia.",
      };
    }

    const nowIso = new Date().toISOString();

    for (const instName of targetInstances) {
      const prev = existingByInst.get(instName);
      const realDays = calculateElapsedDaysFromCreatedAt(prev?.created_at, nowIso);
      const stage: WarmupStage =
        realDays !== null ? getMaxStageForDaysActive(realDays) : ((prev?.stage || 1) as WarmupStage);
      const stageDefaults = STAGE_DEFAULTS[stage];

      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .upsert(
          {
            client_id: clientId,
            instance_name: instName,
            enabled: true,
            stage,
            daily_target: stageDefaults.dailyTarget,
            swarm_active: true,
            group_auto_join: true,
            stage_auto_progress: true,
            enable_vcard: true,
            enable_audio: true,
            enable_blue_ticks: true,
            enable_reactions: true,
            enable_status_posts: true,
            continuous_warmup: true,
            is_quarantined: false,
            quarantine_reason: null,
            min_interval_seconds: stageDefaults.minInterval,
            max_interval_seconds: stageDefaults.maxInterval,
            min_typing_seconds: prev?.min_typing_seconds || 3,
            max_typing_seconds: prev?.max_typing_seconds || 8,
            allowed_start_hour: prev?.allowed_start_hour ?? 8,
            allowed_end_hour: prev?.allowed_end_hour ?? 21,
            ai_model: prev?.ai_model || "fallback",
            ai_theme: prev?.ai_theme || "dia_a_dia",
            updated_at: nowIso,
          },
          { onConflict: "client_id,instance_name" }
        );

      hydrateChipProfile(clientId, instName).catch(() => {});
    }

    syncGroupMembershipForChips(clientId).catch(() => {});

    if (targetInstances.length >= 2) {
      const instA = targetInstances[0];
      const instB = targetInstances[1];
      try {
        await supabaseAdmin.from("whatsapp_warmup_conversations").insert({
          client_id: clientId,
          instance_a: instA,
          instance_b: instB,
          topic: pickEffectiveConversationTheme(existingByInst.get(instA)?.ai_theme),
          history: [],
          turn_count: 0,
          max_turns: 6,
          status: "active",
          next_turn_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        });
      } catch {}
    }

    await logWarmupAction({
      client_id: clientId,
      sender_instance: "swarm_orchestrator",
      receiver_instance: "colmeia",
      message_text: `🐝 Colmeia Autônoma ATIVADA para ${targetInstances.length} chips. Rede em malha e grupos ativados.`,
      action_type: "system",
    });

    return {
      success: true,
      chipsActivated: targetInstances.length,
      message: `Colmeia Autônoma ativada com sucesso para ${targetInstances.length} chip(s)! Todos estão aquecendo sozinhos com proteção máxima.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, chipsActivated: 0, message: msg, error: msg };
  }
}

/**
 * Dispara uma rodada completa de aquecimento na colmeia inteira:
 * Executa trocas mútuas entre os pares disponíveis e sincroniza grupos.
 */
export async function triggerSwarmCycle(
  clientId: string,
  instanceNames?: string[]
): Promise<{ success: boolean; message: string; roundsExecuted: number; error?: string }> {
  try {
    let targetInstances = instanceNames || [];

    if (targetInstances.length === 0) {
      const { data: configs } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("instance_name")
        .eq("client_id", clientId)
        .eq("enabled", true)
        .eq("is_quarantined", false);

      if (configs && configs.length > 0) {
        targetInstances = configs.map((c) => c.instance_name);
      }
    }

    if (targetInstances.length < 2) {
      if (targetInstances.length === 1) {
        await syncGroupMembershipForChips(clientId);
        await hydrateChipProfile(clientId, targetInstances[0]);
        return {
          success: true,
          roundsExecuted: 1,
          message: `Chip ${targetInstances[0]} sincronizado com os grupos da colmeia e perfil hidratado!`,
        };
      }
      return {
        success: false,
        roundsExecuted: 0,
        message: "Necessário ao menos 1 chip ativo para rodada na colmeia.",
      };
    }

    let roundsExecuted = 0;
    for (let i = 0; i < targetInstances.length - 1; i += 2) {
      const instA = targetInstances[i];
      const instB = targetInstances[i + 1];
      const res = await triggerMutualWarmup(clientId, instA, instB);
      if (res.success) {
        roundsExecuted++;
      }
    }

    if (targetInstances.length % 2 !== 0 && targetInstances.length >= 3) {
      const last = targetInstances[targetInstances.length - 1];
      const first = targetInstances[0];
      await triggerMutualWarmup(clientId, last, first).catch(() => {});
      roundsExecuted++;
    }

    syncGroupMembershipForChips(clientId).catch(() => {});

    return {
      success: true,
      roundsExecuted,
      message: `Rodada da colmeia concluída com sucesso! ${roundsExecuted} pares interagiram mutuamente.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, roundsExecuted: 0, message: msg, error: msg };
  }
}

/**
 * Diluição Simbiótica Anti-Ban durante Prospecção Fria:
 * Quando um chip (`coldSenderInstance`) dispara mensagens frias no `campaign-worker`,
 * esta função seleciona um chip irmão conectado e saudável (`peerInstance`) para
 * iniciar uma troca bidirecional rápida (`peer -> coldSender -> peer`).
 *
 * Efeito no classificador da Meta:
 * 1. O chip de prospecção RECEBE uma mensagem (`inbound`) de um contato conhecido.
 * 2. O chip de prospecção RESPONDE (`reply_rate` sobe) e tem sua resposta lida/reagida.
 * 3. Dilui a sequência de conversas iniciadas no vácuo (Unanswered Out-Degree Spike).
 */
function isChipQuarantinedNow(cfg: Partial<WarmupConfig> | undefined, nowMs = Date.now()): boolean {
  if (!cfg?.is_quarantined) return false;
  if (!cfg.quarantine_until) return true;
  const untilMs = new Date(cfg.quarantine_until).getTime();
  return Number.isNaN(untilMs) || untilMs > nowMs;
}

export async function triggerSymbioticWarmupPulse(
  clientId: string,
  coldSenderInstance: string,
  nowMs = Date.now()
): Promise<{ triggered: boolean; peerInstance?: string; reason?: string }> {
  try {
    if (!clientId || !coldSenderInstance) {
      return { triggered: false, reason: "missing_params" };
    }

    const lastPulse = _lastSymbioticPulseAt.get(coldSenderInstance) || 0;
    if (nowMs - lastPulse < SYMBIOTIC_PULSE_COOLDOWN_MS) {
      return { triggered: false, reason: "cooldown_active" };
    }

    const [connections, { configs: configMap }] = await Promise.all([
      readTenantConnections(clientId),
      readTenantWarmupConfigs(clientId),
    ]);

    const coldCfg = configMap[coldSenderInstance];
    if (isChipQuarantinedNow(coldCfg, nowMs)) {
      return { triggered: false, reason: "cold_chip_quarantined" };
    }

    const statusByInstance = new Map(connections.map((c) => [c.instance_name, c.status]));
    const candidatePeers = Object.values(configMap)
      .filter((c) => {
        if (!c || c.instance_name === coldSenderInstance) return false;
        if (isChipQuarantinedNow(c, nowMs)) return false;
        if ((c.health_score ?? 100) < 45) return false;
        const connStatus = statusByInstance.get(c.instance_name);
        return connStatus ? isConnectedStatus(connStatus) : true;
      })
      .sort((a, b) => (b.health_score ?? 100) - (a.health_score ?? 100));

    let peerConfig: WarmupConfig | null = candidatePeers[0] || null;
    if (!peerConfig) {
      // Fallback seguro: somente conexões abertas que NÃO estão em quarentena/degradadas no configMap
      const openConnPeer = connections.find((c) => {
        if (c.instance_name === coldSenderInstance || !isConnectedStatus(c.status)) return false;
        const cfg = configMap[c.instance_name];
        return !cfg || (!isChipQuarantinedNow(cfg, nowMs) && (cfg.health_score ?? 100) >= 45);
      });
      if (!openConnPeer) {
        return { triggered: false, reason: "no_peer_available" };
      }
      peerConfig = {
        client_id: clientId,
        instance_name: openConnPeer.instance_name,
        enabled: true,
        stage: 2,
        stage_auto_progress: true,
        days_active: 4,
        consecutive_successful_days: 1,
        health_score: 100,
        is_quarantined: false,
        daily_target: 25,
        sent_today: 0,
        received_today: 0,
        error_count_today: 0,
        min_interval_seconds: 150,
        max_interval_seconds: 420,
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
      };
    }

    const receiverConfig: WarmupConfig = coldCfg || {
      client_id: clientId,
      instance_name: coldSenderInstance,
      enabled: true,
      stage: 2,
      stage_auto_progress: true,
      days_active: 4,
      consecutive_successful_days: 1,
      health_score: 100,
      is_quarantined: false,
      daily_target: 25,
      sent_today: 0,
      received_today: 0,
      error_count_today: 0,
      min_interval_seconds: 150,
      max_interval_seconds: 420,
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
    };

    // Agenda 1 turno assíncrono não-manual (peer -> coldSender); o retorno acontece em 3–7 min no worker,
    // eliminando rajadas síncronas de 24 segundos detectáveis por heurística anti-spam.
    const nowIso = new Date(nowMs).toISOString();
    const convId = `symbiotic_${[peerConfig.instance_name, coldSenderInstance].sort().join("_")}_${Math.floor(nowMs / (60 * 60 * 1000))}`;
    const convPayload: WarmupConversation = {
      id: convId,
      client_id: clientId,
      instance_a: peerConfig.instance_name,
      instance_b: coldSenderInstance,
      topic: pickEffectiveConversationTheme(peerConfig.ai_theme),
      history: [],
      turn_count: 0,
      max_turns: 4,
      status: "active",
      next_turn_at: new Date(nowMs + 180 * 1000).toISOString(),
    };

    try {
      await supabaseAdmin
        .from("whatsapp_warmup_conversations")
        .upsert(
          {
            ...convPayload,
            created_at: nowIso,
            updated_at: nowIso,
          },
          { onConflict: "id" }
        );
    } catch {}

    _lastSymbioticPulseAt.set(coldSenderInstance, nowMs);
    pruneMapToLimit?.(_lastSymbioticPulseAt, 2000);

    const res = await executeWarmupTurn({
      clientId,
      senderConfig: peerConfig,
      receiverConfig,
      conversation: convPayload,
      isManualTrigger: false,
    });

    if (res.success) {
      await logWarmupAction({
        client_id: clientId,
        sender_instance: peerConfig.instance_name,
        receiver_instance: coldSenderInstance,
        message_text: `🛡️ Escudo Simbiótico: turno orgânico assíncrono (${peerConfig.instance_name} → ${coldSenderInstance}) intercalado na prospecção fria.`,
        action_type: "system",
      });
    }

    return {
      triggered: res.success,
      peerInstance: peerConfig.instance_name,
      reason: res.success ? "ok" : res.error || "turn_failed",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { triggered: false, reason: msg };
  }
}

