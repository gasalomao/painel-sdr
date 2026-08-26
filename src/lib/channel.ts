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
 * Cache em memória com ORÇAMENTO EM BYTES (48MB total) pra não baixar a mesma
 * foto de produto 100x por dia (produtos do catálogo são re-enviados a cada
 * pergunta). Antes era "LRU de 50 itens" — 50 × base64 grande = OOM.
 */
const mediaBase64Cache = new Map<string, { base64: string; mimetype: string; ts: number }>();
const MEDIA_CACHE_TTL_MS = 6 * 3600 * 1000; // 6h — produtos mudam raramente
/**
 * Orçamento em BYTES (não em itens): 50 itens × base64 de até 100MB = OOM.
 * 48MB total cobre dezenas de fotos de produto; mídia >8MB nem entra no cache
 * (um vídeo só despejaria todo o resto).
 */
const MEDIA_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const MEDIA_CACHE_ITEM_MAX_BYTES = 8 * 1024 * 1024;
let mediaCacheBytes = 0;

function cachePutBounded(url: string, entry: { base64: string; mimetype: string; ts: number }) {
  const size = entry.base64.length;
  if (size > MEDIA_CACHE_ITEM_MAX_BYTES) return;
  while (mediaCacheBytes + size > MEDIA_CACHE_MAX_BYTES && mediaBase64Cache.size > 0) {
    // Evicta o mais antigo (FIFO por ts).
    let oldestUrl: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of mediaBase64Cache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestUrl = k; }
    }
    if (!oldestUrl) break;
    mediaCacheBytes -= mediaBase64Cache.get(oldestUrl)!.base64.length;
    mediaBase64Cache.delete(oldestUrl);
  }
  mediaBase64Cache.set(url, entry);
  mediaCacheBytes += size;
}

async function fetchUrlAsBase64(url: string): Promise<{ base64: string; mimetype: string } | null> {
  if (!url || !/^https?:\/\//.test(url)) return null;

  // Cache hit?
  const cached = mediaBase64Cache.get(url);
  if (cached && Date.now() - cached.ts < MEDIA_CACHE_TTL_MS) {
    return { base64: cached.base64, mimetype: cached.mimetype };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60000), // 60s — arquivos até 100MB em conexões lentas
      headers: { "User-Agent": "painel-sdr-media/1.0" },
    });
    if (!res.ok) {
      console.warn(`[channel] fetchUrlAsBase64 falhou pra ${url}: HTTP ${res.status}`);
      return null;
    }
    const mimetype = res.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    // Limite 100MB — WhatsApp aceita documentos até 100MB; imagens/vídeos/áudio têm limites menores.
    // Apenas avisa — não rejeita (Evolution/Baileys decide se aceita ou não por tipo).
    if (buf.length > 100 * 1024 * 1024) {
      console.warn(`[channel] Mídia ${url} tem ${(buf.length / 1024 / 1024).toFixed(1)}MB (>100MB) — WhatsApp pode rejeitar.`);
    }
    const base64 = buf.toString("base64");

    // Cache com orçamento em bytes (ver MEDIA_CACHE_MAX_BYTES acima).
    cachePutBounded(url, { base64, mimetype, ts: Date.now() });

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

/**
 * Sincroniza TODAS as fotos de perfil de uma instância em bulk.
 *
 * Usa os endpoints de contatos de cada provedor:
 *   - Evolution API v2: POST /chat/findContacts/{instance} → retorna [{ id, pushName, number, profilePictureUrl }]
 *   - Evolution GO: GET /message/contacts → retorna lista de contatos com foto
 *
 * Atualiza a tabela `contacts` com as URLs encontradas. Muito mais eficiente
 * que buscar foto por foto (1 request vs N requests).
 *
 * Retorna o número de contatos atualizados.
 */
