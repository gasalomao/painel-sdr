import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { evolution, getEvolutionConfig } from "@/lib/evolution";
import { getEffectiveStatus } from "@/lib/bot-status";
import { isManualSend } from "@/lib/manual-send-registry";

export const dynamic = 'force-dynamic';

// Para chamadas internas (server-to-server), sempre usar localhost
const INTERNAL_BASE = `http://localhost:${process.env.PORT || 3000}`;

// ============================================================
// HELPERS DE PARSING
// ============================================================

const STATUS_MAP: Record<number | string, string> = {
  0: "error", 1: "delivered", 2: "read", 3: "played",
  "ERROR": "error", "DELIVERED": "delivered", "READ": "read", "PLAYED": "played",
};

/**
 * Desempacota wrappers que a Evolution v2 / WhatsApp Business usam pra envolver
 * a mensagem real. Sem isso, mensagens efêmeras / visualizar-uma-vez / encaminhadas
 * caíam em extractText="" → UI mostrava "[Sem conteúdo]".
 *
 * Ordem dos wrappers (alguns podem aninhar):
 *   - ephemeralMessage.message → wraps mensagem com timer (disappearing chats)
 *   - viewOnceMessage.message  → "ver uma vez"
 *   - viewOnceMessageV2.message
 *   - viewOnceMessageV2Extension.message
 *   - documentWithCaptionMessage.message → documento + caption no envelope externo
 *   - editedMessage.message  → mensagem editada
 *   - botInvokeMessage.message
 */
function unwrapMessage(msg: Record<string, any> | null | undefined): Record<string, any> {
  if (!msg) return {};
  let cur = msg;
  // No máximo 4 níveis de wrapper — defesa contra loop em payload malformado.
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

function extractText(messageRaw: Record<string, any>): string {
  const message = unwrapMessage(messageRaw);
  if (!message) return "";
  // Texto direto / com formatação / como caption de mídia.
  const direct =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.ptvMessage?.caption;
  if (direct) return direct;

  // Tipos sem texto natural — devolve descrição usável (e a UI fica clara em
  // vez de "[Sem conteúdo]"). A pipeline de mídia depois substitui pelos
  // resultados de transcrição/descrição quando aplicável.
  if (message.locationMessage || message.liveLocationMessage) {
    const loc = message.locationMessage || message.liveLocationMessage;
    const name = loc.name || loc.address || "";
    return `📍 Localização${name ? ": " + name : ""}`;
  }
  if (message.contactMessage) {
    return `👤 Contato: ${message.contactMessage.displayName || "(sem nome)"}`;
  }
  if (message.contactsArrayMessage) {
    const arr = message.contactsArrayMessage.contacts || [];
    return `👤 ${arr.length} contato(s)`;
  }
  if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
    const poll = message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3;
    return `📊 Enquete: ${poll.name || "(sem título)"}`;
  }
  if (message.pollUpdateMessage) return `📊 Voto em enquete`;
  if (message.reactionMessage) {
    return `↩ Reagiu: ${message.reactionMessage.text || "(emoji)"}`;
  }
  if (message.buttonsResponseMessage) {
    return message.buttonsResponseMessage.selectedDisplayText
      || message.buttonsResponseMessage.selectedButtonId
      || "(botão)";
  }
  if (message.listResponseMessage) {
    return message.listResponseMessage.title
      || message.listResponseMessage.singleSelectReply?.selectedRowId
      || "(item de lista)";
  }
  if (message.templateButtonReplyMessage) {
    return message.templateButtonReplyMessage.selectedDisplayText
      || message.templateButtonReplyMessage.selectedId
      || "(resposta)";
  }
  if (message.protocolMessage) return ""; // controle interno (read receipts, etc) — não mostrar
  return "";
}

function extractMessageType(messageRaw: Record<string, any>): string {
  const message = unwrapMessage(messageRaw);
  if (!message) return "unknown";
  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.ptvMessage) return "video"; // push-to-talk video (vídeo redondo)
  if (message.audioMessage) return "audio";
  if (message.pttMessage) return "audio"; // push-to-talk audio (áudio antigo do WhatsApp)
  if (message.documentMessage) return "document";
  if (message.stickerMessage) return "sticker";
  if (message.reactionMessage) return "reaction";
  if (message.contactMessage || message.contactsArrayMessage) return "contact";
  if (message.locationMessage || message.liveLocationMessage) return "location";
  if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3 || message.pollUpdateMessage) return "poll";
  return "text";
}

function extractMimetype(messageRaw: Record<string, any>): string | null {
  const message = unwrapMessage(messageRaw);
  return message?.imageMessage?.mimetype
    || message?.videoMessage?.mimetype
    || message?.ptvMessage?.mimetype
    || message?.audioMessage?.mimetype
    || message?.pttMessage?.mimetype
    || message?.documentMessage?.mimetype
    || message?.stickerMessage?.mimetype
    || null;
}

function extractFileName(messageRaw: Record<string, any>): string | null {
  const message = unwrapMessage(messageRaw);
  return message?.documentMessage?.fileName
    || message?.imageMessage?.fileName
    || null;
}

