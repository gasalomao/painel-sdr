export const AUTO_POOL_INSTANCE = "__auto_pool__";

export function isAutoPoolInstance(name?: string | null): boolean {
  return String(name || "").trim() === AUTO_POOL_INSTANCE;
}

export function formatInstanceLabel(name?: string | null): string {
  if (isAutoPoolInstance(name)) {
    return "⚡ Pool Automático (Multi-Chip)";
  }
  return String(name || "");
}

export type WeekendB2BGuardMode = boolean | "full" | "sunday_only";

export type WeekendB2BGuardResult = {
  allowed: boolean;
  hourlyFactor: number;
  weekday: string;
  reason?: string;
};

/**
 * Modo Comercial B2B (opt-in por campanha/follow-up):
 * - Domingo: pausa disparos frios automaticamente (alta taxa de denúncia B2B).
 * - Sábado: `true`/`"full"` reduz pela metade (`hourlyFactor = 0.5`), `"sunday_only"` libera 100% (`hourlyFactor = 1`).
 * - Seg–Sex (ou quando desabilitado): operação normal (hourlyFactor = 1).
 */
export function evaluateWeekendB2BGuard(
  weekendGuardMode: WeekendB2BGuardMode,
  now: Date = new Date()
): WeekendB2BGuardResult {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).format(now);
  if (!weekendGuardMode) {
    return { allowed: true, hourlyFactor: 1, weekday };
  }
  if (weekday === "Sun") {
    return { allowed: false, hourlyFactor: 0, weekday, reason: "weekend_b2b_sunday" };
  }
  if (weekday === "Sat") {
    if (weekendGuardMode === "sunday_only") {
      return { allowed: true, hourlyFactor: 1, weekday, reason: "weekend_b2b_saturday_full" };
    }
    return { allowed: true, hourlyFactor: 0.5, weekday, reason: "weekend_b2b_saturday" };
  }
  return { allowed: true, hourlyFactor: 1, weekday };
}



