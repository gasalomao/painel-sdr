import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { generateText } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";
import { getRandomWarmupVoiceBase64 } from "./warmup-audio";
import {
  calculateTypingDuration,
  getRandomReaction,
  getRandomStatusQuote,
  getRandomCasualVoiceNote,
  pickFallbackDialogue,
  WARMUP_THEMES,
} from "./warmup-dialogues";
import {
  STAGE_DEFAULTS,
  type WarmupConfig,
  type WarmupConversation,
  type WarmupConversationTurn,
  type WarmupLog,
  type WarmupStage,
} from "./warmup-types";

// Base64 de um áudio sintético super leve de voz silenciosa/neutra (OPUS) para fallback de PTT
const CASUAL_OPUS_BASE64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAA+1icBAAAAAAAAPtYnAQAAAAAAAA==";

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
  } catch {}

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
      const clean = String(candidate).replace(/\D/g, "");
      if (clean.length >= 10) return clean;
    }
  } catch {}

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
      const clean = String(owner).replace(/\D/g, "");
      if (clean.length >= 10) return clean;
    }
  } catch {}

  return null;
}

/**
 * Gera mensagem de aquecimento usando o modelo de IA configurado ou diálogos nativos.
 */
export async function generateWarmupMessage(opts: {
  theme: string;
  speakerRole: "A" | "B";
  history: WarmupConversationTurn[];
  aiModel?: string;
  customPrompt?: string | null;
}): Promise<{ text: string; provider: string; modelUsed: string }> {
  const { theme, speakerRole, history, aiModel, customPrompt } = opts;

  if (!aiModel || aiModel === "fallback" || aiModel === "nativo") {
    const script = pickFallbackDialogue(theme);
    const step = Math.min(history.length, script.turns.length - 1);
    const turn = script.turns[step] || script.turns[0];
    return {
      text: turn.text,
      provider: "native_fallback",
      modelUsed: "dialogue_bank_pt_br",
    };
  }

  try {
    const keys = await getAiKeys();
    const recentHistoryText = history
      .slice(-4)
      .map((h) => `${h.sender}: ${h.text}`)
      .join("\n");

    const themeObj = WARMUP_THEMES.find((t) => t.id === theme) || WARMUP_THEMES[0];

    const systemPrompt = `Você é um usuário brasileiro casual conversando no WhatsApp com um amigo próximo sobre ${themeObj.label}.
REGRAS OBRIGATÓRIAS:
1. Escreva EXATAMENTE UMA mensagem curta e natural em português brasileiro (como alguém digita no WhatsApp pelo celular).
2. Use linguagem casual e gírias leves (ex: 'blz', 'show', 'tbm', 'vc', 'kkk', 'mano', 'cara', 'valeu').
3. NUNCA faça ofertas comerciais, nunca fale como atendente, robô ou empresa.
4. Mantenha coerência com as mensagens anteriores.
5. Devolva APENAS o texto da mensagem, sem aspas, sem explicações.`;

    const userPrompt = history.length === 0
      ? `Inicie a conversa casualmente com um cumprimento e uma frase sobre ${themeObj.label}. ${customPrompt ? `Detalhe: ${customPrompt}` : ""}`
      : `Últimas mensagens trocadas:\n${recentHistoryText}\n\nResponda casualmente como o interlocutor (${speakerRole}):`;

    const res = await generateText({
      modelRef: aiModel,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.85,
      geminiApiKey: keys.gemini,
      openrouterApiKey: keys.openrouter,
      openrouterKeys: keys.openrouterKeys,
      nvidiaApiKey: keys.nvidia,
      gatewayBaseUrl: keys.gatewayBaseUrl,
      gatewayApiKey: keys.gatewayApiKey,
    });

    const cleanText = (res.text || "").trim().replace(/^["']|["']$/g, "");
    if (cleanText.length > 2) {
      return {
        text: cleanText,
        provider: res.provider,
        modelUsed: res.modelUsed || aiModel,
      };
    }
  } catch (err: any) {
    console.warn(`[Warmup] Geração IA falhou (${err.message}) — usando fallback nativo.`);
  }

  const script = pickFallbackDialogue(theme);
  const step = Math.min(history.length, script.turns.length - 1);
  return {
    text: script.turns[step]?.text || "Opa, tudo bem por aí?",
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
  } catch {}

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
  } catch {}
}

/**
 * Disjuntor de Emergência (Circuit Breaker): Reduz score e coloca em quarentena se houver erros.
 */
export async function handleInstanceFailure(
  clientId: string,
  cfg: WarmupConfig,
  errorMessage: string
): Promise<void> {
  const now = new Date();
  const errorsToday = (cfg.error_count_today || 0) + 1;
  const newHealth = Math.max(0, (cfg.health_score ?? 100) - 20);

  const shouldQuarantine = errorsToday >= 3 || newHealth <= 40;
  const quarantineUntil = shouldQuarantine
    ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    : null;

  await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .update({
      error_count_today: errorsToday,
      health_score: newHealth,
      is_quarantined: shouldQuarantine,
      quarantine_reason: shouldQuarantine ? `Múltiplas falhas detectadas: ${errorMessage}` : null,
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
      : `⚠️ Alerta de falha no Chip ${cfg.instance_name} (${errorsToday}/3 falhas). Saúde: ${newHealth}%.`,
    action_type: "circuit_breaker",
    details: { error: errorMessage, health_score: newHealth, is_quarantined: shouldQuarantine },
  });
}

/**
 * Avalia a progressão de dias e promoção de estágio do piloto automático.
 */
export function evaluateDailyAutoProgress(
  cfg: WarmupConfig,
  nowIso: string = new Date().toISOString()
): {
  isNewDay: boolean;
  stagePromoted: boolean;
  newStage: WarmupStage;
  newDaysActive: number;
  newConsecutiveDays: number;
  newDailyTarget: number;
  stageInfo: (typeof STAGE_DEFAULTS)[WarmupStage];
} {
  const isNewDay = cfg.last_activity_at
    ? !isSameBrazilDay(cfg.last_activity_at, nowIso)
    : false;

  const curStage = (cfg.stage || 1) as WarmupStage;

  if (!isNewDay) {
    return {
      isNewDay: false,
      stagePromoted: false,
      newStage: curStage,
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
  const newDaysActive = (cfg.days_active || 1) + 1;

  let newStage: WarmupStage = curStage;
  let stagePromoted = false;

  // PILOTO AUTOMÁTICO DE ESCADA DE FASES
  if (cfg.stage_auto_progress !== false) {
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

  const stageInfo = STAGE_DEFAULTS[newStage];

  return {
    isNewDay: true,
    stagePromoted,
    newStage,
    newDaysActive,
    newConsecutiveDays,
    newDailyTarget: stageInfo.dailyTarget,
    stageInfo,
  };
}

/**
 * Executa um turno avançado de aquecimento com toda a gama de comportamentos humanos:
 * vCard, Digitação, Texto ou Áudio Opus PTT, Tiques Azuis, Reações e Status.
 */
export async function executeWarmupTurn(opts: {
  clientId: string;
  senderConfig: WarmupConfig;
  receiverConfig: WarmupConfig;
  conversation: WarmupConversation;
  isManualTrigger?: boolean;
  forceStatusPost?: boolean;
}): Promise<{ success: boolean; messageText: string; error?: string }> {
  const { clientId, senderConfig, receiverConfig, conversation, isManualTrigger, forceStatusPost } = opts;

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
      await logWarmupAction({
        client_id: clientId,
        sender_instance: senderConfig.instance_name,
        receiver_instance: receiverConfig.instance_name,
        message_text: `Fora da janela permitida (${senderConfig.allowed_start_hour}h às ${senderConfig.allowed_end_hour}h BRT). Aguardando próximo ciclo.`,
        action_type: "system",
      });
      return { success: false, messageText: "", error: "outside_hours" };
    }
  }

  // 3. Resolução dos telefones
  const receiverPhone = await resolveInstancePhone(receiverConfig.instance_name, clientId);
  const senderPhone = await resolveInstancePhone(senderConfig.instance_name, clientId);

  if (!receiverPhone) {
    const errorMsg = `Telefone do chip destinatário (${receiverConfig.instance_name}) não encontrado.`;
    await handleInstanceFailure(clientId, senderConfig, errorMsg);
    return { success: false, messageText: "", error: errorMsg };
  }

  const targetJid = `${receiverPhone}@s.whatsapp.net`;

  // 4. TROCA DE vCARD (Cartão de Contato na Agenda) - Realizada no primeiro turno entre os dois chips
  const vcardPeers = senderConfig.vcard_exchanged_peers || [];
  if (!isManualTrigger && senderConfig.enable_vcard !== false && !vcardPeers.includes(receiverConfig.instance_name) && senderPhone) {
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

      // Envia o cartão de contato do REMETENTE para o destinatário salvar na agenda
      await evolution.sendContact(
        targetJid,
        [{ fullName: senderConfig.instance_name, phoneNumber: senderPhone }],
        senderConfig.instance_name
      );

      // Marca como trocado em ambos os lados
      const updatedPeers = [...vcardPeers, receiverConfig.instance_name];
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({ vcard_exchanged_peers: updatedPeers })
        .eq("instance_name", senderConfig.instance_name)
        .eq("client_id", clientId);
    } catch {}
  }

  // 5. POSTAGEM DE STATUS (WhatsApp Stories) - A cada 48h ou se requisitado no teste manual
  const shouldPostStatus =
    (forceStatusPost || !isManualTrigger) &&
    senderConfig.enable_status_posts !== false &&
    (Boolean(forceStatusPost) ||
      !senderConfig.last_status_post_at ||
      Date.now() - new Date(senderConfig.last_status_post_at).getTime() > 48 * 60 * 60 * 1000);

  if (shouldPostStatus) {
    try {
      const quote = getRandomStatusQuote();
      await evolution.sendStatus(
        quote,
        "text",
        senderConfig.instance_name,
        receiverPhone ? [receiverPhone] : []
      );
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .update({ last_status_post_at: new Date().toISOString() })
        .eq("instance_name", senderConfig.instance_name)
        .eq("client_id", clientId);

      await logWarmupAction({
        client_id: clientId,
        sender_instance: senderConfig.instance_name,
        receiver_instance: "status@broadcast",
        message_text: `Publicou Story no WhatsApp Status: "${quote}"`,
        action_type: "status",
      });
    } catch {}
  }

  // 6. Geração da Mensagem (Texto ou Áudio)
  const isAudioTurn = (senderConfig.enable_audio || senderConfig.stage >= 2) && Math.random() < 0.18; // ~18% de turnos viram áudio
  let messageText = "";
  let genResult = { provider: "native", modelUsed: "dialogue_bank" };

  if (isAudioTurn) {
    messageText = getRandomCasualVoiceNote();
  } else {
    const speakerRole = conversation.turn_count % 2 === 0 ? "A" : "B";
    const generated = await generateWarmupMessage({
      theme: conversation.topic || senderConfig.ai_theme || "dia_a_dia",
      speakerRole,
      history: conversation.history || [],
      aiModel: senderConfig.ai_model,
      customPrompt: senderConfig.custom_prompt,
    });
    messageText = generated.text;
    genResult = { provider: generated.provider, modelUsed: generated.modelUsed };
  }

  // 7. Simulação de Digitação Humana ou Gravação de Áudio
  if (senderConfig.enable_typing) {
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
    } catch {}

    const effectiveWait = isManualTrigger ? Math.min(typingMs, 3500) : typingMs;
    await new Promise((r) => setTimeout(r, effectiveWait));
  }

  // 8. Envio Efetivo (Áudio Opus PTT ou Texto)
  let sendResult: any = null;
  try {
    if (isAudioTurn) {
      const voiceB64 = getRandomWarmupVoiceBase64() || CASUAL_OPUS_BASE64;
      sendResult = await evolution.sendMedia(
        targetJid,
        "",
        { type: "audio", base64: voiceB64, mimetype: "audio/ogg; codecs=opus" },
        senderConfig.instance_name,
        { delay: 1500, encoding: false }
      );
    } else {
      sendResult = await evolution.sendTextMessage(targetJid, messageText, senderConfig.instance_name);
    }
  } catch (err: any) {
    const errorMsg = `Erro ao enviar no WhatsApp: ${err.message}`;
    await handleInstanceFailure(clientId, senderConfig, errorMsg);
    return { success: false, messageText, error: errorMsg };
  }

  const messageId =
    sendResult?.key?.id ||
    sendResult?.id ||
    sendResult?.data?.key?.id ||
    `wup_${Date.now()}`;

  // Log do Envio com Sucesso
  await logWarmupAction({
    client_id: clientId,
    sender_instance: senderConfig.instance_name,
    receiver_instance: receiverConfig.instance_name,
    sender_phone: senderPhone,
    receiver_phone: receiverPhone,
    message_text: isAudioTurn ? `🎤 Áudio PTT gravado na hora: "${messageText}"` : messageText,
    action_type: isAudioTurn ? "audio" : "text",
    details: {
      message_id: messageId,
      provider: genResult.provider,
      model_used: genResult.modelUsed,
      turn: conversation.turn_count + 1,
    },
  });

  // 9. Confirmação de Leitura e Tique Azul no Destinatário (com Atraso Humano)
  if (receiverConfig.enable_blue_ticks !== false && senderPhone) {
    const senderJid = `${senderPhone}@s.whatsapp.net`;
    const readDelayMs = 4200;

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
      setTimeout(performReadConfirmation, readDelayMs);
    }
  }

  // 10. Reação de Emoji (probabilidade ~32%)
  if (receiverConfig.enable_reactions !== false && senderPhone && (isManualTrigger || Math.random() < 0.32)) {
    const reactionEmoji = getRandomReaction();
    const reactionDelayMs = isManualTrigger ? 2000 : 7500;

    const performReaction = async () => {
      try {
        const senderJid = `${senderPhone}@s.whatsapp.net`;
        await evolution.sendReaction(
          senderJid,
          messageId,
          reactionEmoji,
          receiverConfig.instance_name,
          false
        );
        await logWarmupAction({
          client_id: clientId,
          sender_instance: receiverConfig.instance_name,
          receiver_instance: senderConfig.instance_name,
          sender_phone: receiverPhone,
          receiver_phone: senderPhone,
          message_text: `Reagiu com ${reactionEmoji} à mensagem anterior`,
          action_type: "reaction",
          details: { reaction: reactionEmoji, target_msg_id: messageId },
        });
      } catch {}
    };

    if (isManualTrigger) {
      await new Promise((r) => setTimeout(r, reactionDelayMs));
      await performReaction();
    } else {
      setTimeout(performReaction, reactionDelayMs);
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

  // 12. Atualização da conversa ativa
  const updatedTurnCount = conversation.turn_count + 1;
  const isFinished = updatedTurnCount >= conversation.max_turns;

  const minSec = senderConfig.min_interval_seconds || 90;
  const maxSec = senderConfig.max_interval_seconds || 300;
  const nextIntervalSec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
  const nextTurnAt = new Date(Date.now() + nextIntervalSec * 1000).toISOString();

  const newTurn: WarmupConversationTurn = {
    sender: senderConfig.instance_name,
    text: messageText,
    sent_at: nowIso,
    message_id: messageId,
    action_type: isAudioTurn ? "audio" : "text",
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
