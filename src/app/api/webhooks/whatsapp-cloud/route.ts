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
import { resolveChannel, resolveInstanceFromPhoneNumberId } from "@/lib/channel";
import { getEffectiveStatus } from "@/lib/bot-status";
import { isManualSend } from "@/lib/manual-send-registry";
import { createHmac, timingSafeEqual } from "node:crypto";

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
async function verifyMetaSignature(
  signatureHeader: string | null,
  rawBody: string,
  phoneNumberIds: string[],
): Promise<"valid" | "missing" | "no_header" | "invalid"> {
  // Coleta app_secrets candidatos (env + provider_config das conexões mencionadas no evento)
  const secrets: string[] = [];
  if (ENV_APP_SECRET) secrets.push(ENV_APP_SECRET);
  if (phoneNumberIds.length > 0) {
    const { data } = await supabase
      .from("channel_connections")
      .select("provider_config")
      .eq("provider", "whatsapp_cloud")
      .in("provider_config->>phone_number_id", phoneNumberIds);
    for (const row of data || []) {
      const s = (row as any)?.provider_config?.app_secret;
      if (s && typeof s === "string") secrets.push(s);
    }
  }
  if (secrets.length === 0) return "missing";
  if (!signatureHeader) return "no_header";
  const m = /^sha256=([0-9a-f]+)$/i.exec(signatureHeader.trim());
  if (!m) return "invalid";
  const recv = Buffer.from(m[1], "hex");
  if (recv.length !== 32) return "invalid";
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    if (expected.length === recv.length && timingSafeEqual(expected, recv)) return "valid";
  }
  return "invalid";
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
  if (sigResult === "invalid") {
    await supabase.from("webhook_logs").insert({
      instance_name: "whatsapp_cloud",
      event: "CLOUD_SIGNATURE_INVALID",
      payload: { phone_ids: phoneIds, has_header: !!sigHeader },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return NextResponse.json({ success: false, error: "Assinatura inválida" }, { status: 401 });
  }
  if (sigResult !== "valid" && process.env.NODE_ENV !== "production") {
    console.warn(`[Cloud Webhook] HMAC ${sigResult} — aceito em dev. Configure app_secret + X-Hub-Signature-256 pra prod.`);
  } else if (sigResult === "no_header" && process.env.NODE_ENV === "production") {
    // App_secret configurado mas Meta não mandou header → bloqueia
    await supabase.from("webhook_logs").insert({
      instance_name: "whatsapp_cloud",
      event: "CLOUD_SIGNATURE_MISSING_HEADER",
      payload: { phone_ids: phoneIds },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return NextResponse.json({ success: false, error: "Header de assinatura ausente" }, { status: 401 });
  }
  // sigResult === "missing" em prod = sem app_secret cadastrado → loga warning mas aceita (rollout).

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
    const map: Record<string, string> = {
      sent: "sent", delivered: "delivered", read: "read", failed: "error",
    };
    const norm = map[s.status] || s.status;
    await supabase.from("messages").update({ delivery_status: norm }).eq("message_id", s.messageId);
    await supabase.from("chats_dashboard").update({ status_envio: norm }).eq("message_id", s.messageId);
  }

  // ====== INCOMING MESSAGES ======
  for (const m of parsed.messages) {
    try {
      const instanceName = await resolveInstanceFromPhoneNumberId(m.phoneNumberId);
      if (!instanceName) {
        console.warn(`[Cloud Webhook] Mensagem para phone_number_id=${m.phoneNumberId} sem conexão cadastrada — ignorada.`);
        await supabase.from("webhook_logs").insert({
          instance_name: "whatsapp_cloud",
          event: "CLOUD_NO_INSTANCE",
          payload: { phone_number_id: m.phoneNumberId, message_id: m.messageId },
          created_at: new Date().toISOString(),
        }).then(() => {}, () => {});
        continue;
      }

      // Anti-duplicação: se já temos a msg, pula
      const [{ data: dupV2 }, { data: dupLegacy }] = await Promise.all([
        supabase.from("messages").select("id").eq("message_id", m.messageId).maybeSingle(),
        supabase.from("chats_dashboard").select("id").eq("message_id", m.messageId).maybeSingle(),
      ]);
      if (dupV2 || dupLegacy) continue;

      // Find/create contact + session
      let contactId: string | null = null;
      let sessionRow: any = null;
      try {
        const { data: existing } = await supabase
          .from("contacts").select("id, push_name").eq("remote_jid", m.remoteJid).maybeSingle();
        if (existing) {
          contactId = existing.id;
          if (m.pushName && existing.push_name !== m.pushName) {
            await supabase.from("contacts").update({ push_name: m.pushName }).eq("id", contactId);
          }
        } else {
          const ins = await supabase.from("contacts").insert({
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
            .eq("contact_id", contactId).eq("instance_name", instanceName).maybeSingle();
          if (existSess) {
            sessionRow = existSess;
          } else {
            const ch = await resolveChannel(instanceName);
            const ns = await supabase.from("sessions").insert({
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

      // Sender (Cloud webhook não dispara fromMe automaticamente — apenas mensagens recebidas)
      // Se for echo de envio nosso (alguns Apps mandam), tratamos via isManualSend.
      const fromMe = false; // Cloud só entrega messages do usuário; status de envio vai no campo statuses
      const sender: "customer" | "ai" | "human" = fromMe
        ? (isManualSend(m.messageId) ? "human" : (sessionRow?.bot_status === "bot_active" ? "ai" : "human"))
        : "customer";

      // Conteúdo: text direto, ou caption, ou placeholder de mídia
      let content: string = m.text || m.caption || "";
      let enrichedLater = false;

      if (!content && m.mediaId) {
        const placeholders: Record<string, string> = {
          image: "[📷 Imagem]",
          audio: "[🎤 Áudio — transcrevendo...]",
          video: "[🎥 Vídeo]",
          document: m.fileName ? `[📄 ${m.fileName}]` : "[📄 Documento]",
          sticker: "[Sticker]",
        };
        content = placeholders[m.type] || "[Mídia]";
        enrichedLater = true;
      }

      // Insert chats_dashboard (UI lê isso)
      await supabase.from("chats_dashboard").insert({
        instance_name: instanceName,
        message_id: m.messageId,
        remote_jid: m.remoteJid,
        sender_type: sender,
        content,
        status_envio: "received",
        created_at: new Date(m.timestamp * 1000).toISOString(),
      }).then(({ error }) => {
        if (error && error.code !== "23505") console.warn("[Cloud Webhook] dash insert:", error.message);
      });

      // Insert messages (V2)
      if (sessionRow?.id) {
        await supabase.from("messages").insert({
          session_id: sessionRow.id,
          message_id: m.messageId,
          sender,
          content: m.text || null,
          media_category: m.type === "text" ? "text" : m.type,
          mimetype: m.mimetype || null,
          file_name: m.fileName || null,
          delivery_status: "pending",
          created_at: new Date(m.timestamp * 1000).toISOString(),
        }).then(({ error }) => {
          if (error && error.code !== "23505") console.warn("[Cloud Webhook] messages insert:", error.message);
        });

        // Update session
        const updPayload: any = { last_message_at: new Date().toISOString() };
        updPayload.unread_count = (sessionRow.unread_count || 0) + 1;
        supabase.from("sessions").update(updPayload).eq("id", sessionRow.id).then(() => {}, () => {});
      }

      // Pipeline de mídia em background (download Cloud + upload Storage + transcrição/descrição + retrigger agente)
      if (enrichedLater && m.mediaId) {
        (async () => {
          try {
            const ch = await resolveChannel(instanceName);
            if (!ch.cloud) return;
            const { base64, mimetype } = await whatsappCloud.fetchMedia(ch.cloud, m.mediaId!);

            // Upload pro Storage (mesmo bucket do Evolution)
            let mediaUrl: string | null = null;
            try {
              const bucketName = "whatsapp_media";
              const buffer = Buffer.from(base64, "base64");
              const ext = (mimetype.split("/")[1] || "bin").split(";")[0];
              const path = `${m.remoteJid}/${Date.now()}.${ext}`;
              const { error: upErr } = await supabase.storage
                .from(bucketName).upload(path, buffer, { contentType: mimetype, upsert: true });
              if (!upErr) mediaUrl = supabase.storage.from(bucketName).getPublicUrl(path).data.publicUrl;
            } catch (upErr: any) {
              console.warn("[Cloud Media] upload falhou:", upErr?.message);
            }

            // Enriquecer texto se for áudio/imagem (reaproveita Gemini do webhook Evolution)
            let enriched: string | null = null;
            if (m.type === "audio") {
              try {
                const { GoogleGenerativeAI } = await import("@google/generative-ai");
                const { data: cfg } = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
                if (cfg?.api_key) {
                  const genAI = new GoogleGenerativeAI(cfg.api_key);
                  // Tenta primeiro o modelo escolhido pelo admin, depois fallbacks históricos
                  // (lista local — última camada se a config global vier vazia).
                  const { getDefaultModel } = await import("@/lib/ai-default-model");
                  const adminModel = await getDefaultModel();
                  const candidates = Array.from(new Set([
                    adminModel,
                    "gemini-2.5-flash",
                    "gemini-2.0-flash",
                    "gemini-1.5-flash",
                  ].filter(Boolean) as string[]));
                  for (const model of candidates) {
                    try {
                      const mdl = genAI.getGenerativeModel({ model });
                      const res = await mdl.generateContent([
                        { inlineData: { data: base64, mimeType: (mimetype || "audio/ogg").split(";")[0] } },
                        { text: "Transcreva esse áudio em PT-BR. Devolva APENAS o texto transcrito." },
                      ]);
                      const t = res.response.text().trim();
                      // Token tracking — antes esse bloco do canal Cloud era o
                      // "primo pobre" do whatsapp/route.ts e NÃO logava nada,
                      // deixando o gasto de transcrição invisível pro tenant.
                      try {
                        const { extractGeminiUsage, logTokenUsage } = await import("@/lib/token-usage");
                        const usage = extractGeminiUsage(res);
                        const clientId = await (async () => {
                          const { data } = await supabase
                            .from("channel_connections")
                            .select("client_id")
                            .eq("instance_name", instanceName)
                            .maybeSingle();
                          return data?.client_id || null;
                        })();
                        await logTokenUsage({
                          source: "other",
                          sourceLabel: "Transcrição áudio (Cloud)",
                          model,
                          promptTokens: usage.promptTokens,
                          completionTokens: usage.completionTokens,
                          totalTokens: usage.totalTokens,
                          clientId,
                          metadata: { kind: "audio_transcription_cloud", mimetype, instanceName, remoteJid: m.remoteJid },
                        });
                      } catch (logErr) {
                        console.warn("[Cloud Media] token log falhou:", (logErr as Error).message);
                      }
                      if (t) { enriched = `🎤 ${t}`; break; }
                    } catch { /* tenta próximo modelo */ }
                  }
                }
              } catch { /* ignore */ }
              if (!enriched) enriched = "[🎤 O cliente enviou um áudio que não consegui transcrever]";
            }

            // Atualiza linhas
            const upd: Record<string, any> = {};
            if (mediaUrl) upd.media_url = mediaUrl;
            if (mimetype) upd.mimetype = mimetype;
            if (enriched) upd.content = enriched;
            const updDash: Record<string, any> = { ...upd };
            if (m.type !== "text") updDash.media_type = m.type;

            if (Object.keys(updDash).length > 0) {
              const { error } = await supabase.from("chats_dashboard").update(updDash).eq("message_id", m.messageId);
              if (error?.code === "PGRST204" && enriched) {
                await supabase.from("chats_dashboard").update({ content: enriched }).eq("message_id", m.messageId);
              }
            }
            if (Object.keys(upd).length > 0) {
              await supabase.from("messages").update(upd).eq("message_id", m.messageId);
            }

            // Re-dispara agente com texto enriquecido (mesma lógica do Evolution)
            if (enriched && sessionRow?.id) {
              const eff = await getEffectiveStatus(sessionRow as any);
              if (eff.isActive) {
                fetch(`${INTERNAL_BASE}/api/agent/process`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ instanceName, remoteJid: m.remoteJid, text: enriched, sessionId: sessionRow.id }),
                }).catch(() => {});
              }
            }
          } catch (mErr: any) {
            console.warn("[Cloud Media] pipeline falhou:", mErr?.message);
          }
        })();
      }

      // Dispara agente com texto direto (igual webhook Evolution)
      if (content && (m.text || m.caption) && sessionRow?.id) {
        const eff = await getEffectiveStatus(sessionRow as any);
        if (eff.isActive) {
          fetch(`${INTERNAL_BASE}/api/agent/process`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instanceName, remoteJid: m.remoteJid, text: m.text || m.caption || "", sessionId: sessionRow.id }),
          }).catch(() => {});
        } else {
          await supabase.from("webhook_logs").insert({
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
