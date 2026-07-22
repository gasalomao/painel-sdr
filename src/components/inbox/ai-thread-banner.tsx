"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Sparkles, Hand, Play, Loader2, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface AiThreadBannerProps {
  conversationId: string; // remoteJid
  botStatus: "bot_active" | "bot_paused" | string;
  resumeAt: string | null;
  instanceName: string;
  onChange?: (patch: { bot_status: string; resume_at: string | null }) => void;
}

export function AiThreadBanner({
  conversationId,
  botStatus,
  resumeAt,
  instanceName,
  onChange,
}: AiThreadBannerProps) {
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState<string | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Calcula a contagem regressiva se a IA estiver pausada temporariamente (snoozed com resume_at)
  useEffect(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }

    if (!resumeAt || botStatus !== "bot_paused") {
      setCountdown(null);
      return;
    }

    const updateCountdown = () => {
      const now = new Date().getTime();
      const resumeTime = new Date(resumeAt).getTime();
      const diff = resumeTime - now;

      if (diff <= 0) {
        setCountdown(null);
        if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
        onChange?.({ bot_status: "bot_active", resume_at: null });
        return;
      }

      const h = Math.floor(diff / (1000 * 60 * 60));
      const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const s = Math.floor((diff % (1000 * 60)) / 1000);

      const hStr = h > 0 ? `${h}h ` : "";
      const mStr = m > 0 ? `${m}m ` : "";
      const sStr = `${s}s`;

      setCountdown(`${hStr}${mStr}${sStr}`);
    };

    updateCountdown();
    countdownIntervalRef.current = setInterval(updateCountdown, 1000);

    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [resumeAt, botStatus, conversationId, onChange]);

  // Função para Pausar / Retomar a IA
  const handleToggleAi = useCallback(
    async (action: "pause" | "resume") => {
      if (!conversationId) {
        toast.error("Contato inválido para alteração do agente.");
        return;
      }
      setBusy(true);
      try {
        const res = await fetch("/api/agent/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            remoteJid: conversationId,
            instanceName: instanceName || undefined,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          toast.error(data.error || "Erro ao atualizar controle do agente.");
          return;
        }

        const newStatus = action === "pause" ? "bot_paused" : "bot_active";
        const newResumeAt = action === "pause" && data.resumeAt ? data.resumeAt : null;

        onChange?.({
          bot_status: newStatus,
          resume_at: newResumeAt,
        });

        toast.success(
          action === "pause"
            ? "Robô IA Silenciado! (Humano assumiu o atendimento)"
            : "Robô IA Ativado! (IA responderá as mensagens)"
        );
      } catch (err) {
        console.error("Erro ao alterar controle de IA:", err);
        toast.error("Falha de rede ao configurar o agente.");
      } finally {
        setBusy(false);
      }
    },
    [conversationId, instanceName, onChange]
  );

  const isPaused = botStatus === "bot_paused";

  return (
    <div
      className={cn(
        "flex items-center justify-between border-b px-4 py-2 text-xs transition-colors shrink-0",
        isPaused
          ? "border-amber-200/50 bg-amber-500/10 text-amber-800 dark:text-amber-400"
          : "border-primary/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-400"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Sparkles className={cn("h-4 w-4 shrink-0", !isPaused && "animate-pulse")} />
        <span className="font-medium truncate">
          {isPaused ? (
            countdown ? (
              <span className="flex items-center gap-1">
                <Timer className="h-3.5 w-3.5 shrink-0" />
                Robô silenciado temporariamente (reativa em: <strong className="font-mono">{countdown}</strong>)
              </span>
            ) : (
              "Robô silenciado. O atendimento está sob controle humano."
            )
          ) : (
            "Robô IA ativo e respondendo automaticamente."
          )}
        </span>
      </div>

      <div className="shrink-0 pl-4">
        {isPaused ? (
          <button
            onClick={() => handleToggleAi("resume")}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1 h-6 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-medium px-2.5 transition-colors cursor-pointer text-[10px] disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3 fill-current" />
            )}
            Ativar Robô
          </button>
        ) : (
          <button
            onClick={() => handleToggleAi("pause")}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1 h-6 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-medium px-2.5 transition-colors cursor-pointer text-[10px] disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Hand className="h-3 w-3" />
            )}
            Silenciar Robô
          </button>
        )}
      </div>
    </div>
  );
}
