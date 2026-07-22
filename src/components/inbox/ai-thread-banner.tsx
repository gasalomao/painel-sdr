"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Sparkles, Hand, Play, Loader2, Timer, ChevronDown, Clock, Bot, UserCheck } from "lucide-react";
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
      const sStr = `${s.toString().padStart(2, "0")}s`;

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
        "flex items-center justify-between border-b px-4 py-2.5 text-xs transition-all shrink-0 shadow-sm",
        isPaused
          ? "border-amber-500/30 bg-gradient-to-r from-amber-500/15 via-amber-500/10 to-amber-500/5 text-amber-900 dark:text-amber-200"
          : "border-emerald-500/30 bg-gradient-to-r from-emerald-500/15 via-emerald-500/10 to-emerald-500/5 text-emerald-900 dark:text-emerald-200"
      )}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Badge do Atendimento */}
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide shrink-0 shadow-sm uppercase",
            isPaused
              ? "bg-amber-600 text-white"
              : "bg-emerald-600 text-white"
          )}
        >
          {isPaused ? (
            <>
              <UserCheck className="h-3.5 w-3.5" />
              <span>ATENDIMENTO HUMANO</span>
            </>
          ) : (
            <>
              <Bot className="h-3.5 w-3.5 animate-pulse" />
              <span>ATENDIMENTO IA</span>
            </>
          )}
        </div>

        {/* Texto descritivo e Tempo Restante */}
        <div className="flex items-center gap-2 min-w-0 flex-1 truncate">
          {isPaused ? (
            countdown ? (
              <div className="flex items-center gap-1.5 font-medium truncate">
                <span className="truncate">Pausa humana ativa. Tempo restante para a IA reativar:</span>
                <span className="inline-flex items-center gap-1 rounded-md bg-amber-600/20 border border-amber-600/30 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-900 dark:text-amber-100 shrink-0">
                  <Timer className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300 animate-spin" style={{ animationDuration: '4s' }} />
                  {countdown}
                </span>
              </div>
            ) : (
              <span className="font-medium truncate">
                IA silenciada indefinidamente. Atendimento mantido pelo operador humano.
              </span>
            )
          ) : (
            <span className="font-medium truncate">
              O robô de Inteligência Artificial está ativo e respondendo este chat automaticamente.
            </span>
          )}
        </div>
      </div>

      {/* Botões de Ação */}
      <div className="shrink-0 pl-3">
        {isPaused ? (
          <button
            onClick={handleResumeAi}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 h-7 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-3 transition-colors cursor-pointer text-xs shadow-sm disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
            Reativar IA
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 h-7 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-semibold px-3 transition-colors cursor-pointer text-xs shadow-sm disabled:opacity-50 outline-none"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Hand className="h-3.5 w-3.5" />
              )}
              Silenciar Robô (Pausar IA)
              <ChevronDown className="h-3.5 w-3.5 opacity-80" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" className="w-60 border-border bg-popover text-popover-foreground shadow-lg">
              <div className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">
                Selecione a duração da pausa humana:
              </div>
              <DropdownMenuSeparator />
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
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs font-medium text-blue-600 dark:text-blue-400" onClick={() => handlePauseAi(-1)}>
                <Timer className="h-3.5 w-3.5 text-blue-500" />
                Definir tempo em minutos...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer gap-2 text-xs text-red-600 dark:text-red-400 focus:text-red-600 font-semibold" onClick={() => handlePauseAi(undefined)}>
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
