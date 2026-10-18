import { normalizeJid } from "./jid-utils";

/**
 * Domínios e padrões permitidos para fotos do WhatsApp/Meta.
 */
const ALLOWED_PHOTO_HOSTS = [
  "pps.whatsapp.net",
  "whatsapp.net",
  "fbcdn.net",
  "fbsbx.com",
];

/**
 * Valida se uma URL de avatar é segura para renderização no navegador.
 * Rejeita esquemas não-HTTPS, credenciais, portas explícitas, base64 e URLs excessivamente longas.
 * Permite estritamente hosts de imagens oficiais do WhatsApp/Meta.
 */
export function safePhotoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    // Rejeita qualquer porta explícita (incluindo não-padrão ou redundante)
    if (url.port || /:\d+(?:[/?#]|$)/.test(trimmed)) return null;

    const hostname = url.hostname.toLowerCase();
    const isAllowedMetaCdn = ALLOWED_PHOTO_HOSTS.some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );

    if (!isAllowedMetaCdn) return null;

    return url.href;
  } catch {
    return null;
  }
}

/**
 * Extrai e normaliza um JID para fotos de contato, rejeitando grupos (@g.us) e LIDs (@lid).
 */
export function getPhotoJid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeJid(value);
  if (!normalized) return null;
  if (normalized.endsWith("@g.us") || normalized.endsWith("@lid") || !normalized.endsWith("@s.whatsapp.net")) {
    return null;
  }
  return normalized;
}
