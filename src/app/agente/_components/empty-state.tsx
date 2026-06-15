"use client";

import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

/**
 * EmptyState — placeholder amigável quando uma lista está vazia
 * (sem KB, sem etapas, sem agentes, etc).
 *
 * Antes: o usuário caia em telas vazias sem entender o que fazer.
 * Agora: ícone + título + explicação curta + CTA opcional.
 */

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Botão/link de ação ("Criar primeiro X"). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-10 px-6 rounded-2xl",
        "bg-white/[0.02] border border-dashed border-white/10",
        className
      )}
    >
      <div className="p-3 mb-3 rounded-2xl bg-white/5 text-muted-foreground/70">
        <Icon className="w-6 h-6" />
      </div>
      <h4 className="font-bold text-sm text-foreground/90 mb-1.5">{title}</h4>
      {description && (
        <p className="text-xs text-muted-foreground max-w-sm leading-relaxed mb-4">{description}</p>
      )}
      {action && <div>{action}</div>}
    </div>
  );
}
