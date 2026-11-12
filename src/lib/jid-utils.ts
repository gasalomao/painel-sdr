/**
 * Normaliza qualquer telefone ou JID para o formato padrão do WhatsApp (@s.whatsapp.net).
 * Ex: "(11) 98765-4321" -> "5511987654321@s.whatsapp.net"
 *     "11987654321"     -> "5511987654321@s.whatsapp.net"
 *     "5511987654321@s.whatsapp.net" -> "5511987654321@s.whatsapp.net"
 */
export function normalizeJid(jidOrPhone?: string | null): string | null {
  if (typeof jidOrPhone !== "string") return null;
  const s = jidOrPhone.trim();
  if (/^\d+(?:-\d+)?@g\.us$/.test(s)) return s;
  const jid = /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/.exec(s);
  if (s.includes("@") && !jid) return null;
  if (!jid && !/^\+?[\d\s().-]+$/.test(s)) return null;
  let digits = jid ? jid[1] : s.replace(/\D/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  if (!jid && !s.startsWith("+") && (digits.length === 10 || digits.length === 11)) digits = "55" + digits;
  return `${digits}@s.whatsapp.net`;
}

/**
 * Extrai apenas os dígitos do telefone a partir de um JID ou string de telefone.
 */
export function extractDigits(jidOrPhone?: string | null): string {
  if (!jidOrPhone) return "";
  return String(jidOrPhone).replace(/@.*$/, "").replace(/\D/g, "");
}

/**
 * Retorna os dígitos do telefone e, para celulares brasileiros (DDI 55),
 * também a variação com/sem o 9º dígito após o DDD.
 */
export function getBrazilPhoneVariants(jidOrPhone?: string | null): string[] {
  const raw = extractDigits(jidOrPhone);
  if (raw.length < 8) return raw ? [raw] : [];

  const withCountry = (raw.length === 10 || raw.length === 11) ? `55${raw}` : raw;
  const variants = new Set<string>([raw, withCountry]);

  if (/^55[1-9]\d9[6-9]\d{7}$/.test(withCountry)) {
    variants.add(withCountry.slice(0, 4) + withCountry.slice(5));
  } else if (/^55[1-9]\d[6-9]\d{7}$/.test(withCountry)) {
    variants.add(`${withCountry.slice(0, 4)}9${withCountry.slice(4)}`);
  }

  return Array.from(variants);
}