export async function bulkSyncProfilePics(instanceName: string): Promise<number> {
  const ch = await resolveChannel(instanceName);
  if (ch.provider === "whatsapp_cloud") return 0;

  const { primary, fallback } = await getProvider(instanceName);

  // Tentativa 1: provider primário
  let contacts: Array<{ remoteJid: string; profilePicUrl: string | null }> | null = null;

  try {
    contacts = await tryBulkContacts(primary, instanceName);
  } catch (e: any) {
    console.warn(`[bulkSync] primary failed:`, e?.message);
  }

  // Tentativa 2: fallback
  if (!contacts && fallback) {
    try {
      contacts = await tryBulkContacts(fallback, instanceName);
    } catch (e: any) {
      console.warn(`[bulkSync] fallback failed:`, e?.message);
    }
  }

  if (!contacts || contacts.length === 0) return 0;

  // Atualiza o banco em paralelo por chunks de 25 com Promise.all
  let updated = 0;
  const now = new Date().toISOString();
  const validUpdates = contacts
    .filter((c) => c.profilePicUrl && c.profilePicUrl.startsWith("http"))
    .map((c) => ({
      remote_jid: c.remoteJid,
      phone_number: c.remoteJid.replace(/@.*$/, "").replace(/\D/g, ""),
      profile_pic_url: c.profilePicUrl,
      profile_pic_fetched_at: now,
    }));

  const CHUNK = 25;
  for (let i = 0; i < validUpdates.length; i += CHUNK) {
    const batch = validUpdates.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      batch.map((u) =>
        supabase
          .from("contacts")
          .upsert(
            {
              remote_jid: u.remote_jid,
              phone_number: u.phone_number,
              profile_pic_url: u.profile_pic_url,
              profile_pic_fetched_at: now,
            },
            { onConflict: "remote_jid" }
          )
      )
    );
    results.forEach((r) => {
      if (r.status === "fulfilled" && (!r.value || !r.value.error)) updated++;
    });
  }

  return updated;
}

/**
 * Chama o endpoint de contatos do provider para buscar fotos em bulk.
 * Cada provider tem seu formato de resposta.
 */
async function tryBulkContacts(
  provider: WhatsAppProvider,
  instanceName: string
): Promise<Array<{ remoteJid: string; profilePicUrl: string | null }> | null> {
  // Evolution API (v2 / Node.js): POST /chat/findContacts/{instance}
  if (provider.name === "evolution" || provider.name === "evolution_v2") {
    const { getEvolutionConfig } = await import("@/lib/evolution");
    const cfg = (await getEvolutionConfig()) || ({} as any);
    if (!cfg?.url) return null;

    const contacts: Array<{ remoteJid: string; profilePicUrl: string | null }> = [];
    try {
      const res = await fetch(
        `${cfg.url.replace(/\/+$/, "")}/chat/findContacts/${instanceName}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: cfg.apiKey,
          },
          body: JSON.stringify({ take: 500, skip: 0 }),
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data?.data || [];
      for (const c of list) {
        const jid = c.id || (c.number ? `${c.number.replace(/\D/g, "")}@s.whatsapp.net` : null);
        if (jid) {
          contacts.push({
            remoteJid: jid,
            profilePicUrl: c.profilePictureUrl || null,
          });
        }
      }
    } catch (e: any) {
      console.warn(`[bulkSync] findContacts failed:`, e?.message);
      return null;
    }
    return contacts;
  }

  // Evolution GO: GET /message/contacts
  if (provider.name === "evolution_go") {
    try {
      // Lê a config do Evolution GO diretamente do app_settings.
      const { data: settings } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["evolution_go_url", "evolution_go_key"]);
      let goUrl = "";
      let goKey = "";
      for (const r of settings || []) {
        if (r.key === "evolution_go_url" && r.value) goUrl = r.value;
        if (r.key === "evolution_go_key" && r.value) goKey = r.value;
      }
      if (!goUrl) return null;

      // Resolve token da instância.
      const { data: connData } = await supabase
        .from("channel_connections")
        .select("provider_config")
        .eq("instance_name", instanceName)
        .maybeSingle();
      const token = connData?.provider_config?.evo_go_token || goKey;

      const res = await fetch(`${goUrl.replace(/\/+$/, "")}/message/contacts`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          apikey: goKey,
          token,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data?.contacts || data?.data || [];
      const contacts: Array<{ remoteJid: string; profilePicUrl: string | null }> = [];
      for (const c of list) {
        const jid = c.id || (c.number ? `${c.number.replace(/\D/g, "")}@s.whatsapp.net` : null);
        if (jid) {
          // O GO pode retornar pictureUrl, avatar (base64), ou url.
          const pic = c.pictureUrl || c.profilePictureUrl || c.url || null;
          contacts.push({
            remoteJid: jid,
            profilePicUrl: pic && typeof pic === "string" && pic.startsWith("http") ? pic : null,
          });
        }
      }
      return contacts;
    } catch (e: any) {
      console.warn(`[bulkSync] GO contacts failed:`, e?.message);
      return null;
    }
  }

  return null;
}
