"use client";

import { cn } from "@/lib/utils";

/**
 * Toggle switch acessível usado por toda a página /agente. Padroniza o
 * visual hand-rolled que estava duplicado em ~8 lugares (info, ajustes,
 * sortable-stage, testes) e adiciona role="switch" + aria-checked +
 * suporte a teclado (Space/Enter via button nativo).
 *
 * `color` controla a cor do trilho quando ativo. `size` ajusta as
 * dimensões — `sm` é o tamanho compacto usado em sub-itens; `md` é o
 * padrão (linhas de configuração); `lg` é o usado nos toggles grandes
 * de seção (ex: ativar agente, calendar enabled).
 */
export type ToggleColor = "primary" | "green" | "blue" | "cyan" | "yellow" | "purple" | "emerald";
export type ToggleSize = "sm" | "md" | "lg";

const COLOR_BG: Record<ToggleColor, string> = {
  primary: "bg-primary",
  green:   "bg-green-500",
  blue:    "bg-blue-500",
  cyan:    "bg-cyan-500",
  yellow:  "bg-yellow-500",
  purple:  "bg-purple-500",
  emerald: "bg-emerald-500",
};

// Trilho / knob / deslocamento por tamanho — mantém os mesmos valores que
// já estavam espalhados nos toggles originais pra não mudar a aparência.
const SIZE_TRACK: Record<ToggleSize, string> = {
  sm: "w-8 h-4",
  md: "w-9 h-5",
  lg: "w-12 h-6",
};
const SIZE_KNOB: Record<ToggleSize, string> = {
  sm: "w-3 h-3",
  md: "w-4 h-4",
  lg: "w-4 h-4",
};
const SIZE_TRANSLATE: Record<ToggleSize, string> = {
  sm: "translate-x-[18px]",
  md: "translate-x-4",
  lg: "translate-x-6",
};

export function Toggle({
  checked,
  onCheckedChange,
  color = "primary",
  size = "md",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  color?: ToggleColor;
  size?: ToggleSize;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "rounded-full relative cursor-pointer transition-all p-0.5 flex items-center shrink-0",
        SIZE_TRACK[size],
        checked ? COLOR_BG[color] : "bg-white/10",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <span
        className={cn(
          "rounded-full bg-white transition-all shadow-sm pointer-events-none",
          SIZE_KNOB[size],
          checked ? SIZE_TRANSLATE[size] : "translate-x-0"
        )}
      />
    </button>
  );
}
