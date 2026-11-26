import { supabaseAdmin } from "@/lib/supabase_admin";
import { ensureProxyForInstance } from "@/lib/proxy-pool";
import { isTenantWarmupAdmin } from "./warmup-admin-guard";
import {
  getEffectiveDailyTarget,
  getMmzapGovernorSettings,
} from "./warmup-config-service";
import {
  evaluateExternalShieldGraduation,
  getBrazilHour,
  logWarmupAction,
} from "./warmup-engine";
import {
  evaluateMmzapShiftGovernor,
  invalidateExternalShieldCache,
} from "./warmup-external-shield";
import {
  getMmzapWorkerHealth,
  isMmzapWorkerConfigured,
  startMmzapWorkerShift,
  stopMmzapWorkerSession,
  type MmzapWorkerProxyInput,
  type MmzapWorkerSessionStatus,
} from "./mmzap-browser-client";
import type {
  ExternalWarmupMode,
  MmzapBrowserStatus,
  MmzapGovernorSettings,
  WarmupConfig,
  WarmupStage,
} from "./warmup-types";

export const MMZAP_ERROR_AUTO_RECOVERY_MS = 3 * 60 * 60 * 1000;

type WorkerSessionWithWatchdog = MmzapWorkerSessionStatus & {
  sessionLoggedOut?: boolean;
  mmzapWatchdogRecoveries?: number;
  lastWatchdogCheckAt?: string | null;
  proxyLatencyMs?: number | null;
};

/**
 * Identifica erros MMZap que exigem ação humana (re-escanear QR ou configurar extensão)
 * e portanto NÃO devem ser resetados automaticamente para "idle".
 */
export function isNonRecoverableMmzapError(lastError?: string | null): boolean {
  const raw = String(lastError || "").trim().toLowerCase();
  if (!raw) return false;
  return (
    raw === "qr_required" ||
    raw.includes("qr_required") ||
    raw.includes("session_logged_out") ||
    raw === "needs_extension_setup" ||
    raw === "unpaired"
  );
}

/**
 * Consulta somente leitura do host de proxy atualmente atribuído à instância no `proxy_pool`
 * (sem acionar `ensureProxyForInstance` nem probe TCP de 2.5s a cada tick de 60s).
 */
