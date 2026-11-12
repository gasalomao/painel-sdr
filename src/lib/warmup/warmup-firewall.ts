/**
 * Warmup Peer Firewall: identifica tráfego 1x1 entre chips de aquecimento do mesmo
 * tenant (recebido OU enviado via fromMe=true) para blindar CRM, sessões e agente IA.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { getBrazilPhoneVariants } from "@/lib/jid-utils";
import { isWarmupSend } from "@/lib/manual-send-registry";

export interface WarmupPeerEntry {
  instanceName: string;
  phone: string | null;
  variants: string[];
  warmupEnabled: boolean;
}

export interface WarmupFirewallDecision {
  blocked: boolean;
  peerInstance?: string;
  reason?: "warmup_message_id" | "warmup_peer_traffic";
}

interface CacheEntry {
  peers: WarmupPeerEntry[];
  cachedAt: number;
}

const CACHE_TTL_MS = 60_000;
const peerCache = new Map<string, CacheEntry>();

export function invalidateWarmupFirewallCache(clientId?: string): void {
  if (clientId) {
    peerCache.delete(clientId);
  } else {
    peerCache.clear();
  }
}

export function extractCandidatePhones(jids: Array<string | null | undefined>): Set<string> {
  const result = new Set<string>();
  for (const raw of jids) {
    if (!raw || typeof raw !== "string") continue;
    // Ignora JIDs LID puros sem dígito telefônico; usa apenas @s.whatsapp.net / @c.us / dígitos.
    if (raw.includes("@lid")) continue;
    for (const v of getBrazilPhoneVariants(raw)) {
      if (v.length >= 10) result.add(v);
    }
  }
  return result;
}

export async function persistResolvedChipPhone(
  clientId: string,
  instanceName: string,
  phone: string,
): Promise<void> {
  const clean = phone.replace(/\D/g, "");
  if (!clientId || !instanceName || clean.length < 10) return;

  try {
    const { data: existingWarmup } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("phone_number")
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .maybeSingle();

    if (existingWarmup && !existingWarmup.phone_number) {
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({ phone_number: clean, updated_at: new Date().toISOString() })
        .eq("client_id", clientId)
        .eq("instance_name", instanceName);
    }
  } catch { /* ignore */ }

  try {
    const { data: conn } = await supabaseAdmin
      .from("channel_connections")
      .select("provider_config")
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .maybeSingle();

    const pConfig = (conn?.provider_config || {}) as Record<string, unknown>;
    if (!pConfig.owner_phone) {
      await supabaseAdmin
        .from("channel_connections")
        .update({
          provider_config: { ...pConfig, owner_phone: clean },
        })
        .eq("client_id", clientId)
        .eq("instance_name", instanceName);
    }
  } catch { /* ignore */ }
}

async function resolveOwnerPhoneFromEvolution(instanceName: string): Promise<string | null> {
  try {
    const st = await evolution.getStatus(instanceName);
    const data = st?.data as Record<string, unknown> | undefined;
    const nestedInstance =
      data?.instance && typeof data.instance === "object"
        ? (data.instance as Record<string, unknown>)
        : undefined;
    const owner =
      nestedInstance?.owner ||
      data?.owner ||
      data?.ownerJid ||
      nestedInstance?.ownerJid ||
      null;
    if (!owner) return null;
    const clean = String(owner).replace(/@.*$/, "").replace(/\D/g, "");
    return clean.length >= 10 ? clean : null;
  } catch {
    return null;
  }
}

