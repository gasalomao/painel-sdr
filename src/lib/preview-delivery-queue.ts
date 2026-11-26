import { supabaseAdmin } from "@/lib/supabase_admin";
import * as channel from "@/lib/channel";
import { registerPendingAutomatedSend } from "@/lib/manual-send-registry";
import { findOrCreateContactSession, persistOutgoingMessage } from "@/lib/campaign-worker";

export type NaturalDeliverySlot = "now" | "plus_3h" | "evening_18h" | "next_morning_09h" | "custom";

export interface ScheduledPreviewDelivery {
  id: string;
  client_id: string;
  contact_id?: string | null;
  campaign_id?: string | null;
  remote_jid: string;
  instance_name: string;
  company_name?: string | null;
  preview_url: string;
  message_text: string;
  delivery_slot: NaturalDeliverySlot;
  scheduled_for: string;
  status: "pending" | "processing" | "sent" | "cancelled" | "failed";
  sent_at?: string | null;
  last_error?: string | null;
  created_by?: string | null;
  created_at?: string;
}

const SETTINGS_QUEUE_PREFIX = "scheduled_preview_deliveries_";

function getSaoPauloParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") % 24,
    minute: pick("minute"),
  };
}

function makeSaoPauloDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  // America/Sao_Paulo é UTC-03:00 fixo (sem horário de verão desde 2019)
  const utcMs = Date.UTC(year, month - 1, day, hour + 3, minute, 0, 0);
  return new Date(utcMs);
}

/**
 * Calcula a data/hora natural de envio da prévia no fuso America/Sao_Paulo:
 * - `now`: envia imediatamente no próximo tick
 * - `plus_3h`: +3 horas (se cair após 21h SP, avança para 09h15 do próximo dia)
 * - `evening_18h`: hoje às 18h15 SP (se já passou 18h15, amanhã às 18h15)
 * - `next_morning_09h`: amanhã às 09h15 SP (ou hoje se ainda antes das 09h)
 */
export function computeNaturalDeliveryDate(
  slot: NaturalDeliverySlot,
  now: Date = new Date(),
  customIso?: string | null
): Date {
  if (slot === "now") return now;
  if (slot === "custom" && customIso) {
    const parsed = new Date(customIso);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }

  const sp = getSaoPauloParts(now);

  if (slot === "plus_3h") {
    const target = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const spTarget = getSaoPauloParts(target);
    if (spTarget.hour >= 21 || spTarget.hour < 8) {
      const nextDay = new Date(Date.UTC(spTarget.year, spTarget.month - 1, spTarget.day + (spTarget.hour >= 21 ? 1 : 0)));
      return makeSaoPauloDate(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth() + 1,
        nextDay.getUTCDate(),
        9,
        15
      );
    }
    return target;
  }

  if (slot === "evening_18h") {
    const candidate = makeSaoPauloDate(sp.year, sp.month, sp.day, 18, 15);
    if (candidate.getTime() > now.getTime() + 5 * 60 * 1000) return candidate;
    const tomorrow = new Date(Date.UTC(sp.year, sp.month - 1, sp.day + 1));
    return makeSaoPauloDate(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 18, 15);
  }

  // next_morning_09h
  const todayMorning = makeSaoPauloDate(sp.year, sp.month, sp.day, 9, 15);
  if (todayMorning.getTime() > now.getTime() + 5 * 60 * 1000) return todayMorning;
  const tomorrow = new Date(Date.UTC(sp.year, sp.month - 1, sp.day + 1));
  return makeSaoPauloDate(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 9, 15);
}

export function buildDefaultPreviewDeliveryMessage(companyName: string | null | undefined, previewUrl: string): string {
  const cleanCompany = String(companyName || "").trim();
  const intro = cleanCompany
    ? `Oi! Finalizei a prévia personalizada do site da *${cleanCompany}* conforme combinamos.`
    : `Oi! Finalizei a prévia personalizada do seu site conforme combinamos.`;
  return `${intro}\n\nVocê pode abrir e testar no celular por este link:\n${previewUrl}\n\nMe conta o que achou do visual e da estrutura!`;
}

async function readFallbackQueue(clientId: string): Promise<ScheduledPreviewDelivery[]> {
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `${SETTINGS_QUEUE_PREFIX}${clientId}`)
      .maybeSingle();
    if (!data?.value) return [];
    const parsed = JSON.parse(String(data.value));
    return Array.isArray(parsed) ? (parsed as ScheduledPreviewDelivery[]) : [];
  } catch {
    return [];
  }
}

