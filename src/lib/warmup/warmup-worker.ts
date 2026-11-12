import { supabaseAdmin } from "@/lib/supabase_admin";
import {
  executeWarmupTurn,
  isWithinOperatingHours,
  logWarmupAction,
  evaluateDailyAutoProgress,
  getBrazilDayKey,
} from "./warmup-engine";
import { WARMUP_THEMES } from "./warmup-dialogues";
import { type WarmupConfig, type WarmupConversation } from "./warmup-types";
import { syncGroupMembershipForChips, hydrateChipProfile } from "./warmup-groups";
import {
  ensureWarmupConfigsForTenant,
  listWarmupTenantIds,
  readTenantWarmupConfigs,
  isConnectedStatus,
  getEffectiveDailyTarget,
  readDailyResetState,
  writeDailyResetState,
  acquireWarmupTickLock,
  releaseWarmupTickLock,
  type TenantConnection,
} from "./warmup-config-service";

const _lastWarningLogged: Record<string, number> = {};

// A entrada em grupos é custosa e sensível a banimento: no máximo 1 sincronização
// por tenant a cada 10 minutos, sem chamadas concorrentes.
const GROUP_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const _lastGroupSyncAt: Record<string, number> = {};
const _groupSyncInFlight = new Set<string>();

function scheduleGroupSync(clientId: string): void {
  const last = _lastGroupSyncAt[clientId] || 0;
  if (Date.now() - last < GROUP_SYNC_INTERVAL_MS) return;
  if (_groupSyncInFlight.has(clientId)) return;

  _lastGroupSyncAt[clientId] = Date.now();
  _groupSyncInFlight.add(clientId);
  syncGroupMembershipForChips(clientId)
    .catch(() => {})
    .finally(() => _groupSyncInFlight.delete(clientId));
}

// Máximo de turnos por chip dentro do mesmo tick, para não gerar rajada.
const MAX_TURNS_PER_CHIP_PER_TICK = 1;

