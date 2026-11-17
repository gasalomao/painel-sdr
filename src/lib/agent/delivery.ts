import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

export interface ChannelSenderModule {
  sendMessage: (
    remoteJid: string,
    text: string,
    instanceName: string,
    options?: Record<string, unknown>,
  ) => Promise<{ ok?: boolean; error?: string; messageId?: string; key?: { id?: string }; data?: { key?: { id?: string } } } | null>;
  sendMedia: (
    remoteJid: string,
    caption: string,
    media: { mediaUrl: string; url: string; type: string; mimetype: string; fileName: string },
    instanceName: string,
  ) => Promise<{ ok?: boolean; error?: string; messageId?: string; key?: { id?: string } } | null>;
}

/**
 * Carrega URLs de imagens enviadas recentemente nesta sessão/conversa para supressão anti-spam.
 */
export async function loadRecentlySentMediaUrls(params: {
  enabled: boolean;
  windowMs: number;
  sessionId: string | null;
  remoteJid: string;
  clientId: string;
}): Promise<Map<string, number>> {
  const sentMediaRecently = new Map<string, number>();
  const { enabled, windowMs, sessionId, remoteJid, clientId } = params;
  if (!enabled || (!sessionId && !remoteJid) || !supabase) return sentMediaRecently;

  try {
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const { data: pastMsgs } = sessionId
      ? await supabase
          .from("messages")
          .select("media_url, content, created_at")
          .eq("client_id", clientId)
          .eq("session_id", sessionId)
          .eq("sender", "ai")
          .gte("created_at", sinceIso)
      : await supabase
          .from("chats_dashboard")
          .select("media_url, content, created_at")
          .eq("client_id", clientId)
          .eq("remote_jid", remoteJid)
          .eq("sender_type", "ai")
          .gte("created_at", sinceIso);

    for (const pm of (pastMsgs || []) as Array<{ media_url?: string | null; content?: string | null; created_at?: string | null }>) {
      const ts = pm.created_at ? new Date(pm.created_at).getTime() : 0;
      if (pm.media_url) sentMediaRecently.set(pm.media_url.trim(), ts);
      if (pm.content) {
        const matches = Array.from(pm.content.matchAll(/https?:\/\/[^\s\]]+\.(?:jpg|jpeg|png|webp|gif)/gi));
        for (const m of matches) {
          if (m[0]) sentMediaRecently.set(String(m[0]).trim(), ts);
        }
      }
    }
  } catch (err: unknown) {
    console.warn("[AGENT] Erro ao consultar histórico de mídias para dedup:", err instanceof Error ? err.message : String(err));
  }

  return sentMediaRecently;
}

function isInstanceNotFoundError(value: unknown): boolean {
  const s = String(value || "").toLowerCase();
  return s.includes("does not exist") || s.includes("not found") || s.includes("404");
}

function reportAgentSendOutcome(clientId: string, instanceName: string, isTestMode: boolean, ok: boolean, errorMsg?: unknown): void {
  if (isTestMode || !clientId || !instanceName) return;
  if (ok) {
    import("@/lib/warmup/warmup-engine")
      .then((m) => m.recordWebhookDeliveryFeedback?.({ clientId, instanceName, statusText: "delivered" }))
      .catch(() => {});
    return;
  }
  if (/429|rate|timeout|timed out|econn|disconnect|closed|50[0-4]/i.test(String(errorMsg || ""))) {
    import("@/lib/warmup/warmup-engine")
      .then((m) => m.recordWebhookDeliveryFeedback?.({ clientId, instanceName, statusText: "error" }))
      .catch(() => {});
  }
}