async function writeFallbackQueue(clientId: string, items: ScheduledPreviewDelivery[]): Promise<void> {
  try {
    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `${SETTINGS_QUEUE_PREFIX}${clientId}`,
          value: JSON.stringify(items.slice(-200)),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
  } catch { /* ignore */ }
}

export async function enqueueScheduledPreviewDelivery(params: {
  clientId: string;
  contactId?: string | null;
  campaignId?: string | null;
  remoteJid: string;
  instanceName: string;
  companyName?: string | null;
  previewUrl: string;
  messageText?: string | null;
  deliverySlot?: NaturalDeliverySlot;
  scheduledFor?: string | null;
  createdBy?: string | null;
  now?: Date;
}): Promise<{ ok: boolean; delivery?: ScheduledPreviewDelivery; error?: string }> {
  const clientId = String(params.clientId || "").trim();
  const remoteJid = String(params.remoteJid || "").trim();
  const instanceName = String(params.instanceName || "").trim();
  const previewUrl = String(params.previewUrl || "").trim();
  if (!clientId || !remoteJid || !instanceName || !previewUrl) {
    return { ok: false, error: "client_id, remote_jid, instance_name e preview_url são obrigatórios." };
  }

  const slot = params.deliverySlot || "now";
  const scheduledDate = computeNaturalDeliveryDate(slot, params.now || new Date(), params.scheduledFor);
  const messageText = String(params.messageText || "").trim() || buildDefaultPreviewDeliveryMessage(params.companyName, previewUrl);
  const nowIso = (params.now || new Date()).toISOString();

  const rowPayload = {
    client_id: clientId,
    contact_id: params.contactId ?? null,
    campaign_id: params.campaignId ?? null,
    remote_jid: remoteJid,
    instance_name: instanceName,
    company_name: params.companyName ?? null,
    preview_url: previewUrl,
    message_text: messageText,
    delivery_slot: slot,
    scheduled_for: scheduledDate.toISOString(),
    status: "pending" as const,
    created_by: params.createdBy ?? null,
    updated_at: nowIso,
  };

  try {
    const { data, error } = await supabaseAdmin
      .from("scheduled_preview_deliveries")
      .insert(rowPayload)
      .select("*")
      .single();

    if (!error && data) {
      return { ok: true, delivery: data as ScheduledPreviewDelivery };
    }
  } catch { /* fallback below */ }

  const fallbackItem: ScheduledPreviewDelivery = {
    id: `prev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    ...rowPayload,
    created_at: nowIso,
  };
  const existing = await readFallbackQueue(clientId);
  existing.push(fallbackItem);
  await writeFallbackQueue(clientId, existing);
  return { ok: true, delivery: fallbackItem };
}

export async function listScheduledPreviewDeliveries(
  clientId: string,
  status?: string | null
): Promise<ScheduledPreviewDelivery[]> {
  try {
    let q = supabaseAdmin
      .from("scheduled_preview_deliveries")
      .select("*")
      .eq("client_id", clientId)
      .order("scheduled_for", { ascending: true })
      .limit(100);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (!error && Array.isArray(data)) return data as ScheduledPreviewDelivery[];
  } catch { /* fallback */ }

  const fb = await readFallbackQueue(clientId);
  return status ? fb.filter((x) => x.status === status) : fb;
}

export async function cancelScheduledPreviewDelivery(clientId: string, id: string): Promise<{ ok: boolean }> {
  const nowIso = new Date().toISOString();
  try {
    const { error } = await supabaseAdmin
      .from("scheduled_preview_deliveries")
      .update({ status: "cancelled", updated_at: nowIso })
      .eq("client_id", clientId)
      .eq("id", id)
      .eq("status", "pending");
    if (!error) return { ok: true };
  } catch { /* fallback */ }

  const fb = await readFallbackQueue(clientId);
  const item = fb.find((x) => x.id === id && x.status === "pending");
  if (!item) return { ok: false };
  item.status = "cancelled";
  await writeFallbackQueue(clientId, fb);
  return { ok: true };
}

async function deliverSinglePreviewItem(item: ScheduledPreviewDelivery, nowIso: string): Promise<boolean> {
  try {
    registerPendingAutomatedSend(item.instance_name, item.remote_jid, item.message_text);
    const sendRes = await channel.sendMessage(item.remote_jid, item.message_text, item.instance_name);
    if (!sendRes?.ok) {
      throw new Error(sendRes?.error || "Falha no envio da prévia via WhatsApp");
    }
    const sentId = sendRes.messageId || `prev-${Date.now()}`;

    // Garante contato/sessão e MANTÉM IA pausada em `paused_manual` para fechamento X1 pelo dono
    const ensured = await findOrCreateContactSession(
      item.client_id,
      item.remote_jid,
      item.instance_name,
      item.company_name || undefined
    ).catch(() => null);

    if (ensured?.sessionId) {
      await supabaseAdmin
        .from("sessions")
        .update({
          bot_status: "paused_manual",
          paused_by: "manual_preview_delivery",
          paused_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", ensured.sessionId)
        .eq("client_id", item.client_id);

      await persistOutgoingMessage({
        sessionId: ensured.sessionId,
        remoteJid: item.remote_jid,
        instanceName: item.instance_name,
        msgId: sentId,
        text: item.message_text,
        clientId: item.client_id,
      }).catch(() => {});
    }

    const contactTargetId = item.contact_id || ensured?.contactId;
    if (contactTargetId) {
      try {
        await supabaseAdmin
          .from("contacts")
          .update({
            preview_delivered_at: nowIso,
            manual_handoff_at: nowIso,
            updated_at: nowIso,
          })
          .eq("id", contactTargetId)
          .eq("client_id", item.client_id);
      } catch { /* col opcional sem 031 */ }
    }

    return true;
  } catch (err: unknown) {
    item.last_error = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/**
 * Processa entregas de prévias vencidas (`status = 'pending'` AND `scheduled_for <= now`).
 * Ao enviar, mantém a IA explicitamente pausada (`paused_manual`) para fechamento 100% manual no X1.
 */
export async function tickScheduledPreviewDeliveries(nowMs = Date.now()): Promise<{
  processed: number;
  sent: number;
  failed: number;
}> {
  const nowIso = new Date(nowMs).toISOString();
  let processed = 0;
  let sent = 0;
  let failed = 0;

  try {
    const { data: dueRows, error } = await supabaseAdmin
      .from("scheduled_preview_deliveries")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_for", nowIso)
      .order("scheduled_for", { ascending: true })
      .limit(20);

    if (!error && Array.isArray(dueRows)) {
      for (const item of dueRows as ScheduledPreviewDelivery[]) {
        processed += 1;
        await supabaseAdmin
          .from("scheduled_preview_deliveries")
          .update({ status: "processing", updated_at: nowIso })
          .eq("id", item.id)
          .eq("status", "pending");

        const ok = await deliverSinglePreviewItem(item, nowIso);
        if (ok) {
          sent += 1;
          await supabaseAdmin
            .from("scheduled_preview_deliveries")
            .update({ status: "sent", sent_at: nowIso, updated_at: nowIso })
            .eq("id", item.id);
        } else {
          failed += 1;
          await supabaseAdmin
            .from("scheduled_preview_deliveries")
            .update({ status: "failed", last_error: item.last_error || "Falha ao enviar prévia", updated_at: nowIso })
            .eq("id", item.id);
        }
      }
      return { processed, sent, failed };
    }
  } catch { /* fallback app_settings */ }

  try {
    const { data: settingRows } = await supabaseAdmin
      .from("app_settings")
      .select("key, value")
      .like("key", `${SETTINGS_QUEUE_PREFIX}%`);
    for (const sRow of (settingRows || []) as Array<{ key?: string; value?: string }>) {
      if (!sRow?.key || !sRow.value) continue;
      const clientId = sRow.key.replace(SETTINGS_QUEUE_PREFIX, "");
      const list = JSON.parse(sRow.value) as ScheduledPreviewDelivery[];
      let dirty = false;
      for (const item of list) {
        if (item.status !== "pending") continue;
        if (new Date(item.scheduled_for).getTime() > nowMs) continue;
        processed += 1;
        dirty = true;
        const ok = await deliverSinglePreviewItem(item, nowIso);
        if (ok) {
          sent += 1;
          item.status = "sent";
          item.sent_at = nowIso;
        } else {
          failed += 1;
          item.status = "failed";
        }
      }
      if (dirty) await writeFallbackQueue(clientId, list);
    }
  } catch { /* ignore */ }

  return { processed, sent, failed };
}
