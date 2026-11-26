import type { MmzapWorkerSessionStatus } from "@/lib/warmup/mmzap-browser-client";
import type {
  ExternalWarmupMode,
  MmzapBrowserStatus,
  MmzapGovernorSettings,
  WarmupConfig,
  WarmupLog,
  WarmupPurpose,
  WarmupStage,
} from "@/lib/warmup/warmup-types";

export interface MmzapWorkerSessionView extends MmzapWorkerSessionStatus {
  sessionLoggedOut?: boolean;
  mmzapWatchdogRecoveries?: number;
  lastWatchdogCheckAt?: string | null;
}

export function toMmzapSessionView(
  session?: MmzapWorkerSessionStatus | null
): MmzapWorkerSessionView | null {
  if (!session) return null;
  return session as MmzapWorkerSessionView;
}

export type ColdReadinessTier =
  | "offline"
  | "quarantined"
  | "rehab"
  | "low_health"
  | "cold_locked"
  | "nursery"
  | "reduced"
  | "ready"
  | "veteran";

export interface ChipColdReadiness {
  safeDailyCold: number;
  baseDailyCold: number;
  tier: ColdReadinessTier;
  isConnected: boolean;
  isEligibleForCold: boolean;
  isMaturing: boolean;
  pillLabel: string;
  detailLabel: string;
  daysActive: number;
  stage: WarmupStage;
  healthScore: number;
}

export interface FleetColdReadinessSummary {
  totalSafeDailyCold: number;
  benchmarkMin: number;
  benchmarkMax: number;
  readyChipsCount: number;
  veteranChipsCount: number;
  maturingChipsCount: number;
  blockedChipsCount: number;
  offlineChipsCount: number;
  connectedChipsCount: number;
}

export const FLEET_COLD_BENCHMARK_MIN = 120;
export const FLEET_COLD_BENCHMARK_MAX = 150;

export function isInstanceConnected(status?: string | null): boolean {
  return status === "open" || status === "connected";
}

export function hasChipDatacenterWarning(item: InstanceItem): boolean {
  return [...(item.day0_warnings || []), ...(item.network_warnings || [])].some((warn) =>
    /datacenter|hosting|asn|hospedagem/i.test(warn)
  );
}

export function isChipMmzapQrRequired(
  config?: WarmupConfig | null,
  workerSession?: MmzapWorkerSessionView | null
): boolean {
  const lastErr = String(config?.mmzap_last_error || "").toLowerCase();
  return Boolean(
    workerSession?.sessionLoggedOut ||
      lastErr === "qr_required" ||
      lastErr.includes("qr_required") ||
      config?.mmzap_browser_status === "qr_pending"
  );
}

export function isChipMmzapNeedsPairing(
  item: InstanceItem,
  workerSession?: MmzapWorkerSessionView | null
): boolean {
  if (!isInstanceConnected(item.connection_status) || item.orphan) return false;
  const status = item.config?.mmzap_browser_status || "unpaired";
  return status === "unpaired" || isChipMmzapQrRequired(item.config, workerSession);
}

