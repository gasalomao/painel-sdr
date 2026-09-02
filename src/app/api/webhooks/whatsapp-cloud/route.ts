/**
 * Webhook único do WhatsApp Cloud API (Meta).
 *
 * GET  → handshake. Meta manda hub.mode=subscribe & hub.verify_token & hub.challenge.
 *        Se o verify_token bate com qualquer channel_connections.provider_config.verify_token
 *        (ou com WHATSAPP_CLOUD_VERIFY_TOKEN do .env), a gente devolve o challenge cru.
 * POST → eventos. Cada entry traz `metadata.phone_number_id` que decide PARA QUAL instância
 *        a mensagem pertence (suporta múltiplas conexões Cloud no mesmo App Meta).
 *
 * Convertemos o payload pro mesmo formato interno que o webhook da Evolution já produz:
 * persistimos em `chats_dashboard` + `messages`, criamos contact/session e disparamos
 * `/api/agent/process` com o sessionId — exatamente igual ao fluxo Evolution.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { whatsappCloud } from "@/lib/whatsapp-cloud";
import { resolveChannel, resolveConnectionFromPhoneNumberId } from "@/lib/channel";
import { getEffectiveStatus } from "@/lib/bot-status";
import { shouldSkipGroupActions, getTranscriptionMethod, getTranscriptionModels } from "@/lib/bot-status";
import { isManualSend } from "@/lib/manual-send-registry";
import { getInternalSecret, INTERNAL_SECRET_HEADER } from "@/lib/internal-auth";
import { createHmac, timingSafeEqual } from "node:crypto";
import { shouldLogOnce } from "@/lib/webhook-security";

export const dynamic = "force-dynamic";

const INTERNAL_BASE = `http://localhost:${process.env.PORT || 3000}`;
const ENV_VERIFY_TOKEN = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN || "";
const ENV_APP_SECRET = process.env.WHATSAPP_CLOUD_APP_SECRET || "";

/**
 * Valida X-Hub-Signature-256 contra o raw body usando o app_secret da conexão
 * que casa com o phone_number_id do evento (ou ENV como fallback).
 *
 * Retorna:
 *   - "valid"     → assinatura confere
 *   - "missing"   → não há app_secret configurado em nenhum lado (rollout ainda em curso)
 *   - "no_header" → header não veio (testes locais; Meta sempre manda em prod)
 *   - "invalid"   → assinatura veio e NÃO confere — rejeitar
 */
type MetaSignatureResult = {
  status: "valid" | "missing" | "no_header" | "invalid";
  clientIds: string[];
  logClientId: string | null;
};

async function verifyMetaSignature(
  signatureHeader: string | null,
  rawBody: string,
  phoneNumberIds: string[],
): Promise<MetaSignatureResult> {
  const { data } = phoneNumberIds.length > 0
    ? await supabase
      .from("channel_connections")
      .select("client_id, provider_config")
      .eq("provider", "whatsapp_cloud")
      .in("provider_config->>phone_number_id", phoneNumberIds)
    : { data: [] as any[] };

  const connections = (data || []).filter((row) => row?.client_id);
  const clientIds = Array.from(new Set(connections.map((row) => row.client_id)));
  const base = { clientIds, logClientId: clientIds.length === 1 ? clientIds[0] : null };

  let hasConfiguredSecret = !!ENV_APP_SECRET;
  const m = signatureHeader ? /^sha256=([0-9a-f]+)$/i.exec(signatureHeader.trim()) : null;
  const recv = m ? Buffer.from(m[1], "hex") : null;
  const wellFormed = !!recv && recv.length === 32;

  if (!signatureHeader) {
    return { ...base, status: hasConfiguredSecret || connections.some((row) => row.provider_config?.app_secret) ? "no_header" : "missing" };
  }
  if (!wellFormed || !recv) return { ...base, status: "invalid" };

  const digestMatches = (secret: string) => {
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    return expected.length === recv.length && timingSafeEqual(expected, recv);
  };

  // Segredo específico da conexão só pode validar seu próprio phone_number_id;
  // o secret global do app é a exceção intencional (plataforma, não tenant).
  const validPhoneIds = new Set<string>();
  for (const row of connections) {
    const cfg = row.provider_config || {};
    const phoneId = cfg.phone_number_id;
    const candidates = [cfg.app_secret, ENV_APP_SECRET].filter((s): s is string => typeof s === "string" && !!s);
    if (candidates.length > 0) hasConfiguredSecret = true;
    if (candidates.some(digestMatches) && phoneId) validPhoneIds.add(String(phoneId));
  }

  // Sem conexão cadastrada, ENV continua como modo legado até provisionamento.
  if (connections.length === 0 && ENV_APP_SECRET && digestMatches(ENV_APP_SECRET)) {
    return { ...base, status: "valid" };
  }
  if (phoneNumberIds.length > 0 && phoneNumberIds.every((id) => validPhoneIds.has(id))) {
    return { ...base, status: "valid" };
  }
  return { ...base, status: "invalid" };
}

