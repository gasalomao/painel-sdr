/**
 * POST /api/webhooks/evolution-go
 *
 * Webhook handler do Evolution GO (Go/whatsmeow).
 *
 * FORMATO DO PAYLOAD (diferente da Evolution API legada):
 * {
 *   "event": "MESSAGE|CONNECTION|QRCODE|...",
 *   "instance": "nome-da-instancia",
 *   "data": { ... }
 * }
 *
 * Esta rota faz o MESMO trabalho do webhook da Evolution API legada
 * (webhooks/whatsapp/route.ts), mas adaptando pro formato do GO:
 *   1. Parse do evento
 *   2. Anti-duplicação (message_id)
 *   3. Salvar em chats_dashboard + messages
 *   4. Upload de mídia
 *   5. Disparar agente IA
 *
 * O resto do sistema (IA, chat, organizador) NÃO sabe qual provedor
 * enviou — tudo é salvo nas mesmas tabelas.
 *
 * Público (não exige auth) — o Evolution GO envia sem cookie de sessão.
 * A segurança vem do facto de só o GO conhecer a URL.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ ok: false, error: "Body inválido" }, { status: 400 });

    const eventType = String(body.event || "").toUpperCase();
    const instanceName = String(body.instance || body.instanceName || "");
    const data = body.data || body;

    // Só processa mensagens recebidas (MESSAGE event com incoming).
    // Outros eventos (CONNECTION, QRCODE, etc) são ignorados aqui —
    // o painel não precisa reagir a eles via webhook.
    if (eventType !== "MESSAGE" && !body.message && !body.key) {
      return NextResponse.json({ ok: true, skipped: true, reason: `event ${eventType} não processado` });
    }

    // ===== Extrair dados da mensagem (formato Evolution GO / whatsmeow) =====
    const message = data.message || body.message || data;
    const key = data.key || message.key || body.key || {};

    // remoteJid (de quem enviou)
    const remoteJid = key.remoteJid || data.remoteJid || data.from || "";
    if (!remoteJid) return NextResponse.json({ ok: true, skipped: true, reason: "sem remoteJid" });

    // fromMe (nós enviamos ou eles?)
    const fromMe = key.fromMe ?? data.fromMe ?? false;

    // message_id (chave de anti-duplicação)
    const messageId = key.id || data.id || data.messageId || "";
    if (!messageId) return NextResponse.json({ ok: true, skipped: true, reason: "sem messageId" });

    // ===== Anti-duplicação =====
    const { data: existing } = await supabase
      .from("chats_dashboard")
      .select("id")
      .eq("message_id", messageId)
      .maybeSingle();
    if (existing) return NextResponse.json({ ok: true, skipped: true, reason: "duplicado" });

    // ===== Extrair texto/mídia =====
    let text = "";
    let mediaType: string | null = null;
    let mediaBase64: string | null = null;
    let mimetype: string | null = null;
    let fileName: string | null = null;

    // Texto (conversation ou extendedTextMessage)
    if (message.conversation) {
      text = message.conversation;
    } else if (message.extendedTextMessage?.text) {
      text = message.extendedTextMessage.text;
    } else if (data.text) {
      text = data.text;
    }

    // Áudio
    if (message.audioMessage || message.pttMessage) {
      mediaType = "audio";
      mimetype = (message.audioMessage || message.pttMessage)?.mimetype || "audio/ogg";
      mediaBase64 = (message.audioMessage || message.pttMessage)?.base64 || data.base64;
    }
    // Imagem
    else if (message.imageMessage) {
      mediaType = "image";
      mimetype = message.imageMessage.mimetype || "image/jpeg";
      mediaBase64 = message.imageMessage.base64 || data.base64;
      if (message.imageMessage.caption) text = message.imageMessage.caption;
    }
    // Vídeo
    else if (message.videoMessage) {
      mediaType = "video";
      mimetype = message.videoMessage.mimetype || "video/mp4";
      mediaBase64 = message.videoMessage.base64 || data.base64;
      if (message.videoMessage.caption) text = message.videoMessage.caption;
    }
    // Documento
    else if (message.documentMessage) {
      mediaType = "document";
      mimetype = message.documentMessage.mimetype || "application/octet-stream";
      mediaBase64 = message.documentMessage.base64 || data.base64;
      fileName = message.documentMessage.fileName || null;
    }

    // Se não tem base64 mas tem URL, baixa depois (o GO pode enviar URL em vez de base64)
    // Por ora, se não tem texto nem mídia, ignora.
    if (!text && !mediaType) {
      return NextResponse.json({ ok: true, skipped: true, reason: "sem conteúdo" });
    }

    // ===== Resolver client_id (multi-tenant) =====
    const ctx = await requireClientId(req).catch(() => null);
    const clientId = ctx?.ok ? ctx.clientId : null;

    // ===== Salvar mensagem =====
    // is_from_me é uma coluna GENERATED (computada de sender_type) — não
    // podemos inserir valor nela. Só enviamos sender_type.
    const insertData: Record<string, any> = {
      remote_jid: remoteJid,
      instance_name: instanceName,
      message_id: messageId,
      sender_type: fromMe ? "ai" : "customer",
      content: text || (mediaType === "audio" ? "[🎤 Áudio]" : mediaType === "image" ? "[📷 Imagem]" : "[Mídia]"),
      created_at: new Date().toISOString(),
    };
    if (mediaType) insertData.media_type = mediaType;
    if (mimetype) insertData.mimetype = mimetype;
    if (fileName) insertData.file_name = fileName;
    if (clientId) insertData.client_id = clientId;

    const { error: insertErr } = await supabase.from("chats_dashboard").insert(insertData);
    if (insertErr) {
      console.error("[evo-go-webhook] erro salvando:", insertErr.message);
      return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
    }

    // ===== Disparar agente IA (só mensagens do cliente, não nossas) =====
    if (!fromMe && text) {
      try {
        // Importa o processador do agente em processo (igual ao webhook legado).
        const agentMod = await import("@/app/api/agent/process/route");
        const fakeReq = new NextRequest("http://internal/api/agent/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instanceName, remoteJid, text, sessionId: undefined }),
        });
        agentMod.POST(fakeReq).catch((e: any) =>
          console.warn("[evo-go-webhook] agente falhou:", e?.message)
        );
      } catch (e: any) {
        console.warn("[evo-go-webhook] dispatch agente falhou:", e?.message);
      }
    }

    return NextResponse.json({ ok: true, saved: true });
  } catch (err: any) {
    console.error("[evo-go-webhook] erro:", err?.message);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}

/** Health check. */
export async function GET() {
  return NextResponse.json({ ok: true, provider: "evolution-go", timestamp: new Date().toISOString() });
}