export async function readAssignedProxyHostReadOnly(instanceName: string): Promise<string | null> {
  if (!instanceName) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("proxy_pool")
      .select("host")
      .eq("assigned_instance", instanceName)
      .eq("status", "assigned")
      .maybeSingle();

    if (!error && data?.host) {
      return String(data.host);
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function resolveMmzapProxyForInstance(
  clientId: string,
  instanceName: string
): Promise<MmzapWorkerProxyInput | null> {
  if (!instanceName) return null;

  await ensureProxyForInstance({
    instanceName,
    clientId,
    reason: "warmup",
    forWarmup: true,
  }).catch(() => null);

  try {
    const { data, error } = await supabaseAdmin
      .from("proxy_pool")
      .select("host, port, protocol, username, password")
      .eq("assigned_instance", instanceName)
      .eq("status", "assigned")
      .maybeSingle();

    if (!error && data?.host && data?.port) {
      const protocol = String(data.protocol || "http").toLowerCase();
      return {
        server: `${protocol}://${data.host}:${data.port}`,
        username: data.username ? String(data.username) : null,
        password: data.password ? String(data.password) : null,
        sourceHost: String(data.host),
      };
    }
  } catch {
    /* fail-open para IP padrão da VPS quando proxy_pool não estiver disponível */
  }

  return null;
}

export async function updateMmzapConfigFields(
  clientId: string,
  instanceName: string,
  fields: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .update(fields)
      .eq("client_id", clientId)
      .eq("instance_name", instanceName);

    if (
      error &&
      (error.code === "42703" ||
        error.code === "PGRST204" ||
        String(error.message || "").includes("mmzap_"))
    ) {
      return;
    }
  } catch {
    /* ignore pre-032 */
  } finally {
    invalidateExternalShieldCache(clientId, instanceName);
  }
}

export async function stopMmzapSessionForChip(
  clientId: string,
  instanceName: string,
  reason = "governor_stop"
): Promise<{ stopped: boolean; status: MmzapBrowserStatus }> {
  const nowIso = new Date().toISOString();
  await stopMmzapWorkerSession(instanceName, reason).catch(() => null);

  let prevMinutes = 0;
  let startedAtMs: number | null = null;
  let currentExternalMode: ExternalWarmupMode | null = null;
  try {
    const { data } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("mmzap_minutes_today, mmzap_shift_started_at, external_warmup_mode")
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .maybeSingle();

    if (data) {
      prevMinutes = Number((data as { mmzap_minutes_today?: number }).mmzap_minutes_today || 0);
      const startedIso = (data as { mmzap_shift_started_at?: string | null }).mmzap_shift_started_at;
      if (startedIso) {
        const parsed = new Date(startedIso).getTime();
        if (Number.isFinite(parsed)) startedAtMs = parsed;
      }
      const rawMode = (data as { external_warmup_mode?: string | null }).external_warmup_mode;
      if (rawMode === "off" || rawMode === "receive_only" || rawMode === "hybrid_quarantine") {
        currentExternalMode = rawMode;
      }
    }
  } catch {
    /* ignore */
  }

  const deltaMin = startedAtMs ? Math.max(0, Math.round((Date.now() - startedAtMs) / 60_000)) : 0;
  const nextStatus: MmzapBrowserStatus =
    reason === "unanswered_brake" ? "paused_safety" : "idle";

  const updateFields: Record<string, unknown> = {
    mmzap_browser_status: nextStatus,
    mmzap_last_shift_ended_at: nowIso,
    mmzap_shift_started_at: null,
    mmzap_minutes_today: prevMinutes + deltaMin,
    mmzap_last_error: reason,
    updated_at: nowIso,
  };

  let graduatedShieldToHybrid = false;
  if (reason === "auto_disabled_stage") {
    updateFields.mmzap_browser_enabled = false;
    if (currentExternalMode === "receive_only") {
      updateFields.external_warmup_mode = "hybrid_quarantine";
      graduatedShieldToHybrid = true;
    }
  }

  await updateMmzapConfigFields(clientId, instanceName, updateFields);

  await logWarmupAction({
    client_id: clientId,
    sender_instance: instanceName,
    receiver_instance: "mmzap_governor",
    message_text: graduatedShieldToHybrid
      ? `⏸️ Turno MMZap encerrado e auto-desativado por fase para ${instanceName}. Escudo Externo graduado automaticamente para "hybrid_quarantine" (leads comerciais liberados para a Sarah/CRM).`
      : `⏸️ Turno MMZap encerrado para ${instanceName} (motivo: ${reason}).`,
    action_type: "system",
  }).catch(() => {});

  return { stopped: true, status: nextStatus };
}

function getMaxShiftsForStage(stage: number, governor: MmzapGovernorSettings): number {
  if (stage <= 1) return governor.max_shifts_stage1;
  if (stage === 2) return governor.max_shifts_stage2;
  if (stage === 3) return governor.max_shifts_stage3;
  return governor.max_shifts_stage3 + 1;
}

export function selectNextMmzapShiftCandidate(params: {
  configs: WarmupConfig[];
  governor: MmzapGovernorSettings;
  activeWorkerNames?: Set<string>;
  connectedInstances?: Set<string>;
  nowMs?: number;
}): WarmupConfig | null {
  const {
    configs,
    governor,
    activeWorkerNames = new Set<string>(),
    connectedInstances,
    nowMs = Date.now(),
  } = params;

  if (!governor.enabled) return null;

  const currentHour = getBrazilHour(new Date(nowMs));
  if (currentHour < governor.allowed_start_hour || currentHour >= governor.allowed_end_hour) {
    return null;
  }

  const restMs = Math.max(1, governor.min_rest_minutes) * 60_000;
  const day0Ms = Math.max(0, governor.day0_cooldown_hours) * 3_600_000;

  const eligible = configs.filter((cfg) => {
    if (!cfg.enabled || cfg.is_quarantined) return false;
    if (connectedInstances && !connectedInstances.has(cfg.instance_name)) return false;
    if (
      cfg.career_mode === "rehab" ||
      cfg.career_mode === "production_light" ||
      cfg.career_mode === "maintenance"
    ) {
      return false;
    }
    if (!cfg.mmzap_browser_enabled) return false;
    if (!cfg.external_warmup_mode || cfg.external_warmup_mode === "off") return false;
    if ((cfg.mmzap_browser_status || "unpaired") !== "idle") return false;
    if (activeWorkerNames.has(cfg.instance_name)) return false;

    const stage = cfg.stage || 1;
    if (
      stage >= governor.auto_disable_stage &&
      (cfg.mmzap_max_sends_override === null || cfg.mmzap_max_sends_override === undefined)
    ) {
      return false;
    }

    if (day0Ms > 0 && (cfg.days_active || 1) <= 1 && cfg.created_at) {
      const createdMs = new Date(cfg.created_at).getTime();
      if (Number.isFinite(createdMs) && nowMs - createdMs < day0Ms) {
        return false;
      }
    }

    const maxShifts = getMaxShiftsForStage(stage, governor);
    if ((cfg.mmzap_shifts_today || 0) >= maxShifts) return false;

    if (cfg.mmzap_last_shift_ended_at) {
      const stopMs = new Date(cfg.mmzap_last_shift_ended_at).getTime();
      if (Number.isFinite(stopMs) && nowMs - stopMs < restMs) {
        return false;
      }
    }

    const decision = evaluateMmzapShiftGovernor({
      stage,
      mmzapSentToday: cfg.external_mmzap_sent_today || 0,
      mmzapInboundToday: cfg.external_warmup_inbound_today || 0,
      internalSentToday: cfg.sent_today || 0,
      dailyTarget: getEffectiveDailyTarget(cfg),
      mmzapMaxSendsOverride: cfg.mmzap_max_sends_override ?? null,
      mmzapShiftStartedAt: null,
      mmzapBrowserStatus: cfg.mmzap_browser_status || "idle",
      governorSettings: governor,
      nowMs,
    });

    return !decision.shouldStop;
  });

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const shiftsDiff = (a.mmzap_shifts_today || 0) - (b.mmzap_shifts_today || 0);
    if (shiftsDiff !== 0) return shiftsDiff;
    const inboundDiff =
      (a.external_warmup_inbound_today || 0) - (b.external_warmup_inbound_today || 0);
    if (inboundDiff !== 0) return inboundDiff;
    const stopA = a.mmzap_last_shift_ended_at ? new Date(a.mmzap_last_shift_ended_at).getTime() : 0;
    const stopB = b.mmzap_last_shift_ended_at ? new Date(b.mmzap_last_shift_ended_at).getTime() : 0;
    return stopA - stopB;
  });

  return eligible[0];
}

