import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import * as channel from "@/lib/channel";
import { generateText } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";
import { registerWarmupSend } from "@/lib/manual-send-registry";
import { checkTenantAiQuota } from "@/lib/saas-limits";
import { getRandomWarmupVoiceBase64 } from "./warmup-audio";
import {
  blacklistInstanceProxy,
  getProxyPoolOverviewCache,
  recordInstanceProxyStrike,
} from "@/lib/proxy-pool";
import {
  claimAndRunPendingWarmupAction,
  enqueuePendingWarmupAction,
} from "./warmup-pending-actions";
import { invalidateWarmupFirewallCache, persistResolvedChipPhone } from "./warmup-firewall";
import {
  createDynamicWarmupImage,
  createDynamicWarmupSticker,
  pickCasualWarmupPoll,
} from "./warmup-media";
import {
  markPhoneDisconnected,
  markPhonePostBanRehab,
  pruneMapToLimit,
  savePhoneMemoryFromConfig,
} from "./warmup-phone-memory";
import {
  calculateInterConversationCooldownSec,
  calculateReactionDelayMs,
  calculateReadReceiptDelayMs,
  calculateTypingDuration,
  getRandomCasualVoiceNote,
  getRandomReaction,
  getRandomStatusQuote,
  pickVariedFallbackTurnText,
  WARMUP_THEMES,
} from "./warmup-dialogues";
import {
  STAGE_DEFAULTS,
  type WarmupConfig,
  type WarmupConversation,
  type WarmupConversationTurn,
  type WarmupLog,
  type WarmupPurpose,
  type WarmupStage,
} from "./warmup-types";

// Base64 de um áudio sintético super leve de voz silenciosa/neutra (OPUS) para fallback de PTT
const CASUAL_OPUS_BASE64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAA+1icBAAAAAAAAPtYnAQAAAAAAAA==";

// Memória recente por instância para evitar repetição das mesmas frases em conversas seguidas
const _recentTextsBySender = new Map<string, string[]>();
const _providerCache = new Map<string, { provider: string; at: number }>();
const MAX_RECENT_TEXTS_PER_SENDER = 30;

async function resolveWarmupChannelProvider(clientId: string, instanceName: string): Promise<string> {
  const key = `${clientId}:${instanceName}`;
  const cached = _providerCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.provider;
  try {
    const { data } = await supabaseAdmin
      .from("channel_connections")
      .select("provider")
      .eq("client_id", clientId)
      .eq("instance_name", instanceName)
      .maybeSingle();
    const provider = String((data as { provider?: string | null } | null)?.provider || "evolution");
    pruneMapToLimit(_providerCache, 2000);
    _providerCache.set(key, { provider, at: Date.now() });
    return provider;
  } catch {
    return "evolution";
  }
}

export function recordRecentWarmupText(senderKey: string, text: string): void {
  const clean = text.trim();
  if (!clean) return;
  pruneMapToLimit(_recentTextsBySender, 2000);
  const list = _recentTextsBySender.get(senderKey) || [];
  list.push(clean);
  if (list.length > MAX_RECENT_TEXTS_PER_SENDER) {
    list.splice(0, list.length - MAX_RECENT_TEXTS_PER_SENDER);
  }
  _recentTextsBySender.set(senderKey, list);
}

export function getRecentWarmupTexts(senderKey: string): string[] {
  return _recentTextsBySender.get(senderKey) || [];
}

/**
 * Retorna a hora atual no fuso horário brasileiro (America/Sao_Paulo).
 */
export function getBrazilHour(date = new Date()): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    hour12: false,
  });
  const parsed = parseInt(formatter.format(date), 10);
  return Number.isNaN(parsed) ? date.getHours() : parsed;
}

/**
 * Verifica se a hora atual está dentro da janela de operação permitida.
 */
export function isWithinOperatingHours(
  startHour: number,
  endHour: number,
  date = new Date()
): boolean {
  const currentHour = getBrazilHour(date);
  if (startHour <= endHour) {
    return currentHour >= startHour && currentHour < endHour;
  }
  return currentHour >= startHour || currentHour < endHour;
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Minutos decorridos desde 00:00 no fuso de Brasília (0..1439).
 */
export function getBrazilMinutesOfDay(date = new Date()): number {
  const hour = getBrazilHour(date);
  const minuteStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    minute: "numeric",
  }).format(date);
  const minute = parseInt(minuteStr, 10);
  return hour * 60 + (Number.isNaN(minute) ? date.getMinutes() : minute);
}

/**
 * Curva horária orgânica não-linear:
 * - Aplica jitter determinístico diário (+/- 22 min) na abertura e fechamento da janela
 *   para janelas regulares (>= 4h e < 24h), evitando todos os chips acordarem/dormirem
 *   no segundo exato das 08:00 e 21:00.
 * - Detecta faixas de pausa de refeição (12h10–13h15 e 19h15–19h45 BRT) para reduzir
 *   início de novas conversas no horário de almoço/jantar.
 */
export function getOrganicScheduleDecision(
  instanceName: string,
  startHour: number,
  endHour: number,
  date = new Date()
): { allowed: boolean; inLunchLull: boolean; startMinuteOffset: number; endMinuteOffset: number } {
  const baseAllowed = isWithinOperatingHours(startHour, endHour, date);
  if (!baseAllowed) {
    return { allowed: false, inLunchLull: false, startMinuteOffset: 0, endMinuteOffset: 0 };
  }

  const dayKey = getBrazilDayKey(date);
  const spanHours = startHour <= endHour ? endHour - startHour : 24 - startHour + endHour;
  const totalMinutes = getBrazilMinutesOfDay(date);

  // Jitter diário nos limites apenas em janelas operacionais regulares (>= 4h e < 24h)
  let startMinuteOffset = 0;
  let endMinuteOffset = 0;
  if (spanHours >= 4 && spanHours < 24) {
    const startSeed = hashSeed(`${instanceName}:${dayKey}:start`);
    const endSeed = hashSeed(`${instanceName}:${dayKey}:end`);
    // Entre +3 e +24 min na abertura; -3 a -24 min antes do encerramento
    startMinuteOffset = 3 + (startSeed % 22);
    endMinuteOffset = -(3 + (endSeed % 22));

    const openMinute = startHour * 60 + startMinuteOffset;
    const closeMinute = endHour * 60 + endMinuteOffset;

    if (startHour < endHour && (totalMinutes < openMinute || totalMinutes >= closeMinute)) {
      return { allowed: false, inLunchLull: false, startMinuteOffset, endMinuteOffset };
    }
  }

  const inLunchLull =
    (totalMinutes >= 12 * 60 + 10 && totalMinutes <= 13 * 60 + 15) ||
    (totalMinutes >= 19 * 60 + 15 && totalMinutes <= 19 * 60 + 45);

  return { allowed: true, inLunchLull, startMinuteOffset, endMinuteOffset };
}

/**
 * Chave do dia civil brasileiro (YYYY-MM-DD), usada para reset diário idempotente.
 */
export function getBrazilDayKey(date: Date | string = new Date()): string {
  try {
    const value = typeof date === "string" ? new Date(date) : date;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  } catch {
    return "";
  }
}

/**
 * Verifica se duas datas caem no mesmo dia civil no Brasil.
 */
export function isSameBrazilDay(
  d1: Date | string,
  d2: Date | string = new Date()
): boolean {
  try {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const date1 = typeof d1 === "string" ? new Date(d1) : d1;
    const date2 = typeof d2 === "string" ? new Date(d2) : d2;
    return f.format(date1) === f.format(date2);
  } catch {
    return false;
  }
}

/**
 * Fase máxima permitida pela idade real (dias ativos) do chip quando o
 * piloto automático está ligado:
 * - Dias 1..3: Fase 1 (Frio)
 * - Dias 4..7: Fase 2 (Morno)
 * - Dias 8..12: Fase 3 (Quente)
 * - Dia 13+: Fase 4 (Blindado)
 */
export function getMaxStageForDaysActive(daysActive: number): WarmupStage {
  if (daysActive >= 13) return 4;
  if (daysActive >= 8) return 3;
  if (daysActive >= 4) return 2;
  return 1;
}

/**
 * Calcula os dias civis reais desde `created_at` no fuso de Brasília.
 */
export function calculateElapsedDaysFromCreatedAt(
  createdAt?: string | null,
  nowIso: string = new Date().toISOString()
): number | null {
  if (!createdAt) return null;
  const createdKey = getBrazilDayKey(createdAt);
  const todayKey = getBrazilDayKey(nowIso);
  if (!createdKey || !todayKey) return null;
  const createdDate = new Date(`${createdKey}T12:00:00Z`);
  const todayDate = new Date(`${todayKey}T12:00:00Z`);
  const elapsed = Math.floor((todayDate.getTime() - createdDate.getTime()) / 86_400_000) + 1;
  return Number.isFinite(elapsed) && elapsed >= 1 ? elapsed : null;
}

