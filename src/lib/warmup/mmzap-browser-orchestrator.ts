import { supabaseAdmin } from "@/lib/supabase_admin";
import { ensureProxyForInstance } from "@/lib/proxy-pool";
import { isTenantWarmupAdmin } from "./warmup-admin-guard";
import {
  getEffectiveDailyTarget,
  getMmzapGovernorSettings,
} from "./warmup-config-service";
import { getBrazilHour, logWarmupAction } from "./warmup-engine";
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
} from "./mmzap-browser-client";
import type {
  MmzapBrowserStatus,
  MmzapGovernorSettings,
  WarmupConfig,
} from "./warmup-types";

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
  try {
    const { data } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("mmzap_minutes_today, mmzap_shift_started_at")
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

  if (reason === "auto_disabled_stage") {
    updateFields.mmzap_browser_enabled = false;
  }

  await updateMmzapConfigFields(clientId, instanceName, updateFields);

  await logWarmupAction({
    client_id: clientId,
    sender_instance: instanceName,
    receiver_instance: "mmzap_governor",
    message_text: `⏸️ Turno MMZap encerrado para ${instanceName} (motivo: ${reason}).`,
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
  if (currentHour < governor.allowed_start_hour || currentHour > governor.allowed_end_hour) {
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
  nowMs?: number;
}): Promise<{ started: string[]; stopped: string[] }> {
  const { clientId, configs, connectedInstanceNames, nowMs = Date.now() } = params;
  const started: string[] = [];
  const stopped: string[] = [];

  if (!isMmzapWorkerConfigured()) {
    return { started, stopped };
  }
  if (!(await isTenantWarmupAdmin(clientId))) {
    return { started, stopped };
  }

  const governor = await getMmzapGovernorSettings(clientId);
  const health = await getMmzapWorkerHealth();
  if (!health.reachable) {
    return { started, stopped };
  }

  const workerSessionsMap = new Map(
    health.sessions.map((s) => [s.instanceName, s])
  );
  const activeWorkerNames = new Set(
    health.sessions
      .filter((s) => s.status === "running" || s.status === "qr_pending" || s.status === "setup")
      .map((s) => s.instanceName)
  );

  // 1. Reconcilia e aplica o governador nas sessões atualmente "running"
  for (const cfg of configs) {
    const status = cfg.mmzap_browser_status || "unpaired";
    const stage = cfg.stage || 1;

    // Auto-desativação automática ao atingir Fase configurada (ex: Fase 3), salvo override manual
    if (
      cfg.mmzap_browser_enabled &&
      stage >= governor.auto_disable_stage &&
      (cfg.mmzap_max_sends_override === null || cfg.mmzap_max_sends_override === undefined)
    ) {
      if (status === "running") {
        await stopMmzapSessionForChip(clientId, cfg.instance_name, "auto_disabled_stage");
        stopped.push(cfg.instance_name);
        cfg.mmzap_browser_status = "idle";
      } else {
        await updateMmzapConfigFields(clientId, cfg.instance_name, {
          mmzap_browser_enabled: false,
          mmzap_last_error: "auto_disabled_stage",
          updated_at: new Date(nowMs).toISOString(),
        });
      }
      cfg.mmzap_browser_enabled = false;
      activeWorkerNames.delete(cfg.instance_name);
      continue;
    }

    if (status !== "running") continue;

    const workerSess = workerSessionsMap.get(cfg.instance_name);
    if (!workerSess || (workerSess.status !== "running" && workerSess.status !== "qr_pending")) {
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

    // Checa se o proxy da instância rotacionou na Evolution: garante IP idêntico reiniciando o turno
    const currentProxy = await resolveMmzapProxyForInstance(clientId, cfg.instance_name);
    if (
      currentProxy?.sourceHost &&
      cfg.mmzap_proxy_endpoint &&
      currentProxy.sourceHost !== cfg.mmzap_proxy_endpoint
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

  // 2. Inicia próximo(s) turno(s) respeitando o limite de browsers simultâneos (RAM)
  const cap = Math.min(governor.max_concurrent_browsers, Math.max(1, health.maxConcurrent || 2));
  const freeSlots = Math.max(0, cap - activeWorkerNames.size);
  if (freeSlots === 0) {
    return { started, stopped };
  }

  for (let i = 0; i < freeSlots; i++) {
    const candidate = selectNextMmzapShiftCandidate({
      configs,
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

    if (startRes.ok) {
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
    } else if (startRes.data?.needsExtensionSetup) {
      await updateMmzapConfigFields(clientId, candidate.instance_name, {
        mmzap_browser_status: "needs_extension_setup",
        mmzap_last_error: "needs_extension_setup",
        updated_at: new Date(nowMs).toISOString(),
      });
      candidate.mmzap_browser_status = "needs_extension_setup";
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
