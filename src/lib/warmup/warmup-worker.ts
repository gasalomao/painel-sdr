import { supabaseAdmin } from "@/lib/supabase_admin";
import {
  calculateElapsedDaysFromCreatedAt,
  evaluateDailyAutoProgress,
  executeWarmupTurn,
  getAutoCareerPurpose,
  getBrazilDayKey,
  getHourlySendCap,
  getMaxStageForDaysActive,
  getOrganicScheduleDecision,
  isWithinOperatingHours,
  logWarmupAction,
} from "./warmup-engine";
import {
  calculateInterConversationCooldownSec,
   getRandomStatusQuote,
  pickEffectiveConversationTheme,
} from "./warmup-dialogues";
import { STAGE_DEFAULTS, type WarmupConfig, type WarmupConversation, type WarmupStage } from "./warmup-types";
import { syncGroupMembershipForChips, hydrateChipProfile } from "./warmup-groups";
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
export function selectAsymmetricWarmupPair(
  idleChips: WarmupConfig[],
  activePairs: Set<string>,
  nowMs = Date.now()
): { initiator: WarmupConfig; partner: WarmupConfig } | null {
  if (idleChips.length < 2) return null;

  const initiatorScore = (c: WarmupConfig): number => {
    const stageScore = (c.stage || 1) * 100;
    const daysScore = Math.min(30, c.days_active || 1) * 3;
    const healthScore = Math.round((c.health_score ?? 100) * 0.5);
    const inboundSurplus = ((c.received_today || 0) - (c.sent_today || 0)) * 4;
    const purposeBias = c.purpose === "inbound" ? -35 : c.purpose === "outbound" ? 15 : 0;
    return stageScore + daysScore + healthScore + inboundSurplus + purposeBias;
  };

  const sortedForInitiator = [...idleChips].sort(
    (a, b) => initiatorScore(b) - initiatorScore(a)
  );

  for (const initiator of sortedForInitiator) {
    const candidates = idleChips.filter((c) => {
      if (c.instance_name === initiator.instance_name) return false;
      const pairKey = [initiator.instance_name, c.instance_name].sort().join("::");
      if (activePairs.has(pairKey)) return false;
      const cooldownUntil = _pairCooldownUntil.get(pairKey) || 0;
      return nowMs >= cooldownUntil;
    });

    if (candidates.length === 0) continue;

    // Prefere parceiro que mais precisa de mensagens recebidas (menor fase ou menor received_today)
    const partnerSorted = [...candidates].sort((a, b) => {
      const recDiff = (a.received_today || 0) - (b.received_today || 0);
      if (recDiff !== 0) return recDiff;
      return (a.stage || 1) - (b.stage || 1);
    });
    const topSlice = partnerSorted.slice(0, Math.min(2, partnerSorted.length));
    const partner = topSlice[Math.floor(Math.random() * topSlice.length)];
    if (partner) {
      return { initiator, partner };
    }
  }

  return null;
}

function recordChipHourSend(instanceName: string, nowMs = Date.now()): void {
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const current = (_hourlySendTimestamps.get(instanceName) || []).filter((ts) => ts > oneHourAgo);
  current.push(nowMs);
  _hourlySendTimestamps.set(instanceName, current);
}

function isChipWithinHourlyPace(cfg: WarmupConfig, nowMs = Date.now()): boolean {
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const recent = (_hourlySendTimestamps.get(cfg.instance_name) || []).filter((ts) => ts > oneHourAgo);
  _hourlySendTimestamps.set(cfg.instance_name, recent);
  const cap = getHourlySendCap(cfg, effectiveTarget(cfg));
  return recent.length < cap;
}

function scheduleGroupSync(clientId: string): void {
  const last = _lastGroupSyncAt[clientId] || 0;
  if (Date.now() - last < GROUP_SYNC_INTERVAL_MS) return;
  if (_groupSyncInFlight.has(clientId)) return;

  _lastGroupSyncAt[clientId] = Date.now();
  _groupSyncInFlight.add(clientId);
  syncGroupMembershipForChips(clientId)
    .catch(() => {})
    .finally(() => _groupSyncInFlight.delete(clientId));
}

// Máximo de turnos por chip dentro do mesmo tick, para não gerar rajada.
const MAX_TURNS_PER_CHIP_PER_TICK = 1;

