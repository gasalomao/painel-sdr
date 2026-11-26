import { supabaseAdmin } from "@/lib/supabase_admin";
import { extractDigits, getBrazilPhoneVariants } from "@/lib/jid-utils";
import {
  isAiSend,
  isManualSend,
  isPendingAutomatedSend,
  isWarmupSend,
} from "@/lib/manual-send-registry";
import { enqueuePendingWarmupAction } from "./warmup-pending-actions";
import { calculateReadReceiptDelayMs } from "./warmup-dialogues";
import {
  canonicalBrazilPhoneKey,
  savePhoneMemoryFromConfig,
} from "./warmup-phone-memory";
import type { ExternalWarmupMode, WarmupConfig } from "./warmup-types";
import { isTenantWarmupAdmin } from "./warmup-admin-guard";

export interface ExternalShieldConfigSnapshot {
  external_warmup_mode: ExternalWarmupMode;
  enable_blue_ticks: boolean;
  phone_number?: string | null;
  sent_today?: number;
  received_today?: number;
  external_warmup_inbound_today?: number;
  external_warmup_inbound_total?: number;
}

export interface CheckExternalWarmupInboundInput {
  clientId: string;
  instanceName: string;
  remoteJid: string;
  remoteJidAlt?: string | null;
  senderName?: string | null;
  messageId?: string | null;
  messageText?: string | null;
  fromMe?: boolean;
  nowMs?: number;
}

export interface CheckExternalWarmupInboundResult {
  blocked: boolean;
  classification: "none" | "external_warmup_inbound" | "self_echo" | "quarantined_unknown";
  reason?: string;
  mode?: ExternalWarmupMode;
  canonicalPhone?: string | null;
}

export interface ExternalQuarantineEntry {
  id?: string;
  client_id: string;
  instance_name: string;
  canonical_sender_phone: string;
  remote_jid: string;
  sender_name: string | null;
  message_id: string | null;
  message_preview: string | null;
  source_tag: string;
  classification: "external_warmup_inbound" | "self_echo" | "quarantined_unknown";
  seen_count: number;
  first_seen_at: string;
  last_seen_at: string;
  promoted_to_crm_at: string | null;
}

const CONFIG_CACHE_TTL_MS = 30_000;
const _shieldConfigCache = new Map<
  string,
  { expiresAt: number; data: ExternalShieldConfigSnapshot | null }
>();

const COMMERCIAL_LEAD_KEYWORDS =
  /\b(site|website|or[cç]amento|pre[cç]o|valor|valores|proposta|pr[eé]via|instagram|google|meu neg[oó]cio|card[aá]pio|agendamento|atendimento|cl[ií]nica|empresa|loja|consult[oó]rio|contrato|pagamento|pix|reuni[aã]o|call|sim,?\s*pode|manda|quero ver)\b/i;

const EXTERNAL_WARMUP_PATTERNS = [
  /^\s*(oi+|ol[aá]+|bom dia|boa tarde|boa noite|tudo bem\??|blz\??|beleza\??|fala|e a[ií]|show|top|ok+|sim|👍|🙏|👏|🤝|😊|🔥)\s*[!?.]*\s*$/i,
  /^(bom dia|boa tarde|boa noite|oi+|ol[aá]+)[!,. ]/i,
  /\b(not[ií]cia|previs[aã]o do tempo|cot[aã][cç][aã]o|futebol|brasileir[aã]o|caf[eé]|almo[cç]o|bom descanso|boa semana|fique com deus|reflex[aã]o|frase do dia|dica do dia|receita|[oó]tima (segunda|ter[cç]a|quarta|quinta|sexta)|ótimo (s[aá]bado|domingo|fim de semana))\b/i,
];

export function invalidateExternalShieldCache(clientId?: string, instanceName?: string): void {
  if (!clientId) {
    _shieldConfigCache.clear();
    return;
  }
  if (instanceName) {
    _shieldConfigCache.delete(`${clientId}:${instanceName}`);
    return;
  }
  const prefix = `${clientId}:`;
  for (const key of _shieldConfigCache.keys()) {
    if (key.startsWith(prefix)) _shieldConfigCache.delete(key);
  }
}

export function looksLikeExternalWarmupText(text?: string | null): boolean {
  const clean = String(text || "").trim();
  if (!clean) return true;
  if (COMMERCIAL_LEAD_KEYWORDS.test(clean)) return false;
  if (clean.length <= 28) return true;
  return EXTERNAL_WARMUP_PATTERNS.some((rx) => rx.test(clean));
}

