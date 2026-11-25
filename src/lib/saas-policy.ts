/**
 * Política central SaaS (Edge-safe — sem imports Node/Supabase).
 *
 * Define:
 *  - Quais módulos são Core do cliente SaaS vs Restritos/Admin-only (fail-closed)
 *  - Mapeamento completo rota -> feature key
 *  - Presets de planos e limites padrão (zero migration)
 */

export const SAAS_CORE_FEATURES = [
  "dashboard",
  "leads",
  "chat",
  "calendario",
  "agente",
  "whatsapp",
  "followup",
] as const;

export const SAAS_RESTRICTED_FEATURES = [
  "captador",
  "automacao",
  "prospeccao_sites",
  "sites",
  "aquecer_chips",
  "disparo",
  "organizador",
  "tokens",
  "configuracoes",
  "historico",
] as const;

export const ALL_SAAS_FEATURES = [
  ...SAAS_CORE_FEATURES,
  ...SAAS_RESTRICTED_FEATURES,
] as const;

export type SaasFeatureKey = (typeof ALL_SAAS_FEATURES)[number];

const RESTRICTED_FEATURE_SET = new Set<string>(SAAS_RESTRICTED_FEATURES);

export const DEFAULT_SAAS_CLIENT_FEATURES: Record<string, boolean> = Object.fromEntries([
  ...SAAS_CORE_FEATURES.map((k) => [k, true]),
  ...SAAS_RESTRICTED_FEATURES.map((k) => [k, false]),
]);

export const ALL_ADMIN_FEATURES: Record<string, boolean> = Object.fromEntries(
  ALL_SAAS_FEATURES.map((k) => [k, true]),
);

/**
 * Mapeia path raiz -> feature key em clients.features.
 * Qualquer página listada aqui é protegida tanto no proxy quanto na navegação.
 */
export const PATH_TO_FEATURE: Record<string, string> = {
  "/leads": "leads",
  "/chat": "chat",
  "/calendario": "calendario",
  "/agente": "agente",
  "/automacao": "automacao",
  "/disparo": "disparo",
  "/prospeccao-sites": "prospeccao_sites",
  "/sites": "sites",
  "/follow-up": "followup",
  "/follow-up-control": "followup",
  "/captador": "captador",
  "/whatsapp": "whatsapp",
  "/aquecer-chips": "aquecer_chips",
  "/tokens": "tokens",
  "/organizador": "organizador",
  "/configuracoes": "configuracoes",
  "/historico-ia": "historico",
};

export function isRestrictedFeature(feature: string): boolean {
  return RESTRICTED_FEATURE_SET.has(feature);
}

export function isFeatureEnabledForSession(
  feature: string,
  session:
    | {
        isAdmin?: boolean;
        impersonating?: boolean;
        features?: Record<string, boolean> | null;
      }
    | null
    | undefined,
): boolean {
  if (!session) return false;
  const isRealAdmin = Boolean(session.isAdmin) && !session.impersonating;
  if (isRealAdmin) return true;

  const features = session.features || {};
  if (isRestrictedFeature(feature)) {
    return features[feature] === true;
  }
  return features[feature] !== false;
}

export type SaasPlanId = "starter" | "pro" | "enterprise" | "custom" | "unlimited";

export interface SaasTenantLimits {
  plan: SaasPlanId;
  max_instances: number | null;
  max_agents: number | null;
  max_kb_docs: number | null;
  max_kb_chars: number;
  max_prompt_chars: number;
  max_output_tokens: number;
  max_upload_mb: number;
  monthly_token_limit: number | null;
  monthly_usd_limit: number | null;
}

export const SAAS_PLAN_PRESETS: Record<
  Exclude<SaasPlanId, "custom">,
  SaasTenantLimits