function effectiveTarget(config: WarmupConfig): number {
  return getEffectiveDailyTarget(config);
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
      processedTenants++;

      // Lock por tenant: evita dois processos enviando no mesmo minuto.
      const locked = await acquireWarmupTickLock(clientId, lockOwner);
      if (!locked) {
        console.log(`[WarmupWorker] Tenant ${clientId} já está sendo processado por outro processo. Pulando tick.`);
        continue;
      }

      try {
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
            days_active: newDaysActive,
            consecutive_successful_days: newConsecutiveDays,
            updated_at: nowIso,
          };

          cfg.sent_today = 0;
          cfg.received_today = 0;
          cfg.error_count_today = 0;
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

          await supabaseAdmin
            .from("whatsapp_warmup_configs")
            .update(update)
            .eq("id", cfg.id)
            .eq("client_id", clientId);

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
        const nonQuarantined = configs.filter((c) => !c.is_quarantined);

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

          scheduleGroupSync(clientId);

          // Publica Status periódicos mesmo quando há apenas 1 chip conectado
          if (
            soleChip.enable_status_posts !== false &&
            (!soleChip.last_status_post_at ||
              nowMs - new Date(soleChip.last_status_post_at).getTime() > 24 * 60 * 60 * 1000)
          ) {
            try {
              const { evolution } = await import("@/lib/evolution");
              const quote = getRandomStatusQuote();
              await evolution.sendStatus(quote, "text", soleChip.instance_name);
              await supabaseAdmin
                .from("whatsapp_warmup_configs")
                .update({ last_status_post_at: nowIso, updated_at: nowIso })
                .eq("instance_name", soleChip.instance_name)
                .eq("client_id", clientId);

              await logWarmupAction({
                client_id: clientId,
                sender_instance: soleChip.instance_name,
                receiver_instance: "status@broadcast",
                message_text: `Publicou Story no WhatsApp Status (modo passivo): "${quote}"`,
                action_type: "status",
              });
            } catch {}
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

        // Pré-filtra pelo ritmo em RAM; se houver chips elegíveis, hidrata contadores reais do banco na 1ª passada
        let availableChips = nonQuarantined.filter(
          (c) => (c.sent_today || 0) < effectiveTarget(c) && isChipWithinHourlyPace(c, nowMs)
        );

        if (availableChips.length === 0) {
          continue;
        }

        await hydrateWarmupHourlyCountsIfNeeded(clientId, nowMs);
        availableChips = nonQuarantined.filter(
          (c) => (c.sent_today || 0) < effectiveTarget(c) && isChipWithinHourlyPace(c, nowMs)
        );
        if (availableChips.length === 0) {
          continue;
        }

        // 3. Consolida conversas ativas duplicadas do mesmo par (legado do bug de
        // criação por tick). Mantém a mais antiga e encerra as demais.
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

          if (duplicateIds.length > 0) {
            await supabaseAdmin
              .from("whatsapp_warmup_conversations")
              .update({ status: "finished", updated_at: nowIso })
              .in("id", duplicateIds);
          }

          activePairs = keptPairs;
        } catch {}

        // 4. Processa conversas ativas com turno pendente (next_turn_at <= now())
        const { data: dueConvs } = await supabaseAdmin
          .from("whatsapp_warmup_conversations")
          .select("*")
          .eq("client_id", clientId)
          .eq("status", "active")
          .lte("next_turn_at", nowIso)
          .order("next_turn_at", { ascending: true })
          .limit(3);

        const busyChips = new Set<string>();
        const sentThisTick = new Map<string, number>();

        if (dueConvs && dueConvs.length > 0) {
          for (const activeConv of dueConvs as WarmupConversation[]) {
            const instA = nonQuarantined.find((c) => c.instance_name === activeConv.instance_a);
            const instB = nonQuarantined.find((c) => c.instance_name === activeConv.instance_b);

            if (instA && instB) {
              busyChips.add(instA.instance_name);
              busyChips.add(instB.instance_name);

              const senderCfg = activeConv.last_sender === instA.instance_name ? instB : instA;
              const receiverCfg = senderCfg.instance_name === instA.instance_name ? instB : instA;

              // Anti-rajada: no máximo 1 turno por chip dentro do mesmo tick e respeita ritmo por hora.
              if (
                (sentThisTick.get(senderCfg.instance_name) || 0) >= MAX_TURNS_PER_CHIP_PER_TICK ||
                !isChipWithinHourlyPace(senderCfg, nowMs)
              ) {
                continue;
              }

              // Fora da janela do chip remetente: não chama o motor
              if (
                !isWithinOperatingHours(
                  senderCfg.allowed_start_hour ?? 8,
                  senderCfg.allowed_end_hour ?? 21
                )
              ) {
                continue;
              }

              if ((senderCfg.sent_today || 0) < effectiveTarget(senderCfg)) {
                const turnRes = await executeWarmupTurn({
                  clientId,
                  senderConfig: senderCfg,
                  receiverConfig: receiverCfg,
                  conversation: activeConv,
                });
                if (turnRes.success) {
                  exchangesCount++;
                  senderCfg.sent_today = (senderCfg.sent_today || 0) + 1;
                  receiverCfg.received_today = (receiverCfg.received_today || 0) + 1;
                  sentThisTick.set(
                    senderCfg.instance_name,
                    (sentThisTick.get(senderCfg.instance_name) || 0) + 1
                  );
                  recordChipHourSend(senderCfg.instance_name, nowMs);

                  // Se este turno encerrou a conversa, aplica cooldown humano entre sessões do par
                  if ((activeConv.turn_count || 0) + 1 >= (activeConv.max_turns || 6)) {
                    const pairKey = [instA.instance_name, instB.instance_name].sort().join("::");
                    const cooldownSec = calculateInterConversationCooldownSec(
                      Math.min(instA.stage || 1, instB.stage || 1)
                    );
                    _pairCooldownUntil.set(pairKey, nowMs + cooldownSec * 1000);
                  }
                }
              } else {
                await supabaseAdmin
                  .from("whatsapp_warmup_conversations")
                  .update({ status: "finished", updated_at: nowIso })
                  .eq("id", activeConv.id);
              }
            }
          }
        }

        // 5. Se houver chips ociosos disponíveis, cria novas conversas em malha (Mesh Swarm Assimétrico)
        const idleChips = availableChips.filter(
          (c) => !busyChips.has(c.instance_name) && !sentThisTick.has(c.instance_name)
        );

        const pickedPair = selectAsymmetricWarmupPair(idleChips, activePairs, nowMs);
        if (pickedPair) {
          const { initiator, partner } = pickedPair;
          const scheduleDecision =
            process.env.VITEST === "true" || process.env.NODE_ENV === "test"
              ? {
                  allowed: isWithinOperatingHours(
                    initiator.allowed_start_hour ?? 8,
                    initiator.allowed_end_hour ?? 21
                  ),
                  inLunchLull: false,
                }
              : getOrganicScheduleDecision(
                  initiator.instance_name,
                  initiator.allowed_start_hour ?? 8,
                  initiator.allowed_end_hour ?? 21,
                  now
                );

          // Durante a pausa orgânica do almoço/jantar, reduz em 65% o início de novas conversas
          const skipForLunch = scheduleDecision.inLunchLull && Math.random() < 0.65;

          if (scheduleDecision.allowed && !skipForLunch) {
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

    const statusByInstance = new Map(connections.map((c) => [c.instance_name, c.status]));
    const candidatePeers = Object.values(configMap)
      .filter((c) => {
        if (!c || c.instance_name === coldSenderInstance) return false;
        if (c.is_quarantined) return false;
        if ((c.health_score ?? 100) < 45) return false;
        const connStatus = statusByInstance.get(c.instance_name);
        return connStatus ? isConnectedStatus(connStatus) : true;
      })
      .sort((a, b) => (b.health_score ?? 100) - (a.health_score ?? 100));

    if (candidatePeers.length === 0) {
      // Fallback: tenta conexões abertas mesmo sem linha explícita no configMap
      const openConnPeer = connections.find(
        (c) => c.instance_name !== coldSenderInstance && isConnectedStatus(c.status)
      );
      if (!openConnPeer) {
        return { triggered: false, reason: "no_peer_available" };
      }
      _lastSymbioticPulseAt.set(coldSenderInstance, nowMs);
      const res = await triggerMutualWarmup(clientId, openConnPeer.instance_name, coldSenderInstance, false);
      return {
        triggered: res.success,
        peerInstance: openConnPeer.instance_name,
        reason: res.success ? "ok" : res.error || "mutual_failed",
      };
    }

    const peer = candidatePeers[0];
    _lastSymbioticPulseAt.set(coldSenderInstance, nowMs);

    // Importante: `peer.instance_name` envia PRIMEIRO para `coldSenderInstance`,
    // para que o chip que está prospectando no frio RECEBA uma mensagem inbound e responda!
    const res = await triggerMutualWarmup(clientId, peer.instance_name, coldSenderInstance, false);
    if (res.success) {
      await logWarmupAction({
        client_id: clientId,
        sender_instance: peer.instance_name,
        receiver_instance: coldSenderInstance,
        message_text: `🛡️ Escudo Simbiótico: pulso bidirecional (${peer.instance_name} ⇄ ${coldSenderInstance}) intercalado na prospecção fria para blindar a taxa de resposta na Meta.`,
        action_type: "system",
      });
    }

    return {
      triggered: res.success,
      peerInstance: peer.instance_name,
      reason: res.success ? "ok" : res.error || "mutual_failed",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { triggered: false, reason: msg };
  }
}

