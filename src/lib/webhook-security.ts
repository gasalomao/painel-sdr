import { timingSafeEqual } from "crypto";

/**
 * Comparação timing-safe de segredos de webhook.
 * Strings de tamanhos diferentes → false imediato (não vaza prefixo).
 */
export function safeSecretEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const LOGGED_ONCE = new Set<string>();

/**
 * Log-1x-por-processo por (bucket, key) — evita inundar webhook_logs com uma
 * linha por mensagem em instâncias legadas sem secret configurado.
 */
export function shouldLogOnce(bucket: string, key: string): boolean {
  const k = `${bucket}:${key}`;
  if (LOGGED_ONCE.has(k)) return false;
  if (LOGGED_ONCE.size >= 1024) LOGGED_ONCE.clear();
  LOGGED_ONCE.add(k);
  return true;
}