export function createWhatsAppDeliveryHelpers(params: {
  channelMod: ChannelSenderModule;
  remoteJid: string;
  clientId: string;
  initialInstanceName: string;
  sessionId: string | null;
  isTestMode: boolean;
  typingDelaySeconds: number;
  customerInboundCount: number;
  sentMediaRecently: Map<string, number>;
}) {
  const { channelMod, remoteJid, clientId, sessionId, isTestMode, typingDelaySeconds, customerInboundCount, sentMediaRecently } = params;
  let instanceName = params.initialInstanceName;
  let lastSendResult: unknown = null;
  let anySendError: string | null = null;

  async function tryMigrateActiveInstance(text: string): Promise<string | null> {
    if (isTestMode || !supabase) return null;
    const { data: activeConns } = await supabase
      .from("channel_connections")
      .select("instance_name")
      .eq("client_id", clientId)
      .in("status", ["open", "CONNECTED", "connected"])
      .limit(1);

    const altInstance = (activeConns?.[0] as { instance_name?: string } | undefined)?.instance_name;
    if (!altInstance || altInstance === instanceName) return null;

    console.log(`[AGENT] Auto-migrando sessão ${sessionId} de "${instanceName}" para "${altInstance}" ativo.`);
    await supabase
      .from("sessions")
      .update({ instance_name: altInstance })
      .eq("id", sessionId)
      .eq("client_id", clientId);
    instanceName = altInstance;

    try {
      const { registerPendingAutomatedSend } = await import("@/lib/manual-send-registry");
      registerPendingAutomatedSend(instanceName, remoteJid, text);
    } catch { /* ignore */ }
    return altInstance;
  }

  async function persistOutboundMessage(msgId: string, text: string, ok: boolean, mediaUrl?: string): Promise<void> {
    const nowIso = new Date().toISOString();
    if (sessionId && supabase) {
      await supabase
        .from("messages")
        .insert({
          client_id: clientId,
          session_id: sessionId,
          remote_jid: remoteJid,
          instance_name: instanceName,
          message_id: msgId,
          sender: "ai",
          content: mediaUrl ? text || mediaUrl : text,
          ...(mediaUrl ? { media_category: "image", media_url: mediaUrl } : {}),
          delivery_status: ok ? "sent" : "error",
          created_at: nowIso,
        })
        .then(() => {}, () => {});
    }
    if (supabase) {
      await supabase
        .from("chats_dashboard")
        .insert({
          message_id: msgId,
          remote_jid: remoteJid,
          sender_type: "ai",
          content: mediaUrl ? text || `[Imagem] ${mediaUrl}` : text,
          status_envio: ok ? "sent" : "error",
          instance_name: instanceName,
          client_id: clientId,
          ...(mediaUrl ? { media_url: mediaUrl, media_type: "image" } : {}),
          created_at: nowIso,
        })
        .then(() => {}, () => {});
    }
  }

  const sendProductPhoto = async (mediaUrl: string, caption: string): Promise<boolean> => {
    try {
      try {
        const { registerPendingAutomatedMedia, registerPendingAutomatedSend } = await import("@/lib/manual-send-registry");
        registerPendingAutomatedMedia(instanceName, remoteJid);
        if (caption) registerPendingAutomatedSend(instanceName, remoteJid, caption);
      } catch { /* ignore */ }

      const mimetype = /\.(jpg|jpeg)$/i.test(mediaUrl)
        ? "image/jpeg"
        : /\.png$/i.test(mediaUrl)
          ? "image/png"
          : /\.webp$/i.test(mediaUrl)
            ? "image/webp"
            : /\.gif$/i.test(mediaUrl)
              ? "image/gif"
              : "image/jpeg";

      const mediaRes = await channelMod.sendMedia(
        remoteJid,
        caption,
        {
          mediaUrl,
          url: mediaUrl,
          type: "image",
          mimetype,
          fileName: mediaUrl.split("/").pop()?.split("?")[0] || `produto-${Date.now()}.jpg`,
        },
        instanceName,
      );
      if (mediaRes?.ok === false) {
        console.warn(`[AGENT] Provider rejeitou mídia (${mediaRes.error}). URL: ${mediaUrl}`);
      }
      const mediaMsgId =
        mediaRes?.messageId ||
        mediaRes?.key?.id ||
        `agent-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const { registerAiSend } = await import("@/lib/manual-send-registry");
        registerAiSend(mediaMsgId);
      } catch { /* ignore */ }

      sentMediaRecently.set(mediaUrl, Date.now());
      await persistOutboundMessage(mediaMsgId, caption, mediaRes?.ok !== false, mediaUrl);
      return mediaRes?.ok !== false;
    } catch (mErr: unknown) {
      console.warn("[AGENT] Falha ao enviar foto vinculada de produto:", mErr instanceof Error ? mErr.message : String(mErr));
      return false;
    }
  };

  const sendAndPersistText = async (text: string, customDelayMs?: number): Promise<string | null> => {
    if (!text.trim()) return null;
    const effectiveDelayMs = Math.max(1, Math.round(customDelayMs ?? typingDelaySeconds * 1000));
    const sendOptions =
      !isTestMode && customerInboundCount <= 1
        ? { delay: effectiveDelayMs, linkPreview: false }
        : { delay: effectiveDelayMs };

    try {
      try {
        const { registerPendingAutomatedSend } = await import("@/lib/manual-send-registry");
        registerPendingAutomatedSend(instanceName, remoteJid, text);
      } catch { /* ignore */ }

      let sendResult = await channelMod.sendMessage(remoteJid, text, instanceName, sendOptions);
      if (sendResult && sendResult.ok === false && isInstanceNotFoundError(sendResult.error)) {
        console.warn(`[AGENT] Instância "${instanceName}" falhou (não existe/404). Tentando auto-migrar conexão...`);
        const migrated = await tryMigrateActiveInstance(text);
        if (migrated) {
          sendResult = await channelMod.sendMessage(remoteJid, text, instanceName, sendOptions);
        }
      }

      const msgId =
        sendResult?.key?.id ||
        sendResult?.data?.key?.id ||
        sendResult?.messageId ||
        `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const { registerAiSend } = await import("@/lib/manual-send-registry");
        registerAiSend(msgId);
      } catch { /* ignore */ }
      lastSendResult = sendResult;

      await persistOutboundMessage(msgId, text, sendResult?.ok !== false);
      if (sendResult?.ok === false) {
        anySendError = sendResult.error || "Falha no envio";
        reportAgentSendOutcome(clientId, instanceName, isTestMode, false, sendResult.error);
      } else {
        reportAgentSendOutcome(clientId, instanceName, isTestMode, true);
      }
      return msgId;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isInstanceNotFoundError(errMsg) && !isTestMode) {
        try {
          console.warn(`[AGENT] Instância "${instanceName}" falhou (catch não existe/404). Tentando auto-migrar conexão...`);
          const migrated = await tryMigrateActiveInstance(text);
          if (migrated) {
            const sendResult = await channelMod.sendMessage(remoteJid, text, instanceName, sendOptions);
            const msgId = sendResult?.key?.id || sendResult?.messageId || `agent-${Date.now()}`;
            try {
              const { registerAiSend } = await import("@/lib/manual-send-registry");
              registerAiSend(msgId);
            } catch { /* ignore */ }
            await persistOutboundMessage(msgId, text, sendResult?.ok !== false);
            reportAgentSendOutcome(clientId, instanceName, isTestMode, true);
            return msgId;
          }
        } catch (migErr: unknown) {
          console.error("[AGENT] Falha na auto-migração de instância:", migErr instanceof Error ? migErr.message : String(migErr));
        }
      }
      console.error("[AGENT] Falha ao enviar texto:", errMsg);
      anySendError = errMsg;
      reportAgentSendOutcome(clientId, instanceName, isTestMode, false, errMsg);
      return null;
    }
  };

  return {
    sendProductPhoto,
    sendAndPersistText,
    getState: () => ({ instanceName, lastSendResult, anySendError }),
  };
}

