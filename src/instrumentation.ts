declare global {
  var schedulerStarted: boolean | undefined;
  var organizerTimerId: NodeJS.Timeout | undefined;
  var organizerWatcherId: NodeJS.Timeout | undefined;
  var followupTickerId: NodeJS.Timeout | undefined;
  var automationTickerId: NodeJS.Timeout | undefined;
  var campaignTickerId: NodeJS.Timeout | undefined;
  var appointmentTickerId: NodeJS.Timeout | undefined;
  // Flags in-flight pra impedir overlap quando um tick demora mais que o intervalo
  var organizerTicking: boolean | undefined;
  var automationTicking: boolean | undefined;
  var campaignTicking: boolean | undefined;
  var followupTicking: boolean | undefined;
  var appointmentTicking: boolean | undefined;
  var appointmentTickN: number | undefined;
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

  if (globalThis.schedulerStarted) {
    console.log("[SCHEDULER] Já iniciado, pulando duplicidade.");
    return;
  }
  globalThis.schedulerStarted = true;

  // IMPORTANTE: usa o admin client pra contornar RLS. Com o anon, se a policy
  // de ai_organizer_config bloquear leitura, o scheduler silenciosamente nunca
  // dispara.
  const { supabaseAdmin, supabase: anonSb } = await import("@/lib/supabase");
  const supabase = supabaseAdmin || anonSb;

  // Dispara o Organizador pra UM cliente específico.
  const runOrganizerForClient = async (
    clientId: string,
    clientName: string,
    cfg: { api_key: string; model: string; provider: string },
    triggerLabel: "auto" | "schedule_catchup" = "auto"
  ) => {
    try {
      console.log(`[SCHEDULER] ⏰ [${clientName}] Disparando Organizer IA [${cfg.provider}/${cfg.model}] — trigger=${triggerLabel}...`);
      const baseUrl = process.env.INTERNAL_APP_URL || "http://localhost:3000";
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
      });
      if (response.ok) {
        const result = await response.json();
        console.log(`[SCHEDULER] ✅ [${clientName}] ${result.updatedCount || 0} leads movidos.`);
        // /api/ai-organize já marca clients.organizer_last_run quando clientId vem no body
      } else {
        const errData = await response.json().catch(() => ({}));
        console.error(`[SCHEDULER] ❌ [${clientName}] Falha:`, errData.error || response.statusText);
      }
    } catch (err) {
      console.error(`[SCHEDULER] [${clientName}] Erro no disparo:`, (err as Error).message);
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
      if (!cfg.api_key || !cfg.model) {
        console.warn("[SCHEDULER] Sem api_key/model — disparo abortado.");
        return;
      }

      // 2) Clientes elegíveis
      const { data: clients, error: clientsErr } = await supabase
        .from("clients")
        .select("id, name, organizer_execution_hour, organizer_last_run, organizer_enabled")
        .neq("organizer_enabled", false);
      if (clientsErr) {
        console.warn("[SCHEDULER] Erro lendo clients:", clientsErr.message);
        return;
      }

      const now = new Date();
      const todayStr = now.toDateString();
      const currentHour = now.getHours();
      let fired = 0;

      for (const c of clients || []) {
        const hour = typeof c.organizer_execution_hour === "number" ? c.organizer_execution_hour : 20;
        const lastRunDate = c.organizer_last_run ? new Date(c.organizer_last_run).toDateString() : null;
        const ranToday = lastRunDate === todayStr;
        const windowReached = currentHour >= hour;
        if (!ranToday && windowReached) {
          await runOrganizerForClient(c.id, (c as any).name || c.id, cfg as any, "auto");
          fired++;
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
}
