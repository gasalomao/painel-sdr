import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { registerWarmupSend } from "@/lib/manual-send-registry";
import { getBrazilDayKey, logWarmupAction } from "./warmup-engine";
import { getRandomStatusQuote } from "./warmup-dialogues";
import {
  claimAndRunPendingWarmupAction,
  enqueuePendingWarmupAction,
} from "./warmup-pending-actions";
import {
  canonicalBrazilPhoneKey,
  getPersistedFlapCount24h,
  getRecentSocketFlapCount,
  isChipInSoftRecovery,
  pruneMapToLimit,
  type WarmupPhoneMemoryEntry,
} from "./warmup-phone-memory";
import type { WarmupConfig, WarmupGroup } from "./warmup-types";
import { getProxyPoolOverviewCache } from "@/lib/proxy-pool";

// Anti-flood para grupos orgânicos passivos e de aquecimento
const _organicGroupChipCache = new Map<
  string,
  { eligible: boolean; cachedAt: number }
>();
const _lastPassiveReadPerGroup = new Map<string, number>();
const _lastWarmupGroupReadAt = new Map<string, number>();
const _lastInternalSwarmGroupPostAt = new Map<string, number>();
const _lastPassiveTouchPerChip = new Map<string, number>();
const PASSIVE_GROUP_READ_COOLDOWN_MS = 45 * 1000;
const WARMUP_GROUP_READ_COOLDOWN_MS = 120 * 1000;
const INTERNAL_SWARM_GROUP_POST_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const PASSIVE_CHIP_TOUCH_COOLDOWN_MS = 3 * 60 * 1000;
const GROUP_RECEIVE_FLUSH_MS = 12 * 1000;

const _groupReceivePending = new Map<string, number>();
const _groupReceiveLastFlushAt = new Map<string, number>();
const _groupReceiveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _groupReceiveQueue = new Map<string, Promise<void>>();
const _seenGroupMessageIds = new Set<string>();

export function resetGroupReceiveBufferForTests(): void {
  for (const timer of _groupReceiveTimers.values()) clearTimeout(timer);
  _groupReceiveTimers.clear();
  _groupReceivePending.clear();
  _groupReceiveLastFlushAt.clear();
  _groupReceiveQueue.clear();
  _seenGroupMessageIds.clear();
  _organicGroupChipCache.clear();
  _groupJidCache.clear();
  _lastPassiveReadPerGroup.clear();
  _lastWarmupGroupReadAt.clear();
  _lastInternalSwarmGroupPostAt.clear();
  _lastPassiveTouchPerChip.clear();
  _lastReactionPerChipGroup.clear();
}

async function flushChipGroupReceive(clientId: string, instanceName: string): Promise<void> {
  const key = `${clientId}:${instanceName}`;
  const run = async () => {
    const pendingDelta = _groupReceivePending.get(key) || 0;
    if (pendingDelta <= 0) return;
    _groupReceivePending.delete(key);
    _groupReceiveLastFlushAt.set(key, Date.now());
    try {
      const { data: cfg } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("received_today")
        .eq("client_id", clientId)
        .eq("instance_name", instanceName)
        .maybeSingle();

      if (!cfg) return;
      const nowIso = new Date().toISOString();
      const nextReceived = Math.max(0, Number(cfg.received_today || 0)) + pendingDelta;
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({
          received_today: nextReceived,
          last_activity_at: nowIso,
          updated_at: nowIso,
        })
        .eq("client_id", clientId)
        .eq("instance_name", instanceName);
    } catch {
      /* atualização incremental best-effort */
    }
  };

  const prev = _groupReceiveQueue.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  _groupReceiveQueue.set(key, next);
  await next;
}

/**
 * Contabiliza no `received_today` do chip mensagens reais recebidas em grupos
 * (de aquecimento ou orgânicos), deduplicando `messageId` repetido de webhooks e
 * consolidando rajadas em lote sem perder contagem.
 */
export async function recordChipGroupMessageReceived(
  clientId: string,
  instanceName: string,
  messageId?: string | null
): Promise<boolean> {
  if (!clientId || !instanceName) return false;
  if (messageId) {
    const dedupKey = `${instanceName}:${messageId}`;
    if (_seenGroupMessageIds.has(dedupKey)) return false;
    _seenGroupMessageIds.add(dedupKey);
    if (_seenGroupMessageIds.size > 500) {
      const oldest = _seenGroupMessageIds.values().next().value;
      if (oldest) _seenGroupMessageIds.delete(oldest);
    }
  }

  const key = `${clientId}:${instanceName}`;
  _groupReceivePending.set(key, (_groupReceivePending.get(key) || 0) + 1);

  const isTestEnv = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const lastFlush = _groupReceiveLastFlushAt.get(key) || 0;
  const elapsed = Date.now() - lastFlush;

  if (isTestEnv || elapsed >= GROUP_RECEIVE_FLUSH_MS) {
    const existingTimer = _groupReceiveTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      _groupReceiveTimers.delete(key);
    }
    await flushChipGroupReceive(clientId, instanceName);
    return true;
  }

  if (!_groupReceiveTimers.has(key)) {
    const delay = Math.max(200, GROUP_RECEIVE_FLUSH_MS - elapsed);
    const timer = setTimeout(() => {
      _groupReceiveTimers.delete(key);
      flushChipGroupReceive(clientId, instanceName).catch(() => {});
    }, delay);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    _groupReceiveTimers.set(key, timer);
  }
  return true;
}

export function getDailyGroupJoinLimitForStage(stage?: number | null): number {
  const normalized = Math.max(1, Math.min(4, Math.floor(Number(stage) || 1)));
  if (normalized === 1) return 2;
  if (normalized === 2) return 3;
  return 4;
}

// Cache em memória de curta duração (60 segundos) para validação ultrarrápida no Webhook (<1ms)
interface GroupCacheItem {
  isWarmup: boolean;
  groupId?: string;
  clientId?: string;
  totalMessages?: number;
  totalReactions?: number;
  cachedAt: number;
}
const _groupJidCache = new Map<string, GroupCacheItem>();
const CACHE_TTL_MS = 60 * 1000;

// Anti-flood de reações: guarda timestamp da última reação enviada por chip/grupo
const _lastReactionPerChipGroup = new Map<string, number>();

/**
 * Expressões regulares para heurística de sentimentos zero-token em grupos pt-BR.
 */
