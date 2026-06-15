"use client";

/**
 * <LeadIntelligenceBatch /> — botão pré-analisar leads em batch.
 *
 * Reutilizado em /disparo e /automacao. Pega uma lista de lead IDs (que serão
 * disparados/captados) e analisa todos. O briefing fica cacheado em
 * leads_extraidos.intelligence — quando o disparo personalizar com IA, vai
 * usar esse briefing automaticamente como contexto extra.
 *
 * Mostra progresso, total analisados, total via cache, falhas. Não bloqueia
 * a UI — pode rodar em paralelo enquanto o operador edita a campanha.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Bot, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface Props {
  leadIds: number[];
  /** Texto custom; default: "Pré-analisar X lead(s) com IA". */
  label?: string;
  /** Pra estilizar como rosca/full/etc. */
  className?: string;
  /** Tooltip explicativo. */
  hint?: string;
  /** Callback após terminar (pra recarregar dados na tela hospedeira). */
  onDone?: (result: { analyzed: number; cached: number; fresh: number; errors: number }) => void;
}

export function LeadIntelligenceBatch({ leadIds, label, className, hint, onDone }: Props) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<{ analyzed: number; cached: number; fresh: number; errors: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = leadIds.length;

  const run = async () => {
    if (total === 0 || running) return;
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      const r = await fetch("/api/leads/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_ids: leadIds }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha");
      const result = {
        analyzed: d.analyzed || 0,
        cached: d.cached || 0,
        fresh: d.fresh || 0,
        errors: (d.errors || []).length,
      };
      setDone(result);
      onDone?.(result);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  if (total === 0) {
    return (
      <div className={cn("text-[11px] text-muted-foreground italic", className)}>
        Sem leads pra pré-analisar ainda.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Button
        onClick={run}
        disabled={running}
        title={hint || "Pré-analisa cada lead com IA: lê o site, busca na web sobre a empresa e concorrentes, e gera um briefing estratégico. O briefing fica cacheado e é injetado automaticamente nas mensagens personalizadas pela IA."}
        className={cn(
          "h-10 rounded-xl gap-2 text-xs font-bold transition-all",
          done && !error
            ? "bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-100"
            : "bg-gradient-to-r from-cyan-500/20 to-purple-500/20 hover:from-cyan-500/30 hover:to-purple-500/30 border border-cyan-500/40 text-cyan-100",
        )}
      >
        {running ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Analisando {total} lead(s)... pode levar 1-3min
          </>
        ) : done && !error ? (
          <>
            <CheckCircle2 className="w-3.5 h-3.5" />
            Análise OK — re-analisar?
          </>
        ) : (
          <>
            <Bot className="w-3.5 h-3.5" />
            {label || `Pré-analisar ${total} lead(s) com IA`}
          </>
        )}
      </Button>

      {done && !error && (
        <div className="flex items-center gap-3 text-[10px] text-emerald-200/80 px-1">
          <span><strong>{done.fresh}</strong> novos · <strong>{done.cached}</strong> do cache</span>
          {done.errors > 0 && <span className="text-amber-300">⚠ {done.errors} falha(s)</span>}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-[10px] text-red-300 px-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </div>
      )}
      {!running && !done && !error && (
        <p className="text-[10px] text-muted-foreground/80 px-1 leading-relaxed">
          IA lê o site + Google Maps + concorrentes na web. ~1k tokens por lead. Re-cache 30 dias.
        </p>
      )}
    </div>
  );
}
