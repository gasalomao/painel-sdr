/**
 * Enforcement server-side de feature flags, planos/limites SaaS, cota mensal
 * de IA (tokens/USD) e rate-limit por tenant — zero DB migration via `app_settings`.
 */

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import {
  DEFAULT_LEGACY_TENANT_LIMITS,
  SAAS_PLAN_PRESETS,
  isFeatureEnabledForSession,
  normalizeSaasLimits,
  type SaasTenantLimits,
} from "@/lib/saas-policy";

const LIMITS_KEY_PREFIX = "saas_limits:";
const CACHE_TTL_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 5_000;
const CACHE_MAX_ENTRIES = 2_000;

const limitsCache = new Map<string, { value: SaasTenantLimits; at: number }>();
const adminFlagCache = new Map<string, { isAdmin: boolean; at: number }>();
const activeFlagCache = new Map<string, { isActive: boolean; at: number }>();
const monthlyUsageCache = new Map<
  string,
  { monthKey: string; tokens: number; usd: number; at: number }
>();
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function hasDb(): boolean {
  return Boolean(supabaseAdmin && typeof supabaseAdmin.from === "function");
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max = CACHE_MAX_ENTRIES): void {
  if (map.size >= max && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function saasLimitsKey(clientId: string): string {
  return `${LIMITS_KEY_PREFIX}${clientId}`;
}

export function invalidateTenantLimitsCache(clientId?: string): void {
  if (!clientId) {
    limitsCache.clear();
    return;
  }
  limitsCache.delete(clientId);
}

export function invalidateClientStatusCache(clientId?: string): void {
  if (!clientId) {
    adminFlagCache.clear();
    activeFlagCache.clear();
    return;
  }
  adminFlagCache.delete(clientId);
  activeFlagCache.delete(clientId);
}

export function resetSaasLimitsStateForTests(): void {
  limitsCache.clear();
  adminFlagCache.clear();
  activeFlagCache.clear();
  monthlyUsageCache.clear();
  rateLimitBuckets.clear();
}

/**
 * Valida acesso a uma feature (ou lista de features com semântica OR).
 * Retorna NextResponse 403 se negado, ou null se permitido.
 */
export function requireFeatureAccess(
  ctx: {
    isAdmin?: boolean;
    impersonating?: boolean;
    claims?: { features?: Record<string, boolean> | null } | null;
  },
  feature: string | string[],
): NextResponse | null {
  const candidates = Array.isArray(feature) ? feature : [feature];
  const session = {
    isAdmin: ctx.isAdmin,
    impersonating: ctx.impersonating,
    features: ctx.claims?.features ?? {},
  };
  const allowed = candidates.some((f) => isFeatureEnabledForSession(f, session));
  if (allowed) return null;

  return NextResponse.json(
    {
      ok: false,
      success: false,
      error: "Módulo não liberado no seu plano atual. Fale com o administrador.",
    },
    { status: 403 },
  );
}

/**
 * Verifica se o tenant é admin no banco (usado por webhooks/workers sem cookie de sessão).
 */
export async function isClientAdminCached(clientId: string): Promise<boolean> {
  const cleanId = String(clientId || "").trim();
  if (!cleanId) return false;

  const cached = adminFlagCache.get(cleanId);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.isAdmin;
  }

  try {
    if (!hasDb()) return false;
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("is_admin, is_active")
      .eq("id", cleanId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { is_admin?: boolean | null; is_active?: boolean | null };
    const isAdmin = Boolean(row.is_admin);
    const isActive = row.is_active !== false;
    setBounded(adminFlagCache, cleanId, { isAdmin, at: now });
    setBounded(activeFlagCache, cleanId, { isActive, at: now });
    return isAdmin;
  } catch {
    return false;
  }
}

/**
 * Verifica com cache se o tenant está ativo (`is_active !== false`).
 * Em falhas transitórias do banco, retorna true para não derrubar atendimento válido.
 */
export async function isClientActiveCached(clientId: string): Promise<boolean> {
  const cleanId = String(clientId || "").trim();
  if (!cleanId) return true;

  const cached = activeFlagCache.get(cleanId);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.isActive;
  }

  try {
    if (!hasDb()) return true;
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("is_active, is_admin")
      .eq("id", cleanId)
      .maybeSingle();
    if (error || !data) return true;
    const row = data as { is_active?: boolean | null; is_admin?: boolean | null };
    const isActive = row.is_active !== false;
    setBounded(activeFlagCache, cleanId, { isActive, at: now });
    setBounded(adminFlagCache, cleanId, { isAdmin: Boolean(row.is_admin), at: now });
    return isActive;
  } catch {
    return true;
  }
}

export async function getTenantSaasLimits(
  clientId: string,
  isAdmin = false,
): Promise<SaasTenantLimits> {
  if (isAdmin) {
    return { ...SAAS_PLAN_PRESETS.unlimited };
  }

  const cleanId = String(clientId || "").trim();
  if (!cleanId) return { ...DEFAULT_LEGACY_TENANT_LIMITS };

  const cached = limitsCache.get(cleanId);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return { ...cached.value };
  }

  try {
    if (!hasDb()) return { ...DEFAULT_LEGACY_TENANT_LIMITS };
    const { data, error } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", saasLimitsKey(cleanId))
      .maybeSingle();

    if (error || !data?.value) {
      setBounded(limitsCache, cleanId, { value: DEFAULT_LEGACY_TENANT_LIMITS, at: now });
      return { ...DEFAULT_LEGACY_TENANT_LIMITS };
    }

    const parsed = JSON.parse(String(data.value));
    const normalized = normalizeSaasLimits(parsed, DEFAULT_LEGACY_TENANT_LIMITS);
    setBounded(limitsCache, cleanId, { value: normalized, at: now });
    return { ...normalized };
  } catch {
    return { ...DEFAULT_LEGACY_TENANT_LIMITS };
  }
}

