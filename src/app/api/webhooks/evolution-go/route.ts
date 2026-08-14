/**
 * POST /api/webhooks/evolution-go
 *
 * Webhook handler do Evolution GO (Go/whatsmeow) — VERSÃO COMPLETA.
 *
 * Tem AS MESMAS funcionalidades do webhook da Evolution API legado:
 *   - Extração de texto/mídia (imagem, áudio, vídeo, documento, figurinha)
 *   - Upload de mídia (Supabase Storage)
 *   - Transcrição de áudio (whisper.cpp grátis → Gemini fallback)
 *   - Descrição de imagem/documento (Gemini)
 *   - Criação automática de contato + sessão
 *   - Anti-duplicação (message_id)
 *   - Auto-pausa quando humano responde
 *   - Disparo do agente IA
 *
 * Tudo é salvo nas MESMAS tabelas (chats_dashboard, messages, sessions).
 * O sistema não sabe qual provedor enviou.
 *
 * Público (não exige auth) — coberto pelo prefixo /api/webhooks/ no proxy.ts.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import {
  unwrapMessage, extractText, extractMessageType, extractMimetype,
  extractFileName, extractQuoted, extractBase64Media, sanitizeMimetype,
  mediaPlaceholder, uploadMediaBase64,
  transcribeAudio, describeImage, describeDocument,
  findOrCreateContact, findOrCreateSession, healLeadNameFromPushName,
  refreshProfilePicIfStale,
} from "../shared-helpers";
import { clientIdFromInstance, DEFAULT_CLIENT_ID } from "@/lib/tenant";
import { getInternalSecret, INTERNAL_SECRET_HEADER } from "@/lib/internal-auth";
import { isAiSend, isManualSend, isPendingAutomatedSend } from "@/lib/manual-send-registry";
import { shouldSkipGroupActions, getTranscriptionMethod } from "@/lib/bot-status";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Cache anti-duplicação em memória (igual ao webhook legado).
const seenMessageIds = new Set<string>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ ok: false, error: "Body inválido" }, { status: 400 });

    // O Evolution GO envia: { event, instance, data } ou o payload direto.
    const eventTypeRaw = String(body.event || "");
    const eventType = eventTypeRaw.toUpperCase();
    const instanceName = String(body.instance || body.instanceName || "");
    const raw = body.data || body;

    // Ignora eventos que não são de mensagem (CONNECTION, QRCODE, PRESENCE, etc).
    if (
      eventType &&
      !["MESSAGE", "ALL", "MESSAGES_UPSERT", "MESSAGES_UPSERT"].includes(eventType) &&
      eventTypeRaw !== "messages.upsert" &&
      !raw.key &&
      !raw.message
    ) {
      return NextResponse.json({ ok: true, skipped: true, reason: `event ${eventType}` });
    }

    // ===== Extrair dados (formato whatsmeow) =====
    const key = raw.key || {};
    const message = raw.message || body.message || {};
    const unwrapped = unwrapMessage(message);

    const remoteJid = String(key.remoteJid || raw.remoteJid || raw.from || "");
    if (!remoteJid) return NextResponse.json({ ok: true, skipped: true, reason: "sem remoteJid" });

    const fromMe = key.fromMe ?? raw.fromMe ?? false;
    const messageId = String(key.id || raw.id || raw.messageId || "");
    if (!messageId) return NextResponse.json({ ok: true, skipped: true, reason: "sem messageId" });

    // Anti-duplicação em memória (rápido).
    if (seenMessageIds.has(messageId)) {
      return NextResponse.json({ ok: true, skipped: true, reason: "mem-dup" });
    }
    if (seenMessageIds.size > 5000) {
      // Limpa periodicamente pra não crescer infinito.
      const arr = Array.from(seenMessageIds).slice(-2500);
      seenMessageIds.clear();
      arr.forEach((id) => seenMessageIds.add(id));
    }

    // Anti-duplicação no banco.
    const { data: existing } = await supabase
      .from("chats_dashboard")
      .select("id")
      .eq("message_id", messageId)
      .maybeSingle();
    if (existing) {
      seenMessageIds.add(messageId);
      return NextResponse.json({ ok: true, skipped: true, reason: "db-dup" });
    }

    // ===== Extrair conteúdo =====
    const msgType = extractMessageType(unwrapped);
    const text = extractText(unwrapped);
    const mimetype = extractMimetype(unwrapped);
    const fileName = extractFileName(unwrapped);
    const quoted = extractQuoted(unwrapped);
    const pushName = raw.pushName || raw.push_name || "";

    // ===== Resolver client_id (multi-tenant) =====
    // Webhook público não tem cookie — resolve dono pelo nome da instância.
    const clientId = (await clientIdFromInstance(instanceName)) || DEFAULT_CLIENT_ID;

    // ===== Criar/atualizar contato + sessão =====
    const contact = await findOrCreateContact(remoteJid, pushName || undefined, clientId);
    if (contact) {
      healLeadNameFromPushName(remoteJid, pushName || undefined, clientId);
    }
    const session = contact
      ? await findOrCreateSession(contact.id, instanceName, remoteJid, clientId)
      : null;

    // Verifica se grupos estão desativados para este agente.
    const groupDisabled = session?.agent_id
      ? await shouldSkipGroupActions(remoteJid, session.agent_id)
      : false;

    const transcriptionMethod = session?.agent_id
      ? await getTranscriptionMethod(session.agent_id)
      : "auto";

    // ===== Buscar foto de perfil (fire-and-forget) =====
    // Não bloqueia o processamento da mensagem. Só busca se o contato
    // não tem foto ou a URL está stale (>24h).
    if (!fromMe && instanceName) {
      refreshProfilePicIfStale(remoteJid, instanceName).catch(() => {});
    }

    // ===== Classificar sender (anti-eco: distingue IA / humano / cliente) =====
    let sender: "customer" | "ai" | "human" = "customer";
    if (fromMe) {
      if (isAiSend(messageId) || isPendingAutomatedSend(instanceName, remoteJid, text || "")) {
        sender = "ai";
      } else if (isManualSend(messageId)) {
        sender = "human";
      } else {
        sender = "human";
      }
    }

    // ===== Salvar mensagem básica PRIMEIRO (não bloqueia com processamento de mídia) =====
    const placeholderContent = text || mediaPlaceholder(msgType);
    const insertData: Record<string, any> = {
      remote_jid: remoteJid,
      instance_name: instanceName,
      message_id: messageId,
      sender_type: sender,
      content: placeholderContent,
      created_at: new Date().toISOString(),
      contact_name: pushName || null,
      client_id: clientId,
    };
    if (mimetype) insertData.mimetype = sanitizeMimetype(mimetype, "application/octet-stream");
    if (msgType !== "text" && msgType !== "unknown" && msgType !== "buttons" && msgType !== "reaction") {
      insertData.media_type = msgType;
    }
    if (quoted?.text) {
      insertData.quoted_text = quoted.text;
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("chats_dashboard")
      .insert(insertData)
      .select("id")
      .single();

    if (insertErr) {
      console.error("[evo-go-webhook] erro salvando:", insertErr.message);
      return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
    }

    seenMessageIds.add(messageId);

    // ===== Salvar também em messages (V2) + bump session (igual ao legado) =====
    if (session?.id) {
      supabase
        .from("messages")
        .insert({
          client_id: clientId,
          session_id: session.id,
          message_id: messageId,
          sender,
          content: text || null,
          media_category: msgType as any,
          mimetype: mimetype || null,
          file_name: fileName || null,
          delivery_status: fromMe ? "sent" : "pending",
          created_at: new Date().toISOString(),
        })
        .then(() => {}, () => {});

      const bumpPayload: any = { last_message_at: new Date().toISOString() };
      if (!fromMe) {
        bumpPayload.unread_count = (session as any).unread_count ? (session as any).unread_count + 1 : 1;
      }
      supabase.from("sessions").update(bumpPayload).eq("id", session.id).then(() => {}, () => {});
    }

    // ===== Auto-pausa só quando HUMANO responde (eco da IA não pausa) =====
    if (fromMe && sender === "human" && session?.id) {
      try {
        // Salvaguarda anti-eco: mensagem IDÊNTICA da IA nos últimos 30s = eco.
        let isEchoOfAi = false;
        if (text) {
          const { data: recentAi } = await supabase
            .from("chats_dashboard")
            .select("id")
            .eq("remote_jid", remoteJid)
            .eq("sender_type", "ai")
            .eq("content", text)
            .gte("created_at", new Date(Date.now() - 30_000).toISOString())
            .limit(1);
          isEchoOfAi = !!(recentAi && recentAi.length > 0);
        }
        if (!isEchoOfAi) {
          const { getHumanPauseConfig, snoozeSession } = await import("@/lib/bot-status");
          const hp = await getHumanPauseConfig();
          if (hp.enabled) {
            await snoozeSession(session.id, hp.minutes, "human");
          }
        }
      } catch (e: any) {
        console.warn("[evo-go-webhook] auto-pausa falhou:", e?.message);
      }
    }

    // ===== Processamento de MÍDIA (em background — não bloqueia o HTTP 200) =====
    const msgId = inserted?.id;
    const base64Media = extractBase64Media(unwrapped);

    if (!fromMe && base64Media) {
      after(async () => {
        try {
          let enrichedContent: string | null = null;
          let mediaUrl: string | null = null;

          // Upload da mídia.
          mediaUrl = await uploadMediaBase64(base64Media, remoteJid, sanitizeMimetype(mimetype || "", "application/octet-stream"));

          // Transcrição/descrição baseada no tipo.
          if (msgType === "audio" && !groupDisabled && transcriptionMethod !== "disabled") {
            const transcript = await transcribeAudio(base64Media, sanitizeMimetype(mimetype || "", "audio/ogg"), messageId, transcriptionMethod);
            enrichedContent = transcript ? `🎤 ${transcript}` : "[🎤 O cliente enviou um áudio que não consegui transcrever]";
          } else if (msgType === "image") {
            const desc = await describeImage(base64Media, sanitizeMimetype(mimetype || "", "image/jpeg"));
            enrichedContent = desc ? `📷 ${desc}` : null;
          } else if (msgType === "document") {
            const desc = await describeDocument(base64Media, sanitizeMimetype(mimetype || "", "application/pdf"), fileName);
            enrichedContent = desc ? `📄 ${fileName ? `[${fileName}] ` : ""}${desc}` : null;
          }

          // Atualiza a mensagem com o conteúdo enriquecido + URL da mídia.
          const update: Record<string, any> = {};
          if (enrichedContent) update.content = enrichedContent;
          if (mediaUrl) update.media_url = mediaUrl;
          if (Object.keys(update).length > 0) {
            await supabase.from("chats_dashboard").update(update).eq("id", msgId);
          }
        } catch (e: any) {
          console.warn("[evo-go-webhook] processamento de mídia falhou:", e?.message);
        }
      });
    }

    // ===== Disparar agente IA (mensagens do cliente com texto/mídia) =====
    if (!fromMe && (text || msgType === "audio" || msgType === "image") && session?.id && !groupDisabled) {
      const effectiveActive = (session as any)._effective_active ?? (session.bot_status === "bot_active");
      if (effectiveActive) {
        const internalSecret = getInternalSecret();
        if (!internalSecret) {
          await supabase
            .from("webhook_logs")
            .insert({
              instance_name: instanceName,
              event: "AGENT_DISPATCH_NO_SECRET",
              payload: { hint: "AUTH_SECRET ou SUPABASE_SERVICE_ROLE_KEY vazio; /api/agent/process vai rejeitar 401", remote_jid: remoteJid },
              created_at: new Date().toISOString(),
            })
            .then(() => {}, () => {});
        } else {
          try {
            const agentMod = await import("@/app/api/agent/process/route");
            const fakeReq = new NextRequest("http://internal/api/agent/process", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                [INTERNAL_SECRET_HEADER]: internalSecret,
              },
              body: JSON.stringify({
                instanceName,
                remoteJid,
                text: text || (msgType === "audio" ? "[🎤 Áudio — transcrevendo...]" : mediaPlaceholder(msgType)),
                sessionId: session.id,
              }),
            });
            // FIX Next 16: NÃO fire-and-forget. Next standalone cancela trabalho
            // pendente após handler retorn. Bloqueia ~3-7s; Evolution aceita até 30s.
            await agentMod.POST(fakeReq);
          } catch (e: any) {
            console.warn("[evo-go-webhook] agente falhou:", e?.message);
            await supabase
              .from("webhook_logs")
              .insert({
                instance_name: instanceName,
                event: "AGENT_DISPATCH_FETCH_FAIL",
                payload: { error: String(e?.message || e), via: "direct-call" },
                created_at: new Date().toISOString(),
              })
              .then(() => {}, () => {});
          }
        }
      } else {
        await supabase
          .from("webhook_logs")
          .insert({
            instance_name: instanceName,
            event: "AGENT_SKIP_PAUSED",
            payload: { remoteJid, bot_status: session.bot_status, message_saved: true },
            created_at: new Date().toISOString(),
          })
          .then(() => {}, () => {});
      }
    }

    return NextResponse.json({ ok: true, saved: true, msgId });
  } catch (err: any) {
    console.error("[evo-go-webhook] erro:", err?.message);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}

/** Health check. */
export async function GET() {
  return NextResponse.json({ ok: true, provider: "evolution-go", timestamp: new Date().toISOString() });
}
