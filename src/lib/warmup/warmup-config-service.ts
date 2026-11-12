/**
 * Fonte única de verdade das configurações de aquecimento.
 *
 * Regras de precedência:
 * - Se a tabela `whatsapp_warmup_configs` existir, ela é a ÚNICA fonte.
 * - `app_settings` só é usado quando a tabela não existe (banco antigo/sem migration).
 *
 * Motivo: antes o worker caía em `app_settings` quando todas as configs da tabela
 * estavam desligadas, religando chips que o usuário havia pausado.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import {
  PURPOSE_METADATA,
  STAGE_DEFAULTS,
  type WarmupConfig,
  type WarmupPurpose,
  type WarmupStage,
} from "./warmup-types";

export type WarmupConfigSource = "table" | "settings";

export interface TenantConnection {
  instance_name: string;
  status: string;
  phone_number: string | null;
}

export interface GlobalWarmupSettings {
  ai_model: string;
  ai_theme: string;
  allowed_start_hour: number;
  allowed_end_hour: number;
  min_interval_seconds: number;
  max_interval_seconds: number;
  min_typing_seconds: number;
  max_typing_seconds: number;
  enable_typing: boolean;
  enable_blue_ticks: boolean;
  enable_reactions: boolean;
  enable_audio: boolean;
  enable_vcard: boolean;
  enable_status_posts: boolean;
  stage_auto_progress: boolean;
  continuous_warmup: boolean;
  auto_warmup_new_chips: boolean;
  custom_prompt: string;
}

export const DEFAULT_GLOBAL_WARMUP_SETTINGS: GlobalWarmupSettings = {
  ai_model: "fallback",
  ai_theme: "dia_a_dia",
  allowed_start_hour: 8,
  allowed_end_hour: 21,
  min_interval_seconds: 90,
  max_interval_seconds: 300,
  min_typing_seconds: 3,
  max_typing_seconds: 8,
  enable_typing: true,
  enable_blue_ticks: true,
  enable_reactions: true,
  enable_audio: true,
  enable_vcard: true,
  enable_status_posts: true,
  stage_auto_progress: true,
  continuous_warmup: true,
  auto_warmup_new_chips: true,
  custom_prompt: "",
};

/**
 * Campos que o usuário pode alterar pela UI/API.
 * Contadores e campos do motor (sent_today, health_score, days_active, etc.)
 * NUNCA são aceitos de fora.
 */
export const WARMUP_EDITABLE_FIELDS = [
  "enabled",
  "stage",
  "stage_auto_progress",
  "purpose",
  "daily_target",
  "min_interval_seconds",
  "max_interval_seconds",
  "min_typing_seconds",
  "max_typing_seconds",
  "allowed_start_hour",
  "allowed_end_hour",
  "ai_model",
  "ai_theme",
  "custom_prompt",
  "enable_typing",
  "enable_blue_ticks",
  "enable_reactions",
  "enable_audio",
  "enable_vcard",
  "enable_status_posts",
  "continuous_warmup",
  "group_auto_join",
  "swarm_active",
  "max_groups_per_chip",
] as const;

type WarmupEditableField = (typeof WARMUP_EDITABLE_FIELDS)[number];
export type WarmupConfigPatch = Partial<Pick<WarmupConfig, WarmupEditableField>>;

const CONNECTED_STATUSES = new Set(["open", "connected", "connected_open"]);

