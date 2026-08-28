/**
 * Guard SSRF pra URLs que o servidor busca ativamente (webhooks custom de
 * tenant, tool web_fetch da IA). Valida scheme + hostname ANTES do fetch.
 *
 * Escopo (ponytail): validação por hostname — sem resolução DNS pós-redirect.
 * Um domínio público que redireciona pra IP privado ainda passa; mitigação
 * completa exige fetch com pin de IP. Upgrade: resolver DNS e validar IP
 * antes e após redirects (redirect: "manual" + revalidação).
 *
 * Escape hatch: ALLOW_PRIVATE_WEBHOOK_URLS=1 libera IPs privados (self-hosted
 * com n8n interno na mesma rede).
 */

const PRIVATE_V4 = [
  { re: /^127\./, name: "loopback" },
  { re: /^10\./, name: "privado" },
  { re: /^192\.168\./, name: "privado" },
  { re: /^172\.(1[6-9]|2\d|3[01])\./, name: "privado" },
  { re: /^169\.254\./, name: "link-local/metadata" },
  { re: /^0\./, name: "reservado" },
  { re: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, name: "CGNAT" },
];

export type UrlGuardResult = { ok: true } | { ok: false; reason: string };

export function assertPublicHttpUrl(raw: string): UrlGuardResult {
  const allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOK_URLS === "1";
  let u: URL;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return { ok: false, reason: "URL malformada" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `scheme não permitido: ${u.protocol}` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "URL com userinfo não permitida" };
  }
  if (allowPrivate) return { ok: true };

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: `host interno não permitido: ${host}` };
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return { ok: false, reason: `host IPv6 interno não permitido: ${host}` };
  }
  // IPv4 literal (hostname de URL numérica não resolve pra label)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    for (const p of PRIVATE_V4) {
      if (p.re.test(host)) return { ok: false, reason: `IP ${p.name} bloqueado: ${host}` };
    }
  }
  // Decimal/octal/hex IP encodings (ex: http://2130706433/) — new URL mantém
  // hostname numérico; Node só aceita dotted-quad, mas blinda por garantia.
  if (/^\d{8,}$/.test(host)) {
    return { ok: false, reason: "IP em formato numérico bloqueado" };
  }
  return { ok: true };
}
