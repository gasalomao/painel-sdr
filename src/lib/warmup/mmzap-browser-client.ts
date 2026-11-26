import { getInternalSecret, INTERNAL_SECRET_HEADER } from "@/lib/internal-auth";

export interface MmzapWorkerProxyInput {
  server: string;
  username?: string | null;
  password?: string | null;
  sourceHost?: string | null;
}

export interface MmzapWorkerSessionStatus {
  instanceName: string;
  status: string;
  qrCodeBase64?: string | null;
  needsExtensionSetup?: boolean;
  mmzapUiDetected?: boolean;
  mmzapChipState?: string | null;
  mmzapStatusLabel?: string | null;
  proxyIp?: string | null;
  rssMb?: number | null;
  lastError?: string | null;
  uptimeSeconds?: number;
  updatedAt?: string;
}

export interface MmzapWorkerExtensionInfo {
  installed: boolean;
  name: string | null;
  version: string | null;
  source?: "builtin" | "override" | null;
}

export interface MmzapWorkerHealth {
  configured: boolean;
  reachable: boolean;
  activeSessions: number;
  maxConcurrent: number;
  totalRssMb?: number;
  extension?: MmzapWorkerExtensionInfo;
  sessions: MmzapWorkerSessionStatus[];
  error?: string;
}

