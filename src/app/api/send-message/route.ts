import { NextRequest, NextResponse } from "next/server";
import { evolution, getEvolutionConfig } from "@/lib/evolution";
import * as channel from "@/lib/channel";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { registerManualSend } from "@/lib/manual-send-registry";

// Mesmo bucket público usado pelo webhook de entrada (ver webhooks/whatsapp/route.ts).
// Mantemos o upload para não inflar o DB com data URIs gigantes de áudio/imagem.
const MEDIA_BUCKET = "whatsapp_media";
let bucketReady: boolean | null = null;

async function ensureMediaBucket(): Promise<boolean> {
  if (bucketReady) return true;
  try {
    const { data: list } = await supabase.storage.listBuckets();
    if (list?.some((b: any) => b.name === MEDIA_BUCKET)) {
      bucketReady = true;
      return true;
    }
    const { error: createErr } = await supabase.storage.createBucket(MEDIA_BUCKET, {
      public: true,
      fileSizeLimit: 50 * 1024 * 1024,
    });
    if (createErr && !/already exists/i.test(createErr.message)) return false;
    bucketReady = true;
    return true;
  } catch {
    return false;
  }
}

async function uploadOutgoingMedia(
  base64: string,
  remoteJid: string,
  mimetype: string,
  fileName?: string
): Promise<string | null> {
  try {
    if (!(await ensureMediaBucket())) return null;
    const clean = base64.replace(/^data:.*?;base64,/, "");
    const buffer = Buffer.from(clean, "base64");
    const ext = fileName?.split(".").pop() || mimetype?.split("/")[1]?.split(";")[0] || "bin";
    const path = `${remoteJid}/out-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(path, buffer, { contentType: mimetype || "application/octet-stream", upsert: true });
    if (error) {
      console.warn("[SEND-MESSAGE] upload falhou:", error.message);
      return null;
    }
    return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
  } catch (err: any) {
    console.warn("[SEND-MESSAGE] upload erro:", err?.message);
    return null;
  }
}

function inferMimeForType(type: string, explicit?: string): string {
  if (explicit) return explicit;
  if (type === "image") return "image/jpeg";
  if (type === "audio") return "audio/ogg; codecs=opus";
  if (type === "document") return "application/pdf";
  return "application/octet-stream";
}

/**
 * Envio manual pelo painel.
 * Não mexe na pausa da IA — quem controla isso é o front (auto-pause-on-typing)
 * ou os botões explícitos de Pausar/Snooze.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const defaultInstance = (await getEvolutionConfig()).instance || "sdr";
    const { remoteJid, text, media, instanceName = defaultInstance } = body;

    if (!remoteJid) {
      return NextResponse.json({ error: "remoteJid é obrigatório" }, { status: 400 });
    }
    if (!text && !media) {
      return NextResponse.json({ error: "Obrigatório enviar text ou media" }, { status: 400 });
    }

    console.log(`[SEND-MESSAGE] Enviando para ${remoteJid} via ${instanceName}`);

    // === 1. Enviar via Evolution API DIRETO ===
    // Se falhar, NÃO aborta — salva a mensagem com status 'error' pra não sumir da UI.
    let evoData: any = null;
    let sendError: string | null = null;
    try {
      if (media && media.base64) {
        evoData = await channel.sendMedia(remoteJid, text || "", {
          type: media.type,
          base64: media.base64,
          fileName: media.fileName,
          mimetype: media.mimetype,
        }, instanceName);
      } else {
        evoData = await channel.sendMessage(remoteJid, text, instanceName);
      }
    } catch (evoErr: any) {
      sendError = evoErr.message;
      console.error("[SEND-MESSAGE] Erro Evolution API:", sendError);
    }

    const msgId = evoData?.key?.id || evoData?.data?.key?.id || `manual-${Date.now()}`;
    if (!sendError) console.log(`[SEND-MESSAGE] Enviado com sucesso. MsgID: ${msgId}`);

    // === 1.5. Upload da mídia enviada para o bucket, pra que o próprio painel
    // consiga renderizar a mídia ao recarregar (sem isso a linha vira
    // "[mensagem sem conteúdo]"). ===
    let outMediaUrl: string | null = null;
    let outMimetype: string | null = null;
    let outMediaType: string | null = null;
    if (media && media.base64) {
      outMimetype = inferMimeForType(media.type, media.mimetype);
      outMediaType = media.type === "document" ? "document" : media.type;
      outMediaUrl = await uploadOutgoingMedia(media.base64, remoteJid, outMimetype, media.fileName);
    }

    // Registra IMEDIATAMENTE que esta msg foi enviada manualmente.
    // Se o webhook do Evolution chegar depois (com fromMe=true), ele consulta
    // esse registro e rotula como 'human' em vez de 'ai'.
    if (!sendError) registerManualSend(msgId);

    // === 2. Find or Create Contact & Session — persiste SEMPRE, mesmo se falhou. ===
    let contactId: string | null = null;
    let sessionId: string | null = null;

    try {
      const { data: contact } = await supabase.from("contacts").select("id").eq("remote_jid", remoteJid).maybeSingle();
      if (contact) {
        contactId = contact.id;
      } else {
        const { data: nc } = await supabase.from("contacts").insert({
          remote_jid: remoteJid,
          phone_number: evolution.extractPhone(remoteJid),
        }).select("id").single();
        contactId = nc?.id || null;
      }

      if (contactId) {
        const { data: session } = await supabase.from("sessions").select("id").eq("contact_id", contactId).eq("instance_name", instanceName).maybeSingle();
        if (session) {
          sessionId = session.id;
        } else {
          const { data: ns } = await supabase.from("sessions").insert({
            contact_id: contactId,
            instance_name: instanceName,
            bot_status: 'bot_active',
          }).select("id").single();
          sessionId = ns?.id || null;
        }
      }
    } catch (persistErr: any) {
      console.warn("[SEND-MESSAGE] Falha ao resolver contact/session:", persistErr?.message);
    }

    // === 3. Salvar no banco — sucesso ou falha, a msg entra no histórico ===
    const now = new Date().toISOString();
    const finalStatus = sendError ? "error" : "sent";

    // V2 messages — tenta insert; se webhook venceu a corrida, força UPDATE pra 'human'
    if (sessionId) {
      const messagesPayload: Record<string, any> = {
        session_id: sessionId,
        message_id: msgId,
        sender: 'human',
        content: text || "",
        media_category: media?.type || 'text',
        delivery_status: finalStatus,
        created_at: now,
      };
      if (outMediaUrl) messagesPayload.media_url = outMediaUrl;
      if (outMimetype) messagesPayload.mimetype = outMimetype;
      const { error: insertErr } = await supabase.from("messages").insert(messagesPayload);
      if (insertErr?.code === "23505") {
        // Duplicata — webhook já inseriu (provavelmente como 'ai'). Força pra human.
        await supabase.from("messages").update({
          sender: 'human',
          delivery_status: finalStatus,
        }).eq("message_id", msgId);
      } else if (insertErr) {
        console.warn("[SEND-MESSAGE] messages insert:", insertErr.message);
      }
    }

    // Legado chats_dashboard — mesmo tratamento
    const dashPayload: Record<string, any> = {
      remote_jid: remoteJid,
      instance_name: instanceName,
      message_id: msgId,
      sender_type: 'human',
      content: text || "",
      status_envio: finalStatus,
      created_at: now,
    };
    if (outMediaUrl) dashPayload.media_url = outMediaUrl;
    if (outMediaType) dashPayload.media_type = outMediaType;
    if (outMimetype) dashPayload.mimetype = outMimetype;

    let { error: dashErr } = await supabase.from("chats_dashboard").insert(dashPayload);

    // Se a tabela não tem as colunas extras de mídia, cai pra payload mínimo
    if (dashErr?.code === "PGRST204") {
      const minimal = {
        remote_jid: remoteJid,
        instance_name: instanceName,
        message_id: msgId,
        sender_type: 'human',
        content: text || "",
        status_envio: finalStatus,
        created_at: now,
      };
      const retry = await supabase.from("chats_dashboard").insert(minimal);
      dashErr = retry.error as any;
      if (!dashErr && outMediaUrl) {
        console.warn("[SEND-MESSAGE] chats_dashboard sem colunas de mídia. Rode criar_chats_dashboard_extras.sql.");
      }
    }

    if (dashErr?.code === "23505") {
      const upd: Record<string, any> = { sender_type: 'human', status_envio: finalStatus };
      if (outMediaUrl) upd.media_url = outMediaUrl;
      if (outMediaType) upd.media_type = outMediaType;
      if (outMimetype) upd.mimetype = outMimetype;
      await supabase.from("chats_dashboard").update(upd).eq("message_id", msgId);
    } else if (dashErr) {
      console.warn("[SEND-MESSAGE] chats_dashboard insert:", dashErr.message);
    }

    // === 4. Resposta ===
    if (sendError) {
      return NextResponse.json(
        { success: false, error: sendError, persisted: true, msgId },
        { status: 502 }
      );
    }
    return NextResponse.json({ success: true, msgId, sent: true });

  } catch (err: any) {
    console.error("[SEND-MESSAGE] Erro:", err.message);
    return NextResponse.json({ success: false, error: err.message || "Erro interno" }, { status: 500 });
  }
}
