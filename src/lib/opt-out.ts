import { supabaseAdmin } from "@/lib/supabase_admin";
import { getBrazilPhoneVariants } from "@/lib/jid-utils";
import { isExplicitOptOutRequest } from "@/lib/agent-guards";

/**
 * Constrói variantes de JID/telefone brasileiro para cruzamento consistente de opt-out.
 */
export function buildOptOutJidVariants(remoteJid: string): string[] {
  const variants = new Set<string>([remoteJid]);
  for (const phoneVar of getBrazilPhoneVariants(remoteJid)) {
    if (phoneVar.length >= 10) {
      variants.add(phoneVar);
      variants.add(`${phoneVar}@s.whatsapp.net`);
    }
  }
  return Array.from(variants);
}

/**
 * Marca `opt_out = true` em `leads_extraidos`, cancela disparos pendentes em campanhas
 * e follow-ups e pausa a sessão ativa quando o contato pede explicitamente para parar.
 * Evita que um mesmo número receba nova abordagem fria (principal gatilho do botão Denunciar).
 */
export async function recordLeadOptOut(params: {
  clientId: string;
  remoteJid: string;
  reason?: string;
  sessionId?: string | null;
}): Promise<{ updated: boolean }> {
  const { clientId, remoteJid, reason, sessionId } = params;
  if (!clientId || !remoteJid) return { updated: false };

  const jidList = buildOptOutJidVariants(remoteJid);
  const nowIso = new Date().toISOString();
  const note = `Opt-out automático detectado${reason ? `: "${reason.slice(0, 120)}"` : ""}`;

  let updated = false;
  try {
    const { data, error } = await supabaseAdmin
      .from("leads_extraidos")
      .update({ opt_out: true, updated_at: nowIso })
      .eq("client_id", clientId)
      .in("remoteJid", jidList)
      .select("id");

    if (!error && Array.isArray(data) && data.length > 0) {
      updated = true;
    } else if (error && (error as { code?: string }).code === "PGRST204") {
      await supabaseAdmin
        .from("leads_extraidos")
        .update({ opt_out: true })
        .eq("client_id", clientId)
        .in("remoteJid", jidList);
      updated = true;
    }
  } catch {
    /* tabela/coluna pode variar em bancos antigos */
  }

  try {
    await supabaseAdmin
      .from("campaign_targets")
      .update({ status: "skipped", error_message: note })
      .eq("client_id", clientId)
      .eq("status", "pending")
      .in("remote_jid", jidList);
  } catch {}

  try {
    await supabaseAdmin
      .from("followup_targets")
      .update({ status: "skipped", error_message: note, updated_at: nowIso })
      .eq("client_id", clientId)
      .in("status", ["pending", "waiting", "failed"])
      .in("remote_jid", jidList);
  } catch {}

  if (sessionId) {
    try {
      await supabaseAdmin
        .from("sessions")
        .update({
          bot_status: "bot_paused",
          paused_by: "opt_out",
          paused_at: nowIso,
          resume_at: null,
        })
        .eq("id", sessionId)
        .eq("client_id", clientId);
    } catch {}
  }

  return { updated };
}

/**
 * Verifica se o contato já está marcado como opt-out neste tenant (considerando variantes BR).
 */
export async function isLeadOptedOut(clientId: string, remoteJid: string): Promise<boolean> {
  if (!clientId || !remoteJid) return false;
  try {
    const jidList = buildOptOutJidVariants(remoteJid);
    const { data, error } = await supabaseAdmin
      .from("leads_extraidos")
      .select("id, opt_out")
      .eq("client_id", clientId)
      .in("remoteJid", jidList)
      .eq("opt_out", true);
    if (error || !Array.isArray(data)) return false;
    return data.length > 0;
  } catch {
    return false;
  }
}

export async function handleIncomingOptOutIfDetected(params: {
  clientId: string;
  remoteJid: string;
  messageText?: string | null;
  sessionId?: string | null;
}): Promise<boolean> {
  if (!params.messageText || !isExplicitOptOutRequest(params.messageText)) {
    return false;
  }
  await recordLeadOptOut({
    clientId: params.clientId,
    remoteJid: params.remoteJid,
    reason: params.messageText,
    sessionId: params.sessionId,
  });
  return true;
}

