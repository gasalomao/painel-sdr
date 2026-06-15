"use client";

import { Button } from "@/components/ui/button";
import { Check, Loader2, Save } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * SaveButton — botão de save PADRONIZADO pra usar em qualquer formulário
 * da página /agente. Resolve a inconsistência de antes (cada subseção tinha
 * estilo diferente: glow-primary, blue-600, ghost, etc).
 *
 * Estados visuais (auto-gerenciados):
 *   1. Idle   — "Salvar X" + ícone Save
 *   2. Saving — "Salvando..." + spinner (auto: enquanto onSave() não termina)
 *   3. Saved  — "Salvo ✓" verde por 1.8s, depois volta pro idle
 *
 * O dev passa só onSave (async) e label. Estados de loading/sucesso são
 * automáticos via promise.
 */

export interface SaveButtonProps {
  /** Texto do botão. Ex: "Salvar Identidade". */
  label: string;
  /** Handler async — botão entra em loading enquanto ele resolve. */
  onSave: () => Promise<any> | void;
  /** Bloqueia o botão (ex: campo obrigatório vazio). */
  disabled?: boolean;
  /** Variante visual. "primary" = roxo glow (default), "subtle" = ghost. */
  variant?: "primary" | "subtle";
  /** Tamanho. "lg" (default — sticky bar) ou "sm" (inline). */
  size?: "lg" | "sm";
  /** Largura. "full" (default) ou "auto" (não estica). */
  width?: "full" | "auto";
  className?: string;
}

export function SaveButton({
  label,
  onSave,
  disabled = false,
  variant = "primary",
  size = "lg",
  width = "full",
  className,
}: SaveButtonProps) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  const handle = async () => {
    if (status === "saving" || disabled) return;
    setStatus("saving");
    try {
      const r = onSave();
      if (r instanceof Promise) await r;
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 1800);
    } catch {
      setStatus("idle");
    }
  };

  const isPrimary = variant === "primary";
  const isLg = size === "lg";

  return (
    <Button
      onClick={handle}
      disabled={disabled || status === "saving"}
      className={cn(
        // Base
        "rounded-xl font-bold uppercase tracking-widest transition-all gap-2",
        // Size
        isLg ? "h-11 text-xs px-6" : "h-9 text-[11px] px-4",
        // Width
        width === "full" && "w-full",
        // Variant
        isPrimary
          ? "glow-primary"
          : "bg-white/5 hover:bg-white/10 text-foreground border border-white/10",
        // Saved state — verde temporário
        status === "saved" && "!bg-emerald-500 hover:!bg-emerald-500 !text-black !border-transparent",
        className
      )}
    >
      {status === "saving" ? (
        <>
          <Loader2 className={cn(isLg ? "w-4 h-4" : "w-3.5 h-3.5", "animate-spin")} />
          Salvando…
        </>
      ) : status === "saved" ? (
        <>
          <Check className={isLg ? "w-4 h-4" : "w-3.5 h-3.5"} />
          Salvo
        </>
      ) : (
        <>
          <Save className={isLg ? "w-4 h-4" : "w-3.5 h-3.5"} />
          {label}
        </>
      )}
    </Button>
  );
}