export function isConnectedStatus(status?: string | null): boolean {
  if (!status) return false;
  return CONNECTED_STATUSES.has(String(status).trim().toLowerCase());
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Higieniza o patch vindo do cliente, mantendo apenas campos editáveis e
 * aplicando limites numéricos. Impede que a UI sobrescreva contadores internos.
 */
export function sanitizeWarmupPatch(input: Record<string, unknown>): WarmupConfigPatch {
  const patch: WarmupConfigPatch = {};

  for (const field of WARMUP_EDITABLE_FIELDS) {
    if (!(field in input)) continue;
    const raw = input[field];

    switch (field) {
      case "stage": {
        patch.stage = clampInt(raw, 1, 4, 1) as WarmupStage;
        break;
      }
      case "purpose": {
        const value = String(raw ?? "");
        patch.purpose = (
          ["contingency", "inbound", "outbound"].includes(value) ? value : "contingency"
        ) as WarmupPurpose;
        break;
      }
      case "daily_target":
        patch.daily_target = clampInt(raw, 1, 200, 10);
        break;
      case "min_interval_seconds":
        patch.min_interval_seconds = clampInt(raw, 30, 3600, 90);
        break;
      case "max_interval_seconds":
        patch.max_interval_seconds = clampInt(raw, 30, 3600, 300);
        break;
      case "min_typing_seconds":
        patch.min_typing_seconds = clampInt(raw, 1, 60, 3);
        break;
      case "max_typing_seconds":
        patch.max_typing_seconds = clampInt(raw, 1, 60, 8);
        break;
      case "allowed_start_hour":
        patch.allowed_start_hour = clampInt(raw, 0, 23, 8);
        break;
      case "allowed_end_hour":
        patch.allowed_end_hour = clampInt(raw, 1, 24, 21);
        break;
      case "max_groups_per_chip":
        patch.max_groups_per_chip = clampInt(raw, 0, 100, 10);
        break;
      case "ai_model":
        patch.ai_model = String(raw ?? "fallback").trim() || "fallback";
        break;
      case "ai_theme":
        patch.ai_theme = String(raw ?? "dia_a_dia").trim() || "dia_a_dia";
        break;
      case "custom_prompt":
        patch.custom_prompt =
          raw === null || raw === undefined || raw === "" ? null : String(raw);
        break;
      default:
        if (field === "enabled" || field === "stage_auto_progress" || field === "continuous_warmup" ||
          field === "enable_typing" || field === "enable_blue_ticks" || field === "enable_reactions" ||
          field === "enable_audio" || field === "enable_vcard" || field === "enable_status_posts" ||
          field === "group_auto_join" || field === "swarm_active") {
          (patch as Record<string, unknown>)[field] = Boolean(raw);
        }
        break;
    }
  }

  if (patch.min_interval_seconds !== undefined && patch.max_interval_seconds !== undefined) {
    if (patch.max_interval_seconds < patch.min_interval_seconds) {
      patch.max_interval_seconds = patch.min_interval_seconds;
    }
  }
  if (patch.min_typing_seconds !== undefined && patch.max_typing_seconds !== undefined) {
    if (patch.max_typing_seconds < patch.min_typing_seconds) {
      patch.max_typing_seconds = patch.min_typing_seconds;
    }
  }

  return patch;
}

function isMissingTableError(error: unknown): boolean {
  const code = String((error as { code?: string } | null)?.code || "");
  if (["42P01", "PGRST205", "PGRST204"].includes(code)) return true;
  const message = String((error as { message?: string } | null)?.message || "").toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table");
}

async function readSettingsConfigs(clientId: string): Promise<Record<string, WarmupConfig>> {
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `warmup_configs_${clientId}`)
      .maybeSingle();

    if (!data?.value) return {};
    const parsed = JSON.parse(data.value) as Record<string, WarmupConfig>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Lê as configs do tenant respeitando a precedência tabela → app_settings.
 */
export async function readTenantWarmupConfigs(clientId: string): Promise<{
  source: WarmupConfigSource;
  configs: Record<string, WarmupConfig>;
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("*")
      .eq("client_id", clientId);

    if (!error) {
      const configs: Record<string, WarmupConfig> = {};
      for (const row of (data || []) as WarmupConfig[]) {
        if (row?.instance_name) configs[row.instance_name] = row;
      }
      return { source: "table", configs };
    }

    // Erro transitório (rede/permissão): falha fechado, sem cair em cópia antiga.
    if (!isMissingTableError(error)) {
      return { source: "settings", configs: {} };
    }
  } catch {
    // Exceção inesperada: também falha fechado.
    return { source: "settings", configs: {} };
  }

  return { source: "settings", configs: await readSettingsConfigs(clientId) };
}

export async function readTenantConnections(clientId: string): Promise<TenantConnection[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, status, provider_config")
      .eq("client_id", clientId);

    if (error || !Array.isArray(data)) return [];

    return data.map((row) => {
      const providerConfig = (row.provider_config || {}) as Record<string, unknown>;
      const rawPhone = providerConfig.owner_phone ?? providerConfig.owner_jid ?? null;
      const cleanPhone = rawPhone
        ? String(rawPhone).replace(/@.*$/, "").replace(/\D/g, "")
        : "";
      return {
        instance_name: String(row.instance_name),
        status: String(row.status || ""),
        phone_number: cleanPhone.length >= 10 ? cleanPhone : null,
      };
    });
  } catch {
    return [];
  }
}