/**
 * Teto de envios por hora para distribuir a meta diária suavemente ao longo
 * da janela comercial (evita disparar 50 mensagens em 3h pela manhã).
 */
export function getHourlySendCap(cfg: WarmupConfig, effectiveDailyTarget: number): number {
  const start = cfg.allowed_start_hour ?? 8;
  const end = cfg.allowed_end_hour ?? 21;
  const windowHours = Math.max(6, end >= start ? end - start : 24 - start + end);
  const avgPerHour = effectiveDailyTarget / windowHours;
  const stageMaxByHour: Record<WarmupStage, number> = {
    1: 3,
    2: 5,
    3: 8,
    4: 10,
  };
  const stageCap = stageMaxByHour[(cfg.stage || 1) as WarmupStage] || 6;
  return Math.max(2, Math.min(stageCap, Math.ceil(avgPerHour * 1.45)));
}

/**
 * Indica se a data cai no sábado ou domingo (horário oficial de Brasília).
 */
export function isBrazilWeekend(date: Date = new Date()): boolean {
  try {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      weekday: "short",
    }).format(date);
    return weekday === "Sat" || weekday === "Sun";
  } catch {
    const day = date.getDay();
    return day === 0 || day === 6;
  }
}

/**
 * Curva circadiana de ritmo horário:
 * - Picos naturais de atividade humana pela manhã (09-11h) e tarde (14-17h)
 * - Queda natural no almoço (12-13h), início/fim de expediente e desaceleração (~45%) no fim de semana.
 */
export function getCircadianHourlyCap(
  cfg: WarmupConfig,
  effectiveDailyTarget: number,
  date: Date = new Date()
): number {
  const baseCap = getHourlySendCap(cfg, effectiveDailyTarget);
  const hour = getBrazilHour(date);
  const weekendFactor = isBrazilWeekend(date) ? 0.55 : 1;

  let hourWeight = 1;
  if (hour >= 9 && hour <= 11) hourWeight = 1.15;
  else if (hour >= 12 && hour <= 13) hourWeight = 0.55;
  else if (hour >= 14 && hour <= 17) hourWeight = 1.15;
  else if (hour >= 18 && hour <= 19) hourWeight = 0.75;
  else if (hour >= 20 || hour < 6) hourWeight = 0.45;
  else hourWeight = 0.7; // 06h-08h

  return Math.max(1, Math.round(baseCap * weekendFactor * hourWeight));
}

/**
 * Resolve o telefone do WhatsApp associado à instância via channel_connections ou Evolution.
 */
export async function resolveInstancePhone(
  instanceName: string,
  clientId: string
): Promise<string | null> {
  // 1. Tenta ler de whatsapp_warmup_configs
  try {
    const { data: warmupCfg } = await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .select("phone_number")
      .eq("instance_name", instanceName)
      .eq("client_id", clientId)
      .maybeSingle();

    if (warmupCfg?.phone_number && warmupCfg.phone_number.trim()) {
      return warmupCfg.phone_number.trim().replace(/\D/g, "");
    }
  } catch { }

  // 2. Tenta ler de channel_connections (provider_config)
  try {
    const { data: conn } = await supabaseAdmin
      .from("channel_connections")
      .select("provider_config")
      .eq("instance_name", instanceName)
      .eq("client_id", clientId)
      .maybeSingle();

    const pConfig = conn?.provider_config as Record<string, any> | undefined;
    const candidate = pConfig?.owner_phone || pConfig?.owner_jid || null;

    if (candidate) {
      const clean = String(candidate).replace(/@.*$/, "").replace(/\D/g, "");
      if (clean.length >= 10) {
        persistResolvedChipPhone(clientId, instanceName, clean).catch(() => { });
        invalidateWarmupFirewallCache(clientId);
        return clean;
      }
    }
  } catch { }

  // 3. Fallback: consulta ao vivo status da Evolution API
  try {
    const st = await evolution.getStatus(instanceName);
    const owner =
      (st?.data as any)?.instance?.owner ||
      (st?.data as any)?.owner ||
      (st?.data as any)?.ownerJid ||
      (st?.data as any)?.instance?.ownerJid ||
      null;
    if (owner) {
      const clean = String(owner).replace(/@.*$/, "").replace(/\D/g, "");
      if (clean.length >= 10) {
        persistResolvedChipPhone(clientId, instanceName, clean).catch(() => { });
        invalidateWarmupFirewallCache(clientId);
        return clean;
      }
    }
  } catch { }

  return null;
}

/**
 * Gera mensagem de aquecimento usando o modelo de IA configurado ou diálogos nativos variados.
 */
export async function generateWarmupMessage(opts: {
  theme: string;
  speakerRole: "A" | "B";
  history: WarmupConversationTurn[];
  aiModel?: string;
  customPrompt?: string | null;
  senderInstance?: string;
  clientId?: string;
  conversationId?: string;
  now?: Date;
}): Promise<{ text: string; provider: string; modelUsed: string }> {
  const { theme, speakerRole, history, aiModel, customPrompt, senderInstance, clientId, conversationId, now = new Date() } = opts;

  const historyTexts = history.map((h) => h.text).filter(Boolean);
  const recentSenderTexts = senderInstance ? getRecentWarmupTexts(senderInstance) : [];
  const usedTexts = [...historyTexts, ...recentSenderTexts];

  if (!aiModel || aiModel === "fallback" || aiModel === "nativo") {
    const text = pickVariedFallbackTurnText({
      theme,
      stepIndex: history.length,
      usedTexts,
      conversationId,
      now,
    });
    if (senderInstance) recordRecentWarmupText(senderInstance, text);
    return {
      text,
      provider: "native_fallback",
      modelUsed: "dialogue_bank_pt_br",
    };
  }

  try {
    // Respeita a cota mensal de IA do tenant antes de chamar qualquer provedor LLM
    if (clientId) {
      const quota = await checkTenantAiQuota(clientId, false).catch(() => ({ allowed: true }));
      if (quota && quota.allowed === false) {
        const text = pickVariedFallbackTurnText({
          theme,
          stepIndex: history.length,
          usedTexts,
          conversationId,
          now,
        });
        if (senderInstance) recordRecentWarmupText(senderInstance, text);
        return {
          text,
          provider: "native_fallback",
          modelUsed: "dialogue_bank_pt_br",
        };
      }
    }

    const keys = await getAiKeys();
    const hasAnyKey = Boolean(
      keys.gemini ||
      keys.openrouter ||
      (Array.isArray(keys.openrouterKeys) && keys.openrouterKeys.length > 0) ||
      keys.nvidia ||
      (keys.gatewayBaseUrl && keys.gatewayApiKey)
    );

    if (!hasAnyKey) {
      const text = pickVariedFallbackTurnText({
        theme,
        stepIndex: history.length,
        usedTexts,
        conversationId,
        now,
      });
      if (senderInstance) recordRecentWarmupText(senderInstance, text);
      return {
        text,
        provider: "native_fallback",
        modelUsed: "dialogue_bank_pt_br",
      };
    }

    const recentHistoryText = history
      .slice(-5)
      .map((h) => `${h.sender}: ${h.text}`)
      .join("\n");

    const themeObj = WARMUP_THEMES.find((t) => t.id === theme) || WARMUP_THEMES[0];
    const avoidSample = usedTexts.slice(-8).join(" | ");
    const resolvedModelRef = aiModel === "auto:free" ? "auto:free-fast" : aiModel;

    const systemPrompt = `Você é um usuário brasileiro casual conversando no WhatsApp com um amigo próximo sobre ${themeObj.label}.
REGRAS OBRIGATÓRIAS:
1. Escreva EXATAMENTE UMA mensagem curta e natural em português brasileiro (como alguém digita no WhatsApp pelo celular, entre 4 e 18 palavras).
2. Use linguagem casual e gírias leves (ex: 'blz', 'show', 'tbm', 'vc', 'kkk', 'mano', 'cara', 'valeu').
3. NUNCA faça ofertas comerciais, nunca fale como atendente, robô ou empresa.
4. Mantenha coerência com as mensagens anteriores e NÃO repita frases já ditas (${avoidSample || "nenhuma"}).
5. Devolva APENAS o texto da mensagem, sem aspas, sem explicações.`;

    const userPrompt =
      history.length === 0
        ? `Inicie a conversa casualmente com um cumprimento e uma frase sobre ${themeObj.label}. ${customPrompt ? `Detalhe: ${customPrompt}` : ""}`
        : `Últimas mensagens trocadas:\n${recentHistoryText}\n\nResponda casualmente como o interlocutor (${speakerRole}):`;

    const res = await generateText({
      modelRef: resolvedModelRef,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.9,
      geminiApiKey: keys.gemini,
      openrouterApiKey: keys.openrouter,
      openrouterKeys: keys.openrouterKeys,
      nvidiaApiKey: keys.nvidia,
      gatewayBaseUrl: keys.gatewayBaseUrl,
      gatewayApiKey: keys.gatewayApiKey,
    });

    const cleanText = (res.text || "").trim().replace(/^["']|["']$/g, "");
    if (cleanText.length > 2) {
      if (senderInstance) recordRecentWarmupText(senderInstance, cleanText);
      return {
        text: cleanText,
        provider: res.provider,
        modelUsed: res.modelUsed || resolvedModelRef,
      };
    }
  } catch (err: any) {
    console.warn(`[Warmup] Geração IA falhou (${err.message}) — usando fallback nativo variado.`);
  }

  const text = pickVariedFallbackTurnText({
    theme,
    stepIndex: history.length,
    usedTexts,
    conversationId,
    now,
  });
  if (senderInstance) recordRecentWarmupText(senderInstance, text);
  return {
    text,
    provider: "native_fallback",
    modelUsed: "dialogue_bank_pt_br",
  };
}

/**
 * Registra log na tabela whatsapp_warmup_logs e no buffer app_settings.
 */
export async function logWarmupAction(log: WarmupLog): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await supabaseAdmin.from("whatsapp_warmup_logs").insert({
      client_id: log.client_id,
      sender_instance: log.sender_instance,
      receiver_instance: log.receiver_instance,
      sender_phone: log.sender_phone,
      receiver_phone: log.receiver_phone,
      message_text: log.message_text,
      action_type: log.action_type,
      details: log.details || {},
      created_at: nowIso,
    });
  } catch { }

  // Buffer em app_settings para persistência garantida
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `warmup_logs_${log.client_id}`)
      .maybeSingle();

    const currentLogs: WarmupLog[] = data?.value ? JSON.parse(data.value) : [];
    currentLogs.unshift({ ...log, created_at: nowIso });
    const trimmed = currentLogs.slice(0, 50);

    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `warmup_logs_${log.client_id}`,
          value: JSON.stringify(trimmed),
          updated_at: nowIso,
        },
        { onConflict: "key" }
      );
  } catch { }
}

