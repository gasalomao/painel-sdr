import { supabaseAdmin } from "@/lib/supabase_admin";
import { executeWarmupTurn, isWithinOperatingHours, logWarmupAction, evaluateDailyAutoProgress } from "./warmup-engine";
import { WARMUP_THEMES } from "./warmup-dialogues";
import { type WarmupConfig, type WarmupConversation } from "./warmup-types";

const _lastWarningLogged: Record<string, number> = {};

/**
 * Agendador principal de maturação.
 * Executado a cada 60s pelo instrumentation / worker pool.
 */
export async function tickWarmupWorker(): Promise<{
  processedTenants: number;
  exchangesCount: number;
}> {
  let processedTenants = 0;
  let exchangesCount = 0;

  try {
    // 1. Busca todas as configurações ativas (tabela oficial + fallback app_settings)
    const activeConfigsList: WarmupConfig[] = [];

    try {
      const { data: dbConfigs, error: cfgError } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("*")
        .eq("enabled", true);

      if (!cfgError && dbConfigs && dbConfigs.length > 0) {
        activeConfigsList.push(...(dbConfigs as WarmupConfig[]));
      }
    } catch {}

    // Fallback: se a tabela estiver vazia, busca em app_settings
    if (activeConfigsList.length === 0) {
      try {
        const { data: appSettingsData } = await supabaseAdmin
          .from("app_settings")
          .select("key, value")
          .like("key", "warmup_configs_%");

        if (appSettingsData && appSettingsData.length > 0) {
          for (const row of appSettingsData) {
            try {
              const parsed = JSON.parse(row.value);
              const items = Object.values(parsed) as WarmupConfig[];
              activeConfigsList.push(...items.filter((c) => c.enabled));
            } catch {}
          }
        }
      } catch {}
    }

    if (activeConfigsList.length === 0) {
      return { processedTenants, exchangesCount };
    }

    // Agrupa por client_id
    const clientMap = new Map<string, WarmupConfig[]>();
    for (const c of activeConfigsList) {
      const list = clientMap.get(c.client_id) || [];
      list.push(c);
      clientMap.set(c.client_id, list);
    }

    const now = new Date();
    const nowIso = now.toISOString();

    for (const [clientId, configs] of clientMap.entries()) {
      processedTenants++;

      // 2. Avaliação de Quarentena & Reset Diário com Piloto Automático de Fases
      for (const cfg of configs) {
        // Recuperação automática de quarentena pós-24h
        if (cfg.is_quarantined && cfg.quarantine_until && new Date(cfg.quarantine_until) <= now) {
          cfg.is_quarantined = false;
          cfg.quarantine_reason = null;
          cfg.health_score = 75;
          await supabaseAdmin
            .from("whatsapp_warmup_configs")
            .update({
              is_quarantined: false,
              quarantine_reason: null,
              health_score: 75,
              updated_at: nowIso,
            })
            .eq("id", cfg.id);

          await logWarmupAction({
            client_id: clientId,
            sender_instance: cfg.instance_name,
            receiver_instance: "circuit_breaker",
            message_text: `✅ Quarentena preventiva de 24h concluída para o Chip ${cfg.instance_name}. Tráfego reativado gradualmente.`,
            action_type: "circuit_breaker",
          });
        }

        // Reset diário de contadores se virou o dia civil no Brasil (Piloto Automático de Fases)
        const progress = evaluateDailyAutoProgress(cfg, nowIso);
        if (progress.isNewDay) {
          const { stagePromoted, newStage, newDaysActive, newConsecutiveDays, stageInfo } = progress;

          cfg.stage = newStage;
          cfg.daily_target = stageInfo.dailyTarget;
          cfg.min_interval_seconds = stageInfo.minInterval;
          cfg.max_interval_seconds = stageInfo.maxInterval;
          cfg.sent_today = 0;
          cfg.received_today = 0;
          cfg.error_count_today = 0;
          cfg.days_active = newDaysActive;
          cfg.consecutive_successful_days = newConsecutiveDays;

          await supabaseAdmin
            .from("whatsapp_warmup_configs")
            .update({
              stage: newStage,
              daily_target: stageInfo.dailyTarget,
              min_interval_seconds: stageInfo.minInterval,
              max_interval_seconds: stageInfo.maxInterval,
              sent_today: 0,
              received_today: 0,
              error_count_today: 0,
              days_active: newDaysActive,
              consecutive_successful_days: newConsecutiveDays,
              updated_at: nowIso,
            })
            .eq("id", cfg.id);

          if (stagePromoted) {
            await logWarmupAction({
              client_id: clientId,
              sender_instance: cfg.instance_name,
              receiver_instance: "auto_ramp",
              message_text: `🎉 PILOTO AUTOMÁTICO: Chip ${cfg.instance_name} promovido para a ${stageInfo.name} (${newDaysActive} dias de maturação). Nova meta: ${stageInfo.dailyTarget} msgs/dia!`,
              action_type: "system",
            });
          }
        }
      }

      // Validação: precisa de pelo menos 2 chips ativos para troca mútua
      const nonQuarantined = configs.filter((c) => !c.is_quarantined);
      if (nonQuarantined.length < 2) {
        const lastWarn = _lastWarningLogged[clientId] || 0;
        if (Date.now() - lastWarn > 30 * 60 * 1000) {
          _lastWarningLogged[clientId] = Date.now();
          await logWarmupAction({
            client_id: clientId,
            sender_instance: nonQuarantined[0]?.instance_name || "sistema",
            receiver_instance: "aguardando_parceiro",
            message_text: "⚠️ Apenas 1 chip ativo. Para maturação mútua contínua, mantenha pelo menos 2 chips ativos.",
            action_type: "system",
          });
        }
        continue;
      }

      // Filtra apenas chips que ainda não bateram a meta diária
      const availableChips = nonQuarantined.filter(
        (c) => (c.sent_today || 0) < (c.daily_target || 10)
      );

      if (availableChips.length === 0) {
        continue;
      }

      // 3. Verifica conversas ativas com turno pendente (next_turn_at <= now())
      const { data: dueConvs } = await supabaseAdmin
        .from("whatsapp_warmup_conversations")
        .select("*")
        .eq("client_id", clientId)
        .eq("status", "active")
        .lte("next_turn_at", nowIso)
        .order("next_turn_at", { ascending: true })
        .limit(1);

      if (dueConvs && dueConvs.length > 0) {
        const activeConv = dueConvs[0] as WarmupConversation;
        const instA = nonQuarantined.find((c) => c.instance_name === activeConv.instance_a);
        const instB = nonQuarantined.find((c) => c.instance_name === activeConv.instance_b);

        if (instA && instB) {
          const senderCfg = activeConv.last_sender === instA.instance_name ? instB : instA;
          const receiverCfg = senderCfg.instance_name === instA.instance_name ? instB : instA;

          if ((senderCfg.sent_today || 0) < (senderCfg.daily_target || 10)) {
            const turnRes = await executeWarmupTurn({
              clientId,
              senderConfig: senderCfg,
              receiverConfig: receiverCfg,
              conversation: activeConv,
            });
            if (turnRes.success) {
              exchangesCount++;
            }
          } else {
            await supabaseAdmin
              .from("whatsapp_warmup_conversations")
              .update({ status: "finished", updated_at: nowIso })
              .eq("id", activeConv.id);
          }
        }
        continue;
      }

      // 4. Se não há conversa ativa pendente, cria uma nova conversa em malha (Mesh Rotation)
      const { data: anyActive } = await supabaseAdmin
        .from("whatsapp_warmup_conversations")
        .select("id")
        .eq("client_id", clientId)
        .eq("status", "active")
        .limit(1);

      if ((!anyActive || anyActive.length === 0) && availableChips.length >= 2) {
        // Ordena para que o chip mais veterano (maior estágio) inicie
        const sorted = [...availableChips].sort((a, b) => (b.stage || 1) - (a.stage || 1));
        const initiator = sorted[0];

        // Seleciona parceiro de forma rotativa (embaralha os candidatos restantes)
        const candidates = availableChips.filter((c) => c.instance_name !== initiator.instance_name);
        const partner = candidates[Math.floor(Math.random() * candidates.length)];

        if (initiator && partner) {
          if (!isWithinOperatingHours(initiator.allowed_start_hour ?? 8, initiator.allowed_end_hour ?? 21)) {
            continue;
          }

          const randomTheme = WARMUP_THEMES[Math.floor(Math.random() * WARMUP_THEMES.length)].id;
          const maxTurns = Math.floor(Math.random() * 4) + 4; // 4 a 7 turnos

          const { data: newConvData, error: convErr } = await supabaseAdmin
            .from("whatsapp_warmup_conversations")
            .insert({
              client_id: clientId,
              instance_a: initiator.instance_name,
              instance_b: partner.instance_name,
              topic: initiator.ai_theme || randomTheme,
              history: [],
              turn_count: 0,
              max_turns: maxTurns,
              status: "active",
              next_turn_at: nowIso,
            })
            .select()
            .single();

          if (!convErr && newConvData) {
            const turnRes = await executeWarmupTurn({
              clientId,
              senderConfig: initiator,
              receiverConfig: partner,
              conversation: newConvData as WarmupConversation,
            });
            if (turnRes.success) {
              exchangesCount++;
            }
          }
        }
      }
    }
  } catch (err: any) {
    console.error("[WarmupWorker] Erro no tick do worker:", err.message);
  }

  return { processedTenants, exchangesCount };
}

