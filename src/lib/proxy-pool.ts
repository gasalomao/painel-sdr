/**
 * proxy-pool.ts — Pool Rotativo de Proxies BR (Webshare) com Lista Negra & Fail-Open para VPS.
 *
 * Garantias arquiteturais:
 * - Exclusividade 1:1 no Postgres (`uq_proxy_pool_assigned_instance` + `claim_next_proxy` com FOR UPDATE SKIP LOCKED);
 * - Enquanto um proxy estiver `assigned` a uma instância, nenhuma outra instância o utiliza;
 * - Proxies que falharam (`failed`), sofreram ban 401/403 (`banned`) ou já foram usados (`used`)
 *   entram na `blacklisted` e são ignorados nas próximas alocações do ciclo rotativo;
 * - Fail-open seguro para VPS padrão: se o pool vencer/acabar ou todos falharem, limpa o proxy da instância
 *   e segue operando pelo IP da VPS marcando `proxy_pending_rotation: true` para resgate automático ao subir novo `.txt`.
 */

import net from "node:net";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { setEvolutionGoProxy, removeEvolutionGoProxy } from "@/lib/providers/evolution-go";
import { isPrivateOrLocalHost } from "@/lib/url-guard";

export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";
export type ProxyPoolStatus = "available" | "assigned" | "blacklisted" | "retired";
export type ProxyBlacklistReason = "used" | "failed" | "banned" | "manual";
export type InstanceProxyMode = "pool_assigned" | "manual" | "vps_fallback" | "direct";

export interface ProxyPoolRecord {
  id: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username: string;
  password: string;
  provider_label: string;
  country_code: string;
  status: ProxyPoolStatus;
  blacklist_reason: ProxyBlacklistReason | null;
  blacklisted_at: string | null;
  assigned_instance: string | null;
  assigned_client_id: string | null;
  assigned_at: string | null;
  last_batch_id: string | null;
  fail_count: number;
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedProxyEntry {
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username: string;
  password: string;
}

export interface InvalidProxyLine {
  lineNumber: number;
  raw: string;
  reason: string;
}

export interface ParseProxyBatchResult {
  valid: ParsedProxyEntry[];
  invalid: InvalidProxyLine[];
  duplicateCount: number;
}

export interface ProxyPoolSettings {
  defaultProtocol: ProxyProtocol;
  warmupReserveCount: number;
  strikeThreshold: number;
  allowVpsFallback: boolean;
  verifyBeforeAssign: boolean;
  blockSharedVpsDomino: boolean;
}

export const DEFAULT_PROXY_POOL_SETTINGS: ProxyPoolSettings = {
  defaultProtocol: "http",
  warmupReserveCount: 0,
  strikeThreshold: 3,
  allowVpsFallback: true,
  verifyBeforeAssign: true,
  blockSharedVpsDomino: false,
};

export interface ProxyGeoIntel {
  countryCode: string | null;
  country: string | null;
  hosting: boolean;
  proxy?: boolean;
  mobile?: boolean;
  isp: string | null;
  checkedAt: number;
}

export type ProxyGeoProbe = (host: string) => Promise<ProxyGeoIntel | null>;

export interface InstanceProxySummary {
  auto_proxy: boolean;
  mode: InstanceProxyMode;
  protected: boolean;
  waiting_rotation: boolean;
  last_fallback_reason?: string | null;
  vps_shared_count?: number;
  vps_warning?: string | null;
  country_code?: string | null;
  is_datacenter?: boolean | null;
  geo_warning?: string | null;
}

export interface EnsureProxyResult {
  ok: boolean;
  mode: InstanceProxyMode;
  usedVpsFallback: boolean;
  proxyId?: string;
  host?: string;
  port?: number;
  protocol?: ProxyProtocol;
  reason?: string;
  vpsSharedCount?: number;
  vpsWarning?: string | null;
  countryCode?: string | null;
  isDatacenter?: boolean | null;
  isp?: string | null;
  geoWarning?: string | null;
}

export type ProxyConnectivityProbe = (
  proxy: ParsedProxyEntry,
  timeoutMs?: number,
) => Promise<{ ok: boolean; error?: string; authFailed?: boolean }>;

const VALID_PROTOCOLS = new Set<ProxyProtocol>(["http", "https", "socks4", "socks5"]);
const SETTINGS_KEY = "proxy_pool_settings";
const SETTINGS_TTL_MS = 15_000;
const POOL_CACHE_TTL_MS = 15_000;
const GEO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let _settingsCache: { value: ProxyPoolSettings; loadedAt: number } | null = null;
let _poolPresenceCache: { hasPool: boolean; availableCount: number; brHosts: Set<string>; loadedAt: number } | null = null;
const _geoIntelCache = new Map<string, ProxyGeoIntel>();

/** Invalida caches em memória de configurações, geo e hosts do pool. */
export function invalidateProxyPoolCache(): void {
  _settingsCache = null;
  _poolPresenceCache = null;
  _geoIntelCache.clear();
}

function isMissingProxyPoolError(err: unknown): boolean {
  const obj = err as { code?: string; message?: string; details?: string } | null;
  const code = String(obj?.code || "");
  const msg = `${obj?.message || ""} ${obj?.details || ""}`.toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    code === "42883" ||
    msg.includes("proxy_pool") && (msg.includes("does not exist") || msg.includes("could not find"))
  );
}

function normalizeProtocol(raw?: string | null, fallback: ProxyProtocol = "http"): ProxyProtocol {
  const clean = String(raw || "").trim().toLowerCase() as ProxyProtocol;
  return VALID_PROTOCOLS.has(clean) ? clean : fallback;
}

function isValidHostnameFormat(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return /^[a-z0-9.-]+$/i.test(host) && host.includes(".") && !host.startsWith(".") && !host.endsWith(".");
}

/**
 * Faz o parse e validação anti-SSRF de arquivos `.txt` do Webshare (`IP:PORTA:USER:SENHA`,
 * `protocol://user:pass@ip:porta`, ou `IP:PORTA`).
 */
export function parseWebshareProxyText(
  rawText: string,
  defaultProtocol: ProxyProtocol = "http",
): ParseProxyBatchResult {
  const lines = String(rawText || "").split(/\r?\n/);
  const seen = new Set<string>();
  const valid: ParsedProxyEntry[] = [];
  const invalid: InvalidProxyLine[] = [];
  let duplicateCount = 0;
  const fallbackProto = normalizeProtocol(defaultProtocol, "http");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("//")) continue;

    let protocol: ProxyProtocol = fallbackProto;
    let host = "";
    let portNum = 0;
    let username = "";
    let password = "";

    if (/^[a-z0-9]+:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        protocol = normalizeProtocol(parsed.protocol.replace(":", ""), fallbackProto);
        host = parsed.hostname.trim().toLowerCase();
        portNum = Number(parsed.port || 0);
        username = decodeURIComponent(parsed.username || "");
        password = decodeURIComponent(parsed.password || "");
      } catch {
        invalid.push({ lineNumber: i + 1, raw: raw.slice(0, 80), reason: "URL de proxy inválida" });
        continue;
      }
    } else if (raw.includes("@")) {
      const parts = raw.split("@");
      if (parts.length !== 2) {
        invalid.push({ lineNumber: i + 1, raw: raw.slice(0, 80), reason: "Formato user:pass@host:port inválido" });
        continue;
      }
      const [authPart, hostPart] = parts;
      const authSplitIdx = authPart.indexOf(":");
      if (authSplitIdx > -1) {
        username = authPart.slice(0, authSplitIdx).trim();
        password = authPart.slice(authSplitIdx + 1).trim();
      }
      const hostColonIdx = hostPart.lastIndexOf(":");
      host = hostColonIdx > -1 ? hostPart.slice(0, hostColonIdx).trim().toLowerCase() : "";
      portNum = hostColonIdx > -1 ? Number(hostPart.slice(hostColonIdx + 1).trim()) : 0;
    } else {
      const parts = raw.split(":");
      if (parts.length < 2) {
        invalid.push({ lineNumber: i + 1, raw: raw.slice(0, 80), reason: "Esperado IP:PORTA:USUARIO:SENHA" });
        continue;
      }
      host = parts[0].trim().toLowerCase();
      portNum = Number(parts[1].trim());
      if (parts.length >= 4) {
        username = parts[2].trim();
        password = parts.slice(3).join(":").trim();
      } else if (parts.length === 3) {
        username = parts[2].trim();
      }
    }

    if (!isValidHostnameFormat(host)) {
      invalid.push({ lineNumber: i + 1, raw: raw.slice(0, 80), reason: "Host/IP inválido" });
      continue;
    }

    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      invalid.push({ lineNumber: i + 1, raw: raw.slice(0, 80), reason: "Porta inválida (use 1-65535)" });
      continue;
    }

    if (isPrivateOrLocalHost(host)) {
      invalid.push({ lineNumber: i + 1, raw: raw.slice(0, 80), reason: "Host privado ou localhost bloqueado (SSRF)" });
      continue;
    }

    const endpointKey = `${host}:${portNum}`;
    if (seen.has(endpointKey)) {
      duplicateCount++;
      continue;
    }
    seen.add(endpointKey);

    valid.push({ host, port: portNum, protocol, username, password });
  }

  return { valid, invalid, duplicateCount };
}

/** Lê configurações globais do pool em `app_settings` com fallback seguro. */
export async function getProxyPoolSettings(): Promise<ProxyPoolSettings> {
  if (_settingsCache && Date.now() - _settingsCache.loadedAt < SETTINGS_TTL_MS) {
    return _settingsCache.value;
  }

  let next = { ...DEFAULT_PROXY_POOL_SETTINGS };
  try {
    if (supabaseAdmin && typeof supabaseAdmin.from === "function") {
      const res = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", SETTINGS_KEY)
        .maybeSingle();
      const raw = res?.data?.value;
      if (typeof raw === "string" && raw.trim().startsWith("{")) {
        const parsed = JSON.parse(raw) as Partial<ProxyPoolSettings>;
        next = {
          defaultProtocol: normalizeProtocol(parsed.defaultProtocol, "http"),
          warmupReserveCount: Math.max(0, Math.min(500, Math.round(Number(parsed.warmupReserveCount || 0)))),
          strikeThreshold: Math.max(1, Math.min(10, Math.round(Number(parsed.strikeThreshold || 3)))),
          allowVpsFallback: parsed.allowVpsFallback !== false,
          verifyBeforeAssign: parsed.verifyBeforeAssign !== false,
          blockSharedVpsDomino: Boolean(parsed.blockSharedVpsDomino),
        };
      }
    }
  } catch {
    // fallback silencioso aos padrões
  }

  _settingsCache = { value: next, loadedAt: Date.now() };
  return next;
}