export function isTransientInfraError(message: string): boolean {
  return /(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|fetch failed|signal is aborted|timed out after|status\s+50[234]|gateway timeout)/i.test(
    String(message || "")
  );
}

export function isSevereDisconnectReason(reason: unknown): boolean {
  const reasonStr = reason != null ? String(reason).trim() : "";
  if (!reasonStr) return false;
  return /(?:^|\D)(401|403|405|428)(?:\D|$)|logged.?out|ban|blocked|restricted|removed|refused/i.test(
    reasonStr
  );
}

/**
 * Disjuntor de Emergência (Circuit Breaker): Reduz score e coloca em quarentena se houver erros.
 */
export async function handleInstanceFailure(
  clientId: string,
  cfg: WarmupConfig,
  errorMessage: string,
  opts?: { immediateQuarantine?: boolean; isTransientInfra?: boolean }
): Promise<void> {
  const now = new Date();
  const isTransientInfra = Boolean(opts?.isTransientInfra);
  const immediateQuarantine = Boolean(opts?.immediateQuarantine);
  const errorsToday = isTransientInfra
    ? cfg.error_count_today || 0
    : (cfg.error_count_today || 0) + 1;
  const healthPenalty = isTransientInfra ? 5 : immediateQuarantine ? 65 : 20;
  const newHealth = Math.max(0, (cfg.health_score ?? 100) - healthPenalty);

  const shouldQuarantine =
    immediateQuarantine || (!isTransientInfra && (errorsToday >= 3 || newHealth <= 40)) || newHealth <= 30;
  const quarantineUntil = shouldQuarantine
    ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    : null;

  await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .update({
      error_count_today: errorsToday,
      health_score: newHealth,
      is_quarantined: shouldQuarantine,
      quarantine_reason: shouldQuarantine
        ? immediateQuarantine
          ? `Quarentena imediata por bloqueio/sessão crítica: ${errorMessage}`
          : `Múltiplas falhas detectadas: ${errorMessage}`
        : null,
      quarantine_until: quarantineUntil,
      updated_at: now.toISOString(),
    })
    .eq("instance_name", cfg.instance_name)
    .eq("client_id", clientId);

  await logWarmupAction({
    client_id: clientId,
    sender_instance: cfg.instance_name,
    receiver_instance: "circuit_breaker",
    message_text: shouldQuarantine
      ? `🛑 DISJUNTOR ATIVADO: Chip ${cfg.instance_name} colocado em Quarentena 24h para evitar banimento.`
      : isTransientInfra
        ? `⚠️ Instabilidade transitória da Evolution API no Chip ${cfg.instance_name} (sem quebrar sequência de dias). Saúde: ${newHealth}%.`
        : `⚠️ Alerta de falha no Chip ${cfg.instance_name} (${errorsToday}/3 falhas). Saúde: ${newHealth}%.`,
    action_type: "circuit_breaker",
    details: {
      error: errorMessage,
      health_score: newHealth,
      is_quarantined: shouldQuarantine,
      transient_infra: isTransientInfra,
      immediate_quarantine: immediateQuarantine,
    },
  });

  if (/proxy|407|ECONNREFUSED|ETIMEDOUT|ECONNRESET|SOCKS|socket/i.test(errorMessage)) {
    const overview = await getProxyPoolOverviewCache().catch(() => ({ hasPool: false }));
    if (overview.hasPool) {
      await recordInstanceProxyStrike({
        instanceName: cfg.instance_name,
        clientId,
        errorMessage,
        isBan401Or403: immediateQuarantine,
      }).catch(() => null);
    }
  }
}

const _lastDisconnectReportAt = new Map<string, number>();
const DISCONNECT_REPORT_COOLDOWN_MS = 5 * 60 * 1000;
const _lastDisconnectAlertAt = new Map<string, number>();
const DISCONNECT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

export function resetDisconnectAlertCooldownForTests(): void {
  _lastDisconnectAlertAt.clear();
  _lastDisconnectReportAt.clear();
}

async function notifySevereDisconnectAlert(params: {
  clientId: string;
  instanceName: string;
  reasonStr: string;
  pausedCampaigns: number;
  nowMs: number;
}): Promise<void> {
  const { clientId, instanceName, reasonStr, pausedCampaigns, nowMs } = params;
  const cooldownKey = `${clientId}:${instanceName}`;
  const lastAlertAt = _lastDisconnectAlertAt.get(cooldownKey) || 0;
  if (nowMs - lastAlertAt < DISCONNECT_ALERT_COOLDOWN_MS) {
    return;
  }
  _lastDisconnectAlertAt.set(cooldownKey, nowMs);

  try {
    await supabaseAdmin.from("webhook_logs").insert({
      instance_name: instanceName,
      client_id: clientId,
      event: "INSTANCE_DISCONNECTED_ALERT",
      payload: {
        instance_name: instanceName,
        reason: reasonStr,
        paused_campaigns: pausedCampaigns,
      },
      created_at: new Date(nowMs).toISOString(),
    });
  } catch { }

  try {
    const { data: peers } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name, status")
      .eq("client_id", clientId);

    const peerRow = (Array.isArray(peers) ? peers : []).find((row) => {
      const name = String(row?.instance_name || "").trim();
      const status = String(row?.status || "").trim().toLowerCase();
      return name && name !== instanceName && (status === "open" || status === "connected");
    });
    const peerInstance = peerRow?.instance_name ? String(peerRow.instance_name).trim() : "";
    if (!peerInstance) return;

    let ownerPhone = "";
    try {
      const { data: agents } = await supabaseAdmin
        .from("agent_settings")
        .select("scheduler_config")
        .eq("client_id", clientId);
      for (const ag of Array.isArray(agents) ? agents : []) {
        const sched = (ag as { scheduler_config?: { owner_phone?: string } | null })?.scheduler_config;
        const candidate = String(sched?.owner_phone || "").replace(/\D/g, "");
        if (candidate.length >= 10) {
          ownerPhone = candidate;
          break;
        }
      }
    } catch { }

    if (!ownerPhone) {
      ownerPhone = String(process.env.ADMIN_WHATSAPP_PHONE || process.env.OWNER_PHONE || "").replace(/\D/g, "");
    }
    if (ownerPhone.length < 10) return;

    const ownerJid = `${ownerPhone}@s.whatsapp.net`;
    const alertText =
      `🚨 *ALERTA DE CHIP DESCONECTADO*\n\n` +
      `📱 Instância: *${instanceName}*\n` +
      `⚠️ Motivo: ${reasonStr}\n` +
      `⏸️ Campanhas pausadas automaticamente: ${pausedCampaigns}\n` +
      `🔄 Reconecte o QR Code no painel para retomar o atendimento.`;

    try {
      const { registerPendingAutomatedSend } = await import("@/lib/manual-send-registry");
      registerPendingAutomatedSend(peerInstance, ownerJid, alertText);
    } catch { }

    const { sendMessage } = await import("@/lib/channel");
    await sendMessage(ownerJid, alertText, peerInstance);
  } catch { }
}