export async function getAllTenantSaasLimits(
  clientIds: string[],
): Promise<Record<string, SaasTenantLimits>> {
  const out: Record<string, SaasTenantLimits> = {};
  const cleanIds = Array.from(new Set(clientIds.map((id) => String(id || "").trim()).filter(Boolean)));
  for (const id of cleanIds) {
    out[id] = { ...DEFAULT_LEGACY_TENANT_LIMITS };
  }
  if (cleanIds.length === 0 || !hasDb()) return out;

  try {
    const keys = cleanIds.map((id) => saasLimitsKey(id));
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("key, value")
      .in("key", keys);

    const now = Date.now();
    for (const row of (data || []) as Array<{ key?: string; value?: string }>) {
      const k = String(row.key || "");
      if (!k.startsWith(LIMITS_KEY_PREFIX) || !row.value) continue;
      const cid = k.slice(LIMITS_KEY_PREFIX.length);
      try {
        const parsed = JSON.parse(String(row.value));
        const normalized = normalizeSaasLimits(parsed, DEFAULT_LEGACY_TENANT_LIMITS);
        out[cid] = normalized;
        setBounded(limitsCache, cid, { value: normalized, at: now });
      } catch {
        // mantém fallback
      }
    }
  } catch {
    // non-fatal
  }
  return out;
}

export async function saveTenantSaasLimits(
  clientId: string,
  rawLimits: unknown,
): Promise<SaasTenantLimits> {
  const cleanId = String(clientId || "").trim();
  const normalized = normalizeSaasLimits(rawLimits, DEFAULT_LEGACY_TENANT_LIMITS);
  if (!cleanId) return normalized;

  if (hasDb()) {
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: saasLimitsKey(cleanId),
          value: JSON.stringify(normalized),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      );
    if (error) {
      throw new Error(error.message);
    }
  }

  setBounded(limitsCache, cleanId, { value: normalized, at: Date.now() });
  return normalized;
}

function currentUtcMonthKey(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function recordTenantUsageDelta(
  clientId: string | null | undefined,
  tokens: number,
  costUsd?: number | null,
  nowMs = Date.now(),
): void {
  const cleanId = String(clientId || "").trim();
  if (!cleanId || !Number.isFinite(tokens) || tokens <= 0) return;

  const monthKey = currentUtcMonthKey(nowMs);
  const existing = monthlyUsageCache.get(cleanId);
  if (!existing || existing.monthKey !== monthKey) {
    return;
  }

  existing.tokens += Math.max(0, Math.floor(tokens));
  if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0) {
    existing.usd += costUsd;
  }
}

