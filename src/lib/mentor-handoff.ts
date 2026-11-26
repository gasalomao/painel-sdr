import { supabaseAdmin } from "@/lib/supabase_admin";
import * as channel from "@/lib/channel";
import { registerPendingAutomatedSend } from "@/lib/manual-send-registry";

export interface NotifyOwnerPreviewAcceptedParams {
  clientId: string;
  contactId?: string | null;
  remoteJid: string;
  companyName?: string | null;
  instanceName: string;
  summary?: string | null;
  ownerPhone?: string | null;
  sessionId?: string | null;
}

export interface NotifyOwnerPreviewAcceptedResult {
  notified: boolean;
  ownerJid?: string | null;
  viaInstance?: string | null;
  reason?: string;
}

function normalizeOwnerJid(raw?: string | null): string | null {
  const digits = String(raw || "").replace(/@.*$/, "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const full = digits.startsWith("55") || digits.length > 11 ? digits : `55${digits}`;
  return `${full}@s.whatsapp.net`;
}

async function resolveOwnerNotificationTarget(
  clientId: string,
  preferredInstance: string,
  explicitOwnerPhone?: string | null
): Promise<{ ownerJid: string | null; viaInstance: string }> {
  let ownerRaw = explicitOwnerPhone || null;

  if (!ownerRaw) {
    try {
      const { data: cfgRow } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", `mentor_handoff_config_${clientId}`)
        .maybeSingle();
      if (cfgRow?.value) {
        const parsed = JSON.parse(String(cfgRow.value)) as { owner_phone?: string; enabled?: boolean };
        if (parsed.enabled === false) return { ownerJid: null, viaInstance: preferredInstance };
        if (parsed.owner_phone) ownerRaw = parsed.owner_phone;
      }
    } catch { /* ignore */ }
  }

  let viaInstance = preferredInstance;
  try {
    const { data: conns } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, status, provider_config")
      .eq("client_id", clientId);

    if (Array.isArray(conns)) {
      const connected = conns.filter((c) => {
        const st = String((c as { status?: string }).status || "").toLowerCase();
        return st === "open" || st === "connected" || st === "online";
      });
      if (!ownerRaw) {
        for (const c of conns) {
          const pCfg = (c as { provider_config?: Record<string, unknown> | null }).provider_config;
          const p = pCfg?.owner_alert_phone || pCfg?.alert_phone;
          if (p) {
            ownerRaw = String(p);
            break;
          }
        }
      }
      if (!viaInstance && connected[0]) {
        viaInstance = String((connected[0] as { instance_name?: string }).instance_name || "");
      }
    }
  } catch { /* ignore */ }

  return {
    ownerJid: normalizeOwnerJid(ownerRaw),
    viaInstance: viaInstance || preferredInstance,
  };
}

/**
 * Marca o aceite de prévia no lead/contato, pausa a IA (`paused_manual`) para que o humano
 * faça o envio da prévia + fechamento X1 sem interferência, e envia alerta WhatsApp ao dono.
 */
export async function notifyOwnerPreviewAccepted(
  params: NotifyOwnerPreviewAcceptedParams
): Promise<NotifyOwnerPreviewAcceptedResult> {
  const {
    clientId,
    contactId,
    remoteJid,
    companyName,
    instanceName,
    summary,
    ownerPhone,
    sessionId,
  } = params;
  const nowIso = new Date().toISOString();

  // 1. Carimba preview_accepted_at no contato (ignora silenciosamente se migration 031 não foi aplicada)
  if (contactId) {
    try {
      await supabaseAdmin
        .from("contacts")
        .update({ preview_accepted_at: nowIso, updated_at: nowIso })
        .eq("id", contactId)
        .eq("client_id", clientId);
    } catch { /* fail-open sem 031 */ }
  } else if (remoteJid) {
    try {
      await supabaseAdmin
        .from("contacts")
        .update({ preview_accepted_at: nowIso, updated_at: nowIso })
        .eq("remote_jid", remoteJid)
        .eq("client_id", clientId);
    } catch { /* fail-open sem 031 */ }
  }

  // 2. Garante IA pausada para handoff X1 humano
  if (sessionId) {
    try {
      await supabaseAdmin
        .from("sessions")
        .update({
          bot_status: "paused_manual",
          paused_by: "sarah_preview_accepted",
          paused_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", sessionId)
        .eq("client_id", clientId);
    } catch { /* non-fatal */ }
  }

  const target = await resolveOwnerNotificationTarget(clientId, instanceName, ownerPhone);
  if (!target.ownerJid || !target.viaInstance) {
    return { notified: false, reason: "owner_phone_not_configured" };
  }

  const leadPhone = remoteJid.replace(/@.*$/, "");
  const labelEmpresa = String(companyName || "").trim() || leadPhone;
  const alertLines = [
    `🔔 *NOVA PRÉVIA ACEITA — MODO X1*`,
    `🏢 Empresa: *${labelEmpresa}*`,
    `📱 WhatsApp do Lead: ${leadPhone}`,
    `📡 Chip: ${instanceName}`,
    summary ? `📝 Resumo: ${summary.slice(0, 220)}` : "",
    `👉 A IA foi pausada neste lead. Gere e agende a prévia no painel (Prospecção Sites) e assuma no X1!`,
  ].filter(Boolean);

  const message = alertLines.join("\n");
  try {
    registerPendingAutomatedSend(target.viaInstance, target.ownerJid, message);
    await channel.sendMessage(target.ownerJid, message, target.viaInstance);
    return {
      notified: true,
      ownerJid: target.ownerJid,
      viaInstance: target.viaInstance,
    };
  } catch (err: unknown) {
    return {
      notified: false,
      ownerJid: target.ownerJid,
      viaInstance: target.viaInstance,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