const ZERO_TOKEN_HEURISTICS: Array<{ regex: RegExp; emojis: string[] }> = [
  {
    regex: /\b(bom dia|diaa+|bom diaa+|dia abençoado|ótimo dia)\b/i,
    emojis: ["👍", "☀️", "☕", "👋", "🙏"],
  },
  {
    regex: /\b(boa tarde|boa tardee+|ótima tarde)\b/i,
    emojis: ["👍", "☕", "👋"],
  },
  {
    regex: /\b(boa noite|boa noitee+|ótima noite|bom descanso)\b/i,
    emojis: ["🌙", "💤", "👍", "🙏"],
  },
  {
    regex: /\b(parab[eé]ns|felicidades|sucesso|meta batida|consegui|fechou|fechado|bora pra cima|pra cima)\b/i,
    emojis: ["👏", "🚀", "🎉", "💪", "🔥"],
  },
  {
    regex: /\b(kkk+|hahaha+|rsrs+|rs+|engraçado|morrendo de rir|kk)\b/i,
    emojis: ["😂", "🤣"],
  },
  {
    regex: /\b(obrigad[oa]|valeu|gratid[aã]o|am[eé]m|show|top|sensacional|muito bom|excelente)\b/i,
    emojis: ["🙏", "❤️", "👍", "🤝", "👏"],
  },
  {
    regex: /\b(link|not[ií]cia|olhem isso|vejam|dica|novidade)\b/i,
    emojis: ["💡", "👀", "👍"],
  },
];

/**
 * Extrai todos os códigos de convite válidos de uma string com múltiplos links de WhatsApp.
 */