function extractFileSize(messageRaw: Record<string, any>): number | null {
  const message = unwrapMessage(messageRaw);
  const size = message?.imageMessage?.fileLength
    || message?.videoMessage?.fileLength
    || message?.ptvMessage?.fileLength
    || message?.audioMessage?.fileLength
    || message?.pttMessage?.fileLength
    || message?.documentMessage?.fileLength
    || message?.stickerMessage?.fileLength;
  return size ? Number(size) : null;
}

function extractQuoted(messageRaw: Record<string, any>) {
  const message = unwrapMessage(messageRaw);
  const contextInfo = message?.extendedTextMessage?.contextInfo
    || message?.imageMessage?.contextInfo
    || message?.videoMessage?.contextInfo
    || message?.ptvMessage?.contextInfo
    || message?.audioMessage?.contextInfo
    || message?.pttMessage?.contextInfo
    || message?.documentMessage?.contextInfo
    || message?.stickerMessage?.contextInfo;
  if (!contextInfo) return { quotedId: null, quotedText: null };
  const qMsgRaw = contextInfo.quotedMessage;
  const qMsg = unwrapMessage(qMsgRaw);
  const quotedText = qMsg?.conversation
    || qMsg?.extendedTextMessage?.text
    || qMsg?.imageMessage?.caption
    || qMsg?.videoMessage?.caption
    || (qMsg?.imageMessage ? "📷 Imagem" : null)
    || (qMsg?.videoMessage ? "🎥 Vídeo" : null)
    || (qMsg?.ptvMessage ? "🎥 Vídeo" : null)
    || (qMsg?.audioMessage ? "🎤 Áudio" : null)
    || (qMsg?.pttMessage ? "🎤 Áudio" : null)
    || (qMsg?.documentMessage ? "📄 Documento" : null)
    || (qMsg?.stickerMessage ? "Sticker" : null)
    || (qMsg?.locationMessage ? "📍 Localização" : null)
    || (qMsg?.contactMessage ? "👤 Contato" : null);
  return { quotedId: contextInfo.stanzaId || null, quotedText };
}

// ============================================================
// UPLOAD DE MÍDIA PARA SUPABASE STORAGE
// ============================================================

// Cacheia se o bucket foi verificado/criado, pra não bater em Storage toda vez
let bucketReady: boolean | null = null;

async function ensureMediaBucket(): Promise<boolean> {
  if (bucketReady === true) return true;
  const bucketName = "whatsapp_media";
  try {
    // Tenta listar pra descobrir se existe — se não, cria público
    const { data: list, error: listErr } = await supabase.storage.listBuckets();
    if (listErr) {
      console.warn("[Bucket] Não consegui listar buckets:", listErr.message);
      return false;
    }
    if (list?.some((b: any) => b.name === bucketName)) {
      bucketReady = true;
      return true;
    }
    console.log("[Bucket] Criando whatsapp_media (público)...");
    const { error: createErr } = await supabase.storage.createBucket(bucketName, {
      public: true,
      fileSizeLimit: 50 * 1024 * 1024, // 50 MB por arquivo
    });
    if (createErr) {
      // Pode ter sido criado em paralelo — ignora "already exists"
      if (/already exists/i.test(createErr.message)) {
        bucketReady = true;
        return true;
      }
      console.warn("[Bucket] Falha ao criar:", createErr.message, "— cria manual em Supabase Storage > New bucket 'whatsapp_media' (public).");
      return false;
    }
    bucketReady = true;
    return true;
  } catch (err: any) {
    console.error("[Bucket] Erro:", err?.message);
    return false;
  }
}

