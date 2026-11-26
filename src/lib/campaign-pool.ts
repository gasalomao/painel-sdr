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

export const DEFAULT_B2B_WEEKEND_GUARD_MODE: WeekendB2BGuardMode = "sunday_only";

/**
 * Normaliza valores vindos do banco/app_settings/API para `WeekendB2BGuardMode`,
 * preservando `"sunday_only"` (sábado 100%, domingo pausado — janela pico B2B local).
 */
export function parseWeekendB2BGuardMode(raw: unknown): WeekendB2BGuardMode {
  if (raw === "sunday_only") return "sunday_only";
  if (raw === "full" || raw === true || raw === "true" || raw === "1" || raw === 1) {
    return "full";
  }
  return false;
}

export type WeekendB2BGuardResult = {
  allowed: boolean;
  hourlyFactor: number;
  weekday: string;
  reason?: string;
};

/**
 * Identifica se o horário atual em Brasília corresponde às janelas de maior taxa
 * de resposta de donos de negócios locais B2B (sábado comercial e dias úteis 18h–20h).
 */
export function isB2BPeakReplyWindow(now: Date = new Date()): {
  isPeak: boolean;
  weekday: string;
  hourBrt: number;
  windowLabel: string;
} {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).format(now);
  const hourBrt =
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        hour12: false,
      }).format(now)
    ) % 24;

  if (weekday === "Sat" && hourBrt >= 9 && hourBrt < 20) {
    return { isPeak: true, weekday, hourBrt, windowLabel: "saturday_owner_window" };
  }
  if (weekday !== "Sun" && weekday !== "Sat" && hourBrt >= 18 && hourBrt < 21) {
    return { isPeak: true, weekday, hourBrt, windowLabel: "evening_b2b_peak" };
  }
  return { isPeak: false, weekday, hourBrt, windowLabel: "standard" };
}

/**
 * Modo Comercial B2B (opt-in por campanha/follow-up):
 * - Domingo: pausa disparos frios automaticamente (alta taxa de denúncia B2B).
 * - Sábado: `true`/`"full"` reduz pela metade (`hourlyFactor = 0.5`), `"sunday_only"` libera 100% (`hourlyFactor = 1`, janela pico de resposta B2B).
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



