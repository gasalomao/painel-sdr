declare global {
  var schedulerStarted: boolean | undefined;
  var organizerTimerId: NodeJS.Timeout | undefined;
  var organizerWatcherId: NodeJS.Timeout | undefined;
  var followupTickerId: NodeJS.Timeout | undefined;
  var automationTickerId: NodeJS.Timeout | undefined;
  var campaignTickerId: NodeJS.Timeout | undefined;
  var appointmentTickerId: NodeJS.Timeout | undefined;
  var agentFollowupTickerId: NodeJS.Timeout | undefined;
  var backupTickerId: NodeJS.Timeout | undefined;
  // Flags in-flight pra impedir overlap quando um tick demora mais que o intervalo
  var organizerTicking: boolean | undefined;
  var automationTicking: boolean | undefined;
  var campaignTicking: boolean | undefined;
  var followupTicking: boolean | undefined;
  var appointmentTicking: boolean | undefined;
  var appointmentTickN: number | undefined;
  var agentFollowupTicking: boolean | undefined;
  var backupTicking: boolean | undefined;
  var sitesWorkerStarted: boolean | undefined;
  var autonomousSiteWorkerStarted: boolean | undefined;
  var warmupTickerId: NodeJS.Timeout | undefined;
  var warmupTicking: boolean | undefined;
  var proxyWatchdogTickerId: NodeJS.Timeout | undefined;
  var proxyWatchdogTicking: boolean | undefined;
  var previewQueueTickerId: NodeJS.Timeout | undefined;
  var previewQueueTicking: boolean | undefined;
}

