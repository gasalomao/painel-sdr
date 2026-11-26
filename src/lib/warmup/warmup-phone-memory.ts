/**
 * Memória Permanente por Telefone (Passaporte do Chip) & Utilitários de Concorrência.
 *
 * Garante que qualquer número de WhatsApp preserve sua fase de aquecimento,
 * dias ativos reais, finalidade, saúde e histórico de contatos mesmo quando:
 * - A instância desconecta e reconecta dias depois;
 * - A instância é deletada/recriada com outro `instance_name` (mesmo telefone);
 * - O status no banco fica preso em "connecting" / "close" / "disconnected".
 *
 * Persistência 100% compatível com o schema atual (via `app_settings` + `whatsapp_warmup_configs`).
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import { extractDigits, getBrazilPhoneVariants } from "@/lib/jid-utils";
import type {
  ExternalWarmupMode,
  WarmupCareerMode,
  WarmupConfig,
  WarmupPurpose,
  WarmupStage,
} from "./warmup-types";
import { STAGE_DEFAULTS } from "./warmup-types";

const PHONE_MEMORY_PREFIX = "warmup_phone_memory_";
const PHONE_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const OFFLINE_SOFT_RECOVERY_THRESHOLD_MS = 48 * 60 * 60 * 1000;
export const POST_BAN_REHAB_HOURS = 72;
export const POST_BAN_COLD_LOCK_HOURS = 96;

export interface WarmupPhoneMemoryEntry {
  canonicalPhone: string;
  phoneNumber: string;
  lastInstanceName: string;
  enabled: boolean;
  stage: WarmupStage;
  daysActive: number;
  consecutiveSuccessfulDays: number;
  healthScore: number;
  purpose: WarmupPurpose;
  dailyTarget: number;
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  minTypingSeconds: number;
  maxTypingSeconds: number;
  allowedStartHour: number;
  allowedEndHour: number;
  aiModel: string;
  aiTheme: string;
  customPrompt: string | null;
  enableTyping: boolean;
  enableBlueTicks: boolean;
  enableReactions: boolean;
  enableAudio: boolean;
  enableVcard: boolean;
  enableStatusPosts: boolean;
  continuousWarmup: boolean;
  groupAutoJoin: boolean;
  swarmActive: boolean;
  maxGroupsPerChip: number;
  vcardExchangedPeers: string[];
  lastStatusPostAt: string | null;
  profileHydrated: boolean;
  firstSeenAt: string;
  lastActivityAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  softRecoveryUntil: string | null;
  disconnectCount24h: number;
  flapTimestamps?: number[];
  lastDisconnectReason: string | null;
  careerMode?: WarmupCareerMode;
  banCount?: number;
  lastBanAt?: string | null;
  lastBanReason?: string | null;
  rehabUntil?: string | null;
  coldOutreachLockedUntil?: string | null;
  externalWarmupMode?: ExternalWarmupMode;
  externalWarmupInboundTotal?: number;
  externalWarmupInboundToday?: number;
  externalMmzapSentTotal?: number;
  externalMmzapSentToday?: number;
  externalWarmupLastAt?: string | null;
  previousInstances?: string[];
  updatedAt: string;
}

const _tenantMemoryQueues = new Map<string, Promise<unknown>>();
const _runtimeReconnectFlaps = new Map<string, number[]>();

/**
 * Executa uma lista de tarefas assíncronas com concorrência limitada,
 * impedindo sobrecarga em PostgreSQL/Evolution API quando há dezenas ou centenas de chips.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Limita o tamanho de Maps em memória para evitar vazamento em execução contínua multi-tenant.
 */
export function pruneMapToLimit<K, V>(map: Map<K, V>, maxEntries = 5000): void {
  if (map.size <= maxEntries) return;
  const excess = map.size - maxEntries;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed++;
    if (removed >= excess) break;
  }
}

function enqueueTenantMemoryOp<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
  pruneMapToLimit(_tenantMemoryQueues, 2000);
  const prev = _tenantMemoryQueues.get(clientId) || Promise.resolve();
  const next = prev.then(fn, fn);
  _tenantMemoryQueues.set(clientId, next);
  return next;
}

/**
 * Normaliza telefone brasileiro/internacional para uma chave canônica estável.
 * Para celulares BR (DDI 55 + DDD + 8/9 dígitos), prioriza a forma de 13 dígitos (com 9º dígito).
 */
export function canonicalBrazilPhoneKey(phoneOrJid?: string | null): string {
  const digits = extractDigits(phoneOrJid);
  if (!digits || digits.length < 10) return "";
  const variants = getBrazilPhoneVariants(digits);
  const br13 = variants.find((v) => /^55[1-9]\d9[6-9]\d{7}$/.test(v));
  if (br13) return br13;
  const with55 = variants.find((v) => v.startsWith("55") && v.length >= 12);
  if (with55) return with55;
  return digits;
}

function samePhone(a?: string | null, b?: string | null): boolean {
  const ca = canonicalBrazilPhoneKey(a);
  const cb = canonicalBrazilPhoneKey(b);
  if (ca && cb && ca === cb) return true;
  if (!a || !b) return false;
  const va = new Set(getBrazilPhoneVariants(a));
  return getBrazilPhoneVariants(b).some((v) => va.has(v));
}

export async function readPhoneMemoryMap(
  clientId: string
): Promise<Record<string, WarmupPhoneMemoryEntry>> {
  if (!clientId) return {};
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `${PHONE_MEMORY_PREFIX}${clientId}`)
      .maybeSingle();

    if (!data?.value) return {};
    const parsed = JSON.parse(data.value) as Record<string, WarmupPhoneMemoryEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Remove entradas antigas/órfãs (> `maxIdleDays` sem atividade) e limita o total
 * de chips no JSON do passaporte por tenant, evitando crescimento ilimitado em `app_settings`.
 */