export async function getTenantMonthlyAiUsage(
  clientId: string,
  nowMs = Date.now(),
): Promise<{ tokens: number; usd: number }> {
  const cleanId = String(clientId || "").trim();
  if (!cleanId || !hasDb()) return { tokens: 0, usd: 0 };

  const monthKey = currentUtcMonthKey(nowMs);
  const cached = monthlyUsageCache.get(cleanId);
  if (cached && cached.monthKey === monthKey && nowMs - cached.at < CACHE_TTL_MS) {
    return { tokens: cached.tokens, usd: cached.usd };
  }

  try {
    const monthStartIso = `${monthKey}-01T00:00:00.000Z`;
    const { data, error } = await supabaseAdmin
      .from("ai_token_usage")
      .select("total_tokens, cost_usd")
      .eq("client_id", cleanId)
      .gte("created_at", monthStartIso);

    if (error || !Array.isArray(data)) {
      return cached && cached.monthKey === monthKey
        ? { tokens: cached.tokens, usd: cached.usd }
        : { tokens: 0, usd: 0 };
    }

    let tokens = 0;
    let usd = 0;
    for (const row of data as Array<{ total_tokens?: number | null; cost_usd?: number | null }>) {
      const t = Number(row?.total_tokens || 0);
      if (Number.isFinite(t) && t > 0) tokens += t;
      const c = Number(row?.cost_usd || 0);
      if (Number.isFinite(c) && c > 0) usd += c;
    }

    setBounded(monthlyUsageCache, cleanId, { monthKey, tokens, usd, at: nowMs });
    return { tokens, usd };
  } catch {
    return { tokens: 0, usd: 0 };
  }
}

export async function getAllTenantsMonthlyUsage(
  clientIds: string[],
  nowMs = Date.now(),
): Promise<Record<string, { tokens: number; usd: number }>> {
  const out: Record<string, { tokens: number; usd: number }> = {};
  const cleanIds = Array.from(new Set(clientIds.map((id) => String(id || "").trim()).filter(Boolean)));
  for (const id of cleanIds) out[id] = { tokens: 0, usd: 0 };
  if (cleanIds.length === 0 || !hasDb()) return out;

  try {
    const monthKey = currentUtcMonthKey(nowMs);
    const monthStartIso = `${monthKey}-01T00:00:00.000Z`;
    const { data, error } = await supabaseAdmin
      .from("ai_token_usage")
      .select("client_id, total_tokens, cost_usd")
      .in("client_id", cleanIds)
      .gte("created_at", monthStartIso);

    if (error || !Array.isArray(data)) return out;
    for (const row of data as Array<{ client_id?: string | null; total_tokens?: number | null; cost_usd?: number | null }>) {
      const cid = String(row.client_id || "").trim();
      if (!cid || !out[cid]) continue;
      const t = Number(row.total_tokens || 0);
      if (Number.isFinite(t) && t > 0) out[cid].tokens += t;
      const c = Number(row.cost_usd || 0);
      if (Number.isFinite(c) && c > 0) out[cid].usd += c;
    }
    for (const cid of cleanIds) {
      setBounded(monthlyUsageCache, cid, {
        monthKey,
        tokens: out[cid].tokens,
        usd: out[cid].usd,
        at: nowMs,
      });
    }
  } catch {
    // non-fatal
  }
  return out;
}

export interface TenantUsageSummary {
  plan: SaasTenantLimits["plan"];
  limits: SaasTenantLimits;
  usage: {
    tokens: number;
    usd: number;
    tokenPercent: number | null;
    usdPercent: number | null;
  };
  resources: {
    agents: number;
    instances: number;
    kbDocs: number;
  };
  status: "ok" | "warning" | "exceeded";
}