async function uploadMediaBase64(base64: string, remoteJid: string, mimetype: string): Promise<string | null> {
  try {
    const bucketName = "whatsapp_media";
    await ensureMediaBucket();

    const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
    const buffer = Buffer.from(cleanBase64, "base64");
    const extension = mimetype?.split("/")[1]?.split(";")[0] || "bin";
    const path = `${remoteJid}/${Date.now()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(path, buffer, { contentType: mimetype || "application/octet-stream", upsert: true });

    if (uploadError) {
      console.warn("[Media Upload] Falha:", uploadError.message, "— confere se o bucket 'whatsapp_media' existe e é public.");
      return null;
    }
    const { data } = supabase.storage.from(bucketName).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error("[Media Upload] Erro:", err);
    return null;
  }
}

// Gemini aceita mimetype base (sem "; codecs=..."). WhatsApp manda "audio/ogg; codecs=opus"
// que causa erro silencioso na chamada.
function sanitizeMimetype(mt: string | null | undefined, fallback: string): string {
  if (!mt) return fallback;
  return mt.split(";")[0].trim() || fallback;
}

/**
 * Transcreve áudio usando Gemini (multimodal). API Key central em ai_organizer_config.
 * Suporta ogg/opus (formato padrão de áudio do WhatsApp), mp3, wav, etc.
 * Retorna null em caso de falha — o pipeline continua sem transcrição.
 */
/**
 * Modelos Gemini tentados em ordem. Os modelos atuais suportam áudio nativamente
 * via inlineData. 2.5-flash é o flagship rápido atual (multimodal).
 * 1.5-flash fica como fallback porque muita API key antiga não tem acesso ao 2.5.
 */
const GEMINI_MODEL_CHAIN = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

async function transcribeAudioWithGemini(base64: string, mimetype: string, debugMessageId?: string): Promise<string | null> {
  const cfgResult = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
  const apiKey = cfgResult.data?.api_key;

  const logFail = async (reason: string, extra: any = {}) => {
    console.error(`[Transcription] ❌ ${reason}`, extra);
    try {
      await supabase.from("webhook_logs").insert({
        instance_name: "transcription",
        event: "TRANSCRIPTION_FAIL",
        payload: { reason, message_id: debugMessageId, ...extra },
        created_at: new Date().toISOString(),
      });
    } catch { /* ignore */ }
  };

  if (!apiKey) {
    await logFail("Sem API Key do Gemini em /configuracoes (ai_organizer_config.api_key vazio).");
    return null;
  }

  const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
  const sizeBytes = Math.ceil(cleanBase64.length * 0.75);
  if (sizeBytes > 20 * 1024 * 1024) {
    await logFail("Áudio maior que 20 MB — Gemini inline não suporta.", { sizeBytes });
    return null;
  }

  // Gemini aceita: audio/wav, mp3, aiff, aac, ogg, flac.
  // WhatsApp manda "audio/ogg; codecs=opus" — sanitiza pra "audio/ogg" e tem fallback.
  const tryMimes = Array.from(new Set([
    sanitizeMimetype(mimetype, "audio/ogg"),
    "audio/ogg",
    "audio/mpeg",
    "audio/wav",
  ]));

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);

  // Matriz: modelo × mimetype. Para cada modelo, tenta cada mimetype.
  let lastErr: any = null;
  const attempts: any[] = [];
  for (const modelName of GEMINI_MODEL_CHAIN) {
    const model = genAI.getGenerativeModel({ model: modelName });
    for (const tryMime of tryMimes) {
      try {
        console.log(`[Transcription] model=${modelName} mime=${tryMime} size=${sizeBytes}B msgId=${debugMessageId}`);
        const result = await model.generateContent([
          { inlineData: { data: cleanBase64, mimeType: tryMime } },
          { text: "Transcreva esse áudio em Português (BR). Devolva APENAS o texto transcrito, sem aspas, sem prefixo, sem explicação. Se não entender, devolva '[áudio inaudível]'." },
        ]);
        const text = result.response.text().trim().replace(/^["']+|["']+$/g, "");
        if (text) {
          console.log(`[Transcription] ✓ OK com ${modelName}/${tryMime}: ${text.slice(0, 80)}`);
          // Token tracking
          {
            const { logTokenUsage, extractGeminiUsage } = await import("@/lib/token-usage");
            const u = extractGeminiUsage(result);
            await logTokenUsage({
              source: "other",
              sourceLabel: "Transcrição de áudio",
              model: modelName,
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
              metadata: { kind: "audio_transcription", mime: tryMime, msgId: debugMessageId },
            });
          }
          return text;
        }
        attempts.push({ model: modelName, mime: tryMime, result: "vazio" });
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e).slice(0, 400);
        attempts.push({ model: modelName, mime: tryMime, error: msg });
        console.warn(`[Transcription] falha ${modelName}/${tryMime}: ${msg}`);

        // API key errada → aborta tudo, não adianta tentar outros modelos
        if (/API key|invalid.*key|unauthorized|401|403.*api/i.test(msg) && !/model/i.test(msg)) {
          await logFail(`API Key inválida ou sem permissão: ${msg}`, { attempts });
          return null;
        }
        // Modelo não existe pra essa key → tenta próximo modelo (quebra o loop de mime)
        if (/not found|404|does not exist|not supported|model/i.test(msg)) {
          break;
        }
      }
    }
  }

  await logFail("Nenhuma combinação modelo/mimetype funcionou.", { attempts, lastError: String(lastErr?.message || lastErr || "").slice(0, 400) });
  return null;
}

/**
 * Gera descrição curta de uma imagem com Gemini. Usado pra:
 *   1) Preencher o content da msg (em vez de "[sem conteúdo]")
 *   2) Dar contexto visual pro agente IA no próximo turno
 */
async function describeImageWithGemini(base64: string, mimetype: string): Promise<string | null> {
  const { data: cfg } = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
  const apiKey = cfg?.api_key;
  if (!apiKey) return null;

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
  const effMime = sanitizeMimetype(mimetype, "image/jpeg");

  for (const modelName of GEMINI_MODEL_CHAIN) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        { inlineData: { data: cleanBase64, mimeType: effMime } },
        { text: "Descreva brevemente (1-2 frases, PT-BR) o que aparece nesta imagem. Se for um documento/print com texto, extraia o texto principal. Sem prefixo nem explicação." },
      ]);
      const text = result.response.text().trim();
      if (text) {
        // Token tracking
        const { logTokenUsage, extractGeminiUsage } = await import("@/lib/token-usage");
        const u = extractGeminiUsage(result);
        await logTokenUsage({
          source: "other",
          sourceLabel: "Descrição de imagem",
          model: modelName,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          totalTokens: u.totalTokens,
          metadata: { kind: "image_description", mime: effMime },
        });
        return text;
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      console.warn(`[ImageDescribe] falha ${modelName}: ${msg.slice(0, 200)}`);
      // Se for erro de modelo, tenta o próximo; se for API key, aborta
      if (/API key|invalid.*key|unauthorized|401|403.*api/i.test(msg) && !/model/i.test(msg)) return null;
    }
  }
  return null;
}

// Placeholder textual pra mídias (aparece no chat antes do upload/transcrição terminarem)
function mediaPlaceholder(msgType: string): string {
  switch (msgType) {
    case "image":    return "[📷 Imagem]";
    case "audio":    return "[🎤 Áudio — transcrevendo...]";
    case "video":    return "[🎥 Vídeo]";
    case "document": return "[📄 Documento]";
    case "sticker":  return "[Sticker]";
    case "location": return "[📍 Localização]";
    case "contact":  return "[👤 Contato]";
    case "poll":     return "[📊 Enquete]";
    case "reaction": return "[↩ Reação]";
    default:         return "[Mídia]";
  }
}

// ============================================================
// FIND OR CREATE: Contact + Session
// ============================================================

async function findOrCreateContact(remoteJid: string, pushName?: string) {
  // Tenta encontrar contato existente
  const { data: existing } = await supabase
    .from("contacts")
    .select("id, push_name")
    .eq("remote_jid", remoteJid)
    .single();

  if (existing) {
    // Atualizar push_name se mudou
    if (pushName && pushName !== existing.push_name) {
      await supabase.from("contacts").update({ push_name: pushName }).eq("id", existing.id);
    }
    return existing.id;
  }

  // Criar novo contato
  const phoneNumber = evolution.extractPhone(remoteJid);
  const { data: newContact, error } = await supabase.from("contacts").insert({
    remote_jid: remoteJid,
    push_name: pushName || null,
    phone_number: phoneNumber,
  }).select("id").single();

  if (error) {
    // Race condition: outro webhook pode ter criado entre o select e o insert
    if (error.code === "23505") {
      const { data: retry } = await supabase.from("contacts").select("id").eq("remote_jid", remoteJid).single();
      return retry?.id;
    }
    throw error;
  }
  return newContact.id;
}

async function findOrCreateSession(contactId: string, instanceName: string, remoteJid: string) {
  const { data: existing } = await supabase
    .from("sessions")
    .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id")
    .eq("contact_id", contactId)
    .eq("instance_name", instanceName)
    .single();

  if (existing) {
    // Auto-resume se snooze venceu (faz update no DB internamente)
    const eff = await getEffectiveStatus(existing as any);
    return { ...existing, bot_status: eff.status, resume_at: eff.resumeAt, _effective_active: eff.isActive };
  }

  // Buscar agent_id da instância
  const { data: channel } = await supabase
    .from("channel_connections")
    .select("agent_id")
    .eq("instance_name", instanceName)
    .single();

  const { data: newSession, error } = await supabase.from("sessions").insert({
    contact_id: contactId,
    instance_name: instanceName,
    agent_id: channel?.agent_id || 1,
    bot_status: 'bot_active',
  }).select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id").single();

  if (error) {
    if (error.code === "23505") {
      const { data: retry } = await supabase
        .from("sessions").select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id")
        .eq("contact_id", contactId).eq("instance_name", instanceName).single();
      return retry;
    }
    throw error;
  }
  return newSession;
}

// ============================================================
// MAIN WEBHOOK HANDLER
// ============================================================

export async function POST(req: NextRequest) {
  console.log("\n>>> 🔌 WEBHOOK RECEBIDO:", new Date().toISOString());

  try {
    const body = await req.json();
    const eventName = body.event || body.type || "unknown";
    // Aceita QUALQUER nome de instância vindo do payload da Evolution.
    // Fallback final = instância configurada (DB ou env), nunca um literal.
    const instanceName = body.instance || body.instance_name || (await getEvolutionConfig()).instance || "sdr";
    const overrideAgentId = req.nextUrl.searchParams.get("agentId");

    console.log(">>> [Evolution API v2] Evento:", eventName, "| Instância:", instanceName);

    // Log tudo para debug
    await supabase.from("webhook_logs").insert({
      instance_name: instanceName,
      event: eventName,
      payload: { level: "raw", event: eventName, instance: instanceName, raw: body },
      created_at: new Date().toISOString()
    }).then(({ error }) => error && console.error("❌ Log error:", error.message));

    // ============================================================
    // EVENTO: messages.upsert
    // ============================================================
    if (eventName === "messages.upsert" || eventName === "MESSAGES_UPSERT") {
      const data = body.data || body;
      const message = data.message || {};
      const finalId = data.key?.id || body.key?.id;
      const remoteJid = data.key?.remoteJid || body.key?.remoteJid;
      const fromMe = data.key?.fromMe ?? body.key?.fromMe ?? false;
      const pushName = data.pushName || body.pushName;
      const text = extractText(message);
      const msgType = extractMessageType(message);
      const mimetype = extractMimetype(message);
      const fileName = extractFileName(message);
      const fileSize = extractFileSize(message);
      const { quotedId, quotedText } = extractQuoted(message);

      console.log(">>> MESSAGE PARSED ->", { id: finalId, jid: remoteJid?.slice(0, 15), text: text.slice(0, 40), fromMe, type: msgType });

      if (!finalId || !remoteJid) {
        console.warn(">>> [Webhook] Ignorando evento sem finalId ou remoteJid");
        return NextResponse.json({ success: false, error: "Missing message_id or remote_jid" });
      }

      console.log(`>>> [Webhook] Processando mensagem id: ${finalId} de: ${remoteJid}`);

      // Ignorar mensagens de status broadcast
      if (remoteJid === "status@broadcast") {
        return NextResponse.json({ success: true, ignored: true, reason: "status_broadcast" });
      }

      // === Find or Create Contact & Session ===
      // Se falhar, NÃO aborta mais — a msg ainda vai pra chats_dashboard (que é o que
      // a UI /chat lê). A tabela V2 messages depende de session, mas é secundária.
      let contactId: string | null = null;
      let session: any = null;
      try {
        contactId = await findOrCreateContact(remoteJid, pushName);
        if (contactId) {
          session = await findOrCreateSession(contactId, instanceName, remoteJid);
        }
      } catch (sessErr: any) {
        console.error(">>> [Webhook] ⚠ Falha ao criar contact/session (não-fatal):", sessErr?.message);
        await supabase.from("webhook_logs").insert({
          instance_name: instanceName,
          event: "WEBHOOK_SESSION_FAIL",
          payload: { remote_jid: remoteJid, error: sessErr?.message, fromMe },
          created_at: new Date().toISOString(),
        }).then(() => {}, () => {});
      }

      // Determinar sender
      let sender: 'customer' | 'ai' | 'human' | 'system' = 'customer';
      if (fromMe) {
        // Prioridade: se essa msg foi enviada manualmente pelo painel nos últimos 2min,
        // rotula como 'human' mesmo que o bot esteja ativo. Caso contrário, usa o status
        // do bot pra decidir entre 'ai' (IA respondeu) ou 'human' (outro dispositivo).
        if (isManualSend(finalId)) {
          sender = 'human';
          console.log(">>> [Webhook] fromMe=true reconhecido como envio MANUAL do painel:", finalId);
        } else {
          sender = (session?.bot_status === 'bot_active') ? 'ai' : 'human';
        }
      }

      // === ANTI-DUPLICAÇÃO REFORÇADA ===
      // Verifica em AMBAS tabelas (messages + chats_dashboard)
      const [{ data: existingV2 }, { data: existingLegacy }] = await Promise.all([
        supabase.from("messages").select("id").eq("message_id", finalId).single(),
        supabase.from("chats_dashboard").select("id").eq("message_id", finalId).single(),
      ]);

      if (existingV2 || existingLegacy) {
        console.log(">>> [Webhook] MESSAGE JÁ EXISTE (duplicata ignorada):", finalId);
        return NextResponse.json({ success: true, message: "Já processada (duplicata)" });
      }

      console.log(`>>> [Webhook] Inserindo nova mensagem no banco: ${finalId}`);

      // === Upload de mídia (Evolution v2) ===
      // Caminhos possíveis onde o base64 pode vir:
      //   - data.base64 (raiz, quando webhookBase64=true na Evolution)
      //   - message.base64 (às vezes em webhooks customizados)
      //   - message.{image|audio|video|document|sticker}Message.base64 (v2 padrão)
      // Fallback: se NÃO veio inline, a Evolution tem endpoint pra buscar depois pelo id:
      //   POST /chat/getBase64FromMediaMessage/{instance}
      // O uploadMediaBase64 faz upload pro Storage "whatsapp_media" e devolve a URL pública.
      let mediaUrl: string | null = null;
      // Usa a mensagem desempacotada — ephemeral/viewOnce escondiam a mídia
      // dentro de message.{ephemeralMessage|viewOnceMessage}.message.{tipo}Message.
      const unwrapped = unwrapMessage(message);
      const mediaMsg =
        unwrapped.imageMessage || unwrapped.audioMessage || unwrapped.pttMessage ||
        unwrapped.videoMessage || unwrapped.ptvMessage ||
        unwrapped.documentMessage || unwrapped.stickerMessage;
      const hasMedia = !!mediaMsg || ['image', 'audio', 'video', 'document', 'sticker'].includes(msgType);

      let base64Media: string | null =
        data.base64 || message.base64 || unwrapped.base64 ||
        mediaMsg?.base64 || null;

      if (hasMedia) {
        // Pipeline em background (Evolution tem timeout curto no webhook):
        //   1. Resolve base64 (inline ou via getBase64FromMedia)
        //   2. Upload pro Storage → media_url
        //   3. Se audio → transcreve com Gemini
        //      Se image → descreve com Gemini
        //   4. Update chats_dashboard.content com transcrição/descrição
        //   5. Se for customer + bot ativo → dispara o agente com o texto enriquecido
        (async () => {
          try {
            // 1) Resolve base64
            if (!base64Media && finalId) {
              console.log("[Media] Sem base64 inline — buscando via getBase64FromMedia...");
              try {
                const got = await evolution.getBase64FromMedia(finalId, instanceName);
                base64Media = got?.base64 || got?.data?.base64 || got?.message?.base64 || null;
              } catch (fetchErr: any) {
                console.warn("[Media] getBase64FromMedia falhou:", fetchErr?.message);
              }
            }
            if (!base64Media) {
              console.warn("[Media] Nenhum base64 disponível pra msg", finalId, "— content fica como placeholder.");
              return;
            }

            const effMimetype = mimetype || mediaMsg?.mimetype || (msgType === "audio" ? "audio/ogg" : msgType === "image" ? "image/jpeg" : "application/octet-stream");

            // 2) Upload
            const url = await uploadMediaBase64(base64Media, remoteJid, effMimetype);
            if (url) {
              console.log("[Media] Uploaded:", url);
            } else {
              console.warn("[Media] Upload falhou — segue pra transcrição mesmo assim.");
            }

            // 3) Gemini: transcrição (áudio) ou descrição (imagem)
            let enrichedContent: string | null = null;
            if (msgType === "audio") {
              console.log("[Media] Transcrevendo áudio com Gemini...");
              const transcript = await transcribeAudioWithGemini(base64Media, effMimetype, finalId);
              if (transcript) {
                enrichedContent = `🎤 ${transcript}`;
                console.log("[Media] Transcrição:", transcript.slice(0, 80));
              } else {
                // Sem transcrição — mas ainda manda o áudio pra IA com uma nota
                // pra ela poder responder algo ("peça pra cliente repetir por texto")
                enrichedContent = "[🎤 O cliente enviou um áudio que não consegui transcrever]";
                console.warn("[Media] Transcrição falhou — veja webhook_logs.event=TRANSCRIPTION_FAIL pro motivo exato.");
              }
            } else if (msgType === "image") {
              console.log("[Media] Descrevendo imagem com Gemini...");
              const desc = await describeImageWithGemini(base64Media, effMimetype);
              if (desc) {
                enrichedContent = `📷 ${desc}`;
                console.log("[Media] Descrição:", desc.slice(0, 80));
              }
              // Imagem sem descrição fica com placeholder "[📷 Imagem]" que já foi inserido
            }

            // 4) Update das tabelas — sempre atualiza media_url/mimetype,
            //    e content se tiver enrichment
            const mediaCategory = ['image', 'audio', 'video', 'document', 'sticker'].includes(msgType) ? msgType : null;

            // messages (V2)
            const v2Update: Record<string, any> = {};
            if (url) v2Update.media_url = url;
            if (effMimetype) v2Update.mimetype = effMimetype;
            if (enrichedContent) v2Update.content = enrichedContent;
            if (Object.keys(v2Update).length > 0) {
              await supabase.from("messages").update(v2Update).eq("message_id", finalId).then(({ error }) => error && console.warn("[Media] update messages:", error.message));
            }

            // chats_dashboard — update completo, com fallback se coluna não existe
            const fullUpdate: Record<string, any> = {};
            if (url) fullUpdate.media_url = url;
            if (mediaCategory) fullUpdate.media_type = mediaCategory;
            if (effMimetype) fullUpdate.mimetype = effMimetype;
            if (enrichedContent) fullUpdate.content = enrichedContent;

            if (Object.keys(fullUpdate).length > 0) {
              const { error: dashUpdErr } = await supabase.from("chats_dashboard").update(fullUpdate).eq("message_id", finalId);

              if (dashUpdErr?.code === "PGRST204") {
                // Alguma coluna extra falta — tenta só content + media_url (essencial)
                const minimal: Record<string, any> = {};
                if (url) minimal.media_url = url;
                if (enrichedContent) minimal.content = enrichedContent;
                const retry = await supabase.from("chats_dashboard").update(minimal).eq("message_id", finalId);
                if (retry.error?.code === "PGRST204") {
                  // Nem media_url existe — atualiza só content
                  if (enrichedContent) {
                    await supabase.from("chats_dashboard").update({ content: enrichedContent }).eq("message_id", finalId);
                  }
                  console.warn("[Media] chats_dashboard sem coluna media_url. Rode criar_chats_dashboard_extras.sql pra mostrar mídia.");
                } else if (retry.error) {
                  console.warn("[Media] update chats_dashboard (minimal):", retry.error.message);
                }
              } else if (dashUpdErr) {
                console.warn("[Media] update chats_dashboard:", dashUpdErr.message);
              }
            }

            // 5) Dispara agente com texto enriquecido (só se msg do cliente + bot ativo +
            //    transcrição disponível + mensagem original NÃO tinha caption — senão
            //    o fluxo síncrono já disparou e a gente evita double-fire).
            if (!fromMe && !text && enrichedContent && session?.id) {
              const effectiveActive = (session as any)._effective_active ?? (session.bot_status === 'bot_active');
              if (effectiveActive) {
                console.log("🤖 [Media] Disparando agente com conteúdo transcrito/descrito:", enrichedContent.slice(0, 60));
                fetch(`${INTERNAL_BASE}/api/agent/process`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(overrideAgentId ? { "x-test-agent-id": overrideAgentId } : {})
                  },
                  body: JSON.stringify({ instanceName, remoteJid, text: enrichedContent, sessionId: session.id })
                }).catch(e => console.error("[Media] Falha ao disparar agente:", e.message));
              }
            }
          } catch (err: any) {
            console.error("[Media] Pipeline falhou:", err?.message);
          }
        })();
      }

      // === 1. SALVA PRIMEIRO NO chats_dashboard (fonte que a UI /chat lê) ===
      // Payload MINIMAL: só colunas que a gente tem certeza que existem.
      // Colunas extras (message_type, media_*, quoted_*, mimetype) são opcionais
      // e serão incluídas via "enrichment" depois, se a tabela tiver espaço.
      //
      // Pra mídias sem caption (foto/áudio sozinhos), sem placeholder a UI mostra
      // "[Sem conteúdo]". Com placeholder, mostra "[🎤 Áudio — transcrevendo...]"
      // e depois o enrichment troca pela transcrição real.
      // Fallback em camadas: texto > placeholder por tipo > genérico [Mídia].
      // Garante que NUNCA caímos em null/"" pra mensagens novas — se um tipo
      // novo aparecer (ex: novo wrapper da Evolution), mostra ao menos "[Mídia]"
      // em vez de "[Sem conteúdo]" no chat.
      const initialContent =
        text ||
        (hasMedia ? mediaPlaceholder(msgType) : null) ||
        (msgType && msgType !== "text" ? mediaPlaceholder(msgType) : null);

      const basePayload: Record<string, any> = {
        instance_name: instanceName,
        message_id: finalId,
        remote_jid: remoteJid,
        sender_type: sender === 'ai' ? 'ai' : sender,
        content: initialContent,
        status_envio: fromMe ? "sent" : "received",
        created_at: new Date().toISOString(),
      };

      let { error: dashErr } = await supabase.from("chats_dashboard").insert(basePayload);

      // Se falhou por coluna faltando (PGRST204), tenta ainda mais minimal
      if (dashErr?.code === "PGRST204") {
        console.warn(">>> [Webhook] chats_dashboard rejeitou coluna — tentando payload mínimo:", dashErr.message);
        const minimal = {
          remote_jid: remoteJid,
          message_id: finalId,
          sender_type: sender === 'ai' ? 'ai' : sender,
          content: text,
          instance_name: instanceName,
          created_at: new Date().toISOString(),
        };
        const retry = await supabase.from("chats_dashboard").insert(minimal);
        dashErr = retry.error as any;
      }

      if (dashErr) {
        if ((dashErr as any).code === "23505") {
          console.log(">>> [Webhook] chats_dashboard duplicata (msg já salva):", finalId);
        } else {
          console.error(">>> [Webhook] ❌ FALHA chats_dashboard:", dashErr.message, "| Details:", JSON.stringify(dashErr));
          await supabase.from("webhook_logs").insert({
            instance_name: instanceName,
            event: "WEBHOOK_DASH_INSERT_FAIL",
            payload: { remote_jid: remoteJid, sender, message_id: finalId, error: dashErr.message, code: (dashErr as any).code, details: dashErr },
            created_at: new Date().toISOString(),
          }).then(() => {}, () => {});
        }
      } else {
        console.log(">>> [Webhook] chats_dashboard OK:", finalId, "| sender_type:", sender === 'ai' ? 'ai' : sender);

        // Best-effort: se a tabela tem as colunas de mídia, preenche via UPDATE separado.
        // Se não tiver, falha silenciosa (não afeta a exibição no chat).
        if (mediaUrl || msgType !== 'text' || quotedId) {
          const extras: Record<string, any> = {};
          if (mediaUrl) extras.media_url = mediaUrl;
          if (mimetype) extras.mimetype = mimetype;
          if (['image', 'audio', 'video', 'document'].includes(msgType)) extras.media_type = msgType;
          if (msgType !== 'text') extras.message_type = msgType + 'Message';
          if (quotedId) extras.quoted_id = quotedId;
          if (quotedText) extras.quoted_text = quotedText;
          supabase.from("chats_dashboard").update(extras).eq("message_id", finalId).then(() => {}, () => {});
        }
      }

      // === 2. SALVA no messages (V2) — só se tiver session. NÃO bloqueia. ===
      if (session?.id) {
        const { error: insertError } = await supabase.from("messages").insert({
          session_id: session.id,
          message_id: finalId,
          sender,
          content: text || null,
          media_category: msgType as any,
          media_url: mediaUrl,
          mimetype,
          file_name: fileName,
          file_size: fileSize,
          quoted_msg_id: quotedId,
          quoted_text: quotedText,
          delivery_status: fromMe ? "sent" : "pending",
          created_at: new Date().toISOString(),
        });

        if (insertError && insertError.code !== "23505") {
          console.error(">>> [Webhook] ⚠ messages insert falhou (não-fatal):", insertError.message);
          await supabase.from("webhook_logs").insert({
            instance_name: instanceName,
            event: "WEBHOOK_V2_INSERT_FAIL",
            payload: { remote_jid: remoteJid, sender, message_id: finalId, error: insertError.message, code: insertError.code },
            created_at: new Date().toISOString(),
          }).then(() => {}, () => {});
        }
      } else {
        console.warn(">>> [Webhook] Sem session — V2 messages pulado (chats_dashboard já tem a msg).");
      }

      console.log(">>> MESSAGE SALVA:", finalId, "| sender:", sender);

      // === 3. Atualizar session: last_message_at + unread_count ===
      if (session?.id) {
        const updatePayload: any = { last_message_at: new Date().toISOString() };
        if (!fromMe) {
          updatePayload.unread_count = (session as any).unread_count ? (session as any).unread_count + 1 : 1;
        }
        supabase.from("sessions").update(updatePayload).eq("id", session.id).then(() => {}, () => {});
      }

      // === Disparar IA (apenas se mensagem do cliente E IA efetivamente ativa) ===
      if (!fromMe && text && session?.id) {
        const effectiveActive = (session as any)._effective_active ?? (session.bot_status === 'bot_active');
        if (effectiveActive) {
          console.log("🤖 DISPARANDO AGENTE DE IA PARA:", remoteJid);
          fetch(`${INTERNAL_BASE}/api/agent/process`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(overrideAgentId ? { "x-test-agent-id": overrideAgentId } : {})
            },
            body: JSON.stringify({ instanceName, remoteJid, text, sessionId: session.id })
          }).catch(e => console.error("[Webhook] Erro ao disparar IA:", e.message));
        } else {
          console.log("⏸️ IA pausada para:", remoteJid, "| status:", session.bot_status, "(mensagem foi salva, IA terá contexto ao voltar)");
          await supabase.from("webhook_logs").insert({
            instance_name: instanceName,
            event: "AGENT_SKIP_PAUSED",
            payload: { remoteJid, bot_status: session.bot_status, message_saved: true },
            created_at: new Date().toISOString()
          });
        }
      }

      return NextResponse.json({ success: true, event: "message_saved", message_id: finalId, sender });
    }

    // ============================================================
    // EVENTO: messages.update (status de entrega)
    // ============================================================
    if (eventName === "messages.update" || eventName === "MESSAGES_UPDATE" || eventName === "message.status.update") {
      const data = body.data || body;
      const msgId = data.key?.id || data.id;
      const statusRaw = data.status;

      if (msgId && statusRaw !== null && statusRaw !== undefined) {
        const statusText = STATUS_MAP[statusRaw] || "sent";
        await supabase.from("messages").update({ delivery_status: statusText }).eq("message_id", msgId);
        // Compatibilidade
        await supabase.from("chats_dashboard").update({ status_envio: statusText }).eq("message_id", msgId);
      }
      return NextResponse.json({ success: true, event: "status_updated" });
    }

    // ============================================================
    // EVENTO: connection.update
    // ============================================================
    if (eventName === "connection.update" || eventName === "CONNECTION_UPDATE") {
      const data = body.data || body;
      console.log(">>> CONNECTION UPDATE ->", JSON.stringify(data).slice(0, 200));
      return NextResponse.json({ success: true, event: "connection_update" });
    }

    // ============================================================
    // EVENTO: messages.delete
    // ============================================================
    if (eventName === "messages.delete" || eventName === "MESSAGES_DELETE") {
      const data = body.data || body;
      const msgId = data.key?.id || data.id;
      if (msgId) {
        await supabase.from("messages").update({ content: "[Mensagem apagada]" }).eq("message_id", msgId);
        await supabase.from("chats_dashboard").update({ content: "[Mensagem apagada]" }).eq("message_id", msgId);
      }
      return NextResponse.json({ success: true, event: "message_deleted" });
    }

    // SEND_MESSAGE echo
    if (eventName === "send.message" || eventName === "SEND_MESSAGE") {
      return NextResponse.json({ success: true, event: "send_mirrored" });
    }

    console.log(">>> EVENTO NÃO TRATADO:", eventName);
    return NextResponse.json({ success: true, message: "Evento registrado" });

  } catch (err) {
    console.error(">>> WEBHOOK ERROR:", err);
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

// GET para debug
export async function GET() {
  const { data } = await supabase
    .from("webhook_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  return NextResponse.json({ success: true, logs: data || [] });
}
