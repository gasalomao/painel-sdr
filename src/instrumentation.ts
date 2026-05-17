declare global {
  var schedulerStarted: boolean | undefined;
  var organizerTimerId: NodeJS.Timeout | undefined;
  var organizerWatcherId: NodeJS.Timeout | undefined;
  var followupTickerId: NodeJS.Timeout | undefined;
  var automationTickerId: NodeJS.Timeout | undefined;
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
      const response = await fetch(`${baseUrl}/api/ai-organize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
  const tickClients = async () => {
    try {
      // 1) Config global é kill-switch + fonte do api_key/model/provider
      const { data: cfg } = await supabase
        .from("ai_organizer_config")
        .select("enabled, api_key, model, provider")
        .eq("id", 1)
        .maybeSingle();

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
        .select("id, nome, organizer_execution_hour, organizer_last_run, organizer_enabled")
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
          await runOrganizerForClient(c.id, c.nome || c.id, cfg as any, "auto");
          fired++;
        }
      }
      if (fired > 0) console.log(`[SCHEDULER] Tick processou ${fired} cliente(s) na janela.`);
    } catch (err) {
      console.error("[SCHEDULER] tickClients erro:", (err as Error).message);
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
    try {
      const { tickAllAutomations } = await import("@/lib/automation-worker");
      const n = await tickAllAutomations();
      if (n > 0) console.log(`[AUTOMATION] tick processou ${n} automação(ões) ativas.`);
    } catch (e) {
      console.error("[AUTOMATION] tick falhou:", (e as Error).message);
    }
  }, 1000 * 60);

  console.log("[FOLLOWUP] Iniciando ticker (2 min) — primeiro tick em 15s.");
  const { tickAllAutoCampaigns } = await import("@/lib/followup-worker");
  const { promoteStalePrimeiroContato } = await import("@/lib/auto-promoter");
  if (globalThis.followupTickerId) clearInterval(globalThis.followupTickerId);

  // Delay inicial de 15s para dar tempo ao Supabase ficar pronto no boot
  await new Promise(r => setTimeout(r, 15_000));
  console.log("[FOLLOWUP] Delay de boot concluído, ticker ativo.");

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
