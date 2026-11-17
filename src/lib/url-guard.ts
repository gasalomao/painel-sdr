/**
 * Helpers para evitar SSRF em rotas que aceitam URLs/hosts do usuário (admin)
 * e fazem fetch contra eles. Bloqueia IPs privados, localhost e loopback.
 *
 * Use em qualquer rota que vá:
 *   - registrar webhook em URL controlada pelo cliente
 *   - probe Evolution / Cloud com URL passada pelo body
 *   - configurar proxy outbound
 */

function parseIpv4Quad(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

function isPrivateIpv4(quad: [number, number, number, number]): boolean {
  const [a, b] = quad;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC 6598
  return false;
}

/** True se o hostname é localhost ou IP de rede privada (RFC 1918, loopback, IPv6 ULA/link-local/mapeado). */
export function isPrivateOrLocalHost(hostname: string): boolean {
  // URL.hostname preserva colchetes em IPv6 no Node (ex: "[::1]" / "[::ffff:7f00:1]")
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, "").split("%")[0];
  if (!h) return true;
  if (
    h === "localhost" ||
    h === "localhost." ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Quad(h);
  if (ipv4) return isPrivateIpv4(ipv4);

  // IPv6 loopback / unspecified (forma curta e expandida)
  if (h === "::1" || h === "::" || /^0+:0+:0+:0+:0+:0+:0+:[01]$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 ULA (fc00::/7)
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true; // IPv6 link-local (fe80::/10)

  // IPv4-mapped IPv6: "::ffff:127.0.0.1" ou forma hex "new URL()" -> "::ffff:7f00:1"
  if (h.startsWith("::ffff:")) {
    const rest = h.slice(7);
    const mappedV4 = parseIpv4Quad(rest);
    if (mappedV4) return isPrivateIpv4(mappedV4);
    const hexParts = rest.split(":");
    if (hexParts.length === 2 && hexParts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      return isPrivateIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
    }
    return true;
  }

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
