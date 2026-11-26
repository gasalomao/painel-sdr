import { supabaseAdmin } from "@/lib/supabase_admin";
import { getBrazilPhoneVariants } from "@/lib/jid-utils";

export type AbVariantKey = "A" | "B";

export interface CampaignAbConfig {
  enabled: boolean;
  variantA_label: string;
  variantA_template: string;
  variantB_label: string;
  variantB_template: string;
  auto_pause_below_pct: number;
  min_sample_size: number;
  paused_variant: AbVariantKey | null;
  paused_reason: string | null;
}

export interface CampaignAbVariantBucket {
  variant: AbVariantKey;
  label: string;
  sent: number;
  replied: number;
  preview_accepted: number;
  reply_rate_pct: number;
  paused: boolean;
}

export interface CampaignAbSummary {
  campaignId: string;
  campaignName?: string | null;
  enabled: boolean;
  paused_variant: AbVariantKey | null;
  paused_reason: string | null;
  winner_variant: AbVariantKey | null;
  variants: [CampaignAbVariantBucket, CampaignAbVariantBucket];
}

interface StoredAbStats {
  sends: Record<string, AbVariantKey>; // remote_jid -> "A" | "B" (capped at 1000)
  counts: { A: number; B: number };
}

const AB_CONFIG_PREFIX = "campaign_ab_config:";
const AB_STATS_PREFIX = "campaign_ab_stats:";

export const DEFAULT_AB_MIN_SAMPLE = 20;
export const DEFAULT_AB_AUTO_PAUSE_PCT = 10;

export function selectCampaignAbVariant(
  config: CampaignAbConfig,
  counts: { A: number; B: number }
): AbVariantKey {
  if (config.paused_variant === "A") return "B";
  if (config.paused_variant === "B") return "A";
  return counts.A <= counts.B ? "A" : "B";
}

export function evaluateAbAutoPause(
  config: CampaignAbConfig,
  stats: [CampaignAbVariantBucket, CampaignAbVariantBucket]
): { shouldPause: boolean; pausedVariant: AbVariantKey | null; reason: string | null } {
  if (!config.enabled || config.paused_variant) {
    return { shouldPause: false, pausedVariant: config.paused_variant, reason: config.paused_reason };
  }

  const minSample = Math.max(5, Number(config.min_sample_size || DEFAULT_AB_MIN_SAMPLE));
  const threshold = Math.max(1, Number(config.auto_pause_below_pct || DEFAULT_AB_AUTO_PAUSE_PCT));
  const [bucketA, bucketB] = stats;

  const aUnder = bucketA.sent >= minSample && bucketA.reply_rate_pct < threshold;
  const bUnder = bucketB.sent >= minSample && bucketB.reply_rate_pct < threshold;

  // Nunca pausa ambas automaticamente — preserva a variante menos pior ou a de melhor taxa
  if (aUnder && bUnder) {
    if (bucketA.reply_rate_pct < bucketB.reply_rate_pct) {
      return {
        shouldPause: true,
        pausedVariant: "A",
        reason: `Variante A pausada (${bucketA.reply_rate_pct}% em ${bucketA.sent} envios < ${threshold}%)`,
      };
    }
    if (bucketB.reply_rate_pct < bucketA.reply_rate_pct) {
      return {
        shouldPause: true,
        pausedVariant: "B",
        reason: `Variante B pausada (${bucketB.reply_rate_pct}% em ${bucketB.sent} envios < ${threshold}%)`,
      };
    }
    return { shouldPause: false, pausedVariant: null, reason: null };
  }

  if (aUnder) {
    return {
      shouldPause: true,
      pausedVariant: "A",
      reason: `Variante A pausada automaticamente (${bucketA.reply_rate_pct}% de resposta após ${bucketA.sent} envios < ${threshold}%)`,
    };
  }
  if (bUnder) {
    return {
      shouldPause: true,
      pausedVariant: "B",
      reason: `Variante B pausada automaticamente (${bucketB.reply_rate_pct}% de resposta após ${bucketB.sent} envios < ${threshold}%)`,
    };
  }

  return { shouldPause: false, pausedVariant: null, reason: null };
}

