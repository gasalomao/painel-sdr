"use client";

import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CornerDownLeft,
  Monitor,
  QrCode,
  RefreshCw,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { MmzapWorkerSessionView } from "./types";

interface MmzapModalApiPayload {
  status?: string;
  qrCodeBase64?: string | null;
  screenshotBase64?: string | null;
  needsExtensionSetup?: boolean;
  proxyIp?: string | null;
  mmzapUiDetected?: boolean;
  mmzapChipState?: string | null;
  mmzapStatusLabel?: string | null;
  sessionLoggedOut?: boolean;
  mmzapWatchdogRecoveries?: number;
  lastWatchdogCheckAt?: string | null;
}

export interface MmzapPairModalProps {
  open: boolean;
  instanceName: string | null;
  initialMode: "pair" | "setup";
  workerSession?: MmzapWorkerSessionView | null;
  styles: Record<string, string>;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => Promise<void>;
}

export function MmzapPairModal({
  open,
  instanceName,
  initialMode,
  workerSession = null,
  styles,
  onOpenChange,
  onCompleted,
}: MmzapPairModalProps) {
  const [mode, setMode] = useState<"pair" | "setup">(initialMode);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [qrCodeBase64, setQrCodeBase64] = useState<string | null>(null);
  const [screenshotBase64, setScreenshotBase64] = useState<string | null>(null);
  const [proxyIp, setProxyIp] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("idle");
  const [mmzapUiDetected, setMmzapUiDetected] = useState<boolean | null>(null);
  const [mmzapChipState, setMmzapChipState] = useState<string | null>(null);
  const [mmzapStatusLabel, setMmzapStatusLabel] = useState<string | null>(null);
  const [sessionLoggedOut, setSessionLoggedOut] = useState<boolean>(false);
  const [watchdogRecoveries, setWatchdogRecoveries] = useState<number>(0);
  const [textInput, setTextInput] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);

  const applyTelemetry = useCallback((data?: MmzapModalApiPayload | null) => {
    if (!data) return;
    if (typeof data.mmzapUiDetected === "boolean") {
      setMmzapUiDetected(data.mmzapUiDetected);
    }
    if (data.mmzapChipState !== undefined) {
      setMmzapChipState(data.mmzapChipState ?? null);
    }
    if (data.mmzapStatusLabel !== undefined) {
      setMmzapStatusLabel(data.mmzapStatusLabel ?? null);
    }
    if (typeof data.sessionLoggedOut === "boolean") {
      setSessionLoggedOut(data.sessionLoggedOut);
    }
    if (typeof data.mmzapWatchdogRecoveries === "number") {
      setWatchdogRecoveries(data.mmzapWatchdogRecoveries);
    }
  }, []);

  const startPairing = useCallback(async (inst: string) => {
    setBusy(true);
    setErrorMsg(null);
    setQrCodeBase64(null);
    setSessionLoggedOut(false);
    try {
      const res = await fetch("/api/warmup/mmzap-browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pair", instance_name: inst }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        data?: MmzapModalApiPayload;
      } | null;

      if (!res.ok || !json?.success) {
        setErrorMsg(json?.error || "Não foi possível abrir o navegador do worker.");
        return;
      }

      setSessionStatus(json.data?.status || "qr_pending");
      setQrCodeBase64(json.data?.qrCodeBase64 || null);
      setProxyIp(json.data?.proxyIp || null);
      applyTelemetry(json.data);
    } finally {
      setBusy(false);
    }
  }, [applyTelemetry]);

  const openSetup = useCallback(async (inst: string) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/warmup/mmzap-browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setup", instance_name: inst }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        data?: MmzapModalApiPayload;
      } | null;

      if (!res.ok || !json?.success) {
        setErrorMsg(json?.error || "Falha ao abrir janela da extensão no worker.");
        return;
      }

      setSessionStatus(json.data?.status || "setup");
      setScreenshotBase64(json.data?.screenshotBase64 || null);
      setProxyIp(json.data?.proxyIp || null);
      applyTelemetry(json.data);
    } finally {
      setBusy(false);
    }
  }, [applyTelemetry]);

  useEffect(() => {
    if (!open || !instanceName) return;
    setMode(initialMode);
    setErrorMsg(null);
    setMmzapUiDetected(null);
    setMmzapChipState(null);
    setMmzapStatusLabel(null);
    setSessionLoggedOut(false);
    setWatchdogRecoveries(0);
    if (initialMode === "pair") {
      void startPairing(instanceName);
    } else {
      void openSetup(instanceName);
    }
  }, [open, instanceName, initialMode, startPairing, openSetup]);

  useEffect(() => {
    if (!open || !instanceName || !workerSession || mode !== "setup") return;
    if (workerSession.instanceName !== instanceName) return;
    applyTelemetry(workerSession);
    if (workerSession.proxyIp) setProxyIp(workerSession.proxyIp);
  }, [open, instanceName, mode, workerSession, applyTelemetry]);

  // Poll de QR Code enquanto aguardando leitura no celular
  useEffect(() => {
    if (!open || !instanceName || mode !== "pair" || sessionStatus !== "qr_pending") {
      return;
    }

    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/warmup/mmzap-browser?action=qr&instance=${encodeURIComponent(instanceName)}`,
            { cache: "no-store" }
          );
          const json = (await res.json().catch(() => null)) as {
            success?: boolean;
            data?: MmzapModalApiPayload;
          } | null;
          if (!json?.success || !json.data) return;
          if (json.data.qrCodeBase64) setQrCodeBase64(json.data.qrCodeBase64);
          if (json.data.proxyIp) setProxyIp(json.data.proxyIp);
          if (json.data.status) setSessionStatus(json.data.status);
          applyTelemetry(json.data);

          if (json.data.status === "running") {
            toast.success(`MMZap conectado e turno iniciado em ${instanceName}.`);
            await onCompleted();
            setMode("setup");
            await openSetup(instanceName);
          } else if (json.data.status === "idle") {
            toast.success(`MMZap Web pareado em ${instanceName}.`);
            await onCompleted();
            onOpenChange(false);
          } else if (json.data.status === "needs_extension_setup") {
            toast.success("WhatsApp Web pareado. Falta apenas ativar a extensão MMZap.");
            setMode("setup");
            await openSetup(instanceName);
          }
        } catch {
          /* ignora erro transitório de poll */
        }
      })();
    }, 3000);

    return () => clearInterval(timer);
  }, [
    open,
    instanceName,
    mode,
    sessionStatus,
    onCompleted,
    onOpenChange,
    openSetup,
    applyTelemetry,
  ]);

  // Poll leve de saúde ao vivo na tela da extensão (detecta mmzapUiDetected e sessionLoggedOut)
  useEffect(() => {
    if (!open || !instanceName || mode !== "setup") return;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch("/api/warmup/mmzap-browser?action=status", {
            cache: "no-store",
          });
          const json = (await res.json().catch(() => null)) as {
            success?: boolean;
            data?: {
              worker?: {
                sessions?: MmzapWorkerSessionView[];
              };
            };
          } | null;
          const live = json?.data?.worker?.sessions?.find(
            (s) => s.instanceName === instanceName
          );
          if (!live) return;
          if (live.status) setSessionStatus(live.status);
          if (live.proxyIp) setProxyIp(live.proxyIp);
          applyTelemetry(live);
        } catch {
          /* ignora erro transitório de poll */
        }
      })();
    }, 6000);

    return () => clearInterval(timer);
  }, [open, instanceName, mode, applyTelemetry]);

  const sendInput = async (input: Record<string, unknown>) => {
    if (!instanceName) return;
    setBusy(true);
    try {
      const res = await fetch("/api/warmup/mmzap-browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setup_input",
          instance_name: instanceName,
          input,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: MmzapModalApiPayload;
      } | null;
      if (json?.success && json.data) {
        if (json.data.screenshotBase64) setScreenshotBase64(json.data.screenshotBase64);
        applyTelemetry(json.data);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleImageClick = (e: MouseEvent<HTMLImageElement>) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1024);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 720);
    void sendInput({ type: "click", x, y });
  };

  const handleRefreshScreenshot = async () => {
    if (!instanceName) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/warmup/mmzap-browser?action=screenshot&instance=${encodeURIComponent(instanceName)}`,
        { cache: "no-store" }
      );
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: MmzapModalApiPayload;
      } | null;
      if (json?.success && json.data) {
        if (json.data.screenshotBase64) setScreenshotBase64(json.data.screenshotBase64);
        applyTelemetry(json.data);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSwitchToRepair = () => {
    if (!instanceName) return;
    setMode("pair");
    void startPairing(instanceName);
  };

  const handleCompleteSetup = async () => {
    if (!instanceName) return;
    setBusy(true);
    try {
      const res = await fetch("/api/warmup/mmzap-browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setup_complete",
          instance_name: instanceName,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !json?.success) {
        toast.error(json?.error || "Falha ao salvar conclusão.");
        return;
      }
      toast.success(`Extensão MMZap liberada para turnos em ${instanceName}.`);
      await onCompleted();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(styles.dialog, mode === "setup" && "!max-w-3xl")}>
        <div className={styles.dialogHeader}>
          {mode === "pair" ? (
            <QrCode className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <Monitor className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          )}
          <div>
            <DialogTitle className="text-base font-semibold text-[#edf2ee]">
              {mode === "pair"
                ? `Parear MMZap Web · ${instanceName || ""}`
                : `Tela ao vivo MMZap · ${instanceName || ""}`}
            </DialogTitle>
            <DialogDescription className="text-xs text-[#a5b1a8] mt-1">
              {mode === "pair"
                ? "Escaneie em Dispositivos Conectados usando o mesmo IP exclusivo da Evolution."
                : "Visualize ou clique no WhatsApp Web com o MMZap na VPS. Fechar mantém o turno rodando."}
            </DialogDescription>
          </div>
        </div>

        <div className={styles.dialogBody}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#a5b1a8] tabular-nums">
            <span>
              Proxy do navegador:{" "}
              <strong className="text-[#edf2ee] font-mono">
                {proxyIp || "IP padrão da VPS"}
              </strong>
            </span>
            <div className="inline-flex rounded-lg border border-[#303a32] bg-[#111712] p-0.5">
              <button
                type="button"
                onClick={() => {
                  setMode("pair");
                  if (instanceName) void startPairing(instanceName);
                }}
                className={cn(
                  "px-2.5 py-1 rounded-md text-[11px] font-medium",
                  mode === "pair"
                    ? "bg-[#223528] text-emerald-200 border border-emerald-500/40"
                    : "text-[#a5b1a8] hover:text-white border border-transparent"
                )}
              >
                QR Code
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("setup");
                  if (instanceName) void openSetup(instanceName);
                }}
                className={cn(
                  "px-2.5 py-1 rounded-md text-[11px] font-medium",
                  mode === "setup"
                    ? "bg-[#223528] text-emerald-200 border border-emerald-500/40"
                    : "text-[#a5b1a8] hover:text-white border border-transparent"
                )}
              >
                Tela ao vivo
              </button>
            </div>
          </div>

          {errorMsg && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-100">
              <AlertTriangle className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {mode === "pair" ? (
            <div className="flex flex-col items-center gap-3 py-2">
              {qrCodeBase64 ? (
                <div className="rounded-lg border border-[#303a32] bg-white p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qrCodeBase64}
                    alt={`QR Code MMZap de ${instanceName || "chip"}`}
                    className="w-60 h-60 object-contain"
                  />
                </div>
              ) : (
                <div className="w-60 h-60 rounded-lg border border-[#303a32] bg-[#101411] flex flex-col items-center justify-center gap-2 text-xs text-[#a5b1a8]">
                  <RefreshCw className={cn("w-5 h-5 text-emerald-400", busy && "animate-spin")} />
                  <span>{busy ? "Abrindo Chromium com proxy..." : "Aguardando QR Code..."}</span>
                </div>
              )}

              <button
                type="button"
                disabled={busy || !instanceName}
                onClick={() => instanceName && void startPairing(instanceName)}
                className={styles.secondaryAction}
              >
                <RefreshCw className={cn("w-3.5 h-3.5", busy && "animate-spin")} />
                Gerar novo QR
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {sessionLoggedOut ? (
                <div
                  role="alert"
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-100"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-red-100">
                        Sessão do WhatsApp Web deslogada neste navegador
                      </p>
                      <p className="text-[11px] text-red-200/80 mt-0.5">
                        Re-escaneie o QR Code para retomar o aquecimento MMZap mantendo o mesmo proxy exclusivo.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy || !instanceName}
                    onClick={handleSwitchToRepair}
                    className={styles.primaryAction}
                  >
                    <QrCode className="w-3.5 h-3.5" />
                    Re-parear QR
                  </button>
                </div>
              ) : (
                <div
                  role="status"
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs",
                    mmzapUiDetected
                      ? mmzapChipState === "is-error"
                        ? "border-red-500/35 bg-red-500/10 text-red-200"
                        : mmzapChipState === "is-off"
                          ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                          : "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                      : "border-[#303a32] bg-[#131914] text-[#c2cfc6]"
                  )}
                >
                  <span className="inline-flex items-center gap-2 font-medium">
                    {mmzapUiDetected ? (
                      mmzapChipState === "is-error" || mmzapChipState === "is-off" ? (
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      )
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 text-emerald-400 animate-spin shrink-0" />
                    )}
                    {mmzapUiDetected
                      ? mmzapChipState === "is-error"
                        ? `MMZap detectado com erro${mmzapStatusLabel ? ` · ${mmzapStatusLabel}` : ""}`
                        : mmzapChipState === "is-off"
                          ? `MMZap detectado (pausado)${mmzapStatusLabel ? ` · ${mmzapStatusLabel}` : ""}`
                          : `Interface MMZap detectada e ativa${mmzapStatusLabel ? ` · ${mmzapStatusLabel}` : ""}`
                      : "Carregando interface da extensão MMZap no WhatsApp Web..."}
                  </span>
                  {watchdogRecoveries > 0 && (
                    <span className="text-[11px] font-mono tabular-nums text-[#a5b1a8]">
                      Watchdog: {watchdogRecoveries} recup.
                    </span>
                  )}
                </div>
              )}

              <div className="overflow-hidden rounded-lg border border-[#303a32] bg-[#101411]">
                {screenshotBase64 ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    ref={imgRef}
                    src={screenshotBase64}
                    onClick={handleImageClick}
                    alt={`Tela de configuração da extensão MMZap em ${instanceName || "chip"}`}
                    className="w-full h-auto cursor-crosshair select-none"
                  />
                ) : (
                  <div className="h-64 flex items-center justify-center text-xs text-[#a5b1a8]">
                    Carregando janela da extensão no Chromium...
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Digite aqui para enviar texto para o campo clicado..."
                  className="bg-[#101411] border-[#303a32] text-xs flex-1 min-w-[220px]"
                />
                <button
                  type="button"
                  disabled={busy || !textInput}
                  onClick={() => {
                    const txt = textInput;
                    setTextInput("");
                    void sendInput({ type: "text", text: txt });
                  }}
                  className={styles.secondaryAction}
                >
                  <Send className="w-3.5 h-3.5" />
                  Enviar texto
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendInput({ type: "key", key: "Enter" })}
                  className={styles.secondaryAction}
                >
                  <CornerDownLeft className="w-3.5 h-3.5" />
                  Enter
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendInput({ type: "goto", url: "https://web.whatsapp.com" })}
                  className={styles.secondaryAction}
                >
                  <Monitor className="w-3.5 h-3.5" />
                  WhatsApp Web
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRefreshScreenshot()}
                  className={styles.secondaryAction}
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", busy && "animate-spin")} />
                  Atualizar tela
                </button>
              </div>
            </div>
          )}

          <div className={styles.dialogActions}>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={styles.secondaryAction}
            >
              Fechar
            </button>
            {mode === "setup" && !sessionLoggedOut && sessionStatus !== "running" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleCompleteSetup()}
                className={styles.primaryAction}
              >
                <CheckCircle2 className="w-4 h-4" />
                Concluir configuração
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
