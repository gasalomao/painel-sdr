"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Sparkles, Hand, Play, Loader2, Timer, ChevronDown, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

  // Função para Ativar a IA
  const handleResumeAi = useCallback(async () => {
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
          action: "resume",
          remoteJid: conversationId,
          instanceName: instanceName || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        toast.error(data.error || "Erro ao ativar o agente.");
        return;
      }

      onChange?.({
        bot_status: "bot_active",
        resume_at: null,
      });

      toast.success("Robô IA Ativado! (IA responderá as mensagens)");
    } catch (err) {
      console.error("Erro ao ativar controle de IA:", err);
      toast.error("Falha de rede ao configurar o agente.");
    } finally {
      setBusy(false);
    }
  }, [conversationId, instanceName, onChange]);

  // Função para Silenciar/Pausar a IA por tempo específico em minutos (ou indefinido)
  const handlePauseAi = useCallback(
    async (durationMinutes?: number) => {
      if (!conversationId) {
        toast.error("Contato inválido para alteração do agente.");
        return;
      }

      let minutes = durationMinutes;

      // Opção de tempo customizado em minutos
      if (minutes === -1) {
        const input = window.prompt("Digite o tempo em minutos para silenciar a IA nesta conversa:", "30");
        if (!input) return;
        const parsed = parseInt(input.trim(), 10);
        if (isNaN(parsed) || parsed <= 0) {
          toast.error("Por favor, informe uma quantidade válida de minutos.");
          return;
        }
        minutes = parsed;
      }

      setBusy(true);
      try {
        const action = minutes ? "snooze" : "pause";
        const res = await fetch("/api/agent/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            remoteJid: conversationId,
            instanceName: instanceName || undefined,
            durationMinutes: minutes,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          toast.error(data.error || "Erro ao atualizar controle do agente.");
          return;
        }

        const newStatus = "bot_paused";
        const newResumeAt = data.resumeAt || data.resume_at || null;

        onChange?.({
          bot_status: newStatus,
          resume_at: newResumeAt,
        });

        toast.success(
          minutes
            ? `Robô IA silenciado nesta conversa por ${minutes} minuto(s)!`
            : "Robô IA silenciado indefinidamente nesta conversa."
        );
      } catch (err) {
        console.error("Erro ao pausar controle de IA:", err);
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
                <Timer className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
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
            onClick={handleResumeAi}
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
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              className="inline-flex items-center justify-center gap-1 h-6 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-medium px-2.5 transition-colors cursor-pointer text-[10px] disabled:opacity-50 outline-none"
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Hand className="h-3 w-3" />
              )}
              Silenciar Robô
              <ChevronDown className="h-3 w-3 opacity-80" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" className="w-56 border-border bg-popover text-popover-foreground">
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs" onClick={() => handlePauseAi(15)}>
                <Clock className="h-3.5 w-3.5 text-amber-500" />
                Pausar por 15 minutos
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs" onClick={() => handlePauseAi(30)}>
                <Clock className="h-3.5 w-3.5 text-amber-500" />
                Pausar por 30 minutos
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs" onClick={() => handlePauseAi(60)}>
                <Clock className="h-3.5 w-3.5 text-amber-500" />
                Pausar por 1 hora (60 min)
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs" onClick={() => handlePauseAi(120)}>
                <Clock className="h-3.5 w-3.5 text-amber-500" />
                Pausar por 2 horas
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs" onClick={() => handlePauseAi(240)}>
                <Clock className="h-3.5 w-3.5 text-amber-500" />
                Pausar por 4 horas
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs" onClick={() => handlePauseAi(720)}>
                <Clock className="h-3.5 w-3.5 text-amber-500" />
                Pausar por 12 horas
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs" onClick={() => handlePauseAi(-1)}>
                <Timer className="h-3.5 w-3.5 text-blue-500" />
                Definir tempo em minutos...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs text-red-500 focus:text-red-500 font-medium" onClick={() => handlePauseAi(undefined)}>
                <Hand className="h-3.5 w-3.5" />
                Silenciar Indefinidamente
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