export function prunePhoneMemoryMap(
  map: Record<string, WarmupPhoneMemoryEntry>,
  maxEntries = 200,
  maxIdleDays = 120,
  nowMs = Date.now()
): boolean {
  const keys = Object.keys(map);
  if (keys.length === 0) return false;

  let changed = false;
  const maxIdleMs = Math.max(1, maxIdleDays) * 24 * 60 * 60 * 1000;

  for (const k of keys) {
    const entry = map[k];
    if (!entry) {
      delete map[k];
      changed = true;
      continue;
    }
    const refIso = entry.lastActivityAt || entry.lastConnectedAt || entry.updatedAt;
    const refMs = refIso ? new Date(refIso).getTime() : NaN;
    if (Number.isFinite(refMs) && nowMs - refMs > maxIdleMs) {
      delete map[k];
      changed = true;
    }
  }

  const remaining = Object.entries(map);
  if (remaining.length > maxEntries) {
    remaining.sort((a, b) => {
      const ta = new Date(a[1]?.updatedAt || a[1]?.lastActivityAt || 0).getTime() || 0;
      const tb = new Date(b[1]?.updatedAt || b[1]?.lastActivityAt || 0).getTime() || 0;
      return tb - ta;
    });
    for (let i = maxEntries; i < remaining.length; i++) {
      delete map[remaining[i][0]];
      changed = true;
    }
  }

  return changed;
}

async function writePhoneMemoryMap(
  clientId: string,
  map: Record<string, WarmupPhoneMemoryEntry>
): Promise<void> {
  try {
    prunePhoneMemoryMap(map);
    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `${PHONE_MEMORY_PREFIX}${clientId}`,
          value: JSON.stringify(map),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
  } catch {
    /* persistência best-effort sem derrubar o worker */
  }
}

