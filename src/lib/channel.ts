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

/**
 * Baixa uma URL pública (Supabase Storage, etc) e devolve como base64.
 *
 * POR QUE EXISTE: o Evolution GO exige SEMPRE base64 no payload (não suporta
 * URL direta). O Evolution V2 aceita URL, mas se a URL tiver redirect, auth
 * privada, ou se a Evolution não conseguir baixar (CORS/timeout), ela envia
 * o LINK da imagem como texto em vez da imagem em si — é o bug que o usuário
 * reportou ("envia o link da imagem, não a imagem").
 *
 * Solução robusta: baixamos server-side e SEMPRE enviamos base64 pro provider.
 * Nunca mais o cliente recebe link no lugar da imagem.
 *
 * Cache simples em memória (LRU de 50 itens) pra não baixar a mesma foto
 * de produto 100x por dia (produtos do catálogo são re-enviados a cada pergunta).
 */
const mediaBase64Cache = new Map<string, { base64: string; mimetype: string; ts: number }>();
const MEDIA_CACHE_TTL_MS = 6 * 3600 * 1000; // 6h — produtos mudam raramente
const MEDIA_CACHE_MAX = 50;

async function fetchUrlAsBase64(url: string): Promise<{ base64: string; mimetype: string } | null> {
  if (!url || !/^https?:\/\//.test(url)) return null;

  // Cache hit?
  const cached = mediaBase64Cache.get(url);
  if (cached && Date.now() - cached.ts < MEDIA_CACHE_TTL_MS) {
    return { base64: cached.base64, mimetype: cached.mimetype };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "painel-sdr-media/1.0" },
    });
    if (!res.ok) {
      console.warn(`[channel] fetchUrlAsBase64 falhou pra ${url}: HTTP ${res.status}`);
      return null;
    }
    const mimetype = res.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    // Limite 15MB — Evolution/WhatsApp rejeitam anexos maiores.
    if (buf.length > 15 * 1024 * 1024) {
      console.warn(`[channel] Mídia ${url} tem ${buf.length}B (>15MB) — pode ser rejeitada.`);
    }
    const base64 = buf.toString("base64");

    // Cache (LRU simples — quando encher, remove o mais antigo).
    if (mediaBase64Cache.size >= MEDIA_CACHE_MAX) {
      const oldest = Array.from(mediaBase64Cache.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) mediaBase64Cache.delete(oldest[0]);
    }
    mediaBase64Cache.set(url, { base64, mimetype, ts: Date.now() });

    return { base64, mimetype };
  } catch (err: any) {
    console.warn(`[channel] fetchUrlAsBase64 erro pra ${url}:`, err?.message);
    return null;
  }
}

/**
 * Garante que mediaData tenha base64. Se só vier URL, baixa e converte.
 * Retorna uma NOVA MediaData completa (não muta a original).
 */
async function ensureBase64(media: MediaData): Promise<MediaData> {
  // Já tem base64 direto → segue.
  if (media.base64 && media.base64.length > 100) {
    return media;
  }

  const url = media.mediaUrl || media.url;
  if (!url) return media;

  const fetched = await fetchUrlAsBase64(url);
  if (!fetched) {
    // Não conseguiu baixar — retorna como veio (provider pode tentar URL direta).
    return media;
  }

  return {
    ...media,
    base64: fetched.base64,
    mimetype: media.mimetype || fetched.mimetype,
    // Mantém URL pra fallback do provider, mas base64 é a via principal agora.
  };
}

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
  // GARANTIA ANTI-LINK: baixa a URL server-side e converte pra base64 ANTES
  // de chamar o provider. Sem isso, quando o agente IA envia uma foto de
  // produto do catálogo via tag [IMAGEM: url], a Evolution API (especialmente
  // a GO) recebe `base64: undefined` e acaba mostrando o link como texto
  // em vez da imagem propriamente dita.
  const resolvedMedia = await ensureBase64(mediaData);

  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") {
    const cfg = ensureCloudConfig(ch);
    return whatsappCloud.sendMedia(cfg, remoteJid, {
      type: resolvedMedia.type === "audio" ? "audio" : (resolvedMedia.type as any),
      base64: resolvedMedia.base64,
      fileName: resolvedMedia.fileName,
      mimetype: resolvedMedia.mimetype,
      caption,
    });
  }

  const { primary, fallback } = await getProvider(instanceName);
  const res = await primary.sendMedia(remoteJid, caption, resolvedMedia, instanceName);
  if (res.ok) return res;

  if (fallback) {
    const fallbackRes = await fallback.sendMedia(remoteJid, caption, resolvedMedia, instanceName);
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