export async function getTenantUsageSummary(
  clientId: string,
  isAdmin = false,
): Promise<TenantUsageSummary> {
  const limits = await getTenantSaasLimits(clientId, isAdmin);
  const usage = await getTenantMonthlyAiUsage(clientId);

  let agents = 0;
  let instances = 0;
  let kbDocs = 0;
  if (hasDb() && clientId) {
    try {
      const [agRes, instRes, kbRes] = await Promise.all([
        supabaseAdmin
          .from("agent_settings")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId),
        supabaseAdmin
          .from("channel_connections")
          .select("instance_name", { count: "exact", head: true })
          .eq("client_id", clientId),
        supabaseAdmin
          .from("agent_knowledge")
          .select("id", { count: "exact", head: true })
          .eq("client_id", clientId),
      ]);
      agents = Number(agRes.count || 0);
      instances = Number(instRes.count || 0);
      kbDocs = Number(kbRes.count || 0);
    } catch {
      // mantém contagem 0 em erro transitório
    }
  }

  const tokenPercent =
    limits.monthly_token_limit && limits.monthly_token_limit > 0
      ? Math.min(999, Math.round((usage.tokens / limits.monthly_token_limit) * 100))
      : null;
  const usdPercent =
    limits.monthly_usd_limit && limits.monthly_usd_limit > 0
      ? Math.min(999, Math.round((usage.usd / limits.monthly_usd_limit) * 100))
      : null;

  const maxPct = Math.max(tokenPercent ?? 0, usdPercent ?? 0);
  const status: TenantUsageSummary["status"] = isAdmin
    ? "ok"
    : maxPct >= 100
      ? "exceeded"
      : maxPct >= 80
        ? "warning"
        : "ok";

  return {
    plan: limits.plan,
    limits,
    usage: {
      tokens: usage.tokens,
      usd: Math.round(usage.usd * 10_000) / 10_000,
      tokenPercent,
      usdPercent,
    },
    resources: { agents, instances, kbDocs },
    status,
  };
}

export async function logAdminAudit(params: {
  actorId: string;
  targetClientId: string;
  action: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  if (!hasDb()) return;
  try {
    await supabaseAdmin.from("webhook_logs").insert({
      client_id: params.targetClientId,
      instance_name: "admin_panel",
      event: "ADMIN_AUDIT",
      payload: {
        actor_id: params.actorId,
        action: params.action,
        ...(params.details || {}),
      },
      created_at: new Date().toISOString(),
    });
  } catch {
    // auditoria nunca deve quebrar fluxo do admin
  }
}

export async function checkTenantAiQuota(
  clientId: string,
  isAdmin = false,
  nowMs = Date.now(),
): Promise<{
  allowed: boolean;
  reason?: string;
  usage: { tokens: number; usd: number };
  limits: SaasTenantLimits;
}> {
  if (isAdmin) {
    const unlimited = { ...SAAS_PLAN_PRESETS.unlimited };
    return { allowed: true, usage: { tokens: 0, usd: 0 }, limits: unlimited };
  }

  const limits = await getTenantSaasLimits(clientId, false);
  const needsUsageCheck =
    limits.monthly_token_limit !== null || limits.monthly_usd_limit !== null;
  if (!needsUsageCheck) {
    return { allowed: true, usage: { tokens: 0, usd: 0 }, limits };
  }

  const usage = await getTenantMonthlyAiUsage(clientId, nowMs);

  if (limits.monthly_token_limit !== null && usage.tokens >= limits.monthly_token_limit) {
    return {
      allowed: false,
      reason: `Cota mensal de tokens IA atingida (${usage.tokens.toLocaleString("pt-BR")} / ${limits.monthly_token_limit.toLocaleString("pt-BR")}).`,
      usage,
      limits,
    };
  }

  if (limits.monthly_usd_limit !== null && usage.usd >= limits.monthly_usd_limit) {
    return {
      allowed: false,
      reason: `Limite mensal de consumo IA atingido (\$${usage.usd.toFixed(2)} / \$${limits.monthly_usd_limit.toFixed(2)}).`,
      usage,
      limits,
    };
  }

  return { allowed: true, usage, limits };
}

export function checkTenantRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
  nowMs = Date.now(),
): { allowed: boolean; retryAfterSec?: number } {
  if (!key || maxRequests <= 0 || windowMs <= 0) return { allowed: true };

  if (rateLimitBuckets.size > RATE_LIMIT_MAX_KEYS) {
    for (const [k, entry] of rateLimitBuckets.entries()) {
      if (entry.resetAt <= nowMs) rateLimitBuckets.delete(k);
    }
    if (rateLimitBuckets.size > RATE_LIMIT_MAX_KEYS) {
      const oldest = rateLimitBuckets.keys().next().value;
      if (oldest) rateLimitBuckets.delete(oldest);
    }
  }

  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= nowMs) {
    rateLimitBuckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return { allowed: true };
  }

  if (current.count >= maxRequests) {
    const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - nowMs) / 1000));
    return { allowed: false, retryAfterSec };
  }

  current.count += 1;
  return { allowed: true };
}