/**
 * Disparo manual imediato de teste entre 2 chips.
 */
export async function triggerManualWarmup(
  clientId: string,
  instanceA: string,
  instanceB: string,
  forceStatusPost: boolean = false
): Promise<{ success: boolean; message: string; error?: string }> {
  const { data: configs } = await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .select("*")
    .eq("client_id", clientId)
    .in("instance_name", [instanceA, instanceB]);

  const cfgA = configs?.find((c) => c.instance_name === instanceA);
  const cfgB = configs?.find((c) => c.instance_name === instanceB);

  const defaultCfg = (inst: string): WarmupConfig => ({
    client_id: clientId,
    instance_name: inst,
    enabled: true,
    stage: 2,
    stage_auto_progress: true,
    days_active: 1,
    consecutive_successful_days: 1,
    health_score: 100,
    is_quarantined: false,
    daily_target: 25,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 60,
    max_interval_seconds: 180,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 0,
    allowed_end_hour: 24,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
  });

  const finalA: WarmupConfig = cfgA || defaultCfg(instanceA);
  const finalB: WarmupConfig = cfgB || defaultCfg(instanceB);

  const syntheticConv: WarmupConversation = {
    id: `manual_${Date.now()}`,
    client_id: clientId,
    instance_a: instanceA,
    instance_b: instanceB,
    topic: finalA.ai_theme || "dia_a_dia",
    history: [],
    turn_count: 0,
    max_turns: 4,
    status: "active",
    next_turn_at: new Date().toISOString(),
  };

  const res = await executeWarmupTurn({
    clientId,
    senderConfig: finalA,
    receiverConfig: finalB,
    conversation: syntheticConv,
    isManualTrigger: true,
    forceStatusPost,
  });

  if (!res.success) {
    return {
      success: false,
      message: `Falha no teste: ${res.error || "Desconhecido"}`,
      error: res.error,
    };
  }

  return {
    success: true,
    message: `Mensagem enviada com sucesso de ${instanceA} para ${instanceB}: "${res.messageText}"`,
  };
}

