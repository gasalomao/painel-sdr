/**
 * Channel router — unifica envio entre Evolution API v2 (Node.js/Baileys),
 * Evolution API GO (Go/whatsmeow) e WhatsApp Cloud API (oficial Meta).
 *
 * Como decide:
 *  - Lê `channel_connections` por instance_name.
 *  - provider === "whatsapp_cloud"  → usa lib/whatsapp-cloud.ts com config em provider_config (JSONB).
 *  - provider === "evolution_go"    → tenta lib/providers/evolution-go.ts com fallback para evolution-v2.ts.
 *  - provider === "evolution" (def) → usa lib/providers/evolution-v2.ts com fallback para evolution-go.ts.
 *
 * O resto do sistema (agent/process, send-message, follow-up, disparo, workers) chama estes helpers
 * sem se importar com o provider. A chave estável é "instanceName".
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { whatsappCloud, type WhatsAppCloudConfig } from "@/lib/whatsapp-cloud";
import { evolutionGo } from "@/lib/providers/evolution-go";
import { evolutionV2 } from "@/lib/providers/evolution-v2";
import type { WhatsAppProvider, SendResult, MediaData, ConnectionStatus, QRCodeResult } from "@/lib/providers/types";

export type ResolvedChannel = {
  instance_name: string;
  provider: "evolution_go" | "whatsapp_cloud" | "evolution" | string;
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

/** Helper para obter os provedores primário e secundário (fallback) para a instância. */
export async function getProvider(instanceName: string): Promise<{ primary: WhatsAppProvider; fallback?: WhatsAppProvider }> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "evolution_go") {
    return { primary: evolutionGo, fallback: evolutionV2 };
  }
  return { primary: evolutionV2, fallback: evolutionGo };
}

/* ============================================================
   API pública unificada: sendMessage / sendMedia / getStatus / checkNumbers
============================================================ */

export async function sendMessage(remoteJid: string, text: string, instanceName: string): Promise<SendResult> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    const cfg = ensureCloudConfig(ch);
    return whatsappCloud.sendText(cfg, remoteJid, text);
  }

  const { primary, fallback } = await getProvider(instanceName);
  const res = await primary.sendText(remoteJid, text, instanceName);
  if (res.ok) return res;

  if (fallback) {
    const fallbackRes = await fallback.sendText(remoteJid, text, instanceName);
    if (fallbackRes.ok) return fallbackRes;
  }

  return res;
}

export async function sendMedia(
  remoteJid: string,
  caption: string,
  mediaData: MediaData,
  instanceName: string
): Promise<SendResult> {
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

  const { primary, fallback } = await getProvider(instanceName);
  const res = await primary.sendMedia(remoteJid, caption, mediaData, instanceName);
  if (res.ok) return res;

  if (fallback) {
    const fallbackRes = await fallback.sendMedia(remoteJid, caption, mediaData, instanceName);
    if (fallbackRes.ok) return fallbackRes;
  }

  return res;
}

export async function checkWhatsAppNumbers(numbers: string[], instanceName: string): Promise<Record<string, boolean>> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    const map: Record<string, boolean> = {};
    for (const n of numbers) map[n.replace(/\D/g, "")] = true;
    return map;
  }

  const { primary, fallback } = await getProvider(instanceName);
  const map = await primary.checkNumbers(numbers, instanceName);
  if (Object.keys(map).length > 0) return map;
  if (fallback) {
    const fallMap = await fallback.checkNumbers(numbers, instanceName);
    if (Object.keys(fallMap).length > 0) return fallMap;
  }
  return map;
}

export async function checkNumbersDetailed(
  numbers: string[],
  instanceName: string
): Promise<Record<string, { exists: boolean; jid: string | null }>> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    const map: Record<string, { exists: boolean; jid: string | null }> = {};
    for (const n of numbers) {
      const d = n.replace(/\D/g, "");
      if (d) map[d] = { exists: true, jid: `${d}@s.whatsapp.net` };
    }
    return map;
  }

  const { primary, fallback } = await getProvider(instanceName);
  const map = await primary.checkNumbersDetailed(numbers, instanceName);
  if (Object.keys(map).length > 0) return map;
  if (fallback) {
    return fallback.checkNumbersDetailed(numbers, instanceName);
  }
  return map;
}

export const checkWhatsAppNumbersDetailed = checkNumbersDetailed;

export function extractPhone(jid: string): string {
  if (!jid) return "";
  const match = jid.match(/(\d+)/);
  return match ? match[1] : "";
}

export async function getStatus(instanceName: string): Promise<ConnectionStatus> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    return { state: "open" as const, data: null };
  }

  const { primary, fallback } = await getProvider(instanceName);
  const res = await primary.getStatus(instanceName);
  if (res.state !== "unknown" && res.state !== "not_found") return res;
  if (fallback) {
    const fallRes = await fallback.getStatus(instanceName);
    if (fallRes.state !== "unknown" && fallRes.state !== "not_found") return fallRes;
  }
  return res;
}

export async function fetchProfilePicture(remoteJid: string, instanceName: string): Promise<string | null> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    return null;
  }

  const { primary, fallback } = await getProvider(instanceName);
  const pic = await primary.fetchProfilePicture(remoteJid, instanceName);
  if (pic) return pic;
  if (fallback) {
    return fallback.fetchProfilePicture(remoteJid, instanceName);
  }
  return null;
}
