import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { logWarmupAction } from "./warmup-engine";
import { getRandomStatusQuote } from "./warmup-dialogues";
import type { WarmupGroup } from "./warmup-types";

// Cache em memória de curta duração (60 segundos) para validação ultrarrápida no Webhook (<1ms)
interface GroupCacheItem {
  isWarmup: boolean;
  groupId?: string;
  clientId?: string;
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
        // Invalida cache local
        if (groupJid) {
          _groupJidCache.set(groupJid, {
            isWarmup: true,
            clientId,
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
): Promise<{ isWarmup: boolean; groupId?: string; clientId?: string }> {
  if (!groupJid || !groupJid.includes("@g.us")) {
    return { isWarmup: false };
  }

  const cached = _groupJidCache.get(groupJid);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    if (!clientId || cached.clientId === clientId) {
      return { isWarmup: cached.isWarmup, groupId: cached.groupId, clientId: cached.clientId };
    }
  }

  try {
    let query = supabaseAdmin
      .from("whatsapp_warmup_groups")
      .select("id, client_id, status")
      .eq("group_jid", groupJid);

    if (clientId) {
      query = query.eq("client_id", clientId);
    }

    const { data } = await query.maybeSingle();

    if (data) {
      _groupJidCache.set(groupJid, {
        isWarmup: true,
        groupId: data.id,
        clientId: data.client_id,
        cachedAt: Date.now(),
      });
      return { isWarmup: true, groupId: data.id, clientId: data.client_id };
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
 * 3. Atualiza contadores do grupo sem poluir o CRM.
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

  // 1. Atualiza métricas do grupo (Fire-and-forget assíncrono para zero latência)
  supabaseAdmin
    .from("whatsapp_warmup_groups")
    .update({
      last_activity_at: nowIso,
      updated_at: nowIso,
    })
    .eq("group_jid", groupJid)
    .then(() => {}, () => {});

  // 2. Leitura com marcação de tique azul humana
  evolution.markMessageAsRead([{ remoteJid: groupJid, id: messageId, fromMe: false }], instanceName).catch(() => {});

  // 3. Heurística de Reação com Emoji (Zero-Token Tier)
  const antiFloodKey = `${instanceName}:${groupJid}`;
  const lastReaction = _lastReactionPerChipGroup.get(antiFloodKey) || 0;
  const cooldownPassed = Date.now() - lastReaction > 90 * 1000; // Mínimo de 90s entre reações no mesmo grupo

  let reactionChosen: string | null = null;

  if (cooldownPassed && messageText && messageText.trim()) {
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

    // Dispara reação com delay orgânico de 2 a 5 segundos
    const delayMs = Math.floor(Math.random() * 3000) + 2000;
    setTimeout(async () => {
      try {
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

        // Incrementa contagem de reações do grupo
        await supabaseAdmin
          .from("whatsapp_warmup_groups")
          .update({
            total_reactions_sent: 1, // trigger/raw increment
            updated_at: new Date().toISOString(),
          })
          .eq("group_jid", groupJid);
      } catch {}
    }, delayMs);

    return { handled: true, action: "reacted", reaction: reactionChosen };
  }

  return { handled: true, action: "read_passive" };
}

/**
 * Fila de entrada cadenciada (Staggered Join) de chips nos grupos cadastrados.
 */
export async function syncGroupMembershipForChips(
  clientId: string
): Promise<{ joinedCount: number; errors: string[] }> {
  let joinedCount = 0;
  const errors: string[] = [];

  try {
    // 1. Busca chips ativos na colmeia
    const { data: configs } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("instance_name, group_auto_join, is_quarantined")
      .eq("client_id", clientId)
      .eq("enabled", true)
      .eq("is_quarantined", false);

    if (!configs || configs.length === 0) {
      return { joinedCount: 0, errors: ["Nenhum chip ativo elegível para entrada em grupos."] };
    }

    const eligibleChips = configs
      .filter((c) => c.group_auto_join !== false)
      .map((c) => c.instance_name);

    if (eligibleChips.length === 0) {
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

    // 3. Busca associações já existentes
    const { data: existingMembers } = await supabaseAdmin
      .from("whatsapp_warmup_group_members")
      .select("group_id, instance_name, status")
      .eq("client_id", clientId);

    const memberSet = new Set(
      (existingMembers || []).map((m) => `${m.group_id}:${m.instance_name}`)
    );

    for (const group of groups as WarmupGroup[]) {
      for (const chip of eligibleChips) {
        const key = `${group.id}:${chip}`;
        if (memberSet.has(key)) continue;

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

            // Se o grupo ainda não tinha JID salvo, atualiza
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

            // Intervalo humano mínimo entre entradas para não disparar rate limits
            await new Promise((r) => setTimeout(r, 1500));
          } else {
            const errMsg = joinRes.error || "Não foi possível entrar no grupo";
            if (errMsg.includes("full") || errMsg.includes("lotado")) {
              await supabaseAdmin
                .from("whatsapp_warmup_groups")
                .update({ status: "full", last_error: errMsg })
                .eq("id", group.id);
            }
            errors.push(`Chip ${chip} não conseguiu entrar no grupo ${group.invite_code}: ${errMsg}`);
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
    ];
    const pickedStatus = defaultStatuses[Math.floor(Math.random() * defaultStatuses.length)];

    await evolution.updateProfileStatus(pickedStatus, instanceName).catch(() => {});

    // Publica status inicial se ainda não tiver postado
    const quote = getRandomStatusQuote();
    await evolution.sendStatus(quote, "text", instanceName).catch(() => {});

    await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .update({
        profile_hydrated: true,
        last_status_post_at: new Date().toISOString(),
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

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