/**
 * Responde a quedas/desconexões recebidas via webhook `connection.update`:
 * - Reporta falha ao circuito do Aquecedor (com cooldown de 5 min em oscilações comuns,
 *   ou imediato em erros 401/403/loggedOut/ban).
 * - Em logout/banimento severo, pausa campanhas exclusivas do chip para interromper disparos em erro.
 */
export async function handleWebhookConnectionClosed(params: {
  clientId: string;
  instanceName: string;
  statusReason?: unknown;
  nowMs?: number;
}): Promise<{ severe: boolean; pausedCampaigns: number }> {
  const { clientId, instanceName, statusReason, nowMs = Date.now() } = params;
  if (!clientId || !instanceName) return { severe: false, pausedCampaigns: 0 };

  const reasonStr = statusReason != null && String(statusReason).trim() ? String(statusReason).trim() : "desconexão";
  const severe = isSevereDisconnectReason(reasonStr);
  const lastAt = _lastDisconnectReportAt.get(instanceName) || 0;

  markPhoneDisconnected(clientId, instanceName, reasonStr, nowMs);

  if (severe || nowMs - lastAt >= DISCONNECT_REPORT_COOLDOWN_MS) {
    _lastDisconnectReportAt.set(instanceName, nowMs);
    try {
      const { data: wCfg } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("*")
        .eq("client_id", clientId)
        .eq("instance_name", instanceName)
        .maybeSingle();

      if (wCfg) {
        await handleInstanceFailure(
          clientId,
          wCfg as WarmupConfig,
          `[Webhook] Conexão fechada (${reasonStr})`,
          { immediateQuarantine: severe }
        );
      }
    } catch { }
  }

  let pausedCampaigns = 0;
  if (severe) {
    let resolvedPhone: string | null = null;
    try {
      const { data: wRow } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("phone_number")
        .eq("client_id", clientId)
        .eq("instance_name", instanceName)
        .maybeSingle();
      resolvedPhone = (wRow as { phone_number?: string | null } | null)?.phone_number || null;
      if (!resolvedPhone) {
        const { data: connRow } = await supabaseAdmin
          .from("channel_connections")
          .select("provider_config")
          .eq("client_id", clientId)
          .eq("instance_name", instanceName)
          .maybeSingle();
        const pCfg = (connRow as { provider_config?: Record<string, unknown> | null } | null)?.provider_config;
        const owner = pCfg?.owner_phone || pCfg?.owner_jid;
        if (owner) resolvedPhone = String(owner);
      }
    } catch { /* ignore */ }

    const rehabEntry = await markPhonePostBanRehab({
      clientId,
      instanceName,
      phone: resolvedPhone,
      reason: reasonStr,
      nowMs,
    }).catch(() => null);

    try {
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({
          career_mode: "rehab",
          rehab_until: rehabEntry?.rehabUntil || new Date(nowMs + 72 * 60 * 60 * 1000).toISOString(),
          cold_outreach_locked_until:
            rehabEntry?.coldOutreachLockedUntil || new Date(nowMs + 96 * 60 * 60 * 1000).toISOString(),
          updated_at: new Date(nowMs).toISOString(),
        })
        .eq("client_id", clientId)
        .eq("instance_name", instanceName);
    } catch {
      /* schema sem 031 segue com passaporte em app_settings */
    }

    try {
      const { data: paused } = await supabaseAdmin
        .from("campaigns")
        .update({
          status: "paused",
          last_error: `Instância "${instanceName}" desconectada/bloqueada (${reasonStr}). Campanha pausada automaticamente.`,
          last_error_at: new Date(nowMs).toISOString(),
          updated_at: new Date(nowMs).toISOString(),
        })
        .eq("client_id", clientId)
        .eq("instance_name", instanceName)
        .eq("status", "running")
        .select("id");
      pausedCampaigns = Array.isArray(paused) ? paused.length : 0;
    } catch { }

    await notifySevereDisconnectAlert({
      clientId,
      instanceName,
      reasonStr,
      pausedCampaigns,
      nowMs,
    });

    const overview = await getProxyPoolOverviewCache().catch(() => ({ hasPool: false }));
    if (overview.hasPool) {
      await recordInstanceProxyStrike({
        instanceName,
        clientId,
        errorMessage: reasonStr,
        isBan401Or403: true,
      }).catch(() => null);
      await blacklistInstanceProxy(instanceName, "banned", reasonStr).catch(() => null);
    }
  }

  return { severe, pausedCampaigns };
}

const DELIVERY_BURST_WINDOW_MS = 10 * 60 * 1000;
const DELIVERY_BURST_THRESHOLD = 3;
const DELIVERY_COOLDOWN_MS = 5 * 60 * 1000;
const _deliveryErrorBurstByInstance = new Map<string, number[]>();
const _deliveryFeedbackCooldown = new Map<string, number>();

export function resetDeliveryFeedbackForTests(): void {
  _deliveryErrorBurstByInstance.clear();
  _deliveryFeedbackCooldown.clear();
}

/**
 * Fecha o loop entre eventos `messages.update` do WhatsApp e o Disjuntor do Aquecedor:
 * - Confirmação positiva (`delivered`, `read`, `played`) zera a janela de erros da instância.
 * - >= 3 falhas de entrega (`error` / `failed`) dentro de 10 minutos acionam `handleInstanceFailure`,
 *   reduzindo o health_score e colocando o chip em quarentena preventiva após reincidência.
 */
export async function recordWebhookDeliveryFeedback(params: {
  clientId: string;
  instanceName: string;
  statusText: string;
  nowMs?: number;
}): Promise<{ triggered: boolean; cleared: boolean; recentErrors: number }> {
  const { clientId, instanceName, statusText, nowMs = Date.now() } = params;
  if (!clientId || !instanceName || !statusText) {
    return { triggered: false, cleared: false, recentErrors: 0 };
  }

  const key = `${clientId}:${instanceName}`;
  const normalized = statusText.toLowerCase();

  if (normalized === "delivered" || normalized === "read" || normalized === "played") {
    _deliveryErrorBurstByInstance.delete(key);
    return { triggered: false, cleared: true, recentErrors: 0 };
  }

  if (normalized !== "error" && normalized !== "failed") {
    return { triggered: false, cleared: false, recentErrors: 0 };
  }

  const cutoff = nowMs - DELIVERY_BURST_WINDOW_MS;
  const recent = (_deliveryErrorBurstByInstance.get(key) || []).filter((ts) => ts >= cutoff);
  recent.push(nowMs);
  _deliveryErrorBurstByInstance.set(key, recent);

  const lastTriggered = _deliveryFeedbackCooldown.get(key) || 0;
  if (recent.length >= DELIVERY_BURST_THRESHOLD && nowMs - lastTriggered >= DELIVERY_COOLDOWN_MS) {
    _deliveryErrorBurstByInstance.delete(key);
    _deliveryFeedbackCooldown.set(key, nowMs);
    try {
      const { data: wCfg } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("*")
        .eq("client_id", clientId)
        .eq("instance_name", instanceName)
        .maybeSingle();

      if (wCfg) {
        await handleInstanceFailure(
          clientId,
          wCfg as WarmupConfig,
          `[Webhook] Surto de falhas de entrega (${recent.length}x em 10 min via messages.update)`
        );
        return { triggered: true, cleared: false, recentErrors: recent.length };
      }
    } catch { }
  }

  return { triggered: false, cleared: false, recentErrors: recent.length };
}