export async function getCampaignAbConfig(campaignId: string): Promise<CampaignAbConfig | null> {
  if (!campaignId) return null;
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `${AB_CONFIG_PREFIX}${campaignId}`)
      .maybeSingle();
    if (!data?.value) return null;
    const parsed = JSON.parse(data.value) as Partial<CampaignAbConfig>;
    return {
      enabled: Boolean(parsed.enabled),
      variantA_label: String(parsed.variantA_label || "Variante A"),
      variantA_template: String(parsed.variantA_template || ""),
      variantB_label: String(parsed.variantB_label || "Variante B"),
      variantB_template: String(parsed.variantB_template || ""),
      auto_pause_below_pct: Number(parsed.auto_pause_below_pct ?? DEFAULT_AB_AUTO_PAUSE_PCT),
      min_sample_size: Number(parsed.min_sample_size ?? DEFAULT_AB_MIN_SAMPLE),
      paused_variant: parsed.paused_variant === "A" || parsed.paused_variant === "B" ? parsed.paused_variant : null,
      paused_reason: typeof parsed.paused_reason === "string" ? parsed.paused_reason : null,
    };
  } catch {
    return null;
  }
}

export async function saveCampaignAbConfig(
  campaignId: string,
  input: {
    enabled: boolean;
    variantA_label?: string;
    variantA_template?: string;
    variantB_label?: string;
    variantB_template?: string;
    auto_pause_below_pct?: number;
    min_sample_size?: number;
    paused_variant?: AbVariantKey | null;
    paused_reason?: string | null;
  }
): Promise<CampaignAbConfig> {
  const existing = await getCampaignAbConfig(campaignId);
  const next: CampaignAbConfig = {
    enabled: Boolean(input.enabled),
    variantA_label: input.variantA_label || existing?.variantA_label || "Variante A (Padrão)",
    variantA_template: input.variantA_template ?? existing?.variantA_template ?? "",
    variantB_label: input.variantB_label || existing?.variantB_label || "Variante B (Vídeo Nota Google)",
    variantB_template: input.variantB_template ?? existing?.variantB_template ?? "",
    auto_pause_below_pct: Math.max(
      1,
      Math.min(90, Number(input.auto_pause_below_pct ?? existing?.auto_pause_below_pct ?? DEFAULT_AB_AUTO_PAUSE_PCT))
    ),
    min_sample_size: Math.max(
      5,
      Math.min(500, Number(input.min_sample_size ?? existing?.min_sample_size ?? DEFAULT_AB_MIN_SAMPLE))
    ),
    paused_variant: input.paused_variant !== undefined ? input.paused_variant : (existing?.paused_variant ?? null),
    paused_reason: input.paused_reason !== undefined ? input.paused_reason : (existing?.paused_reason ?? null),
  };

  await supabaseAdmin
    .from("app_settings")
    .upsert(
      {
        key: `${AB_CONFIG_PREFIX}${campaignId}`,
        value: JSON.stringify(next),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
  return next;
}

export async function readCampaignAbStats(campaignId: string): Promise<StoredAbStats> {
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `${AB_STATS_PREFIX}${campaignId}`)
      .maybeSingle();
    if (data?.value) {
      const parsed = JSON.parse(data.value) as Partial<StoredAbStats>;
      return {
        sends: parsed.sends && typeof parsed.sends === "object" ? parsed.sends : {},
        counts: {
          A: Number(parsed.counts?.A || 0),
          B: Number(parsed.counts?.B || 0),
        },
      };
    }
  } catch {
    /* empty fallback */
  }
  return { sends: {}, counts: { A: 0, B: 0 } };
}

