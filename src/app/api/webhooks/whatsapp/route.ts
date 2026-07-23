import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { evolution, getEvolutionConfig } from "@/lib/evolution";
import { getEffectiveStatus } from "@/lib/bot-status";
import { isManualSend, isAiSend, isPendingAutomatedSend } from "@/lib/manual-send-registry";
import { clientIdFromInstance, DEFAULT_CLIENT_ID } from "@/lib/tenant";
import { getInternalSecret, INTERNAL_SECRET_HEADER } from "@/lib/internal-auth";
import { maskJid, truncForLog } from "@/lib/pii";

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

export function extractText(messageRaw: Record<string, any>): string {
  const message = unwrapMessage(messageRaw);
  if (!message) return "";

  // Suporte a templateMessage (WhatsApp Business / Facebook alerts)
  if (message.templateMessage) {
    const tm = message.templateMessage;
    const it = tm.interactiveMessageTemplate;
    const bodyText = it?.body?.text || tm.hydratedTemplate?.hydratedContentText || tm.hydratedFourRowTemplate?.hydratedContentText || "";
    const headerTitle = it?.header?.title || tm.hydratedTemplate?.hydratedTitleText || "";
    
    let buttonsStr = "";
    const buttons = it?.nativeFlowMessage?.buttons || tm.hydratedTemplate?.hydratedButtons || [];
    if (buttons.length > 0) {
      try {
        buttonsStr = "\n\n" + buttons.map((b: any) => {
          const params = b.buttonParamsJson ? JSON.parse(b.buttonParamsJson) : {};
          const label = b.displayText || params.display_text || b.quickReplyButton?.displayText || "Clique aqui";
          const url = params.url || "";
          return url ? `🔗 [${label}](${url})` : `🔘 ${label}`;
        }).join("\n");
      } catch (err) {
        buttonsStr = "";
      }
    }
    return [headerTitle ? `*${headerTitle}*` : "", bodyText, buttonsStr].filter(Boolean).join("\n\n");
  }

  // Suporte a interactiveMessage (mensagens interativas com botões)
  if (message.interactiveMessage) {
    const im = message.interactiveMessage;
    const bodyText = im.body?.text || "";
    const headerTitle = im.header?.title || "";
    
    let buttonsStr = "";
    const buttons = im.nativeFlowMessage?.buttons || [];
    if (buttons.length > 0) {
      try {
        buttonsStr = "\n\n" + buttons.map((b: any) => {
          const params = b.buttonParamsJson ? JSON.parse(b.buttonParamsJson) : {};
          const label = b.displayText || params.display_text || "Clique aqui";
          const url = params.url || "";
          return url ? `🔗 [${label}](${url})` : `🔘 ${label}`;
        }).join("\n");
      } catch (err) {
        buttonsStr = "";
      }
    }
    return [headerTitle ? `*${headerTitle}*` : "", bodyText, buttonsStr].filter(Boolean).join("\n\n");
  }

  // Suporte a buttonsMessage (templates de botões tradicionais)
  if (message.buttonsMessage) {
    const bm = message.buttonsMessage;
    const bodyText = bm.contentText || "";
    const headerText = bm.headerText || "";
    
    let buttonsStr = "";
    const buttons = bm.buttons || [];
    if (buttons.length > 0) {
      buttonsStr = "\n\n" + buttons.map((b: any) => `🔘 ${b.buttonText?.displayText || "Opção"}`).join("\n");
    }
    return [headerText ? `*${headerText}*` : "", bodyText, buttonsStr].filter(Boolean).join("\n\n");
  }

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

export function extractMessageType(messageRaw: Record<string, any>): string {
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

export function extractMimetype(messageRaw: Record<string, any>): string | null {
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

export function extractFileName(messageRaw: Record<string, any>): string | null {
  const message = unwrapMessage(messageRaw);
  return message?.documentMessage?.fileName
    || message?.imageMessage?.fileName
    || null;
}

export function extractFileSize(messageRaw: Record<string, any>): number | null {
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

export function extractQuoted(messageRaw: Record<string, any>) {
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
 * Modelos Gemini tentados em ordem — ordenados por custo-benefício (mais
 * barato primeiro, fallback se a key não tiver acesso). Todos suportam
 * inlineData (áudio/imagem/PDF) nativamente.
 *
 * Construída DINAMICAMENTE em runtime via `buildFallbackChain()` — lê a lista
 * real da Google (com cache 10 min). Nada hardcoded: quando Google publica 4.x
 * aparece sozinho, quando despublica 3.x some sozinho.
 *
 * Fallback final (cold start, sem API key, Google fora): tenta o que dá. O
 * caller fica responsável por logar falha — não inventamos modelo.
 */
async function getGeminiModelChain(): Promise<string[]> {
  const { buildFallbackChain } = await import("@/lib/gemini-model-discovery");
  return buildFallbackChain();
}

async function transcribeAudioWithGemini(base64: string, mimetype: string, debugMessageId?: string, clientId?: string): Promise<string | null> {
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
  const chain = await getGeminiModelChain();
  if (!chain.length) {
    await logFail("Não foi possível descobrir modelos Gemini (API key inválida ou Google fora).");
    return null;
  }
  for (const modelName of chain) {
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
              clientId: clientId || undefined,
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
async function describeImageWithGemini(base64: string, mimetype: string, clientId?: string): Promise<string | null> {
  const { data: cfg } = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
  const apiKey = cfg?.api_key;
  if (!apiKey) return null;

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
  const effMime = sanitizeMimetype(mimetype, "image/jpeg");

  const chain = await getGeminiModelChain();
  if (!chain.length) return null;
  for (const modelName of chain) {
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
          clientId: clientId || undefined,
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

/**
 * Extrai conteúdo de PDF/documento usando Gemini multimodal.
 * Gemini 1.5+ aceita PDFs inline diretamente (não precisa pdf-parse externo).
 * Pra outros tipos de documento (docx, xlsx, txt), só PDF e TXT são suportados
 * nativamente — outros formatos retornam null e a IA cai no placeholder.
 *
 * Retorna o conteúdo do documento resumido + texto principal extraído.
 */
async function describeDocumentWithGemini(base64: string, mimetype: string, fileName: string | null, clientId?: string): Promise<string | null> {
  const { data: cfg } = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
  const apiKey = cfg?.api_key;
  if (!apiKey) return null;

  // Gemini API aceita estes mimetypes de documento inline:
  // application/pdf, text/plain, text/html, text/css, text/javascript,
  // application/x-javascript, text/x-typescript, application/x-typescript,
  // text/csv, text/markdown, text/x-python, application/x-python-code,
  // application/json, text/xml, application/rtf, text/rtf
  const cleanMime = sanitizeMimetype(mimetype, "application/pdf");
  const supportedDocs = /^(application\/pdf|text\/|application\/(json|rtf|x-javascript|x-python-code|x-typescript))/i;
  if (!supportedDocs.test(cleanMime)) {
    console.log(`[DocumentExtract] mimetype ${cleanMime} não suportado nativamente pelo Gemini — pulando.`);
    return null;
  }

  const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
  const sizeBytes = Math.ceil(cleanBase64.length * 0.75);
  // Gemini inline aceita até 20 MB. Acima disso seria preciso usar Files API (não cobrimos aqui).
  if (sizeBytes > 20 * 1024 * 1024) {
    console.warn(`[DocumentExtract] documento > 20 MB (${sizeBytes}B) — pulando (use Files API pra arquivos grandes).`);
    return null;
  }

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);

  const filenameHint = fileName ? ` (arquivo: ${fileName})` : "";

  const chain = await getGeminiModelChain();
  if (!chain.length) return null;
  for (const modelName of chain) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        { inlineData: { data: cleanBase64, mimeType: cleanMime } },
        {
          text:
            `Você recebeu um documento${filenameHint}. ` +
            "Gere um resumo executivo em PT-BR (até 4 frases) do conteúdo principal. " +
            "Se o documento tiver dados estruturados (tabela, contrato, NF, currículo, proposta), " +
            "liste os pontos-chave em bullets curtos. Sem preâmbulo, sem 'aqui está o resumo'.",
        },
      ]);
      const text = result.response.text().trim();
      if (text) {
        const { logTokenUsage, extractGeminiUsage } = await import("@/lib/token-usage");
        const u = extractGeminiUsage(result);
        await logTokenUsage({
          source: "other",
          sourceLabel: "Extração de documento",
          model: modelName,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          totalTokens: u.totalTokens,
          clientId: clientId || undefined,
          metadata: { kind: "document_extraction", mime: cleanMime, fileName, sizeBytes },
        });
        return text;
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      console.warn(`[DocumentExtract] falha ${modelName}: ${msg.slice(0, 200)}`);
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
    case "document": return "[📄 Documento — extraindo conteúdo...]";
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

/**
 * Auto-cura do nome do lead no CRM. Preenche `leads_extraidos.nome_negocio`
 * com o push_name do WhatsApp QUANDO o nome atual está vazio ou é um
 * placeholder (telefone cru, "Desconhecido", "Lead Disparo (...)", "Lead Via
 * Chat (...)"). NUNCA sobrescreve um nome real (ex: vindo do scraper do Maps).
 * Best-effort — falha aqui não pode derrubar o webhook.
 */
async function healLeadNameFromPushName(remoteJid: string, pushName: string | undefined, clientId: string) {
  const name = (pushName || "").trim();
  if (!name) return;
  // Se o próprio push_name é só dígitos (alguns aparelhos), não ajuda.
  if (name.replace(/\D/g, "") === name.replace(/\s/g, "")) return;
  try {
    const { data: lead } = await supabase
      .from("leads_extraidos")
      .select("id, nome_negocio")
      .eq("remoteJid", remoteJid)
      .eq("client_id", clientId)
      .maybeSingle();
    if (!lead) return;
    const cur = (lead.nome_negocio || "").trim();
    const phone = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
    const isPlaceholder =
      !cur ||
      cur.toLowerCase() === "desconhecido" ||
      cur.toLowerCase() === "sem registro" ||
      /^lead\s+(via chat|disparo|whatsapp)/i.test(cur) ||
      cur.replace(/\D/g, "") === phone; // nome_negocio == telefone
    if (isPlaceholder) {
      await supabase.from("leads_extraidos").update({ nome_negocio: name }).eq("id", lead.id);
    }
  } catch { /* best-effort */ }
}

async function findOrCreateContact(remoteJid: string, pushName: string | undefined, clientId: string) {
  // Tenta encontrar contato existente (busca pelo JID único de forma ampla, sem escopar rigidamente por client_id no SELECT primário, para curar e evitar colisão de tenants)
  const { data: existing } = await supabase
    .from("contacts")
    .select("id, push_name, client_id")
    .eq("remote_jid", remoteJid)
    .maybeSingle();

  if (existing) {
    // Alinhamento de Tenant (Backfill): se o contato existe com o client_id default ou nulo,
    // atualizamos para o client_id real da instância ativa pra unificar chats e sessões.
    if (!existing.client_id || existing.client_id === DEFAULT_CLIENT_ID) {
      await supabase
        .from("contacts")
        .update({ client_id: clientId })
        .eq("id", existing.id);
    }

    // Só preenche o nome se o contato AINDA não tem um. Assim o nome do
    // negócio (definido pelo disparo da automação) NÃO é sobrescrito depois
    // pela alcunha do WhatsApp — a conversa segue identificada pela empresa.
    if (pushName && !existing.push_name) {
      await supabase.from("contacts").update({ push_name: pushName }).eq("id", existing.id);
    }
    return existing.id;
  }

  const phoneNumber = evolution.extractPhone(remoteJid);
  const { data: newContact, error } = await supabase.from("contacts").insert({
    client_id: clientId,
    remote_jid: remoteJid,
    push_name: pushName || null,
    phone_number: phoneNumber,
  }).select("id").single();

  if (error) {
    if (error.code === "23505") {
      // Retry resiliente: busca pelo JID único de forma ampla
      const { data: retry } = await supabase
        .from("contacts").select("id, client_id")
        .eq("remote_jid", remoteJid).single();
      
      if (retry) {
        if (!retry.client_id || retry.client_id === DEFAULT_CLIENT_ID) {
          await supabase
            .from("contacts")
            .update({ client_id: clientId })
            .eq("id", retry.id);
        }
        return retry.id;
      }
    }
    throw error;
  }
  return newContact.id;
}

async function findOrCreateSession(contactId: string, instanceName: string, remoteJid: string, clientId: string) {
  const { data: existing } = await supabase
    .from("sessions")
    .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id")
    .eq("contact_id", contactId)
    .eq("instance_name", instanceName)
    .maybeSingle();

  if (existing) {
    const eff = await getEffectiveStatus(existing as any);
    return { ...existing, bot_status: eff.status, resume_at: eff.resumeAt, _effective_active: eff.isActive };
  }

  // === MIGRAÇÃO DE SESSÃO POR NÚMERO DE TELEFONE CONECTADO ==================
  // Sessões são chaveadas por (contact_id, instance_name). Mas o que o
  // usuário quer é continuidade pelo NÚMERO conectado: se desconectou
  // WhatsApp em "sdr" e reconectou o MESMO nº em "sdr_v2", a IA deve manter
  // estado (pausa, variáveis do funil, memória) — não reiniciar do zero.
  // Aqui detectamos instâncias "irmãs" pelo owner_phone persistido em
  // channel_connections.provider_config e MIGRAMOS a sessão pra instância
  // atual (UPDATE do instance_name preserva tudo: bot_status, paused_*,
  // current_stage_id, variables, last_message_at). agent_id é atualizado
  // pro agente vinculado à nova instância.
  // ==========================================================================
  const { data: allConns } = await supabase
    .from("channel_connections")
    .select("instance_name, agent_id, provider_config")
    .eq("client_id", clientId);
  const currentConn = (allConns || []).find((c: any) => c.instance_name === instanceName);
  const ownerPhone = String(currentConn?.provider_config?.owner_phone || "").replace(/\D/g, "");
  if (ownerPhone && ownerPhone.length >= 8) {
    const siblingNames = (allConns || [])
      .filter((c: any) => c.instance_name !== instanceName &&
        String(c.provider_config?.owner_phone || "").replace(/\D/g, "") === ownerPhone)
      .map((c: any) => c.instance_name);
    if (siblingNames.length > 0) {
      const { data: siblingSess } = await supabase
        .from("sessions")
        .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id")
        .eq("contact_id", contactId)
        .in("instance_name", siblingNames)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (siblingSess) {
        const newAgentId = currentConn?.agent_id || siblingSess.agent_id || 1;
        const { data: migrated, error: migErr } = await supabase
          .from("sessions")
          .update({ instance_name: instanceName, agent_id: newAgentId })
          .eq("id", siblingSess.id)
          .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id")
          .maybeSingle();
        if (!migErr && migrated) {
          console.log(`[SESSION MIGRATE] sessão ${siblingSess.id} de "${siblingSess.instance_name}" → "${instanceName}" (mesmo nº ${ownerPhone}) — estado preservado.`);
          const eff = await getEffectiveStatus(migrated as any);
          return { ...migrated, bot_status: eff.status, resume_at: eff.resumeAt, _effective_active: eff.isActive };
        }
        // Se a UPDATE bater em unique (race com outro processo criando a
        // sessão na nova instância), cai pro INSERT abaixo e o 23505 catch
        // recupera a versão existente.
      }
    }
  }

  // Não tem instância irmã com sessão pré-existente → cria nova.
  const channel = currentConn || null;
  const { data: newSession, error } = await supabase.from("sessions").insert({
    client_id: clientId,
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

  // Lê o body como texto uma vez — precisamos do instance ANTES de validar
  // o secret per-instância. Depois reparseamos pra usar normalmente.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ success: false, error: "Body inválido" }, { status: 400 });
  }

  try {
    const body = JSON.parse(rawBody);
    const eventName = body.event || body.type || "unknown";

    // ============================================================
    // VALIDAÇÃO DE ORIGEM — per-instância (não-bloqueante por padrão)
    // ============================================================
    // O secret é gerado quando o cliente clica "Registrar Webhook" e fica em
    // channel_connections.provider_config.webhook_secret. Evolution v2 manda
    // como X-Webhook-Secret. ANTES o webhook BLOQUEAVA com 401 quando o
    // header não batia — resultado: cliente perdia mensagens silenciosamente
    // se a Evolution dele re-registrou webhook sem o header (cenário comum
    // quando cliente mexe direto no painel Evolution sem usar nosso fluxo).
    //
    // AGORA: mismatch só LOGA em webhook_logs (visível em /api/webhooks/
    // diagnose), não bloqueia. Cliente que quiser fechar a porta forçando
    // 401 pode setar `channel_connections.provider_config.webhook_strict=true`.
    const instanceForSecret = body.instance || body.instance_name;
    let secretMismatch: string | null = null; // tag pra logar lá embaixo
    if (instanceForSecret) {
      try {
        const { data: conn } = await supabase
          .from("channel_connections")
          .select("provider_config")
          .eq("instance_name", instanceForSecret)
          .maybeSingle();
        const cfg = (conn?.provider_config || {}) as any;
        const expected = cfg.webhook_secret as string | undefined;
        const strict = !!cfg.webhook_strict;
        if (expected) {
          const got = req.headers.get("x-webhook-secret") || req.headers.get("x-internal-secret");
          if (got !== expected) {
            secretMismatch = got ? "header_mismatch" : "header_absent";
            console.warn(`>>> webhook secret mismatch em ${instanceForSecret}: ${secretMismatch} (strict=${strict})`);
            if (strict) {
              // Persistente: deixa rastro no webhook_logs antes de rejeitar
              await supabase.from("webhook_logs").insert({
                instance_name: instanceForSecret,
                event: "WEBHOOK_SECRET_REJECTED",
                payload: { reason: secretMismatch, strict: true },
                created_at: new Date().toISOString(),
              }).then(() => {}, () => {});
              return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
            }
            // Não-strict: continua, mas registra
            await supabase.from("webhook_logs").insert({
              instance_name: instanceForSecret,
              event: "WEBHOOK_SECRET_MISMATCH",
              payload: { reason: secretMismatch, action: "accepted_anyway" },
              created_at: new Date().toISOString(),
            }).then(() => {}, () => {});
          }
        }
      } catch {
        /* falha de lookup não bloqueia processamento — backwards compat */
      }
    }
    // Aceita QUALQUER nome de instância vindo do payload da Evolution.
    // Fallback final = instância configurada (DB ou env), nunca um literal.
    const instanceName = body.instance || body.instance_name || (await getEvolutionConfig()).instance;
    if (!instanceName) {
      console.warn(">>> webhook recebido sem instância identificável; ignorando");
      return NextResponse.json({ success: false, ignored: true, reason: "no_instance" });
    }
    const overrideAgentId = req.nextUrl.searchParams.get("agentId");

    console.log(">>> [Evolution API v2] Evento:", eventName, "| Instância:", instanceName);

    // ============================================================
    // MULTI-TENANT: descobre a qual cliente esta instância pertence.
    // Sem isso, mensagens de cliente A vazariam no painel do cliente B.
    // Fallback Default mantém compat com webhooks de instâncias antigas
    // que ainda não foram vinculadas a um cliente específico.
    // ============================================================
    const clientId = (await clientIdFromInstance(instanceName)) || DEFAULT_CLIENT_ID;

    // Log tudo para debug
    await supabase.from("webhook_logs").insert({
      client_id: clientId,
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

      console.log(">>> MESSAGE PARSED ->", { id: finalId, jid: maskJid(remoteJid), text: truncForLog(text, 40), fromMe, type: msgType });

      if (!finalId || !remoteJid) {
        console.warn(">>> [Webhook] Ignorando evento sem finalId ou remoteJid");
        return NextResponse.json({ success: false, error: "Missing message_id or remote_jid" });
      }

      console.log(`>>> [Webhook] Processando mensagem id: ${finalId} de: ${maskJid(remoteJid)}`);

      // Ignorar placeholderMessage do Baileys/Evolution (mensagem de controle pendente)
      const unwrappedForPlaceholder = unwrapMessage(message);
      if (message.placeholderMessage || unwrappedForPlaceholder.placeholderMessage) {
        console.log(">>> [Webhook] Ignorando placeholderMessage:", finalId);
        return NextResponse.json({ success: true, ignored: true, reason: "placeholder_message" });
      }

      // Ignorar mensagens de status broadcast
      if (remoteJid === "status@broadcast") {
        return NextResponse.json({ success: true, ignored: true, reason: "status_broadcast" });
      }

      // === In-Memory Concurrency Set Guard ===
      if (!(globalThis as any).__processedMessageIds) {
        (globalThis as any).__processedMessageIds = new Set<string>();
      }
      if ((globalThis as any).__processedMessageIds.has(finalId)) {
        console.log(`>>> [Webhook] Concurrency guard: message ${finalId} already processing. Ignoring.`);
        return NextResponse.json({ success: true, message: "Já processando (concorrência bloqueada)" });
      }
      (globalThis as any).__processedMessageIds.add(finalId);

      try {
      // === Find or Create Contact & Session ===
      // Se falhar, NÃO aborta mais — a msg ainda vai pra chats_dashboard (que é o que
      // a UI /chat lê). A tabela V2 messages depende de session, mas é secundária.
      let contactId: string | null = null;
      let session: any = null;
      try {
        // Em mensagens fromMe (saíram do nosso número), `pushName` é o nome
        // do REMETENTE (nós) — não do contato. Passar isso renomearia o
        // contato errado. Por isso só usamos pushName de mensagens recebidas.
        contactId = await findOrCreateContact(remoteJid, fromMe ? undefined : pushName, clientId);
        if (contactId) {
          session = await findOrCreateSession(contactId, instanceName, remoteJid, clientId);
        }
        // Auto-cura do nome do lead no CRM: muitos leads entram sem nome de
        // empresa (disparo por lista de números, lead que chamou no chat, etc) e
        // ficam identificáveis só pelo telefone. Quando a pessoa interage e o
        // WhatsApp informa o push_name, preenchemos o nome_negocio do lead SE
        // estiver vazio/placeholder — sem sobrescrever nomes reais (scraper).
        if (!fromMe && pushName) {
          await healLeadNameFromPushName(remoteJid, pushName, clientId);
        }
      } catch (sessErr: any) {
        console.error(">>> [Webhook] ⚠ Falha ao criar contact/session (não-fatal):", sessErr?.message);
        await supabase.from("webhook_logs").insert({
          client_id: clientId,
          instance_name: instanceName,
          event: "WEBHOOK_SESSION_FAIL",
          payload: { remote_jid: remoteJid, error: sessErr?.message, fromMe },
          created_at: new Date().toISOString(),
        }).then(() => {}, () => {});
      }

      // Determinar sender. Pra mensagens fromMe (saíram do nosso número):
      //   - isAiSend     → foi a PRÓPRIA IA (registro em memória) → 'ai'
      //   - isManualSend → envio pelo painel → 'human'
      //   - nenhum dos 2 → humano digitou no CELULAR (número conectado) → 'human'
      // Antes usava-se `bot_active ? 'ai' : 'human'`, que rotulava errado um
      // envio do celular como 'ai' quando o bot estava ativo — e, com isso, a
      // IA nunca pausava ao você responder pelo telefone.
      let sender: 'customer' | 'ai' | 'human' | 'system' = 'customer';
      if (fromMe) {
        if (isAiSend(finalId) || isPendingAutomatedSend(instanceName, remoteJid, text)) {
          sender = 'ai';
        } else if (isManualSend(finalId)) {
          sender = 'human';
          console.log(">>> [Webhook] fromMe=true — envio MANUAL do painel:", finalId);
        } else {
          sender = 'human';
          console.log(">>> [Webhook] fromMe=true — envio pelo CELULAR (número conectado):", finalId);
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
      const mediaUrl: string | null = null;
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
        // Pipeline async em background. Em Next 16 com output:standalone, IIFE
        // continua executando DB ops após response (Node event loop ainda vivo).
        // Apenas fetch() de saída pode ser abortado — por isso o dispatch interno
        // do agente em mensagens texto vai pelo caminho síncrono acima.
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

            // 3) ÁUDIO: whisper.cpp PRIMEIRO (grátis, local) → Gemini fallback.
            // Nunca perde um áudio: se o whisper falhar/indisponível, cai pro
            // Gemini (multimodal, gasta token mas garante resposta ao cliente).
            let enrichedContent: string | null = null;
            if (msgType === "audio") {
              let transcript: string | null = null;
              let transcribeProvider = "none";
              // Tenta whisper.cpp (grátis) primeiro — baixa na 1ª vez, cacheia.
              try {
                const { transcribeAudioWithWhisper } = await import("@/lib/whisper-manager");
                console.log("[Media] Transcrevendo áudio com whisper.cpp (grátis)...");
                transcript = await transcribeAudioWithWhisper(base64Media, effMimetype);
                if (transcript) transcribeProvider = "whisper";
              } catch (wErr: any) {
                console.warn("[Media] whisper.cpp indisponível:", wErr?.message, "→ cai pro Gemini.");
              }
              // Fallback: Gemini multimodal (gasta token, mas nunca falha).
              if (!transcript) {
                console.log("[Media] Transcrevendo áudio com Gemini (fallback)...");
                transcript = await transcribeAudioWithGemini(base64Media, effMimetype, finalId, clientId);
                if (transcript) transcribeProvider = "gemini";
              }
              if (transcript) {
                enrichedContent = `🎤 ${transcript}`;
                console.log(`[Media] Transcrição (${transcribeProvider}):`, transcript.slice(0, 80));
              } else {
                // Sem transcrição — mas ainda manda o áudio pra IA com uma nota
                // pra ela poder responder algo ("peça pra cliente repetir por texto")
                enrichedContent = "[🎤 O cliente enviou um áudio que não consegui transcrever]";
                console.warn("[Media] Transcrição falhou — veja webhook_logs.event=TRANSCRIPTION_FAIL pro motivo exato.");
              }
            } else if (msgType === "image") {
              console.log("[Media] Descrevendo imagem com Gemini...");
              const desc = await describeImageWithGemini(base64Media, effMimetype, clientId);
              if (desc) {
                enrichedContent = `📷 ${desc}`;
                console.log("[Media] Descrição:", desc.slice(0, 80));
              }
              // Imagem sem descrição fica com placeholder "[📷 Imagem]" que já foi inserido
            } else if (msgType === "document") {
              console.log("[Media] Extraindo conteúdo de documento com Gemini...");
              const fileName = extractFileName(message);
              const desc = await describeDocumentWithGemini(base64Media, effMimetype, fileName, clientId);
              if (desc) {
                enrichedContent = `📄 ${fileName ? `[${fileName}] ` : ""}${desc}`;
                console.log("[Media] Documento:", desc.slice(0, 80));
              } else {
                // Sem extração mas IA ainda recebe contexto de que cliente mandou arquivo
                enrichedContent = `[📄 O cliente enviou ${fileName ? `o documento "${fileName}"` : "um documento"}${effMimetype ? ` (${effMimetype})` : ""} mas não consegui extrair o conteúdo automaticamente]`;
              }
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
                try {
                  await fetch(`${INTERNAL_BASE}/api/agent/process`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      [INTERNAL_SECRET_HEADER]: getInternalSecret(),
                      ...(overrideAgentId ? { "x-test-agent-id": overrideAgentId } : {})
                    },
                    body: JSON.stringify({ instanceName, remoteJid, text: enrichedContent, sessionId: session.id })
                  });
                } catch (e: any) {
                  console.error("[Media] Falha ao disparar agente:", e?.message);
                }
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
        client_id: clientId,
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
          client_id: clientId,
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
          console.log(">>> [Webhook] chats_dashboard duplicata (msg já salva, abortando fluxo concorrente):", finalId);
          return NextResponse.json({ success: true, message: "Já processada (duplicata concorrente 23505)" });
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
          client_id: clientId,
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

        if (insertError) {
          if (insertError.code === "23505") {
            console.log(">>> [Webhook] messages duplicata (msg já salva, abortando fluxo concorrente):", finalId);
            return NextResponse.json({ success: true, message: "Já processada (duplicata concorrente messages 23505)" });
          } else {
            console.error(">>> [Webhook] ⚠ messages insert falhou (não-fatal):", insertError.message);
            await supabase.from("webhook_logs").insert({
              instance_name: instanceName,
              event: "WEBHOOK_V2_INSERT_FAIL",
              payload: { remote_jid: remoteJid, sender, message_id: finalId, error: insertError.message, code: insertError.code },
              created_at: new Date().toISOString(),
            }).then(() => {}, () => {});
          }
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

      // === Auto-pausa da IA quando um HUMANO assume a conversa ===
      // Vale pro envio pelo painel E pelo CELULAR (número conectado). Evita
      // IA + humano respondendo o cliente juntos. A mensagem do humano JÁ
      // foi salva acima → a IA mantém o contexto e, ao voltar, sabe tudo o
      // que foi conversado. Configurável (ligar/desligar, minutos, modo).
      if (fromMe && sender === "human" && session?.id) {
        try {
          // Salvaguarda anti-eco: se há uma mensagem IDÊNTICA da IA nos
          // últimos 30s pra esse contato, isto é só o echo da própria IA
          // (caso raro do id não bater no registro) — NÃO pausa a si mesma.
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
              // A auto-pausa de mensagens manuais (do chat ou do celular) agora é sempre temporária (snooze)
              // com base nos minutos pre-selecionados configurados no sistema.
              await snoozeSession(session.id, hp.minutes, "human");
              console.log(`[AUTO-PAUSE] IA pausada ${hp.minutes}min (snooze automático) — humano respondeu ${maskJid(remoteJid)}`);
            }
          }
        } catch (e: any) {
          console.warn("[AUTO-PAUSE] falhou:", e?.message);
        }
      }

      // === Disparar IA (apenas se mensagem do cliente E IA efetivamente ativa) ===
      if (!fromMe && text && session?.id) {
        const effectiveActive = (session as any)._effective_active ?? (session.bot_status === 'bot_active');
        if (effectiveActive) {
          console.log("🤖 DISPARANDO AGENTE DE IA PARA:", maskJid(remoteJid));
          // Verifica precondições críticas ANTES do fetch:
          //  1) Secret interno tem que existir senão /api/agent/process devolve 401 silencioso
          const internalSecretValue = getInternalSecret();
          if (!internalSecretValue) {
            await supabase.from("webhook_logs").insert({
              instance_name: instanceName,
              event: "AGENT_DISPATCH_NO_SECRET",
              payload: { hint: "AUTH_SECRET ou SUPABASE_SERVICE_ROLE_KEY vazio no env do container; /api/agent/process vai rejeitar com 401", remote_jid: maskJid(remoteJid) },
              created_at: new Date().toISOString(),
            }).then(() => {}, () => {});
          }
          // FIX Next 16: NÃO usar fire-and-forget (cancelado quando handler retorna)
          // NEM after() (no-op em alguns setups standalone). Importar o handler
          // do agente DIRETAMENTE e invocar em-processo. Mais rápido, sem rede,
          // sem auth interna, sem cancelamento. Webhook bloqueia ~3-7s mas
          // Evolution aceita até 30s tranquilamente.
          await supabase.from("webhook_logs").insert({
            instance_name: instanceName,
            event: "AGENT_DISPATCH_SCHEDULED",
            payload: { remote_jid: maskJid(remoteJid), via: "direct-call" },
            created_at: new Date().toISOString(),
          }).then(() => {}, () => {});
          try {
            const agentMod = await import("@/app/api/agent/process/route");
            // Mantém o INTERNAL_SECRET_HEADER pra passar pelo gate do agent/process
            const fakeReq = new Request(`${INTERNAL_BASE}/api/agent/process`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                [INTERNAL_SECRET_HEADER]: internalSecretValue,
                ...(overrideAgentId ? { "x-test-agent-id": overrideAgentId } : {}),
              },
              body: JSON.stringify({ instanceName, remoteJid, text, sessionId: session.id }),
            });
            // Next 13+ Route Handler aceita Request; o cast pra NextRequest é seguro
            // porque agent/process não usa nada exclusivo do NextRequest extras.
            await agentMod.POST(fakeReq as any);
            console.log("[Webhook] ✓ Agent dispatch concluído pra", maskJid(remoteJid));
          } catch (e: any) {
            console.error("[Webhook] Erro ao disparar IA:", e?.message);
            await supabase.from("webhook_logs").insert({
              instance_name: instanceName,
              event: "AGENT_DISPATCH_FETCH_FAIL",
              payload: { error: String(e?.message || e), stack: String(e?.stack || "").slice(0, 500), via: "direct-call" },
              created_at: new Date().toISOString(),
            }).then(() => {}, () => {});
          }
        } else {
          console.log("⏸️ IA pausada para:", maskJid(remoteJid), "| status:", session.bot_status, "(mensagem foi salva, IA terá contexto ao voltar)");
          await supabase.from("webhook_logs").insert({
            instance_name: instanceName,
            event: "AGENT_SKIP_PAUSED",
            payload: { remoteJid, bot_status: session.bot_status, message_saved: true },
            created_at: new Date().toISOString()
          });
        }
      }

      return NextResponse.json({ success: true, event: "message_saved", message_id: finalId, sender });
      } finally {
        if (finalId) {
          (globalThis as any).__processedMessageIds.delete(finalId);
        }
      }
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
      
      const rawState = (data.state || data.status || "").toLowerCase();
      let state = "disconnected";
      if (rawState === "open" || rawState === "connected") state = "open";
      if (rawState === "connecting" || rawState === "pairing") state = "connecting";
      if (rawState === "close" || rawState === "disconnected") state = "close";

      if (instanceName && state) {
        await supabase
          .from("channel_connections")
          .update({ status: state })
          .eq("instance_name", instanceName);

        // QR escaneado → instância CONECTOU. Vincula automaticamente um
        // agente de IA (1º livre · senão outro · senão cria). Não bloqueia
        // a resposta do webhook — best-effort.
        if (state === "open") {
          try {
            const { autoLinkAgentOnConnect } = await import("@/lib/auto-link-agent");
            const r = await autoLinkAgentOnConnect(instanceName);
            console.log(`[CONNECTION_UPDATE] auto-link "${instanceName}":`, JSON.stringify(r));
          } catch (e) {
            console.warn("[CONNECTION_UPDATE] auto-link falhou:", (e as Error).message);
          }

          // Busca o owner da Evolution para sincronizar e migrar o histórico
          try {
            const status = await evolution.getStatus(instanceName).catch(() => null);
            const owner = status?.data?.owner || data.owner || data.jid;
            const phone = owner ? String(owner).replace(/\D/g, "") : null;
            if (phone) {
              const phoneInstanceName = `phone:${phone}`;
              console.log(`[CONNECTION_UPDATE] Instância "${instanceName}" ativa. Restaurando histórico do telefone ${phone}`);
              // Busca o client_id associado à conexão
              const { data: connData } = await supabase
                .from("channel_connections")
                .select("client_id")
                .eq("instance_name", instanceName)
                .maybeSingle();

              if (connData?.client_id) {
                // Sincroniza owner_phone no provider_config
                const { data: cur } = await supabase
                  .from("channel_connections")
                  .select("provider_config")
                  .eq("instance_name", instanceName)
                  .maybeSingle();
                const merged = { ...(cur?.provider_config || {}), owner_phone: phone, owner_jid: owner };
                await supabase
                  .from("channel_connections")
                  .update({ provider_config: merged })
                  .eq("instance_name", instanceName);

                // Migra conversas, sessões e mensagens de volta
                await Promise.all([
                  supabase.from("chats_dashboard").update({ instance_name: instanceName }).eq("instance_name", phoneInstanceName).eq("client_id", connData.client_id),
                  supabase.from("sessions").update({ instance_name: instanceName }).eq("instance_name", phoneInstanceName).eq("client_id", connData.client_id),
                  supabase.from("messages").update({ instance_name: instanceName }).eq("instance_name", phoneInstanceName).eq("client_id", connData.client_id),
                ]);
              }
            }
          } catch (err: any) {
            console.warn("[CONNECTION_UPDATE] Falha na migração automática de histórico:", err.message);
          }
        }
      }

      return NextResponse.json({ success: true, event: "connection_update", state });
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

// GET para debug — admin-only (payloads contêm PII)
export async function GET(req: NextRequest) {
  const { requireClientId } = await import("@/lib/tenant");
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!auth.isAdmin) return NextResponse.json({ success: false, error: "Apenas admin" }, { status: 403 });
  const { data } = await supabase
    .from("webhook_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  return NextResponse.json({ success: true, logs: data || [] });
}