/**
 * Esteira automática de carreira do chip (Plug & Play Zero-Toque):
 * - Fase 1 / Dias 1..3 (Berçário): permanece em "contingency" (bloqueado de disparo frio).
 * - Fase 2 / Dias 4..7 (Pré-Prospecção): gradua de "contingency" -> "inbound".
 * - Fase 3+ / Dia 8+ com saúde >= 70 (Produção): gradua -> "outbound" para o pool de campanhas.
 */
export function getAutoCareerPurpose(opts: {
  currentPurpose?: WarmupPurpose | null;
  stage: WarmupStage;
  daysActive: number;
  healthScore?: number | null;
  autoProgress?: boolean;
}): { nextPurpose: WarmupPurpose; graduated: boolean } {
  const current = (opts.currentPurpose || "contingency") as WarmupPurpose;
  if (opts.autoProgress === false) {
    return { nextPurpose: current, graduated: false };
  }

  const health = opts.healthScore ?? 100;
  let target: WarmupPurpose = current;

  if (opts.stage >= 3 && opts.daysActive >= 8 && health >= 70) {
    if (current === "contingency" || current === "inbound") {
      target = "outbound";
    }
  } else if (opts.stage >= 2 && opts.daysActive >= 4) {
    if (current === "contingency") {
      target = "inbound";
    }
  }

  return {
    nextPurpose: target,
    graduated: target !== current,
  };
}

/**
 * Avalia a progressão de dias e promoção/reconciliação de estágio do piloto automático.
 *
 * `lastResetDay` (YYYY-MM-DD, fuso Brasil) evita reset a cada tick quando o
 * chip não envia nada: sem ele, `last_activity_at` antigo marcava "novo dia"
 * a cada 60s e inflava `days_active` (bug observado: 624 dias).
 */
export function evaluateDailyAutoProgress(
  cfg: WarmupConfig,
  nowIso: string = new Date().toISOString(),
  lastResetDay?: string | null
): {
  isNewDay: boolean;
  stagePromoted: boolean;
  stageReconciled?: boolean;
  purposeGraduated: boolean;
  newStage: WarmupStage;
  newPurpose: WarmupPurpose;
  newDaysActive: number;
  newConsecutiveDays: number;
  newDailyTarget: number;
  stageInfo: (typeof STAGE_DEFAULTS)[WarmupStage];
} {
  const todayKey = getBrazilDayKey(nowIso);
  const isNewDay = lastResetDay
    ? lastResetDay !== todayKey
    : cfg.last_activity_at
      ? !isSameBrazilDay(cfg.last_activity_at, nowIso)
      : false;

  const curStage = (cfg.stage || 1) as WarmupStage;
  const curPurpose = (cfg.purpose || "contingency") as WarmupPurpose;

  if (!isNewDay) {
    return {
      isNewDay: false,
      stagePromoted: false,
      stageReconciled: false,
      purposeGraduated: false,
      newStage: curStage,
      newPurpose: curPurpose,
      newDaysActive: cfg.days_active || 1,
      newConsecutiveDays: cfg.consecutive_successful_days || 0,
      newDailyTarget: cfg.daily_target || STAGE_DEFAULTS[curStage].dailyTarget,
      stageInfo: STAGE_DEFAULTS[curStage],
    };
  }

  const hadSuccess = (cfg.sent_today || 0) > 0 && (cfg.error_count_today || 0) === 0;
  const newConsecutiveDays = hadSuccess
    ? (cfg.consecutive_successful_days || 0) + 1
    : Math.max(0, (cfg.consecutive_successful_days || 0) - 1);

  // Dias ativos: só avança quando houve tráfego real no dia anterior e limita saltos após hiatos offline (>=48h)
  const elapsedFromCreated = calculateElapsedDaysFromCreatedAt(cfg.created_at, nowIso);
  const hadWarmupActivity = (cfg.sent_today || 0) > 0 || (cfg.received_today || 0) > 0;
  const lastActMs = cfg.last_activity_at ? new Date(cfg.last_activity_at).getTime() : NaN;
  const nowMs = new Date(nowIso).getTime();
  const hasOfflineGap =
    Number.isFinite(lastActMs) && Number.isFinite(nowMs) && nowMs - lastActMs >= 48 * 60 * 60 * 1000;

  let newDaysActive: number;
  if (!hadWarmupActivity) {
    // Dia offline/ocioso: nunca promove dias ativos à força
    newDaysActive =
      elapsedFromCreated !== null ? Math.min(elapsedFromCreated, cfg.days_active || 1) : (cfg.days_active || 1);
  } else if (hasOfflineGap) {
    // Voltou após >=48h parado: avança apenas +1 dia real de uso por ciclo, nunca saltando dias offline
    const incremental = (cfg.days_active || 1) + 1;
    newDaysActive = elapsedFromCreated !== null ? Math.min(elapsedFromCreated, incremental) : incremental;
  } else {
    newDaysActive = elapsedFromCreated ?? (cfg.days_active || 1) + 1;
  }

  let newStage: WarmupStage = curStage;
  let stagePromoted = false;
  let stageReconciled = false;

  // Reconciliação de segurança: se o chip tem created_at real e está em uma fase
  // acima do permitido pela sua idade real (ex: herança do bug antigo de 624 dias),
  // ajusta para a fase compatível com a idade real.
  if (cfg.stage_auto_progress !== false && elapsedFromCreated !== null) {
    const maxAllowedStage = getMaxStageForDaysActive(newDaysActive);
    if (curStage > maxAllowedStage) {
      newStage = maxAllowedStage;
      stageReconciled = true;
    }
  }

  // PILOTO AUTOMÁTICO DE ESCADA DE FASES
  // Só promove com dias suficientes E pelo menos 2 dias consecutivos saudáveis.
  if (cfg.stage_auto_progress !== false && newConsecutiveDays >= 2 && !stageReconciled) {
    if (newStage === 1 && newDaysActive >= 4) {
      newStage = 2;
      stagePromoted = true;
    } else if (newStage === 2 && newDaysActive >= 8) {
      newStage = 3;
      stagePromoted = true;
    } else if (newStage === 3 && newDaysActive >= 13) {
      newStage = 4;
      stagePromoted = true;
    }
  }

  const career = getAutoCareerPurpose({
    currentPurpose: cfg.purpose,
    stage: newStage,
    daysActive: newDaysActive,
    healthScore: cfg.health_score,
    autoProgress: cfg.stage_auto_progress,
  });

  const stageInfo = STAGE_DEFAULTS[newStage];

  return {
    isNewDay: true,
    stagePromoted,
    stageReconciled,
    purposeGraduated: career.graduated,
    newStage,
    newPurpose: career.nextPurpose,
    newDaysActive,
    newConsecutiveDays,
    newDailyTarget:
      stagePromoted || stageReconciled
        ? stageInfo.dailyTarget
        : cfg.daily_target || stageInfo.dailyTarget,
    stageInfo,
  };
}

/**
 * Avalia se um chip em `rehab` pós-banimento já cumpriu a janela mínima de 72h,
 * recuperou saúde (>= 75%) e acumulou >= 3 dias consecutivos limpos para voltar a `maturing`.
 */
export function evaluateRehabGraduation(
  cfg: WarmupConfig,
  nowIso: string = new Date().toISOString()
): { graduated: boolean; nextCareerMode: "maturing" | "rehab" } {
  if (cfg.career_mode !== "rehab") {
    return { graduated: false, nextCareerMode: "maturing" };
  }
  const nowMs = new Date(nowIso).getTime();
  const rehabUntilMs = cfg.rehab_until ? new Date(cfg.rehab_until).getTime() : 0;
  const healthOk = (cfg.health_score ?? 100) >= 75;
  const daysOk = (cfg.consecutive_successful_days ?? 0) >= 3;
  const windowElapsed = !rehabUntilMs || nowMs >= rehabUntilMs;

  if (windowElapsed && healthOk && daysOk) {
    return { graduated: true, nextCareerMode: "maturing" };
  }
  return { graduated: false, nextCareerMode: "rehab" };
}

/**
 * Rotina isolada de publicação no WhatsApp Status (Stories):
 * Executa fora do turno de mensagem para evitar timeout encadeado na Evolution API
 * e só grava `last_status_post_at` + log se o provedor confirmar o envio.
 */
