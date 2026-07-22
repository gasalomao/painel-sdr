/**
 * Helpers compartilhados entre o webhook da Evolution API (legado) e o
 * webhook do Evolution GO. Centraliza: extração de mídia, upload, transcrição,
 * descrição de imagem, criação de contato/sessão, etc.
 *
 * Assim, ambos os webhooks têm AS MESMAS funcionalidades — quem chama não
 * sabe qual provedor enviou. Tudo é salvo nas mesmas tabelas.
 *
 * Server-only.
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

// ============================================================================
// EXTRAÇÃO DE MENSAGEM (formato whatsmeow — igual nos dois provedores)
// ============================================================================

export function unwrapMessage(msg: Record<string, any> | null | undefined): Record<string, any> {
  if (!msg) return {};
  let cur = msg;
  for (let i = 0; i < 4; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message ||
      cur.editedMessage?.message ||
      cur.botInvokeMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

export function extractText(messageRaw: Record<string, any>): string {
  const m = unwrapMessage(messageRaw);
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.templateMessage?.hydratedTemplate?.hydratedContentText ||
    m?.buttonsMessage?.contentText ||
    m?.buttonsResponseMessage?.selectedButtonId ||
    m?.listResponseMessage?.title ||
    ""
  );
}

export function extractMessageType(messageRaw: Record<string, any>): string {
  const m = unwrapMessage(messageRaw);
  if (m.conversation || m.extendedTextMessage) return "text";
  if (m.imageMessage) return "image";
  if (m.audioMessage || m.pttMessage) return "audio";
  if (m.videoMessage) return "video";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  if (m.locationMessage) return "location";
  if (m.contactMessage) return "contact";
  if (m.listResponseMessage || m.buttonsResponseMessage || m.templateMessage || m.buttonsMessage) return "buttons";
  if (m.reactionMessage) return "reaction";
  return "unknown";
}

export function extractMimetype(messageRaw: Record<string, any>): string | null {
  const m = unwrapMessage(messageRaw);
  return (
    m?.imageMessage?.mimetype ||
    m?.audioMessage?.mimetype ||
    m?.pttMessage?.mimetype ||
    m?.videoMessage?.mimetype ||
    m?.documentMessage?.mimetype ||
    m?.stickerMessage?.mimetype ||
    null
  );
}

export function extractFileName(messageRaw: Record<string, any>): string | null {
  const m = unwrapMessage(messageRaw);
  return m?.documentMessage?.fileName || null;
}

export function extractFileSize(messageRaw: Record<string, any>): number | null {
  const m = unwrapMessage(messageRaw);
  const s = m?.imageMessage?.fileLength || m?.audioMessage?.fileLength || m?.videoMessage?.fileLength || m?.documentMessage?.fileLength;
  if (typeof s === "string") return parseInt(s, 10);
  if (typeof s === "number") return s;
  return null;
}

export function extractQuoted(messageRaw: Record<string, any>) {
  const m = unwrapMessage(messageRaw);
  const ctx = m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo;
  if (!ctx) return null;
  const q = ctx.quotedMessage;
  if (!q) return null;
  return {
    text: extractText(q) || "",
    participant: ctx.participant || "",
  };
}

export function extractBase64Media(messageRaw: Record<string, any>): string | null {
  const m = unwrapMessage(messageRaw);
  return (
    m?.imageMessage?.base64 ||
    m?.audioMessage?.base64 ||
    m?.pttMessage?.base64 ||
    m?.videoMessage?.base64 ||
    m?.documentMessage?.base64 ||
    m?.stickerMessage?.base64 ||
    null
  );
}

export function sanitizeMimetype(mt: string | null | undefined, fallback: string): string {
  if (!mt) return fallback;
  return mt.split(";")[0].trim() || fallback;
}

export function mediaPlaceholder(msgType: string): string {
  if (msgType === "image") return "📷 Imagem";
  if (msgType === "audio") return "[🎤 Áudio — transcrevendo...]";
  if (msgType === "video") return "🎥 Vídeo";
  if (msgType === "document") return "📄 Arquivo";
  if (msgType === "sticker") return "🎨 Figurinha";
  if (msgType === "location") return "📍 Localização";
  return "[Mídia]";
}

// ============================================================================
// UPLOAD DE MÍDIA (Supabase Storage)
// ============================================================================

let _bucketOk = false;
export async function ensureMediaBucket(): Promise<boolean> {
  if (_bucketOk) return true;
  try {
    const { data, error } = await supabase.storage.getBucket("whatsapp_media");
    if (error || !data) {
      const { error: createErr } = await supabase.storage.createBucket("whatsapp_media", { public: true });
      if (createErr) {
        console.warn("[Bucket] Falha ao criar:", createErr.message);
        return false;
      }
      console.log("[Bucket] Criando whatsapp_media (público)...");
    }
    _bucketOk = true;
    return true;
  } catch {
    return false;
  }
}

export async function uploadMediaBase64(base64: string, remoteJid: string, mimetype: string): Promise<string | null> {
  try {
    const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
    const buf = Buffer.from(cleanBase64, "base64");
    const ext = (mimetype || "").split("/")[1]?.split(";")[0] || "bin";
    const fileName = `${remoteJid.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.${ext}`;
    const ok = await ensureMediaBucket();
    if (!ok) return null;
    const { data, error } = await supabase.storage.from("whatsapp_media").upload(fileName, buf, {
      contentType: mimetype || "application/octet-stream",
      upsert: false,
    });
    if (error) {
      console.warn("[Media Upload] Falha:", error.message);
      return null;
    }
    const { data: pub } = supabase.storage.from("whatsapp_media").getPublicUrl(fileName);
    return pub?.publicUrl || null;
  } catch (err: any) {
    console.error("[Media Upload] Erro:", err);
    return null;
  }
}

// ============================================================================
// IA: TRANSCRIÇÃO + DESCRIÇÃO (lazy import pra não carregar se não precisar)
// ============================================================================

export async function transcribeAudio(base64: string, mimetype: string, debugMessageId?: string): Promise<string | null> {
  // Tenta whisper.cpp (grátis) primeiro, fallback Gemini.
  try {
    const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
    const t = await transcribeAudioWithWhisper(base64, mimetype);
    if (t) return t;
  } catch {}
  // Fallback: Gemini multimodal.
  try {
    const mod = await import("@/app/api/webhooks/whatsapp/route");
    // A função não é exportada — usamos a versão inline do módulo.
    // Pra evitar duplicação, fazemos uma chamada direta ao Gemini aqui.
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const cfgResult = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
    const apiKey = cfgResult.data?.api_key;
    if (!apiKey) return null;
    const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
    const tryMimes = Array.from(new Set([sanitizeMimetype(mimetype, "audio/ogg"), "audio/ogg", "audio/mpeg", "audio/wav"]));
    const { buildFallbackChain } = await import("@/lib/gemini-model-discovery");
    const chain = await buildFallbackChain();
    if (!chain.length) return null;
    const genAI = new GoogleGenerativeAI(apiKey);
    for (const modelName of chain) {
      const model = genAI.getGenerativeModel({ model: modelName });
      for (const tryMime of tryMimes) {
        try {
          const result = await model.generateContent([
            { inlineData: { data: cleanBase64, mimeType: tryMime } },
            { text: "Transcreva esse áudio em Português (BR). Devolva APENAS o texto transcrito." },
          ]);
          const text = result.response.text().trim();
          if (text) return text;
        } catch {}
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function describeImage(base64: string, mimetype: string): Promise<string | null> {
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const cfgResult = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
    const apiKey = cfgResult.data?.api_key;
    if (!apiKey) return null;
    const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
    const { buildFallbackChain } = await import("@/lib/gemini-model-discovery");
    const chain = await buildFallbackChain();
    const genAI = new GoogleGenerativeAI(apiKey);
    for (const modelName of chain) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([
          { inlineData: { data: cleanBase64, mimeType: sanitizeMimetype(mimetype, "image/jpeg") } },
          { text: "Descreva esta imagem em Português (BR) em 1-2 frases. Foque no que é relevante para atendimento comercial." },
        ]);
        const text = result.response.text().trim();
        if (text) return text;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

export async function describeDocument(base64: string, mimetype: string, fileName: string | null): Promise<string | null> {
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const cfgResult = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
    const apiKey = cfgResult.data?.api_key;
    if (!apiKey) return null;
    const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
    const { buildFallbackChain } = await import("@/lib/gemini-model-discovery");
    const chain = await buildFallbackChain();
    const genAI = new GoogleGenerativeAI(apiKey);
    for (const modelName of chain) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([
          { inlineData: { data: cleanBase64, mimeType: sanitizeMimetype(mimetype, "application/pdf") } },
          { text: `Extraia o conteúdo principal deste documento (${fileName || "sem nome"}). Resuma em Português (BR) em 2-3 frases.` },
        ]);
        const text = result.response.text().trim();
        if (text) return text;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// CONTATO + SESSÃO (criação/resolução)
// ============================================================================

export async function findOrCreateContact(remoteJid: string, pushName: string | undefined, clientId: string) {
  try {
    const { data: existing } = await supabase
      .from("contacts")
      .select("id, push_name, phone_number")
      .eq("remote_jid", remoteJid)
      .maybeSingle();

    if (existing) {
      // Atualiza pushName se mudou.
      if (pushName && pushName !== existing.push_name) {
        await supabase.from("contacts").update({ push_name: pushName }).eq("id", existing.id);
      }
      return existing;
    }

    const phone = remoteJid.replace(/@.*$/, "");
    const { data: created, error } = await supabase
      .from("contacts")
      .insert({
        remote_jid: remoteJid,
        phone_number: phone,
        push_name: pushName || null,
        client_id: clientId,
      })
      .select("id, push_name, phone_number")
      .single();

    if (error) throw error;
    return created;
  } catch (err: any) {
    console.error("[contact] findOrCreate:", err.message);
    return null;
  }
}

export async function findOrCreateSession(contactId: string, instanceName: string, remoteJid: string, clientId: string) {
  try {
    const { data: existing } = await supabase
      .from("sessions")
      .select("id, bot_status")
      .eq("contact_id", contactId)
      .eq("instance_name", instanceName)
      .maybeSingle();

    if (existing) return existing;

    const { data: created, error } = await supabase
      .from("sessions")
      .insert({
        contact_id: contactId,
        instance_name: instanceName,
        client_id: clientId,
        bot_status: "bot_active",
        remote_jid: remoteJid,
      })
      .select("id, bot_status")
      .single();

    if (error) throw error;
    return created;
  } catch (err: any) {
    console.error("[session] findOrCreate:", err.message);
    return null;
  }
}

export async function healLeadNameFromPushName(remoteJid: string, pushName: string | undefined, clientId: string) {
  if (!pushName) return;
  try {
    await supabase
      .from("leads_extraidos")
      .update({ nome_negocio: pushName })
      .eq("remote_jid", remoteJid)
      .eq("client_id", clientId)
      .is("nome_negocio", null);
  } catch {}
}

export { requireClientId };