export async function getGlobalWarmupSettings(clientId: string): Promise<GlobalWarmupSettings> {
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `warmup_global_${clientId}`)
      .maybeSingle();

    if (data?.value) {
      const parsed = JSON.parse(data.value) as Partial<GlobalWarmupSettings>;
      return { ...DEFAULT_GLOBAL_WARMUP_SETTINGS, ...parsed };
    }
  } catch {
    /* usa defaults */
  }

  return { ...DEFAULT_GLOBAL_WARMUP_SETTINGS };
}

export async function saveGlobalWarmupSettings(
  clientId: string,
  settings: Partial<GlobalWarmupSettings>,
  applyToAll = false
): Promise<GlobalWarmupSettings> {
  const current = await getGlobalWarmupSettings(clientId);
  const sanitized: Partial<GlobalWarmupSettings> = {};

  for (const [key, value] of Object.entries(settings)) {
    if (key === "auto_warmup_new_chips") {
      sanitized.auto_warmup_new_chips = Boolean(value);
      continue;
    }
    if (!(key in DEFAULT_GLOBAL_WARMUP_SETTINGS)) continue;
    if (typeof value === "number") {
      const fallback = DEFAULT_GLOBAL_WARMUP_SETTINGS[key as keyof GlobalWarmupSettings] as number;
      const max = key.startsWith("allowed_") ? (key === "allowed_end_hour" ? 24 : 23) : 3600;
      const min = key.startsWith("allowed_") ? 0 : 1;
      (sanitized as Record<string, unknown>)[key] = clampInt(value, min, max, fallback);
    } else if (typeof value === "boolean") {
      (sanitized as Record<string, unknown>)[key] = Boolean(value);
    } else if (typeof value === "string") {
      (sanitized as Record<string, unknown>)[key] = value;
    }
  }

  if (
    sanitized.min_interval_seconds !== undefined &&
    sanitized.max_interval_seconds !== undefined &&
    sanitized.max_interval_seconds < sanitized.min_interval_seconds
  ) {
    sanitized.max_interval_seconds = sanitized.min_interval_seconds;
  }

  const merged = { ...current, ...sanitized };

  await supabaseAdmin
    .from("app_settings")
    .upsert(
      {
        key: `warmup_global_${clientId}`,
        value: JSON.stringify(merged),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

  if (applyToAll) {
    const { source, configs } = await readTenantWarmupConfigs(clientId);
    if (source === "table") {
      for (const cfg of Object.values(configs)) {
        const patch: WarmupConfigPatch = {
          stage_auto_progress: merged.stage_auto_progress,
          continuous_warmup: merged.continuous_warmup,
          min_interval_seconds: merged.min_interval_seconds,
          max_interval_seconds: merged.max_interval_seconds,
          min_typing_seconds: merged.min_typing_seconds,
          max_typing_seconds: merged.max_typing_seconds,
          allowed_start_hour: merged.allowed_start_hour,
          allowed_end_hour: merged.allowed_end_hour,
          ai_model: merged.ai_model,
          ai_theme: merged.ai_theme,
          enable_typing: merged.enable_typing,
          enable_blue_ticks: merged.enable_blue_ticks,
          enable_reactions: merged.enable_reactions,
          enable_audio: merged.enable_audio,
          enable_vcard: merged.enable_vcard,
          enable_status_posts: merged.enable_status_posts,
          custom_prompt: merged.custom_prompt || null,
        };
        await supabaseAdmin
          .from("whatsapp_warmup_configs")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("client_id", clientId)
          .eq("instance_name", cfg.instance_name);
      }
    }
  }

  return merged;
}

/**
 * Salva apenas campos editáveis. Usa a tabela como fonte quando disponível;
 * caso contrário mantém o fallback em app_settings (banco sem migration).
 */
export async function saveWarmupConfig(
  clientId: string,
  instanceName: string,
  rawPatch: Record<string, unknown>
): Promise<{ ok: boolean; config?: WarmupConfig; error?: string }> {
  const name = String(instanceName || "").trim();
  if (!name) return { ok: false, error: "instance_name é obrigatório" };

  const patch = sanitizeWarmupPatch(rawPatch);
  const nowIso = new Date().toISOString();

  try {
    const { error } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .upsert(
        {
          ...patch,
          client_id: clientId,
          instance_name: name,
          updated_at: nowIso,
        },
        { onConflict: "client_id,instance_name" }
      );

    if (!error) {
      return {
        ok: true,
        config: { client_id: clientId, instance_name: name, ...patch } as WarmupConfig,
      };
    }

    if (!isMissingTableError(error)) {
      return { ok: false, error: error.message || "Falha ao salvar configuração" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  try {
    const current = await readSettingsConfigs(clientId);
    current[name] = {
      ...(current[name] || {}),
      ...patch,
      client_id: clientId,
      instance_name: name,
      updated_at: nowIso,
    } as WarmupConfig;

    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `warmup_configs_${clientId}`,
          value: JSON.stringify(current),
          updated_at: nowIso,
        },
        { onConflict: "key" }
      );

    return { ok: true, config: current[name] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Ativa/pausa todos os chips do tenant. Cria configs para chips conectados
 * que ainda não tinham linha, para que "Aquecer todos" inclua número novo.
 */
export async function setWarmupEnabledForAll(
  clientId: string,
  enabled: boolean
): Promise<{ updated: number; source: WarmupConfigSource }> {
  await ensureWarmupConfigsForTenant(clientId);

  const { source, configs } = await readTenantWarmupConfigs(clientId);
  const nowIso = new Date().toISOString();
  let updated = 0;

  if (source === "table") {
    const { error } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .update({ enabled, updated_at: nowIso })
      .eq("client_id", clientId);
    if (!error) updated = Object.keys(configs).length;
  } else {
    for (const cfg of Object.values(configs)) {
      const res = await saveWarmupConfig(clientId, cfg.instance_name, { enabled });
      if (res.ok) updated++;
    }
  }

  return { updated, source };
}

function buildNewWarmupConfig(
  clientId: string,
  connection: TenantConnection,
  global: GlobalWarmupSettings
): WarmupConfig {
  const stageDefaults = STAGE_DEFAULTS[1];
  return {
    client_id: clientId,
    instance_name: connection.instance_name,
    phone_number: connection.phone_number,
    enabled: global.auto_warmup_new_chips !== false,
    stage: 1,
    stage_auto_progress: global.stage_auto_progress !== false,
    days_active: 1,
    consecutive_successful_days: 0,
    health_score: 100,
    is_quarantined: false,
    quarantine_reason: null,
    quarantine_until: null,
    purpose: "contingency",
    profile_hydrated: false,
    group_auto_join: true,
    swarm_active: true,
    max_groups_per_chip: 10,
    daily_target: stageDefaults.dailyTarget,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    last_activity_at: null,
    last_status_post_at: null,
    vcard_exchanged_peers: [],
    min_interval_seconds: stageDefaults.minInterval,
    max_interval_seconds: stageDefaults.maxInterval,
    min_typing_seconds: global.min_typing_seconds,
    max_typing_seconds: global.max_typing_seconds,
    allowed_start_hour: global.allowed_start_hour,
    allowed_end_hour: global.allowed_end_hour,
    ai_model: global.ai_model,
    ai_theme: global.ai_theme,
    enable_typing: global.enable_typing,
    enable_blue_ticks: global.enable_blue_ticks,
    enable_reactions: global.enable_reactions,
    enable_audio: global.enable_audio,
    enable_vcard: global.enable_vcard,
    enable_status_posts: global.enable_status_posts,
    continuous_warmup: global.continuous_warmup,
    custom_prompt: global.custom_prompt || null,
  };
}

/**
 * Cadastra automaticamente chips conectados que ainda não têm config.
 * Nunca sobrescreve config existente: chip pausado continua pausado.
 */
export async function ensureWarmupConfigsForTenant(
  clientId: string,
  opts?: { connections?: TenantConnection[] }
): Promise<{ created: string[]; enabledNew: string[]; source: WarmupConfigSource; connections: TenantConnection[] }> {
  const connections = opts?.connections ?? (await readTenantConnections(clientId));
  const { source, configs } = await readTenantWarmupConfigs(clientId);

  const created: string[] = [];
  const enabledNew: string[] = [];

  if (source !== "table") {
    return { created, enabledNew, source, connections };
  }

  const global = await getGlobalWarmupSettings(clientId);
  const connected = connections.filter((c) => isConnectedStatus(c.status));

  for (const connection of connected) {
    const existing = configs[connection.instance_name];

    if (!existing) {
      const row = buildNewWarmupConfig(clientId, connection, global);
      try {
        const { error } = await supabaseAdmin
          .from("whatsapp_warmup_configs")
          .upsert(row, { onConflict: "client_id,instance_name", ignoreDuplicates: true });
        if (!error) {
          created.push(connection.instance_name);
          if (row.enabled) enabledNew.push(connection.instance_name);
        }
      } catch {
        /* melhor deixar para o próximo tick do que derrubar o worker */
      }
      continue;
    }

    if (!existing.phone_number && connection.phone_number) {
      try {
        await supabaseAdmin
          .from("whatsapp_warmup_configs")
          .update({ phone_number: connection.phone_number, updated_at: new Date().toISOString() })
          .eq("client_id", clientId)
          .eq("instance_name", connection.instance_name);
      } catch {
        /* opcional */
      }
    }
  }

  return { created, enabledNew, source, connections };
}

/**
 * Lista tenants que possuem config de warmup ou conexão WhatsApp.
 */
export async function listWarmupTenantIds(): Promise<string[]> {
  const ids = new Set<string>();

  try {
    const { data } = await supabaseAdmin.from("whatsapp_warmup_configs").select("client_id");
    for (const row of data || []) {
      if (row?.client_id) ids.add(String(row.client_id));
    }
  } catch {
    /* ignore */
  }

  try {
    const { data } = await supabaseAdmin.from("channel_connections").select("client_id");
    for (const row of data || []) {
      if (row?.client_id) ids.add(String(row.client_id));
    }
  } catch {
    /* ignore */
  }

  return Array.from(ids);
}

/**
 * Meta diária efetiva: menor valor entre a meta da fase e o teto da finalidade.
 * Evita que um chip "contingência" (20/dia) dispare como outbound (70/dia).
 */
export function getEffectiveDailyTarget(config: WarmupConfig): number {
  const stageTarget =
    config.daily_target || STAGE_DEFAULTS[(config.stage || 1) as WarmupStage].dailyTarget;
  const purposeCap = PURPOSE_METADATA[config.purpose || "outbound"]?.dailyCap ?? stageTarget;
  return Math.max(1, Math.min(stageTarget, purposeCap));
}

const DAILY_STATE_PREFIX = "warmup_daily_state_";
const TICK_LOCK_PREFIX = "warmup_tick_lock_";
const TICK_LOCK_STALE_MS = 2 * 60 * 1000;

/**
 * Lock distribuído por tenant para impedir que dois processos (dev + produção,
 * ou duas réplicas serverless) enviem mensagens duplicadas no mesmo minuto.
 * Usa o PRIMARY KEY de app_settings como mutex atômico (insert falha se existir).
 */
export async function acquireWarmupTickLock(
  clientId: string,
  owner: string
): Promise<boolean> {
  const key = `${TICK_LOCK_PREFIX}${clientId}`;
  try {
    const { error } = await supabaseAdmin
      .from("app_settings")
      .insert({ key, value: JSON.stringify({ owner, at: Date.now() }) });

    if (!error) return true;

    // 23505 = unique_violation: outro processo está com o lock.
    if ((error as { code?: string }).code !== "23505") return true;

    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    let parsed: { owner?: string; at?: number } = {};
    try {
      parsed = data?.value ? JSON.parse(data.value) : {};
    } catch {
      parsed = {};
    }

    if (parsed.owner === owner) return true;
    const age = Date.now() - Number(parsed.at || 0);
    if (!Number.isFinite(age) || age > TICK_LOCK_STALE_MS) {
      // Lock órfão (processo caiu): assume o controle.
      await supabaseAdmin
        .from("app_settings")
        .update({ value: JSON.stringify({ owner, at: Date.now() }) })
        .eq("key", key);
      return true;
    }

    return false;
  } catch {
    // Sem app_settings não há como travar; não bloqueia o aquecimento.
    return true;
  }
}

export async function releaseWarmupTickLock(clientId: string, owner: string): Promise<void> {
  const key = `${TICK_LOCK_PREFIX}${clientId}`;
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    let parsed: { owner?: string } = {};
    try {
      parsed = data?.value ? JSON.parse(data.value) : {};
    } catch {
      parsed = {};
    }

    if (parsed.owner !== owner) return;

    await supabaseAdmin.from("app_settings").delete().eq("key", key);
  } catch {
    /* lock expira sozinho pelo TTL */
  }
}

export async function readDailyResetState(clientId: string): Promise<Record<string, string>> {
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `${DAILY_STATE_PREFIX}${clientId}`)
      .maybeSingle();

    if (!data?.value) return {};
    const parsed = JSON.parse(data.value) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeDailyResetState(
  clientId: string,
  state: Record<string, string>
): Promise<void> {
  try {
    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `${DAILY_STATE_PREFIX}${clientId}`,
          value: JSON.stringify(state),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
  } catch {
    /* próximo tick tenta de novo */
  }
}
