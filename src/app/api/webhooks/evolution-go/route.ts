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

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import {
  unwrapMessage, extractText, extractMessageType, extractMimetype,
  extractFileName, extractQuoted, extractBase64Media, sanitizeMimetype,
  mediaPlaceholder, uploadMediaBase64,
  transcribeAudio, describeImage, describeDocument,
  findOrCreateContact, findOrCreateSession, healLeadNameFromPushName,
  requireClientId,
} from "../shared-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Cache anti-duplicação em memória (igual ao webhook legado).
const seenMessageIds = new Set<string>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ ok: false, error: "Body inválido" }, { status: 400 });

    // O Evolution GO envia: { event, instance, data } ou o payload direto.
    const eventType = String(body.event || "").toUpperCase();
    const instanceName = String(body.instance || body.instanceName || "");
    const raw = body.data || body;

    // Ignora eventos que não são de mensagem (CONNECTION, QRCODE, PRESENCE, etc).
    if (eventType && eventType !== "MESSAGE" && eventType !== "ALL" && !raw.key && !raw.message) {
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
    const ctx = await requireClientId(req).catch(() => null);
    const clientId = ctx?.ok ? ctx.clientId : "00000000-0000-0000-0000-000000000001";

    // ===== Criar/atualizar contato + sessão =====
    const contact = await findOrCreateContact(remoteJid, pushName || undefined, clientId);
    if (contact) {
      healLeadNameFromPushName(remoteJid, pushName || undefined, clientId);
    }
    const session = contact
      ? await findOrCreateSession(contact.id, instanceName, remoteJid, clientId)
      : null;

    // ===== Salvar mensagem básica PRIMEIRO (não bloqueia com processamento de mídia) =====
    const placeholderContent = text || mediaPlaceholder(msgType);
    const insertData: Record<string, any> = {
      remote_jid: remoteJid,
      instance_name: instanceName,
      message_id: messageId,
      sender_type: fromMe ? "ai" : "customer",
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

    // ===== Auto-pausa quando humano responde (igual ao legado) =====
    if (fromMe) {
      try {
        const { snoozeSession } = await import("@/lib/bot-status");
        if (session?.id) {
          const { getHumanPauseConfig } = await import("@/lib/bot-status");
          const pauseCfg = await getHumanPauseConfig().catch(() => ({ enabled: true, minutes: 30 }));
          if (pauseCfg.enabled && pauseCfg.minutes > 0) {
            await snoozeSession(session.id, pauseCfg.minutes, "human");
          }
        }
      } catch {}
    }

    // ===== Processamento de MÍDIA (em background — não bloqueia o HTTP 200) =====
    const msgId = inserted?.id;
    const base64Media = extractBase64Media(unwrapped);

    if (!fromMe && base64Media) {
      // Roda em background (fire-and-forget) — o cliente não espera.
      (async () => {
        try {
          let enrichedContent: string | null = null;
          let mediaUrl: string | null = null;

          // Upload da mídia.
          mediaUrl = await uploadMediaBase64(base64Media, remoteJid, sanitizeMimetype(mimetype || "", "application/octet-stream"));

          // Transcrição/descrição baseada no tipo.
          if (msgType === "audio") {
            const transcript = await transcribeAudio(base64Media, sanitizeMimetype(mimetype || "", "audio/ogg"), messageId);
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
      })();
    }

    // ===== Disparar agente IA (mensagens do cliente com texto) =====
    if (!fromMe && (text || msgType === "audio" || msgType === "image")) {
      try {
        const agentMod = await import("@/app/api/agent/process/route");
        const fakeReq = new NextRequest("http://internal/api/agent/process", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": process.env.INTERNAL_SECRET || "internal",
          },
          body: JSON.stringify({
            instanceName,
            remoteJid,
            text: text || (msgType === "audio" ? "[🎤 Áudio — transcrevendo...]" : mediaPlaceholder(msgType)),
            sessionId: session?.id,
          }),
        });
        // Fire-and-forget — não espera a IA responder pra devolver HTTP 200.
        agentMod.POST(fakeReq).catch((e: any) =>
          console.warn("[evo-go-webhook] agente falhou:", e?.message)
        );
      } catch (e: any) {
        console.warn("[evo-go-webhook] dispatch agente falhou:", e?.message);
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