export async function recordCampaignAbSend(
  campaignId: string,
  clientId: string,
  remoteJid: string,
  variant: AbVariantKey
): Promise<StoredAbStats> {
  const stats = await readCampaignAbStats(campaignId);
  const cleanJid = String(remoteJid || "").trim();
  if (cleanJid && !stats.sends[cleanJid]) {
    stats.counts[variant] = (stats.counts[variant] || 0) + 1;
  } else if (!cleanJid) {
    stats.counts[variant] = (stats.counts[variant] || 0) + 1;
  }

  if (cleanJid) {
    stats.sends[cleanJid] = variant;
    const keys = Object.keys(stats.sends);
    if (keys.length > 1000) {
      for (const oldKey of keys.slice(0, keys.length - 1000)) {
        delete stats.sends[oldKey];
      }
    }
  }

  try {
    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `${AB_STATS_PREFIX}${campaignId}`,
          value: JSON.stringify(stats),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
  } catch {
    /* non-fatal */
  }

  // Espelha na coluna optional `contacts.ab_variant` quando disponível
  if (cleanJid) {
    try {
      await supabaseAdmin
        .from("contacts")
        .update({ ab_variant: variant })
        .eq("client_id", clientId)
        .eq("remote_jid", cleanJid);
    } catch {
      /* coluna opcional */
    }
  }

  return stats;
}

/**
 * Consolida taxa de resposta e aceite de prévia das Variantes A/B para a campanha,
 * aplicando pausa automática quando uma variante fica abaixo de `auto_pause_below_pct`
 * após atingir `min_sample_size`.
 */