/** Salva configurações globais do pool de proxies. */
export async function saveProxyPoolSettings(
  patch: Partial<ProxyPoolSettings>,
): Promise<ProxyPoolSettings> {
  const current = await getProxyPoolSettings();
  const next: ProxyPoolSettings = {
    defaultProtocol: patch.defaultProtocol
      ? normalizeProtocol(patch.defaultProtocol, current.defaultProtocol)
      : current.defaultProtocol,
    warmupReserveCount:
      patch.warmupReserveCount !== undefined
        ? Math.max(0, Math.min(500, Math.round(Number(patch.warmupReserveCount) || 0)))
        : current.warmupReserveCount,
    strikeThreshold:
      patch.strikeThreshold !== undefined
        ? Math.max(1, Math.min(10, Math.round(Number(patch.strikeThreshold) || 3)))
        : current.strikeThreshold,
    allowVpsFallback: patch.allowVpsFallback !== undefined ? Boolean(patch.allowVpsFallback) : current.allowVpsFallback,
    verifyBeforeAssign:
      patch.verifyBeforeAssign !== undefined ? Boolean(patch.verifyBeforeAssign) : current.verifyBeforeAssign,
    blockSharedVpsDomino:
      patch.blockSharedVpsDomino !== undefined
        ? Boolean(patch.blockSharedVpsDomino)
        : current.blockSharedVpsDomino,
  };

  if (supabaseAdmin && typeof supabaseAdmin.from === "function") {
    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: SETTINGS_KEY,
          value: JSON.stringify(next),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      );
  }
  _settingsCache = { value: next, loadedAt: Date.now() };
  return next;
}

/**
 * Executa um probe rápido TCP/HTTP-CONNECT/SOCKS5 para detectar IPs mortos ou credenciais Webshare
 * vencidas (`407`) antes de vinculá-los a uma sessão ativa da Evolution.
 */
export async function testProxyEndpointConnectivity(
  proxy: ParsedProxyEntry,
  timeoutMs: number = 2500,
): Promise<{ ok: boolean; error?: string; authFailed?: boolean }> {
  if (isPrivateOrLocalHost(proxy.host)) {
    return { ok: false, error: "Host privado bloqueado" };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: { ok: boolean; error?: string; authFailed?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(res);
    };

    const socket = net.createConnection({ host: proxy.host, port: proxy.port });
    const timer = setTimeout(() => {
      finish({ ok: false, error: `Timeout (${timeoutMs}ms) conectando ao proxy ${proxy.host}:${proxy.port}` });
    }, timeoutMs);

    socket.once("error", (err) => {
      finish({ ok: false, error: err?.message || "Erro TCP no proxy" });
    });

    socket.once("connect", () => {
      if (proxy.protocol === "http" || proxy.protocol === "https") {
        const authHeader =
          proxy.username || proxy.password
            ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`
            : "";
        socket.write(
          `CONNECT web.whatsapp.com:443 HTTP/1.1\r\nHost: web.whatsapp.com:443\r\n${authHeader}Connection: close\r\n\r\n`,
        );
        socket.once("data", (chunk) => {
          const line = chunk.toString("utf8").split("\r\n")[0] || "";
          if (/^HTTP\/1\.[01]\s+200\b/i.test(line)) {
            finish({ ok: true });
          } else if (/\b407\b/.test(line)) {
            finish({ ok: false, authFailed: true, error: `Credencial proxy expirada/inválida (${line.trim()})` });
          } else {
            finish({ ok: false, error: `Resposta proxy inesperada: ${line.trim() || "vazia"}` });
          }
        });
        return;
      }

      if (proxy.protocol === "socks5") {
        const methods = proxy.username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
        socket.write(methods);
        let stage: "greeting" | "auth" = "greeting";
        socket.on("data", (chunk) => {
          if (stage === "greeting") {
            if (chunk.length < 2 || chunk[0] !== 0x05 || chunk[1] === 0xff) {
              finish({ ok: false, error: "Handshake SOCKS5 recusado pelo proxy" });
              return;
            }
            if (chunk[1] === 0x00) {
              finish({ ok: true });
              return;
            }
            if (chunk[1] === 0x02) {
              stage = "auth";
              const uBuf = Buffer.from(proxy.username || "", "utf8").subarray(0, 255);
              const pBuf = Buffer.from(proxy.password || "", "utf8").subarray(0, 255);
              const authPacket = Buffer.concat([
                Buffer.from([0x01, uBuf.length]),
                uBuf,
                Buffer.from([pBuf.length]),
                pBuf,
              ]);
              socket.write(authPacket);
              return;
            }
            finish({ ok: false, error: "Método de autenticação SOCKS5 não suportado" });
          } else {
            if (chunk.length >= 2 && chunk[1] === 0x00) {
              finish({ ok: true });
            } else {
              finish({ ok: false, authFailed: true, error: "Autenticação SOCKS5 rejeitada" });
            }
          }
        });
        return;
      }

      finish({ ok: true });
    });
  });
}

async function mapPoolConcurrency<T, R>(
  items: T[],
  concurrency: number,
  delayBetweenBatchesMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const step = Math.max(1, concurrency);
  for (let i = 0; i < items.length; i += step) {
    const batch = items.slice(i, i + step);
    const batchResults = await Promise.all(batch.map((item) => fn(item)));
    results.push(...batchResults);
    if (delayBetweenBatchesMs > 0 && i + step < items.length) {
      await new Promise((r) => setTimeout(r, delayBetweenBatchesMs));
    }
  }
  return results;
}

/**
 * Consulta paginada em `proxy_pool` sem estourar o teto padrão de 1.000 linhas do PostgREST.
 */
async function fetchAllActivePoolRows(): Promise<ProxyPoolRecord[]> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") return [];
  const pageSize = 1000;
  const rows: ProxyPoolRecord[] = [];
  for (let from = 0; from < 20_000; from += pageSize) {
    const q = supabaseAdmin
      .from("proxy_pool")
      .select("*")
      .neq("status", "retired")
      .order("created_at", { ascending: true });
    const res =
      typeof (q as unknown as { range?: unknown }).range === "function"
        ? await q.range(from, from + pageSize - 1)
        : await q;
    if (res.error) {
      if (isMissingProxyPoolError(res.error)) return [];
      throw new Error(res.error.message || "Falha ao ler pool de proxies");
    }
    const batch = (res.data || []) as ProxyPoolRecord[];
    rows.push(...batch);
    if (batch.length < pageSize || typeof (q as unknown as { range?: unknown }).range !== "function") {
      break;
    }
  }
  return rows;
}

/**
 * Verifica se um registro do `proxy_pool` foi comprovadamente validado como residencial/4G brasileiro
 * (nunca assume cegamente que qualquer linha importada do Webshare é IP residencial BR limpo).
 */
export function isVerifiedCleanBrResidentialRow(row: {
  country_code?: string | null;
  provider_label?: string | null;
}): boolean {
  const cc = String(row.country_code || "").trim().toUpperCase();
  const label = String(row.provider_label || "").trim().toLowerCase();
  if (cc !== "BR") return false;
  if (label.includes("datacenter") || label.includes("hosting") || label.includes("foreign") || label.includes("unverified")) {
    return false;
  }
  return label.includes("residential") || label.includes("mobile") || label.includes("4g") || label.includes("isp_br");
}

export function formatHonestProviderLabel(intel: ProxyGeoIntel | null, baseProvider = "webshare"): string {
  if (!intel) return `${baseProvider}:unverified`;
  const cc = String(intel.countryCode || "").toUpperCase();
  if (intel.hosting || intel.proxy) {
    return cc && cc !== "BR" ? `${baseProvider}:foreign_datacenter` : `${baseProvider}:datacenter`;
  }
  if (cc && cc !== "BR") {
    return `${baseProvider}:foreign`;
  }
  if (cc === "BR") {
    return intel.mobile ? `${baseProvider}:br_mobile` : `${baseProvider}:br_residential`;
  }
  return `${baseProvider}:unverified`;
}

/**
 * Monta alerta honesto em português quando o proxy é de datacenter/hosting/proxy ASN
 * ou está fora do Brasil (divergência geográfica para chip +55).
 */
export function buildProxyGeoWarning(
  host: string,
  intel: { countryCode?: string | null; country?: string | null; hosting?: boolean | null; proxy?: boolean | null; isp?: string | null } | null,
  fallbackRow?: { country_code?: string | null; provider_label?: string | null } | null
): { warning: string | null; isDatacenter: boolean | null; countryCode: string | null } {
  const warnings: string[] = [];
  let countryCode: string | null = null;
  let isDatacenter: boolean | null = null;

  if (intel) {
    countryCode = intel.countryCode ? String(intel.countryCode).toUpperCase() : null;
    isDatacenter = Boolean(intel.hosting || intel.proxy);
    if (countryCode && countryCode !== "BR") {
      warnings.push(
        `Proxy localizado fora do Brasil (${intel.country || countryCode}) — divergência geográfica para chip +55.`
      );
    }
    if (intel.hosting || intel.proxy) {
      warnings.push(
        `Proxy em Datacenter/ASN (${intel.isp || host}) — risco elevado de flapping 428 e bloqueio 401; prefira IP residencial/4G brasileiro.`
      );
    }
  } else if (fallbackRow) {
    const cc = String(fallbackRow.country_code || "").trim().toUpperCase();
    const label = String(fallbackRow.provider_label || "").trim().toLowerCase();
    countryCode = cc && cc !== "UNVERIFIED" ? cc : null;
    if (label.includes("datacenter") || label.includes("hosting")) {
      isDatacenter = true;
      warnings.push(
        `Proxy marcado como Datacenter/ASN (${host}) — prefira IP residencial/4G brasileiro para escalar prospecção fria.`
      );
    } else if (label.includes("residential") || label.includes("mobile")) {
      isDatacenter = false;
    }
    if (countryCode && countryCode !== "BR") {
      warnings.push(
        `Proxy registrado fora do Brasil (${countryCode}) — divergência geográfica para chip +55.`
      );
    }
  }

  return {
    warning: warnings.length > 0 ? warnings.join(" | ") : null,
    isDatacenter,
    countryCode,
  };
}

/**
 * Consulta Geo/ASN real de um host de proxy via ip-api.com com cache de 6h.
 * Em ambiente de teste (Vitest), retorna `null` salvo se `geoProbeFn` ou `forceInTests` for passado.
 */
export async function inspectProxyGeoAsn(
  host: string,
  opts?: { geoProbeFn?: ProxyGeoProbe; forceInTests?: boolean }
): Promise<ProxyGeoIntel | null> {
  const cleanHost = String(host || "").trim().toLowerCase();
  if (!cleanHost || isPrivateOrLocalHost(cleanHost)) return null;

  if (opts?.geoProbeFn) {
    const probed = await opts.geoProbeFn(cleanHost).catch(() => null);
    if (probed) _geoIntelCache.set(cleanHost, probed);
    return probed;
  }

  const now = Date.now();
  const cached = _geoIntelCache.get(cleanHost);
  if (cached && now - cached.checkedAt < GEO_CACHE_TTL_MS) {
    return cached;
  }

  if (!opts?.forceInTests && (process.env.VITEST === "true" || process.env.NODE_ENV === "test")) {
    return null;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = (await fetch(
      `http://ip-api.com/json/${encodeURIComponent(cleanHost)}?fields=status,countryCode,country,hosting,proxy,mobile,isp`,
      { signal: ctrl.signal }
    )
      .then((r) => r.json())
      .catch(() => null)) as {
      status?: string;
      countryCode?: string;
      country?: string;
      hosting?: boolean;
      proxy?: boolean;
      mobile?: boolean;
      isp?: string;
    } | null;
    clearTimeout(timer);

    if (res?.status === "success") {
      const entry: ProxyGeoIntel = {
        countryCode: res.countryCode ? String(res.countryCode).toUpperCase() : null,
        country: res.country ? String(res.country) : null,
        hosting: Boolean(res.hosting),
        proxy: Boolean(res.proxy),
        mobile: Boolean(res.mobile),
        isp: res.isp ? String(res.isp) : null,
        checkedAt: now,
      };
      if (_geoIntelCache.size > 500) _geoIntelCache.clear();
      _geoIntelCache.set(cleanHost, entry);
      return entry;
    }
  } catch {
    /* lookup best-effort */
  }
  return null;
}

/**
 * Conta quantas OUTRAS instâncias não-Cloud já estão operando sem proxy dedicado (usando o IP da VPS),
 * permitindo alertar sobre risco real de compartilhamento de IP / banimento em dominó.
 */
export async function countInstancesUsingVpsIp(
  excludeInstanceName?: string
): Promise<{ vpsSharedCount: number; vpsSharedInstances: string[] }> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    return { vpsSharedCount: 0, vpsSharedInstances: [] };
  }
  try {
    const { data: conns } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, provider, status, provider_config");

    const assignedInstances = new Set<string>();
    try {
      const { data: assignedRows } = await supabaseAdmin
        .from("proxy_pool")
        .select("assigned_instance")
        .eq("status", "assigned");
      for (const r of (assignedRows || []) as Array<{ assigned_instance?: string | null }>) {
        if (r?.assigned_instance) assignedInstances.add(String(r.assigned_instance));
      }
    } catch {
      /* tabela opcional */
    }

    const shared: string[] = [];
    for (const c of (conns || []) as Array<{
      instance_name?: string | null;
      provider?: string | null;
      status?: string | null;
      provider_config?: Record<string, unknown> | null;
    }>) {
      const name = String(c?.instance_name || "").trim();
      if (!name || name === excludeInstanceName) continue;
      if (c.provider === "whatsapp_cloud") continue;
      const cfg = (c.provider_config || {}) as Record<string, unknown>;
      const mode = String(cfg.proxy_mode || "");
      const hasDedicatedProxy =
        mode === "pool_assigned" || mode === "manual" || assignedInstances.has(name);
      if (!hasDedicatedProxy) {
        shared.push(name);
      }
    }

    return { vpsSharedCount: shared.length, vpsSharedInstances: shared };
  } catch {
    return { vpsSharedCount: 0, vpsSharedInstances: [] };
  }
}