export async function runIsolatedStatusPost(opts: {
  clientId: string;
  senderConfig: WarmupConfig;
  peerPhones?: string[];
  force?: boolean;
}): Promise<{ posted: boolean; quote?: string }> {
  const { clientId, senderConfig, peerPhones = [], force = false } = opts;
  if (!force && senderConfig.enable_status_posts === false) {
    return { posted: false };
  }
  if (
    !force &&
    senderConfig.is_quarantined &&
    (!senderConfig.quarantine_until || new Date(senderConfig.quarantine_until) > new Date())
  ) {
    return { posted: false };
  }

  const statusIntervalMs = (24 + Math.floor(Math.random() * 12)) * 60 * 60 * 1000;
  const isDue =
    force ||
    !senderConfig.last_status_post_at ||
    Date.now() - new Date(senderConfig.last_status_post_at).getTime() > statusIntervalMs;

  if (!isDue) return { posted: false };

  try {
    const quote = getRandomStatusQuote();
    const statusRes = (await evolution.sendStatus(
      quote,
      "text",
      senderConfig.instance_name,
      peerPhones
    )) as { key?: { id?: string }; id?: string; data?: { key?: { id?: string } } } | null;
    if (!statusRes) {
      return { posted: false };
    }
    const statusId = statusRes?.key?.id || statusRes?.id || statusRes?.data?.key?.id;
    if (statusId) registerWarmupSend(statusId);

    const postedAt = new Date().toISOString();
    await supabaseAdmin
      .from("whatsapp_warmup_configs")
      .update({ last_status_post_at: postedAt })
      .eq("instance_name", senderConfig.instance_name)
      .eq("client_id", clientId);

    await logWarmupAction({
      client_id: clientId,
      sender_instance: senderConfig.instance_name,
      receiver_instance: "status@broadcast",
      message_text: `Publicou Story no WhatsApp Status: "${quote}"`,
      action_type: "status",
      details: { isolated: !force, message_id: statusId || null },
    });

    return { posted: true, quote };
  } catch {
    return { posted: false };
  }
}

/**
 * Executa um turno avançado de aquecimento com toda a gama de comportamentos humanos:
 * vCard, Digitação, Texto ou Áudio Opus PTT recodificado, Tiques Azuis variáveis,
 * Reações variáveis e Status.
 */
