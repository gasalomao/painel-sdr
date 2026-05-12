/**
 * Channel router — unifica envio entre Evolution API (Baileys) e WhatsApp Cloud API (oficial Meta).
 *
 * Como decide:
 *  - Lê `channel_connections` por instance_name.
 *  - provider === "whatsapp_cloud"  → usa lib/whatsapp-cloud.ts com config em provider_config (JSONB).
 *  - caso contrário                 → usa lib/evolution.ts (default histórico).
 *
 * O resto do sistema (agent/process, send-message, follow-up, disparo) chama estes helpers
 * sem se importar com o provider. A chave estável é "instanceName".
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { whatsappCloud, type WhatsAppCloudConfig } from "@/lib/whatsapp-cloud";

export type ResolvedChannel = {
  instance_name: string;
  provider: "evolution" | "whatsapp_cloud" | string;
  agent_id?: number | null;
  status?: string | null;
  cloud?: WhatsAppCloudConfig | null;
};

const channelCache = new Map<string, { value: ResolvedChannel; ts: number }>();
const CACHE_TTL_MS = 30_000;

export async function resolveChannel(instanceName: string, opts: { fresh?: boolean } = {}): Promise<ResolvedChannel> {
  if (!opts.fresh) {
    const cached = channelCache.get(instanceName);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;
  }

  const { data } = await supabase
    .from("channel_connections")
    .select("instance_name, provider, agent_id, status, provider_config")
    .eq("instance_name", instanceName)
    .maybeSingle();

  const provider = (data?.provider || "evolution") as ResolvedChannel["provider"];
  let cloud: WhatsAppCloudConfig | null = null;

  if (provider === "whatsapp_cloud") {
    const cfg = data?.provider_config || {};
    cloud = {
      phone_number_id:     cfg.phone_number_id,
      access_token:        cfg.access_token,
      business_account_id: cfg.business_account_id,
      verify_token:        cfg.verify_token,
      app_secret:          cfg.app_secret,
      graph_version:       cfg.graph_version,
    };
  }

  const value: ResolvedChannel = {
    instance_name: instanceName,
    provider,
    agent_id: data?.agent_id ?? null,
    status: data?.status ?? null,
    cloud,
  };
  channelCache.set(instanceName, { value, ts: Date.now() });
  return value;
}

export function invalidateChannelCache(instanceName?: string) {
  if (instanceName) channelCache.delete(instanceName);
  else channelCache.clear();
}

/** Resolve qual instance_name deve responder a um phone_number_id da Cloud API (vinda do webhook). */
export async function resolveInstanceFromPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const { data } = await supabase
    .from("channel_connections")
    .select("instance_name, provider_config")
    .eq("provider", "whatsapp_cloud")
    .eq("provider_config->>phone_number_id", phoneNumberId)
    .maybeSingle();
  return data?.instance_name || null;
}

function ensureCloudConfig(ch: ResolvedChannel): WhatsAppCloudConfig {
  if (ch.provider !== "whatsapp_cloud" || !ch.cloud?.phone_number_id || !ch.cloud?.access_token) {
    throw new Error(
      `Conexão "${ch.instance_name}" está marcada como WhatsApp Cloud mas não tem phone_number_id/access_token configurado.`
    );
  }
  return ch.cloud;
}

/* ============================================================
   API pública: send / sendMedia / setTyping / checkNumbers
   Mesma assinatura nos dois providers.
============================================================ */

export async function sendMessage(remoteJid: string, text: string, instanceName: string) {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    const cfg = ensureCloudConfig(ch);
    return whatsappCloud.sendText(cfg, remoteJid, text);
  }
  return evolution.sendMessage(remoteJid, text, instanceName);
}

export async function sendMedia(
  remoteJid: string,
  caption: string,
  mediaData: { type: "image" | "audio" | "video" | "document"; base64: string; fileName?: string; mimetype?: string },
  instanceName: string
) {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    const cfg = ensureCloudConfig(ch);
    return whatsappCloud.sendMedia(cfg, remoteJid, {
      type: mediaData.type === "audio" ? "audio" : (mediaData.type as any),
      base64: mediaData.base64,
      fileName: mediaData.fileName,
      mimetype: mediaData.mimetype,
      caption,
    });
  }
  return evolution.sendMedia(remoteJid, caption, mediaData as any, instanceName);
}

export async function checkWhatsAppNumbers(numbers: string[], instanceName: string): Promise<Record<string, boolean>> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    // Cloud API não tem endpoint de "esse número existe?" — só descobrimos no envio.
    // Retornamos todos como "presumed true" pra não bloquear o disparo.
    const map: Record<string, boolean> = {};
    for (const n of numbers) map[n.replace(/\D/g, "")] = true;
    return map;
  }
  return evolution.checkWhatsAppNumbers(numbers, instanceName);
}

export function extractPhone(jid: string): string {
  return evolution.extractPhone(jid);
}

/**
 * Busca a foto de perfil de um número.
 *
 * - Evolution (Baileys/WPPConnect): consegue (via /chat/fetchProfilePictureUrl).
 * - WhatsApp Cloud API oficial: NÃO CONSEGUE — Meta restringe por privacidade.
 *   A Cloud API só expõe a foto da PRÓPRIA empresa (via /whatsapp_business_profile),
 *   nunca de clientes. Documentação:
 *   https://developers.facebook.com/community/threads/whatsapp-cloud-api-get-customer-profile-picture/
 *   Retornamos null e a UI cai no avatar de iniciais.
 *
 * Mesma assinatura entre providers — quem chama não precisa saber qual está ativo.
 */
export async function fetchProfilePicture(remoteJid: string, instanceName: string): Promise<string | null> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    return null;  // Cloud API não expõe foto de clientes (limitação da Meta)
  }
  return evolution.fetchProfilePicture(remoteJid, instanceName);
}