export interface MmzapWorkerCallResult<T> {
  configured: boolean;
  ok: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

function getWorkerBaseUrl(): string | null {
  const raw = String(process.env.MMZAP_WORKER_URL || "").trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function getWorkerSecret(): string {
  const explicit = String(process.env.MMZAP_WORKER_SECRET || "").trim();
  if (explicit) return explicit;
  return getInternalSecret() || "";
}

export function isMmzapWorkerConfigured(): boolean {
  return Boolean(getWorkerBaseUrl());
}

async function callMmzapWorker<T>(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<MmzapWorkerCallResult<T>> {
  const baseUrl = getWorkerBaseUrl();
  if (!baseUrl) {
    return { configured: false, ok: false, error: "MMZAP_WORKER_URL não configurada" };
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  const secret = getWorkerSecret();
  if (secret) headers[INTERNAL_SECRET_HEADER] = secret;

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    let parsed: T | undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const errMsg =
        (parsed as { error?: string } | undefined)?.error ||
        text.slice(0, 200) ||
        `HTTP ${res.status}`;
      return {
        configured: true,
        ok: false,
        statusCode: res.status,
        data: parsed,
        error: errMsg,
      };
    }
    return { configured: true, ok: true, statusCode: res.status, data: parsed };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      error: err instanceof Error ? err.message : "Falha ao conectar no mmzap-browser-worker",
    };
  }
}

export async function getMmzapWorkerHealth(): Promise<MmzapWorkerHealth> {
  if (!isMmzapWorkerConfigured()) {
    return {
      configured: false,
      reachable: false,
      activeSessions: 0,
      maxConcurrent: 0,
      sessions: [],
    };
  }
  const res = await callMmzapWorker<{
    ok?: boolean;
    activeSessions?: number;
    maxConcurrent?: number;
    totalRssMb?: number;
    extension?: MmzapWorkerExtensionInfo;
    sessions?: MmzapWorkerSessionStatus[];
  }>("/health", "GET", undefined, 8000);

  if (!res.ok || !res.data) {
    return {
      configured: true,
      reachable: false,
      activeSessions: 0,
      maxConcurrent: 0,
      sessions: [],
      error: res.error || "Worker offline",
    };
  }

  return {
    configured: true,
    reachable: true,
    activeSessions: Number(res.data.activeSessions || 0),
    maxConcurrent: Number(res.data.maxConcurrent || 2),
    totalRssMb: typeof res.data.totalRssMb === "number" ? res.data.totalRssMb : undefined,
    extension: res.data.extension,
    sessions: Array.isArray(res.data.sessions) ? res.data.sessions : [],
  };
}

export async function startMmzapWorkerPairing(params: {
  instanceName: string;
  clientId: string;
  proxy?: MmzapWorkerProxyInput | null;
  shiftDurationMinutes?: number;
}): Promise<MmzapWorkerCallResult<MmzapWorkerSessionStatus>> {
  return callMmzapWorker<MmzapWorkerSessionStatus>(
    `/sessions/${encodeURIComponent(params.instanceName)}/pair`,
    "POST",
    {
      clientId: params.clientId,
      proxy: params.proxy || null,
      shiftDurationMinutes: params.shiftDurationMinutes,
    },
    25_000
  );
}

export async function getMmzapWorkerPairingQr(
  instanceName: string
): Promise<MmzapWorkerCallResult<MmzapWorkerSessionStatus>> {
  return callMmzapWorker<MmzapWorkerSessionStatus>(
    `/sessions/${encodeURIComponent(instanceName)}/qr`,
    "GET",
    undefined,
    12_000
  );
}

export async function openMmzapWorkerSetupWindow(params: {
  instanceName: string;
  clientId: string;
  proxy?: MmzapWorkerProxyInput | null;
  setupUrl?: string;
}): Promise<MmzapWorkerCallResult<MmzapWorkerSessionStatus>> {
  return callMmzapWorker<MmzapWorkerSessionStatus>(
    `/sessions/${encodeURIComponent(params.instanceName)}/setup`,
    "POST",
    {
      clientId: params.clientId,
      proxy: params.proxy || null,
      setupUrl: params.setupUrl || undefined,
    },
    25_000
  );
}

export async function startMmzapWorkerShift(params: {
  instanceName: string;
  clientId: string;
  proxy?: MmzapWorkerProxyInput | null;
  shiftDurationMinutes: number;
  slowMode?: boolean;
}): Promise<MmzapWorkerCallResult<MmzapWorkerSessionStatus>> {
  return callMmzapWorker<MmzapWorkerSessionStatus>(
    `/sessions/${encodeURIComponent(params.instanceName)}/start`,
    "POST",
    {
      clientId: params.clientId,
      proxy: params.proxy || null,
      shiftDurationMinutes: params.shiftDurationMinutes,
      slowMode: params.slowMode !== false,
    },
    25_000
  );
}

export async function stopMmzapWorkerSession(
  instanceName: string,
  reason = "governor_stop"
): Promise<MmzapWorkerCallResult<MmzapWorkerSessionStatus>> {
  return callMmzapWorker<MmzapWorkerSessionStatus>(
    `/sessions/${encodeURIComponent(instanceName)}/stop`,
    "POST",
    { reason },
    15_000
  );
}

export async function deleteMmzapWorkerSession(
  instanceName: string
): Promise<MmzapWorkerCallResult<{ ok: boolean }>> {
  return callMmzapWorker<{ ok: boolean }>(
    `/sessions/${encodeURIComponent(instanceName)}`,
    "DELETE",
    undefined,
    15_000
  );
}

export async function markMmzapWorkerSetupDone(
  instanceName: string
): Promise<MmzapWorkerCallResult<{ ok: boolean; needsExtensionSetup: boolean }>> {
  return callMmzapWorker<{ ok: boolean; needsExtensionSetup: boolean }>(
    `/sessions/${encodeURIComponent(instanceName)}/setup-complete`,
    "POST",
    {},
    10_000
  );
}

export async function getMmzapWorkerScreenshot(
  instanceName: string
): Promise<MmzapWorkerCallResult<{ screenshotBase64?: string | null; status?: string }>> {
  return callMmzapWorker<{ screenshotBase64?: string | null; status?: string }>(
    `/sessions/${encodeURIComponent(instanceName)}/screenshot`,
    "GET",
    undefined,
    12_000
  );
}

export async function sendMmzapWorkerInput(
  instanceName: string,
  input: { type: "click" | "text" | "key" | "goto"; x?: number; y?: number; text?: string; key?: string; url?: string }
): Promise<MmzapWorkerCallResult<{ screenshotBase64?: string | null; status?: string }>> {
  return callMmzapWorker<{ screenshotBase64?: string | null; status?: string }>(
    `/sessions/${encodeURIComponent(instanceName)}/input`,
    "POST",
    input as Record<string, unknown>,
    15_000
  );
}

export async function uploadMmzapExtensionZip(
  zipBase64: string
): Promise<MmzapWorkerCallResult<{ ok: boolean; extension?: { installed: boolean; name: string | null; version: string | null } }>> {
  return callMmzapWorker(
    "/extensions/upload",
    "POST",
    { zipBase64 },
    30_000
  );
}
