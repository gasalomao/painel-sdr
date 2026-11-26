"use client";

import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  Globe,
  Monitor,
  Pause,
  Play,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Unlock,
  Wrench,
  WifiOff,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  PURPOSE_METADATA,
  STAGE_DEFAULTS,
  type ExternalWarmupMode,
  type MmzapBrowserStatus,
  type WarmupConfig,
  type WarmupPurpose,
  type WarmupStage,
} from "@/lib/warmup/warmup-types";
import {
  computeChipColdReadiness,
  hasChipDatacenterWarning,
  isChipMmzapQrRequired,
  type ColdReadinessTier,
  type ExternalDiagnostic,
  type InstanceItem,
  type MmzapWorkerSessionView,
} from "./types";

const COLD_READINESS_CLS: Record<ColdReadinessTier, string> = {
  veteran: "border-emerald-500/45 bg-emerald-500/15 text-emerald-200",
  ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  reduced: "border-amber-500/35 bg-amber-500/10 text-amber-200",
  nursery: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  quarantined: "border-amber-500/40 bg-amber-500/15 text-amber-200",
  rehab: "border-amber-500/40 bg-amber-500/15 text-amber-200",
  low_health: "border-red-500/40 bg-red-500/15 text-red-200",
  cold_locked: "border-amber-500/35 bg-amber-500/10 text-amber-200",
  offline: "border-[#303a32] bg-[#131914] text-[#95a499]",
};

function formatWatchdogTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

const MMZAP_BROWSER_STATUS_UI: Record<
  MmzapBrowserStatus,
  { label: string; cls: string }
> = {
  unpaired: {
    label: "Não pareado",
    cls: "border-[#303a32] bg-[#131914] text-[#a5b1a8]",
  },
  qr_pending: {
    label: "Sessão MMZap deslogada · re-escanear QR",
    cls: "border-red-500/40 bg-red-500/15 text-red-200",
  },
  needs_extension_setup: {
    label: "Configurar 1ª vez",
    cls: "border-amber-500/35 bg-amber-500/10 text-amber-200",
  },
  idle: {
    label: "Pronto",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  },
  running: {
    label: "Turno ativo",
    cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
  },
  paused_safety: {
    label: "Pausa preventiva · retoma amanhã",
    cls: "border-amber-500/40 bg-amber-500/15 text-amber-200",
  },
  error: {
    label: "Erro worker",
    cls: "border-red-500/40 bg-red-500/15 text-red-200",
  },
};

const STAGE_LABEL: Record<WarmupStage, string> = {
  1: "Fase 1 · Frio",
  2: "Fase 2 · Morno",
  3: "Fase 3 · Quente",
  4: "Fase 4 · Blindado",
};

const PURPOSE_LABEL: Record<WarmupPurpose, string> = {
  contingency: "Reserva",
  inbound: "Receber leads",
  outbound: "Prospecção",
};

const MMZAP_OPTIONS: Array<{ value: ExternalWarmupMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "receive_only", label: "Só receber" },
  { value: "hybrid_quarantine", label: "Híbrido" },
];

export interface ChipAutopilotRowProps {
  item: InstanceItem;
  diagnostic?: ExternalDiagnostic;
  isDirty: boolean;
  isSaving: boolean;
  isReauditing: boolean;
  workerConfigured?: boolean;
  workerSession?: MmzapWorkerSessionView | null;
  styles: Record<string, string>;
  onToggleEnabled: (instanceName: string, nextEnabled: boolean) => void;
  onChangeField: (
    instanceName: string,
    field: keyof WarmupConfig,
    value: WarmupConfig[keyof WarmupConfig]
  ) => void;
  onSaveConfig: (instanceName: string) => void;
  onChangeMmzapMode: (instanceName: string, mode: ExternalWarmupMode) => Promise<void>;
  onOpenMmzapPairModal?: (instanceName: string, mode?: "pair" | "setup") => void;
  onMmzapBrowserAction?: (
    instanceName: string,
    action: "start_shift" | "stop_shift" | "toggle_enabled" | "reset_profile",
    extra?: Record<string, unknown>
  ) => Promise<void>;
  onReleaseQuarantine?: (instanceName: string) => Promise<void>;
  onReauditDay0: (instanceName: string) => void;
  onOpenPairModal: (instanceName: string) => void;
  onOpenTestModal: (instanceName: string) => void;
}