> = {
  starter: {
    plan: "starter",
    max_instances: 1,
    max_agents: 2,
    max_kb_docs: 15,
    max_kb_chars: 15_000,
    max_prompt_chars: 12_000,
    max_output_tokens: 1_024,
    max_upload_mb: 15,
    monthly_token_limit: 500_000,
    monthly_usd_limit: 5,
  },
  pro: {
    plan: "pro",
    max_instances: 3,
    max_agents: 5,
    max_kb_docs: 40,
    max_kb_chars: 25_000,
    max_prompt_chars: 16_000,
    max_output_tokens: 1_536,
    max_upload_mb: 30,
    monthly_token_limit: 2_000_000,
    monthly_usd_limit: 20,
  },
  enterprise: {
    plan: "enterprise",
    max_instances: 10,
    max_agents: 15,
    max_kb_docs: 100,
    max_kb_chars: 40_000,
    max_prompt_chars: 24_000,
    max_output_tokens: 2_048,
    max_upload_mb: 60,
    monthly_token_limit: 8_000_000,
    monthly_usd_limit: 80,
  },
  unlimited: {
    plan: "unlimited",
    max_instances: null,
    max_agents: null,
    max_kb_docs: null,
    max_kb_chars: 100_000,
    max_prompt_chars: 100_000,
    max_output_tokens: 8_192,
    max_upload_mb: 100,
    monthly_token_limit: null,
    monthly_usd_limit: null,
  },
};

/**
 * Fallback seguro para tenants legados sem entrada em `app_settings` (`saas_limits:<id>`).
 */
export const DEFAULT_LEGACY_TENANT_LIMITS: SaasTenantLimits = {
  plan: "pro",
  max_instances: 3,
  max_agents: 5,
  max_kb_docs: 30,
  max_kb_chars: 25_000,
  max_prompt_chars: 16_000,
  max_output_tokens: 1_536,
  max_upload_mb: 30,
  monthly_token_limit: 1_500_000,
  monthly_usd_limit: 15,
};

function parseNullableCap(value: unknown, fallback: number | null, min = 1, max = 1_000_000_000): number | null {
  if (value === null || value === "") return null;
  if (value === undefined) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function parseNullableUsd(value: unknown, fallback: number | null): number | null {
  if (value === null || value === "") return null;
  if (value === undefined) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(100_000, Math.round(num * 100) / 100);
}

export function normalizeSaasLimits(
  raw: unknown,
  fallback: SaasTenantLimits = DEFAULT_LEGACY_TENANT_LIMITS,
): SaasTenantLimits {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...fallback };
  }
  const obj = raw as Record<string, unknown>;
  const rawPlan = typeof obj.plan === "string" ? obj.plan.trim().toLowerCase() : "";
  const validPlan: SaasPlanId =
    rawPlan === "starter" ||
    rawPlan === "pro" ||
    rawPlan === "enterprise" ||
    rawPlan === "custom" ||
    rawPlan === "unlimited"
      ? rawPlan
      : fallback.plan;

  const base =
    validPlan !== "custom" && SAAS_PLAN_PRESETS[validPlan]
      ? SAAS_PLAN_PRESETS[validPlan]
      : fallback;

  return {
    plan: validPlan,
    max_instances: parseNullableCap(obj.max_instances, base.max_instances, 1, 500),
    max_agents: parseNullableCap(obj.max_agents, base.max_agents, 1, 500),
    max_kb_docs: parseNullableCap(obj.max_kb_docs, base.max_kb_docs, 1, 10_000),
    max_kb_chars: parsePositiveInt(obj.max_kb_chars, base.max_kb_chars, 500, 500_000),
    max_prompt_chars: parsePositiveInt(obj.max_prompt_chars, base.max_prompt_chars, 500, 200_000),
    max_output_tokens: parsePositiveInt(obj.max_output_tokens, base.max_output_tokens, 100, 8_192),
    max_upload_mb: parsePositiveInt(obj.max_upload_mb, base.max_upload_mb, 1, 100),
    monthly_token_limit: parseNullableCap(obj.monthly_token_limit, base.monthly_token_limit, 1_000, 1_000_000_000),
    monthly_usd_limit: parseNullableUsd(obj.monthly_usd_limit, base.monthly_usd_limit),
  };
}