/**
 * Retorna a quantidade de proxies atualmente livres (`available`) no pool.
 */
export async function getAvailableProxyCount(): Promise<number> {
  const overview = await getProxyPoolOverviewCache();
  return overview.availableCount;
}

/**
 * Indica se há ao menos 1 proxy livre (`available`) pronto para alocação imediata.
 */
export async function hasAvailablePoolProxies(): Promise<boolean> {
  return (await getAvailableProxyCount()) > 0;
}

/**
 * Verifica se existe algum pool configurado e devolve apenas hosts comprovadamente
 * residenciais/4G BR em `brHosts` (nunca esconde datacenter/estrangeiros nem linhas não verificadas).
 */
export async function getProxyPoolOverviewCache(): Promise<{
  hasPool: boolean;
  availableCount: number;
  brHosts: Set<string>;
}> {
  if (_poolPresenceCache && Date.now() - _poolPresenceCache.loadedAt < POOL_CACHE_TTL_MS) {
    return {
      hasPool: _poolPresenceCache.hasPool,
      availableCount: _poolPresenceCache.availableCount,
      brHosts: _poolPresenceCache.brHosts,
    };
  }

  const brHosts = new Set<string>();
  let hasPool = false;
  let availableCount = 0;

  try {
    if (supabaseAdmin && typeof supabaseAdmin.from === "function") {
      const q = supabaseAdmin
        .from("proxy_pool")
        .select("host, country_code, provider_label, status")
        .neq("status", "retired")
        .limit(2000);
      const res = await q;
      if (!res?.error && Array.isArray(res?.data) && res.data.length > 0) {
        hasPool = true;
        for (const r of res.data as Array<{
          host?: string;
          country_code?: string;
          provider_label?: string;
          status?: string;
        }>) {
          if (r.status === "available") availableCount++;
          if (r.host && isVerifiedCleanBrResidentialRow(r)) {
            brHosts.add(String(r.host).trim().toLowerCase());
          }
        }
      }
    }
  } catch {
    // fail-safe em mocks sem tabela proxy_pool
  }

  _poolPresenceCache = { hasPool, availableCount, brHosts, loadedAt: Date.now() };
  return { hasPool, availableCount, brHosts };
}

async function resolveConnectionProviderInfo(
  instanceName: string,
  clientId?: string | null,
): Promise<{
  provider: string;
  clientId: string | null;
  providerConfig: Record<string, unknown>;
} | null> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") return null;
  try {
    let q = supabaseAdmin
      .from("channel_connections")
      .select("client_id, provider, provider_config")
      .eq("instance_name", instanceName);
    if (clientId) q = q.eq("client_id", clientId);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return {
      provider: String((data as { provider?: string }).provider || "evolution"),
      clientId: (data as { client_id?: string | null }).client_id || null,
      providerConfig: ((data as { provider_config?: Record<string, unknown> }).provider_config || {}) as Record<
        string,
        unknown
      >,
    };
  } catch {
    return null;
  }
}

async function patchInstanceConnectionProxyMeta(
  instanceName: string,
  clientId: string | null | undefined,
  metaPatch: {
    auto_proxy?: boolean;
    proxy_mode?: InstanceProxyMode;
    proxy_pending_rotation?: boolean;
    proxy_last_fallback_at?: string | null;
    proxy_last_error?: string | null;
    proxy_pool_id?: string | null;
    proxy_vps_shared_count?: number | null;
    proxy_vps_warning?: string | null;
    proxy_country_code?: string | null;
    proxy_is_datacenter?: boolean | null;
    proxy_isp?: string | null;
    proxy_geo_warning?: string | null;
  },
): Promise<void> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") return;
  try {
    const cur = await resolveConnectionProviderInfo(instanceName, clientId);
    if (!cur) return;
    const merged: Record<string, unknown> = { ...cur.providerConfig };
    for (const [k, v] of Object.entries(metaPatch)) {
      if (v === undefined) continue;
      merged[k] = v;
    }
    let upd = supabaseAdmin.from("channel_connections").update({ provider_config: merged }).eq("instance_name", instanceName);
    const targetClient = clientId || cur.clientId;
    if (targetClient) upd = upd.eq("client_id", targetClient);
    await upd;
  } catch {
    // best-effort metadata update
  }
}

/**
 * Aplica proxy na instância usando o provedor correto (`evolution` v2 ou `evolution_go`).
 */
