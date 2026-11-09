/**
 * Utilitário de cálculo de delay e simulação de presença humana (digitando...)
 * para o Evolution API no Agente de IA.
 *
 * Suporta:
 * 1. Modo Fixo: valor exato em segundos (ex: 10s).
 * 2. Modo Aleatório: sorteio uniforme dentro de uma faixa [min, max] (ex: 5s a 25s).
 */

export type TypingDelayMode = "fixed" | "random";

export interface TypingDelayConfig {
  mode: TypingDelayMode;
  fixedSeconds: number;
  minSeconds: number;
  maxSeconds: number;
}

export const DEFAULT_TYPING_DELAY_CONFIG: TypingDelayConfig = {
  mode: "random",
  fixedSeconds: 10,
  minSeconds: 5,
  maxSeconds: 25,
};

/**
 * Normaliza e sanitiza a configuração vinda do JSONB options do agente,
 * scrape_filters da automação ou objeto de campanha.
 */
export function normalizeTypingDelayConfig(raw?: any): TypingDelayConfig {
  const target = raw && typeof raw === "object" ? (raw.typing_delay || raw.typingDelay || raw) : {};
  const modeVal = target.mode || target.typing_delay_mode || target.typingDelayMode;
  const mode: TypingDelayMode = modeVal === "fixed" ? "fixed" : "random";

  const rawFixed = Number(
    target.fixedSeconds ??
    target.seconds ??
    target.typing_delay_seconds ??
    target.typingDelaySeconds
  );
  const fixedSeconds = Number.isFinite(rawFixed) ? Math.max(1, Math.min(rawFixed, 120)) : DEFAULT_TYPING_DELAY_CONFIG.fixedSeconds;

  const rawMin = Number(
    target.minSeconds ??
    target.min_seconds ??
    target.typing_delay_min_seconds ??
    target.typingDelayMinSeconds
  );
  const minSeconds = Number.isFinite(rawMin) ? Math.max(1, Math.min(rawMin, 120)) : DEFAULT_TYPING_DELAY_CONFIG.minSeconds;

  const rawMax = Number(
    target.maxSeconds ??
    target.max_seconds ??
    target.typing_delay_max_seconds ??
    target.typingDelayMaxSeconds
  );
  let maxSeconds = Number.isFinite(rawMax) ? Math.max(1, Math.min(rawMax, 120)) : DEFAULT_TYPING_DELAY_CONFIG.maxSeconds;

  if (maxSeconds < minSeconds) {
    maxSeconds = minSeconds;
  }

  return {
    mode,
    fixedSeconds,
    minSeconds,
    maxSeconds,
  };
}

/**
 * Calcula o delay em segundos para a próxima mensagem.
 * Se fixed -> retorna fixedSeconds.
 * Se random -> sorteia um inteiro entre minSeconds e maxSeconds (inclusivo).
 */
export function calculateTypingDelaySeconds(rawConfig?: Partial<TypingDelayConfig> | null): number {
  const cfg = normalizeTypingDelayConfig(rawConfig);
  if (cfg.mode === "fixed") {
    return cfg.fixedSeconds;
  }

  const range = cfg.maxSeconds - cfg.minSeconds;
  if (range <= 0) return cfg.minSeconds;

  return Math.floor(Math.random() * (range + 1)) + cfg.minSeconds;
}

/**
 * Retorna o delay em milissegundos para envio ao Evolution API (parâmetro `delay`).
 */
export function calculateTypingDelayMs(rawConfig?: Partial<TypingDelayConfig> | null): number {
  return calculateTypingDelaySeconds(rawConfig) * 1000;
}
