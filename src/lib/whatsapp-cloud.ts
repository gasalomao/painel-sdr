/**
 * WhatsApp Cloud API (Meta) — API oficial.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/
 *
 * Diferenças importantes vs Evolution/Baileys:
 *  - Cada conexão é um "Phone Number" identificado por phone_number_id (numérico).
 *  - O token é um Bearer (System User Token ou Access Token de App), não API key simples.
 *  - O número do destinatário vai SEM @s.whatsapp.net e SEM +; só dígitos com DDI.
 *  - Receber mensagens é via webhook único por App, com verify token (challenge GET).
 *  - Mensagens "freeform" só podem ser enviadas se o cliente mandou algo nas últimas 24h.
 *    Fora dessa janela, é OBRIGATÓRIO usar template message aprovado.
 *  - Mídia: você sobe via /media e usa o id retornado, ou manda link público.
 */

import axios from "axios";

const GRAPH_BASE = "https://graph.facebook.com";
const DEFAULT_VERSION = "v21.0";

export type WhatsAppCloudConfig = {
  phone_number_id: string;
  access_token: string;
  business_account_id?: string;
  verify_token?: string;
  app_secret?: string;
  graph_version?: string;
};

function api(version: string | undefined): string {
  return `${GRAPH_BASE}/${version || DEFAULT_VERSION}`;
}

function cleanNumber(n: string): string {
  // Cloud API quer só dígitos com DDI. Remove @s.whatsapp.net, +, espaços, tracinho.
  return (n || "").replace(/@.*$/, "").replace(/\D/g, "");
}

/** Erro consolidado do Graph API (Meta gosta de aninhar a mensagem) */
function graphError(err: any, ctx: string): Error {
  const data = err?.response?.data;
  const apiErr = data?.error;
  const msg = apiErr
    ? `${apiErr.code || ""} ${apiErr.type || ""} — ${apiErr.message || ""}${apiErr.error_user_msg ? ` (${apiErr.error_user_msg})` : ""}`
    : (err?.message || "Erro desconhecido");
  return new Error(`[WhatsApp Cloud · ${ctx}] ${msg}`);
}