export async function applyProxyToProvider(
  instanceName: string,
  proxy: {
    host: string;
    port: number | string;
    protocol: ProxyProtocol;
    username?: string;
    password?: string;
  },
  providerHint?: string,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  let provider = providerHint || "";
  if (!provider) {
    const info = await resolveConnectionProviderInfo(instanceName);
    provider = info?.provider || "evolution";
  }

  if (provider === "whatsapp_cloud") {
    return { ok: true, skipped: true };
  }

  try {
    if (provider === "evolution_go") {
      await setEvolutionGoProxy(instanceName, {
        enabled: true,
        host: proxy.host,
        port: String(proxy.port),
        protocol: proxy.protocol,
        username: proxy.username || "",
        password: proxy.password || "",
      });
    } else {
      await evolution.setProxy(instanceName, {
        enabled: true,
        host: proxy.host,
        port: String(proxy.port),
        protocol: proxy.protocol,
        username: proxy.username || "",
        password: proxy.password || "",
      });
    }
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Remove proxy da instância na Evolution (volta para o IP padrão da VPS).
 */
export async function removeProxyFromProvider(instanceName: string, providerHint?: string): Promise<void> {
  let provider = providerHint || "";
  if (!provider) {
    const info = await resolveConnectionProviderInfo(instanceName);
    provider = info?.provider || "evolution";
  }
  if (provider === "whatsapp_cloud") return;
  try {
    if (provider === "evolution_go") {
      await removeEvolutionGoProxy(instanceName);
    } else {
      await evolution.removeProxy(instanceName);
    }
  } catch {
    // best-effort: não impede fallback nem deleção
  }
}

/**
 * Score de prioridade para seleção de proxy no pool:
 * 0 = BR Residencial / 4G validado
 * 1 = Geo ainda não auditado / neutro
 * 2 = Datacenter/Hosting ou estrangeiro (menor prioridade)
 */
function scoreProxyPoolPriority(row: {
  country_code?: string | null;
  provider_label?: string | null;
}): number {
  if (isVerifiedCleanBrResidentialRow(row)) return 0;
  const cc = String(row.country_code || "").trim().toUpperCase();
  const label = String(row.provider_label || "").trim().toLowerCase();
  if (label.includes("datacenter") || label.includes("hosting") || label.includes("foreign") || (cc && cc !== "BR" && cc !== "UNVERIFIED")) {
    return 2;
  }
  return 1;
}

/**
 * Identifica proxies enviados à Lista Negra apenas por erro transitório 428
 * (não por ban 401/403 real ou erro 407 de credencial).
 */
export function isFalse428BlacklistRow(row: {
  blacklist_reason?: string | null;
  last_error?: string | null;
}): boolean {
  const err = String(row.last_error || "");
  if (!err) return false;
  if (/\b(401|403|407)\b|ban|logged.?out/i.test(err)) return false;
  return /\b428\b|connection.?closed|precondition/i.test(err);
}

/**
 * Claim atômico de 1 proxy disponível para `instanceName` (exclusivo 1:1).
 * Prioriza IPs BR residenciais/ISP validados antes de cair em datacenter;
 * usa RPC SQL com `FOR UPDATE SKIP LOCKED` e fallback Compare-And-Set.
 */
async function claimNextAvailableProxyRow(params: {
  instanceName: string;
  clientId?: string | null;
  reserveForWarmup: number;
  forWarmup: boolean;
}): Promise<{ row: ProxyPoolRecord | null; missingTable?: boolean }> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    return { row: null };
  }

  const { instanceName, clientId = null, reserveForWarmup, forWarmup } = params;

  // 0) Prioridade residencial BR: se já há proxy auditado como br_residential/br_mobile disponível,
  // faz claim atômico CAS nele antes do RPC FIFO genérico.
  try {
    const existingCheck = await supabaseAdmin
      .from("proxy_pool")
      .select("*")
      .eq("assigned_instance", instanceName)
      .eq("status", "assigned")
      .maybeSingle();
    if (existingCheck?.data) {
      return { row: existingCheck.data as ProxyPoolRecord };
    }

    let reserveAllows = true;
    if (!forWarmup && reserveForWarmup > 0) {
      const countRes = await supabaseAdmin
        .from("proxy_pool")
        .select("id", { count: "exact", head: true })
        .eq("status", "available");
      if (Number(countRes?.count || 0) <= reserveForWarmup) {
        reserveAllows = false;
      }
    }

    if (reserveAllows) {
      const brRes = await supabaseAdmin
        .from("proxy_pool")
        .select("*")
        .eq("status", "available")
        .eq("country_code", "BR")
        .order("created_at", { ascending: true })
        .limit(25);
      const residentialCandidates = ((brRes?.data || []) as ProxyPoolRecord[]).filter((r) =>
        isVerifiedCleanBrResidentialRow(r),
      );
      for (const cand of residentialCandidates.slice(0, 5)) {
        const nowIso = new Date().toISOString();
        const updRes = await supabaseAdmin
          .from("proxy_pool")
          .update({
            status: "assigned",
            assigned_instance: instanceName,
            assigned_client_id: clientId,
            assigned_at: nowIso,
            updated_at: nowIso,
          })
          .eq("id", cand.id)
          .eq("status", "available")
          .select("*")
          .maybeSingle();
        if (updRes?.data) {
          invalidateProxyPoolCache();
          return { row: updRes.data as ProxyPoolRecord };
        }
      }
    }
  } catch {
    /* segue para RPC/CAS padrão */
  }

  // 1) Tenta RPC atômico no Postgres
  if (typeof (supabaseAdmin as unknown as { rpc?: unknown }).rpc === "function") {
    try {
      const rpcRes = await supabaseAdmin.rpc("claim_next_proxy", {
        p_instance_name: instanceName,
        p_client_id: clientId,
        p_reserve_for_warmup: reserveForWarmup,
        p_for_warmup: forWarmup,
      });
      if (!rpcRes?.error) {
        const list = Array.isArray(rpcRes?.data)
          ? (rpcRes.data as ProxyPoolRecord[])
          : rpcRes?.data
            ? [rpcRes.data as ProxyPoolRecord]
            : [];
        return { row: list[0] || null };
      }
      if (isMissingProxyPoolError(rpcRes.error)) {
        // Fallback CAS se a função ainda não existir ou for ambiente mockado
      }
    } catch {
      // Fallback CAS
    }
  }

  // 2) Fallback Compare-And-Set no Postgres / mocks (ordenando residencial BR -> não auditado -> datacenter)
  try {
    const existingRes = await supabaseAdmin
      .from("proxy_pool")
      .select("*")
      .eq("assigned_instance", instanceName)
      .eq("status", "assigned")
      .maybeSingle();

    if (existingRes.error && isMissingProxyPoolError(existingRes.error)) {
      return { row: null, missingTable: true };
    }
    if (existingRes.data) {
      return { row: existingRes.data as ProxyPoolRecord };
    }

    if (!forWarmup && reserveForWarmup > 0) {
      const countRes = await supabaseAdmin
        .from("proxy_pool")
        .select("id", { count: "exact", head: true })
        .eq("status", "available");
      const availCount = Number(countRes.count || 0);
      if (availCount <= reserveForWarmup) {
        return { row: null };
      }
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const candRes = await supabaseAdmin
        .from("proxy_pool")
        .select("*")
        .eq("status", "available")
        .order("created_at", { ascending: true })
        .limit(25);

      const candidates = ((candRes.data as ProxyPoolRecord[] | null) || [])
        .slice()
        .sort((a, b) => scoreProxyPoolPriority(a) - scoreProxyPoolPriority(b));
      const candidate = candidates[0];
      if (!candidate) return { row: null };

      const nowIso = new Date().toISOString();
      const updRes = await supabaseAdmin
        .from("proxy_pool")
        .update({
          status: "assigned",
          assigned_instance: instanceName,
          assigned_client_id: clientId,
          assigned_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", candidate.id)
        .eq("status", "available")
        .select("*")
        .maybeSingle();

      if (updRes.data) {
        invalidateProxyPoolCache();
        return { row: updRes.data as ProxyPoolRecord };
      }

      if (updRes.error && String(updRes.error.code || "") === "23505") {
        // Outra concorrência vinculou esta mesma instância primeiro — devolve o vencedor
        const winnerRes = await supabaseAdmin
          .from("proxy_pool")
          .select("*")
          .eq("assigned_instance", instanceName)
          .eq("status", "assigned")
          .maybeSingle();
        if (winnerRes.data) return { row: winnerRes.data as ProxyPoolRecord };
      }
    }
  } catch (err) {
    if (isMissingProxyPoolError(err)) return { row: null, missingTable: true };
  }

  return { row: null };
}

/**
 * Move o proxy atualmente vinculado à instância para a Lista Negra (`blacklisted`),
 * liberando `assigned_instance` sem jamais devolvê-lo para `available`.
 */
export async function blacklistInstanceProxy(
  instanceName: string,
  reason: ProxyBlacklistReason = "used",
  errorMessage?: string | null,
): Promise<ProxyPoolRecord | null> {
  if (!instanceName || !supabaseAdmin || typeof supabaseAdmin.from !== "function") return null;

  if (typeof (supabaseAdmin as unknown as { rpc?: unknown }).rpc === "function") {
    try {
      const rpcRes = await supabaseAdmin.rpc("blacklist_instance_proxy", {
        p_instance_name: instanceName,
        p_reason: reason,
        p_error: errorMessage || null,
      });
      if (!rpcRes?.error) {
        invalidateProxyPoolCache();
        const list = Array.isArray(rpcRes?.data)
          ? (rpcRes.data as ProxyPoolRecord[])
          : rpcRes?.data
            ? [rpcRes.data as ProxyPoolRecord]
            : [];
        return list[0] || null;
      }
    } catch {
      // Fallback para update direto
    }
  }

  try {
    const nowIso = new Date().toISOString();
    const { data: existing } = await supabaseAdmin
      .from("proxy_pool")
      .select("*")
      .eq("assigned_instance", instanceName)
      .eq("status", "assigned")
      .maybeSingle();
    if (!existing) return null;

    const currentRow = existing as ProxyPoolRecord;
    const nextFails =
      reason === "failed" || reason === "banned" ? Number(currentRow.fail_count || 0) + 1 : Number(currentRow.fail_count || 0);

    const { data: updated } = await supabaseAdmin
      .from("proxy_pool")
      .update({
        status: "blacklisted",
        blacklist_reason: reason,
        blacklisted_at: nowIso,
        assigned_instance: null,
        assigned_client_id: null,
        fail_count: nextFails,
        last_error: errorMessage ? String(errorMessage).slice(0, 300) : currentRow.last_error,
        updated_at: nowIso,
      })
      .eq("id", currentRow.id)
      .eq("status", "assigned")
      .select("*")
      .maybeSingle();

    invalidateProxyPoolCache();
    return (updated as ProxyPoolRecord | null) || null;
  } catch {
    return null;
  }
}

async function blacklistProxyById(
  proxyId: string,
  reason: ProxyBlacklistReason,
  errorMessage?: string | null,
): Promise<void> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") return;
  try {
    const nowIso = new Date().toISOString();
    const { data: cur } = await supabaseAdmin
      .from("proxy_pool")
      .select("fail_count")
      .eq("id", proxyId)
      .maybeSingle();
    const prevFails = Number((cur as { fail_count?: number } | null)?.fail_count || 0);
    await supabaseAdmin
      .from("proxy_pool")
      .update({
        status: "blacklisted",
        blacklist_reason: reason,
        blacklisted_at: nowIso,
        assigned_instance: null,
        assigned_client_id: null,
        fail_count: prevFails + (reason === "failed" || reason === "banned" ? 1 : 0),
        last_error: errorMessage ? String(errorMessage).slice(0, 300) : null,
        last_checked_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", proxyId);
    invalidateProxyPoolCache();
  } catch {
    // non-fatal
  }
}

/**
 * Fallback seguro (Fail-open) para o IP padrão da VPS quando não há proxy saudável no pool.
 * Remove proxy quebrado na Evolution, reporta quantas outras instâncias já dividem o IP da VPS
 * (`vpsSharedCount`) e marca `proxy_pending_rotation = true` para resgate futuro.
 */
export async function fallbackInstanceToVps(
  instanceName: string,
  clientId?: string | null,
  reason: string = "Sem proxy disponível — operando no IP padrão da VPS",
  providerHint?: string,
): Promise<{ vpsSharedCount: number; vpsSharedInstances: string[]; warning: string | null }> {
  await removeProxyFromProvider(instanceName, providerHint);
  const { vpsSharedCount, vpsSharedInstances } = await countInstancesUsingVpsIp(instanceName);
  const warning =
    vpsSharedCount > 0
      ? `IP da VPS já compartilhado com ${vpsSharedCount} outra(s) instância(s) (${vpsSharedInstances.slice(0, 3).join(", ")}${vpsSharedCount > 3 ? "…" : ""}) — risco de correlação de IP/banimento em dominó. Suba novos proxies BR residenciais no pool.`
      : null;
  const fullReason = warning ? `${reason} · ${warning}` : reason;

  await patchInstanceConnectionProxyMeta(instanceName, clientId, {
    auto_proxy: true,
    proxy_mode: "vps_fallback",
    proxy_pending_rotation: true,
    proxy_last_fallback_at: new Date().toISOString(),
    proxy_last_error: String(fullReason).slice(0, 280),
    proxy_pool_id: null,
    proxy_vps_shared_count: vpsSharedCount,
    proxy_vps_warning: warning,
    proxy_country_code: null,
    proxy_is_datacenter: null,
    proxy_isp: null,
    proxy_geo_warning: null,
  });

  return { vpsSharedCount, vpsSharedInstances, warning };
}

/**
 * Garante 1 proxy exclusivo do pool para a instância informada (usado em `/whatsapp` quando `autoProxy=true`
 * e no Aquecedor sempre automaticamente). Nunca propaga falha fatal caso o pool vença ou acabe.
 */
export async function ensureProxyForInstance(params: {
  instanceName: string;
  clientId?: string | null;
  reason: "connect" | "warmup" | "rotation" | "manual_auto";
  forWarmup?: boolean;
  providerHint?: string;
  probeFn?: ProxyConnectivityProbe;
  geoProbeFn?: ProxyGeoProbe;
  forceProbeInTests?: boolean;
  forceGeoInTests?: boolean;
  maxAttempts?: number;
}): Promise<EnsureProxyResult> {
  const {
    instanceName,
    clientId = null,
    reason,
    forWarmup = reason === "warmup",
    providerHint,
    probeFn,
    geoProbeFn,
    forceProbeInTests = false,
    forceGeoInTests = false,
    maxAttempts = 3,
  } = params;

  if (!instanceName) {
    return { ok: false, mode: "direct", usedVpsFallback: false, reason: "instanceName vazio" };
  }

  const connInfo = await resolveConnectionProviderInfo(instanceName, clientId);
  const provider = providerHint || connInfo?.provider || "evolution";
  if (provider === "whatsapp_cloud") {
    return { ok: true, mode: "direct", usedVpsFallback: false, reason: "WhatsApp Cloud não usa proxy" };
  }

  const overview = await getProxyPoolOverviewCache();
  const explicitAuto = Boolean(connInfo?.providerConfig?.auto_proxy);
  const effectiveClientId = clientId || connInfo?.clientId || null;

  // Se nenhum pool foi cadastrado ainda no sistema e o caller é apenas check de warmup, não altera nada.
  if (!overview.hasPool && !explicitAuto && reason === "warmup") {
    return { ok: true, mode: "direct", usedVpsFallback: false, reason: "Pool de proxies não configurado" };
  }

  const settings = await getProxyPoolSettings();
  const isVitest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const shouldProbe = Boolean(probeFn) || (settings.verifyBeforeAssign && (!isVitest || forceProbeInTests));
  const activeProbe: ProxyConnectivityProbe = probeFn || testProxyEndpointConnectivity;

  const triedErrors: string[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const claimed = await claimNextAvailableProxyRow({
      instanceName,
      clientId: effectiveClientId,
      reserveForWarmup: settings.warmupReserveCount,
      forWarmup,
    });

    if (claimed.missingTable) {
      return { ok: true, mode: "direct", usedVpsFallback: false, reason: "Tabela proxy_pool ausente" };
    }

    const row = claimed.row;
    if (!row) {
      const { vpsSharedCount, vpsSharedInstances } = await countInstancesUsingVpsIp(instanceName);
      if ((settings.blockSharedVpsDomino || !settings.allowVpsFallback) && vpsSharedCount >= 1) {
        const dominoMsg = `Bloqueado pelo modo anti-dominó: IP da VPS já está em uso por ${vpsSharedCount} instância(s) (${vpsSharedInstances.slice(0, 3).join(", ")}). Adicione novos proxies BR ao pool.`;
        await patchInstanceConnectionProxyMeta(instanceName, effectiveClientId, {
          auto_proxy: true,
          proxy_pending_rotation: true,
          proxy_last_error: dominoMsg.slice(0, 280),
          proxy_vps_shared_count: vpsSharedCount,
          proxy_vps_warning: dominoMsg,
        });
        return {
          ok: false,
          mode: "direct",
          usedVpsFallback: false,
          reason: dominoMsg,
          vpsSharedCount,
          vpsWarning: dominoMsg,
        };
      }

      // Nenhum proxy livre no pool: respeita fail-open para IP padrão da VPS e reporta vpsSharedCount
      if (settings.allowVpsFallback && (overview.hasPool || explicitAuto || reason === "connect")) {
        const msg = triedErrors[triedErrors.length - 1] || "Pool sem proxies livres — usando IP padrão da VPS";
        const fb = await fallbackInstanceToVps(instanceName, effectiveClientId, msg, provider);
        return {
          ok: true,
          mode: "vps_fallback",
          usedVpsFallback: true,
          reason: msg,
          vpsSharedCount: fb.vpsSharedCount,
          vpsWarning: fb.warning,
        };
      }
      return { ok: true, mode: "direct", usedVpsFallback: false, reason: "Sem proxy livre", vpsSharedCount };
    }

    if (shouldProbe) {
      const probeRes = await activeProbe({
        host: row.host,
        port: row.port,
        protocol: row.protocol,
        username: row.username,
        password: row.password,
      }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));

      if (!probeRes.ok) {
        const errTxt = probeRes.error || "Falha no pre-flight do proxy";
        triedErrors.push(errTxt);
        await blacklistProxyById(row.id, "failed", errTxt);
        continue;
      }
    }

    const applied = await applyProxyToProvider(
      instanceName,
      {
        host: row.host,
        port: row.port,
        protocol: row.protocol,
        username: row.username,
        password: row.password,
      },
      provider,
    );

    if (!applied.ok) {
      const errTxt = applied.error || "Falha ao aplicar proxy na Evolution";
      triedErrors.push(errTxt);
      await blacklistProxyById(row.id, "failed", errTxt);
      continue;
    }

    // Diagnóstico honesto de Geo/ASN (nunca assume cegamente que o IP é residencial BR limpo)
    const geoIntel = await inspectProxyGeoAsn(row.host, {
      geoProbeFn,
      forceInTests: forceGeoInTests,
    }).catch(() => null);

    if (geoIntel && supabaseAdmin && typeof supabaseAdmin.from === "function") {
      const honestLabel = formatHonestProviderLabel(geoIntel);
      const honestCc = geoIntel.countryCode || row.country_code || "UNVERIFIED";
      try {
        await supabaseAdmin
          .from("proxy_pool")
          .update({
            country_code: honestCc,
            provider_label: honestLabel,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        invalidateProxyPoolCache();
      } catch {
        /* best-effort update */
      }
    }

    const geoEval = buildProxyGeoWarning(row.host, geoIntel, row);

    await patchInstanceConnectionProxyMeta(instanceName, effectiveClientId, {
      auto_proxy: true,
      proxy_mode: "pool_assigned",
      proxy_pending_rotation: false,
      proxy_last_error: null,
      proxy_pool_id: row.id,
      proxy_vps_shared_count: 0,
      proxy_vps_warning: null,
      proxy_country_code: geoEval.countryCode,
      proxy_is_datacenter: geoEval.isDatacenter,
      proxy_isp: geoIntel?.isp ?? null,
      proxy_geo_warning: geoEval.warning,
    });

    return {
      ok: true,
      mode: "pool_assigned",
      usedVpsFallback: false,
      proxyId: row.id,
      host: row.host,
      port: row.port,
      protocol: row.protocol,
      vpsSharedCount: 0,
      countryCode: geoEval.countryCode,
      isDatacenter: geoEval.isDatacenter,
      isp: geoIntel?.isp ?? null,
      geoWarning: geoEval.warning,
    };
  }

  // Esgotaram as tentativas com falha: respeita modo anti-dominó se IP da VPS já estiver compartilhado
  const failReason = triedErrors.join(" | ") || "Proxies testados falharam — fallback para IP da VPS";
  const { vpsSharedCount, vpsSharedInstances } = await countInstancesUsingVpsIp(instanceName);
  if ((settings.blockSharedVpsDomino || !settings.allowVpsFallback) && vpsSharedCount >= 1) {
    const dominoMsg = `Bloqueado pelo modo anti-dominó: IP da VPS já está em uso por ${vpsSharedCount} instância(s) (${vpsSharedInstances.slice(0, 3).join(", ")}). (${failReason})`;
    await patchInstanceConnectionProxyMeta(instanceName, effectiveClientId, {
      auto_proxy: true,
      proxy_pending_rotation: true,
      proxy_last_error: dominoMsg.slice(0, 280),
      proxy_vps_shared_count: vpsSharedCount,
      proxy_vps_warning: dominoMsg,
    });
    return {
      ok: false,
      mode: "direct",
      usedVpsFallback: false,
      reason: dominoMsg,
      vpsSharedCount,
      vpsWarning: dominoMsg,
    };
  }
  const fb = await fallbackInstanceToVps(instanceName, effectiveClientId, failReason, provider);
  return {
    ok: true,
    mode: "vps_fallback",
    usedVpsFallback: true,
    reason: failReason,
    vpsSharedCount: fb.vpsSharedCount,
    vpsWarning: fb.warning,
  };
}

/**
 * Circuito anti-tempestade: evita remover proxy em 1 falha isolada.
 * - Ban (`401`/`403`) ou erro explícito de auth proxy (`407`) coloca imediatamente na Lista Negra;
 * - Erros de rede comuns só derrubam o proxy após atingir `strikeThreshold` (padrão 3).
 * - Se não foi ban, tenta rotacionar automaticamente para 1 próximo proxy livre; se acabou, cai para VPS.
 */
export async function recordInstanceProxyStrike(params: {
  instanceName: string;
  clientId?: string | null;
  errorMessage: string;
  isBan401Or403?: boolean;
  probeFn?: ProxyConnectivityProbe;
}): Promise<{ action: "ignored" | "strike" | "rotated" | "vps_fallback" | "blacklisted_banned"; failCount?: number }> {
  const { instanceName, clientId = null, errorMessage, isBan401Or403 = false, probeFn } = params;
  if (!instanceName || !supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    return { action: "ignored" };
  }

  try {
    const { data: assigned, error } = await supabaseAdmin
      .from("proxy_pool")
      .select("*")
      .eq("assigned_instance", instanceName)
      .eq("status", "assigned")
      .maybeSingle();

    if (error || !assigned) return { action: "ignored" };
    const row = assigned as ProxyPoolRecord;
    const settings = await getProxyPoolSettings();
    const isProxyAuthOrHardErr = /407|proxy|ECONNREFUSED|ENOTFOUND|SOCKS/i.test(errorMessage);

    if (isBan401Or403) {
      await blacklistInstanceProxy(instanceName, "banned", errorMessage);
      await removeProxyFromProvider(instanceName);
      await patchInstanceConnectionProxyMeta(instanceName, clientId, {
        proxy_mode: "direct",
        proxy_pending_rotation: false,
        proxy_pool_id: null,
        proxy_last_error: errorMessage.slice(0, 240),
      });
      return { action: "blacklisted_banned", failCount: row.fail_count + 1 };
    }

    const nextFails = Number(row.fail_count || 0) + 1;
    const threshold = isProxyAuthOrHardErr ? Math.min(2, settings.strikeThreshold) : settings.strikeThreshold;

    if (nextFails < threshold) {
      await supabaseAdmin
        .from("proxy_pool")
        .update({
          fail_count: nextFails,
          last_error: errorMessage.slice(0, 300),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "assigned");
      return { action: "strike", failCount: nextFails };
    }

    await blacklistInstanceProxy(instanceName, "failed", errorMessage);
    const rotated = await ensureProxyForInstance({
      instanceName,
      clientId,
      reason: "rotation",
      forWarmup: true,
      probeFn,
    });

    return {
      action: rotated.mode === "pool_assigned" ? "rotated" : "vps_fallback",
      failCount: nextFails,
    };
  } catch {
    return { action: "ignored" };
  }
}

/**
 * Chamada na exclusão/desvínculo de instância: envia o proxy utilizado diretamente
 * para a Lista Negra (`used`), garantindo que nenhum outro chip reuse aquele IP no ciclo atual.
 */
export async function retireInstanceProxyAsUsed(
  instanceName: string,
  clientId?: string | null,
  providerHint?: string,
  opts?: { forceCleanup?: boolean },
): Promise<{ retired: boolean }> {
  if (providerHint === "whatsapp_cloud") {
    return { retired: false };
  }
  const row = await blacklistInstanceProxy(instanceName, "used", "Instância removida ou proxy automático desativado");
  if (row || opts?.forceCleanup) {
    await removeProxyFromProvider(instanceName, providerHint);
    await patchInstanceConnectionProxyMeta(instanceName, clientId, {
      auto_proxy: false,
      proxy_mode: "direct",
      proxy_pending_rotation: false,
      proxy_pool_id: null,
    });
  }
  return { retired: Boolean(row) };
}

export interface SyncRotatedInstancesResult {
  totalTargeted: number;
  migratedCount: number;
  vpsFallbackCount: number;
  results: Array<{ instanceName: string; mode: InstanceProxyMode; host?: string; reason?: string }>;
}

/**
 * Aplica novos proxies em fila cadenciada nas instâncias que perderam proxy na troca mensal
 * ou estavam aguardando no fallback da VPS. Evita derrubar dezenas de sockets simultaneamente.
 */
export async function syncRotatedProxiesBatch(params?: {
  extraInstances?: string[];
  concurrency?: number;
  delayBetweenBatchesMs?: number;
  probeFn?: ProxyConnectivityProbe;
}): Promise<SyncRotatedInstancesResult> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    return { totalTargeted: 0, migratedCount: 0, vpsFallbackCount: 0, results: [] };
  }

  const isVitest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const concurrency = params?.concurrency ?? 3;
  const delayMs = params?.delayBetweenBatchesMs ?? (isVitest ? 0 : 200);

  const targets = new Map<string, { clientId: string | null; provider: string; forWarmup: boolean }>();

  for (const name of params?.extraInstances || []) {
    if (name && name.trim()) {
      targets.set(name.trim(), { clientId: null, provider: "evolution", forWarmup: false });
    }
  }

  // 1) Busca instâncias com auto_proxy=true ou em fallback/pending rotation sem proxy ativo
  try {
    const { data: conns } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, client_id, provider, provider_config, status");

    const activeAssignedRows = await fetchAllActivePoolRows();
    const currentlyAssigned = new Set(
      activeAssignedRows.filter((r) => r.status === "assigned" && r.assigned_instance).map((r) => r.assigned_instance!),
    );

    const warmupSet = new Set<string>();
    try {
      const { data: warmupRows } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("instance_name")
        .eq("enabled", true);
      for (const w of (warmupRows || []) as Array<{ instance_name?: string }>) {
        if (w.instance_name) warmupSet.add(w.instance_name);
      }
    } catch {
      // opcional se tabela warmup ainda não existir
    }

    for (const c of (conns || []) as Array<{
      instance_name: string;
      client_id: string | null;
      provider: string | null;
      status: string | null;
      provider_config: Record<string, unknown> | null;
    }>) {
      if (!c.instance_name || c.provider === "whatsapp_cloud") continue;
      const cfg = c.provider_config || {};
      const inWarmup = warmupSet.has(c.instance_name);
      const wantsAuto = Boolean(cfg.auto_proxy) || Boolean(cfg.proxy_pending_rotation) || cfg.proxy_mode === "vps_fallback";

      if (targets.has(c.instance_name)) {
        targets.set(c.instance_name, {
          clientId: c.client_id,
          provider: c.provider || "evolution",
          forWarmup: inWarmup,
        });
        continue;
      }

      if (!currentlyAssigned.has(c.instance_name) && (wantsAuto || inWarmup)) {
        targets.set(c.instance_name, {
          clientId: c.client_id,
          provider: c.provider || "evolution",
          forWarmup: inWarmup,
        });
      }
    }
  } catch {
    // prossegue com extraInstances se houver
  }

  const targetEntries = Array.from(targets.entries());
  const results = await mapPoolConcurrency(targetEntries, concurrency, delayMs, async ([instanceName, meta]) => {
    const res = await ensureProxyForInstance({
      instanceName,
      clientId: meta.clientId,
      reason: "rotation",
      forWarmup: meta.forWarmup,
      providerHint: meta.provider,
      probeFn: params?.probeFn,
    });
    return {
      instanceName,
      mode: res.mode,
      ...(res.host ? { host: res.host } : {}),
      ...(res.reason ? { reason: res.reason } : {}),
    };
  });

  const migratedCount = results.filter((r) => r.mode === "pool_assigned").length;
  const vpsFallbackCount = results.filter((r) => r.mode === "vps_fallback").length;

  return {
    totalTargeted: results.length,
    migratedCount,
    vpsFallbackCount,
    results,
  };
}

export interface ImportProxyBatchResult {
  ok: boolean;
  batchId: string;
  totalParsed: number;
  duplicateCount: number;
  invalidCount: number;
  invalidSample: InvalidProxyLine[];
  addedCount: number;
  keptAssignedCount: number;
  keptBlacklistedCount: number;
  retiredCount: number;
  migratedInstances: number;
  vpsFallbackInstances: number;
  datacenterCount?: number;
  nonBrCount?: number;
  unverifiedGeoCount?: number;
  geoWarnings?: string[];
  error?: string;
}

/**
 * Importa lista `.txt` mensal do Webshare (exclusivo Admin):
 * - Mantém intactos os proxies `assigned` que permaneceram na lista;
 * - Respeita a Lista Negra (`failed`/`banned`/`used`) caso IPs repetidos reapareçam;
 * - Aposenta (`retired`) proxies do lote anterior que saíram da lista rotativa;
 * - Classifica Geo/ASN de forma honesta (nunca assume cegamente que todos são BR residenciais limpos);
 * - Insere IPs novos como `available` e opcionalmente reaplica em fila nas instâncias que precisam.
 */
export async function importProxyPoolBatch(params: {
  rawText: string;
  protocol?: ProxyProtocol;
  uploadedBy?: string | null;
  clearUsedBlacklist?: boolean;
  applyToInstances?: boolean;
  probeFn?: ProxyConnectivityProbe;
  geoProbeFn?: ProxyGeoProbe;
  forceGeoInTests?: boolean;
}): Promise<ImportProxyBatchResult> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    throw new Error("DB indisponível");
  }

  const settings = await getProxyPoolSettings();
  const proto = normalizeProtocol(params.protocol, settings.defaultProtocol);
  const parsed = parseWebshareProxyText(params.rawText, proto);

  if (parsed.valid.length === 0) {
    throw new Error(
      parsed.invalid.length > 0
        ? `Nenhum proxy válido encontrado (${parsed.invalid[0]?.reason || "formato inválido"}).`
        : "Nenhum proxy válido encontrado no arquivo enviado.",
    );
  }

  const batchId = randomUUID();
  const nowIso = new Date().toISOString();
  const clearUsed = Boolean(params.clearUsedBlacklist);
  const incomingByKey = new Map<string, ParsedProxyEntry>();
  for (const entry of parsed.valid) {
    incomingByKey.set(`${entry.host}:${entry.port}`, entry);
  }

  const existingRows = await fetchAllActivePoolRows();
  const existingByKey = new Map<string, ProxyPoolRecord>();
  for (const r of existingRows) {
    existingByKey.set(`${r.host}:${r.port}`, r);
  }

  let keptAssignedCount = 0;
  let keptBlacklistedCount = 0;
  let retiredCount = 0;
  let addedCount = 0;
  const instancesNeedingRotation: string[] = [];

  // 1) Processa proxies existentes vs nova lista
  for (const row of existingRows) {
    const key = `${row.host}:${row.port}`;
    const incoming = incomingByKey.get(key);

    if (!incoming) {
      // Saiu na rotação mensal
      if (row.status === "assigned" && row.assigned_instance) {
        instancesNeedingRotation.push(row.assigned_instance);
      }
      await supabaseAdmin
        .from("proxy_pool")
        .update({
          status: "retired",
          assigned_instance: null,
          assigned_client_id: null,
          updated_at: nowIso,
        })
        .eq("id", row.id);
      retiredCount++;
      continue;
    }

    if (row.status === "assigned") {
      const credsChanged =
        row.username !== incoming.username ||
        row.password !== incoming.password ||
        row.protocol !== incoming.protocol;
      await supabaseAdmin
        .from("proxy_pool")
        .update({
          username: incoming.username,
          password: incoming.password,
          protocol: incoming.protocol,
          last_batch_id: batchId,
          updated_at: nowIso,
        })
        .eq("id", row.id);
      keptAssignedCount++;
      if (credsChanged && row.assigned_instance) {
        await applyProxyToProvider(row.assigned_instance, incoming);
      }
      continue;
    }

    if (row.status === "blacklisted") {
      if (clearUsed && row.blacklist_reason === "used") {
        await supabaseAdmin
          .from("proxy_pool")
          .update({
            status: "available",
            blacklist_reason: null,
            blacklisted_at: null,
            fail_count: 0,
            last_error: null,
            username: incoming.username,
            password: incoming.password,
            protocol: incoming.protocol,
            last_batch_id: batchId,
            updated_at: nowIso,
          })
          .eq("id", row.id);
        addedCount++;
      } else {
        await supabaseAdmin
          .from("proxy_pool")
          .update({
            username: incoming.username,
            password: incoming.password,
            protocol: incoming.protocol,
            last_batch_id: batchId,
            updated_at: nowIso,
          })
          .eq("id", row.id);
        keptBlacklistedCount++;
      }
      continue;
    }

    // available
    await supabaseAdmin
      .from("proxy_pool")
      .update({
        username: incoming.username,
        password: incoming.password,
        protocol: incoming.protocol,
        last_batch_id: batchId,
        updated_at: nowIso,
      })
      .eq("id", row.id);
  }

  // 2) Insere proxies inéditos com classificação honesta de Geo/ASN
  const newEntries: ParsedProxyEntry[] = [];
  for (const [key, entry] of incomingByKey.entries()) {
    if (existingByKey.has(key)) continue;
    newEntries.push(entry);
  }

  const isVitest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const shouldRunGeoSample = Boolean(params.geoProbeFn) || (!isVitest || Boolean(params.forceGeoInTests));
  const geoByHost = new Map<string, ProxyGeoIntel | null>();
  if (shouldRunGeoSample && newEntries.length > 0) {
    const uniqueHosts = Array.from(new Set(newEntries.map((e) => e.host)));
    const hostsToProbe = params.geoProbeFn ? uniqueHosts : uniqueHosts.slice(0, 8);
    await mapPoolConcurrency(hostsToProbe, 4, isVitest ? 0 : 120, async (host) => {
      const intel = await inspectProxyGeoAsn(host, {
        geoProbeFn: params.geoProbeFn,
        forceInTests: params.forceGeoInTests,
      }).catch(() => null);
      geoByHost.set(host, intel);
    });
  }

  let datacenterCount = 0;
  let nonBrCount = 0;
  let unverifiedGeoCount = 0;
  const geoWarnings: string[] = [];

  const toInsert: Array<Record<string, unknown>> = [];
  for (const entry of newEntries) {
    const intel = geoByHost.get(entry.host) ?? null;
    const countryCode = intel?.countryCode ? intel.countryCode : "UNVERIFIED";
    const providerLabel = formatHonestProviderLabel(intel, "webshare");
    if (!intel) {
      unverifiedGeoCount++;
    } else {
      if (intel.hosting || intel.proxy) datacenterCount++;
      if (intel.countryCode && intel.countryCode !== "BR") nonBrCount++;
    }
    toInsert.push({
      host: entry.host,
      port: entry.port,
      protocol: entry.protocol,
      username: entry.username,
      password: entry.password,
      provider_label: providerLabel,
      country_code: countryCode,
      status: "available",
      last_batch_id: batchId,
      created_at: nowIso,
      updated_at: nowIso,
    });
  }

  if (datacenterCount > 0) {
    geoWarnings.push(
      `⚠️ ${datacenterCount} proxy(s) da amostra foram identificados como Datacenter/ASN — risco elevado de 428/401; prefira IPs residenciais/4G BR para escalar prospecção.`
    );
  }
  if (nonBrCount > 0) {
    geoWarnings.push(
      `⚠️ ${nonBrCount} proxy(s) da amostra estão fora do Brasil — divergência geográfica para chips +55.`
    );
  }

  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += 200) {
      const slice = toInsert.slice(i, i + 200);
      const { error: insErr } = await supabaseAdmin.from("proxy_pool").insert(slice);
      if (insErr) throw new Error(insErr.message || "Falha ao inserir proxies no pool");
    }
    addedCount += toInsert.length;
  }

  invalidateProxyPoolCache();

  // 3) Reaplica em lote controlado nas instâncias que perderam proxy ou estavam no fallback VPS
  let migratedInstances = 0;
  let vpsFallbackInstances = 0;
  if (params.applyToInstances !== false) {
    const syncRes = await syncRotatedProxiesBatch({
      extraInstances: instancesNeedingRotation,
      probeFn: params.probeFn,
    });
    migratedInstances = syncRes.migratedCount;
    vpsFallbackInstances = syncRes.vpsFallbackCount;
  }

  // 4) Limpeza de retired antigos (> 60 dias) e gravação do histórico de lote
  try {
    const retentionCutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin
      .from("proxy_pool")
      .delete()
      .eq("status", "retired")
      .lt("updated_at", retentionCutoff);
  } catch {
    // non-fatal
  }

  try {
    await supabaseAdmin.from("proxy_pool_batches").insert({
      id: batchId,
      uploaded_by: params.uploadedBy || null,
      protocol: proto,
      total_parsed: parsed.valid.length,
      added_count: addedCount,
      kept_assigned_count: keptAssignedCount,
      kept_blacklisted_count: keptBlacklistedCount,
      retired_count: retiredCount,
      migrated_instances: migratedInstances,
      fallback_vps_instances: vpsFallbackInstances,
      clear_used_blacklist: clearUsed,
      created_at: nowIso,
    });
  } catch {
    // non-fatal
  }

  return {
    ok: true,
    batchId,
    totalParsed: parsed.valid.length,
    duplicateCount: parsed.duplicateCount,
    invalidCount: parsed.invalid.length,
    invalidSample: parsed.invalid.slice(0, 10),
    addedCount,
    keptAssignedCount,
    keptBlacklistedCount,
    retiredCount,
    migratedInstances,
    vpsFallbackInstances,
    datacenterCount,
    nonBrCount,
    unverifiedGeoCount,
    geoWarnings,
  };
}

