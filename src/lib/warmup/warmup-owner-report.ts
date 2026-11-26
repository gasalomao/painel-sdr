import { supabaseAdmin } from "@/lib/supabase_admin";
import { sendMessage } from "@/lib/channel";
import { registerPendingAutomatedSend } from "@/lib/manual-send-registry";
import { getGlobalWarmupSettings, isConnectedStatus } from "./warmup-config-service";
import { getBrazilDayKey, getBrazilHour, logWarmupAction } from "./warmup-engine";

export interface DailyWarmupOwnerReportChipItem {
  instanceName: string;
  stage: number;
  healthScore: number;
  sentToday: number;
  coldSentToday: number;
  replyRatePct: number | null;
  alert: string | null;
}

export interface DailyWarmupOwnerReportInput {
  dayKey: string;
  coldSentToday: number;
  coldRepliedToday: number;
  replyRatePct: number;
  acceptedPreviewsToday: number;
  promotionsToday: string[];
  alerts: string[];
  chips: DailyWarmupOwnerReportChipItem[];
}

const REPORT_DEDUP_PREFIX = "warmup_daily_owner_report_last:";

/**
 * Formata o resumo diário das 20h BRT em até 8 linhas objetivas (zero tokens de IA).
 */
export function buildDailyWarmupOwnerReportText(input: DailyWarmupOwnerReportInput): string {
  const topChips = input.chips
    .slice(0, 4)
    .map(
      (c) =>
        `${c.instanceName} (F${c.stage}/${c.healthScore}%${c.replyRatePct !== null ? ` · ${c.replyRatePct}% resp` : ""})`
    )
    .join(", ");

  const lines: string[] = [
    `📊 Resumo Diário do Aquecimento & Prospecção (${input.dayKey})`,
    `• Disparos frios hoje: ${input.coldSentToday} | Respostas: ${input.coldRepliedToday} (${input.replyRatePct}%)`,
    `• Prévias aceitas hoje: ${input.acceptedPreviewsToday}`,
  ];

  if (topChips) {
    lines.push(`• Chips: ${topChips}`);
  }
  if (input.promotionsToday.length > 0) {
    lines.push(`• Promoções de fase hoje: ${input.promotionsToday.slice(0, 4).join(", ")}`);
  }
  if (input.alerts.length > 0) {
    lines.push(`• Alertas: ${input.alerts.slice(0, 4).join(" | ")}`);
  } else {
    lines.push("• Alertas: nenhum incidente crítico hoje.");
  }

  return lines.join("\n");
}

async function resolveOwnerPhoneForTenant(clientId: string, overridePhone?: string | null): Promise<string | null> {
  const cleanOverride = String(overridePhone || "").replace(/\D/g, "");
  if (cleanOverride.length >= 10) return cleanOverride;

  try {
    const { data: agents } = await supabaseAdmin
      .from("agent_settings")
      .select("scheduler_config")
      .eq("client_id", clientId)
      .limit(10);
    for (const row of (agents || []) as Array<{ scheduler_config?: Record<string, unknown> | null }>) {
      const phone = String(row?.scheduler_config?.owner_phone || "").replace(/\D/g, "");
      if (phone.length >= 10) return phone;
    }
  } catch {
    /* fallback silencioso */
  }
  return null;
}

/**
 * Envia resumo diário via WhatsApp ao dono às 20h BRT (1x por dia por tenant, idempotente via app_settings).
 */
