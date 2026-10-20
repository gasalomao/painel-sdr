"use client";

import { cn } from "@/lib/utils";
import { Info, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

/**
 * SectionCard — wrapper PADRONIZADO pra cada subseção de config do agente.
 *
 * Antes: cada seção (Identidade, Calendar, KB, etc) tinha seu próprio
 * cabeçalho ad-hoc — variava cor, padding, hierarquia. Resultado: usuário
 * leigo perdia a noção de "o que é cada bloco e o que faz".
 *
 * Padrão aqui:
 *   - Header: ícone colorido + título + descrição curta (1 linha)
 *   - "Dica" opcional: caixa azul translúcida com texto explicativo
 *     pra quem nunca configurou. Esconde-se quando o usuário fecha (uma vez).
 *   - Body: conteúdo livre.
 *
 * Cores: 'primary' (roxo), 'blue' (calendário/integrações), 'cyan' (KB/RAG),
 * 'amber' (cuidado/atenção), 'emerald' (sucesso/ativo), 'purple' (IA).
 */

type AccentColor = "primary" | "blue" | "cyan" | "amber" | "emerald" | "purple";

const ACCENT_CLASSES: Record<AccentColor, { bg: string; text: string; ring: string }> = {
  primary: { bg: "bg-primary/15", text: "text-primary", ring: "ring-primary/20" },
  blue:    { bg: "bg-blue-500/15", text: "text-blue-300", ring: "ring-blue-500/20" },
  cyan:    { bg: "bg-cyan-500/15", text: "text-cyan-300", ring: "ring-cyan-500/20" },
  amber:   { bg: "bg-amber-500/15", text: "text-amber-300", ring: "ring-amber-500/20" },
  emerald: { bg: "bg-emerald-500/15", text: "text-emerald-300", ring: "ring-emerald-500/20" },
  purple:  { bg: "bg-purple-500/15", text: "text-purple-300", ring: "ring-purple-500/20" },
};

export interface SectionCardProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Caixa azul com explicação pra usuário novo. Pode ser texto ou nodes. */
  hint?: ReactNode;
  /** Cor do ícone/destaque. Default 'primary'. */
  accent?: AccentColor;
  /** Slot pra um botão/toggle no canto direito (ex: ativar feature). */
  rightAction?: ReactNode;
  /** Número do passo no fluxo guiado (1, 2, 3...). Renderiza badge numerado. */
  step?: number;
  /** Conteúdo da seção. */
  children: ReactNode;
  className?: string;
  id?: string;
}

export function SectionCard({
  icon: Icon,
  title,
  description,
  hint,
  accent = "primary",
  rightAction,
  step,
  children,
  className,
  id,
}: SectionCardProps) {
  const c = ACCENT_CLASSES[accent];

  return (
    <section
      id={id}
      aria-label={title}
      className={cn(
        "min-w-0 scroll-mt-6 bg-card border border-white/10 rounded-2xl p-4 sm:p-6 space-y-5",
        className
      )}
    >
      <header className="flex flex-wrap items-start gap-3">
        {step !== undefined && (
          <div className="shrink-0 w-8 h-8 rounded-lg bg-primary/10 text-primary font-semibold text-sm flex items-center justify-center" aria-label={`Passo ${step}`}>
            {step}
          </div>
        )}
        <div className={cn("shrink-0 p-2 rounded-lg", c.bg, step !== undefined && "hidden sm:block")}>
          <Icon className={cn("w-4 h-4", c.text)} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <h3 className="font-bold text-base text-foreground">{title}</h3>
          {description && (
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{description}</p>
          )}
        </div>
        {rightAction && <div className="shrink-0 ml-auto max-w-full">{rightAction}</div>}
      </header>

      {hint && (
        <div className="flex items-start gap-2.5 py-1">
          <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-xs leading-relaxed text-muted-foreground max-w-prose">{hint}</div>
        </div>
      )}

      <div className="space-y-4">{children}</div>
    </section>
  );
}