/**
 * Monta resumo seguro (zero credenciais) do estado de proxy para exibir em `/whatsapp`.
 */
export function buildSafeProxySummary(providerConfig: unknown): InstanceProxySummary {
  const cfg = providerConfig && typeof providerConfig === "object" ? (providerConfig as Record<string, unknown>) : {};
  const rawMode = String(cfg.proxy_mode || "");
  const mode: InstanceProxyMode =
    rawMode === "pool_assigned" || rawMode === "manual" || rawMode === "vps_fallback" ? rawMode : "direct";
  return {
    auto_proxy: Boolean(cfg.auto_proxy),
    mode,
    protected: mode === "pool_assigned" || mode === "manual",
    waiting_rotation: Boolean(cfg.proxy_pending_rotation),
    last_fallback_reason: typeof cfg.proxy_last_error === "string" ? cfg.proxy_last_error : null,
    vps_shared_count: typeof cfg.proxy_vps_shared_count === "number" ? cfg.proxy_vps_shared_count : undefined,
    vps_warning: typeof cfg.proxy_vps_warning === "string" ? cfg.proxy_vps_warning : null,
    country_code: typeof cfg.proxy_country_code === "string" ? cfg.proxy_country_code : null,
    is_datacenter: typeof cfg.proxy_is_datacenter === "boolean" ? cfg.proxy_is_datacenter : null,
    geo_warning: typeof cfg.proxy_geo_warning === "string" ? cfg.proxy_geo_warning : null,
  };
}