function effectiveTarget(config: WarmupConfig): number {
  return getEffectiveDailyTarget(config);
}


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
    // 1. Lista tenants com configuração de warmup ou conexão WhatsApp.
    const tenantIds = await listWarmupTenantIds();
    const now = new Date();
    const nowIso = now.toISOString();

    if (tenantIds.length === 0) {
      return { processedTenants, exchangesCount };
    }

    const lockOwner = `warmup-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

    for (const clientId of tenantIds) {
      processedTenants++;

      // Lock por tenant: evita dois processos enviando no mesmo minuto.
      const locked = await acquireWarmupTickLock(clientId, lockOwner);
      if (!locked) {
        console.log(`[WarmupWorker] Tenant ${clientId} já está sendo processado por outro processo. Pulando tick.`);
        continue;
      }

      try {
        // 2. Cadastro automático de chip conectado + leitura com precedência tabela > settings
        const ensured = await ensureWarmupConfigsForTenant(clientId);
        const connections: TenantConnection[] = ensured.connections;
        const { configs: configMap } = await readTenantWarmupConfigs(clientId);

        if (ensured.created.length > 0) {
          await logWarmupAction({
            client_id: clientId,
            sender_instance: "swarm_orchestrator",
            receiver_instance: "auto_enroll",
            message_text: `🆕 ${ensured.created.length} chip(s) conectado(s) cadastrado(s) automaticamente no aquecimento: ${ensured.created.join(", ")}.`,
            action_type: "system",
          });
        }

        const enabledConfigs = Object.values(configMap).filter((c) => c.enabled);
        if (enabledConfigs.length === 0) continue;

        // Chip desconectado não recebe envio. Config sem linha de conexão mantém
        // comportamento legado (evita parar tenants antigos sem channel_connections).
        const statusByInstance = new Map(connections.map((c) => [c.instance_name, c.status]));
        const configs = enabledConfigs.filter((c) => {
          const status = statusByInstance.get(c.instance_name);
          return status ? isConnectedStatus(status) : true;
        });
        if (configs.length === 0) continue;

        // 2.1 Quarentena + reset diário idempotente (uma vez por dia civil)
        const dailyState = await readDailyResetState(clientId);
        const nextDailyState = { ...dailyState };
        let dailyStateDirty = false;

        for (const cfg of configs) {
          // Recuperação automática de quarentena pós-24h
          if (cfg.is_quarantined && cfg.quarantine_until && new Date(cfg.quarantine_until) <= now) {
            cfg.is_quarantined = false;
            cfg.quarantine_reason = null;
            cfg.health_score = 75;
            cfg.error_count_today = 0;
            await supabaseAdmin
              .from("whatsapp_warmup_configs")
              .update({
                is_quarantined: false,
                quarantine_reason: null,
                health_score: 75,
                error_count_today: 0,
                updated_at: nowIso,
              })
              .eq("id", cfg.id)
              .eq("client_id", clientId);

            await logWarmupAction({
              client_id: clientId,
              sender_instance: cfg.instance_name,
              receiver_instance: "circuit_breaker",
              message_text: `✅ Quarentena preventiva de 24h concluída para o Chip ${cfg.instance_name}. Tráfego reativado gradualmente.`,
              action_type: "circuit_breaker",
            });
          }

          const progress = evaluateDailyAutoProgress(
            cfg,
            nowIso,
            dailyState[cfg.instance_name] ?? null
          );
          if (!progress.isNewDay) continue;

          const { stagePromoted, newStage, newDaysActive, newConsecutiveDays, newDailyTarget } = progress;

          const update: Record<string, unknown> = {
            sent_today: 0,
            received_today: 0,
            error_count_today: 0,
            days_active: newDaysActive,
            consecutive_successful_days: newConsecutiveDays,
            updated_at: nowIso,
          };

          cfg.sent_today = 0;
          cfg.received_today = 0;
          cfg.error_count_today = 0;
          cfg.days_active = newDaysActive;
          cfg.consecutive_successful_days = newConsecutiveDays;

          if (stagePromoted) {
            update.stage = newStage;
            update.daily_target = newDailyTarget;
            update.min_interval_seconds = progress.stageInfo.minInterval;
            update.max_interval_seconds = progress.stageInfo.maxInterval;

            cfg.stage = newStage;
            cfg.daily_target = newDailyTarget;
            cfg.min_interval_seconds = progress.stageInfo.minInterval;
            cfg.max_interval_seconds = progress.stageInfo.maxInterval;
          }

          await supabaseAdmin
            .from("whatsapp_warmup_configs")
            .update(update)
            .eq("id", cfg.id)
            .eq("client_id", clientId);

          nextDailyState[cfg.instance_name] = getBrazilDayKey(nowIso);
          dailyStateDirty = true;

          if (stagePromoted) {
            await logWarmupAction({
              client_id: clientId,
              sender_instance: cfg.instance_name,
              receiver_instance: "auto_ramp",
              message_text: `🎉 PILOTO AUTOMÁTICO: Chip ${cfg.instance_name} promovido para a ${progress.stageInfo.name} (${newDaysActive} dias de maturação). Nova meta: ${newDailyTarget} msgs/dia!`,
              action_type: "system",
            });
          }
        }

        if (dailyStateDirty) {
          await writeDailyResetState(clientId, nextDailyState);
        }

      // 2.2 Hidratação preventiva de perfis e sincronização de grupos
      for (const cfg of configs) {
        if (!cfg.profile_hydrated && !cfg.is_quarantined) {
          hydrateChipProfile(clientId, cfg.instance_name).catch(() => {});
        }
      }

      // Validação de chips não em quarentena
      const nonQuarantined = configs.filter((c) => !c.is_quarantined);

      // Se temos apenas 1 chip: aquece passivamente via grupos da colmeia
      if (nonQuarantined.length < 2) {
        scheduleGroupSync(clientId);

        const lastWarn = _lastWarningLogged[clientId] || 0;
        if (Date.now() - lastWarn > 60 * 60 * 1000) {
          _lastWarningLogged[clientId] = Date.now();
          await logWarmupAction({
            client_id: clientId,
            sender_instance: nonQuarantined[0]?.instance_name || "sistema",
            receiver_instance: "grupos_colmeia",
            message_text: "ℹ️ Chip único ativo: aquecendo passivamente via grupos da colmeia e publicação de status. Para trocas mútuas 1x1, adicione outro chip.",
            action_type: "system",
          });
        }
        continue;
      }

      // Sincroniza adesão nos grupos (com throttle anti-flood)
      scheduleGroupSync(clientId);

      // Filtra chips que ainda não bateram a meta diária efetiva
      // (menor valor entre meta da fase e teto da finalidade do chip).
      const availableChips = nonQuarantined.filter(
        (c) => (c.sent_today || 0) < effectiveTarget(c)
      );

      if (availableChips.length === 0) {
        continue;
      }

      // 3. Consolida conversas ativas duplicadas do mesmo par (legado do bug de
      // criação por tick). Mantém a mais antiga e encerra as demais.
      let activePairs = new Set<string>();
      try {
        const { data: activeAll } = await supabaseAdmin
          .from("whatsapp_warmup_conversations")
          .select("id, instance_a, instance_b")
          .eq("client_id", clientId)
          .eq("status", "active")
          .order("created_at", { ascending: true });

        const keptPairs = new Set<string>();
        const duplicateIds: string[] = [];
        for (const conv of activeAll || []) {
          const pairKey = [conv.instance_a, conv.instance_b].filter(Boolean).sort().join("::");
          if (!pairKey) continue;
          if (keptPairs.has(pairKey)) duplicateIds.push(conv.id);
          else keptPairs.add(pairKey);
        }

        if (duplicateIds.length > 0) {
          await supabaseAdmin
            .from("whatsapp_warmup_conversations")
            .update({ status: "finished", updated_at: nowIso })
            .in("id", duplicateIds);
        }

        activePairs = keptPairs;
      } catch {}

      // 4. Processa conversas ativas com turno pendente (next_turn_at <= now())
      const { data: dueConvs } = await supabaseAdmin
        .from("whatsapp_warmup_conversations")
        .select("*")
        .eq("client_id", clientId)
        .eq("status", "active")
        .lte("next_turn_at", nowIso)
        .order("next_turn_at", { ascending: true })
        .limit(3);

      const busyChips = new Set<string>();
      const sentThisTick = new Map<string, number>();

      if (dueConvs && dueConvs.length > 0) {
        for (const activeConv of dueConvs as WarmupConversation[]) {
          const instA = nonQuarantined.find((c) => c.instance_name === activeConv.instance_a);
          const instB = nonQuarantined.find((c) => c.instance_name === activeConv.instance_b);

          if (instA && instB) {
            busyChips.add(instA.instance_name);
            busyChips.add(instB.instance_name);

            const senderCfg = activeConv.last_sender === instA.instance_name ? instB : instA;
            const receiverCfg = senderCfg.instance_name === instA.instance_name ? instB : instA;

            // Anti-rajada: no máximo 1 turno por chip dentro do mesmo tick.
            if ((sentThisTick.get(senderCfg.instance_name) || 0) >= MAX_TURNS_PER_CHIP_PER_TICK) {
              continue;
            }

            // Fora da janela do chip remetente: não chama o motor (evita log repetido
            // a cada tick e mantém o turno agendado para quando abrir a janela).
            if (
              !isWithinOperatingHours(
                senderCfg.allowed_start_hour ?? 8,
                senderCfg.allowed_end_hour ?? 21
              )
            ) {
              continue;
            }

            if ((senderCfg.sent_today || 0) < effectiveTarget(senderCfg)) {
              const turnRes = await executeWarmupTurn({
                clientId,
                senderConfig: senderCfg,
                receiverConfig: receiverCfg,
                conversation: activeConv,
              });
              if (turnRes.success) {
                exchangesCount++;
                // Mantém a cópia em memória em sincronia para não estourar a meta no mesmo tick.
                senderCfg.sent_today = (senderCfg.sent_today || 0) + 1;
                receiverCfg.received_today = (receiverCfg.received_today || 0) + 1;
                sentThisTick.set(
                  senderCfg.instance_name,
                  (sentThisTick.get(senderCfg.instance_name) || 0) + 1
                );
              }
            } else {
              await supabaseAdmin
                .from("whatsapp_warmup_conversations")
                .update({ status: "finished", updated_at: nowIso })
                .eq("id", activeConv.id);
            }
          }
        }
      }

      // 4. Se houver chips ociosos disponíveis, cria novas conversas em malha (Mesh Swarm)
      const idleChips = availableChips.filter(
        (c) => !busyChips.has(c.instance_name) && !sentThisTick.has(c.instance_name)
      );

      // Não abre conversa nova para um par que já tem conversa ativa.
      // `activePairs` foi consolidado no passo 3.

      if (idleChips.length >= 2) {
        // Ordena para que o chip mais veterano (maior estágio) inicie a nova conversa
        const sorted = [...idleChips].sort((a, b) => (b.stage || 1) - (a.stage || 1));
        const initiator = sorted[0];

        // Seleciona parceiro de forma rotativa entre os ociosos, evitando par já ativo
        const candidates = sorted.filter(
          (c) =>
            c.instance_name !== initiator.instance_name &&
            !activePairs.has([initiator.instance_name, c.instance_name].sort().join("::"))
        );
        const partner = candidates[Math.floor(Math.random() * candidates.length)];

        if (initiator && partner) {
          if (isWithinOperatingHours(initiator.allowed_start_hour ?? 8, initiator.allowed_end_hour ?? 21)) {
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
                initiator.sent_today = (initiator.sent_today || 0) + 1;
                partner.received_today = (partner.received_today || 0) + 1;
                sentThisTick.set(initiator.instance_name, 1);
              }
            }
          }
        }
      }
      } catch (tenantErr) {
        const message = tenantErr instanceof Error ? tenantErr.message : String(tenantErr);
        console.error(`[WarmupWorker] Falha no tenant ${clientId}:`, message);
      } finally {
        await releaseWarmupTickLock(clientId, lockOwner);
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

/**
 * Ativa o Piloto Automático para TODOS os chips (ou lista de chips) na Colmeia:
 * 1. Habilita todas as proteções anti-ban e modo malha aberta.
 * 2. Hidrata perfis dos chips (nome comercial, status/recado, Stories iniciais).
 * 3. Sincroniza adesão nos grupos de aquecimento cadastrados.
 * 4. Inicia conversas em malha entre os chips disponíveis.
 */
export async function enableSwarmAutopilot(
  clientId: string,
  instanceNames?: string[]
): Promise<{ success: boolean; message: string; chipsActivated: number; error?: string }> {
  try {
    let targetInstances = instanceNames || [];

    if (targetInstances.length === 0) {
      const { data: configs } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("instance_name")
        .eq("client_id", clientId);

      if (configs && configs.length > 0) {
        targetInstances = configs.map((c) => c.instance_name);
      }
    }

    if (targetInstances.length === 0) {
      return {
        success: false,
        chipsActivated: 0,
        message: "Nenhuma instância encontrada para ativar na colmeia.",
      };
    }

    const nowIso = new Date().toISOString();

    for (const instName of targetInstances) {
      await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .upsert(
          {
            client_id: clientId,
            instance_name: instName,
            enabled: true,
            swarm_active: true,
            group_auto_join: true,
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
          },
          { onConflict: "client_id,instance_name" }
        );

      hydrateChipProfile(clientId, instName).catch(() => {});
    }

    syncGroupMembershipForChips(clientId).catch(() => {});

    if (targetInstances.length >= 2) {
      const instA = targetInstances[0];
      const instB = targetInstances[1];
      try {
        await supabaseAdmin.from("whatsapp_warmup_conversations").insert({
          client_id: clientId,
          instance_a: instA,
          instance_b: instB,
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
    }

    await logWarmupAction({
      client_id: clientId,
      sender_instance: "swarm_orchestrator",
      receiver_instance: "colmeia",
      message_text: `🐝 Colmeia Autônoma ATIVADA para ${targetInstances.length} chips. Rede em malha e grupos ativados.`,
      action_type: "system",
    });

    return {
      success: true,
      chipsActivated: targetInstances.length,
      message: `Colmeia Autônoma ativada com sucesso para ${targetInstances.length} chip(s)! Todos estão aquecendo sozinhos com proteção máxima.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, chipsActivated: 0, message: msg, error: msg };
  }
}