function buildEntryFromConfig(
  cfg: Partial<WarmupConfig> & { instance_name: string },
  phone: string,
  prev?: WarmupPhoneMemoryEntry | null,
  extra?: Partial<WarmupPhoneMemoryEntry>
): WarmupPhoneMemoryEntry {
  const nowIso = new Date().toISOString();
  const canonical = canonicalBrazilPhoneKey(phone);
  const stage = (Math.max(1, Math.min(4, Number(cfg.stage || prev?.stage || 1))) || 1) as WarmupStage;
  const defaults = STAGE_DEFAULTS[stage];
  const mergedVcardPeers = Array.from(
    new Set([
      ...(prev?.vcardExchangedPeers || []),
      ...(Array.isArray(cfg.vcard_exchanged_peers) ? cfg.vcard_exchanged_peers : []),
    ])
  );

  // Nunca regride `daysActive` acidentalmente ao salvar a partir de uma linha recém-criada.
  const cfgDays = Number(cfg.days_active || 1);
  const prevDays = Number(prev?.daysActive || 1);
  const effectiveDays = Math.max(cfgDays, prevDays);
  const effectiveStage = (
    cfg.instance_name === prev?.lastInstanceName
      ? stage
      : Math.max(stage, Number(prev?.stage || 1))
  ) as WarmupStage;

  const firstSeenAt = (() => {
    const candidates = [prev?.firstSeenAt, cfg.created_at].filter(Boolean) as string[];
    if (candidates.length === 0) return nowIso;
    return candidates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
  })();

  return {
    canonicalPhone: canonical,
    phoneNumber: extractDigits(phone) || prev?.phoneNumber || canonical,
    lastInstanceName: cfg.instance_name || prev?.lastInstanceName || "",
    enabled: cfg.enabled !== undefined ? Boolean(cfg.enabled) : (prev?.enabled ?? true),
    stage: effectiveStage,
    daysActive: effectiveDays,
    consecutiveSuccessfulDays:
      cfg.consecutive_successful_days !== undefined
        ? Math.max(
          Number(cfg.consecutive_successful_days || 0),
          cfg.instance_name === prev?.lastInstanceName ? 0 : Number(prev?.consecutiveSuccessfulDays || 0)
        )
        : (prev?.consecutiveSuccessfulDays ?? 0),
    healthScore:
      cfg.health_score !== undefined
        ? Number(cfg.health_score)
        : (prev?.healthScore ?? 100),
    purpose: (cfg.purpose || prev?.purpose || "contingency") as WarmupPurpose,
    dailyTarget: Number(cfg.daily_target || prev?.dailyTarget || defaults.dailyTarget),
    minIntervalSeconds: Number(cfg.min_interval_seconds || prev?.minIntervalSeconds || defaults.minInterval),
    maxIntervalSeconds: Number(cfg.max_interval_seconds || prev?.maxIntervalSeconds || defaults.maxInterval),
    minTypingSeconds: Number(cfg.min_typing_seconds || prev?.minTypingSeconds || 3),
    maxTypingSeconds: Number(cfg.max_typing_seconds || prev?.maxTypingSeconds || 8),
    allowedStartHour: Number(cfg.allowed_start_hour ?? prev?.allowedStartHour ?? 8),
    allowedEndHour: Number(cfg.allowed_end_hour ?? prev?.allowedEndHour ?? 21),
    aiModel: String(cfg.ai_model || prev?.aiModel || "fallback"),
    aiTheme: String(cfg.ai_theme || prev?.aiTheme || "dia_a_dia"),
    customPrompt: cfg.custom_prompt !== undefined ? (cfg.custom_prompt ?? null) : (prev?.customPrompt ?? null),
    enableTyping: cfg.enable_typing !== undefined ? Boolean(cfg.enable_typing) : (prev?.enableTyping ?? true),
    enableBlueTicks: cfg.enable_blue_ticks !== undefined ? Boolean(cfg.enable_blue_ticks) : (prev?.enableBlueTicks ?? true),
    enableReactions: cfg.enable_reactions !== undefined ? Boolean(cfg.enable_reactions) : (prev?.enableReactions ?? true),
    enableAudio: cfg.enable_audio !== undefined ? Boolean(cfg.enable_audio) : (prev?.enableAudio ?? true),
    enableVcard: cfg.enable_vcard !== undefined ? Boolean(cfg.enable_vcard) : (prev?.enableVcard ?? true),
    enableStatusPosts: cfg.enable_status_posts !== undefined ? Boolean(cfg.enable_status_posts) : (prev?.enableStatusPosts ?? true),
    continuousWarmup: cfg.continuous_warmup !== undefined ? Boolean(cfg.continuous_warmup) : (prev?.continuousWarmup ?? true),
    groupAutoJoin: cfg.group_auto_join !== undefined ? Boolean(cfg.group_auto_join) : (prev?.groupAutoJoin ?? true),
    swarmActive: cfg.swarm_active !== undefined ? Boolean(cfg.swarm_active) : (prev?.swarmActive ?? true),
    maxGroupsPerChip: Number(cfg.max_groups_per_chip ?? prev?.maxGroupsPerChip ?? 10),
    vcardExchangedPeers: mergedVcardPeers,
    lastStatusPostAt: cfg.last_status_post_at || prev?.lastStatusPostAt || null,
    profileHydrated: cfg.profile_hydrated !== undefined ? Boolean(cfg.profile_hydrated) : (prev?.profileHydrated ?? false),
    firstSeenAt,
    lastActivityAt: cfg.last_activity_at || prev?.lastActivityAt || null,
    lastConnectedAt: extra?.lastConnectedAt !== undefined ? extra.lastConnectedAt : (prev?.lastConnectedAt ?? null),
    lastDisconnectedAt: extra?.lastDisconnectedAt !== undefined ? extra.lastDisconnectedAt : (prev?.lastDisconnectedAt ?? null),
    softRecoveryUntil: extra?.softRecoveryUntil !== undefined ? extra.softRecoveryUntil : (prev?.softRecoveryUntil ?? null),
    disconnectCount24h: extra?.disconnectCount24h !== undefined ? extra.disconnectCount24h : (prev?.disconnectCount24h ?? 0),
    flapTimestamps:
      extra?.flapTimestamps !== undefined
        ? extra.flapTimestamps
        : Array.isArray(prev?.flapTimestamps)
          ? [...prev.flapTimestamps]
          : undefined,
    lastDisconnectReason: extra?.lastDisconnectReason !== undefined ? extra.lastDisconnectReason : (prev?.lastDisconnectReason ?? null),
    careerMode: (extra?.careerMode ?? cfg.career_mode ?? prev?.careerMode ?? "maturing") as WarmupCareerMode,
    banCount: extra?.banCount !== undefined ? extra.banCount : (prev?.banCount ?? 0),
    lastBanAt: extra?.lastBanAt !== undefined ? extra.lastBanAt : (prev?.lastBanAt ?? null),
    lastBanReason: extra?.lastBanReason !== undefined ? extra.lastBanReason : (prev?.lastBanReason ?? null),
    rehabUntil: extra?.rehabUntil !== undefined ? extra.rehabUntil : (cfg.rehab_until ?? prev?.rehabUntil ?? null),
    coldOutreachLockedUntil:
      extra?.coldOutreachLockedUntil !== undefined
        ? extra.coldOutreachLockedUntil
        : (cfg.cold_outreach_locked_until ?? prev?.coldOutreachLockedUntil ?? null),
    externalWarmupMode: (
      extra?.externalWarmupMode ??
      cfg.external_warmup_mode ??
      prev?.externalWarmupMode ??
      "off"
    ) as ExternalWarmupMode,
    externalWarmupInboundTotal:
      extra?.externalWarmupInboundTotal !== undefined
        ? extra.externalWarmupInboundTotal
        : Math.max(Number(cfg.external_warmup_inbound_total || 0), Number(prev?.externalWarmupInboundTotal || 0)),
    externalWarmupInboundToday:
      extra?.externalWarmupInboundToday !== undefined
        ? extra.externalWarmupInboundToday
        : Number(cfg.external_warmup_inbound_today ?? prev?.externalWarmupInboundToday ?? 0),
    externalMmzapSentTotal:
      extra?.externalMmzapSentTotal !== undefined
        ? extra.externalMmzapSentTotal
        : Math.max(Number(cfg.external_mmzap_sent_total || 0), Number(prev?.externalMmzapSentTotal || 0)),
    externalMmzapSentToday:
      extra?.externalMmzapSentToday !== undefined
        ? extra.externalMmzapSentToday
        : Number(cfg.external_mmzap_sent_today ?? prev?.externalMmzapSentToday ?? 0),
    externalWarmupLastAt:
      extra?.externalWarmupLastAt !== undefined
        ? extra.externalWarmupLastAt
        : (cfg.external_warmup_last_at ?? prev?.externalWarmupLastAt ?? null),
    previousInstances: Array.from(
      new Set(
        [
          ...(prev?.previousInstances || []),
          prev?.lastInstanceName || "",
          cfg.instance_name || "",
        ].filter(Boolean)
      )
    ).slice(-15),
    updatedAt: nowIso,
  };
}