async function loadTenantWarmupPeers(clientId: string): Promise<WarmupPeerEntry[]> {
  const cached = peerCache.get(clientId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.peers;
  }

  const byInstance = new Map<string, { phone: string | null; warmupEnabled: boolean }>();

  const [{ data: warmupRows }, { data: connRows }, { data: settingsRow }] = await Promise.all([
    supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("instance_name, phone_number, enabled")
      .eq("client_id", clientId),
    supabaseAdmin
      .from("channel_connections")
      .select("instance_name, provider_config")
      .eq("client_id", clientId),
    supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `warmup_configs_${clientId}`)
      .maybeSingle(),
  ]);

  if (Array.isArray(warmupRows)) {
    for (const row of warmupRows) {
      if (!row?.instance_name) continue;
      const phone = row.phone_number ? String(row.phone_number).replace(/\D/g, "") : null;
      byInstance.set(row.instance_name, {
        phone: phone && phone.length >= 10 ? phone : null,
        warmupEnabled: Boolean(row.enabled),
      });
    }
  }

  if (settingsRow?.value) {
    try {
      const parsed = JSON.parse(settingsRow.value) as Record<string, unknown>;
      for (const rawCfg of Object.values(parsed)) {
        const cfg =
          rawCfg && typeof rawCfg === "object"
            ? (rawCfg as Record<string, unknown>)
            : null;
        const instName = typeof cfg?.instance_name === "string" ? cfg.instance_name : null;
        if (!instName) continue;
        const prev = byInstance.get(instName);
        const cfgPhone = cfg?.phone_number ? String(cfg.phone_number).replace(/\D/g, "") : null;
        byInstance.set(instName, {
          phone: prev?.phone || (cfgPhone && cfgPhone.length >= 10 ? cfgPhone : null),
          warmupEnabled: prev ? prev.warmupEnabled : Boolean(cfg?.enabled),
        });
      }
    } catch { /* ignore invalid JSON */ }
  }

  if (Array.isArray(connRows)) {
    for (const conn of connRows) {
      if (!conn?.instance_name) continue;
      const pConfig = (conn.provider_config || {}) as Record<string, unknown>;
      const rawPhone = pConfig.owner_phone || pConfig.owner_jid || null;
      const clean = rawPhone ? String(rawPhone).replace(/@.*$/, "").replace(/\D/g, "") : null;
      const prev = byInstance.get(conn.instance_name);
      if (prev) {
        if (!prev.phone && clean && clean.length >= 10) prev.phone = clean;
      } else if (clean && clean.length >= 10) {
        byInstance.set(conn.instance_name, { phone: clean, warmupEnabled: false });
      }
    }
  }

  // Auto-cura em cache para chips com warmup ativo mas phone_number ainda null no DB.
  const peers: WarmupPeerEntry[] = [];
  for (const [inst, info] of byInstance.entries()) {
    let phone = info.phone;
    if (!phone && info.warmupEnabled) {
      phone = await resolveOwnerPhoneFromEvolution(inst);
      if (phone) {
        persistResolvedChipPhone(clientId, inst, phone).catch(() => {});
      }
    }
    peers.push({
      instanceName: inst,
      phone,
      variants: phone ? getBrazilPhoneVariants(phone) : [],
      warmupEnabled: info.warmupEnabled,
    });
  }

  peerCache.set(clientId, { peers, cachedAt: Date.now() });
  return peers;
}

/**
 * Avalia de forma pura uma lista de pares já carregados contra o JID remoto.
 * Separada para facilitar testes unitários sem banco ou Evolution API.
 */
export function matchWarmupPeer(params: {
  instanceName: string;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  senderPn?: string | null;
  peers: WarmupPeerEntry[];
}): WarmupFirewallDecision {
  const candidates = extractCandidatePhones([params.remoteJid, params.remoteJidAlt, params.senderPn]);
  if (candidates.size === 0) return { blocked: false };

  const currentPeer = params.peers.find((p) => p.instanceName === params.instanceName);

  for (const peer of params.peers) {
    if (peer.instanceName === params.instanceName) continue;
    const isPeerWarmupParticipant =
      peer.warmupEnabled && (currentPeer ? currentPeer.warmupEnabled : true);
    if (!isPeerWarmupParticipant) continue;

    for (const v of peer.variants) {
      if (candidates.has(v)) {
        return {
          blocked: true,
          peerInstance: peer.instanceName,
          reason: "warmup_peer_traffic",
        };
      }
    }
  }

  return { blocked: false };
}

/**
 * Intercepta mensagens trocadas entre chips em aquecimento (recebidas ou fromMe)
 * antes que entrem no CRM, histórico de chat ou acionem o agente de IA.
 */
export async function detectWarmupPeerTraffic(params: {
  clientId: string;
  instanceName: string;
  messageId?: string | null;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  senderPn?: string | null;
}): Promise<WarmupFirewallDecision> {
  if (params.messageId && isWarmupSend(params.messageId)) {
    return { blocked: true, reason: "warmup_message_id" };
  }

  try {
    const peers = await loadTenantWarmupPeers(params.clientId);
    return matchWarmupPeer({
      instanceName: params.instanceName,
      remoteJid: params.remoteJid,
      remoteJidAlt: params.remoteJidAlt,
      senderPn: params.senderPn,
      peers,
    });
  } catch {
    return { blocked: false };
  }
}