/**
 * Agendador do Organizador IA — PER-CLIENT.
 *
 * Cada cliente tem sua própria hora (clients.organizer_execution_hour) e seu
 * próprio último-disparo (clients.organizer_last_run). O scheduler faz um tick
 * a cada 5 min: pra cada cliente com organizer_enabled=true cuja hora já chegou
 * hoje e que ainda não rodou hoje → dispara /api/ai-organize com clientId.
 *
 * O ai_organizer_config.enabled GLOBAL continua valendo como kill-switch (admin).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_BACKGROUND_WORKERS === "true") {
    console.info("[SCHEDULER] Desabilitado neste processo (DISABLE_BACKGROUND_WORKERS=true).");
    return;
  }

  if (globalThis.schedulerStarted) {
    console.log("[SCHEDULER] Já iniciado, pulando duplicidade.");
    return;
  }
  globalThis.schedulerStarted = true;

  // IMPORTANTE: usa apenas o admin client pra contornar RLS. Sem
  // SUPABASE_SERVICE_ROLE_KEY, evita fallback anônimo silencioso.
  const { supabaseAdmin } = await import("@/lib/supabase_admin");
  const supabase = supabaseAdmin;

  // Dispara o Organizador pra UM cliente específico.
  const runOrganizerForClient = async (
    clientId: string,
    clientName: string,
    cfg: { api_key: string; model: string; provider: string },
    triggerLabel: "auto" | "schedule_catchup" = "auto"
  ): Promise<boolean> => {
    try {
      console.log(`[SCHEDULER] ⏰ [${clientName}] Disparando Organizer IA [${cfg.provider}/${cfg.model}] — trigger=${triggerLabel}...`);
      const baseUrl = process.env.INTERNAL_APP_URL || `http://localhost:${process.env.PORT || 3000}`;
      const { getInternalSecret, INTERNAL_SECRET_HEADER } = await import("@/lib/internal-auth");
      const response = await fetch(`${baseUrl}/api/ai-organize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_SECRET_HEADER]: getInternalSecret(),
        },
        body: JSON.stringify({
          apiKey: cfg.api_key,
          model: cfg.model,
          provider: cfg.provider,
          triggered_by: triggerLabel,
          clientId,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) {
        const result = await response.json();
        console.log(`[SCHEDULER] ✅ [${clientName}] ${result.updatedCount || 0} leads movidos.`);
        return true;
      } else {
        const errData = await response.json().catch(() => ({}));
        console.error(`[SCHEDULER] ❌ [${clientName}] Falha:`, errData.error || response.statusText);
        return false;
      }
    } catch (err) {
      console.error(`[SCHEDULER] [${clientName}] Erro no disparo:`, (err as Error).message);
      return false;
    }
  };

  // Tick: a cada 5 min, percorre todos os clientes ativos e dispara
  // pra quem está na janela (hora atingida + ainda não rodou hoje).
  // Flag in-flight impede 2 ticks concorrentes se um demorar mais que 5min.
  const tickClients = async () => {
    if (globalThis.organizerTicking) {
      console.log("[SCHEDULER] Tick anterior ainda rodando, pulando.");
      return;
    }
    globalThis.organizerTicking = true;
    try {
      // 1) Config global (cache 60s) — antes era 1 query a cada tick.
      const { getOrganizerConfig } = await import("@/lib/organizer-config-cache");
      const cfg = await getOrganizerConfig();

      if (!cfg) {
        console.warn("[SCHEDULER] ai_organizer_config não encontrada.");
        return;
      }
      if (!cfg.enabled) return; // kill-switch global do admin
      if (!cfg.model) {
        console.warn("[SCHEDULER] Sem model configurado — disparo abortado.");
        return;
      }

      // 2) Clientes elegíveis
      if (!supabase) {
        console.warn("[SCHEDULER] SUPABASE_SERVICE_ROLE_KEY ausente — pulando tick.");
        return;
      }
      const { data: clients, error: clientsErr } = await supabase
        .from("clients")
        .select("id, name, is_admin, is_active, features, organizer_execution_hour, organizer_last_run, organizer_enabled")
        .neq("is_active", false);
      if (clientsErr) {
        console.warn("[SCHEDULER] Erro lendo clients:", clientsErr.message);
        return;
      }

      const { isFeatureEnabledForSession } = await import("@/lib/saas-policy");
      const { checkTenantAiQuota } = await import("@/lib/saas-limits");

      const now = new Date();
      const fmtBrt = (d: Date) => ({
        day: new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Sao_Paulo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(d),
        hour: Number(
          new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Sao_Paulo",
            hour: "2-digit",
            hour12: false,
          }).format(d)
        ) % 24,
      });
      const brtNow = fmtBrt(now);
      const startOfTodayBrtIso = new Date(`${brtNow.day}T00:00:00-03:00`).toISOString();
      let fired = 0;

      for (const c of clients || []) {
        const clientRow = c as {
          id: string;
          name?: string;
          is_admin?: boolean | null;
          is_active?: boolean | null;
          features?: Record<string, boolean> | null;
          organizer_execution_hour?: number | null;
          organizer_last_run?: string | null;
          organizer_enabled?: boolean | null;
        };
        if (clientRow.is_active === false) continue;
        if (!clientRow.is_admin) {
          if (clientRow.organizer_enabled !== true) continue;
          if (!isFeatureEnabledForSession("organizador", { isAdmin: false, features: clientRow.features || {} })) {
            continue;
          }
          const quota = await checkTenantAiQuota(clientRow.id, false).catch(() => ({ allowed: true }));
          if (!quota.allowed) continue;
        } else if (clientRow.organizer_enabled === false) {
          continue;
        }
        const hour = typeof c.organizer_execution_hour === "number" ? c.organizer_execution_hour : 20;
        const lastRunDate = c.organizer_last_run ? fmtBrt(new Date(c.organizer_last_run)).day : null;
        const ranToday = lastRunDate === brtNow.day;
        const windowReached = brtNow.hour >= hour;
        if (!ranToday && windowReached) {
          // Lock otimista atômico em Postgres: impede disparo duplicado entre múltiplas instâncias Node
          const claimIso = new Date().toISOString();
          const { data: claimed } = await supabase
            .from("clients")
            .update({ organizer_last_run: claimIso })
            .eq("id", c.id)
            .or(`organizer_last_run.is.null,organizer_last_run.lt.${startOfTodayBrtIso}`)
            .select("id");
          if (!claimed || claimed.length === 0) continue;

          const ok = await runOrganizerForClient(c.id, (c as { name?: string }).name || c.id, cfg as { api_key: string; model: string; provider: string }, "auto");
          if (!ok) {
            await supabase
              .from("clients")
              .update({ organizer_last_run: c.organizer_last_run || null })
              .eq("id", c.id)
              .eq("organizer_last_run", claimIso);
          } else {
            fired++;
          }
        }
      }
      if (fired > 0) console.log(`[SCHEDULER] Tick processou ${fired} cliente(s) na janela.`);
    } catch (err) {
      console.error("[SCHEDULER] tickClients erro:", (err as Error).message);
    } finally {
      globalThis.organizerTicking = false;
    }
  };

  console.log("[SCHEDULER] Organizer per-client iniciado (tick a cada 5 min).");
  // Primeiro tick em 20s pra dar tempo do boot terminar
  setTimeout(() => { tickClients().catch(() => {}); }, 20_000);
  if (globalThis.organizerWatcherId) clearInterval(globalThis.organizerWatcherId);
  globalThis.organizerWatcherId = setInterval(() => {
    tickClients().catch(() => {});
  }, 1000 * 60 * 5);

  // ============================================================
  // Disparo em massa: recupera campanhas "running" que perderam
  // o timer in-memory (ex: depois de restart do servidor).
  // ============================================================
  try {
    const { recoverRunningCampaigns } = await import("@/lib/campaign-worker");
    const n = await recoverRunningCampaigns();
    if (n > 0) console.log(`[CAMPAIGN RECOVER] ${n} campanha(s) retomada(s) após boot.`);
  } catch (e) {
    console.error("[CAMPAIGN RECOVER] falhou no boot:", (e as Error).message);
  }

  // ============================================================
  // Follow-up automático: a cada 2 min, processa campanhas com
  // status=active e auto_execute=true. O próprio tickCampaign
  // respeita janela de horário, ritmo e só manda quem tem
  // next_send_at <= agora.
  // ============================================================

  // ============================================================
  // AGENT FOLLOW-UPS: a cada 2 min, processa follow-ups agendados
  // de todos os agentes (multi-agente, multi-tenant).
  // Verifica se lead respondeu, envia mensagem e agenda próximo.
  // ============================================================
  if (globalThis.agentFollowupTickerId) clearInterval(globalThis.agentFollowupTickerId);
  if (process.env.AGENT_FOLLOWUP_WORKER_ENABLED === "true") {
    console.log("[AGENT FOLLOWUP] Iniciando ticker (120s).");
    globalThis.agentFollowupTickerId = setInterval(async () => {
      if (globalThis.agentFollowupTicking) {
        console.log("[AGENT FOLLOWUP] tick anterior em andamento, pulando.");
        return;
      }
      globalThis.agentFollowupTicking = true;
      try {
        const { runFollowUpWorker } = await import("@/workers/agent-followup-worker");
        await runFollowUpWorker();
      } catch (e) {
        console.error("[AGENT FOLLOWUP] tick falhou:", (e as Error).message);
      } finally {
        globalThis.agentFollowupTicking = false;
      }
    }, 1000 * 120); // 2 minutos
  } else {
    console.info("[AGENT FOLLOWUP] Ticker desativado (defina AGENT_FOLLOWUP_WORKER_ENABLED=true para ativar).");
  }

  // ============================================================
  // AUTOMAÇÃO: orquestrador scrape → disparo → follow-up.
  // Ticker leve a cada 60s — só consulta automations(status=running)
  // e avança a máquina de estados (state machine no automation-worker).
  // ============================================================
  console.log("[AUTOMATION] Iniciando ticker (60s).");
  if (globalThis.automationTickerId) clearInterval(globalThis.automationTickerId);
  globalThis.automationTickerId = setInterval(async () => {
    if (globalThis.automationTicking) {
      console.log("[AUTOMATION] tick anterior em andamento, pulando.");
      return;
    }
    globalThis.automationTicking = true;
    try {
      const { tickAllAutomations } = await import("@/lib/automation-worker");
      const n = await tickAllAutomations();
      if (n > 0) console.log(`[AUTOMATION] tick processou ${n} automação(ões) ativas.`);
    } catch (e) {
      console.error("[AUTOMATION] tick falhou:", (e as Error).message);
    } finally {
      globalThis.automationTicking = false;
    }
  }, 1000 * 60);

  // ============================================================
  // DISPARO EM MASSA — rede de segurança (a cada 90s).
  // Campanha `running` no banco sem timer em memória (restart, deploy,
  // timer de "fora de horário" perdido de madrugada) é reativada aqui.
  // Sem isto, uma campanha podia ficar parada pra sempre — foi exatamente
  // o bug do disparo que iniciava de madrugada e nunca retomava às 8h.
  // ============================================================
  console.log("[CAMPAIGN] Iniciando ticker de auto-recuperação (90s).");
  if (globalThis.campaignTickerId) clearInterval(globalThis.campaignTickerId);
  globalThis.campaignTickerId = setInterval(async () => {
    if (globalThis.campaignTicking) {
      console.log("[CAMPAIGN] tick anterior em andamento, pulando.");
      return;
    }
    globalThis.campaignTicking = true;
    try {
      const { tickRunningCampaigns } = await import("@/lib/campaign-worker");
      const n = await tickRunningCampaigns();
      if (n > 0) console.log(`[CAMPAIGN] tick reativou ${n} campanha(s) órfã(s).`);
    } catch (e) {
      console.error("[CAMPAIGN] tick falhou:", (e as Error).message);
    } finally {
      globalThis.campaignTicking = false;
    }
  }, 1000 * 90);

  console.log("[FOLLOWUP] Iniciando ticker (2 min) — primeiro tick em 15s.");
  const { tickAllAutoCampaigns } = await import("@/lib/followup-worker");
  const { promoteStalePrimeiroContato } = await import("@/lib/auto-promoter");
  if (globalThis.followupTickerId) clearInterval(globalThis.followupTickerId);

  // Delay inicial de 15s para dar tempo ao Supabase ficar pronto no boot
  await new Promise(r => setTimeout(r, 15_000));
  console.log("[FOLLOWUP] Delay de boot concluído, ticker ativo.");

  globalThis.followupTickerId = setInterval(async () => {
    if (globalThis.followupTicking) {
      console.log("[FOLLOWUP] tick anterior em andamento, pulando.");
      return;
    }
    globalThis.followupTicking = true;
    try {
      // 1) Promove quem está há >24h em primeiro_contato (vindo de disparo) para follow-up
      try {
        const promoted = await promoteStalePrimeiroContato();
        if (promoted > 0) console.log(`[AUTO-PROMOTER] ${promoted} lead(s) promovidos para follow-up.`);
      } catch (e) {
        console.error("[AUTO-PROMOTER] falhou:", (e as Error).message);
      }
      // 2) Processa campanhas de follow-up ativas+auto
      try {
        const processed = await tickAllAutoCampaigns();
        if (processed > 0) console.log(`[FOLLOWUP] tick processou ${processed} target(s).`);
      } catch (e) {
        console.error("[FOLLOWUP] tick falhou:", (e as Error).message);
      }
    } finally {
      globalThis.followupTicking = false;
    }
  }, 1000 * 60 * 2);

  // ============================================================
  // APPOINTMENTS — lembrete + auto-promote do kanban
  // ============================================================
  // tickReminders roda a cada 60s pra cumprir reminders configurados
  // (offset_minutes antes do start_at). tickAutoPromote roda a cada
  // 5min pra mover leads pra estágio terminal positivo pós-atendimento.
  if (globalThis.appointmentTickerId) clearInterval(globalThis.appointmentTickerId);
  globalThis.appointmentTickerId = setInterval(async () => {
    if (globalThis.appointmentTicking) return;
    globalThis.appointmentTicking = true;
    try {
      const { tickReminders, tickAutoPromote } = await import("@/lib/appointment-worker");
      try {
        const r = await tickReminders();
        if (r.sent > 0 || r.errors > 0) console.log(`[APPOINTMENTS] reminders: ${r.sent} enviados, ${r.errors} erros, ${r.checked} verificados`);
      } catch (e) {
        console.error("[APPOINTMENTS] tickReminders falhou:", (e as Error).message);
      }
      // Auto-promote roda menos frequente — só a cada 5min (60*5 ticks de 60s).
      const tickN = (globalThis.appointmentTickN || 0) + 1;
      globalThis.appointmentTickN = tickN;
      if (tickN % 5 === 0) {
        try {
          const p = await tickAutoPromote();
          if (p.promoted > 0 || p.errors > 0) console.log(`[APPOINTMENTS] auto-promote: ${p.promoted} leads movidos, ${p.errors} erros`);
        } catch (e) {
          console.error("[APPOINTMENTS] tickAutoPromote falhou:", (e as Error).message);
        }
      }
      // Google sync server-side a cada 3min — espelho real-time independente
      // de usuário ter o /calendario aberto. Pega eventos criados/editados
      // direto no Google Calendar (fora do nosso painel).
      if (tickN % 3 === 0) {
        try {
          const { tickGoogleSyncAll } = await import("@/lib/google-calendar-sync");
          const g = await tickGoogleSyncAll();
          if (g.totalSynced > 0) {
            console.log(`[APPOINTMENTS] google-sync: ${g.totalSynced} eventos sincronizados em ${g.agents.length} agente(s)`);
          }
        } catch (e) {
          console.error("[APPOINTMENTS] tickGoogleSync falhou:", (e as Error).message);
        }
      }
    } finally {
      globalThis.appointmentTicking = false;
    }
  }, 1000 * 60); // 1 min

  // ============================================================
  // BACKUP AUTOMÁTICO — Google Drive
  // ============================================================
  // Agenda persistida; opt-in evita exportação automática durante setup/build.
  if (globalThis.backupTickerId) clearInterval(globalThis.backupTickerId);
  if (process.env.BACKUP_WORKER_ENABLED === "true") {
    const tickBackup = async () => {
      if (globalThis.backupTicking) return;
      globalThis.backupTicking = true;
      try {
        const { runBackupWorker } = await import("@/workers/backup-worker");
        await runBackupWorker();
      } catch {
        console.error("[BACKUP] Não foi possível iniciar o worker.");
      } finally {
        globalThis.backupTicking = false;
      }
    };
    void tickBackup();
    globalThis.backupTickerId = setInterval(() => { void tickBackup(); }, 60_000);
  }

  const workerControllers: AbortController[] = [];

  // ============================================================
  // SITE STUDIO — Worker de criação e edição de sites por IA
  // ============================================================
  // Em desenvolvimento ou quando explicitamente habilitado,
  // processa a fila de runs do Site Studio automaticamente.
  if (!globalThis.sitesWorkerStarted && (process.env.SITES_WORKER_ENABLED === "true" || process.env.NODE_ENV === "development")) {
    globalThis.sitesWorkerStarted = true;
    process.env.SITES_WORKER_ENABLED = "true";
    const workerController = new AbortController();
    workerControllers.push(workerController);
    void (async () => {
      try {
        console.log("[SCHEDULER] 🌐 Iniciando Site Studio Worker in-process...");
        const { startWebsiteWorker } = await import("@/lib/sites/worker");
        await startWebsiteWorker(workerController.signal);
      } catch (err: unknown) {
        globalThis.sitesWorkerStarted = false;
        console.error("[SCHEDULER] Site Studio Worker encerrou:", (err as Error)?.message || err);
      }
    })();
  }

  // ============================================================
  // PROSPECÇÃO AUTÔNOMA DE SITES — OpenCode + Impeccable + Vercel + QA
  // ============================================================
  // Processa a fila de prévias solicitadas com geração headless na VPS
  if (!globalThis.autonomousSiteWorkerStarted && (process.env.AUTONOMOUS_SITE_WORKER_ENABLED === "true" || process.env.NODE_ENV === "development")) {
    globalThis.autonomousSiteWorkerStarted = true;
    process.env.AUTONOMOUS_SITE_WORKER_ENABLED = "true";
    const workerController = new AbortController();
    workerControllers.push(workerController);
    void (async () => {
      try {
        console.log("[SCHEDULER] 🤖 Iniciando Autonomous Site Worker in-process...");
        const { startAutonomousSiteWorker } = await import("@/lib/sites/autonomous-worker-engine");
        await startAutonomousSiteWorker(workerController.signal);
      } catch (err: unknown) {
        globalThis.autonomousSiteWorkerStarted = false;
        console.error("[SCHEDULER] Autonomous Site Worker encerrou:", (err as Error)?.message || err);
      }
    })();
  }

  // ============================================================
  // AQUECER CHIPS (WARMUP) — Worker de maturação automática
  // ============================================================
  if (globalThis.warmupTickerId) clearInterval(globalThis.warmupTickerId);
  globalThis.warmupTickerId = setInterval(async () => {
    if (globalThis.warmupTicking) return;
    globalThis.warmupTicking = true;
    try {
      const { tickWarmupWorker } = await import("@/lib/warmup/warmup-worker");
      await tickWarmupWorker();
    } catch (e) {
      console.error("[WARMUP] tick falhou:", (e as Error).message);
    } finally {
      globalThis.warmupTicking = false;
    }
  }, 1000 * 60); // 1 minuto

  // ============================================================
  // WATCHDOG PREVENTIVO DE PROXIES — A cada 60 minutos
  // ============================================================
  if (globalThis.proxyWatchdogTickerId) clearInterval(globalThis.proxyWatchdogTickerId);
  globalThis.proxyWatchdogTickerId = setInterval(async () => {
    if (globalThis.proxyWatchdogTicking) return;
    globalThis.proxyWatchdogTicking = true;
    try {
      const { runAssignedProxyHealthWatchdog } = await import("@/lib/proxy-pool");
      const summary = await runAssignedProxyHealthWatchdog();
      if (summary.rotated > 0 || summary.fallbackVps > 0) {
        console.log(
          `[PROXY WATCHDOG] verificados=${summary.checked} ok=${summary.healthy} rotacionados=${summary.rotated} fallbackVps=${summary.fallbackVps}`
        );
      }
    } catch (e) {
      console.error("[PROXY WATCHDOG] falhou:", (e as Error).message);
    } finally {
      globalThis.proxyWatchdogTicking = false;
    }
  }, 60 * 60 * 1000);
  if (typeof globalThis.proxyWatchdogTickerId.unref === "function") {
    globalThis.proxyWatchdogTickerId.unref();
  }

  // ============================================================
  // FILA DE ENTREGA NATURAL DE PRÉVIAS (MÉTODO MENTOR) — A cada 1 min
  // ============================================================
  if (globalThis.previewQueueTickerId) clearInterval(globalThis.previewQueueTickerId);
  globalThis.previewQueueTickerId = setInterval(async () => {
    if (globalThis.previewQueueTicking) return;
    globalThis.previewQueueTicking = true;
    try {
      const { tickScheduledPreviewDeliveries } = await import("@/lib/preview-delivery-queue");
      await tickScheduledPreviewDeliveries();
    } catch (e) {
      console.error("[PREVIEW QUEUE] tick falhou:", (e as Error).message);
    } finally {
      globalThis.previewQueueTicking = false;
    }
  }, 60 * 1000);
  if (typeof globalThis.previewQueueTickerId.unref === "function") {
    globalThis.previewQueueTickerId.unref();
  }

  const stopBackgroundWorkers = () => {
    for (const timer of [
      globalThis.organizerWatcherId,
      globalThis.agentFollowupTickerId,
      globalThis.automationTickerId,
      globalThis.campaignTickerId,
      globalThis.followupTickerId,
      globalThis.appointmentTickerId,
      globalThis.backupTickerId,
      globalThis.warmupTickerId,
      globalThis.proxyWatchdogTickerId,
      globalThis.previewQueueTickerId,
    ]) {
      if (timer) clearInterval(timer);
    }
    for (const controller of workerControllers) {
      controller.abort();
    }
    globalThis.schedulerStarted = false;
  };

  // ============================================================
  // RETENÇÃO DE LOGS — Expurga webhook_logs > 30 dias (1x/dia)
  // Mantém ADMIN_AUDIT intacto e evita crescimento ilimitado no Postgres.
  // ============================================================
  const retentionGlobal = globalThis as typeof globalThis & { __logRetentionLastRun?: number };
  const runLogRetention = async () => {
    const now = Date.now();
    if (retentionGlobal.__logRetentionLastRun && now - retentionGlobal.__logRetentionLastRun < 24 * 3600_000) {
      return;
    }
    retentionGlobal.__logRetentionLastRun = now;
    try {
      const { supabaseAdmin } = await import("@/lib/supabase_admin");
      if (!supabaseAdmin) return;
      const cutoff = new Date(now - 30 * 24 * 3600_000).toISOString();
      await supabaseAdmin
        .from("webhook_logs")
        .delete()
        .lt("created_at", cutoff)
        .neq("event", "ADMIN_AUDIT");
    } catch {
      // non-fatal
    }
  };
  void runLogRetention();
  const runtimeProcess = Reflect.get(globalThis, "process") as NodeJS.Process | undefined;
  runtimeProcess?.once?.("SIGTERM", stopBackgroundWorkers);
  runtimeProcess?.once?.("SIGINT", stopBackgroundWorkers);
}