export async function computeCampaignAbSummary(
  clientId: string,
  campaignId: string,
  campaignName?: string | null
): Promise<{
  summary: CampaignAbSummary | null;
  storedCounts: { A: number; B: number };
  newlyPaused?: { variant: AbVariantKey; reason: string };
}> {
  const config = await getCampaignAbConfig(campaignId);
  if (!config || !config.enabled) {
    return { summary: null, storedCounts: { A: 0, B: 0 } };
  }

  const stored = await readCampaignAbStats(campaignId);
  const acc: Record<AbVariantKey, { sent: number; replied: number; preview_accepted: number }> = {
    A: { sent: 0, replied: 0, preview_accepted: 0 },
    B: { sent: 0, replied: 0, preview_accepted: 0 },
  };

  try {
    const [{ data: targets }, { data: leads }, { data: contacts }] = await Promise.all([
      supabaseAdmin
        .from("campaign_targets")
        .select("remote_jid, status")
        .eq("campaign_id", campaignId)
        .eq("client_id", clientId)
        .in("status", ["sent", "delivered", "replied"])
        .limit(2000),
      supabaseAdmin
        .from("leads_extraidos")
        .select("remoteJid, status, previa_status")
        .eq("client_id", clientId)
        .limit(2000),
      supabaseAdmin
        .from("contacts")
        .select("remote_jid, ab_variant, preview_accepted_at")
        .eq("client_id", clientId)
        .limit(2000)
        .then(
          (r) => r,
          () => ({ data: [] as Array<Record<string, unknown>> })
        ),
    ]);

    const expandJidKeys = (raw: string): string[] => {
      const clean = String(raw || "").trim();
      if (!clean) return [];
      if (clean.includes("@g.us") || clean.includes("@lid")) return [clean];
      const keys = new Set<string>([clean]);
      for (const digits of getBrazilPhoneVariants(clean)) {
        if (digits.length >= 10) {
          keys.add(digits);
          keys.add(`${digits}@s.whatsapp.net`);
        }
      }
      return Array.from(keys);
    };

    const storedVariantByKey = new Map<string, AbVariantKey>();
    for (const [k, v] of Object.entries(stored.sends || {})) {
      if (v !== "A" && v !== "B") continue;
      for (const key of expandJidKeys(k)) storedVariantByKey.set(key, v);
    }

    const leadByJid = new Map<string, Record<string, unknown>>();
    for (const l of (leads || []) as Array<Record<string, unknown>>) {
      if (l?.remoteJid) {
        for (const key of expandJidKeys(String(l.remoteJid))) leadByJid.set(key, l);
      }
    }

    const contactByJid = new Map<string, Record<string, unknown>>();
    for (const c of (contacts || []) as Array<Record<string, unknown>>) {
      if (c?.remote_jid) {
        for (const key of expandJidKeys(String(c.remote_jid))) contactByJid.set(key, c);
      }
    }

    for (const t of (targets || []) as Array<Record<string, unknown>>) {
      const jid = String(t.remote_jid || "");
      const contact = contactByJid.get(jid);
      const rawVar = stored.sends[jid] || storedVariantByKey.get(jid) || (contact?.ab_variant as string | undefined);
      const variant: AbVariantKey | null = rawVar === "A" || rawVar === "B" ? rawVar : null;
      if (!variant) continue;

      acc[variant].sent += 1;
      const lead = leadByJid.get(jid);
      const leadStatus = String(lead?.status || "").toLowerCase();
      const previaStatus = String(lead?.previa_status || "").toUpperCase();
      const replied =
        t.status === "replied" ||
        ["em_conversa", "interessado", "previa_aceita", "previa_enviada", "negociacao_x1", "agendado", "fechado"].includes(
          leadStatus
        );
      if (replied) acc[variant].replied += 1;

      const previewAccepted =
        Boolean(contact?.preview_accepted_at) ||
        ["PREVIA_SOLICITADA", "PRONTO_PARA_ENVIO", "ENVIADA"].includes(previaStatus) ||
        ["previa_aceita", "previa_enviada", "negociacao_x1", "fechado"].includes(leadStatus);
      if (previewAccepted) acc[variant].preview_accepted += 1;
    }
  } catch {
    /* usa contadores armazenados como fallback */
  }

  // Fallback se targets ainda não foram lidos
  if (acc.A.sent === 0 && stored.counts.A > 0) acc.A.sent = stored.counts.A;
  if (acc.B.sent === 0 && stored.counts.B > 0) acc.B.sent = stored.counts.B;

  const pct = (num: number, den: number): number => (den > 0 ? Number(((num / den) * 100).toFixed(1)) : 0);

  const buckets: [CampaignAbVariantBucket, CampaignAbVariantBucket] = [
    {
      variant: "A",
      label: config.variantA_label,
      sent: acc.A.sent,
      replied: acc.A.replied,
      preview_accepted: acc.A.preview_accepted,
      reply_rate_pct: pct(acc.A.replied, acc.A.sent),
      paused: config.paused_variant === "A",
    },
    {
      variant: "B",
      label: config.variantB_label,
      sent: acc.B.sent,
      replied: acc.B.replied,
      preview_accepted: acc.B.preview_accepted,
      reply_rate_pct: pct(acc.B.replied, acc.B.sent),
      paused: config.paused_variant === "B",
    },
  ];

  let newlyPaused: { variant: AbVariantKey; reason: string } | undefined;
  const evalPause = evaluateAbAutoPause(config, buckets);
  if (evalPause.shouldPause && evalPause.pausedVariant && !config.paused_variant) {
    const reason = evalPause.reason || `Variante ${evalPause.pausedVariant} pausada automaticamente`;
    await saveCampaignAbConfig(campaignId, {
      enabled: true,
      paused_variant: evalPause.pausedVariant,
      paused_reason: reason,
    }).catch(() => {});
    config.paused_variant = evalPause.pausedVariant;
    config.paused_reason = reason;
    buckets[evalPause.pausedVariant === "A" ? 0 : 1].paused = true;
    newlyPaused = { variant: evalPause.pausedVariant, reason };
  }

  const winnerVariant: AbVariantKey | null =
    config.paused_variant === "A"
      ? "B"
      : config.paused_variant === "B"
        ? "A"
        : buckets[0].sent >= 10 && buckets[1].sent >= 10 && buckets[0].reply_rate_pct !== buckets[1].reply_rate_pct
          ? buckets[0].reply_rate_pct > buckets[1].reply_rate_pct
            ? "A"
            : "B"
          : null;

  return {
    summary: {
      campaignId,
      campaignName,
      enabled: true,
      paused_variant: config.paused_variant,
      paused_reason: config.paused_reason,
      winner_variant: winnerVariant,
      variants: buckets,
    },
    storedCounts: stored.counts,
    newlyPaused,
  };
}