export function computeChipColdReadiness(
  item: InstanceItem,
  nowMs: number = Date.now()
): ChipColdReadiness {
  const cfg = item.config;
  const isConnected = isInstanceConnected(item.connection_status);
  const daysActive = Math.max(1, Math.floor(Number(cfg?.days_active || 1)));
  const stage = Math.min(4, Math.max(1, Math.floor(Number(cfg?.stage || 1)))) as WarmupStage;
  const healthScore =
    typeof cfg?.health_score === "number" && Number.isFinite(cfg.health_score)
      ? Math.round(cfg.health_score)
      : 100;
  const isQuarantined = Boolean(cfg?.is_quarantined);
  const isRehab = cfg?.career_mode === "rehab";
  const coldLockMs = cfg?.cold_outreach_locked_until
    ? Date.parse(cfg.cold_outreach_locked_until)
    : Number.NaN;
  const isColdLocked = Number.isFinite(coldLockMs) && coldLockMs > nowMs;

  let baseDailyCold = 0;
  let isVeteran = false;
  if (daysActive >= 21 && stage >= 4 && healthScore >= 90) {
    baseDailyCold = 80;
    isVeteran = true;
  } else if (daysActive >= 15 && stage >= 4) {
    baseDailyCold = 50;
  } else if (daysActive >= 11 && stage >= 3) {
    baseDailyCold = 30;
  } else if (daysActive >= 7 && stage >= 2) {
    baseDailyCold = 15;
  }

  if (!isConnected) {
    return {
      safeDailyCold: 0,
      baseDailyCold,
      tier: "offline",
      isConnected: false,
      isEligibleForCold: false,
      isMaturing: false,
      pillLabel: "Offline · 0 frios/dia",
      detailLabel: "Reconecte o chip no WhatsApp para liberar a cota de prospecção.",
      daysActive,
      stage,
      healthScore,
    };
  }

  if (isQuarantined) {
    return {
      safeDailyCold: 0,
      baseDailyCold,
      tier: "quarantined",
      isConnected: true,
      isEligibleForCold: false,
      isMaturing: false,
      pillLabel: "Quarentena · 0 frios/dia",
      detailLabel: "Chip em quarentena preventiva; prospecção fria pausada.",
      daysActive,
      stage,
      healthScore,
    };
  }

  if (isRehab) {
    return {
      safeDailyCold: 0,
      baseDailyCold,
      tier: "rehab",
      isConnected: true,
      isEligibleForCold: false,
      isMaturing: false,
      pillLabel: "Reabilitação · 0 frios/dia",
      detailLabel: "Chip em reabilitação após incidente; somente aquecimento.",
      daysActive,
      stage,
      healthScore,
    };
  }

  if (healthScore < 40) {
    return {
      safeDailyCold: 0,
      baseDailyCold,
      tier: "low_health",
      isConnected: true,
      isEligibleForCold: false,
      isMaturing: false,
      pillLabel: "Saúde crítica · 0 frios/dia",
      detailLabel: `Saúde em ${healthScore}% (<40%); prospecção bloqueada até recuperar.`,
      daysActive,
      stage,
      healthScore,
    };
  }

  if (isColdLocked) {
    return {
      safeDailyCold: 0,
      baseDailyCold,
      tier: "cold_locked",
      isConnected: true,
      isEligibleForCold: false,
      isMaturing: false,
      pillLabel: "Trava fria · 0 frios/dia",
      detailLabel: "Prospecção fria temporariamente travada por segurança.",
      daysActive,
      stage,
      healthScore,
    };
  }

  if (baseDailyCold === 0) {
    const label =
      daysActive < 7
        ? `Berçário (Dia ${daysActive}/7)`
        : `Maturação (Fase ${stage} · Dia ${daysActive})`;
    return {
      safeDailyCold: 0,
      baseDailyCold: 0,
      tier: "nursery",
      isConnected: true,
      isEligibleForCold: false,
      isMaturing: true,
      pillLabel: label,
      detailLabel:
        daysActive < 7
          ? `Dias 1–6 são exclusivos de maturação (faltam ${Math.max(1, 7 - daysActive)} dia(s) para liberar 15 frios/dia na Fase 2).`
          : "Aguardando evolução para Fase 2+ para liberar envios frios.",
      daysActive,
      stage,
      healthScore,
    };
  }

  if (healthScore < 75) {
    const halved = Math.floor(baseDailyCold / 2);
    return {
      safeDailyCold: halved,
      baseDailyCold,
      tier: "reduced",
      isConnected: true,
      isEligibleForCold: halved > 0,
      isMaturing: false,
      pillLabel: `Reduzido: ${halved} frios/dia`,
      detailLabel: `Saúde em ${healthScore}% (40–74%): cota segura reduzida à metade de ${baseDailyCold}/dia.`,
      daysActive,
      stage,
      healthScore,
    };
  }

  if (isVeteran) {
    return {
      safeDailyCold: 80,
      baseDailyCold: 80,
      tier: "veteran",
      isConnected: true,
      isEligibleForCold: true,
      isMaturing: false,
      pillLabel: "Veterano: 80 frios/dia",
      detailLabel: `Dia ${daysActive} · Fase 4 · Saúde ${healthScore}% (≥90%). Capacidade máxima segura.`,
      daysActive,
      stage,
      healthScore,
    };
  }

  return {
    safeDailyCold: baseDailyCold,
    baseDailyCold,
    tier: "ready",
    isConnected: true,
    isEligibleForCold: true,
    isMaturing: false,
    pillLabel: `Pronto: ${baseDailyCold} frios/dia`,
    detailLabel: `Dia ${daysActive} · Fase ${stage} · Saúde ${healthScore}%. Liberado para prospecção fria.`,
    daysActive,
    stage,
    healthScore,
  };
}