/**
 * Snapshot mascarado completo do pool para o Painel Admin (sem nunca expor senhas).
 */
export async function getAdminProxyPoolSnapshot(): Promise<{
  tableReady: boolean;
  settings: ProxyPoolSettings;
  stats: {
    totalActive: number;
    available: number;
    assigned: number;
    blacklisted: number;
    blacklistBreakdown: Record<ProxyBlacklistReason, number>;
    vpsFallbackCount: number;
    vpsSharedCount: number;
    datacenterCount: number;
    nonBrCount: number;
    brResidentialCount: number;
    unverifiedCount: number;
    false428Count: number;
  };
  assignedList: Array<{
    id: string;
    host: string;
    port: number;
    protocol: ProxyProtocol;
    assignedInstance: string;
    assignedClientId: string | null;
    assignedAt: string | null;
    failCount: number;
    countryCode?: string;
    providerLabel?: string;
    geoWarning?: string | null;
    isVerifiedBrResidential?: boolean;
  }>;
  blacklistList: Array<{
    id: string;
    host: string;
    port: number;
    protocol: ProxyProtocol;
    reason: ProxyBlacklistReason;
    blacklistedAt: string | null;
    failCount: number;
    lastError: string | null;
  }>;
  fallbackInstances: Array<{
    instanceName: string;
    clientId: string | null;
    provider: string;
    lastError: string | null;
    lastFallbackAt: string | null;
  }>;
  recentBatches: Array<Record<string, unknown>>;
}> {
  const settings = await getProxyPoolSettings();
  const emptyBreakdown: Record<ProxyBlacklistReason, number> = {
    used: 0,
    failed: 0,
    banned: 0,
    manual: 0,
  };

  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    return {
      tableReady: false,
      settings,
      stats: {
        totalActive: 0,
        available: 0,
        assigned: 0,
        blacklisted: 0,
        blacklistBreakdown: emptyBreakdown,
        vpsFallbackCount: 0,
        vpsSharedCount: 0,
        datacenterCount: 0,
        nonBrCount: 0,
        brResidentialCount: 0,
        unverifiedCount: 0,
        false428Count: 0,
      },
      assignedList: [],
      blacklistList: [],
      fallbackInstances: [],
      recentBatches: [],
    };
  }

  let tableReady = true;
  let rows: ProxyPoolRecord[] = [];
  try {
    const probe = await supabaseAdmin.from("proxy_pool").select("id").limit(1);
    if (probe.error && isMissingProxyPoolError(probe.error)) {
      tableReady = false;
    } else {
      rows = await fetchAllActivePoolRows();
    }
  } catch (err) {
    if (isMissingProxyPoolError(err)) tableReady = false;
  }

  const assignedList: Array<{
    id: string;
    host: string;
    port: number;
    protocol: ProxyProtocol;
    assignedInstance: string;
    assignedClientId: string | null;
    assignedAt: string | null;
    failCount: number;
    countryCode?: string;
    providerLabel?: string;
    geoWarning?: string | null;
    isVerifiedBrResidential?: boolean;
  }> = [];

  const blacklistList: Array<{
    id: string;
    host: string;
    port: number;
    protocol: ProxyProtocol;
    reason: ProxyBlacklistReason;
    blacklistedAt: string | null;
    failCount: number;
    lastError: string | null;
  }> = [];

  let available = 0;
  let assigned = 0;
  let blacklisted = 0;
  let datacenterCount = 0;
  let nonBrCount = 0;
  let brResidentialCount = 0;
  let unverifiedCount = 0;
  let false428Count = 0;

  for (const r of rows) {
    const geoEval = buildProxyGeoWarning(r.host, null, r);
    const isRes = isVerifiedCleanBrResidentialRow(r);
    if (isRes) brResidentialCount++;
    else if (geoEval.isDatacenter) datacenterCount++;
    if (geoEval.countryCode && geoEval.countryCode !== "BR") nonBrCount++;
    if (!isRes && !geoEval.isDatacenter && (!geoEval.countryCode || geoEval.countryCode === "UNVERIFIED")) {
      unverifiedCount++;
    }

    if (r.status === "available") {
      available++;
    } else if (r.status === "assigned") {
      assigned++;
      assignedList.push({
        id: r.id,
        host: r.host,
        port: r.port,
        protocol: r.protocol,
        assignedInstance: r.assigned_instance || "",
        assignedClientId: r.assigned_client_id,
        assignedAt: r.assigned_at,
        failCount: r.fail_count || 0,
        countryCode: r.country_code,
        providerLabel: r.provider_label,
        geoWarning: geoEval.warning,
        isVerifiedBrResidential: isRes,
      });
    } else if (r.status === "blacklisted") {
      blacklisted++;
      const reason = (r.blacklist_reason || "manual") as ProxyBlacklistReason;
      emptyBreakdown[reason] = (emptyBreakdown[reason] || 0) + 1;
      if (isFalse428BlacklistRow(r)) false428Count++;
      blacklistList.push({
        id: r.id,
        host: r.host,
        port: r.port,
        protocol: r.protocol,
        reason,
        blacklistedAt: r.blacklisted_at,
        failCount: r.fail_count || 0,
        lastError: r.last_error,
      });
    }
  }

  const fallbackInstances: Array<{
    instanceName: string;
    clientId: string | null;
    provider: string;
    lastError: string | null;
    lastFallbackAt: string | null;
  }> = [];
  let vpsSharedCount = 0;

  try {
    const { data: conns } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, client_id, provider, provider_config");
    const assignedSet = new Set(assignedList.map((a) => a.assignedInstance).filter(Boolean));
    for (const c of (conns || []) as Array<{
      instance_name: string;
      client_id: string | null;
      provider: string | null;
      provider_config: Record<string, unknown> | null;
    }>) {
      const cfg = c.provider_config || {};
      if (c.provider !== "whatsapp_cloud") {
        const hasDedicated =
          cfg.proxy_mode === "pool_assigned" || cfg.proxy_mode === "manual" || assignedSet.has(c.instance_name);
        if (!hasDedicated) vpsSharedCount++;
      }
      if (cfg.proxy_mode === "vps_fallback" || cfg.proxy_pending_rotation === true) {
        fallbackInstances.push({
          instanceName: c.instance_name,
          clientId: c.client_id,
          provider: c.provider || "evolution",
          lastError: typeof cfg.proxy_last_error === "string" ? cfg.proxy_last_error : null,
          lastFallbackAt: typeof cfg.proxy_last_fallback_at === "string" ? cfg.proxy_last_fallback_at : null,
        });
      }
    }
  } catch {
    // ignore
  }

  let recentBatches: Array<Record<string, unknown>> = [];
  if (tableReady) {
    try {
      const { data: batchRows } = await supabaseAdmin
        .from("proxy_pool_batches")
        .select("id, uploaded_by, protocol, total_parsed, added_count, kept_assigned_count, kept_blacklisted_count, retired_count, migrated_instances, fallback_vps_instances, created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      recentBatches = (batchRows || []) as Array<Record<string, unknown>>;
    } catch {
      // ignore
    }
  }

  return {
    tableReady,
    settings,
    stats: {
      totalActive: available + assigned + blacklisted,
      available,
      assigned,
      blacklisted,
      blacklistBreakdown: emptyBreakdown,
      vpsFallbackCount: fallbackInstances.length,
      vpsSharedCount,
      datacenterCount,
      nonBrCount,
      brResidentialCount,
      unverifiedCount,
      false428Count,
    },
    assignedList,
    blacklistList,
    fallbackInstances,
    recentBatches,
  };
}