export function parseGroupInviteCodes(
  rawInput: string
): Array<{ url: string; code: string }> {
  if (!rawInput || typeof rawInput !== "string") return [];

  const lines = rawInput
    .split(/[\r\n,;]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const seenCodes = new Set<string>();
  const results: Array<{ url: string; code: string }> = [];

  const linkRegex = /(?:https?:\/\/)?(?:chat\.whatsapp\.com\/)([a-zA-Z0-9_-]{20,26})/i;
  const bareCodeRegex = /^[a-zA-Z0-9_-]{20,26}$/;

  for (const item of lines) {
    let code: string | null = null;
    const match = item.match(linkRegex);

    if (match && match[1]) {
      code = match[1];
    } else if (bareCodeRegex.test(item)) {
      code = item;
    }

    if (code && !seenCodes.has(code)) {
      seenCodes.add(code);
      results.push({
        url: `https://chat.whatsapp.com/${code}`,
        code,
      });
    }
  }

  return results;
}

/**
 * Importa múltiplos links de grupos no banco e obtém metadados via Evolution API se houver instância ativa.
 */
export async function importWarmupGroups(
  clientId: string,
  rawInput: string,
  preferredInstance?: string
): Promise<{
  added: number;
  existing: number;
  totalParsed: number;
  errors: string[];
}> {
  const parsed = parseGroupInviteCodes(rawInput);
  if (parsed.length === 0) {
    return { added: 0, existing: 0, totalParsed: 0, errors: ["Nenhum link ou código de grupo válido encontrado."] };
  }

  let added = 0;
  let existing = 0;
  const errors: string[] = [];

  for (const { url, code } of parsed) {
    try {
      // 1. Verifica se já existe para este tenant
      const { data: existingGroup } = await supabaseAdmin
        .from("whatsapp_warmup_groups")
        .select("id, status")
        .eq("client_id", clientId)
        .eq("invite_code", code)
        .maybeSingle();

      if (existingGroup) {
        existing++;
        continue;
      }

      // 2. Consulta metadados do grupo na Evolution API (se houver instância ativa)
      let name: string | null = null;
      let description: string | null = null;
      let memberCount = 0;
      let groupJid: string | null = null;
      let initialStatus: "pending" | "active" | "full" | "invalid" = "pending";

      if (preferredInstance) {
        try {
          const info = await evolution.getGroupInviteInfo(code, preferredInstance);
          if (info) {
            name = info.subject || null;
            description = info.desc || null;
            memberCount = info.size || 0;
            if (info.id) {
              groupJid = info.id.includes("@g.us") ? info.id : `${info.id}@g.us`;
            }
            if (memberCount >= 1024) {
              initialStatus = "full";
            }
          }
        } catch {
          // Não fatal: salva como pendente para tentar entrar depois
        }
      }

      // 3. Salva no banco de dados
      const { error: insertError } = await supabaseAdmin
        .from("whatsapp_warmup_groups")
        .insert({
          client_id: clientId,
          invite_url: url,
          invite_code: code,
          group_jid: groupJid,
          name: name || `Grupo WhatsApp (${code.slice(0, 6)}...)`,
          description,
          member_count: memberCount,
          status: initialStatus,
        });

      if (insertError) {
        errors.push(`Erro ao salvar grupo ${code}: ${insertError.message}`);
      } else {
        added++;
        if (groupJid) {
          _groupJidCache.set(groupJid, {
            isWarmup: true,
            clientId,
            totalMessages: 0,
            totalReactions: 0,
            cachedAt: Date.now(),
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Falha no processamento de ${code}: ${msg}`);
    }
  }

  return { added, existing, totalParsed: parsed.length, errors };
}

/**
 * Verifica se um JID pertence a um grupo de aquecimento registrado (com cache de alta performance).
 */
export async function isWarmupGroupJid(
  groupJid: string,
  clientId?: string
): Promise<{
  isWarmup: boolean;
  groupId?: string;
  clientId?: string;
  totalMessages?: number;
  totalReactions?: number;
}> {
  if (!groupJid || !groupJid.includes("@g.us")) {
    return { isWarmup: false };
  }

  const cached = _groupJidCache.get(groupJid);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    if (!clientId || cached.clientId === clientId) {
      return {
        isWarmup: cached.isWarmup,
        groupId: cached.groupId,
        clientId: cached.clientId,
        totalMessages: cached.totalMessages,
        totalReactions: cached.totalReactions,
      };
    }
  }

  try {
    let query = supabaseAdmin
      .from("whatsapp_warmup_groups")
      .select("id, client_id, status, total_messages_received, total_reactions_sent")
      .eq("group_jid", groupJid);

    if (clientId) {
      query = query.eq("client_id", clientId);
    }

    const { data } = await query.maybeSingle();

    if (data) {
      const item: GroupCacheItem = {
        isWarmup: true,
        groupId: data.id,
        clientId: data.client_id,
        totalMessages: Number(data.total_messages_received || 0),
        totalReactions: Number(data.total_reactions_sent || 0),
        cachedAt: Date.now(),
      };
      _groupJidCache.set(groupJid, item);
      return {
        isWarmup: true,
        groupId: data.id,
        clientId: data.client_id,
        totalMessages: item.totalMessages,
        totalReactions: item.totalReactions,
      };
    }

    _groupJidCache.set(groupJid, {
      isWarmup: false,
      cachedAt: Date.now(),
    });
    return { isWarmup: false };
  } catch {
    return { isWarmup: false };
  }
}

/**
 * Processa mensagens recebidas de grupos no webhook via Camada Zero-Token.
 * 1. Simula leitura humana (ticks azuis).
 * 2. Avalia heurísticas de sentimentos para reações com emoji naturais.
 * 3. Atualiza contadores incrementais do grupo sem poluir o CRM.
 */
export async function processIncomingGroupMessage(params: {
  clientId: string;
  instanceName: string;
  groupJid: string;
  messageId: string;
  messageText: string;
  participant?: string;
  fromMe?: boolean;
}): Promise<{ handled: boolean; action?: string; reaction?: string }> {
  const { clientId, instanceName, groupJid, messageId, messageText, participant, fromMe } = params;

  if (fromMe) {
    return { handled: true, action: "ignored_from_me" };
  }

  const warmupCheck = await isWarmupGroupJid(groupJid, clientId);
  if (!warmupCheck.isWarmup) {
    return { handled: false };
  }

  const nowIso = new Date().toISOString();
  const nextMessagesCount = (warmupCheck.totalMessages || 0) + 1;
  const cachedEntry = _groupJidCache.get(groupJid);
  if (cachedEntry) {
    cachedEntry.totalMessages = nextMessagesCount;
  }

  // 1. Atualiza métricas do grupo (incrementando total_messages_received) e received_today do chip
  supabaseAdmin
    .from("whatsapp_warmup_groups")
    .update({
      total_messages_received: nextMessagesCount,
      last_activity_at: nowIso,
      updated_at: nowIso,
    })
    .eq("group_jid", groupJid)
    .then(() => {}, () => {});

  await recordChipGroupMessageReceived(clientId, instanceName, messageId);

  // 2. Leitura com marcação de tique azul humana (atraso orgânico + cooldown de 120s + fila persistente)
  const nowMs = Date.now();
  const readKey = `${instanceName}:${groupJid}`;
  const lastReadAt = _lastWarmupGroupReadAt.get(readKey) || 0;
  if (nowMs - lastReadAt >= WARMUP_GROUP_READ_COOLDOWN_MS) {
    _lastWarmupGroupReadAt.set(readKey, nowMs);
    pruneMapToLimit(_lastWarmupGroupReadAt, 3000);
    const readDelayMs =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test"
        ? 10
        : 2000 + Math.floor(Math.random() * 6000);
    const readAction = await enqueuePendingWarmupAction(clientId, {
      type: "read",
      dueAt: nowMs + readDelayMs,
      actorInstance: instanceName,
      peerInstance: groupJid,
      actorPhone: "",
      peerPhone: groupJid,
      targetJid: groupJid,
      messageId,
      delayMs: readDelayMs,
    }).catch(() => null);
    if (readAction?.id) {
      const t = setTimeout(() => {
        void claimAndRunPendingWarmupAction(clientId, readAction.id);
      }, readDelayMs);
      if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
    } else {
      const t = setTimeout(() => {
        evolution
          .markMessageAsRead([{ remoteJid: groupJid, id: messageId, fromMe: false }], instanceName)
          .catch(() => {});
      }, readDelayMs);
      if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
    }
  }

  // 3. Carência de 72h pós-entrada em grupos recém-ingressados (apenas leitura passiva nos 3 primeiros dias)
  let inNewJoinGrace = false;
  if (warmupCheck.groupId) {
    try {
      const { data: memRow } = await supabaseAdmin
        .from("whatsapp_warmup_group_members")
        .select("joined_at, status")
        .eq("client_id", clientId)
        .eq("group_id", warmupCheck.groupId)
        .eq("instance_name", instanceName)
        .maybeSingle();

      if (memRow?.joined_at) {
        const joinedAgeMs = Date.now() - new Date(String(memRow.joined_at)).getTime();
        if (Number.isFinite(joinedAgeMs) && joinedAgeMs >= 0 && joinedAgeMs < 72 * 60 * 60 * 1000) {
          inNewJoinGrace = true;
        }
      }
    } catch {}
  }

  // 4. Heurística de Reação com Emoji (Zero-Token Tier)
  const antiFloodKey = `${instanceName}:${groupJid}`;
  const lastReaction = _lastReactionPerChipGroup.get(antiFloodKey) || 0;
  const cooldownPassed = Date.now() - lastReaction > 90 * 1000; // Mínimo de 90s entre reações no mesmo grupo

  let reactionChosen: string | null = null;

  if (!inNewJoinGrace && cooldownPassed && messageText && messageText.trim()) {
    const textLower = messageText.toLowerCase();

    for (const rule of ZERO_TOKEN_HEURISTICS) {
      if (rule.regex.test(textLower)) {
        // Probabilidade de 25% para simular comportamento humano casual
        if (Math.random() < 0.25) {
          const randomIndex = Math.floor(Math.random() * rule.emojis.length);
          reactionChosen = rule.emojis[randomIndex];
        }
        break;
      }
    }
  }

  if (reactionChosen) {
    _lastReactionPerChipGroup.set(antiFloodKey, Date.now());
    const nextReactionsCount = (warmupCheck.totalReactions || 0) + 1;
    if (cachedEntry) {
      cachedEntry.totalReactions = nextReactionsCount;
    }

    // Dispara reação com delay orgânico persistida em fila de ações pendentes
    const delayMs =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test"
        ? 15
        : Math.floor(Math.random() * 6000) + 3000;
    const reactAction = await enqueuePendingWarmupAction(clientId, {
      type: "react",
      dueAt: Date.now() + delayMs,
      actorInstance: instanceName,
      peerInstance: groupJid,
      actorPhone: "",
      peerPhone: groupJid,
      targetJid: groupJid,
      messageId,
      delayMs,
      emoji: reactionChosen,
      participant,
    }).catch(() => null);

    const reactTimer = setTimeout(async () => {
      try {
        if (reactAction?.id) {
          const ran = await claimAndRunPendingWarmupAction(clientId, reactAction.id);
          if (!ran) return;
        } else {
          await evolution.sendReaction(
            groupJid,
            messageId,
            reactionChosen!,
            instanceName,
            false,
            participant
          );
          await logWarmupAction({
            client_id: clientId,
            sender_instance: instanceName,
            receiver_instance: groupJid,
            message_text: `Reagiu com ${reactionChosen} a mensagem no grupo de aquecimento`,
            action_type: "reaction",
            details: { groupJid, participant, emoji: reactionChosen },
          });
        }

        let syncedReactionCount = nextReactionsCount;
        try {
          const { data: latestGroup } = await supabaseAdmin
            .from("whatsapp_warmup_groups")
            .select("total_reactions_sent")
            .eq("group_jid", groupJid)
            .maybeSingle();
          if (typeof latestGroup?.total_reactions_sent === "number") {
            syncedReactionCount = Math.max(nextReactionsCount, latestGroup.total_reactions_sent + 1);
          }
        } catch {}

        await supabaseAdmin
          .from("whatsapp_warmup_groups")
          .update({
            total_reactions_sent: syncedReactionCount,
            updated_at: new Date().toISOString(),
          })
          .eq("group_jid", groupJid);
      } catch {}
    }, delayMs);
    if (typeof (reactTimer as { unref?: () => void }).unref === "function") {
      (reactTimer as { unref: () => void }).unref();
    }

    return { handled: true, action: "reacted", reaction: reactionChosen };
  }

  return { handled: true, action: "read_passive" };
}

/**
 * Aproveita grupos orgânicos reais (não cadastrados em `whatsapp_warmup_groups`)
 * onde o chip já participa para gerar sinal passivo de leitura humana e receita de
 * tráfego Inbound sem nunca enviar mensagens no grupo e sem poluir o CRM.
 */
export async function processPassiveOrganicGroupMessage(params: {
  clientId: string;
  instanceName: string;
  groupJid: string;
  messageId: string;
  fromMe?: boolean;
}): Promise<{ handled: boolean; action: "ignored" | "read_scheduled" | "throttled" }> {
  const { clientId, instanceName, groupJid, messageId, fromMe } = params;
  if (fromMe || !groupJid || !groupJid.includes("@g.us") || !clientId || !instanceName) {
    return { handled: false, action: "ignored" };
  }

  const cacheKey = `${clientId}:${instanceName}`;
  const nowMs = Date.now();
  let chipInfo = _organicGroupChipCache.get(cacheKey);

  if (!chipInfo || nowMs - chipInfo.cachedAt > CACHE_TTL_MS) {
    try {
      const { data: cfg } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("enabled, is_quarantined, enable_blue_ticks")
        .eq("client_id", clientId)
        .eq("instance_name", instanceName)
        .maybeSingle();

      const eligible = Boolean(
        cfg?.enabled && !cfg?.is_quarantined && cfg?.enable_blue_ticks !== false
      );
      chipInfo = { eligible, cachedAt: nowMs };
      _organicGroupChipCache.set(cacheKey, chipInfo);
    } catch {
      return { handled: false, action: "ignored" };
    }
  }

  if (!chipInfo.eligible) {
    return { handled: false, action: "ignored" };
  }

  await recordChipGroupMessageReceived(clientId, instanceName, messageId);

  const readKey = `${instanceName}:${groupJid}`;
  const lastRead = _lastPassiveReadPerGroup.get(readKey) || 0;
  if (nowMs - lastRead < PASSIVE_GROUP_READ_COOLDOWN_MS) {
    return { handled: true, action: "throttled" };
  }
  _lastPassiveReadPerGroup.set(readKey, nowMs);

  const delayMs =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? 10
      : 2500 + Math.floor(Math.random() * 6000);

  const readTimer = setTimeout(() => {
    Promise.resolve(
      evolution.markMessageAsRead([{ remoteJid: groupJid, id: messageId, fromMe: false }], instanceName),
    ).catch(() => {});
  }, delayMs);
  if (typeof (readTimer as { unref?: () => void }).unref === "function") {
    (readTimer as { unref: () => void }).unref();
  }

  // Atualiza last_activity_at no máximo a cada 3 minutos por chip para não sobrecarregar o banco
  const lastTouch = _lastPassiveTouchPerChip.get(cacheKey) || 0;
  if (nowMs - lastTouch >= PASSIVE_CHIP_TOUCH_COOLDOWN_MS) {
    _lastPassiveTouchPerChip.set(cacheKey, nowMs);
    supabaseAdmin
      .from("whatsapp_warmup_configs")
      .update({ last_activity_at: new Date(nowMs).toISOString() })
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .then(() => {}, () => {});
  }

  return { handled: true, action: "read_scheduled" };
}

/**
 * Classifica falhas definitivas ao tentar ingressar em um grupo via convite para
 * evitar tentativas repetidas contra links mortos/revogados na Evolution API.
 */
export function classifyGroupJoinError(errMsg: string): "full" | "invalid" | "restricted" | null {
  const msg = String(errMsg || "");
  if (!msg) return null;
  if (/\bfull\b|lotad[oa]|max.?participants|invite.?limit/i.test(msg)) return "full";
  if (/not.?authorized|restricted|admin.?only|permission/i.test(msg)) return "restricted";
  if (/invalid|revoked|expired|\b404\b|\b410\b|gone|not.?found|does.?not.?exist|bad.?invite/i.test(msg)) {
    return "invalid";
  }
  return null;
}

/**
 * Fila de entrada cadenciada (Slow Join Anti-Ban) de chips nos grupos cadastrados:
 * - Respeita o limite diário por estágio (Fase 1: máx. 2/dia, Fase 2: máx. 3/dia, Fase 3+: 4/dia)
 * - Prioriza chips mais novos (menor stage) e com menos grupos antes dos veteranos
 * - Respeita o teto `max_groups_per_chip` de cada chip
 * - Interrompe imediatamente links revogados/inválidos/lotados sem desperdiçar tentativas
 */
export async function syncGroupMembershipForChips(
  clientId: string
): Promise<{ joinedCount: number; errors: string[] }> {
  let joinedCount = 0;
  const errors: string[] = [];

  try {
    // 1. Busca chips ativos na colmeia com estágio e limite total de grupos
    const { data: configs } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("instance_name, stage, group_auto_join, is_quarantined, max_groups_per_chip")
      .eq("client_id", clientId)
      .eq("enabled", true)
      .eq("is_quarantined", false);

    if (!configs || configs.length === 0) {
      return { joinedCount: 0, errors: ["Nenhum chip ativo elegível para entrada em grupos."] };
    }

    const eligibleConfigRows = configs.filter((c) => c.group_auto_join !== false);
    if (eligibleConfigRows.length === 0) {
      return { joinedCount: 0, errors: [] };
    }

    // 2. Busca grupos pendentes ou ativos
    const { data: groups } = await supabaseAdmin
      .from("whatsapp_warmup_groups")
      .select("*")
      .eq("client_id", clientId)
      .in("status", ["pending", "active"]);

    if (!groups || groups.length === 0) {
      return { joinedCount: 0, errors: [] };
    }

    // 3. Busca associações já existentes para respeitar teto total e teto diário (Slow Join)
    const { data: existingMembers } = await supabaseAdmin
      .from("whatsapp_warmup_group_members")
      .select("group_id, instance_name, status, joined_at")
      .eq("client_id", clientId);

    const todayKey = getBrazilDayKey(new Date());
    const memberSet = new Set<string>();
    const totalJoinedByChip = new Map<string, number>();
    const joinedTodayByChip = new Map<string, number>();

    for (const m of existingMembers || []) {
      if (!m?.group_id || !m?.instance_name) continue;
      memberSet.add(`${m.group_id}:${m.instance_name}`);
      if (m.status === "joined") {
        totalJoinedByChip.set(
          m.instance_name,
          (totalJoinedByChip.get(m.instance_name) || 0) + 1
        );
        if (m.joined_at && getBrazilDayKey(String(m.joined_at)) === todayKey) {
          joinedTodayByChip.set(
            m.instance_name,
            (joinedTodayByChip.get(m.instance_name) || 0) + 1
          );
        }
      }
    }

    const prioritizedChips = [...eligibleConfigRows].sort((a, b) => {
      const stageDiff = Number(a.stage ?? 1) - Number(b.stage ?? 1);
      if (stageDiff !== 0) return stageDiff;
      return (totalJoinedByChip.get(a.instance_name) || 0) - (totalJoinedByChip.get(b.instance_name) || 0);
    });

    const MAX_JOINS_PER_RUN = 6;
    for (const group of groups as WarmupGroup[]) {
      if (joinedCount >= MAX_JOINS_PER_RUN) break;
      for (const chipCfg of prioritizedChips) {
        if (joinedCount >= MAX_JOINS_PER_RUN) break;
        const chip = chipCfg.instance_name;
        const key = `${group.id}:${chip}`;
        if (memberSet.has(key)) continue;

        const maxTotalGroups = Number(chipCfg.max_groups_per_chip ?? 10);
        const currentTotalGroups = totalJoinedByChip.get(chip) || 0;
        if (currentTotalGroups >= maxTotalGroups) {
          continue;
        }

        const dailyCap = getDailyGroupJoinLimitForStage(chipCfg.stage);
        const joinedToday = joinedTodayByChip.get(chip) || 0;
        if (joinedToday >= dailyCap) {
          continue;
        }

        try {
          // Entra no grupo usando a Evolution API
          const joinRes = await evolution.acceptGroupInvite(group.invite_code, chip);

          if (joinRes.success) {
            const groupJid = joinRes.groupJid || group.group_jid;

            await supabaseAdmin.from("whatsapp_warmup_group_members").upsert(
              {
                client_id: clientId,
                group_id: group.id,
                instance_name: chip,
                status: "joined",
                joined_at: new Date().toISOString(),
              },
              { onConflict: "group_id,instance_name" }
            );

            if (groupJid && (!group.group_jid || group.status !== "active")) {
              await supabaseAdmin
                .from("whatsapp_warmup_groups")
                .update({
                  group_jid: groupJid,
                  status: "active",
                  updated_at: new Date().toISOString(),
                })
                .eq("id", group.id);

              _groupJidCache.set(groupJid, {
                isWarmup: true,
                groupId: group.id,
                clientId,
                totalMessages: group.total_messages_received || 0,
                totalReactions: group.total_reactions_sent || 0,
                cachedAt: Date.now(),
              });
            }

            await logWarmupAction({
              client_id: clientId,
              sender_instance: chip,
              receiver_instance: group.name || group.invite_code,
              message_text: `🤝 Chip ${chip} ingressou com sucesso no grupo de aquecimento: "${group.name || group.invite_code}"`,
              action_type: "system",
            });

            joinedCount++;
            memberSet.add(key);
            totalJoinedByChip.set(chip, currentTotalGroups + 1);
            joinedTodayByChip.set(chip, joinedToday + 1);

            // Intervalo humano entre entradas para não disparar rate limits
            const joinPauseMs =
              process.env.VITEST === "true" || process.env.NODE_ENV === "test"
                ? 25
                : 4500 + Math.floor(Math.random() * 7000);
            await new Promise((r) => setTimeout(r, joinPauseMs));
          } else {
            const errMsg = joinRes.error || "Não foi possível entrar no grupo";
            const terminalStatus = classifyGroupJoinError(errMsg);
            errors.push(`Chip ${chip} não conseguiu entrar no grupo ${group.invite_code}: ${errMsg}`);
            if (terminalStatus) {
              await supabaseAdmin
                .from("whatsapp_warmup_groups")
                .update({
                  status: terminalStatus,
                  last_error: errMsg.slice(0, 300),
                  updated_at: new Date().toISOString(),
                })
                .eq("id", group.id);
              await logWarmupAction({
                client_id: clientId,
                sender_instance: chip,
                receiver_instance: group.name || group.invite_code,
                message_text: `⊘ Link de grupo marcado como "${terminalStatus}" (${group.invite_code}): ${errMsg.slice(0, 140)}`,
                action_type: "system",
              });
              break; // Não insiste com os outros chips em convite morto/lotado
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Erro ao ingressar ${chip}: ${msg}`);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Erro geral na sincronização de grupos: ${msg}`);
  }

  return { joinedCount, errors };
}

/**
 * Hidratação Automática de Perfil (Anti-Ban Nível 1):
 * Define recado comercial, confirma presença e publica Story no WhatsApp Status.
 */
export async function hydrateChipProfile(
  clientId: string,
  instanceName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const defaultStatuses = [
      "Atendimento comercial e consultoria",
      "Disponível para contato",
      "Foco em resultados e eficiência",
      "Conectado via WhatsApp",
      "Consultoria e soluções digitais",
      "Atendimento de segunda a sexta",
    ];
    const pickedStatus = defaultStatuses[Math.floor(Math.random() * defaultStatuses.length)];

    if (typeof (evolution as { setSettings?: unknown }).setSettings === "function") {
      await evolution.setSettings(instanceName, { groupsIgnore: false, alwaysOnline: false }).catch(() => {});
    }
    await evolution.updateProfileStatus(pickedStatus, instanceName).catch(() => {});

    // Publica status inicial se ainda não tiver postado (e só grava timestamp se o envio confirmar)
    const quote = getRandomStatusQuote();
    const statusOk = await evolution.sendStatus(quote, "text", instanceName).catch(() => null);

    await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .update({
        profile_hydrated: true,
        ...(statusOk ? { last_status_post_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("instance_name", instanceName)
      .eq("client_id", clientId);

    await logWarmupAction({
      client_id: clientId,
      sender_instance: instanceName,
      receiver_instance: "profile_hydration",
      message_text: `✨ Perfil hidratado automaticamente: Recado "${pickedStatus}" e publicação no WhatsApp Status.`,
      action_type: "system",
    });

    await auditChipDay0Hygiene(clientId, instanceName);

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Auditoria Dia-0 (higiene do número e proxy): verifica foto de perfil e país do proxy.
 * Loga alertas quando há pendências ou marca como resolvido ("✓ Auditoria Dia-0 OK")
 * para limpar avisos antigos automaticamente na interface.
 */
export async function auditChipDay0Hygiene(
  clientId: string,
  instanceName: string,
  opts?: { forceInTests?: boolean }
): Promise<{ ok: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  if (!opts?.forceInTests && (process.env.VITEST === "true" || process.env.NODE_ENV === "test")) {
    return { ok: true, warnings };
  }

  try {
    const { data: chipRow } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("phone_number")
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .maybeSingle();

    const phone = chipRow?.phone_number ? String(chipRow.phone_number).replace(/\D/g, "") : "";
    if (phone && typeof (evolution as { fetchProfilePicture?: unknown }).fetchProfilePicture === "function") {
      const picUrl = await evolution.fetchProfilePicture(phone, instanceName).catch(() => null);
      if (!picUrl) {
        warnings.push("chip sem foto de perfil configurada no WhatsApp (adicione uma foto antes de prospectar)");
      }
    }
  } catch {}

  try {
    if (typeof (evolution as { findProxy?: unknown }).findProxy === "function") {
      const pr: { enabled?: boolean; host?: string | null } | null = await evolution
        .findProxy(instanceName)
        .catch(() => null);
      if (pr?.enabled && pr.host) {
        const cleanHost = String(pr.host).trim().toLowerCase();
        const poolOverview = await getProxyPoolOverviewCache().catch(() => ({
          hasPool: false,
          brHosts: new Set<string>(),
        }));
        if (!poolOverview.brHosts.has(cleanHost)) {
          const geoRes = await checkProxyIpIntel(cleanHost, { forceInTests: opts?.forceInTests });
          if (geoRes?.countryCode && geoRes.countryCode !== "BR") {
            warnings.push(
              `proxy estrangeiro (${geoRes.country || geoRes.countryCode}) em chip +55 — recomendado proxy BR ou conexão direta`
            );
          }
          if (geoRes?.hosting) {
            warnings.push(
              `proxy em servidor datacenter/ASN (${geoRes.isp || pr.host}) — risco elevado de flapping e bloqueio 401; prefira IP residencial/4G`
            );
          }
        }
      }
    }
  } catch {}

  if (warnings.length > 0) {
    await logWarmupAction({
      client_id: clientId,
      sender_instance: instanceName,
      receiver_instance: "day0_hygiene",
      message_text: `⚠️ Auditoria Dia-0 (${instanceName}): ${warnings.join(" | ")}.`,
      action_type: "system",
    });
    return { ok: false, warnings };
  }

  await logWarmupAction({
    client_id: clientId,
    sender_instance: instanceName,
    receiver_instance: "day0_hygiene",
    message_text: `✓ Auditoria Dia-0 OK (${instanceName}): foto de perfil e proxy validados.`,
    action_type: "system",
  });
  return { ok: true, warnings: [] };
}

/**
 * Extrai avisos pendentes de Auditoria Dia-0 a partir dos logs (mais recentes primeiro).
 * Um registro recente marcado com "✓" / "Auditoria Dia-0 OK" limpa avisos anteriores da instância.
 */
export function extractDay0WarningsByInstance(
  logs: Array<{ receiver_instance?: string | null; sender_instance?: string | null; message_text?: string | null }>
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const log of logs) {
    if (log?.receiver_instance !== "day0_hygiene" || !log?.sender_instance) continue;
    if (map.has(log.sender_instance)) continue;
    const raw = String(log.message_text || "").trim();
    if (/^[✓✔]|Auditoria Dia-0 OK/i.test(raw)) {
      map.set(log.sender_instance, []);
      continue;
    }
    const cleaned = raw
      .replace(/^⚠️?\s*Auditoria Dia-0\s*\([^)]*\):\s*/i, "")
      .replace(/\.$/, "")
      .trim();
    if (!cleaned) continue;
    const parts = cleaned.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) map.set(log.sender_instance, parts);
  }
  return map;
}

export interface ProxyIpIntel {
  countryCode: string | null;
  country: string | null;
  hosting: boolean;
  isp: string | null;
  checkedAt: number;
}

const _proxyIntelCache = new Map<string, ProxyIpIntel>();
const PROXY_INTEL_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Verifica reputação geográfica e ASN de um host de proxy (com cache em RAM de 6h).
 */
export async function checkProxyIpIntel(
  host: string,
  opts?: { forceInTests?: boolean }
): Promise<ProxyIpIntel | null> {
  const cleanHost = String(host || "").trim().toLowerCase();
  if (!cleanHost) return null;

  const now = Date.now();
  const cached = _proxyIntelCache.get(cleanHost);
  if (cached && now - cached.checkedAt < PROXY_INTEL_TTL_MS) {
    return cached;
  }

  if (!opts?.forceInTests && (process.env.VITEST === "true" || process.env.NODE_ENV === "test")) {
    return null;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const geoRes = (await fetch(
      `http://ip-api.com/json/${encodeURIComponent(cleanHost)}?fields=status,countryCode,country,hosting,isp`,
      { signal: ctrl.signal }
    )
      .then((r) => r.json())
      .catch(() => null)) as {
      status?: string;
      countryCode?: string;
      country?: string;
      hosting?: boolean;
      isp?: string;
    } | null;
    clearTimeout(timer);

    if (geoRes?.status === "success") {
      const entry: ProxyIpIntel = {
        countryCode: geoRes.countryCode ? String(geoRes.countryCode) : null,
        country: geoRes.country ? String(geoRes.country) : null,
        hosting: Boolean(geoRes.hosting),
        isp: geoRes.isp ? String(geoRes.isp) : null,
        checkedAt: now,
      };
      pruneMapToLimit(_proxyIntelCache, 500);
      _proxyIntelCache.set(cleanHost, entry);
      return entry;
    }
  } catch {}
  return null;
}

/**
 * Sinaliza grupos silenciosos há > 72h que não estão gerando aquecimento passivo real.
 */
export function isWarmupGroupDead(
  group: Pick<WarmupGroup, "status" | "last_activity_at" | "created_at" | "total_messages_received">,
  nowMs = Date.now(),
  deadHours = 72
): boolean {
  if (!group || group.status !== "active") return false;
  const thresholdMs = Math.max(1, deadHours) * 60 * 60 * 1000;
  if (group.last_activity_at) {
    const lastMs = new Date(group.last_activity_at).getTime();
    return Number.isFinite(lastMs) && nowMs - lastMs > thresholdMs;
  }
  if (group.created_at && (group.total_messages_received || 0) === 0) {
    const createdMs = new Date(group.created_at).getTime();
    return Number.isFinite(createdMs) && nowMs - createdMs > thresholdMs;
  }
  return false;
}

const INTERNAL_GROUP_SUBJECTS = [
  "Comunidade Empreendedores BR",
  "Networking & Negócios Locais",
  "Grupo Dicas do Dia",
  "Troca de Ideias & Café",
  "Rotina & Produtividade",
];

const INTERNAL_GROUP_CASUAL_LINES = [
  "Bom dia pessoal! Tudo tranquilo por aí hoje?",
  "Boa tarde galera, semana corrida mas produtiva!",
  "Alguém aí acompanhou as novidades de hoje?",
  "Ótimo dia para todos, foco total por aqui 💪",
  "Passando só pra desejar uma excelente tarde pra turma!",
];

/**
 * Descobre grupos em que o chip já participa via Evolution `fetchAllGroups`,
 * registrando-os como grupos de aquecimento para leitura/reação sem depender de links manuais.
 */
export async function discoverExistingGroupsForChip(
  clientId: string,
  instanceName: string
): Promise<{ discovered: number; errors: string[] }> {
  const errors: string[] = [];
  let discovered = 0;
  if (!clientId || !instanceName) return { discovered: 0, errors };

  try {
    const fetched = await evolution.fetchAllGroups(instanceName, false);
    if (!Array.isArray(fetched) || fetched.length === 0) return { discovered: 0, errors };

    const { data: existingGroups } = await supabaseAdmin
      .from("whatsapp_warmup_groups")
      .select("id, group_jid")
      .eq("client_id", clientId);

    const groupIdByJid = new Map<string, string>();
    for (const row of existingGroups || []) {
      if (row?.group_jid && row?.id) groupIdByJid.set(String(row.group_jid), String(row.id));
    }

    const nowIso = new Date().toISOString();
    for (const g of fetched.slice(0, 15)) {
      if (!g?.id || !g.id.includes("@g.us")) continue;
      if (g.restrict || g.announce) continue;

      let groupId = groupIdByJid.get(g.id);
      if (!groupId) {
        const pseudoCode = `discovered_${g.id.replace(/[^a-z0-9]/gi, "").slice(0, 24)}`;
        const insertPayload: Record<string, unknown> = {
          client_id: clientId,
          invite_url: `https://chat.whatsapp.com/${pseudoCode}`,
          invite_code: pseudoCode,
          group_jid: g.id,
          name: g.subject || "Grupo Descoberto",
          member_count: g.size || 2,
          status: "active",
          origin: "external",
          last_activity_at: nowIso,
          updated_at: nowIso,
        };
        let { data: inserted, error: insErr } = await supabaseAdmin
          .from("whatsapp_warmup_groups")
          .insert(insertPayload)
          .select("id")
          .maybeSingle();
        if (insErr && (String(insErr.code || "") === "42703" || String(insErr.code || "") === "PGRST204")) {
          const { origin: _orig, ...legacyPayload } = insertPayload;
          const retry = await supabaseAdmin
            .from("whatsapp_warmup_groups")
            .insert(legacyPayload)
            .select("id")
            .maybeSingle();
          inserted = retry.data;
          insErr = retry.error;
        }
        if (insErr) {
          errors.push(`Falha ao importar ${g.id}: ${insErr.message}`);
          continue;
        }
        groupId = (inserted as { id?: string } | null)?.id;
        if (groupId) {
          groupIdByJid.set(g.id, groupId);
          discovered += 1;
        }
      }

      if (groupId) {
        await supabaseAdmin
          .from("whatsapp_warmup_group_members")
          .upsert(
            {
              client_id: clientId,
              group_id: groupId,
              instance_name: instanceName,
              status: "joined",
              joined_at: nowIso,
            },
            { onConflict: "group_id,instance_name" }
          );
      }
    }
  } catch (err: unknown) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { discovered, errors };
}

/**
 * Remove chips de grupos ativos silenciosos há mais de `deadHours` (padrão 5 dias = 120h)
 * e marca o grupo como `left` para não manter peso morto na sessão.
 */
export async function cleanupDeadWarmupGroups(
  clientId: string,
  nowMs = Date.now(),
  deadHours = 120
): Promise<{ leftGroups: number }> {
  let leftGroups = 0;
  try {
    const { data: activeGroups } = await supabaseAdmin
      .from("whatsapp_warmup_groups")
      .select("*")
      .eq("client_id", clientId)
      .eq("status", "active");

    if (!Array.isArray(activeGroups) || activeGroups.length === 0) return { leftGroups: 0 };

    const nowIso = new Date(nowMs).toISOString();
    for (const g of activeGroups as WarmupGroup[]) {
      if (!isWarmupGroupDead(g, nowMs, deadHours)) continue;

      if (g.group_jid) {
        const { data: members } = await supabaseAdmin
          .from("whatsapp_warmup_group_members")
          .select("instance_name")
          .eq("client_id", clientId)
          .eq("group_id", g.id)
          .eq("status", "joined");

        for (const m of members || []) {
          if (m?.instance_name) {
            await evolution.leaveGroup(g.group_jid, m.instance_name).catch(() => false);
          }
        }
      }

      await supabaseAdmin
        .from("whatsapp_warmup_groups")
        .update({
          status: "left",
          last_error: `auto_cleanup_dead_group_${deadHours}h`,
          updated_at: nowIso,
        })
        .eq("id", g.id);

      await supabaseAdmin
        .from("whatsapp_warmup_group_members")
        .update({ status: "left" })
        .eq("group_id", g.id)
        .eq("client_id", clientId);

      if (g.group_jid) _groupJidCache.delete(g.group_jid);
      leftGroups += 1;
    }
  } catch { /* best-effort */ }
  return { leftGroups };
}

/**
 * Ciclo autônomo de grupos internos da Colmeia:
 * - Com >= 3 chips ativos com telefone conhecido, cria até 2 grupos internos orgânicos
 * - Posta no máximo 1 mensagem casual a cada 4h por grupo ativo interno.
 */
export async function runInternalSwarmGroupCycle(
  clientId: string,
  nowMs = Date.now()
): Promise<{ created: number; posted: number }> {
  let created = 0;
  let posted = 0;

  try {
    const { data: rawConfigs } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("*")
      .eq("client_id", clientId)
      .eq("enabled", true)
      .eq("is_quarantined", false);

    const eligible = ((rawConfigs || []) as WarmupConfig[]).filter(
      (c) => c.internal_groups_enabled !== false && Boolean(c.phone_number)
    );
    if (eligible.length < 3) return { created: 0, posted: 0 };

    const { data: activeGroups } = await supabaseAdmin
      .from("whatsapp_warmup_groups")
      .select("*")
      .eq("client_id", clientId)
      .eq("status", "active");

    const allActive = (activeGroups || []) as WarmupGroup[];
    const internalGroups = allActive.filter(
      (g) => g.origin === "internal_swarm" || String(g.invite_code || "").startsWith("internal_")
    );

    const nowIso = new Date(nowMs).toISOString();

    if (internalGroups.length < 2) {
      const sorted = [...eligible].sort(
        (a, b) => (b.stage || 1) - (a.stage || 1) || (b.days_active || 1) - (a.days_active || 1)
      );
      const creator = sorted[0];
      const peers = sorted.slice(1, Math.min(4, sorted.length));
      const participantPhones = peers
        .map((p) => String(p.phone_number || "").replace(/\D/g, ""))
        .filter(Boolean);

      if (creator && participantPhones.length >= 2) {
        const subject =
          INTERNAL_GROUP_SUBJECTS[Math.floor(Math.random() * INTERNAL_GROUP_SUBJECTS.length)];
        const createdRes = await evolution.createGroup({
          subject,
          participants: participantPhones,
          description: "Troca diária saudável",
          instance: creator.instance_name,
        });

        if (createdRes.success && createdRes.groupJid) {
          const code =
            (await evolution.getGroupInviteCode(createdRes.groupJid, creator.instance_name)) ||
            `internal_${Date.now().toString(36)}`;
          const inviteCode = code.startsWith("internal_") ? code : `internal_${code}`;

          const insertPayload: Record<string, unknown> = {
            client_id: clientId,
            invite_url: `https://chat.whatsapp.com/${code}`,
            invite_code: inviteCode,
            group_jid: createdRes.groupJid,
            name: createdRes.subject || subject,
            member_count: 1 + peers.length,
            status: "active",
            origin: "internal_swarm",
            last_activity_at: nowIso,
            updated_at: nowIso,
          };
          let { data: insertedGrp, error: insErr } = await supabaseAdmin
            .from("whatsapp_warmup_groups")
            .insert(insertPayload)
            .select("*")
            .maybeSingle();
          if (insErr && (String(insErr.code || "") === "42703" || String(insErr.code || "") === "PGRST204")) {
            const { origin: _orig, ...legacyPayload } = insertPayload;
            const retry = await supabaseAdmin
              .from("whatsapp_warmup_groups")
              .insert(legacyPayload)
              .select("*")
              .maybeSingle();
            insertedGrp = retry.data;
            insErr = retry.error;
          }

          if (!insErr && insertedGrp?.id) {
            created += 1;
            const groupId = String(insertedGrp.id);
            for (const memberChip of [creator, ...peers]) {
              await supabaseAdmin.from("whatsapp_warmup_group_members").upsert(
                {
                  client_id: clientId,
                  group_id: groupId,
                  instance_name: memberChip.instance_name,
                  status: "joined",
                  joined_at: nowIso,
                },
                { onConflict: "group_id,instance_name" }
              );
            }
            internalGroups.push(insertedGrp as WarmupGroup);
          }
        }
      }
    }

    for (const grp of internalGroups) {
      if (!grp.group_jid) continue;
      const lastPost = _lastInternalSwarmGroupPostAt.get(grp.group_jid) || 0;
      if (nowMs - lastPost < INTERNAL_SWARM_GROUP_POST_COOLDOWN_MS) continue;

      const poster = eligible.find((c) => c.career_mode !== "rehab") || eligible[0];
      if (!poster) continue;
      const line =
        INTERNAL_GROUP_CASUAL_LINES[Math.floor(Math.random() * INTERNAL_GROUP_CASUAL_LINES.length)];
      try {
        const sentRes = (await evolution.sendTextMessage(
          grp.group_jid,
          line,
          poster.instance_name
        )) as { key?: { id?: string }; id?: string; data?: { key?: { id?: string } } } | null;
        registerWarmupSend(sentRes?.key?.id || sentRes?.data?.key?.id || sentRes?.id);
        _lastInternalSwarmGroupPostAt.set(grp.group_jid, nowMs);
        pruneMapToLimit(_lastInternalSwarmGroupPostAt, 1000);
        posted += 1;

        await logWarmupAction({
          client_id: clientId,
          sender_instance: poster.instance_name,
          receiver_instance: grp.group_jid,
          message_text: line,
          action_type: "text",
          details: { internal_swarm_group: true, group_name: grp.name },
        });
      } catch { /* non-fatal */ }
      break; // Máximo 1 post interno por ciclo para naturalidade
    }
  } catch { /* best-effort */ }

  return { created, posted };
}

export interface ClusterNetworkAnalysis {
  warnings: string[];
  flaps24h: number;
  softRecovery: boolean;
  sharedProxyPeers: string[];
  proxyHosting: boolean;
  proxyForeign: boolean;
}

/**
 * Analisa saúde de rede/proxy e estabilidade do chip em relação à frota:
 * - Colisão de IP de proxy entre múltiplas instâncias
 * - Proxy em datacenter (`hosting`) ou estrangeiro (`!= BR`)
 * - Oscilações excessivas (> 8 desconexões em 24h)
 * - Estado de Retomada Suave (50% pós-hiato/quarentena)
 */
export function analyzeChipClusterHealth(params: {
  clientId: string;
  instanceName: string;
  config: WarmupConfig;
  proxyByInstance: Map<string, { enabled: boolean; host: string | null }>;
  proxyIntelByHost?: Map<string, ProxyIpIntel | null>;
  managedBrPoolHosts?: Set<string>;
  phoneMemoryMap?: Record<string, WarmupPhoneMemoryEntry>;
  nowMs?: number;
}): ClusterNetworkAnalysis {
  const {
    clientId,
    instanceName,
    config,
    proxyByInstance,
    proxyIntelByHost,
    managedBrPoolHosts,
    phoneMemoryMap = {},
    nowMs = Date.now(),
  } = params;

  const warnings: string[] = [];
  const pKey = canonicalBrazilPhoneKey(config.phone_number);
  const memEntry =
    (pKey && phoneMemoryMap[pKey]) ||
    Object.values(phoneMemoryMap).find((e) => e.lastInstanceName === instanceName) ||
    null;

  const flaps24h = Math.max(
    getRecentSocketFlapCount(clientId, instanceName, nowMs),
    getPersistedFlapCount24h(memEntry, nowMs)
  );

  if (flaps24h > 8) {
    warnings.push(
      `Instabilidade severa: ${flaps24h} quedas/reconexões em 24h — troque o proxy ou rede antes de ganhar banimento 401.`
    );
  }

  const ownProxy = proxyByInstance.get(instanceName);
  const sharedProxyPeers: string[] = [];
  let proxyHosting = false;
  let proxyForeign = false;

  if (ownProxy?.enabled && ownProxy.host) {
    const ownHost = ownProxy.host.trim().toLowerCase();
    for (const [peerName, peerProxy] of proxyByInstance.entries()) {
      if (peerName === instanceName) continue;
      if (peerProxy.enabled && peerProxy.host && peerProxy.host.trim().toLowerCase() === ownHost) {
        sharedProxyPeers.push(peerName);
      }
    }
    if (sharedProxyPeers.length > 0) {
      warnings.push(
        `Colisão de proxy (${ownProxy.host}): compartilhado com ${sharedProxyPeers.join(", ")} — risco de banimento em dominó.`
      );
    }

    const isManagedBrPool = Boolean(managedBrPoolHosts?.has(ownHost));
    if (!isManagedBrPool) {
      const intel = proxyIntelByHost?.get(ownHost) || _proxyIntelCache.get(ownHost) || null;
      if (intel?.hosting) {
        proxyHosting = true;
        warnings.push(
          `Proxy em servidor Datacenter/ASN (${intel.isp || ownProxy.host}) — prefira IP residencial/4G brasileiro.`
        );
      }
      if (intel?.countryCode && intel.countryCode !== "BR") {
        proxyForeign = true;
        warnings.push(
          `Proxy localizado fora do Brasil (${intel.country || intel.countryCode}) — divergência geográfica para chip +55.`
        );
      }
    }
  }

  const softRecovery = isChipInSoftRecovery(config, memEntry, nowMs);

  return {
    warnings,
    flaps24h,
    softRecovery,
    sharedProxyPeers,
    proxyHosting,
    proxyForeign,
  };
}

/**
 * Gera conteúdo vCard 3.0 único com todos os chips válidos e deduplicados por telefone canônico,
 * permitindo importar toda a colmeia na agenda do celular em 1 clique.
 */
export function buildClusterVcfContent(
  chips: Array<{ instanceName: string; phoneNumber?: string | null }>
): string {
  const seenKeys = new Set<string>();
  const cards: string[] = [];

  for (const chip of chips) {
    const rawDigits = String(chip.phoneNumber || "").replace(/\D/g, "");
    if (rawDigits.length < 10) continue;

    const canonical = canonicalBrazilPhoneKey(rawDigits) || rawDigits;
    if (seenKeys.has(canonical)) continue;
    seenKeys.add(canonical);

    const e164 = rawDigits.startsWith("55") || rawDigits.length >= 12 ? `+${rawDigits}` : `+55${rawDigits}`;
    const safeName = String(chip.instanceName || `Chip ${rawDigits.slice(-4)}`)
      .replace(/[\r\n;,]/g, " ")
      .trim();

    cards.push(
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `FN:${safeName}`,
        `N:${safeName};;;;`,
        `TEL;TYPE=CELL:${e164}`,
        "NOTE:Contato Colmeia Aquecimento WhatsApp",
        "END:VCARD",
      ].join("\r\n")
    );
  }

  return cards.length > 0 ? `${cards.join("\r\n")}\r\n` : "";
}
