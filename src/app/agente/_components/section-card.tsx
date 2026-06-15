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
  /** Conteúdo da seção. */
  children: ReactNode;
  className?: string;
}

export function SectionCard({
  icon: Icon,
  title,
  description,
  hint,
  accent = "primary",
  rightAction,
  children,
  className,
}: SectionCardProps) {
  const c = ACCENT_CLASSES[accent];

  return (
    <section
      className={cn(
        "bg-card/40 border border-white/5 rounded-2xl p-5 space-y-4 backdrop-blur-sm",
        className
      )}
    >
      <header className="flex items-start gap-3">
        <div className={cn("shrink-0 p-2.5 rounded-xl ring-1", c.bg, c.ring)}>
          <Icon className={cn("w-5 h-5", c.text)} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-base text-foreground">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
          )}
        </div>
        {rightAction && <div className="shrink-0">{rightAction}</div>}
      </header>

      {hint && (
        <div className="flex items-start gap-2.5 p-3 bg-blue-500/5 border border-blue-500/15 rounded-xl">
          <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
          <div className="text-[11px] leading-relaxed text-blue-100/80">{hint}</div>
        </div>
      )}

      <div className="space-y-4">{children}</div>
    </section>
  );
}