/**
 * Testa em lotes paralelos os proxies `available` e envia automaticamente os mortos/407 para a Lista Negra.
 */
export async function testAvailablePoolProxies(params?: {
  limit?: number;
  probeFn?: ProxyConnectivityProbe;
}): Promise<{ checked: number; healthy: number; blacklisted: number }> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    return { checked: 0, healthy: 0, blacklisted: 0 };
  }

  const limit = Math.max(1, Math.min(500, params?.limit ?? 120));
  const { data, error } = await supabaseAdmin
    .from("proxy_pool")
    .select("*")
    .eq("status", "available")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !Array.isArray(data) || data.length === 0) {
    return { checked: 0, healthy: 0, blacklisted: 0 };
  }

  const probe = params?.probeFn || testProxyEndpointConnectivity;
  const rows = data as ProxyPoolRecord[];
  const nowIso = new Date().toISOString();
  let healthy = 0;
  let blacklisted = 0;

  await mapPoolConcurrency(rows, 8, 50, async (row) => {
    const res = await probe({
      host: row.host,
      port: row.port,
      protocol: row.protocol,
      username: row.username,
      password: row.password,
    }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));

    if (res.ok) {
      healthy++;
      await supabaseAdmin!
        .from("proxy_pool")
        .update({ last_checked_at: nowIso, last_error: null, updated_at: nowIso })
        .eq("id", row.id);
    } else {
      blacklisted++;
      await blacklistProxyById(row.id, "failed", res.error || "Falha no healthcheck");
    }
  });

  if (blacklisted > 0) invalidateProxyPoolCache();
  return { checked: rows.length, healthy, blacklisted };
}