export async function maybeSendDailyWarmupOwnerSummary(
  clientId: string,
  opts?: { now?: Date; force?: boolean }
): Promise<{ sent: boolean; reason?: string; recipient?: string; text?: string }> {
  try {
    const now = opts?.now ?? new Date();
    const globalSettings = await getGlobalWarmupSettings(clientId);
    if (!opts?.force && !globalSettings.daily_owner_summary_enabled) {
      return { sent: false, reason: "disabled" };
    }

    const hourBrt = getBrazilHour(now);
    if (!opts?.force && hourBrt < 20) {
      return { sent: false, reason: "before_20h_brt" };
    }

    const dayKey = getBrazilDayKey(now.toISOString());
    const dedupKey = `${REPORT_DEDUP_PREFIX}${clientId}`;

    if (!opts?.force) {
      const { data: existingDedup } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", dedupKey)
        .maybeSingle();
      if (existingDedup?.value === dayKey) {
        return { sent: false, reason: "already_sent_today" };
      }
    }

    const ownerPhone = await resolveOwnerPhoneForTenant(clientId, globalSettings.daily_owner_summary_phone);
    if (!ownerPhone) {
      return { sent: false, reason: "missing_owner_phone" };
    }

    const [{ data: conns }, { data: configs }] = await Promise.all([
      supabaseAdmin
        .from("channel_connections")
        .select("instance_name, status")
        .eq("client_id", clientId),
      supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("instance_name, stage, health_score, sent_today, is_quarantined, career_mode, mmzap_browser_status, mmzap_last_error")
        .eq("client_id", clientId),
    ]);

    const connStatus = new Map<string, string>();
    for (const c of (conns || []) as Array<{ instance_name?: string; status?: string }>) {
      if (c?.instance_name) connStatus.set(c.instance_name, String(c.status || ""));
    }

    const configList = (configs || []) as Array<{
      instance_name: string;
      stage?: number;
      health_score?: number;
      sent_today?: number;
      is_quarantined?: boolean;
      career_mode?: string;
      mmzap_browser_status?: string | null;
      mmzap_last_error?: string | null;
    }>;

    const senderChip =
      configList.find((cfg) => isConnectedStatus(connStatus.get(cfg.instance_name)) && !cfg.is_quarantined)
        ?.instance_name ||
      Array.from(connStatus.entries()).find(([, st]) => isConnectedStatus(st))?.[0] ||
      null;

    if (!senderChip) {
      return { sent: false, reason: "no_connected_sender" };
    }

    const dayStartIso = `${dayKey}T00:00:00-03:00`;
    let coldSentToday = 0;
    let coldRepliedToday = 0;
    const campInstById = new Map<string, string>();
    const sentByInst = new Map<string, number>();
    const repliedByInst = new Map<string, number>();

    try {
      const { data: camps } = await supabaseAdmin
        .from("campaigns")
        .select("id, instance_name")
        .eq("client_id", clientId)
        .limit(200);
      for (const c of (camps || []) as Array<{ id?: string; instance_name?: string | null }>) {
        if (c?.id && c.instance_name) campInstById.set(c.id, c.instance_name);
      }

      const { data: tgtRows } = await supabaseAdmin
        .from("campaign_targets")
        .select("campaign_id, status, sent_at")
        .eq("client_id", clientId)
        .gte("sent_at", dayStartIso)
        .in("status", ["sent", "delivered", "replied"])
        .limit(2000);

      for (const t of (tgtRows || []) as Array<{ campaign_id?: string; status?: string }>) {
        coldSentToday++;
        const inst = campInstById.get(String(t.campaign_id || ""));
        if (inst) sentByInst.set(inst, (sentByInst.get(inst) || 0) + 1);
        if (t.status === "replied") {
          coldRepliedToday++;
          if (inst) repliedByInst.set(inst, (repliedByInst.get(inst) || 0) + 1);
        }
      }
    } catch {
      /* fail-open */
    }

    let acceptedPreviewsToday = 0;
    try {
      const { count } = await supabaseAdmin
        .from("contacts")
        .select("remote_jid", { count: "exact", head: true })
        .eq("client_id", clientId)
        .gte("preview_accepted_at", dayStartIso);
      acceptedPreviewsToday = Number(count || 0);
    } catch {
      /* coluna opcional */
    }

    const promotionsToday: string[] = [];
    try {
      const { data: logRows } = await supabaseAdmin
        .from("whatsapp_warmup_logs")
        .select("sender_instance")
        .eq("client_id", clientId)
        .eq("receiver_instance", "auto_ramp")
        .gte("created_at", dayStartIso)
        .limit(50);
      for (const row of (logRows || []) as Array<{ sender_instance?: string | null }>) {
        if (row?.sender_instance) promotionsToday.push(row.sender_instance);
      }
    } catch {
      /* tabela opcional */
    }

    const alerts: string[] = [];
    const chips: DailyWarmupOwnerReportChipItem[] = configList.map((cfg) => {
      const conn = connStatus.get(cfg.instance_name);
      const chipSent = sentByInst.get(cfg.instance_name) || 0;
      const chipReplied = repliedByInst.get(cfg.instance_name) || 0;
      let alert: string | null = null;
      if (!isConnectedStatus(conn)) {
        alert = `${cfg.instance_name}: desconectado`;
      } else if (cfg.mmzap_browser_status === "qr_pending" || cfg.mmzap_last_error === "qr_required") {
        alert = `${cfg.instance_name}: qr_required no MMZap`;
      } else if (cfg.is_quarantined) {
        alert = `${cfg.instance_name}: em quarentena`;
      } else if (cfg.career_mode === "rehab") {
        alert = `${cfg.instance_name}: em reabilitação`;
      }
      if (alert) alerts.push(alert);

      return {
        instanceName: cfg.instance_name,
        stage: Number(cfg.stage || 1),
        healthScore: Number(cfg.health_score ?? 100),
        sentToday: Number(cfg.sent_today || 0),
        coldSentToday: chipSent,
        replyRatePct: chipSent > 0 ? Number(((chipReplied / chipSent) * 100).toFixed(1)) : null,
        alert,
      };
    });

    const replyRatePct =
      coldSentToday > 0 ? Number(((coldRepliedToday / coldSentToday) * 100).toFixed(1)) : 0;

    const text = buildDailyWarmupOwnerReportText({
      dayKey,
      coldSentToday,
      coldRepliedToday,
      replyRatePct,
      acceptedPreviewsToday,
      promotionsToday: Array.from(new Set(promotionsToday)),
      alerts,
      chips,
    });

    const recipientJid = `${ownerPhone}@s.whatsapp.net`;
    registerPendingAutomatedSend(senderChip, recipientJid, text);
    const sendRes = await sendMessage(recipientJid, text, senderChip, { linkPreview: false });
    if (sendRes && (sendRes as { ok?: boolean }).ok === false) {
      return { sent: false, reason: "send_failed" };
    }

    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: dedupKey,
          value: dayKey,
          updated_at: now.toISOString(),
        },
        { onConflict: "key" }
      );

    await logWarmupAction({
      client_id: clientId,
      sender_instance: senderChip,
      receiver_instance: "owner_summary_20h",
      message_text: `📊 Resumo diário das 20h BRT enviado ao gestor (${ownerPhone}).`,
      action_type: "system",
    }).catch(() => {});

    return { sent: true, recipient: ownerPhone, text };
  } catch {
    return { sent: false, reason: "unexpected_error" };
  }
}