/**
 * Disparo mútuo simultâneo: Chip A envia para Chip B e Chip B responde para Chip A,
 * ativando todas as funcionalidades automáticas de aquecimento bilateral de 2026.
 */
export async function triggerMutualWarmup(
  clientId: string,
  instanceA: string,
  instanceB: string,
  forceStatusPost: boolean = false
): Promise<{ success: boolean; message: string; details?: { turnA: string; turnB: string }; error?: string }> {
  const { data: configs } = await supabaseAdmin
    .from("whatsapp_warmup_configs")
    .select("*")
    .eq("client_id", clientId)
    .in("instance_name", [instanceA, instanceB]);

  const cfgA = configs?.find((c) => c.instance_name === instanceA);
  const cfgB = configs?.find((c) => c.instance_name === instanceB);

  const defaultCfg = (inst: string): WarmupConfig => ({
    client_id: clientId,
    instance_name: inst,
    enabled: true,
    stage: 2,
    stage_auto_progress: true,
    days_active: 1,
    consecutive_successful_days: 1,
    health_score: 100,
    is_quarantined: false,
    daily_target: 25,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 60,
    max_interval_seconds: 180,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 0,
    allowed_end_hour: 24,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
  });

  const finalA: WarmupConfig = cfgA || defaultCfg(instanceA);
  const finalB: WarmupConfig = cfgB || defaultCfg(instanceB);

  // Turno 1: Chip A -> Chip B
  const convId = `mutual_${Date.now()}`;
  const conversation: WarmupConversation = {
    id: convId,
    client_id: clientId,
    instance_a: instanceA,
    instance_b: instanceB,
    topic: finalA.ai_theme || "dia_a_dia",
    history: [],
    turn_count: 0,
    max_turns: 6,
    status: "active",
    next_turn_at: new Date().toISOString(),
  };

  const resA = await executeWarmupTurn({
    clientId,
    senderConfig: finalA,
    receiverConfig: finalB,
    conversation,
    isManualTrigger: true,
    forceStatusPost,
    forceVCard: true,
  });

  if (!resA.success) {
    return {
      success: false,
      message: `Falha no envio de ${instanceA} para ${instanceB}: ${resA.error || "Desconhecido"}`,
      error: resA.error,
    };
  }

  // Registra no histórico do diálogo para resposta contextual de B
  conversation.history.push({
    sender: instanceA,
    text: resA.messageText,
    sent_at: new Date().toISOString(),
  });
  conversation.turn_count = 1;
  conversation.last_sender = instanceA;

  // Pequena pausa humana entre mensagens mútuas (1.5s)
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Turno 2: Chip B -> Chip A (Resposta Simultânea)
  const resB = await executeWarmupTurn({
    clientId,
    senderConfig: finalB,
    receiverConfig: finalA,
    conversation,
    isManualTrigger: true,
    forceStatusPost,
    forceVCard: true,
  });

  if (!resB.success) {
    return {
      success: true,
      message: `Primeiro envio de ${instanceA} concluído, mas resposta de ${instanceB} falhou: ${resB.error}`,
      details: { turnA: resA.messageText, turnB: "" },
    };
  }

  conversation.history.push({
    sender: instanceB,
    text: resB.messageText,
    sent_at: new Date().toISOString(),
  });
  conversation.turn_count = 2;
  conversation.last_sender = instanceB;

  // Persiste a conversa em andamento para o worker continuar mantendo o vínculo
  try {
    await supabaseAdmin
      .from("whatsapp_warmup_conversations")
      .upsert(
        {
          id: convId,
          client_id: clientId,
          instance_a: instanceA,
          instance_b: instanceB,
          topic: conversation.topic,
          history: conversation.history,
          turn_count: 2,
          max_turns: 6,
          last_sender: instanceB,
          status: "active",
          next_turn_at: new Date(Date.now() + 180 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );
  } catch {}

  await logWarmupAction({
    client_id: clientId,
    sender_instance: instanceA,
    receiver_instance: instanceB,
    message_text: `🔄 Rodada mútua concluída entre ${instanceA} e ${instanceB}. Ambos trocaram mensagens e contatos.`,
    action_type: "system",
  });

  return {
    success: true,
    message: `Aquecimento mútuo concluído! ${instanceA} enviou: "${resA.messageText}" ⇄ ${instanceB} respondeu: "${resB.messageText}".`,
    details: { turnA: resA.messageText, turnB: resB.messageText },
  };
}

/**
 * Ativa o Piloto Automático 100% autônomo entre duas instâncias:
 * Ativa ambos os chips, configura todas as proteções anti-ban de 2026 e vincula a conversa.
 */
export async function enablePairAutopilot(
  clientId: string,
  instanceA: string,
  instanceB: string
): Promise<{ success: boolean; message: string; error?: string }> {
  const nowIso = new Date().toISOString();

  const pairConfigs = [instanceA, instanceB].map((name) => ({
    client_id: clientId,
    instance_name: name,
    enabled: true,
    stage_auto_progress: true,
    enable_vcard: true,
    enable_audio: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_status_posts: true,
    continuous_warmup: true,
    is_quarantined: false,
    min_interval_seconds: 90,
    max_interval_seconds: 240,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 8,
    allowed_end_hour: 21,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    updated_at: nowIso,
  }));

  for (const cfg of pairConfigs) {
    try {
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .upsert(cfg, { onConflict: "client_id,instance_name" });
    } catch {}
  }

  // Cria / reativa conversa na fila do worker
  try {
    await supabaseAdmin
      .from("whatsapp_warmup_conversations")
      .insert({
        client_id: clientId,
        instance_a: instanceA,
        instance_b: instanceB,
        topic: "dia_a_dia",
        history: [],
        turn_count: 0,
        max_turns: 6,
        status: "active",
        next_turn_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      });
  } catch {}

  await logWarmupAction({
    client_id: clientId,
    sender_instance: instanceA,
    receiver_instance: instanceB,
    message_text: `🚀 Piloto Automático Mútuo ATIVADO para ${instanceA} ⇄ ${instanceB}. Ambos aquecem sozinhos com todas as proteções anti-ban.`,
    action_type: "system",
  });

  return {
    success: true,
    message: `Piloto Automático Mútuo ativado com sucesso para ${instanceA} e ${instanceB}! Ambos estão aquecendo sozinhos 24/7 com proteção máxima.`,
  };
}