export interface AuditProxyGeoResult {
  auditedHosts: number;
  updatedRows: number;
  brResidentialCount: number;
  brMobileCount: number;
  datacenterCount: number;
  foreignCount: number;
  unverifiedCount: number;
}

/**
 * Audita o Geo/ASN real (país + datacenter/residential) dos proxies ativos (`available`/`assigned`)
 * sem suposições cegas, atualizando `country_code` e `provider_label`.
 */
export async function auditProxyPoolGeoAsn(params?: {
  limit?: number;
  geoProbeFn?: ProxyGeoProbe;
  forceInTests?: boolean;
}): Promise<AuditProxyGeoResult> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    return {
      auditedHosts: 0,
      updatedRows: 0,
      brResidentialCount: 0,
      brMobileCount: 0,
      datacenterCount: 0,
      foreignCount: 0,
      unverifiedCount: 0,
    };
  }

  const limit = Math.max(1, Math.min(100, params?.limit ?? 40));
  const { data, error } = await supabaseAdmin
    .from("proxy_pool")
    .select("*")
    .in("status", ["available", "assigned"])
    .order("created_at", { ascending: true })
    .limit(limit * 3);

  if (error || !Array.isArray(data) || data.length === 0) {
    return {
      auditedHosts: 0,
      updatedRows: 0,
      brResidentialCount: 0,
      brMobileCount: 0,
      datacenterCount: 0,
      foreignCount: 0,
      unverifiedCount: 0,
    };
  }

  const rows = (data as ProxyPoolRecord[])
    .slice()
    .sort((a, b) => {
      const aUnv = String(a.country_code || "").toUpperCase() === "UNVERIFIED" || String(a.provider_label || "").includes("unverified") ? 0 : 1;
      const bUnv = String(b.country_code || "").toUpperCase() === "UNVERIFIED" || String(b.provider_label || "").includes("unverified") ? 0 : 1;
      return aUnv - bUnv;
    })
    .slice(0, limit);

  const uniqueHosts = Array.from(new Set(rows.map((r) => String(r.host || "").trim().toLowerCase()).filter(Boolean)));
  const isVitest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const geoByHost = new Map<string, ProxyGeoIntel | null>();

  await mapPoolConcurrency(uniqueHosts, 4, isVitest ? 0 : 150, async (host) => {
    const intel = await inspectProxyGeoAsn(host, {
      geoProbeFn: params?.geoProbeFn,
      forceInTests: params?.forceInTests,
    }).catch(() => null);
    geoByHost.set(host, intel);
  });

  let updatedRows = 0;
  let brResidentialCount = 0;
  let brMobileCount = 0;
  let datacenterCount = 0;
  let foreignCount = 0;
  let unverifiedCount = 0;
  const nowIso = new Date().toISOString();

  for (const row of rows) {
    const hostKey = String(row.host || "").trim().toLowerCase();
    const intel = geoByHost.get(hostKey) ?? null;
    if (!intel) {
      unverifiedCount++;
      continue;
    }
    const nextCc = intel.countryCode || row.country_code || "UNVERIFIED";
    const nextLabel = formatHonestProviderLabel(intel, "webshare");
    if (intel.hosting || intel.proxy) datacenterCount++;
    else if (intel.countryCode === "BR" && intel.mobile) brMobileCount++;
    else if (intel.countryCode === "BR") brResidentialCount++;
    else if (intel.countryCode && intel.countryCode !== "BR") foreignCount++;
    else unverifiedCount++;

    const { error: updErr } = await supabaseAdmin
      .from("proxy_pool")
      .update({
        country_code: nextCc,
        provider_label: nextLabel,
        last_checked_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", row.id);
    if (!updErr) updatedRows++;
  }

  if (updatedRows > 0) invalidateProxyPoolCache();
  return {
    auditedHosts: uniqueHosts.length,
    updatedRows,
    brResidentialCount,
    brMobileCount,
    datacenterCount,
    foreignCount,
    unverifiedCount,
  };
}

/**
 * Gerencia itens na Lista Negra (reativar 1 item específico ou limpar por motivo).
 */
export async function manageProxyBlacklist(params: {
  action: "unblacklist_id" | "clear_used" | "clear_failed" | "clear_false_428" | "clear_all";
  proxyId?: string;
}): Promise<{ updated: number }> {
  if (!supabaseAdmin || typeof supabaseAdmin.from !== "function") {
    return { updated: 0 };
  }

  const nowIso = new Date().toISOString();
  const clearPatch = {
    status: "available",
    blacklist_reason: null,
    blacklisted_at: null,
    fail_count: 0,
    last_error: null,
    updated_at: nowIso,
  };

  if (params.action === "clear_false_428") {
    const { data: blRows } = await supabaseAdmin
      .from("proxy_pool")
      .select("id, blacklist_reason, last_error")
      .eq("status", "blacklisted");
    const ids = ((blRows || []) as Array<{ id: string; blacklist_reason?: string | null; last_error?: string | null }>)
      .filter((r) => isFalse428BlacklistRow(r))
      .map((r) => r.id);
    if (ids.length === 0) return { updated: 0 };
    const { data: updatedRows } = await supabaseAdmin
      .from("proxy_pool")
      .update(clearPatch)
      .in("id", ids)
      .select("id");
    invalidateProxyPoolCache();
    return { updated: Array.isArray(updatedRows) ? updatedRows.length : ids.length };
  }

  let q = supabaseAdmin
    .from("proxy_pool")
    .update(clearPatch)
    .eq("status", "blacklisted");

  if (params.action === "unblacklist_id") {
    if (!params.proxyId) return { updated: 0 };
    q = q.eq("id", params.proxyId);
  } else if (params.action === "clear_used") {
    q = q.eq("blacklist_reason", "used");
  } else if (params.action === "clear_failed") {
    q = q.in("blacklist_reason", ["failed", "banned"]);
  }

  const { data } = await q.select("id");
  invalidateProxyPoolCache();
  return { updated: Array.isArray(data) ? data.length : 0 };
}

/**
 * Troca manualmente o proxy de uma instância: coloca o anterior em `blacklisted ('used')`
 * e aloca imediatamente um novo proxy limpo (ou cai pro fallback da VPS se esgotou).
 */
export async function rotateSingleInstanceProxy(
  instanceName: string,
  clientId?: string | null,
  probeFn?: ProxyConnectivityProbe,
): Promise<EnsureProxyResult> {
  await blacklistInstanceProxy(instanceName, "used", "Rotacionado manualmente pelo Admin");
  return ensureProxyForInstance({
    instanceName,
    clientId,
    reason: "rotation",
    forWarmup: true,
    probeFn,
  });
}

/**
 * Watchdog preventivo de saúde de proxies ativos:
 * testa periodicamente proxies com status `assigned`; se algum estiver offline/407,
 * coloca na blacklist ('failed') e rotaciona automaticamente para o próximo proxy limpo
 * antes que a instância caia ou tome erro na Evolution.
 */
export async function runAssignedProxyHealthWatchdog(opts?: {
  probeFn?: ProxyConnectivityProbe;
  maxChecks?: number;
}): Promise<{
  checked: number;
  healthy: number;
  rotated: number;
  fallbackVps: number;
  errors: string[];
}> {
  const probe = opts?.probeFn ?? testProxyEndpointConnectivity;
  const maxChecks = Math.max(1, Math.min(50, opts?.maxChecks ?? 20));
  const summary = { checked: 0, healthy: 0, rotated: 0, fallbackVps: 0, errors: [] as string[] };

  try {
    const { data: rows, error } = await supabaseAdmin
      .from("proxy_pool")
      .select("id, host, port, protocol, username, password, assigned_instance, assigned_client_id, fail_count")
      .eq("status", "assigned")
      .not("assigned_instance", "is", null)
      .order("last_checked_at", { ascending: true })
      .limit(maxChecks);

    if (error || !Array.isArray(rows) || rows.length === 0) {
      return summary;
    }

    const nowIso = new Date().toISOString();
    for (const row of rows as Array<Record<string, unknown>>) {
      const instanceName = String(row.assigned_instance || "").trim();
      if (!instanceName) continue;
      summary.checked += 1;

      const parsed: ParsedProxyEntry = {
        host: String(row.host || ""),
        port: Number(row.port || 0),
        protocol: (String(row.protocol || "http") as ParsedProxyEntry["protocol"]),
        username: String(row.username || ""),
        password: String(row.password || ""),
      };

      const check = await probe(parsed, 5000).catch((err: unknown) => ({
        ok: false,
        error: err instanceof Error ? err.message : "Probe falhou",
      }));

      if (check.ok) {
        summary.healthy += 1;
        await supabaseAdmin
          .from("proxy_pool")
          .update({ last_checked_at: nowIso, updated_at: nowIso })
          .eq("id", row.id);
        continue;
      }

      const reason = check.error || "Proxy offline no watchdog preventivo";
      summary.errors.push(`${instanceName}: ${reason}`);
      await blacklistInstanceProxy(instanceName, "failed", reason);
      const clientId = row.assigned_client_id ? String(row.assigned_client_id) : null;
      const rotated = await ensureProxyForInstance({
        instanceName,
        clientId,
        reason: "rotation",
        forWarmup: true,
        probeFn: probe,
      });

      if (rotated.mode === "pool_assigned") {
        summary.rotated += 1;
      } else {
        summary.fallbackVps += 1;
      }
    }
  } catch (err: unknown) {
    summary.errors.push(err instanceof Error ? err.message : String(err));
  }

  return summary;
}