export async function tickMmzapBrowserOrchestrator(params: {
  clientId: string;
  configs: WarmupConfig[];
  connectedInstanceNames: Set<string>;
  activeCampaignInstances?: Set<string>;
  nowMs?: number;
}): Promise<{ started: string[]; stopped: string[] }> {
  const {
    clientId,
    configs,
    connectedInstanceNames,
    activeCampaignInstances,
    nowMs = Date.now(),
  } = params;
  const started: string[] = [];
  const stopped: string[] = [];

  if (!isMmzapWorkerConfigured()) {
    return { started, stopped };
  }
  if (!(await isTenantWarmupAdmin(clientId))) {
    return { started, stopped };
  }

  const activeCampaignSet = new Set<string>();
  if (activeCampaignInstances) {
    for (const inst of activeCampaignInstances) {
      const clean = String(inst || "").trim().toLowerCase();
      if (clean) activeCampaignSet.add(clean);
    }
  }

  const governor = await getMmzapGovernorSettings(clientId);
  const health = await getMmzapWorkerHealth();
  if (!health.reachable) {
    return { started, stopped };
  }

  const workerSessionsMap = new Map<string, WorkerSessionWithWatchdog>(
    health.sessions.map((s) => [s.instanceName, s as WorkerSessionWithWatchdog])
  );
  const activeWorkerNames = new Set(
    health.sessions
      .filter((s) => s.status === "running" || s.status === "qr_pending" || s.status === "setup")
      .map((s) => s.instanceName)
  );

  // 1. Reconcilia, auto-recupera erros transitórios e aplica o governador nas sessões "running"
  for (const cfg of configs) {
    const status = cfg.mmzap_browser_status || "unpaired";
    const stage = Math.max(1, Math.min(4, Number(cfg.stage || 1))) as WarmupStage;
    const isCampaignActive = activeCampaignSet.has(cfg.instance_name.trim().toLowerCase());

    // Exclusão mútua estrita: campanha fria ativa e MMZap nunca rodam juntos no mesmo chip
    if (isCampaignActive) {
      if (status === "running") {
        await stopMmzapSessionForChip(clientId, cfg.instance_name, "campaign_active");
        stopped.push(cfg.instance_name);
        cfg.mmzap_browser_status = "idle";
        cfg.mmzap_last_shift_ended_at = new Date(nowMs).toISOString();
        activeWorkerNames.delete(cfg.instance_name);
      }
      continue;
    }

    // Auto-desativação automática ao atingir Fase configurada (ex: Fase 4), salvo override manual
    if (
      cfg.mmzap_browser_enabled &&
      stage >= governor.auto_disable_stage &&
      (cfg.mmzap_max_sends_override === null || cfg.mmzap_max_sends_override === undefined)
    ) {
      const shieldGrad = evaluateExternalShieldGraduation({
        currentMode: cfg.external_warmup_mode,
        stage,
        purpose: cfg.purpose,
        mmzapAutoDisabled: true,
        mmzapBrowserEnabled: false,
        nowMs,
      });

      if (status === "running") {
        await stopMmzapSessionForChip(clientId, cfg.instance_name, "auto_disabled_stage");
        stopped.push(cfg.instance_name);
        cfg.mmzap_browser_status = "idle";
        if (shieldGrad.shouldTransition) {
          cfg.external_warmup_mode = shieldGrad.nextMode;
        }
      } else {
        const autoDisableFields: Record<string, unknown> = {
          mmzap_browser_enabled: false,
          mmzap_last_error: "auto_disabled_stage",
          updated_at: new Date(nowMs).toISOString(),
        };
        if (shieldGrad.shouldTransition) {
          autoDisableFields.external_warmup_mode = shieldGrad.nextMode;
          cfg.external_warmup_mode = shieldGrad.nextMode;
        }
        await updateMmzapConfigFields(clientId, cfg.instance_name, autoDisableFields);
        if (shieldGrad.shouldTransition) {
          await logWarmupAction({
            client_id: clientId,
            sender_instance: cfg.instance_name,
            receiver_instance: "external_shield",
            message_text: `🛡️ MMZap auto-desativado na Fase ${stage} para ${cfg.instance_name}. Escudo Externo graduado automaticamente para "${shieldGrad.nextMode}".`,
            action_type: "system",
          }).catch(() => {});
        }
      }
      cfg.mmzap_browser_enabled = false;
      activeWorkerNames.delete(cfg.instance_name);
      continue;
    }

    // Graduação automática do Escudo Externo em Fase 4 após >= 48h sem tráfego externo (hybrid_quarantine -> off)
    if (cfg.external_warmup_mode === "hybrid_quarantine" && stage >= 4 && cfg.mmzap_browser_enabled === false) {
      const quietGrad = evaluateExternalShieldGraduation({
        currentMode: cfg.external_warmup_mode,
        stage,
        purpose: cfg.purpose,
        mmzapBrowserEnabled: false,
        externalWarmupLastAt: cfg.external_warmup_last_at ?? null,
        externalWarmupInboundToday: cfg.external_warmup_inbound_today ?? 0,
        mmzapLastShiftEndedAt: cfg.mmzap_last_shift_ended_at ?? null,
        nowMs,
      });
      if (quietGrad.shouldTransition && quietGrad.nextMode === "off") {
        await updateMmzapConfigFields(clientId, cfg.instance_name, {
          external_warmup_mode: "off",
          updated_at: new Date(nowMs).toISOString(),
        });
        cfg.external_warmup_mode = "off";
        await logWarmupAction({
          client_id: clientId,
          sender_instance: cfg.instance_name,
          receiver_instance: "external_shield",
          message_text: `🛡️ Escudo Externo desativado automaticamente no chip ${cfg.instance_name} (Fase 4 + MMZap desligado + >= 48h sem tráfego externo).`,
          action_type: "system",
        }).catch(() => {});
      }
    }

    // Auto-recuperação após 3h de cooldown para erros transitórios de rede/worker (nunca para qr_required/unpaired/extension)
    if (
      status === "error" &&
      cfg.mmzap_browser_enabled &&
      !isNonRecoverableMmzapError(cfg.mmzap_last_error)
    ) {
      const refIso = cfg.updated_at || cfg.mmzap_last_shift_ended_at;
      const refMs = refIso ? new Date(refIso).getTime() : NaN;
      if (Number.isFinite(refMs) && nowMs - refMs >= MMZAP_ERROR_AUTO_RECOVERY_MS) {
        const prevError = cfg.mmzap_last_error || "erro transitório";
        const nowIso = new Date(nowMs).toISOString();
        await updateMmzapConfigFields(clientId, cfg.instance_name, {
          mmzap_browser_status: "idle",
          mmzap_last_error: null,
          updated_at: nowIso,
        });
        cfg.mmzap_browser_status = "idle";
        cfg.mmzap_last_error = null;
        cfg.updated_at = nowIso;
        await logWarmupAction({
          client_id: clientId,
          sender_instance: cfg.instance_name,
          receiver_instance: "mmzap_governor",
          message_text: `🔄 Auto-recuperação MMZap: chip ${cfg.instance_name} saiu de erro transitório (${prevError}) após 3h e retornou para "idle".`,
          action_type: "system",
        }).catch(() => {});
      }
      continue;
    }

    if (status !== "running") continue;

    const workerSess = workerSessionsMap.get(cfg.instance_name);

    // Watchdog de logout no WhatsApp Web: transita de forma limpa para "unpaired" + alerta acionável ao ADM
    if (
      workerSess &&
      (workerSess.sessionLoggedOut === true ||
        workerSess.status === "qr_pending" ||
        workerSess.lastError === "qr_required")
    ) {
      const nowIso = new Date(nowMs).toISOString();
      await stopMmzapWorkerSession(cfg.instance_name, "qr_required").catch(() => null);
      const startedMs = cfg.mmzap_shift_started_at ? new Date(cfg.mmzap_shift_started_at).getTime() : NaN;
      const deltaMin = Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 60_000)) : 0;
      const totalMin = Number(cfg.mmzap_minutes_today || 0) + deltaMin;

      await updateMmzapConfigFields(clientId, cfg.instance_name, {
        mmzap_browser_status: "unpaired",
        mmzap_last_error: "qr_required",
        mmzap_shift_started_at: null,
        mmzap_last_shift_ended_at: nowIso,
        mmzap_minutes_today: totalMin,
        updated_at: nowIso,
      });

      cfg.mmzap_browser_status = "unpaired";
      cfg.mmzap_last_error = "qr_required";
      cfg.mmzap_shift_started_at = null;
      cfg.mmzap_last_shift_ended_at = nowIso;
      cfg.mmzap_minutes_today = totalMin;
      stopped.push(cfg.instance_name);
      activeWorkerNames.delete(cfg.instance_name);

      await logWarmupAction({
        client_id: clientId,
        sender_instance: cfg.instance_name,
        receiver_instance: "mmzap_governor",
        message_text: `🚨 ALERTA ADM: Sessão MMZap do chip ${cfg.instance_name} deslogou no WhatsApp Web (QR necessário). Abra /aquecer-chips e clique em "Re-parear QR" para reconectar.`,
        action_type: "system",
        details: { alert: "mmzap_qr_required", session_logged_out: true },
      }).catch(() => {});
      continue;
    }

    if (!workerSess || workerSess.status !== "running") {
      // Sessão caiu/reciclou no container; volta para idle registrando parada
      await stopMmzapSessionForChip(clientId, cfg.instance_name, "worker_session_ended");
      stopped.push(cfg.instance_name);
      cfg.mmzap_browser_status = "idle";
      cfg.mmzap_last_shift_ended_at = new Date(nowMs).toISOString();
      activeWorkerNames.delete(cfg.instance_name);
      continue;
    }

    if (!governor.enabled || !connectedInstanceNames.has(cfg.instance_name)) {
      const reason = !governor.enabled ? "governor_disabled" : "instance_disconnected";
      await stopMmzapSessionForChip(clientId, cfg.instance_name, reason);
      stopped.push(cfg.instance_name);
      cfg.mmzap_browser_status = "idle";
      cfg.mmzap_last_shift_ended_at = new Date(nowMs).toISOString();
      activeWorkerNames.delete(cfg.instance_name);
      continue;
    }

    // Checa em modo somente-leitura se o proxy da instância rotacionou na Evolution (sem probe TCP a cada 60s)
    const currentProxyHost = await readAssignedProxyHostReadOnly(cfg.instance_name);
    if (
      currentProxyHost &&
      cfg.mmzap_proxy_endpoint &&
      currentProxyHost !== cfg.mmzap_proxy_endpoint
    ) {
      await stopMmzapSessionForChip(clientId, cfg.instance_name, "proxy_rotated");
      stopped.push(cfg.instance_name);
      cfg.mmzap_browser_status = "idle";
      cfg.mmzap_last_shift_ended_at = new Date(nowMs).toISOString();
      activeWorkerNames.delete(cfg.instance_name);
      continue;
    }

    const decision = evaluateMmzapShiftGovernor({
      stage,
      mmzapSentToday: cfg.external_mmzap_sent_today || 0,
      mmzapInboundToday: cfg.external_warmup_inbound_today || 0,
      internalSentToday: cfg.sent_today || 0,
      dailyTarget: getEffectiveDailyTarget(cfg),
      mmzapMaxSendsOverride: cfg.mmzap_max_sends_override ?? null,
      mmzapShiftStartedAt: cfg.mmzap_shift_started_at ?? null,
      mmzapBrowserStatus: status,
      governorSettings: governor,
      nowMs,
    });

    if (decision.shouldStop) {
      await stopMmzapSessionForChip(clientId, cfg.instance_name, decision.reason || "governor_stop");
      stopped.push(cfg.instance_name);
      cfg.mmzap_browser_status = decision.reason === "unanswered_brake" ? "paused_safety" : "idle";
      cfg.mmzap_last_shift_ended_at = new Date(nowMs).toISOString();
      activeWorkerNames.delete(cfg.instance_name);
    }
  }

  if (!governor.enabled) {
    return { started, stopped };
  }

  // 2. Inicia próximo(s) turno(s) respeitando o limite de browsers simultâneos (RAM) e exclusão de campanhas
  const cap = Math.min(governor.max_concurrent_browsers, Math.max(1, health.maxConcurrent || 2));
  const freeSlots = Math.max(0, cap - activeWorkerNames.size);
  if (freeSlots === 0) {
    return { started, stopped };
  }

  const nonCampaignConfigs =
    activeCampaignSet.size > 0
      ? configs.filter((c) => !activeCampaignSet.has(c.instance_name.trim().toLowerCase()))
      : configs;

  for (let i = 0; i < freeSlots; i++) {
    const candidate = selectNextMmzapShiftCandidate({
      configs: nonCampaignConfigs,
      governor,
      activeWorkerNames,
      connectedInstances: connectedInstanceNames,
      nowMs,
    });
    if (!candidate) break;

    const proxy = await resolveMmzapProxyForInstance(clientId, candidate.instance_name);
    const startRes = await startMmzapWorkerShift({
      instanceName: candidate.instance_name,
      clientId,
      proxy,
      shiftDurationMinutes: governor.shift_duration_minutes,
      slowMode: true,
    });

    const startData = startRes.data as WorkerSessionWithWatchdog | undefined;

    if (startRes.ok && startData?.sessionLoggedOut !== true && startData?.status !== "qr_pending") {
      const nowIso = new Date(nowMs).toISOString();
      const nextShifts = (candidate.mmzap_shifts_today || 0) + 1;
      await updateMmzapConfigFields(clientId, candidate.instance_name, {
        mmzap_browser_status: "running",
        mmzap_shift_started_at: nowIso,
        mmzap_shifts_today: nextShifts,
        mmzap_last_error: null,
        mmzap_proxy_endpoint: proxy?.sourceHost || null,
        updated_at: nowIso,
      });

      candidate.mmzap_browser_status = "running";
      candidate.mmzap_shift_started_at = nowIso;
      candidate.mmzap_shifts_today = nextShifts;
      candidate.mmzap_proxy_endpoint = proxy?.sourceHost || null;
      activeWorkerNames.add(candidate.instance_name);
      started.push(candidate.instance_name);

      await logWarmupAction({
        client_id: clientId,
        sender_instance: candidate.instance_name,
        receiver_instance: "mmzap_governor",
        message_text: `🌐 Turno MMZap iniciado para ${candidate.instance_name} (${governor.shift_duration_minutes} min · proxy ${proxy?.sourceHost || "VPS"}).`,
        action_type: "system",
      }).catch(() => {});
    } else if (startData?.needsExtensionSetup) {
      await updateMmzapConfigFields(clientId, candidate.instance_name, {
        mmzap_browser_status: "needs_extension_setup",
        mmzap_last_error: "needs_extension_setup",
        updated_at: new Date(nowMs).toISOString(),
      });
      candidate.mmzap_browser_status = "needs_extension_setup";
    } else if (
      startData?.sessionLoggedOut === true ||
      startData?.status === "qr_pending" ||
      isNonRecoverableMmzapError(startRes.error)
    ) {
      const nowIso = new Date(nowMs).toISOString();
      await updateMmzapConfigFields(clientId, candidate.instance_name, {
        mmzap_browser_status: "unpaired",
        mmzap_last_error: "qr_required",
        mmzap_shift_started_at: null,
        updated_at: nowIso,
      });
      candidate.mmzap_browser_status = "unpaired";
      candidate.mmzap_last_error = "qr_required";
      await logWarmupAction({
        client_id: clientId,
        sender_instance: candidate.instance_name,
        receiver_instance: "mmzap_governor",
        message_text: `🚨 ALERTA ADM: Chip ${candidate.instance_name} requer novo pareamento QR no MMZap para iniciar turno.`,
        action_type: "system",
        details: { alert: "mmzap_qr_required", session_logged_out: true },
      }).catch(() => {});
    } else if (startRes.statusCode === 429) {
      break;
    } else {
      await updateMmzapConfigFields(clientId, candidate.instance_name, {
        mmzap_browser_status: "error",
        mmzap_last_error: startRes.error || "worker_start_error",
        updated_at: new Date(nowMs).toISOString(),
      });
      candidate.mmzap_browser_status = "error";
    }
  }

  return { started, stopped };
}
