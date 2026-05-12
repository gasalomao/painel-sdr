declare global {
  var schedulerStarted: boolean | undefined;
  var organizerTimerId: NodeJS.Timeout | undefined;
  var organizerWatcherId: NodeJS.Timeout | undefined;
  var followupTickerId: NodeJS.Timeout | undefined;
  var automationTickerId: NodeJS.Timeout | undefined;
}

/**
 * Agendador do Organizador IA.
 *
 * Política: roda **uma vez por dia** na hora configurada (ai_organizer_config.execution_hour).
 * Em vez de polling a cada 5 min, calcula o delay exato até o próximo disparo
 * com setTimeout e re-agenda após cada execução. Um watcher leve (a cada 10 min)
 * re-sincroniza o agendamento caso o operador mude `enabled` ou `execution_hour`.
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

  const runOrganizer = async (triggerLabel: "auto" | "schedule_catchup" = "auto") => {
    try {
      const { data: cfg } = await supabase
        .from("ai_organizer_config")
        .select("*")
        .eq("id", 1)
        .maybeSingle();

      if (!cfg) {
        console.warn("[SCHEDULER] ai_organizer_config não encontrada — verifique se rodou criar_ai_organizer.sql.");
        return;
      }
      if (!cfg.enabled) {
        console.log("[SCHEDULER] Organizer desativado, pulando disparo.");
        return;
      }
      if (!cfg.api_key || !cfg.model) {
        console.warn("[SCHEDULER] Sem api_key/model configurados — ignorando disparo.");
        return;
      }

      const now = new Date();
      const lastRunDate = cfg.last_run ? new Date(cfg.last_run).toDateString() : null;
      if (lastRunDate === now.toDateString()) {
        console.log("[SCHEDULER] Já rodou hoje. Pulando.");
        return;
      }

      console.log(`[SCHEDULER] ⏰ Disparando Organizer IA [${cfg.provider}/${cfg.model}] — trigger=${triggerLabel}...`);

      const baseUrl = process.env.INTERNAL_APP_URL || "http://localhost:3000";
      const response = await fetch(`${baseUrl}/api/ai-organize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: cfg.api_key,
          model: cfg.model,
          provider: cfg.provider,
          triggered_by: triggerLabel,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[SCHEDULER] ✅ ${result.updatedCount || 0} leads movidos.`);
        await supabase
          .from("ai_organizer_config")
          .update({ last_run: now.toISOString() })
          .eq("id", 1);
      } else {
        const errData = await response.json().catch(() => ({}));
        console.error("[SCHEDULER] ❌ Falha:", errData.error || response.statusText);
      }
    } catch (err) {
      console.error("[SCHEDULER] Erro no disparo:", (err as Error).message);
    }
  };

  // Calcula ms até o próximo `hour:00:00` (se já passou hoje, agenda pra amanhã)
  const msUntilNextRun = (hour: number) => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
  };

  let scheduledForHour: number | null = null;
  let scheduledEnabled = false;

  const schedule = async (force = false) => {
    try {
      const { data: cfg } = await supabase
        .from("ai_organizer_config")
        .select("enabled, execution_hour, last_run")
        .eq("id", 1)
        .maybeSingle();

      const enabled = !!cfg?.enabled;
      const hour = typeof cfg?.execution_hour === "number" ? cfg.execution_hour : 20;
      const lastRunDate = cfg?.last_run ? new Date(cfg.last_run).toDateString() : null;

      // Só re-agenda se algo mudou (ou força)
      if (!force && enabled === scheduledEnabled && hour === scheduledForHour) return;

      if (globalThis.organizerTimerId) {
        clearTimeout(globalThis.organizerTimerId);
        globalThis.organizerTimerId = undefined;
      }

      scheduledEnabled = enabled;
      scheduledForHour = hour;

      if (!enabled) {
        console.log("[SCHEDULER] Organizer desativado — nada agendado.");
        return;
      }

      // CATCH-UP: se já passou o horário agendado HOJE e ainda não rodou hoje,
      // dispara em ~10s (garante que o boot termine antes).
      const now = new Date();
      const todayTarget = new Date(now);
      todayTarget.setHours(hour, 0, 0, 0);
      const passedTodaysWindow = now.getTime() >= todayTarget.getTime();
      const ranToday = lastRunDate === now.toDateString();

      if (passedTodaysWindow && !ranToday) {
        const missedBy = Math.round((now.getTime() - todayTarget.getTime()) / 60000);
        console.log(`[SCHEDULER] 🕑 Janela de hoje (${hour}h) foi perdida há ${missedBy} min. Catch-up em 10s.`);
        globalThis.organizerTimerId = setTimeout(async () => {
          await runOrganizer("schedule_catchup");
          // Agora re-agenda pra janela de amanhã
          schedule(true).catch((e) => console.error("[SCHEDULER] Erro reagendando após catch-up:", e));
        }, 10_000);
        return;
      }

      const delay = msUntilNextRun(hour);
      const when = new Date(Date.now() + delay);
      console.log(
        `[SCHEDULER] Próxima execução do Organizer: ${when.toLocaleString("pt-BR")} (em ${Math.round(
          delay / 60000
        )} min)`
      );

      globalThis.organizerTimerId = setTimeout(async () => {
        await runOrganizer("auto");
        // Re-agenda para o próximo dia
        schedule(true).catch((e) =>
          console.error("[SCHEDULER] Erro reagendando após disparo:", e)
        );
      }, delay);
    } catch (err) {
      console.error("[SCHEDULER] Erro no schedule():", (err as Error).message);
    }
  };

  console.log("[SCHEDULER] Iniciando Organizer (execução 1x/dia).");
  await schedule(true);

  // Watcher: a cada 10 min verifica se o usuário mudou a hora/enabled e re-agenda
  if (globalThis.organizerWatcherId) clearInterval(globalThis.organizerWatcherId);
  globalThis.organizerWatcherId = setInterval(() => {
    schedule(false).catch(() => {});
  }, 1000 * 60 * 10);

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
    try {
      const { tickAllAutomations } = await import("@/lib/automation-worker");
      const n = await tickAllAutomations();
      if (n > 0) console.log(`[AUTOMATION] tick processou ${n} automação(ões) ativas.`);
    } catch (e) {
      console.error("[AUTOMATION] tick falhou:", (e as Error).message);
    }
  }, 1000 * 60);

  console.log("[FOLLOWUP] Iniciando ticker (2 min).");
  const { tickAllAutoCampaigns } = await import("@/lib/followup-worker");
  const { promoteStalePrimeiroContato } = await import("@/lib/auto-promoter");
  if (globalThis.followupTickerId) clearInterval(globalThis.followupTickerId);
  globalThis.followupTickerId = setInterval(async () => {
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
  }, 1000 * 60 * 2);
}