// ============================================================
// GET: hub.challenge verification
// ============================================================
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("hub.mode");
  const token = sp.get("hub.verify_token");
  const challenge = sp.get("hub.challenge");

  if (mode !== "subscribe" || !token) {
    return new NextResponse("missing params", { status: 400 });
  }

  // Aceita match pelo .env OU por qualquer conexão Cloud cadastrada no banco.
  if (ENV_VERIFY_TOKEN && token === ENV_VERIFY_TOKEN) {
    return new NextResponse(challenge || "", { status: 200 });
  }

  const { data } = await supabase
    .from("channel_connections")
    .select("instance_name")
    .eq("provider", "whatsapp_cloud")
    .eq("provider_config->>verify_token", token)
    .maybeSingle();

  if (data?.instance_name) {
    return new NextResponse(challenge || "", { status: 200 });
  }

  await supabase.from("webhook_logs").insert({
    instance_name: "whatsapp_cloud",
    event: "CLOUD_VERIFY_FAIL",
    payload: { token_recebido: token, hint: "Nenhuma conexão Cloud com esse verify_token." },
    created_at: new Date().toISOString(),
  }).then(() => {}, () => {});

  return new NextResponse("verify_token mismatch", { status: 403 });
}

// ============================================================
// POST: eventos
// ============================================================
export async function POST(req: NextRequest) {
  // Lê raw body uma vez — precisamos pra HMAC verification
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ success: false, error: "Body inválido" }, { status: 400 });
  }
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 });
  }

  if (body?.object !== "whatsapp_business_account") {
    return NextResponse.json({ success: true, ignored: "not_whatsapp_event" });
  }

  const parsed = whatsappCloud.parseIncoming(body);

  // ====== HMAC X-Hub-Signature-256 (Meta) ======
  // Backwards-compat: aceita SE não há app_secret configurado em nenhum lugar,
  // mas em produção COM secret cadastrado, exige header e bate.
  const phoneIds = Array.from(new Set([
    ...parsed.messages.map(m => m.phoneNumberId),
    ...parsed.statuses.map(s => s.phoneNumberId),
  ].filter(Boolean) as string[]));
  const sigHeader = req.headers.get("x-hub-signature-256");
  const sigResult = await verifyMetaSignature(sigHeader, rawBody, phoneIds);
  const logCtx = { client_id: sigResult.logClientId ?? undefined, instance_name: "whatsapp_cloud" };
  if (sigResult.status === "invalid") {
    await supabase.from("webhook_logs").insert({
      ...logCtx,
      event: "CLOUD_SIGNATURE_INVALID",
      payload: { phone_ids: phoneIds, has_header: !!sigHeader },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return NextResponse.json({ success: false, error: "Assinatura inválida" }, { status: 401 });
  }
  if (sigResult.status === "no_header") {
    await supabase.from("webhook_logs").insert({
      ...logCtx,
      event: "CLOUD_SIGNATURE_MISSING_HEADER",
      payload: { phone_ids: phoneIds },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return NextResponse.json({ success: false, error: "Header de assinatura ausente" }, { status: 401 });
  }
  if (sigResult.status === "missing" && process.env.NODE_ENV === "production") {
    return NextResponse.json({ success: false, error: "App secret não configurado" }, { status: 401 });
  }
  if (sigResult.status === "missing" && shouldLogOnce("cloud-no-secret", "whatsapp_cloud")) {
    await supabase.from("webhook_logs").insert({
      ...logCtx,
      event: "CLOUD_NO_APP_SECRET",
      payload: { hint: "Sem app_secret cadastrado — webhook forjável. Configure o secret do app Meta." },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
  }

  // Log raw pra debug — só uma linha resumida pra não inflar a tabela
  await supabase.from("webhook_logs").insert({
    instance_name: "whatsapp_cloud",
    event: "CLOUD_WEBHOOK_RAW",
    payload: {
      messages: parsed.messages.length,
      statuses: parsed.statuses.length,
      first_phone: parsed.messages[0]?.phoneNumberId || parsed.statuses[0]?.phoneNumberId,
    },
    created_at: new Date().toISOString(),
  }).then(() => {}, () => {});

  // ====== STATUS UPDATES ======
  for (const s of parsed.statuses) {
    const connection = await resolveConnectionFromPhoneNumberId(s.phoneNumberId);
    if (!connection) continue;
    const map: Record<string, string> = {
      sent: "sent", delivered: "delivered", read: "read", failed: "error",
    };
    const norm = map[s.status] || s.status;
    await Promise.all([
      supabase.from("messages").update({ delivery_status: norm }).eq("message_id", s.messageId).eq("client_id", connection.clientId),
      supabase.from("chats_dashboard").update({ status_envio: norm }).eq("message_id", s.messageId).eq("client_id", connection.clientId),
    ]);
  }

  // ====== INCOMING MESSAGES ======
  for (const m of parsed.messages) {
    try {
      const connection = await resolveConnectionFromPhoneNumberId(m.phoneNumberId);
      if (!connection) {
        console.warn(`[Cloud Webhook] Mensagem para phone_number_id=${m.phoneNumberId} sem conexão cadastrada — ignorada.`);
        await supabase.from("webhook_logs").insert({
          client_id: sigResult.logClientId ?? undefined,
          instance_name: "whatsapp_cloud",
          event: "CLOUD_NO_INSTANCE",
          payload: { phone_number_id: m.phoneNumberId, message_id: m.messageId },
          created_at: new Date().toISOString(),
        }).then(() => {}, () => {});
        continue;
      }
      const { instanceName, clientId } = connection;

      // Anti-duplicação: se já temos a msg, pula
      const [{ data: dupV2 }, { data: dupLegacy }] = await Promise.all([
        supabase.from("messages").select("id").eq("message_id", m.messageId).eq("client_id", clientId).maybeSingle(),
        supabase.from("chats_dashboard").select("id").eq("message_id", m.messageId).eq("client_id", clientId).maybeSingle(),
      ]);
      if (dupV2 || dupLegacy) continue;

      // Find/create contact + session
      let contactId: string | null = null;
      let sessionRow: any = null;
      try {
        const { data: existing } = await supabase
          .from("contacts").select("id, push_name").eq("remote_jid", m.remoteJid).eq("client_id", clientId).maybeSingle();
        if (existing) {
          contactId = existing.id;
          if (m.pushName && existing.push_name !== m.pushName) {
            await supabase.from("contacts").update({ push_name: m.pushName }).eq("id", contactId).eq("client_id", clientId);
          }
        } else {
          const ins = await supabase.from("contacts").insert({
            client_id: clientId,
            remote_jid: m.remoteJid,
            phone_number: m.from,
            push_name: m.pushName || null,
          }).select("id").single();
          contactId = ins.data?.id || null;
        }

        if (contactId) {
          const { data: existSess } = await supabase
            .from("sessions")
            .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id, unread_count")
            .eq("contact_id", contactId).eq("instance_name", instanceName).eq("client_id", clientId).maybeSingle();
          if (existSess) {
            sessionRow = existSess;
          } else {
            const ch = await resolveChannel(instanceName);
            const ns = await supabase.from("sessions").insert({
              client_id: clientId,
              contact_id: contactId,
              instance_name: instanceName,
              agent_id: ch.agent_id || 1,
              bot_status: "bot_active",
            }).select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id, unread_count").single();
            sessionRow = ns.data;
          }
        }
      } catch (sErr: any) {
        console.warn("[Cloud Webhook] contact/session falhou (não-fatal):", sErr?.message);
      }

      // Verifica se grupos estão desativados para este agente.
      const groupDisabled = sessionRow?.agent_id
        ? await shouldSkipGroupActions(m.remoteJid, sessionRow.agent_id)
        : false;

      const transcriptionMethod = sessionRow?.agent_id
        ? await getTranscriptionMethod(sessionRow.agent_id)
        : "auto";

      // Sender (Cloud webhook não dispara fromMe automaticamente — apenas mensagens recebidas)
      // Se for echo de envio nosso (alguns Apps mandam), tratamos via isManualSend.
      const fromMe = false; // Cloud só entrega messages do usuário; status de envio vai no campo statuses
      const sender: "customer" | "ai" | "human" = fromMe
        ? (isManualSend(m.messageId) ? "human" : (sessionRow?.bot_status === "bot_active" ? "ai" : "human"))
        : "customer";

      // Conteúdo: text direto, ou caption, ou placeholder de mídia
      let content: string = m.text || m.caption || "";
      let mediaUrl: string | null = null;
      let effectiveMime: string | null = null;
      // Provider da transcrição (UI only — badge no chat; nunca vai pro agente).
      let transcribeProvider: string | null = null;

      // ===== Mídia: baixar + transcrever ANTES de salvar (o chat só mostra
      // o áudio já transcrito; placeholder apenas se transcrição falhou) =====
      if (!content && m.mediaId) {
        if (m.type === "audio" && !groupDisabled && transcriptionMethod !== "disabled") {
          try {
            const ch = await resolveChannel(instanceName);
            if (ch.cloud) {
              const { base64, mimetype: fMime } = await whatsappCloud.fetchMedia(ch.cloud, m.mediaId!);
              effectiveMime = fMime;
              // Upload pro Storage (mesmo bucket do Evolution)
              try {
                const buffer = Buffer.from(base64, "base64");
                const ext = (fMime.split("/")[1] || "bin").split(";")[0];
                const path = `${m.remoteJid}/${Date.now()}.${ext}`;
                const { error: upErr } = await supabase.storage
                  .from("whatsapp_media").upload(path, buffer, { contentType: fMime, upsert: true });
                if (!upErr) mediaUrl = supabase.storage.from("whatsapp_media").getPublicUrl(path).data.publicUrl;
              } catch (upErr: any) {
                console.warn("[Cloud Media] upload falhou:", upErr?.message);
              }
              const { transcribeAudioDetailed } = await import("@/app/api/webhooks/shared-helpers");
              const orModels = sessionRow?.agent_id ? await getTranscriptionModels(sessionRow.agent_id) : [];
              const det = await transcribeAudioDetailed(base64, fMime || "audio/ogg", m.messageId, transcriptionMethod, { models: orModels });
              content = det ? `🎤 ${det.text}` : "[🎤 O cliente enviou um áudio que não consegui transcrever]";
              if (det) transcribeProvider = det.provider;
            } else {
              content = "[🎤 O cliente enviou um áudio que não consegui transcrever]";
            }
          } catch (mErr: any) {
            console.warn("[Cloud Media] transcrição falhou:", mErr?.message);
            content = "[🎤 O cliente enviou um áudio que não consegui transcrever]";
          }
        } else {
          const placeholders: Record<string, string> = {
            image: "[📷 Imagem]",
            audio: "[🎤 Áudio]",
            video: "[🎥 Vídeo]",
            document: m.fileName ? `[📄 ${m.fileName}]` : "[📄 Documento]",
            sticker: "[Sticker]",
          };
          content = placeholders[m.type] || "[Mídia]";
        }
      }

      // Insert chats_dashboard (UI lê isso). Duplicata (23505) = Meta reentregou
      // → NÃO dispara o agente de novo (antes virava resposta DUPLA).
      let msgDup = false;
      const { encodeTranscriptionMime } = await import("@/lib/transcription-label");
      const cloudMime = m.type === "audio" && transcribeProvider
        ? encodeTranscriptionMime(effectiveMime || "audio/ogg", transcribeProvider)
        : effectiveMime;

      const { error: dashErr } = await supabase.from("chats_dashboard").insert({
        client_id: clientId,
        instance_name: instanceName,
        message_id: m.messageId,
        remote_jid: m.remoteJid,
        sender_type: sender,
        content,
        status_envio: "received",
        ...(mediaUrl ? { media_url: mediaUrl } : {}),
        ...(m.type !== "text" ? { media_type: m.type } : {}),
        ...(cloudMime ? { mimetype: cloudMime } : {}),
        created_at: new Date(m.timestamp * 1000).toISOString(),
      });
      if (dashErr) {
        if (dashErr.code === "23505") {
          return NextResponse.json({ ok: true, skipped: true, reason: "duplicata" });
        }
        console.warn("[Cloud Webhook] dash insert:", dashErr.message);
      }

      // Insert messages (V2)
      if (sessionRow?.id) {
        const { error: msgErr } = await supabase.from("messages").insert({
          client_id: clientId,
          session_id: sessionRow.id,
          message_id: m.messageId,
          sender,
          content: m.text || null,
          media_category: m.type === "text" ? "text" : m.type,
          mimetype: m.mimetype || null,
          file_name: m.fileName || null,
          delivery_status: "pending",
          created_at: new Date(m.timestamp * 1000).toISOString(),
        });
        if (msgErr) {
          if (msgErr.code === "23505") msgDup = true;
          else console.warn("[Cloud Webhook] messages insert:", msgErr.message);
        }

        // Update session
        const updPayload: any = { last_message_at: new Date().toISOString() };
        updPayload.unread_count = (sessionRow.unread_count || 0) + 1;
        supabase.from("sessions").update(updPayload).eq("id", sessionRow.id).eq("client_id", clientId).then(() => {}, () => {});
      }

      // (mídia já processada inline acima, antes do insert)

      // Dispara agente com texto direto (igual webhook Evolution).
      // Áudio: `content` já contém a transcrição (ou placeholder de falha).
      // Duplicata (Meta reentregou) → NÃO dispara de novo (resposta dupla).
      if (msgDup) {
        return NextResponse.json({ ok: true, skipped: true, reason: "duplicata-messages" });
      }
      if (content && (m.text || m.caption || m.type === "audio") && sessionRow?.id && !groupDisabled) {
        const eff = await getEffectiveStatus(sessionRow as any);
        if (eff.isActive) {
          // Precondição: sem secret interno o /api/agent/process responde 401
          // silencioso — loga o hint pra diagnóstico (paridade com webhook legado).
          const internalSecretValue = getInternalSecret();
          if (!internalSecretValue) {
            supabase.from("webhook_logs").insert({
              client_id: clientId,
              instance_name: instanceName,
              event: "AGENT_DISPATCH_NO_SECRET",
              payload: { hint: "AUTH_SECRET ou SUPABASE_SERVICE_ROLE_KEY vazio no env; /api/agent/process vai rejeitar com 401", remote_jid: m.remoteJid },
              created_at: new Date().toISOString(),
            }).then(() => {}, () => {});
          }
          try {
            // FIX crítico: era fetch fire-and-forget — Next standalone CANCELA o
            // trabalho pendente quando o handler retorna (mesmo bug já corrigido
            // nos webhooks legado e GO). Agora invoca em-processo, awaited.
            const agentMod = await import("@/app/api/agent/process/route");
            const fakeReq = new NextRequest("http://internal/api/agent/process", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                [INTERNAL_SECRET_HEADER]: getInternalSecret(),
              },
              body: JSON.stringify({ instanceName, remoteJid: m.remoteJid, text: m.text || m.caption || content, sessionId: sessionRow.id }),
            });
            // Serializa por sessão (anti-resposta-dupla em msgs rápidas).
            const { withSessionLock } = await import("@/lib/session-lock");
            await withSessionLock(sessionRow.id, () => agentMod.POST(fakeReq));
          } catch (e: any) {
            console.warn("[Cloud Webhook] dispatch do agente falhou:", e?.message);
            supabase.from("webhook_logs").insert({
              client_id: clientId,
              instance_name: instanceName,
              event: "AGENT_DISPATCH_FAIL",
              payload: { error: String(e?.message || e), via: "direct-call" },
              created_at: new Date().toISOString(),
            }).then(() => {}, () => {});
          }
        } else {
          await supabase.from("webhook_logs").insert({
            client_id: clientId,
            instance_name: instanceName,
            event: "AGENT_SKIP_PAUSED",
            payload: { remoteJid: m.remoteJid, bot_status: sessionRow.bot_status, source: "cloud" },
            created_at: new Date().toISOString(),
          }).then(() => {}, () => {});
        }
      }

      // Marca como lida (efeito visual no app do cliente — opcional)
      try {
        const ch = await resolveChannel(instanceName);
        if (ch.cloud) await whatsappCloud.markRead(ch.cloud, m.messageId);
      } catch { /* não-fatal */ }
    } catch (err: any) {
      console.error("[Cloud Webhook] message handler falhou:", err?.message);
    }
  }

  // Meta exige 200 rápido — qualquer outro código gera retry e duplicação
  return NextResponse.json({ success: true });
}