export function computeFleetColdReadiness(
  items: InstanceItem[],
  nowMs: number = Date.now()
): FleetColdReadinessSummary {
  const managed = items.filter((item) => !item.orphan);
  let totalSafeDailyCold = 0;
  let readyChipsCount = 0;
  let veteranChipsCount = 0;
  let maturingChipsCount = 0;
  let blockedChipsCount = 0;
  let offlineChipsCount = 0;
  let connectedChipsCount = 0;

  for (const item of managed) {
    const r = computeChipColdReadiness(item, nowMs);
    if (r.isConnected) connectedChipsCount += 1;
    if (r.tier === "offline") {
      offlineChipsCount += 1;
    } else if (r.isMaturing) {
      maturingChipsCount += 1;
    } else if (r.isEligibleForCold) {
      totalSafeDailyCold += r.safeDailyCold;
      readyChipsCount += 1;
      if (r.tier === "veteran") veteranChipsCount += 1;
    } else {
      blockedChipsCount += 1;
    }
  }

  return {
    totalSafeDailyCold,
    benchmarkMin: FLEET_COLD_BENCHMARK_MIN,
    benchmarkMax: FLEET_COLD_BENCHMARK_MAX,
    readyChipsCount,
    veteranChipsCount,
    maturingChipsCount,
    blockedChipsCount,
    offlineChipsCount,
    connectedChipsCount,
  };
}

export interface ChipDeliveryMetrics {
  outbound: number;
  deliveredRate: number;
  readRate: number;
  replyRate: number;
  failed: number;
}

export interface InstanceItem {
  instance_name: string;
  connection_status: string;
  phone_number: string | null;
  orphan?: boolean;
  config: WarmupConfig;
  day0_warnings?: string[];
  day0_status?: "pending" | "warning" | "ok";
  network_warnings?: string[];
  flaps_24h?: number;
  soft_recovery?: boolean;
  metrics?: ChipDeliveryMetrics | null;
  passport?: {
    ban_count?: number;
  } | null;
  proxy: {
    enabled: boolean;
    host: string | null;
    port: string | null;
    protocol: string;
  };
}

export interface ExternalDiagnostic {
  instance_name: string;
  shield_mode: ExternalWarmupMode;
  inbound_today: number;
  inbound_total: number;
  last_received_at: string | null;
  webhook_ok: boolean;
  webhook_url: string | null;
  recent_webhook_upsert_at: string | null;
}

export interface SelfHealingActionRecord {
  id: string;
  instance_name: string;
  issue: string;
  resolution: string;
  status: "fixed" | "needs_attention";
  created_at: string;
}

export interface QuarantineEntry {
  id?: string;
  instance_name: string;
  canonical_sender_phone: string;
  sender_name: string | null;
  message_preview: string | null;
  classification: string;
  seen_count: number;
  last_seen_at: string;
  promoted_to_crm_at: string | null;
}

export interface WarmupStats {
  totalChips: number;
  activeWarmup: number;
  connectedChips?: number;
  orphanChips?: number;
  totalSentToday: number;
  totalReceivedToday: number;
  totalGroups?: number;
  mmzapInboundToday?: number;
  mmzapSentToday?: number;
}

export type GlobalSettings = {
  ai_model: string;
  ai_theme: string;
  allowed_start_hour: number;
  allowed_end_hour: number;
  min_interval_seconds: number;
  max_interval_seconds: number;
  min_typing_seconds: number;
  max_typing_seconds: number;
  enable_typing: boolean;
  enable_blue_ticks: boolean;
  enable_reactions: boolean;
  enable_audio: boolean;
  enable_vcard: boolean;
  enable_status_posts: boolean;
  stage_auto_progress: boolean;
  continuous_warmup: boolean;
  auto_warmup_new_chips: boolean;
  custom_prompt: string;
  daily_owner_summary_enabled?: boolean;
  daily_owner_summary_phone?: string;
  default_profile_avatar_urls?: string;
};

export type {
  ExternalWarmupMode,
  MmzapBrowserStatus,
  MmzapGovernorSettings,
  WarmupConfig,
  WarmupLog,
  WarmupPurpose,
  WarmupStage,
};