export function ChipAutopilotRow({
  item,
  diagnostic,
  isDirty,
  isSaving,
  isReauditing,
  workerConfigured = false,
  workerSession = null,
  styles,
  onToggleEnabled,
  onChangeField,
  onSaveConfig,
  onChangeMmzapMode,
  onOpenMmzapPairModal,
  onMmzapBrowserAction,
  onReleaseQuarantine,
  onReauditDay0,
  onOpenPairModal,
  onOpenTestModal,
}: ChipAutopilotRowProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [mmzapBusy, setMmzapBusy] = useState(false);

  const cfg = item.config;
  const instName = item.instance_name;
  const isConnected =
    item.connection_status === "open" || item.connection_status === "connected";
  const stage = (cfg.stage || 1) as WarmupStage;
  const purpose = (cfg.purpose || "outbound") as WarmupPurpose;
  const purposeMeta = PURPOSE_METADATA[purpose] || PURPOSE_METADATA.outbound;
  const mmzapMode = (cfg.external_warmup_mode || "off") as ExternalWarmupMode;
  const mmzapToday =
    diagnostic?.inbound_today ?? cfg.external_warmup_inbound_today ?? 0;
  const mmzapSentToday = cfg.external_mmzap_sent_today ?? 0;
  const mmzapBrowserStatus = (cfg.mmzap_browser_status || "unpaired") as MmzapBrowserStatus;
  const mmzapStatusUi =
    MMZAP_BROWSER_STATUS_UI[mmzapBrowserStatus] || MMZAP_BROWSER_STATUS_UI.unpaired;
  const isMmzapQrRequired = isChipMmzapQrRequired(cfg, workerSession);
  const coldReadiness = computeChipColdReadiness(item);
  const watchdogRecoveries = Number(workerSession?.mmzapWatchdogRecoveries || 0);
  const lastWatchdogTime = formatWatchdogTime(workerSession?.lastWatchdogCheckAt);

  const isQuarantined = Boolean(cfg.is_quarantined);
  const hasDay0Warnings = Boolean(item.day0_warnings && item.day0_warnings.length > 0);
  const hasNetworkWarnings = Boolean(
    item.network_warnings && item.network_warnings.length > 0
  );
  const hasDatacenterWarning = hasChipDatacenterWarning(item);
  const needsMmzapQrAttention = Boolean(isConnected && workerConfigured && isMmzapQrRequired);
  const needsAttention =
    !isConnected ||
    isQuarantined ||
    hasDay0Warnings ||
    hasNetworkWarnings ||
    needsMmzapQrAttention;

  const mmzapBadge = isMmzapQrRequired
    ? {
        label: "Sessão MMZap deslogada · re-escanear QR",
        cls: "border-red-500/40 bg-red-500/15 text-red-200",
      }
    : mmzapBrowserStatus === "paused_safety"
      ? MMZAP_BROWSER_STATUS_UI.paused_safety
      : mmzapBrowserStatus === "running" && workerSession
        ? workerSession.mmzapUiDetected
          ? workerSession.mmzapChipState === "is-error"
            ? {
                label: workerSession.mmzapStatusLabel || "MMZap com erro",
                cls: "border-red-500/40 bg-red-500/15 text-red-200",
              }
            : workerSession.mmzapChipState === "is-off"
              ? {
                  label: workerSession.mmzapStatusLabel || "MMZap pausado",
                  cls: "border-amber-500/35 bg-amber-500/10 text-amber-200",
                }
              : {
                  label: workerSession.mmzapStatusLabel || "MMZap ativo",
                  cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
                }
          : {
              label: "Carregando MMZap...",
              cls: "border-sky-500/35 bg-sky-500/10 text-sky-200",
            }
        : mmzapStatusUi;

  const statusPill = !isConnected
    ? {
        label: "Reconectar QR",
        cls: "border-red-500/40 bg-red-500/15 text-red-200",
        dot: "bg-red-400",
      }
    : isQuarantined
      ? {
          label: "Quarentena",
          cls: "border-amber-500/40 bg-amber-500/15 text-amber-200",
          dot: "bg-amber-400",
        }
      : cfg.enabled
        ? {
            label: "Aquecendo",
            cls: "border-emerald-500/35 bg-emerald-500/15 text-emerald-200",
            dot: "bg-emerald-400",
          }
        : {
            label: "Pausado",
            cls: "border-[#3b483e] bg-[#141a15] text-neutral-300",
            dot: "bg-neutral-500",
          };

  const proxySummary = item.proxy?.enabled && item.proxy?.host
    ? `Proxy ${item.proxy.host}`
    : "VPS direta";

  const webhookOk = diagnostic ? diagnostic.webhook_ok : isConnected;

  const handleMmzapClick = async (mode: ExternalWarmupMode) => {
    if (mode === mmzapMode || mmzapBusy) return;
    setMmzapBusy(true);
    try {
      await onChangeMmzapMode(instName, mode);
    } finally {
      setMmzapBusy(false);
    }
  };

  return (
    <article className="px-5 py-4 space-y-3">
      {/* Linha principal: Identificação + Status + Toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              className={cn("h-2.5 w-2.5 rounded-full shrink-0", statusPill.dot)}
              aria-hidden="true"
            />
            <span className="text-base font-semibold text-[#edf2ee] truncate">
              {instName}
            </span>
            {item.phone_number && (
              <span className="text-xs font-mono tabular-nums text-[#a5b1a8]">
                +{item.phone_number}
              </span>
            )}
            <span
              className={cn(
                "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium",
                statusPill.cls
              )}
            >
              {statusPill.label}
            </span>
            <span
              title={coldReadiness.detailLabel}
              className={cn(
                "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium tabular-nums",
                COLD_READINESS_CLS[coldReadiness.tier]
              )}
            >
              {coldReadiness.pillLabel}
            </span>
            {item.orphan && (
              <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
                Instância órfã
              </span>
            )}
          </div>

          <p className="text-xs text-[#a5b1a8] tabular-nums">
            Dia {cfg.days_active || 1} · {STAGE_LABEL[stage]} · Saúde{" "}
            <span className="text-[#edf2ee] font-medium">{cfg.health_score ?? 100}%</span> ·{" "}
            <span className="text-[#edf2ee] font-medium">
              {cfg.sent_today || 0}/{cfg.daily_target || STAGE_DEFAULTS[stage].dailyTarget}
            </span>{" "}
            enviadas · {cfg.received_today || 0} recebidas
            {cfg.career_mode === "rehab" && " · Modo Reabilitação"}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <label className="inline-flex items-center gap-2 text-xs text-[#cedbd1] cursor-pointer min-h-[38px]">
            <span>{cfg.enabled ? "Ligado" : "Pausado"}</span>
            <Switch
              checked={Boolean(cfg.enabled)}
              onCheckedChange={(val) => onToggleEnabled(instName, val)}
              aria-label={`Alternar aquecimento de ${instName}`}
            />
          </label>

          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            aria-expanded={advancedOpen}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#303a32] bg-[#141a15] px-3 py-2 text-xs font-medium text-[#d3ded6] hover:border-[#4c5c50] hover:text-white transition-colors min-h-[38px]"
          >
            <span>Ajustes</span>
            <ChevronDown
              className={cn(
                "w-3.5 h-3.5 transition-transform",
                advancedOpen && "rotate-180"
              )}
            />
          </button>
        </div>
      </div>

      {/* Linha de sinais operacionais + Escudo MMZap */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span
            title={
              hasDatacenterWarning
                ? "ASN de datacenter/hosting detectado. Recomenda-se migrar para proxy BR residencial/ISP ou 4G antes de escalar acima de 40 envios/dia."
                : undefined
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 tabular-nums",
              hasNetworkWarnings || hasDatacenterWarning
                ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                : "border-[#303a32] bg-[#131914] text-[#c2cfc6]"
            )}
          >
            {proxySummary}
            {hasDatacenterWarning && " · Datacenter"}
          </span>

          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1",
              webhookOk
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-amber-500/35 bg-amber-500/10 text-amber-200"
            )}
          >
            {webhookOk ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 shrink-0" />
            )}
            {webhookOk ? "Webhook ativo" : "Webhook pendente"}
          </span>

          <span className="inline-flex items-center rounded-md border border-[#303a32] bg-[#131914] px-2.5 py-1 text-[#c2cfc6]">
            Uso: {PURPOSE_LABEL[purpose]}
          </span>

          {(item.passport?.ban_count || 0) > 0 && (
            <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-amber-200 tabular-nums">
              {item.passport?.ban_count} queda(s) no histórico
            </span>
          )}
        </div>

        {/* Controle MMZap Receive-Only */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] text-[#a5b1a8]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            MMZap:
          </span>
          <div
            role="group"
            aria-label={`Modo MMZap para ${instName}`}
            className="inline-flex rounded-lg border border-[#303a32] bg-[#111712] p-0.5"
          >
            {MMZAP_OPTIONS.map((opt) => {
              const active = mmzapMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={mmzapBusy}
                  onClick={() => void handleMmzapClick(opt.value)}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors",
                    active
                      ? "bg-[#223528] text-emerald-200 border border-emerald-500/40"
                      : "text-[#a5b1a8] hover:text-white border border-transparent"
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <span className="text-[11px] font-mono tabular-nums text-[#a5b1a8]">
            {mmzapToday} rec · {mmzapSentToday} env
          </span>

          {workerConfigured && (
            <>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
                  mmzapBadge.cls
                )}
              >
                <Globe className="w-3 h-3 shrink-0" />
                {mmzapBadge.label}
              </span>

              {watchdogRecoveries > 0 && (
                <span
                  title={
                    lastWatchdogTime
                      ? `Watchdog verificou às ${lastWatchdogTime} · ${watchdogRecoveries} recuperação(ões) automática(s)`
                      : `Watchdog executou ${watchdogRecoveries} recuperação(ões) automática(s)`
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-[#303a32] bg-[#131914] px-2 py-0.5 text-[11px] tabular-nums text-[#c2cfc6]"
                >
                  <Activity className="w-3 h-3 text-emerald-400 shrink-0" />
                  Watchdog {watchdogRecoveries}x
                </span>
              )}

              {mmzapBrowserStatus === "running" && !isMmzapQrRequired && onOpenMmzapPairModal && (
                <button
                  type="button"
                  disabled={mmzapBusy}
                  onClick={() => onOpenMmzapPairModal(instName, "setup")}
                  className={styles.secondaryAction}
                >
                  <Monitor className="w-3 h-3 text-emerald-400" />
                  Ver tela ao vivo
                </button>
              )}

              {isMmzapQrRequired && onOpenMmzapPairModal ? (
                <button
                  type="button"
                  disabled={mmzapBusy}
                  onClick={() => onOpenMmzapPairModal(instName, "pair")}
                  className={styles.secondaryAction}
                >
                  <QrCode className="w-3 h-3 text-red-300" />
                  Re-escanear QR
                </button>
              ) : mmzapBrowserStatus === "running" && onMmzapBrowserAction ? (
                <button
                  type="button"
                  disabled={mmzapBusy}
                  onClick={async () => {
                    setMmzapBusy(true);
                    try {
                      await onMmzapBrowserAction(instName, "stop_shift");
                    } finally {
                      setMmzapBusy(false);
                    }
                  }}
                  className={styles.secondaryAction}
                >
                  <Pause className="w-3 h-3 text-amber-300" />
                  Parar turno
                </button>
              ) : mmzapBrowserStatus === "needs_extension_setup" && onOpenMmzapPairModal ? (
                <button
                  type="button"
                  disabled={mmzapBusy}
                  onClick={() => onOpenMmzapPairModal(instName, "setup")}
                  className={styles.secondaryAction}
                >
                  <Wrench className="w-3 h-3 text-amber-300" />
                  Configurar MMZap
                </button>
              ) : (mmzapBrowserStatus === "unpaired" || mmzapBrowserStatus === "error") &&
                onOpenMmzapPairModal ? (
                <button
                  type="button"
                  disabled={mmzapBusy}
                  onClick={() => onOpenMmzapPairModal(instName, "pair")}
                  className={styles.secondaryAction}
                >
                  <QrCode className="w-3 h-3 text-emerald-400" />
                  Parear MMZap
                </button>
              ) : (
                onMmzapBrowserAction && (
                  <button
                    type="button"
                    disabled={mmzapBusy}
                    onClick={async () => {
                      setMmzapBusy(true);
                      try {
                        await onMmzapBrowserAction(instName, "start_shift");
                      } finally {
                        setMmzapBusy(false);
                      }
                    }}
                    className={styles.secondaryAction}
                  >
                    <Play className="w-3 h-3 text-emerald-400" />
                    {mmzapBrowserStatus === "paused_safety" ? "Retomar turno" : "Rodar turno"}
                  </button>
                )
              )}

              {(mmzapBrowserStatus === "idle" ||
                mmzapBrowserStatus === "running" ||
                mmzapBrowserStatus === "paused_safety") &&
                onMmzapBrowserAction && (
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-[#cedbd1] cursor-pointer">
                    <Switch
                      checked={Boolean(cfg.mmzap_browser_enabled)}
                      disabled={mmzapBusy}
                      onCheckedChange={async (checked) => {
                        setMmzapBusy(true);
                        try {
                          await onMmzapBrowserAction(instName, "toggle_enabled", {
                            enabled: checked,
                          });
                        } finally {
                          setMmzapBusy(false);
                        }
                      }}
                      aria-label={`Turnos automáticos MMZap de ${instName}`}
                    />
                    <span>Turnos auto</span>
                  </label>
                )}
            </>
          )}
        </div>
      </div>

      {/* Barra condicional de atenção — só aparece se exigir ação humana */}
      {needsAttention && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              {!isConnected && (
                <p>
                  Chip desconectado no WhatsApp ({item.connection_status}). Escaneie o QR Code para retomar automaticamente.
                </p>
              )}
              {isQuarantined && (
                <p>
                  Em quarentena preventiva (turnos MMZap e colmeia pausados){cfg.quarantine_reason ? `: ${cfg.quarantine_reason}` : "."}
                </p>
              )}
              {needsMmzapQrAttention && (
                <p>
                  Sessão MMZap deslogada · re-escaneie o QR Code no navegador isolado para retomar os turnos automáticos.
                </p>
              )}
              {item.day0_warnings?.slice(0, 2).map((warn, idx) => (
                <p key={`d0-${idx}`}>{warn}</p>
              ))}
              {item.network_warnings?.slice(0, 2).map((warn, idx) => (
                <p key={`net-${idx}`}>{warn}</p>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isQuarantined && onReleaseQuarantine && (
              <button
                type="button"
                disabled={mmzapBusy}
                onClick={async () => {
                  setMmzapBusy(true);
                  try {
                    await onReleaseQuarantine(instName);
                  } finally {
                    setMmzapBusy(false);
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-[#142018] px-2.5 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20"
              >
                <Unlock className="w-3 h-3" />
                Liberar quarentena agora
              </button>
            )}
            {needsMmzapQrAttention && onOpenMmzapPairModal && (
              <button
                type="button"
                disabled={mmzapBusy}
                onClick={() => onOpenMmzapPairModal(instName, "pair")}
                className="inline-flex items-center gap-1 rounded-md border border-red-400/40 bg-[#231416] px-2.5 py-1 text-[11px] font-medium text-red-200 hover:bg-red-500/20"
              >
                <QrCode className="w-3 h-3" />
                Re-escanear QR
              </button>
            )}
            {!isConnected && (
              <a
                href="/whatsapp"
                className="inline-flex items-center rounded-md border border-amber-400/40 bg-[#1a1811] px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20"
              >
                Abrir WhatsApp / QR
              </a>
            )}
            {hasDay0Warnings && (
              <button
                type="button"
                disabled={isReauditing}
                onClick={() => onReauditDay0(instName)}
                className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-[#1a1811] px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20"
              >
                <RefreshCw
                  className={cn("w-3 h-3", isReauditing && "animate-spin")}
                />
                {isReauditing ? "Auditando..." : "Reauditar"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Gaveta progressiva: Ajustes avançados */}
      {advancedOpen && (
        <div className="pt-3 border-t border-[#303a32] space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className={styles.fieldGroup}>
              <label htmlFor={`purpose-${instName}`} className={styles.fieldLabel}>
                Finalidade
              </label>
              <select
                id={`purpose-${instName}`}
                value={purpose}
                onChange={(e) =>
                  onChangeField(instName, "purpose", e.target.value as WarmupPurpose)
                }
                className={styles.fieldSelect}
              >
                <option value="outbound">Prospecção (teto 70/dia)</option>
                <option value="inbound">Receber leads (teto 40/dia)</option>
                <option value="contingency">Reserva (teto 20/dia)</option>
              </select>
              <span className="text-[11px] text-[#95a499]">{purposeMeta.description}</span>
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor={`stage-${instName}`} className={styles.fieldLabel}>
                Fase de aquecimento
              </label>
              <select
                id={`stage-${instName}`}
                value={stage}
                onChange={(e) =>
                  onChangeField(instName, "stage", Number(e.target.value) as WarmupStage)
                }
                className={styles.fieldSelect}
              >
                <option value={1}>Fase 1 · Frio (10/dia)</option>
                <option value={2}>Fase 2 · Morno (25/dia)</option>
                <option value={3}>Fase 3 · Quente (50/dia)</option>
                <option value={4}>Fase 4 · Blindado (80/dia)</option>
              </select>
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor={`target-${instName}`} className={styles.fieldLabel}>
                Meta diária
              </label>
              <input
                id={`target-${instName}`}
                type="number"
                min={1}
                max={200}
                value={cfg.daily_target || 10}
                onChange={(e) =>
                  onChangeField(instName, "daily_target", Number(e.target.value) || 10)
                }
                className={styles.fieldInput}
              />
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor={`hours-${instName}`} className={styles.fieldLabel}>
                Janela (início / fim)
              </label>
              <div id={`hours-${instName}`} className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min={0}
                  max={23}
                  aria-label={`Hora inicial de ${instName}`}
                  value={cfg.allowed_start_hour ?? 8}
                  onChange={(e) =>
                    onChangeField(instName, "allowed_start_hour", Number(e.target.value))
                  }
                  className={styles.fieldInput}
                />
                <input
                  type="number"
                  min={1}
                  max={24}
                  aria-label={`Hora final de ${instName}`}
                  value={cfg.allowed_end_hour ?? 21}
                  onChange={(e) =>
                    onChangeField(instName, "allowed_end_hour", Number(e.target.value))
                  }
                  className={styles.fieldInput}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onOpenPairModal(instName)}
                className={styles.secondaryAction}
              >
                <ArrowRightLeft className="w-3.5 h-3.5 text-emerald-400" />
                Aquecer em par
              </button>
              <button
                type="button"
                onClick={() => onOpenTestModal(instName)}
                className={styles.secondaryAction}
              >
                <Send className="w-3.5 h-3.5" />
                Testar conversa
              </button>
              <a
                href="/whatsapp"
                className="text-xs text-[#a5b1a8] hover:text-emerald-300 underline px-2"
              >
                Configurar proxy
              </a>
            </div>

            <div className="flex items-center gap-3">
              {isDirty && (
                <span className="text-xs text-amber-300">Alterações pendentes</span>
              )}
              <button
                type="button"
                disabled={isSaving || !isDirty}
                onClick={() => onSaveConfig(instName)}
                className={isDirty ? styles.primaryAction : styles.secondaryAction}
              >
                {isSaving ? "Salvando..." : isDirty ? "Salvar ajustes" : "Salvo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