/**
 * Persiste o passaporte vitalício do número na tabela `whatsapp_phone_passports` (Migration 031).
 * Falha silenciosamente caso a migration ainda não tenha sido aplicada no banco.
 */
export async function syncPhonePassportRow(
  clientId: string,
  entry: WarmupPhoneMemoryEntry
): Promise<void> {
  if (!clientId || !entry?.canonicalPhone) return;
  const payload = {
    client_id: clientId,
    canonical_phone: entry.canonicalPhone,
    current_instance_name: entry.lastInstanceName || null,
    previous_instances: entry.previousInstances || [],
    stage: entry.stage,
    days_active: entry.daysActive,
    health_score: entry.healthScore,
    career_mode: entry.careerMode || "maturing",
    ban_count: entry.banCount || 0,
    last_ban_at: entry.lastBanAt || null,
    last_ban_reason: entry.lastBanReason || null,
    rehab_until: entry.rehabUntil || null,
    cold_outreach_locked_until: entry.coldOutreachLockedUntil || null,
    external_warmup_mode: entry.externalWarmupMode || "off",
    external_warmup_inbound_total: entry.externalWarmupInboundTotal || 0,
    external_warmup_inbound_today: entry.externalWarmupInboundToday || 0,
    external_mmzap_sent_total: entry.externalMmzapSentTotal || 0,
    external_mmzap_sent_today: entry.externalMmzapSentToday || 0,
    external_warmup_last_at: entry.externalWarmupLastAt || null,
    updated_at: entry.updatedAt || new Date().toISOString(),
  };

  try {
    const { error } = await supabaseAdmin
      .from("whatsapp_phone_passports")
      .upsert(payload, { onConflict: "client_id,canonical_phone" });

    if (
      error &&
      (error.code === "42703" ||
        error.code === "PGRST204" ||
        String(error.message || "").includes("external_mmzap_sent_"))
    ) {
      const {
        external_mmzap_sent_total: _omitTotal,
        external_mmzap_sent_today: _omitToday,
        ...legacyPayload
      } = payload;
      void _omitTotal;
      void _omitToday;
      await supabaseAdmin
        .from("whatsapp_phone_passports")
        .upsert(legacyPayload, { onConflict: "client_id,canonical_phone" });
    }
  } catch {
    /* fail-open antes da migration 031/032 */
  }
}

export async function savePhoneMemoryFromConfig(
  clientId: string,
  cfg: Partial<WarmupConfig> & { instance_name: string },
  extra?: Partial<WarmupPhoneMemoryEntry>
): Promise<WarmupPhoneMemoryEntry | null> {
  const canonical = canonicalBrazilPhoneKey(cfg.phone_number);
  if (!clientId || !canonical) return null;

  return enqueueTenantMemoryOp(clientId, async () => {
    const map = await readPhoneMemoryMap(clientId);
    const prev = map[canonical] || null;
    const entry = buildEntryFromConfig(cfg, cfg.phone_number!, prev, extra);
    map[canonical] = entry;
    await writePhoneMemoryMap(clientId, map);
    await syncPhonePassportRow(clientId, entry);
    return entry;
  });
}