export const whatsappCloud = {
  /** Envia mensagem de texto livre (apenas dentro da janela de 24h). */
  async sendText(cfg: WhatsAppCloudConfig, to: string, text: string) {
    const url = `${api(cfg.graph_version)}/${cfg.phone_number_id}/messages`;
    try {
      const res = await axios.post(
        url,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: cleanNumber(to),
          type: "text",
          text: { preview_url: true, body: text },
        },
        { headers: { Authorization: `Bearer ${cfg.access_token}` }, timeout: 30000 }
      );
      // Resposta: { messages: [{ id: 'wamid....' }], contacts: [...] }
      const wamid = res.data?.messages?.[0]?.id;
      return { ok: true, wamid, raw: res.data, key: { id: wamid } };
    } catch (err: any) {
      throw graphError(err, "sendText");
    }
  },

  /**
   * Envia template (HSM) — único caminho legítimo para abrir conversa
   * fora da janela de 24h. O template precisa estar aprovado no WABA.
   */
  async sendTemplate(
    cfg: WhatsAppCloudConfig,
    to: string,
    templateName: string,
    languageCode: string = "pt_BR",
    components: any[] = []
  ) {
    const url = `${api(cfg.graph_version)}/${cfg.phone_number_id}/messages`;
    try {
      const res = await axios.post(
        url,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: cleanNumber(to),
          type: "template",
          template: {
            name: templateName,
            language: { code: languageCode },
            ...(components.length > 0 ? { components } : {}),
          },
        },
        { headers: { Authorization: `Bearer ${cfg.access_token}` }, timeout: 30000 }
      );
      const wamid = res.data?.messages?.[0]?.id;
      return { ok: true, wamid, raw: res.data, key: { id: wamid } };
    } catch (err: any) {
      throw graphError(err, "sendTemplate");
    }
  },

  /**
   * Envia mídia. Aceita base64 (faz upload primeiro) OU link público (mais rápido).
   * Para áudio do tipo "voz" do WhatsApp (PTT), use mimetype "audio/ogg" — o Meta
   * renderiza como nota de voz se for ogg/opus.
   */
  async sendMedia(
    cfg: WhatsAppCloudConfig,
    to: string,
    media: {
      type: "image" | "audio" | "video" | "document" | "sticker";
      base64?: string;
      link?: string;
      fileName?: string;
      mimetype?: string;
      caption?: string;
    }
  ) {
    let mediaId: string | undefined;
    let mediaLink: string | undefined = media.link;

    if (!mediaLink && media.base64) {
      mediaId = await this.uploadMedia(cfg, media.base64, media.mimetype || "application/octet-stream", media.fileName);
    }

    const url = `${api(cfg.graph_version)}/${cfg.phone_number_id}/messages`;
    const body: any = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: cleanNumber(to),
      type: media.type,
    };
    const obj: any = mediaId ? { id: mediaId } : { link: mediaLink };
    if (media.caption && (media.type === "image" || media.type === "video" || media.type === "document")) {
      obj.caption = media.caption;
    }
    if (media.type === "document" && media.fileName) obj.filename = media.fileName;
    body[media.type] = obj;

    try {
      const res = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${cfg.access_token}` },
        timeout: 60000,
      });
      const wamid = res.data?.messages?.[0]?.id;
      return { ok: true, wamid, raw: res.data, key: { id: wamid } };
    } catch (err: any) {
      throw graphError(err, "sendMedia");
    }
  },

  /** Faz upload de mídia binária pra obter um media_id reutilizável. */
  async uploadMedia(cfg: WhatsAppCloudConfig, base64: string, mimetype: string, fileName?: string): Promise<string> {
    const url = `${api(cfg.graph_version)}/${cfg.phone_number_id}/media`;
    const clean = base64.replace(/^data:.*?;base64,/, "");
    const buffer = Buffer.from(clean, "base64");

    const form = new FormData();
    const blob = new Blob([buffer], { type: mimetype });
    form.append("file", blob, fileName || `upload.${mimetype.split("/")[1] || "bin"}`);
    form.append("type", mimetype);
    form.append("messaging_product", "whatsapp");

    try {
      const res = await axios.post(url, form, {
        headers: { Authorization: `Bearer ${cfg.access_token}` },
        timeout: 60000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      if (!res.data?.id) throw new Error("Upload sem id retornado");
      return res.data.id;
    } catch (err: any) {
      throw graphError(err, "uploadMedia");
    }
  },

  /**
   * Baixa uma mídia recebida (webhook entrega só o media_id).
   * Retorna base64 + mimetype pra você processar/transcrever.
   */
  async fetchMedia(cfg: WhatsAppCloudConfig, mediaId: string): Promise<{ base64: string; mimetype: string }> {
    try {
      // 1) Pegar URL temporária autenticada
      const meta = await axios.get(`${api(cfg.graph_version)}/${mediaId}`, {
        headers: { Authorization: `Bearer ${cfg.access_token}` },
        timeout: 20000,
      });
      const fileUrl = meta.data?.url;
      const mimetype = meta.data?.mime_type || "application/octet-stream";
      if (!fileUrl) throw new Error("URL da mídia não retornada");

      // 2) Baixar binário (precisa do mesmo Bearer)
      const bin = await axios.get(fileUrl, {
        headers: { Authorization: `Bearer ${cfg.access_token}` },
        responseType: "arraybuffer",
        timeout: 60000,
      });
      const base64 = Buffer.from(bin.data).toString("base64");
      return { base64, mimetype };
    } catch (err: any) {
      throw graphError(err, "fetchMedia");
    }
  },

  /** Marca uma mensagem recebida como lida (visto azul). */
  async markRead(cfg: WhatsAppCloudConfig, messageId: string) {
    const url = `${api(cfg.graph_version)}/${cfg.phone_number_id}/messages`;
    try {
      await axios.post(
        url,
        { messaging_product: "whatsapp", status: "read", message_id: messageId },
        { headers: { Authorization: `Bearer ${cfg.access_token}` }, timeout: 10000 }
      );
    } catch (err: any) {
      // Não-fatal — só loga
      console.warn("[WhatsApp Cloud · markRead] falha:", err?.response?.data || err?.message);
    }
  },

  /** Sanity check: confere se phone_number_id + token batem com o WABA. */
  async getPhoneInfo(cfg: WhatsAppCloudConfig) {
    const url = `${api(cfg.graph_version)}/${cfg.phone_number_id}`;
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${cfg.access_token}` },
        params: { fields: "display_phone_number,verified_name,quality_rating,messaging_limit_tier" },
        timeout: 15000,
      });
      return res.data;
    } catch (err: any) {
      throw graphError(err, "getPhoneInfo");
    }
  },

  /** Helpers de parsing de webhook */
  parseIncoming(body: any): {
    messages: Array<{
      from: string;             // número do cliente, só dígitos
      remoteJid: string;        // formatado pra "<numero>@s.whatsapp.net" pra unificar com Evolution
      messageId: string;
      timestamp: number;
      type: string;
      text?: string;
      mediaId?: string;
      mimetype?: string;
      fileName?: string;
      caption?: string;
      pushName?: string;
      phoneNumberId: string;    // identifica QUAL conexão Cloud recebeu (instance routing)
    }>;
    statuses: Array<{
      messageId: string;
      status: string;           // sent | delivered | read | failed
      timestamp: number;
      phoneNumberId: string;
      recipientId?: string;
    }>;
  } {
    const out = { messages: [] as any[], statuses: [] as any[] };
    const entries = body?.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "messages") continue;
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        const contactsByWa: Record<string, string> = {};
        for (const c of value.contacts || []) {
          if (c.wa_id) contactsByWa[c.wa_id] = c.profile?.name || "";
        }

        for (const m of value.messages || []) {
          const from = String(m.from || "").replace(/\D/g, "");
          const base: any = {
            from,
            remoteJid: `${from}@s.whatsapp.net`,
            messageId: m.id,
            timestamp: Number(m.timestamp) || Date.now() / 1000,
            type: m.type,
            pushName: contactsByWa[m.from] || undefined,
            phoneNumberId,
          };
          if (m.type === "text") {
            base.text = m.text?.body || "";
          } else if (m.type === "image" || m.type === "video" || m.type === "audio" || m.type === "document" || m.type === "sticker") {
            const mm = m[m.type] || {};
            base.mediaId = mm.id;
            base.mimetype = mm.mime_type;
            base.fileName = mm.filename;
            base.caption = mm.caption;
          } else if (m.type === "button") {
            base.text = m.button?.text || "";
          } else if (m.type === "interactive") {
            base.text = m.interactive?.button_reply?.title
              || m.interactive?.list_reply?.title
              || "";
          } else if (m.type === "location") {
            const loc = m.location || {};
            base.text = `[📍 ${loc.latitude},${loc.longitude}]${loc.name ? ` ${loc.name}` : ""}`;
          }
          out.messages.push(base);
        }

        for (const s of value.statuses || []) {
          out.statuses.push({
            messageId: s.id,
            status: s.status,
            timestamp: Number(s.timestamp) || Date.now() / 1000,
            phoneNumberId,
            recipientId: s.recipient_id,
          });
        }
      }
    }
    return out;
  },
};

export default whatsappCloud;
