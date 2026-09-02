import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

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

function isPrivateOrReservedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:") ||
      normalized.startsWith("::ffff:")
    );
  }
  return true;
}

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

type ResolvedAddress = { address: string; family: number };

type SafeResolution =
  | { ok: true; url: URL; addresses: ResolvedAddress[] }
  | { ok: false; reason: string };

async function resolvePublicHttpUrl(raw: string): Promise<SafeResolution> {
  const basic = assertPublicHttpUrl(raw);
  if (!basic.ok) return basic;

  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(hostname);
    const addresses = family
      ? [{ address: hostname, family }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      return { ok: false, reason: "host não pôde ser resolvido com segurança" };
    }
    if (
      process.env.ALLOW_PRIVATE_WEBHOOK_URLS !== "1" &&
      addresses.some(({ address }) => isPrivateOrReservedIp(address))
    ) {
      return { ok: false, reason: "DNS resolveu para IP privado ou reservado" };
    }
    return { ok: true, url, addresses };
  } catch {
    return { ok: false, reason: "host não pôde ser resolvido com segurança" };
  }
}

export async function assertPublicHttpUrlResolved(raw: string): Promise<UrlGuardResult> {
  const resolved = await resolvePublicHttpUrl(raw);
  return resolved.ok ? { ok: true } : resolved;
}

function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const requestedFamily = Number(options.family) || 0;
    const selected = addresses.find(({ family }) => !requestedFamily || family === requestedFamily) || addresses[0];
    callback(null, selected.address, selected.family);
  };
}

async function normalizeRequestBody(body: BodyInit | null | undefined): Promise<string | Uint8Array | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new TypeError("fetchPublicHttpUrl aceita body apenas como string, bytes, URLSearchParams ou Blob");
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export async function fetchPublicHttpUrl(raw: string, init: RequestInit = {}): Promise<Response> {
  const resolved = await resolvePublicHttpUrl(raw);
  if (!resolved.ok) throw new Error(`URL bloqueada por política de segurança (${resolved.reason})`);

  const headers = new Headers(init.headers);
  headers.delete("host");
  const body = await normalizeRequestBody(init.body);
  const request = resolved.url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<Response>((resolve, reject) => {
    const req = request(resolved.url, {
      method: init.method || "GET",
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(resolved.addresses),
      servername: resolved.url.hostname.replace(/^\[|\]$/g, ""),
      signal: init.signal || AbortSignal.timeout(15_000),
    }, (incoming) => {
      const status = incoming.statusCode || 500;
      if (status >= 300 && status < 400) {
        incoming.resume();
        resolve(new Response("Redirect bloqueado por política de segurança", { status: 502 }));
        return;
      }
      const stream = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(stream, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders(incoming),
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