export async function findPhoneMemory(
  clientId: string,
  phone?: string | null
): Promise<WarmupPhoneMemoryEntry | null> {
  const canonical = canonicalBrazilPhoneKey(phone);
  if (!clientId || !canonical) return null;

  const map = await readPhoneMemoryMap(clientId);
  if (map[canonical]) return map[canonical];

  for (const variant of getBrazilPhoneVariants(phone)) {
    const varKey = canonicalBrazilPhoneKey(variant);
    if (varKey && map[varKey]) return map[varKey];
    if (map[variant]) return map[variant];
  }

  // Fallback Passaporte SQL (Migration 031): preserva histórico mesmo se app_settings falhar
  try {
    const { data: passportRow } = await supabaseAdmin
      .from("whatsapp_phone_passports")
      .select("*")
      .eq("client_id", clientId)
      .eq("canonical_phone", canonical)
      .maybeSingle();

    if (passportRow) {
      const p = passportRow as Record<string, unknown>;
      return buildEntryFromConfig(
        {
          instance_name: String(p.current_instance_name || ""),
          phone_number: canonical,
          stage: (Number(p.stage || 1) as WarmupStage),
          days_active: Number(p.days_active || 1),
          health_score: Number(p.health_score ?? 100),
          career_mode: (p.career_mode as WarmupCareerMode) || "maturing",
          rehab_until: (p.rehab_until as string | null) ?? null,
          cold_outreach_locked_until: (p.cold_outreach_locked_until as string | null) ?? null,
          external_warmup_mode: (p.external_warmup_mode as ExternalWarmupMode) || "off",
          external_warmup_inbound_today: Number(p.external_warmup_inbound_today || 0),
          external_warmup_inbound_total: Number(p.external_warmup_inbound_total || 0),
          external_mmzap_sent_today: Number(p.external_mmzap_sent_today || 0),
          external_mmzap_sent_total: Number(p.external_mmzap_sent_total || 0),
          external_warmup_last_at: (p.external_warmup_last_at as string | null) ?? null,
        },
        phone!,
        null,
        {
          banCount: Number(p.ban_count || 0),
          lastBanAt: (p.last_ban_at as string | null) ?? null,
          lastBanReason: (p.last_ban_reason as string | null) ?? null,
          previousInstances: Array.isArray(p.previous_instances)
            ? (p.previous_instances as string[])
            : [],
        }
      );
    }
  } catch {
    /* tabela ainda não criada antes da migration 031 */
  }

  // Fallback legado: procura diretamente em linhas antigas de whatsapp_warmup_configs
  try {
    const { data: rows } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("*")
      .eq("client_id", clientId);

    if (Array.isArray(rows) && rows.length > 0) {
      const matches = (rows as WarmupConfig[])
        .filter((r) => samePhone(r.phone_number, phone))
        .sort((a, b) => (b.days_active || 1) - (a.days_active || 1) || (b.stage || 1) - (a.stage || 1));

      if (matches[0]) {
        return buildEntryFromConfig(matches[0], phone!);
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

export async function removePhoneMemory(clientId: string, phone?: string | null): Promise<void> {
  const canonical = canonicalBrazilPhoneKey(phone);
  if (!clientId || !canonical) return;
  await enqueueTenantMemoryOp(clientId, async () => {
    const map = await readPhoneMemoryMap(clientId);
    let changed = false;
    if (map[canonical]) {
      delete map[canonical];
      changed = true;
    }
    for (const v of getBrazilPhoneVariants(phone)) {
      if (map[v]) {
        delete map[v];
        changed = true;
      }
    }
    if (changed) {
      await writePhoneMemoryMap(clientId, map);
    }
  });
}

/**
 * Registra queda/reconexão no histórico em RAM e no passaporte do número quando aplicável.
 */
export function recordSocketFlapInMemory(clientId: string, instanceName: string, nowMs = Date.now()): number {
  pruneMapToLimit(_runtimeReconnectFlaps, 3000);
  const key = `${clientId}:${instanceName}`;
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  const list = (_runtimeReconnectFlaps.get(key) || []).filter((ts) => ts >= cutoff);
  list.push(nowMs);
  _runtimeReconnectFlaps.set(key, list);
  return list.length;
}

export function getRecentSocketFlapCount(clientId: string, instanceName: string, nowMs = Date.now()): number {
  const key = `${clientId}:${instanceName}`;
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  return (_runtimeReconnectFlaps.get(key) || []).filter((ts) => ts >= cutoff).length;
}

export function resetPhoneMemoryRuntimeForTests(): void {
  _tenantMemoryQueues.clear();
  _runtimeReconnectFlaps.clear();
}

export function getPersistedFlapCount24h(
  memory?: WarmupPhoneMemoryEntry | null,
  nowMs = Date.now()
): number {
  if (!memory) return 0;
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  if (Array.isArray(memory.flapTimestamps) && memory.flapTimestamps.length > 0) {
    return memory.flapTimestamps.filter((ts) => Number.isFinite(ts) && ts >= cutoff).length;
  }
  if (
    memory.lastDisconnectedAt &&
    new Date(memory.lastDisconnectedAt).getTime() >= cutoff &&
    typeof memory.disconnectCount24h === "number"
  ) {
    return memory.disconnectCount24h;
  }
  return 0;
}

export function markPhoneDisconnected(
  clientId: string,
  instanceName: string,
  reason?: string | null,
  nowMs = Date.now()
): void {
  const flapCount = recordSocketFlapInMemory(clientId, instanceName, nowMs);
  void enqueueTenantMemoryOp(clientId, async () => {
    const map = await readPhoneMemoryMap(clientId);
    const entry = Object.values(map).find((e) => e.lastInstanceName === instanceName);
    if (!entry) return;
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    const prevList = Array.isArray(entry.flapTimestamps)
      ? entry.flapTimestamps.filter((ts) => Number.isFinite(ts) && ts >= cutoff)
      : [];
    prevList.push(nowMs);
    if (prevList.length > 50) prevList.splice(0, prevList.length - 50);

    entry.flapTimestamps = prevList;
    entry.lastDisconnectedAt = new Date(nowMs).toISOString();
    entry.disconnectCount24h = Math.max(flapCount, prevList.length);
    entry.lastDisconnectReason = reason ? String(reason).slice(0, 200) : entry.lastDisconnectReason;
    entry.updatedAt = new Date(nowMs).toISOString();
    map[entry.canonicalPhone] = entry;
    await writePhoneMemoryMap(clientId, map);
  }).catch(() => { });
}

/**
 * Avalia se o chip deve operar em marcha de retomada suave (50% da meta diária)
 * por ter voltado de quarentena ou de uma desconexão prolongada (> 48h).
 */
export function isChipInSoftRecovery(
  cfg: WarmupConfig,
  memory?: WarmupPhoneMemoryEntry | null,
  nowMs = Date.now()
): boolean {
  if (memory?.softRecoveryUntil) {
    const untilMs = new Date(memory.softRecoveryUntil).getTime();
    if (Number.isFinite(untilMs) && untilMs > nowMs) return true;
  }
  if ((cfg.health_score ?? 100) <= 65 && cfg.quarantine_until) {
    const qUntilMs = new Date(cfg.quarantine_until).getTime();
    if (Number.isFinite(qUntilMs) && qUntilMs <= nowMs && nowMs - qUntilMs <= PHONE_RECOVERY_WINDOW_MS) {
      return true;
    }
  }
  return false;
}

/**
 * Aplica dados restaurados do Passaporte do Telefone sobre uma nova config recém-criada.
 */
export function applyPhoneMemoryToNewConfig(
  base: WarmupConfig,
  memory: WarmupPhoneMemoryEntry,
  nowIso = new Date().toISOString()
): { config: WarmupConfig; softRecoveryActivated: boolean } {
  const nowMs = new Date(nowIso).getTime();
  const stage = (Math.max(1, Math.min(4, Number(memory.stage || 1))) || 1) as WarmupStage;
  const stageDefaults = STAGE_DEFAULTS[stage];

  const lastSeenRef = memory.lastDisconnectedAt || memory.lastActivityAt || memory.lastConnectedAt || memory.updatedAt;
  const offlineMs = lastSeenRef ? Math.max(0, nowMs - new Date(lastSeenRef).getTime()) : 0;
  const existingRecoveryActive = Boolean(
    memory.softRecoveryUntil && new Date(memory.softRecoveryUntil).getTime() > nowMs
  );
  const softRecoveryActivated = offlineMs >= OFFLINE_SOFT_RECOVERY_THRESHOLD_MS || existingRecoveryActive;

  const rehabActive = Boolean(memory.rehabUntil && new Date(memory.rehabUntil).getTime() > nowMs);
  const restoredCareerMode: WarmupCareerMode = rehabActive
    ? "rehab"
    : ((memory.careerMode || base.career_mode || "maturing") as WarmupCareerMode);

  const restored: WarmupConfig = {
    ...base,
    phone_number: extractDigits(base.phone_number || memory.phoneNumber) || memory.phoneNumber,
    enabled: memory.enabled !== undefined ? memory.enabled : base.enabled,
    stage,
    days_active: Math.max(1, Number(memory.daysActive || 1)),
    consecutive_successful_days: Math.max(0, Number(memory.consecutiveSuccessfulDays || 0)),
    health_score: Math.max(rehabActive ? 35 : 60, Math.min(100, Number(memory.healthScore || 85))),
    purpose: (memory.purpose || "contingency") as WarmupPurpose,
    daily_target: Number(memory.dailyTarget || stageDefaults.dailyTarget),
    min_interval_seconds: Number(memory.minIntervalSeconds || stageDefaults.minInterval),
    max_interval_seconds: Number(memory.maxIntervalSeconds || stageDefaults.maxInterval),
    min_typing_seconds: Number(memory.minTypingSeconds || base.min_typing_seconds),
    max_typing_seconds: Number(memory.maxTypingSeconds || base.max_typing_seconds),
    allowed_start_hour: Number(memory.allowedStartHour ?? base.allowed_start_hour),
    allowed_end_hour: Number(memory.allowedEndHour ?? base.allowed_end_hour),
    ai_model: memory.aiModel || base.ai_model,
    ai_theme: memory.aiTheme || base.ai_theme,
    custom_prompt: memory.customPrompt !== undefined ? memory.customPrompt : base.custom_prompt,
    enable_typing: memory.enableTyping ?? base.enable_typing,
    enable_blue_ticks: memory.enableBlueTicks ?? base.enable_blue_ticks,
    enable_reactions: memory.enableReactions ?? base.enable_reactions,
    enable_audio: memory.enableAudio ?? base.enable_audio,
    enable_vcard: memory.enableVcard ?? base.enable_vcard,
    enable_status_posts: memory.enableStatusPosts ?? base.enable_status_posts,
    continuous_warmup: memory.continuousWarmup ?? base.continuous_warmup,
    group_auto_join: memory.groupAutoJoin ?? base.group_auto_join,
    swarm_active: memory.swarmActive ?? base.swarm_active,
    max_groups_per_chip: Number(memory.maxGroupsPerChip ?? base.max_groups_per_chip ?? 10),
    vcard_exchanged_peers: Array.isArray(memory.vcardExchangedPeers) ? memory.vcardExchangedPeers : [],
    last_status_post_at: memory.lastStatusPostAt || null,
    profile_hydrated: Boolean(memory.profileHydrated),
    career_mode: restoredCareerMode,
    rehab_until: memory.rehabUntil ?? base.rehab_until ?? null,
    cold_outreach_locked_until: memory.coldOutreachLockedUntil ?? base.cold_outreach_locked_until ?? null,
    external_warmup_mode: (memory.externalWarmupMode || base.external_warmup_mode || "off") as ExternalWarmupMode,
    external_warmup_inbound_total: Number(memory.externalWarmupInboundTotal || 0),
    external_mmzap_sent_total: Number(memory.externalMmzapSentTotal || 0),
    created_at: memory.firstSeenAt || nowIso,
    updated_at: nowIso,
  };

  return { config: restored, softRecoveryActivated };
}

/**
 * Reconcilia automaticamente a identidade de um chip conectado pelo telefone real (`phone_number`),
 * restaurando fase/dias/finalidade caso tenha sido desconectado ou recriado com novo nome de instância,
 * e desativando eventuais registros órfãos antigos do mesmo telefone.
 */
export async function reconcileWarmupIdentityByPhone(params: {
  clientId: string;
  instanceName: string;
  phone: string;
  nowIso?: string;
}): Promise<{
  restored: boolean;
  previousInstance?: string | null;
  stage?: WarmupStage;
  daysActive?: number;
  softRecovery?: boolean;
}> {
  const { clientId, instanceName, phone, nowIso = new Date().toISOString() } = params;
  const canonical = canonicalBrazilPhoneKey(phone);
  if (!clientId || !instanceName || !canonical) {
    return { restored: false };
  }

  return enqueueTenantMemoryOp(clientId, async () => {
    const nowMs = new Date(nowIso).getTime();
    const map = await readPhoneMemoryMap(clientId);
    let memory = map[canonical] || null;
    if (!memory) {
      for (const v of getBrazilPhoneVariants(phone)) {
        const k = canonicalBrazilPhoneKey(v);
        if (k && map[k]) {
          memory = map[k];
          break;
        }
      }
    }

    let currentRow: WarmupConfig | null = null;
    let samePhoneRows: WarmupConfig[] = [];
    const activeConnectionInstances = new Set<string>([instanceName]);

    try {
      const [{ data: cfgRows }, { data: connRows }] = await Promise.all([
        supabaseAdmin
          .from("whatsapp_warmup_configs")
          .select("*")
          .eq("client_id", clientId),
        supabaseAdmin
          .from("channel_connections")
          .select("instance_name")
          .eq("client_id", clientId),
      ]);

      for (const c of (connRows || []) as Array<{ instance_name?: string }>) {
        if (c?.instance_name) activeConnectionInstances.add(c.instance_name);
      }

      const list = (cfgRows || []) as WarmupConfig[];
      currentRow = list.find((r) => r.instance_name === instanceName) || null;
      samePhoneRows = list
        .filter((r) => r.instance_name !== instanceName && samePhone(r.phone_number, phone))
        .sort((a, b) => (b.days_active || 1) - (a.days_active || 1) || (b.stage || 1) - (a.stage || 1));
    } catch {
      /* segue apenas com app_settings */
    }

    // Se havia linha antiga em whatsapp_warmup_configs ainda sem entrada no passaporte, promove para memória
    if (!memory && samePhoneRows[0]) {
      memory = buildEntryFromConfig(samePhoneRows[0], phone);
    }

    if (!memory) {
      if (currentRow) {
        map[canonical] = buildEntryFromConfig(currentRow, phone, null, {
          lastConnectedAt: nowIso,
        });
        await writePhoneMemoryMap(clientId, map);
      }
      return { restored: false };
    }

    const memoryHasAdvancedProgress =
      memory.lastInstanceName !== instanceName ||
      memory.daysActive > (currentRow?.days_active || 1) ||
      memory.stage > (currentRow?.stage || 1);

    const needsRestore =
      !currentRow ||
      (memoryHasAdvancedProgress &&
        (currentRow.days_active || 1) <= 1 &&
        (currentRow.sent_today || 0) === 0);

    const lastRef = memory.lastDisconnectedAt || currentRow?.last_activity_at || memory.lastConnectedAt || memory.updatedAt;
    const hadLongOfflineGap = Boolean(
      lastRef && nowMs - new Date(lastRef).getTime() >= OFFLINE_SOFT_RECOVERY_THRESHOLD_MS
    );
    const existingRecoveryActive = Boolean(
      memory.softRecoveryUntil && new Date(memory.softRecoveryUntil).getTime() > nowMs
    );

    let restored = false;
    let softRecovery = hadLongOfflineGap || existingRecoveryActive;
    const previousInstance = memory.lastInstanceName || samePhoneRows[0]?.instance_name || null;

    if (needsRestore && currentRow) {
      const applied = applyPhoneMemoryToNewConfig(currentRow, memory, nowIso);
      softRecovery = softRecovery || applied.softRecoveryActivated;

      try {
        const restorePayload: Record<string, unknown> = {
          phone_number: applied.config.phone_number,
          stage: applied.config.stage,
          days_active: applied.config.days_active,
          consecutive_successful_days: applied.config.consecutive_successful_days,
          health_score: applied.config.health_score,
          purpose: applied.config.purpose,
          daily_target: applied.config.daily_target,
          min_interval_seconds: applied.config.min_interval_seconds,
          max_interval_seconds: applied.config.max_interval_seconds,
          ai_model: applied.config.ai_model,
          ai_theme: applied.config.ai_theme,
          custom_prompt: applied.config.custom_prompt,
          allowed_start_hour: applied.config.allowed_start_hour,
          allowed_end_hour: applied.config.allowed_end_hour,
          vcard_exchanged_peers: applied.config.vcard_exchanged_peers,
          last_status_post_at: applied.config.last_status_post_at,
          profile_hydrated: applied.config.profile_hydrated,
          career_mode: applied.config.career_mode || "maturing",
          rehab_until: applied.config.rehab_until ?? null,
          cold_outreach_locked_until: applied.config.cold_outreach_locked_until ?? null,
          external_warmup_mode: applied.config.external_warmup_mode || "off",
          created_at: applied.config.created_at,
          updated_at: nowIso,
        };
        const { error: updErr } = await supabaseAdmin
          .from("whatsapp_warmup_configs")
          .update(restorePayload)
          .eq("client_id", clientId)
          .eq("instance_name", instanceName);
        if (updErr && (String(updErr.code || "") === "42703" || String(updErr.code || "") === "PGRST204")) {
          const {
            career_mode: _cm,
            rehab_until: _ru,
            cold_outreach_locked_until: _cl,
            external_warmup_mode: _ew,
            ...legacyPayload
          } = restorePayload;
          await supabaseAdmin
            .from("whatsapp_warmup_configs")
            .update(legacyPayload)
            .eq("client_id", clientId)
            .eq("instance_name", instanceName);
        }
        restored = true;
      } catch {
        /* ignore */
      }

      currentRow = applied.config;
    }

    // Arquiva/remove configs órfãs antigas deste MESMO telefone que não existem mais em channel_connections
    for (const stale of samePhoneRows) {
      if (!activeConnectionInstances.has(stale.instance_name)) {
        try {
          await supabaseAdmin
            .from("whatsapp_warmup_configs")
            .delete()
            .eq("client_id", clientId)
            .eq("instance_name", stale.instance_name);
        } catch {
          /* ignore */
        }
      }
    }

    const softRecoveryUntil = softRecovery
      ? new Date(nowMs + PHONE_RECOVERY_WINDOW_MS).toISOString()
      : memory.softRecoveryUntil;

    const updatedEntry = buildEntryFromConfig(
      currentRow || {
        instance_name: instanceName,
        phone_number: extractDigits(phone),
        stage: memory.stage,
        days_active: memory.daysActive,
        consecutive_successful_days: memory.consecutiveSuccessfulDays,
        health_score: memory.healthScore,
        purpose: memory.purpose,
      },
      phone,
      memory,
      {
        lastConnectedAt: nowIso,
        lastDisconnectedAt: null,
        softRecoveryUntil,
      }
    );
    updatedEntry.lastInstanceName = instanceName;
    map[canonical] = updatedEntry;
    await writePhoneMemoryMap(clientId, map);
    await syncPhonePassportRow(clientId, updatedEntry);

    return {
      restored: restored || (Boolean(previousInstance) && previousInstance !== instanceName),
      previousInstance,
      stage: updatedEntry.stage,
      daysActive: updatedEntry.daysActive,
      softRecovery,
    };
  });
}

/**
 * Registra banimento/logout 401/403 no passaporte permanente do telefone:
 * - Preserva `daysActive` e `stage` acumulados;
 * - Ativa modo `rehab` por 72h + trava disparo frio por 96h;
 * - Incrementa `banCount` para memória vitalícia mesmo se a instância for recriada.
 */
export async function markPhonePostBanRehab(params: {
  clientId: string;
  instanceName: string;
  phone?: string | null;
  reason?: string | null;
  nowMs?: number;
}): Promise<WarmupPhoneMemoryEntry | null> {
  const { clientId, instanceName, phone, reason, nowMs = Date.now() } = params;
  if (!clientId || !instanceName) return null;

  return enqueueTenantMemoryOp(clientId, async () => {
    const map = await readPhoneMemoryMap(clientId);
    const canonicalFromPhone = canonicalBrazilPhoneKey(phone);
    let entry: WarmupPhoneMemoryEntry | null =
      (canonicalFromPhone && map[canonicalFromPhone]) ||
      Object.values(map).find((e) => e.lastInstanceName === instanceName) ||
      null;

    if (!entry && !canonicalFromPhone) {
      return null;
    }

    const nowIso = new Date(nowMs).toISOString();
    const rehabUntil = new Date(nowMs + POST_BAN_REHAB_HOURS * 60 * 60 * 1000).toISOString();
    const coldLockUntil = new Date(nowMs + POST_BAN_COLD_LOCK_HOURS * 60 * 60 * 1000).toISOString();
    const cleanReason = reason ? String(reason).slice(0, 200) : "ban_or_401_403";

    if (!entry) {
      let existingCfg: Partial<WarmupConfig> | null = null;
      try {
        const { data: cfgRow } = await supabaseAdmin
          .from("whatsapp_warmup_configs")
          .select("*")
          .eq("client_id", clientId)
          .eq("instance_name", instanceName)
          .maybeSingle();
        if (cfgRow) existingCfg = cfgRow as Partial<WarmupConfig>;
      } catch { /* ignore */ }

      entry = buildEntryFromConfig(
        {
          ...(existingCfg || {}),
          instance_name: instanceName,
          phone_number: extractDigits(phone || existingCfg?.phone_number),
          stage: (existingCfg?.stage || 1) as WarmupStage,
          days_active: Number(existingCfg?.days_active || 1),
          health_score: 35,
          career_mode: "rehab",
          rehab_until: rehabUntil,
          cold_outreach_locked_until: coldLockUntil,
        },
        phone || canonicalFromPhone
      );
    }

    const updated: WarmupPhoneMemoryEntry = {
      ...entry,
      lastInstanceName: instanceName,
      healthScore: Math.min(entry.healthScore ?? 100, 35),
      consecutiveSuccessfulDays: 0,
      careerMode: "rehab",
      banCount: Number(entry.banCount || 0) + 1,
      lastBanAt: nowIso,
      lastBanReason: cleanReason,
      rehabUntil,
      coldOutreachLockedUntil: coldLockUntil,
      softRecoveryUntil: rehabUntil,
      lastDisconnectedAt: nowIso,
      lastDisconnectReason: cleanReason,
      previousInstances: Array.from(new Set([...(entry.previousInstances || []), instanceName])).slice(-15),
      updatedAt: nowIso,
    };

    map[updated.canonicalPhone] = updated;
    await writePhoneMemoryMap(clientId, map);
    await syncPhonePassportRow(clientId, updated);
    return updated;
  });
}

/**
 * Libera manualmente a reabilitação pós-incidente e trava de disparo frio
 * no passaporte permanente do telefone (`app_settings` + `whatsapp_phone_passports`),
 * preservando o histórico (`banCount`, `daysActive`, `stage`, `previousInstances`).
 */
export async function clearPhonePostBanRehab(params: {
  clientId: string;
  instanceName: string;
  phone?: string | null;
  nowMs?: number;
}): Promise<WarmupPhoneMemoryEntry | null> {
  const { clientId, instanceName, phone, nowMs = Date.now() } = params;
  if (!clientId || !instanceName) return null;

  return enqueueTenantMemoryOp(clientId, async () => {
    const map = await readPhoneMemoryMap(clientId);
    const canonicalFromPhone = canonicalBrazilPhoneKey(phone);
    const entry: WarmupPhoneMemoryEntry | null =
      (canonicalFromPhone && map[canonicalFromPhone]) ||
      Object.values(map).find((e) => e.lastInstanceName === instanceName) ||
      null;

    if (!entry) return null;

    const nowIso = new Date(nowMs).toISOString();
    const updated: WarmupPhoneMemoryEntry = {
      ...entry,
      lastInstanceName: instanceName,
      healthScore: Math.max(entry.healthScore ?? 75, 75),
      careerMode: "maturing",
      rehabUntil: null,
      coldOutreachLockedUntil: null,
      softRecoveryUntil: null,
      updatedAt: nowIso,
    };

    map[updated.canonicalPhone] = updated;
    await writePhoneMemoryMap(clientId, map);
    await syncPhonePassportRow(clientId, updated);
    return updated;
  });
}