function resolveSenderPhoneVariants(remoteJid: string, remoteJidAlt?: string | null): {
  canonical: string;
  variants: string[];
} {
  const primaryDigits = extractDigits(remoteJid);
  const altDigits = extractDigits(remoteJidAlt || "");
  const picked =
    altDigits && altDigits.length >= 10 && altDigits.length <= 13
      ? altDigits
      : primaryDigits;
  const canonical = canonicalBrazilPhoneKey(picked || primaryDigits) || picked || primaryDigits;
  const variants = Array.from(
    new Set([
      ...getBrazilPhoneVariants(canonical),
      ...getBrazilPhoneVariants(primaryDigits),
      ...getBrazilPhoneVariants(altDigits),
      canonical,
      primaryDigits,
      altDigits,
    ].filter(Boolean))
  );
  return { canonical, variants };
}

async function loadExternalShieldConfig(
  clientId: string,
  instanceName: string,
  nowMs = Date.now()
): Promise<ExternalShieldConfigSnapshot | null> {
  const cacheKey = `${clientId}:${instanceName}`;
  const cached = _shieldConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.data;
  }

  let snap: ExternalShieldConfigSnapshot | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select(
        "external_warmup_mode, enable_blue_ticks, phone_number, sent_today, received_today, external_warmup_inbound_today, external_warmup_inbound_total"
      )
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .maybeSingle();

    if (!error && data) {
      const row = data as Record<string, unknown>;
      snap = {
        external_warmup_mode: (["off", "receive_only", "hybrid_quarantine"].includes(
          String(row.external_warmup_mode || "")
        )
          ? row.external_warmup_mode
          : "off") as ExternalWarmupMode,
        enable_blue_ticks: row.enable_blue_ticks !== false,
        phone_number: (row.phone_number as string | null) ?? null,
        sent_today: Number(row.sent_today || 0),
        received_today: Number(row.received_today || 0),
        external_warmup_inbound_today: Number(row.external_warmup_inbound_today || 0),
        external_warmup_inbound_total: Number(row.external_warmup_inbound_total || 0),
      };
    }
  } catch {
    /* fallback to app_settings */
  }

  if (!snap || snap.external_warmup_mode === "off") {
    try {
      const { data: settingsRow } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", `warmup_configs_${clientId}`)
        .maybeSingle();
      if (settingsRow?.value) {
        const map = JSON.parse(String(settingsRow.value)) as Record<string, WarmupConfig>;
        const cfg = map?.[instanceName];
        if (cfg?.external_warmup_mode && cfg.external_warmup_mode !== "off") {
          snap = {
            external_warmup_mode: cfg.external_warmup_mode,
            enable_blue_ticks: cfg.enable_blue_ticks !== false,
            phone_number: cfg.phone_number ?? null,
            sent_today: Number(cfg.sent_today || 0),
            received_today: Number(cfg.received_today || 0),
            external_warmup_inbound_today: Number(cfg.external_warmup_inbound_today || 0),
            external_warmup_inbound_total: Number(cfg.external_warmup_inbound_total || 0),
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  _shieldConfigCache.set(cacheKey, {
    expiresAt: nowMs + CONFIG_CACHE_TTL_MS,
    data: snap,
  });
  return snap;
}

async function isKnownCrmOrCampaignSender(
  clientId: string,
  remoteJid: string,
  variants: string[]
): Promise<boolean> {
  if (!clientId) return false;
  const jidCandidates = Array.from(
    new Set([
      remoteJid,
      ...variants.map((v) => `${v}@s.whatsapp.net`),
    ].filter(Boolean))
  );

  try {
    const { data: contactRows } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("client_id", clientId)
      .in("remote_jid", jidCandidates)
      .limit(1);
    if (Array.isArray(contactRows) && contactRows.length > 0) return true;
  } catch { /* ignore */ }

  if (variants.length > 0) {
    try {
      const { data: contactPhoneRows } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("client_id", clientId)
        .in("phone_number", variants)
        .limit(1);
      if (Array.isArray(contactPhoneRows) && contactPhoneRows.length > 0) return true;
    } catch { /* ignore */ }
  }

  try {
    const { data: targetRows } = await supabaseAdmin
      .from("campaign_targets")
      .select("id")
      .eq("client_id", clientId)
      .in("remote_jid", jidCandidates)
      .in("status", ["sent", "delivered", "replied"])
      .limit(1);
    if (Array.isArray(targetRows) && targetRows.length > 0) return true;
  } catch { /* ignore */ }

  return false;
}

async function isPromotedFromQuarantine(
  clientId: string,
  instanceName: string,
  canonicalPhone: string
): Promise<boolean> {
  if (!canonicalPhone) return false;
  try {
    const { data } = await supabaseAdmin
      .from("warmup_external_quarantine")
      .select("promoted_to_crm_at")
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .eq("canonical_sender_phone", canonicalPhone)
      .maybeSingle();
    if (data && (data as { promoted_to_crm_at?: string | null }).promoted_to_crm_at) {
      return true;
    }
  } catch {
    /* tabela pode não existir antes da 031 */
  }
  return false;
}

async function recordQuarantineAndStats(params: {
  clientId: string;
  instanceName: string;
  canonicalPhone: string;
  remoteJid: string;
  senderName?: string | null;
  messageId?: string | null;
  messageText?: string | null;
  classification: "external_warmup_inbound" | "self_echo" | "quarantined_unknown";
  snap: ExternalShieldConfigSnapshot;
  nowMs: number;
}): Promise<void> {
  const {
    clientId,
    instanceName,
    canonicalPhone,
    remoteJid,
    senderName,
    messageId,
    messageText,
    classification,
    snap,
    nowMs,
  } = params;
  const nowIso = new Date(nowMs).toISOString();
  const preview = messageText ? String(messageText).trim().slice(0, 180) : null;

  try {
    const { data: existing } = await supabaseAdmin
      .from("warmup_external_quarantine")
      .select("id, seen_count")
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .eq("canonical_sender_phone", canonicalPhone || remoteJid)
      .maybeSingle();

    if (existing?.id) {
      await supabaseAdmin
        .from("warmup_external_quarantine")
        .update({
          remote_jid: remoteJid,
          sender_name: senderName || null,
          message_id: messageId || null,
          message_preview: preview,
          classification,
          seen_count: Number((existing as { seen_count?: number }).seen_count || 1) + 1,
          last_seen_at: nowIso,
        })
        .eq("id", existing.id);
    } else {
      await supabaseAdmin.from("warmup_external_quarantine").insert({
        client_id: clientId,
        instance_name: instanceName,
        canonical_sender_phone: canonicalPhone || remoteJid,
        remote_jid: remoteJid,
        sender_name: senderName || null,
        message_id: messageId || null,
        message_preview: preview,
        source_tag: "mmzap",
        classification,
        seen_count: 1,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
      });
    }
  } catch {
    // Fallback em app_settings se migration 031 ainda não rodou
    try {
      const key = `warmup_ext_quarantine_${clientId}`;
      const { data: sRow } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", key)
        .maybeSingle();
      const list = sRow?.value ? (JSON.parse(String(sRow.value)) as ExternalQuarantineEntry[]) : [];
      const idx = list.findIndex(
        (e) => e.instance_name === instanceName && e.canonical_sender_phone === (canonicalPhone || remoteJid)
      );
      if (idx >= 0) {
        list[idx] = {
          ...list[idx],
          remote_jid: remoteJid,
          sender_name: senderName || list[idx].sender_name,
          message_id: messageId || list[idx].message_id,
          message_preview: preview || list[idx].message_preview,
          classification,
          seen_count: Number(list[idx].seen_count || 1) + 1,
          last_seen_at: nowIso,
        };
      } else {
        list.unshift({
          id: `${instanceName}:${canonicalPhone || remoteJid}`,
          client_id: clientId,
          instance_name: instanceName,
          canonical_sender_phone: canonicalPhone || remoteJid,
          remote_jid: remoteJid,
          sender_name: senderName || null,
          message_id: messageId || null,
          message_preview: preview,
          source_tag: "mmzap",
          classification,
          seen_count: 1,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
          promoted_to_crm_at: null,
        });
      }
      await supabaseAdmin
        .from("app_settings")
        .upsert({ key, value: JSON.stringify(list.slice(0, 200)), updated_at: nowIso }, { onConflict: "key" });
    } catch { /* ignore */ }
  }

  if (classification !== "self_echo") {
    const nextReceived = (snap.received_today || 0) + 1;
    const nextExtToday = (snap.external_warmup_inbound_today || 0) + 1;
    const nextExtTotal = (snap.external_warmup_inbound_total || 0) + 1;
    snap.received_today = nextReceived;
    snap.external_warmup_inbound_today = nextExtToday;
    snap.external_warmup_inbound_total = nextExtTotal;

    try {
      const { error } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({
          received_today: nextReceived,
          external_warmup_inbound_today: nextExtToday,
          external_warmup_inbound_total: nextExtTotal,
          external_warmup_last_at: nowIso,
          last_activity_at: nowIso,
          updated_at: nowIso,
        })
        .eq("client_id", clientId)
        .eq("instance_name", instanceName);

      if (error && (String(error.code || "") === "42703" || String(error.code || "") === "PGRST204")) {
        await supabaseAdmin
          .from("whatsapp_warmup_configs")
          .update({
            received_today: nextReceived,
            last_activity_at: nowIso,
            updated_at: nowIso,
          })
          .eq("client_id", clientId)
          .eq("instance_name", instanceName);
      }
    } catch { /* ignore */ }

    if (snap.phone_number) {
      await savePhoneMemoryFromConfig(
        clientId,
        {
          instance_name: instanceName,
          phone_number: snap.phone_number,
          last_activity_at: nowIso,
          external_warmup_mode: snap.external_warmup_mode,
          external_warmup_inbound_today: nextExtToday,
          external_warmup_inbound_total: nextExtTotal,
          external_warmup_last_at: nowIso,
        }
      ).catch(() => null);
    }
  }
}

/**
 * Escudo de Compatibilidade Externa (ex: extensão MMZap no WhatsApp Web em multi-dispositivo).
 * - Modo `receive_only`: intercepta mensagens recebidas de desconhecidos que NÃO são leads do CRM/campanha,
 *   impede criação de contato/sessão e bloqueia resposta de IA (zero envio de volta = zero risco de flood),
 *   marcando apenas leitura passiva (tick azul opcional) e contabilizando aquecimento inbound real.
 * - Modo `hybrid_quarantine`: coloca desconhecidos suspeitos de aquecimento externo em quarentena revisável,
 *   enquanto preserva leads reais (CRM, campanhas ou intenção comercial explícita).
 */
export async function checkExternalWarmupInbound(
  input: CheckExternalWarmupInboundInput
): Promise<CheckExternalWarmupInboundResult> {
  const {
    clientId,
    instanceName,
    remoteJid,
    remoteJidAlt,
    senderName,
    messageId,
    messageText,
    fromMe = false,
    nowMs = Date.now(),
  } = input;

  if (!clientId || !instanceName || !remoteJid) {
    return { blocked: false, classification: "none" };
  }
  if (remoteJid.includes("@g.us") || remoteJid === "status@broadcast" || remoteJid.includes("@newsletter")) {
    return { blocked: false, classification: "none" };
  }

  if (!(await isTenantWarmupAdmin(clientId))) {
    return { blocked: false, classification: "none" };
  }

  const snap = await loadExternalShieldConfig(clientId, instanceName, nowMs);
  if (!snap || snap.external_warmup_mode === "off") {
    return { blocked: false, classification: "none" };
  }

  const { canonical, variants } = resolveSenderPhoneVariants(remoteJid, remoteJidAlt);

  if (fromMe) {
    if (
      (messageId && (isAiSend(messageId) || isWarmupSend(messageId) || isManualSend(messageId))) ||
      isPendingAutomatedSend(instanceName, remoteJid, messageText || "")
    ) {
      return { blocked: false, classification: "none", mode: snap.external_warmup_mode, canonicalPhone: canonical };
    }
    const isCrmLead = await isKnownCrmOrCampaignSender(clientId, remoteJid, variants);
    if (isCrmLead) {
      return { blocked: false, classification: "none", mode: snap.external_warmup_mode, canonicalPhone: canonical };
    }
    if (snap.external_warmup_mode === "receive_only" || looksLikeExternalWarmupText(messageText)) {
      await recordQuarantineAndStats({
        clientId,
        instanceName,
        canonicalPhone: canonical,
        remoteJid,
        senderName,
        messageId,
        messageText,
        classification: "self_echo",
        snap,
        nowMs,
      });
      return {
        blocked: true,
        classification: "self_echo",
        reason: "external_warmup_self_echo",
        mode: snap.external_warmup_mode,
        canonicalPhone: canonical,
      };
    }
    return { blocked: false, classification: "none", mode: snap.external_warmup_mode, canonicalPhone: canonical };
  }

  // Leads reais do CRM ou alvos ativos de campanha NUNCA são interceptados
  const isKnownLead = await isKnownCrmOrCampaignSender(clientId, remoteJid, variants);
  if (isKnownLead) {
    return { blocked: false, classification: "none", mode: snap.external_warmup_mode, canonicalPhone: canonical };
  }

  const promoted = await isPromotedFromQuarantine(clientId, instanceName, canonical);
  if (promoted) {
    return { blocked: false, classification: "none", mode: snap.external_warmup_mode, canonicalPhone: canonical };
  }

  // Em hybrid_quarantine, mensagens com intenção comercial clara passam direto para a Sarah/CRM
  if (snap.external_warmup_mode === "hybrid_quarantine" && !looksLikeExternalWarmupText(messageText)) {
    return { blocked: false, classification: "none", mode: snap.external_warmup_mode, canonicalPhone: canonical };
  }

  const classification: "external_warmup_inbound" | "quarantined_unknown" =
    looksLikeExternalWarmupText(messageText) ? "external_warmup_inbound" : "quarantined_unknown";

  await recordQuarantineAndStats({
    clientId,
    instanceName,
    canonicalPhone: canonical,
    remoteJid,
    senderName,
    messageId,
    messageText,
    classification,
    snap,
    nowMs,
  });

  // Marca leitura passiva (tick azul) com atraso humano, mas JAMAIS responde de volta
  if (snap.enable_blue_ticks && messageId) {
    const readDelayMs = calculateReadReceiptDelayMs(false);
    await enqueuePendingWarmupAction(clientId, {
      type: "read",
      dueAt: nowMs + readDelayMs,
      actorInstance: instanceName,
      peerInstance: "external_mmzap",
      actorPhone: snap.phone_number || "",
      peerPhone: canonical,
      targetJid: remoteJid,
      messageId,
      delayMs: readDelayMs,
    }).catch(() => {});
  }

  return {
    blocked: true,
    classification,
    reason:
      snap.external_warmup_mode === "receive_only"
        ? "external_warmup_receive_only"
        : "external_warmup_hybrid_quarantine",
    mode: snap.external_warmup_mode,
    canonicalPhone: canonical,
  };
}

export async function listExternalQuarantineEntries(
  clientId: string,
  opts?: { instanceName?: string | null; limit?: number }
): Promise<ExternalQuarantineEntry[]> {
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 50));
  try {
    let q = supabaseAdmin
      .from("warmup_external_quarantine")
      .select("*")
      .eq("client_id", clientId)
      .order("last_seen_at", { ascending: false })
      .limit(limit);
    if (opts?.instanceName) {
      q = q.eq("instance_name", opts.instanceName);
    }
    const { data, error } = await q;
    if (!error && Array.isArray(data)) {
      return data as ExternalQuarantineEntry[];
    }
  } catch { /* fallback */ }

  try {
    const { data: sRow } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `warmup_ext_quarantine_${clientId}`)
      .maybeSingle();
    if (!sRow?.value) return [];
    let list = JSON.parse(String(sRow.value)) as ExternalQuarantineEntry[];
    if (opts?.instanceName) {
      list = list.filter((e) => e.instance_name === opts.instanceName);
    }
    return list.slice(0, limit);
  } catch {
    return [];
  }
}

export async function promoteQuarantineEntryToCrm(
  clientId: string,
  entryIdOrPhone: string,
  instanceName?: string | null
): Promise<{ ok: boolean }> {
  const nowIso = new Date().toISOString();
  try {
    let q = supabaseAdmin
      .from("warmup_external_quarantine")
      .update({ promoted_to_crm_at: nowIso })
      .eq("client_id", clientId);
    if (/^[0-9a-f-]{36}$/i.test(entryIdOrPhone)) {
      q = q.eq("id", entryIdOrPhone);
    } else {
      q = q.eq("canonical_sender_phone", canonicalBrazilPhoneKey(entryIdOrPhone) || entryIdOrPhone);
      if (instanceName) q = q.eq("instance_name", instanceName);
    }
    const { error } = await q;
    if (!error) return { ok: true };
  } catch { /* fallback */ }

  try {
    const key = `warmup_ext_quarantine_${clientId}`;
    const { data: sRow } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (!sRow?.value) return { ok: false };
    const list = JSON.parse(String(sRow.value)) as ExternalQuarantineEntry[];
    let found = false;
    for (const item of list) {
      if (
        item.id === entryIdOrPhone ||
        item.canonical_sender_phone === (canonicalBrazilPhoneKey(entryIdOrPhone) || entryIdOrPhone)
      ) {
        item.promoted_to_crm_at = nowIso;
        found = true;
      }
    }
    if (found) {
      await supabaseAdmin
        .from("app_settings")
        .upsert({ key, value: JSON.stringify(list), updated_at: nowIso }, { onConflict: "key" });
    }
    return { ok: found };
  } catch {
    return { ok: false };
  }
}