/**
 * Dispara uma rodada completa de aquecimento na colmeia inteira:
 * Executa trocas mútuas entre os pares disponíveis e sincroniza grupos.
 */
export async function triggerSwarmCycle(
  clientId: string,
  instanceNames?: string[]
): Promise<{ success: boolean; message: string; roundsExecuted: number; error?: string }> {
  try {
    let targetInstances = instanceNames || [];

    if (targetInstances.length === 0) {
      const { data: configs } = await supabaseAdmin
        .from("whatsapp_warmup_configs")
        .select("instance_name")
        .eq("client_id", clientId)
        .eq("enabled", true)
        .eq("is_quarantined", false);

      if (configs && configs.length > 0) {
        targetInstances = configs.map((c) => c.instance_name);
      }
    }

    if (targetInstances.length < 2) {
      // Se tiver só 1 chip, sincroniza grupos e publica status
      if (targetInstances.length === 1) {
        await syncGroupMembershipForChips(clientId);
        await hydrateChipProfile(clientId, targetInstances[0]);
        return {
          success: true,
          roundsExecuted: 1,
          message: `Chip ${targetInstances[0]} sincronizado com os grupos da colmeia e perfil hidratado!`,
        };
      }
      return {
        success: false,
        roundsExecuted: 0,
        message: "Necessário ao menos 1 chip ativo para rodada na colmeia.",
      };
    }

    let roundsExecuted = 0;
    // Divide os chips em pares e dispara trocas bilaterais simultâneas
    for (let i = 0; i < targetInstances.length - 1; i += 2) {
      const instA = targetInstances[i];
      const instB = targetInstances[i + 1];
      const res = await triggerMutualWarmup(clientId, instA, instB);
      if (res.success) {
        roundsExecuted++;
      }
    }

    // Se sobrou 1 chip ímpar, conecta ele com o primeiro
    if (targetInstances.length % 2 !== 0 && targetInstances.length >= 3) {
      const last = targetInstances[targetInstances.length - 1];
      const first = targetInstances[0];
      await triggerMutualWarmup(clientId, last, first).catch(() => {});
      roundsExecuted++;
    }

    syncGroupMembershipForChips(clientId).catch(() => {});

    return {
      success: true,
      roundsExecuted,
      message: `Rodada da colmeia concluída com sucesso! ${roundsExecuted} pares interagiram mutuamente.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, roundsExecuted: 0, message: msg, error: msg };
  }
}