export async function executeWarmupTurn(opts: {
  clientId: string;
  senderConfig: WarmupConfig;
  receiverConfig: WarmupConfig;
  conversation: WarmupConversation;
  isManualTrigger?: boolean;
  forceStatusPost?: boolean;
  forceVCard?: boolean;
}): Promise<{ success: boolean; messageText: string; error?: string }> {
  const {
    clientId,
    senderConfig,
    receiverConfig,
    conversation,
    isManualTrigger,
    forceStatusPost,
    forceVCard,
  } = opts;

  // 1. Checagem de Quarentena (Circuit Breaker)
  if (senderConfig.is_quarantined && !isManualTrigger) {
    if (senderConfig.quarantine_until && new Date(senderConfig.quarantine_until) > new Date()) {
      return { success: false, messageText: "", error: "chip_in_quarantine" };
    }
  }

  // 2. Checagem de Horário Operacional
  if (!isManualTrigger) {
    const inHours = isWithinOperatingHours(
      senderConfig.allowed_start_hour ?? 8,
      senderConfig.allowed_end_hour ?? 21
    );
    if (!inHours) {
      return { success: false, messageText: "", error: "outside_hours" };
    }
  }

  // 3. Resolução dos telefones
  const receiverPhone = await resolveInstancePhone(receiverConfig.instance_name, clientId);
  const senderPhone = await resolveInstancePhone(senderConfig.instance_name, clientId);

  if (!receiverPhone) {
    const errorMsg = `Telefone do chip destinatário (${receiverConfig.instance_name}) não encontrado.`;
    await logWarmupAction({
      client_id: clientId,
      sender_instance: senderConfig.instance_name,
      receiver_instance: receiverConfig.instance_name,
      message_text: `⚠️ Turno ignorado: ${errorMsg} Nenhum envio foi feito e a saúde do remetente foi preservada.`,
      action_type: "system",
    });
    return { success: false, messageText: "", error: errorMsg };
  }

  if (senderPhone && senderPhone === receiverPhone) {
    const errorMsg = `Remetente e destinatário apontam para o mesmo telefone (${receiverPhone}).`;
    await logWarmupAction({
      client_id: clientId,
      sender_instance: senderConfig.instance_name,
      receiver_instance: receiverConfig.instance_name,
      message_text: `⚠️ Turno ignorado: ${errorMsg} Configure o número correto do chip para evitar autoenvio.`,
      action_type: "system",
    });
    return { success: false, messageText: "", error: errorMsg };
  }

  const targetJid = `${receiverPhone}@s.whatsapp.net`;

  // 4. TROCA DE vCARD (Cartão de Contato na Agenda) - Realizada no primeiro turno entre os dois chips
  const vcardPeers = senderConfig.vcard_exchanged_peers || [];
  const shouldExchangeVCard =
    (forceVCard || !isManualTrigger) &&
    senderConfig.enable_vcard !== false &&
    !vcardPeers.includes(receiverConfig.instance_name) &&
    Boolean(senderPhone);

  if (shouldExchangeVCard && senderPhone) {
    try {
      await logWarmupAction({
        client_id: clientId,
        sender_instance: senderConfig.instance_name,
        receiver_instance: receiverConfig.instance_name,
        sender_phone: senderPhone,
        receiver_phone: receiverPhone,
        message_text: `Enviando cartão de contato (vCard de ${senderConfig.instance_name}) para salvar na agenda de ${receiverConfig.instance_name}...`,
        action_type: "vcard",
      });

      const vcardRes: any = await evolution.sendContact(
        targetJid,
        [{ fullName: senderConfig.instance_name, phoneNumber: senderPhone }],
        senderConfig.instance_name
      );
      registerWarmupSend(vcardRes?.key?.id || vcardRes?.data?.key?.id || vcardRes?.id);

      const updatedPeers = [...vcardPeers, receiverConfig.instance_name];
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({ vcard_exchanged_peers: updatedPeers })
        .eq("instance_name", senderConfig.instance_name)
        .eq("client_id", clientId);
    } catch { }
  }

  // 5. POSTAGEM DE STATUS (WhatsApp Stories) — Desacoplada do turno automático
  // Apenas dispara inline no teste manual explícito (`forceStatusPost`). No automático,
  // roda isoladamente no worker para não competir no mesmo socket e causar timeouts.
  if (forceStatusPost && senderConfig.enable_status_posts !== false) {
    await runIsolatedStatusPost({
      clientId,
      senderConfig,
      peerPhones: receiverPhone ? [receiverPhone] : [],
      force: true,
    });
  }

  // 6. Seleção orgânica de modalidade e geração da mensagem (Áudio, Figurinha, Imagem, Enquete ou Texto)
  const isTestEnv = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const hasSendMedia = typeof (evolution as { sendMedia?: unknown }).sendMedia === "function";
  const hasSendSticker = typeof (evolution as { sendSticker?: unknown }).sendSticker === "function";
  const hasSendPoll = typeof (evolution as { sendPoll?: unknown }).sendPoll === "function";

  const mediaRoll = Math.random();
  const isAudioTurn = senderConfig.enable_audio !== false && senderConfig.stage >= 2 && hasSendMedia && mediaRoll < 0.16;
  const isStickerTurn = !isAudioTurn && !isManualTrigger && senderConfig.stage >= 2 && hasSendSticker && mediaRoll >= 0.16 && mediaRoll < 0.26;
  const isImageTurn = !isAudioTurn && !isStickerTurn && !isManualTrigger && senderConfig.stage >= 2 && hasSendMedia && mediaRoll >= 0.26 && mediaRoll < 0.33;
  const isPollTurn = !isAudioTurn && !isStickerTurn && !isImageTurn && !isManualTrigger && senderConfig.stage >= 3 && hasSendPoll && mediaRoll >= 0.33 && mediaRoll < 0.35;

  let turnActionType: WarmupLog["action_type"] = "text";
  let messageText = "";
  let genResult = { provider: "native", modelUsed: "dialogue_bank" };
  let stickerB64: string | null = null;
  let imagePayload: { base64: string; mimetype: string; caption: string; sha256: string } | null = null;
  let pollPayload: { name: string; values: string[]; selectableCount: number } | null = null;

  if (isAudioTurn) {
    turnActionType = "audio";
    messageText = getRandomCasualVoiceNote();
  } else if (isStickerTurn) {
    turnActionType = "sticker";
    const stk = createDynamicWarmupSticker(`${senderConfig.instance_name}:${conversation.id}`);
    stickerB64 = stk.base64;
    messageText = "[Figurinha enviada]";
    genResult = { provider: "native_media", modelUsed: `webp_vp8l_${stk.sha256.slice(0, 8)}` };
  } else if (isImageTurn) {
    turnActionType = "image";
    imagePayload = createDynamicWarmupImage(`${senderConfig.instance_name}:${conversation.id}`);
    messageText = imagePayload.caption || "[Foto casual enviada]";
    genResult = { provider: "native_media", modelUsed: `png_${imagePayload.sha256.slice(0, 8)}` };
  } else if (isPollTurn) {
    turnActionType = "poll";
    pollPayload = pickCasualWarmupPoll(`${senderConfig.instance_name}:${conversation.id}`);
    messageText = `📊 Enquete: ${pollPayload.name}`;
    genResult = { provider: "native_poll", modelUsed: "casual_poll_pt_br" };
  } else {
    const speakerRole = conversation.turn_count % 2 === 0 ? "A" : "B";
    const generated = await generateWarmupMessage({
      theme: conversation.topic || senderConfig.ai_theme || "dia_a_dia",
      speakerRole,
      history: conversation.history || [],
      aiModel: senderConfig.ai_model,
      customPrompt: senderConfig.custom_prompt,
      senderInstance: senderConfig.instance_name,
      clientId,
      conversationId: conversation.id,
    });
    messageText = generated.text;
    genResult = { provider: generated.provider, modelUsed: generated.modelUsed };
  }

  // 7. Simulação de Digitação Humana (com hesitação natural ocasional) ou Gravação de Áudio
  if (senderConfig.enable_typing && !isStickerTurn && !isPollTurn) {
    const presenceType = isAudioTurn ? "recording" : "composing";
    const typingMs = calculateTypingDuration(
      messageText.length,
      senderConfig.min_typing_seconds || 3,
      senderConfig.max_typing_seconds || 10
    );

    await logWarmupAction({
      client_id: clientId,
      sender_instance: senderConfig.instance_name,
      receiver_instance: receiverConfig.instance_name,
      sender_phone: senderPhone,
      receiver_phone: receiverPhone,
      message_text: `Simulando ${isAudioTurn ? "gravação de áudio..." : "digitação humana..."} (${Math.round(typingMs / 1000)}s)`,
      action_type: "presence",
      details: { typing_ms: typingMs, presence: presenceType },
    });

    try {
      await evolution.sendPresence(targetJid, presenceType, senderConfig.instance_name);
    } catch { }

    const effectiveWait = isManualTrigger ? Math.min(typingMs, 3500) : typingMs;
    await new Promise((r) => setTimeout(r, effectiveWait));

    // Hesitação humana (~15% em texto automático): para brevemente e retoma antes de enviar
    if (!isAudioTurn && !isImageTurn && !isManualTrigger && Math.random() < 0.15) {
      try {
        await evolution.sendPresence(targetJid, "paused", senderConfig.instance_name);
        await new Promise((r) => setTimeout(r, isTestEnv ? 10 : 750 + Math.floor(Math.random() * 650)));
        await evolution.sendPresence(targetJid, "composing", senderConfig.instance_name);
        await new Promise((r) => setTimeout(r, isTestEnv ? 10 : 900 + Math.floor(Math.random() * 800)));
      } catch { }
    }
  }

  // Determina se haverá citação (`quoted`) ou divisão natural de frase em 2 partes
  let quotedOpt: { key: { id: string; fromMe: boolean; remoteJid: string } } | undefined;
  if (turnActionType === "text" && !isManualTrigger && Math.random() < 0.25) {
    const lastPartnerWithId = [...(conversation.history || [])]
      .reverse()
      .find((h) => h.sender !== senderConfig.instance_name && h.message_id);
    if (lastPartnerWithId?.message_id) {
      quotedOpt = {
        key: { id: lastPartnerWithId.message_id, fromMe: false, remoteJid: targetJid },
      };
    }
  }

  const splitParts = (() => {
    if (turnActionType !== "text" || isManualTrigger || quotedOpt || messageText.length < 36 || Math.random() >= 0.15) {
      return null;
    }
    const sepMatch = messageText.match(/^(.{12,60}?)([?!.,])\s+(.{10,})$/) ||
      messageText.match(/^(.{12,60}?)\s+(?:mas|então|porque)\s+(.{10,})$/i);
    if (!sepMatch) return null;
    if (sepMatch.length === 4) {
      const p1 = `${sepMatch[1].trim()}${sepMatch[2] === "," ? "" : sepMatch[2]}`.trim();
      return [p1, sepMatch[3].trim()] as const;
    }
    return [sepMatch[1].trim(), sepMatch[2].trim()] as const;
  })();

  // 8. Envio Efetivo (Áudio, Figurinha, Foto única, Enquete ou Texto com quoted/split orgânico)
  const senderProvider = await resolveWarmupChannelProvider(clientId, senderConfig.instance_name);
  const useChannelGo = senderProvider === "evolution_go";
  let sendResult: any = null;
  try {
    if (isAudioTurn) {
      const voiceB64 = getRandomWarmupVoiceBase64() || CASUAL_OPUS_BASE64;
      sendResult = useChannelGo
        ? await channel.sendMedia(
          targetJid,
          "",
          { type: "audio", base64: voiceB64, mimetype: "audio/ogg; codecs=opus" },
          senderConfig.instance_name,
          { delay: 1200 + Math.floor(Math.random() * 900) },
        )
        : await evolution.sendMedia(
          targetJid,
          "",
          { type: "audio", base64: voiceB64, mimetype: "audio/ogg; codecs=opus" },
          senderConfig.instance_name,
          { delay: 1200 + Math.floor(Math.random() * 900), encoding: true }
        );
    } else if (isStickerTurn && stickerB64) {
      sendResult = await evolution.sendSticker(targetJid, stickerB64, senderConfig.instance_name, {
        delay: 700 + Math.floor(Math.random() * 600),
      });
    } else if (isImageTurn && imagePayload) {
      sendResult = useChannelGo
        ? await channel.sendMedia(
          targetJid,
          imagePayload.caption,
          { type: "image", base64: imagePayload.base64, mimetype: imagePayload.mimetype },
          senderConfig.instance_name,
          { delay: 1100 + Math.floor(Math.random() * 900) },
        )
        : await evolution.sendMedia(
          targetJid,
          imagePayload.caption,
          { type: "image", base64: imagePayload.base64, mimetype: imagePayload.mimetype },
          senderConfig.instance_name,
          { delay: 1100 + Math.floor(Math.random() * 900) }
        );
    } else if (isPollTurn && pollPayload) {
      sendResult = await evolution.sendPoll(
        targetJid,
        pollPayload.name,
        pollPayload.values,
        pollPayload.selectableCount,
        senderConfig.instance_name
      );
    } else if (splitParts) {
      const part1Res: any = useChannelGo
        ? await channel.sendMessage(targetJid, splitParts[0], senderConfig.instance_name)
        : await evolution.sendTextMessage(targetJid, splitParts[0], senderConfig.instance_name);
      registerWarmupSend(part1Res?.key?.id || part1Res?.id || part1Res?.messageId || part1Res?.data?.key?.id);
      if (senderConfig.enable_typing) {
        try {
          await evolution.sendPresence(targetJid, "composing", senderConfig.instance_name);
        } catch { }
        await new Promise((r) => setTimeout(r, isTestEnv ? 10 : 800 + Math.floor(Math.random() * 900)));
      }
      sendResult = useChannelGo
        ? await channel.sendMessage(targetJid, splitParts[1], senderConfig.instance_name)
        : await evolution.sendTextMessage(targetJid, splitParts[1], senderConfig.instance_name);
    } else if (quotedOpt) {
      sendResult = useChannelGo
        ? await channel.sendMessage(targetJid, messageText, senderConfig.instance_name)
        : await evolution.sendTextMessage(targetJid, messageText, senderConfig.instance_name, {
          quoted: quotedOpt,
        });
    } else {
      sendResult = useChannelGo
        ? await channel.sendMessage(targetJid, messageText, senderConfig.instance_name)
        : await evolution.sendTextMessage(targetJid, messageText, senderConfig.instance_name);
    }
    if (sendResult && typeof sendResult === "object" && "ok" in sendResult && sendResult.ok === false) {
      throw new Error(String(sendResult.error || "Falha no provedor WhatsApp"));
    }
  } catch (err: any) {
    const rawErrMsg = err?.message || String(err);
    const errorMsg = `Erro ao enviar no WhatsApp: ${rawErrMsg}`;
    await handleInstanceFailure(clientId, senderConfig, errorMsg, {
      isTransientInfra: isTransientInfraError(rawErrMsg),
    });
    return { success: false, messageText, error: errorMsg };
  }

  const messageId =
    sendResult?.key?.id ||
    sendResult?.id ||
    sendResult?.messageId ||
    sendResult?.data?.key?.id ||
    `wup_${Date.now()}`;
  registerWarmupSend(messageId);

  // Log do Envio com Sucesso
  await logWarmupAction({
    client_id: clientId,
    sender_instance: senderConfig.instance_name,
    receiver_instance: receiverConfig.instance_name,
    sender_phone: senderPhone,
    receiver_phone: receiverPhone,
    message_text: isAudioTurn
      ? `🎤 Áudio PTT gravado na hora: "${messageText}"`
      : isStickerTurn
        ? "🎭 Enviou figurinha WebP exclusiva para manter naturalidade"
        : isImageTurn
          ? `🖼️ Enviou imagem exclusiva${imagePayload?.caption ? `: "${imagePayload.caption}"` : ""}`
          : messageText,
    action_type: turnActionType,
    details: {
      message_id: messageId,
      provider: genResult.provider,
      model_used: genResult.modelUsed,
      turn: conversation.turn_count + 1,
      quoted: Boolean(quotedOpt),
      split_parts: Boolean(splitParts),
    },
  });

  // 9. Confirmação de Leitura e Tique Azul no Destinatário (com Atraso Humano Variável + Fila Persistente)
  if (receiverConfig.enable_blue_ticks !== false && senderPhone) {
    const senderJid = `${senderPhone}@s.whatsapp.net`;
    const readDelayMs = calculateReadReceiptDelayMs(Boolean(isManualTrigger));

    const performReadConfirmation = async () => {
      try {
        await evolution.markMessageAsRead(
          [{ remoteJid: senderJid, id: messageId, fromMe: false }],
          receiverConfig.instance_name
        );
        await logWarmupAction({
          client_id: clientId,
          sender_instance: receiverConfig.instance_name,
          receiver_instance: senderConfig.instance_name,
          sender_phone: receiverPhone,
          receiver_phone: senderPhone,
          message_text: `Visualizou e confirmou leitura da mensagem (tiques azuis exibidos após ${Math.round(readDelayMs / 1000)}s)`,
          action_type: "presence",
          details: { message_id: messageId, delay_ms: readDelayMs, read_receipt: true },
        });
      } catch (err: any) {
        console.error(`[WARMUP] Erro ao marcar como lido em ${receiverConfig.instance_name}:`, err?.message);
      }
    };

    if (isManualTrigger) {
      await new Promise((r) => setTimeout(r, Math.min(readDelayMs, 3500)));
      await performReadConfirmation();
    } else {
      const queuedRead = await enqueuePendingWarmupAction(clientId, {
        type: "read",
        dueAt: Date.now() + readDelayMs,
        actorInstance: receiverConfig.instance_name,
        peerInstance: senderConfig.instance_name,
        actorPhone: receiverPhone,
        peerPhone: senderPhone,
        targetJid: senderJid,
        messageId,
        delayMs: readDelayMs,
      }).catch(() => null);
      const t = setTimeout(() => {
        if (queuedRead) {
          void claimAndRunPendingWarmupAction(clientId, queuedRead.id);
        } else {
          void performReadConfirmation();
        }
      }, readDelayMs);
      if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
    }
  }

  // 10. Reação de Emoji (probabilidade ~28% com atraso humano variável + Fila Persistente)
  if (receiverConfig.enable_reactions !== false && senderPhone && (isManualTrigger || Math.random() < 0.28)) {
    const reactionEmoji = getRandomReaction();
    const reactionDelayMs = calculateReactionDelayMs(Boolean(isManualTrigger));

    const performReaction = async () => {
      try {
        const senderJid = `${senderPhone}@s.whatsapp.net`;
        const reactRes: any = await evolution.sendReaction(
          senderJid,
          messageId,
          reactionEmoji,
          receiverConfig.instance_name,
          false
        );
        registerWarmupSend(reactRes?.key?.id || reactRes?.data?.key?.id || reactRes?.id);
        await logWarmupAction({
          client_id: clientId,
          sender_instance: receiverConfig.instance_name,
          receiver_instance: senderConfig.instance_name,
          sender_phone: receiverPhone,
          receiver_phone: senderPhone,
          message_text: `Reagiu com ${reactionEmoji} à mensagem anterior`,
          action_type: "reaction",
          details: { reaction: reactionEmoji, target_msg_id: messageId, delay_ms: reactionDelayMs },
        });
      } catch { }
    };

    if (isManualTrigger) {
      await new Promise((r) => setTimeout(r, reactionDelayMs));
      await performReaction();
    } else {
      const senderJid = `${senderPhone}@s.whatsapp.net`;
      const queuedReact = await enqueuePendingWarmupAction(clientId, {
        type: "react",
        dueAt: Date.now() + reactionDelayMs,
        actorInstance: receiverConfig.instance_name,
        peerInstance: senderConfig.instance_name,
        actorPhone: receiverPhone,
        peerPhone: senderPhone,
        targetJid: senderJid,
        messageId,
        delayMs: reactionDelayMs,
        emoji: reactionEmoji,
      }).catch(() => null);
      const t = setTimeout(() => {
        if (queuedReact) {
          void claimAndRunPendingWarmupAction(clientId, queuedReact.id);
        } else {
          void performReaction();
        }
      }, reactionDelayMs);
      if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
    }
  }

  // 11. Atualização dos contadores diários e pontuação de saúde
  const nowIso = new Date().toISOString();
  const sameDay = senderConfig.last_activity_at
    ? isSameBrazilDay(senderConfig.last_activity_at, nowIso)
    : true;

  const newSent = sameDay ? (senderConfig.sent_today || 0) + 1 : 1;
  const newHealth = Math.min(100, (senderConfig.health_score ?? 100) + 1);

  await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .update({
      sent_today: newSent,
      health_score: newHealth,
      last_activity_at: nowIso,
      updated_at: nowIso,
    })
    .eq("instance_name", senderConfig.instance_name)
    .eq("client_id", clientId);

  const receiverSameDay = receiverConfig.last_activity_at
    ? isSameBrazilDay(receiverConfig.last_activity_at, nowIso)
    : true;
  const newReceived = receiverSameDay ? (receiverConfig.received_today || 0) + 1 : 1;

  await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .update({
      received_today: newReceived,
      health_score: Math.min(100, (receiverConfig.health_score ?? 100) + 1),
      last_activity_at: nowIso,
      updated_at: nowIso,
    })
    .eq("instance_name", receiverConfig.instance_name)
    .eq("client_id", clientId);

  // Atualiza snapshot persistente no Passaporte do Número (sem impactar performance do turno)
  if (senderPhone) {
    savePhoneMemoryFromConfig(clientId, {
      ...senderConfig,
      phone_number: senderConfig.phone_number || senderPhone,
      sent_today: newSent,
      health_score: newHealth,
      last_activity_at: nowIso,
    }).catch(() => { });
  }
  if (receiverPhone) {
    savePhoneMemoryFromConfig(clientId, {
      ...receiverConfig,
      phone_number: receiverConfig.phone_number || receiverPhone,
      received_today: newReceived,
      health_score: Math.min(100, (receiverConfig.health_score ?? 100) + 1),
      last_activity_at: nowIso,
    }).catch(() => { });
  }

  // 12. Atualização da conversa ativa (com cooldown longo ao encerrar sessão e jitter nos segundos)
  const updatedTurnCount = conversation.turn_count + 1;
  const isFinished = updatedTurnCount >= conversation.max_turns;

  const minSec = senderConfig.min_interval_seconds || 90;
  const maxSec = senderConfig.max_interval_seconds || 300;
  const turnIntervalSec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
  const secondJitter = isTestEnv ? 0 : Math.floor(Math.random() * 47);
  const nextIntervalSec = isFinished
    ? calculateInterConversationCooldownSec(senderConfig.stage || 1) + secondJitter
    : turnIntervalSec + secondJitter;
  const nextTurnAt = new Date(Date.now() + nextIntervalSec * 1000).toISOString();

  const newTurn: WarmupConversationTurn = {
    sender: senderConfig.instance_name,
    text: messageText,
    sent_at: nowIso,
    message_id: messageId,
    action_type: turnActionType,
  };

  const updatedHistory = [...(conversation.history || []), newTurn];

  await supabaseAdmin
    .from("whatsapp_warmup_conversations")
    .update({
      history: updatedHistory,
      turn_count: updatedTurnCount,
      last_sender: senderConfig.instance_name,
      status: isFinished ? "finished" : "active",
      next_turn_at: nextTurnAt,
      updated_at: nowIso,
    })
    .eq("id", conversation.id);

  return { success: true, messageText };
}
