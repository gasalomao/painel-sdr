/**
 * Helpers para evitar SSRF em rotas que aceitam URLs/hosts do usuário (admin)
 * e fazem fetch contra eles. Bloqueia IPs privados, localhost e loopback.
 *
 * Use em qualquer rota que vá:
 *   - registrar webhook em URL controlada pelo cliente
 *   - probe Evolution / Cloud com URL passada pelo body
 *   - configurar proxy outbound
 */

/** True se o hostname é localhost ou IP de rede privada (RFC 1918 + loopback). */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim();
  if (!h) return true;
  if (h === "localhost" || h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^::1$/.test(h)) return true; // IPv6 loopback
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 ULA (fc00::/7)
  return false;
}

/** Bloqueia URL com host privado/localhost. Retorna URL parsed ou null. */
export function isPrivateOrLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return isPrivateOrLocalHost(u.hostname);
  } catch {
    return true; // URL inválida = trata como bloqueada
  }
}

/** Em produção exige HTTPS pública sem IP privado. Em dev/local tudo é permitido. */
export function isUrlSafeForProd(url: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return !isPrivateOrLocalHost(u.hostname);
  } catch {
    return false;
  }
}
