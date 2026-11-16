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

export type WeekendB2BGuardResult = {
  allowed: boolean;
  hourlyFactor: number;
  weekday: string;
  reason?: string;
};

/**
 * Modo Comercial B2B (opt-in por campanha/follow-up):
 * - Domingo: pausa disparos frios automaticamente (alta taxa de denúncia B2B).
 * - Sábado: reduz o teto por hora pela metade (hourlyFactor = 0.5).
 * - Seg–Sex (ou quando desabilitado): operação normal (hourlyFactor = 1).
 */
export function evaluateWeekendB2BGuard(
  weekendGuardEnabled: boolean,
  now: Date = new Date()
): WeekendB2BGuardResult {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).format(now);
  if (!weekendGuardEnabled) {
    return { allowed: true, hourlyFactor: 1, weekday };
  }
  if (weekday === "Sun") {
    return { allowed: false, hourlyFactor: 0, weekday, reason: "weekend_b2b_sunday" };
  }
  if (weekday === "Sat") {
    return { allowed: true, hourlyFactor: 0.5, weekday, reason: "weekend_b2b_saturday" };
  }
  return { allowed: true, hourlyFactor: 1, weekday };
}



