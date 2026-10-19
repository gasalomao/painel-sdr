/**
 * automation-worker — orquestrador de ponta a ponta:
 *
 *   AUTOMAÇÃO = scrape leads (nicho/região/filtros)
 *             → cria campaign + dispara em massa (intervalo, horário)
 *             → enrola leads em follow-up (steps, IA opcional)
 *             → IA do agente atende qualquer resposta automaticamente
 *
 * Cada `automation` tem uma máquina de estados em `phase`:
 *   idle → scraping → dispatching → following → done
 *
 * Este módulo NÃO reimplementa scraper/dispatch/follow-up — orquestra os
 * workers existentes:
 *   - /api/scraper          (Puppeteer + Google Maps)
 *   - lib/campaign-worker   (BullMQ-like timer)
 *   - lib/followup-worker   (ticker + IA por step)
 */

import { randomUUID } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { readCaptureIds, readRejectedCaptureIds, updateAutomationCapture, type AutomationCaptureRow } from "@/lib/automation-capture";
import { startCampaign, pauseCampaign } from "@/lib/campaign-worker";
import { enrollLeads } from "@/lib/followup-worker";
import { startScraperRun, stopScraper, getStatus as getScraperStatus } from "@/lib/scraper-engine";
import { requireAutomationClientId as requireClientId } from "@/lib/automation-lead-scope";
import { summarizeReviewsForLead } from "@/lib/reviews-ai";
import * as channel from "@/lib/channel";

type AutomationRow = any;

function requireAutomationClientId(a: AutomationRow): string {
  return requireClientId(a?.client_id);
}

/** Debounce anti-clique-múltiplo no botão Iniciar: id → último start (ms).
 *  Log real (EasyPanel) mostrou 3 clicks em <2s → 3 startAutomation
 *  concorrentes → 3 scrapers intercalados no mesmo Maps (logs duplicados,
 *  "Parando robô..." de forceRestart matando a sessão anterior). */
const lastStartAt = new Map<string, number>();
/** Start de fase de scrape em andamento: evita 2 ticks concorrentes
 *  (tick imediato do Iniciar + tick de 60s do instrumentation) lerem
 *  phase=idle ao mesmo tempo e dispararem 2× startScrapingPhase. */
const scrapeStartInFlight = new Set<string>();
/** Lock anti-reentrada do tick global. */
let ticking = false;

/**
 * Memória de progresso por automação (vive no processo Node). Serve pra os
 * heartbeats de disparo/follow-up só gravarem log QUANDO o número muda —
 * sem isso, a cada 60s entraria um log idêntico e inútil. O da captação
 * NÃO usa isso: lá o heartbeat a cada tick é proposital (mostra o scraper
 * "vivo" e o tempo ocioso crescendo quando ele trava).
 */
const lastProgressLog = new Map<
  string,
  { dispSent: number; dispFailed: number; follActive: number }
>();

/**
 * Insere um log estruturado pra automação. Visível em tempo real na UI
 * via realtime em automation_logs. NUNCA throw — falha em log nunca pode
 * derrubar o pipeline.
 */
const automationTenantCache = new Map<string, string>();

async function resolveAutomationClientId(automationId: string): Promise<string | null> {
  const cached = automationTenantCache.get(automationId);
  if (cached) return cached;
  const { data } = await supabase
    .from("automations")
    .select("client_id")
    .eq("id", automationId)
    .maybeSingle();
  try {
    const clientId = requireClientId(data?.client_id);
    automationTenantCache.set(automationId, clientId);
    return clientId;
  } catch {
    return null;
  }
}

async function log(
  automationId: string,
  kind: "scrape" | "dispatch" | "followup" | "reply" | "state" | "error",
  level: "info" | "success" | "warning" | "error",
  message: string,
  extra?: { remote_jid?: string; metadata?: Record<string, any> }
) {
  try {
    const clientId = await resolveAutomationClientId(automationId);
    if (!clientId) return;
    await supabase.from("automation_logs").insert({
      automation_id: automationId,
      client_id: clientId,
      kind,
      level,
      message: String(message).slice(0, 1000),
      remote_jid: extra?.remote_jid || null,
      metadata: extra?.metadata || {},
    });
  } catch (e) {
    console.warn("[AUTOMATION] falha gravando log:", (e as Error).message);
  }
}

/** Marca a automação com erro mas mantém ela viva pra retry manual. */
async function markError(id: string, msg: string) {
  console.error(`[AUTOMATION ${id}] ERRO:`, msg);
  const clientId = await resolveAutomationClientId(id);
  await log(id, "error", "error", msg);
  if (!clientId) return;
  await updateAutomationCapture(clientId, id, current => current.status !== "running" ? null : ({
    status: "error",
    phase: "error",
    last_error: String(msg).slice(0, 500),
    last_error_at: new Date().toISOString(),
    scrape_filters: {
      ...current.scrape_filters,
      _resumePhase: current.phase === "error" ? current.scrape_filters._resumePhase : current.phase,
      _captureAttemptId: null,
      _captureLeaseUntil: null,
    },
  }));
}

function captureGoal(a: AutomationRow): number {
  const goal = Number(a.scrape_max_leads || 200);
  if (!Number.isSafeInteger(goal) || goal <= 0) throw new Error("Meta de captação inválida.");
  return goal;
}

function validCaptureIds(filters: unknown): number[] {
  const rejected = new Set(readRejectedCaptureIds(filters));
  return readCaptureIds(filters).filter(id => !rejected.has(id));
}

function hasCaptureLease(filters: Record<string, unknown>): boolean {
  return typeof filters._captureAttemptId === "string" &&
    Date.parse(String(filters._captureLeaseUntil || "")) > Date.now();
}

/** Recupera apenas INSERTs desta sessão; nunca infere propriedade por faixa do CRM. */
async function reconcileCapture(a: AutomationRow): Promise<AutomationCaptureRow | null> {
  const clientId = requireAutomationClientId(a);
  const session = a.scrape_filters?._captureSessionId;
  const recovered: number[] = [];
  if (typeof session === "string") {
    // ponytail: recuperação limitada à meta; paginação por ID evita o teto de 1000 do PostgREST.
    let cursor = 0;
    const maximum = captureGoal(a);
    const known = readCaptureIds(a.scrape_filters);
    const knownSet = new Set(known);
    while (recovered.length < maximum) {
      const size = Math.min(500, maximum - recovered.length);
      const query = supabase.from("leads_extraidos").select("id")
        .eq("client_id", clientId)
        .eq("business_details->_automationCapture->>automationId", a.id)
        .eq("business_details->_automationCapture->>sessionId", session);
      const { data, error } = await query.gt("id", cursor).order("id", { ascending: true }).limit(size);
      if (error) throw new Error(`Falha recuperando vínculo da captura: ${error.message}`);
      const ids = (data || []).map(row => Number(row.id)).filter(id => Number.isSafeInteger(id) && id > cursor);
      for (const id of ids) {
        if (!knownSet.has(id)) recovered.push(id);
        if (recovered.length >= maximum) break;
      }
      if (ids.length < size) break;
      cursor = ids[ids.length - 1];
    }
  }
  const candidateIds = [...new Set([...readCaptureIds(a.scrape_filters), ...recovered])];
  const persisted = await selectCapturedLeads({ ...a, scrape_filters: { ...a.scrape_filters, _capturedLeadIds: candidateIds } });
  const valid = new Set(persisted.map(lead => lead.id));
  const invalid = candidateIds.filter(id => !valid.has(id));
  return updateAutomationCapture(clientId, a.id, current => {
    if (current.status !== a.status || current.phase !== a.phase || current.scrape_filters._captureSessionId !== session) return null;
    const filters = current.scrape_filters;
    const captured = [...new Set([...readCaptureIds(filters), ...recovered])];
    if (current.scraped_count > captured.length) {
      throw new Error("Progresso legado sem vínculo confiável dos leads. Contagem preservada; revise a propriedade antes de retomar.");
    }
    const nextFilters = { ...filters, _capturedLeadIds: captured,
      _rejectedLeadIds: [...new Set([...readRejectedCaptureIds(filters), ...invalid])] };
    return { scrape_filters: nextFilters, scraped_count: validCaptureIds(nextFilters).length };
  });
}

async function scheduleCaptureRetry(a: AutomationRow, reason: string): Promise<void> {
  const row = await updateAutomationCapture(requireAutomationClientId(a), a.id, current => {
    const filters = current.scrape_filters;
    if (current.status !== "running" || current.phase !== "scraping" || filters._captureSessionId !== a.scrape_filters?._captureSessionId ||
      filters._captureAttemptId !== a.scrape_filters?._captureAttemptId || hasCaptureLease(filters) || filters._captureRetryAt) return null;
    const failures = Math.min(20, Math.max(0, Number(filters._captureFailures) || 0) + 1);
    return {
      last_error: reason,
      last_error_at: new Date().toISOString(),
      scrape_filters: {
        ...filters, _captureAttemptId: null, _captureLeaseUntil: null,
        _captureFailures: failures,
        _captureRetryAt: new Date(Date.now() + Math.min(5 * 60_000, 30_000 * 2 ** (failures - 1))).toISOString(),
      },
    };
  });
  if (row) await log(a.id, "scrape", "warning", `${reason} Progresso preservado: ${row.scraped_count}/${captureGoal(a)}. Nova tentativa agendada.`);
}

/** Checkpoint e lease são confirmados ANTES de iniciar qualquer navegador. */
async function startScrapingPhase(a: AutomationRow): Promise<void> {
  const niches = Array.isArray(a.niches) ? a.niches : [];
  const regions = Array.isArray(a.regions) ? a.regions : [];
  if (!niches.length || !regions.length) return markError(a.id, "Niches e regiões são obrigatórios pra fase de scraping.");
  const clientId = requireAutomationClientId(a);
  if (getScraperStatus(clientId, a.id).isScraping) return;
  const reconciled = await reconcileCapture(a);
  if (!reconciled) return;
  const attempt = randomUUID();
  const now = new Date().toISOString();
  const row = await updateAutomationCapture(clientId, a.id, current => {
    const filters = current.scrape_filters;
    if (current.status !== "running" || !["idle", "scraping"].includes(current.phase) ||
      filters._captureSessionId !== reconciled.scrape_filters._captureSessionId || filters._captureAttemptId !== reconciled.scrape_filters._captureAttemptId ||
      hasCaptureLease(filters) || Date.parse(String(filters._captureRetryAt || "")) > Date.now() || validCaptureIds(filters).length >= captureGoal(current)) return null;
    return {
      phase: "scraping", last_error: null, last_error_at: null,
      scrape_filters: {
        ...filters,
        _captureSessionId: filters._captureSessionId || randomUUID(),
        _capturedLeadIds: readCaptureIds(filters), _rejectedLeadIds: readRejectedCaptureIds(filters),
        _captureAttemptId: attempt, _captureRetryAt: null,
        _captureHeartbeatAt: now, _captureLeaseUntil: new Date(Date.now() + 120_000).toISOString(),
        _scrapeStartedAt: filters._scrapeStartedAt || current.started_at || now,
        _lastProgressAt: filters._lastProgressAt || now, _scrapeFinishedAt: null,
      },
    };
  });
  if (!row) return;
  const filters = row.scrape_filters;
  // Não permite um start ultrapassado (por pausa/retomada concorrente) abrir o navegador.
  const current = await updateAutomationCapture(clientId, a.id, latest =>
    latest.status === "running" && latest.phase === "scraping" && latest.scrape_filters._captureAttemptId === attempt ? {} : null);
  if (!current) return;
  try {
    const r = startScraperRun({
      niches, regions, mode: "batch",
      filterEmpty: filters.filterEmpty !== false,
      filterDuplicates: filters.filterDuplicates !== false,
      filterLandlines: filters.filterLandlines === true,
      filterWithWebsite: filters.filterWithWebsite === true,
      filterWithInstagram: (filters.filterWithInstagram === undefined ? false : filters.filterWithInstagram) as boolean,
      minReviews: (filters.minReviews === undefined ? 0 : filters.minReviews) as number,
      captureAllReviews: filters.captureAllReviews === true,
      webhookEnabled: false,
      maxLeads: captureGoal(row) - validCaptureIds(filters).length,
      automation_id: a.id, client_id: clientId, captureAttemptId: attempt,
      forceRestart: false, topup: readRejectedCaptureIds(filters).length > 0,
    });
    if (!r.ok || r.alreadyRunning) {
      const released = await updateAutomationCapture(clientId, a.id, latest => latest.status === "running" &&
        latest.scrape_filters._captureAttemptId === attempt ? { scrape_filters: { ...latest.scrape_filters, _captureLeaseUntil: null } } : null);
      if (!released) return;
      if (!r.ok && !r.busy) return markError(a.id, `Scraper rejeitou: ${r.error}`);
      await scheduleCaptureRetry(released, r.error || "Scraper ocupado por outra captura.");
      return;
    }
    await log(a.id, "scrape", "info", `Captação iniciada: ${row.scraped_count}/${captureGoal(row)}. Buscando somente o restante.`);
  } catch (error) {
    const released = await updateAutomationCapture(clientId, a.id, latest => latest.status === "running" &&
      latest.scrape_filters._captureAttemptId === attempt ? { scrape_filters: { ...latest.scrape_filters, _captureLeaseUntil: null } } : null);
    if (released) await scheduleCaptureRetry(released, `Falha temporária no scraper: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type ScrapeCheck = {
  done: boolean;
  scrapedNow: number;
  progressed: boolean;
  idleSeconds: number;
  elapsedSeconds: number;
  doneReason: string | null;
};

async function checkScrapingDone(a: AutomationRow): Promise<ScrapeCheck> {
  const filters = a.scrape_filters || {};
  const started = Date.parse(String(filters._scrapeStartedAt || a.started_at || "")) || Date.now();
  const lastProgress = Date.parse(String(filters._lastProgressAt || "")) || started;
  const leads = await selectCapturedLeads(a);
  const scrapedNow = Math.min(captureGoal(a), leads.length);
  const done = scrapedNow === captureGoal(a);
  return {
    done, scrapedNow, progressed: scrapedNow > (a.scraped_count || 0),
    idleSeconds: Math.max(0, Math.round((Date.now() - lastProgress) / 1000)),
    elapsedSeconds: Math.max(0, Math.round((Date.now() - started) / 1000)),
    doneReason: done ? `limite de ${captureGoal(a)} leads atingido` : null,
  };
}

/**
 * FASE 2 — Cria a campanha de disparo a partir dos leads novos colhidos
 * desde que a automação começou e dispara via campaign-worker.
 */
async function startDispatchPhase(
  a: AutomationRow,
  doneInfo?: { reason: string | null; scrapedNow: number }
): Promise<void> {
  const clientId = requireAutomationClientId(a);
  if (a.status !== "running" || (await checkScrapingDone(a)).scrapedNow !== captureGoal(a)) return;
  // GUARDA DE IDEMPOTÊNCIA: se já existe campanha pra esta automação,
  // NÃO cria outra. Antes, race condition entre 2 ticks ou re-clicks fazia
  // 2 campanhas pros mesmos leads → mesmo número recebia 2x → ban no zap.
  if (a.campaign_id) {
    console.log(`[AUTOMATION ${a.id}] startDispatchPhase já criou campanha ${a.campaign_id} — pulando.`);
    return;
  }

  // Trava atômica via UPDATE condicional. Só prossegue se ESTE chamador
  // conseguiu mudar phase=scraping → phase=dispatching primeiro (ou retomar um dispatching sem campanha).
  const claimed = await updateAutomationCapture(clientId, a.id, current =>
    current.status === "running" &&
    (current.phase === "scraping" || (current.phase === "dispatching" && !current.campaign_id)) &&
    !current.campaign_id &&
    current.scrape_filters._captureSessionId === a.scrape_filters?._captureSessionId &&
    validCaptureIds(current.scrape_filters).length >= captureGoal(current)
      ? { phase: "dispatching", scrape_filters: { ...current.scrape_filters, _captureAttemptId: null, _captureLeaseUntil: null } }
      : null);
  if (!claimed) {
    console.log(`[AUTOMATION ${a.id}] outro tick já avançou pra dispatching — pulando.`);
    return;
  }
  // Log de transição SÓ DEPOIS de ganhar a trava — antes ficava no tick, e 2
  // ticks concorrentes logavam "Fase de captação encerrada" 2× (mesmo que só
  // um executasse de verdade).
  await log(a.id, "state", "info",
    `✅ Fase de captação encerrada${doneInfo?.reason ? ` (${doneInfo.reason})` : ""}. Avançando para o disparo…`,
    { metadata: { scrapedNow: doneInfo?.scrapedNow ?? null, reason: doneInfo?.reason ?? null } });

  if (!a.dispatch_template?.trim()) return markError(a.id, "Template de disparo vazio.");

  a = claimed;
  let leads = (await selectCapturedLeads(a)).slice(0, captureGoal(a));
  if (leads.length !== captureGoal(a)) {
    await topUpInvalidLeads(a, leads);
    return;
  }
  await log(a.id, "scrape", "success",
    `✅ Captação concluída · ${leads.length} lead(s) novo(s)`,
    { metadata: { count: leads.length } }
  );

  // ───────── RESUMO DE AVALIAÇÕES COM IA (reviews-ai) ─────────
  // Opcional via scrape_filters.reviews_ai {enabled, model, prompt}.
  // Roda ANTES do disparo pra {{resumo_avaliacoes}} resolver no template.
  // Best-effort: falha individual não bloqueia o disparo (fica só no log).
  const filters = a.scrape_filters || {};
  const reviewsAiCfg = filters.reviews_ai as { enabled?: boolean; model?: string; prompt?: string } | undefined;
  if (reviewsAiCfg?.enabled && reviewsAiCfg.model) {
    // SKIP 1: se NENHUM texto consumidor menciona {{resumo_avaliacoes}}, o
    // resumo é peso morto — gastar IA aqui é dinheiro jogado fora (o scraper
    // ainda gastou ~10s/lead abrindo TODAS as avaliações pra alimentar isso).
    const consumidorResumo = [
      a.dispatch_template,
      a.dispatch_ai_prompt,
      a.followup_ai_prompt,
      ...(Array.isArray(a.followup_steps) ? a.followup_steps.map((s: any) => s?.template || "") : []),
    ].filter(Boolean).join("\n");
    if (!/resumo_avaliacoes/.test(consumidorResumo)) {
      await log(a.id, "scrape", "info",
        `⏭️ Resumo de avaliações pulado — nenhum template/prompt usa {{resumo_avaliacoes}}.`);
    } else {
    await log(a.id, "scrape", "info",
      `🧠 Resumindo avaliações do Google com IA (${reviewsAiCfg.model}) pra ${leads.length} lead(s)...`
    );
    let ok = 0, cached = 0, semReviews = 0, falhas = 0;
    const motivos = new Map<string, number>();
    // CIRCUITO ABERTO: erro de chave/cooldown/quota NÃO é por-lead — é do
    // provider inteiro. Depois de 2 falhas consecutivas desse tipo, o resto
    // do loop é previsivelmente fadado; aborta e loga uma vez em vez de N.
    let breakerAbertos = 0;
    let consecutivosFatais = 0;
    for (let i = 0; i < leads.length; i++) {
      const l = leads[i];
      const name = (l.nome_negocio || `lead ${l.id}`).slice(0, 40);
      const idx = `[${i + 1}/${leads.length}]`;
      const bump = (msg: string) => motivos.set(msg, (motivos.get(msg) || 0) + 1);
      const fatal = (msg: string) => /cooldown|falharam|429|rate.?limit|quota|402|sem cr[eé]dito/i.test(msg);
      try {
        const r = await summarizeReviewsForLead({
          leadId: l.id,
          model: reviewsAiCfg.model,
          customPrompt: reviewsAiCfg.prompt || null,
          clientId,
          source: "automation",
          automationId: a.id,
        });
        if ("error" in r) {
          if (/sem avalia/i.test(r.error)) {
            semReviews++;
            consecutivosFatais = 0;
            await log(a.id, "scrape", "info", `   ${idx} ⏭️ ${name} — ${r.error}`);
          } else {
            falhas++;
            bump(r.error);
            if (!fatal(r.error)) consecutivosFatais = 0;
            await log(a.id, "scrape", "warning", `   ${idx} ❌ ${name} — ${r.error}`);
            // Provider morto (cooldown/chaves) volta como r.error, não throw.
            if (fatal(r.error) && ++consecutivosFatais >= 2) {
              breakerAbertos = leads.length - (i + 1);
              break;
            }
          }
        } else if (r.cached) {
          cached++;
          consecutivosFatais = 0;
          await log(a.id, "scrape", "info", `   ${idx} 💾 ${name} — resumo em cache`);
        } else {
          ok++;
          consecutivosFatais = 0;
          await log(a.id, "scrape", "success", `   ${idx} ✅ ${name} — resumo gerado`);
        }
      } catch (e: any) {
        falhas++;
        const msg = String(e?.message || e).slice(0, 160);
        bump(msg);
        if (!fatal(msg)) consecutivosFatais = 0;
        await log(a.id, "scrape", "warning", `   ${idx} ❌ ${name} — ${msg}`);
        if (fatal(msg) && ++consecutivosFatais >= 2) {
          breakerAbertos = leads.length - (i + 1);
          break;
        }
      }
    }
    if (breakerAbertos > 0) {
      await log(a.id, "scrape", "warning",
        `🔴 Circuito aberto — provider de IA indisponível (${reviewsAiCfg.model}). ${breakerAbertos} lead(s) restante(s) pulado(s); resumos podem ser gerados depois via aba Leads.`);
    }
    // Breakdown por motivo — sem isso, "N falha(s)" era mudo e ninguém sabia
    // POR QUE a IA não gerava (rate limit? chave morta? resposta vazia?).
    const motivoStr = Array.from(motivos.entries())
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([m, c]) => `${m} ×${c}`)
      .join(" | ");
    await log(a.id, "scrape", falhas ? "warning" : "success",
      `🧠 Resumo de avaliações: ${ok} gerado(s) · ${cached} em cache · ${semReviews} sem reviews · ${falhas} falha(s).` +
      (motivoStr ? ` Motivos: ${motivoStr}` : "")
    );
    }
  }

  // ───────── VALIDAÇÃO WHATSAPP + REPOSIÇÃO DOS INVÁLIDOS ─────────
  const validated = await canonicalizeAndFilterLeads(a, leads);
  leads = validated.leads;
  if (await topUpInvalidLeads(a, leads)) return;

  // ───────── LEAD INTELLIGENCE (opcional, antes do disparo) ─────────
  // Fluxo certo da automação: extrair → analisar (se ligado) → disparar.
  // O briefing fica cacheado e é injetado depois pelo:
  //   1. campaign-worker.personalizeWithAI (1ª msg)
  //   2. followup-worker.personalizeFollowupWithAI
  //   3. agent/process (agente que assume a conversa)
  if (a.lead_intelligence_enabled) {
    await log(a.id, "scrape", "info", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    await log(a.id, "scrape", "info", `🧠 LEAD INTELLIGENCE — analisando ${leads.length} lead(s)`);
    try {
      const { analyzeLead } = await import("@/lib/lead-intelligence");
      const { data: cfg } = await supabase
        .from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
      const { data: modelRow } = await supabase
        .from("app_settings").select("value").eq("key", "lead_intelligence_model").maybeSingle();
      const apiKey = cfg?.api_key;
      const { resolveModel } = await import("@/lib/ai-default-model");
      const intelModel = modelRow?.value || (await resolveModel(null)) || "gemini-2.5-flash";
      if (!apiKey) {
        await log(a.id, "scrape", "warning",
          "⚠️ Lead Intelligence ligado mas sem API Key Gemini. Pulando análise. Configure em /configuracoes.");
      } else {
        // Providers de busca/scraping disponíveis — informativo no log.
        const providers: string[] = [];
        if (process.env.TAVILY_API_KEY) providers.push("Tavily");
        if (process.env.BRAVE_SEARCH_API_KEY) providers.push("Brave");
        providers.push("DuckDuckGo");
        const scrapers: string[] = [process.env.JINA_API_KEY ? "Jina(auth)" : "Jina(free)"];
        if (process.env.FIRECRAWL_API_KEY) scrapers.push("Firecrawl");
        scrapers.push("fetch");
        await log(a.id, "scrape", "info",
          `   🔧 Modelo: ${intelModel}`);
        await log(a.id, "scrape", "info",
          `   🔍 Busca: ${providers.join(" → ")}`);
        await log(a.id, "scrape", "info",
          `   🕷️ Scraping: ${scrapers.join(" → ")}`);
        await log(a.id, "scrape", "info", `─────────────────────────────────`);

        // Em paralelo com chunks de 5 — equilíbrio velocidade × quota.
        let analyzed = 0, cachedHits = 0, errors = 0;
        const CHUNK = 5;
        const tStart = Date.now();
        for (let i = 0; i < leads.length; i += CHUNK) {
          const batch = leads.slice(i, i + CHUNK);
          const res = await Promise.allSettled(
            batch.map(l => analyzeLead({ leadId: l.id, apiKey, model: intelModel })),
          );
          // Log POR LEAD com sumário visível na UI.
          for (let k = 0; k < res.length; k++) {
            const r = res[k];
            const lead = batch[k];
            const idx = `[${i + k + 1}/${leads.length}]`;
            const name = (lead.nome_negocio || `lead ${lead.id}`).slice(0, 40);
            if (r.status === "fulfilled") {
              if ("error" in r.value) {
                errors++;
                await log(a.id, "scrape", "warning",
                  `   ${idx} ❌ ${name} — ${r.value.error}`);
              } else {
                analyzed++;
                if (r.value.cached) cachedHits++;
                const intel = r.value.intelligence;
                const s = intel?.sources;
                const sig: string[] = [];
                sig.push(r.value.cached ? "💾cache" : "🔬nova");
                if (s?.site_url) {
                  const pgs = s.site_pages_visited?.length || 0;
                  sig.push(`${s.site_discovered ? "🔎" : "🌐"}${pgs}p`);
                } else sig.push("🌐✗");
                if (s?.instagram_url) sig.push("📷");
                if (s?.facebook_url) sig.push("📘");
                sig.push(`🔍${(s?.search_lead?.length || 0)}+${(s?.search_competitors?.length || 0)}`);
                sig.push(`📊ICP ${intel.icp_score}`);
                sig.push(`${intel.lead_type}`);
                const icon = r.value.cached ? "💾" : (intel.icp_score >= 70 ? "🟢" : intel.icp_score >= 50 ? "🟡" : "🔴");
                await log(a.id, "scrape", "info",
                  `   ${idx} ${icon} ${name} → ${sig.join(" · ")}`);
              }
            } else {
              errors++;
              const errName = (lead.nome_negocio || `lead ${lead.id}`).slice(0, 40);
              await log(a.id, "scrape", "warning",
                `   ${idx} ❌ ${errName} — ${String(r.reason).slice(0, 200)}`);
            }
          }
        }
        const dur = Math.round((Date.now() - tStart) / 1000);
        await log(a.id, "scrape", "info", `─────────────────────────────────`);
        await log(a.id, "scrape", "success",
          `✅ Análise concluída em ${dur}s · ${analyzed} ok · ${cachedHits} cache · ${analyzed - cachedHits} nova(s)${errors > 0 ? ` · ${errors} falha(s)` : ""}`,
          { metadata: { analyzed, cachedHits, errors, model: intelModel, durationMs: Date.now() - tStart } });
        await log(a.id, "scrape", "info", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      }
    } catch (e: any) {
      await log(a.id, "scrape", "warning",
        `⚠️ Lead Intelligence falhou: ${e?.message || e}. Seguindo pro disparo sem briefing.`);
    }
  }

  // 1) cria campaigns. Marca `automation_id` pra que o /disparo não exiba
  // essa campanha (ela vive só dentro do card da automação). Se a coluna
  // não existir (DB antigo), tenta sem ela e segue.
  const ready = await updateAutomationCapture(clientId, a.id, current =>
    current.status === "running" && current.phase === "dispatching" && !current.campaign_id &&
    current.scrape_filters._captureSessionId === a.scrape_filters?._captureSessionId &&
    validCaptureIds(current.scrape_filters).length >= captureGoal(current) ? {} : null);
  if (!ready || leads.length !== captureGoal(a)) return;
  const campInsert: any = {
    client_id: clientId,
    name: `[Auto] ${a.name}`,
    instance_name: a.instance_name,
    agent_id: a.agent_id,
    message_template: a.dispatch_template,
    min_interval_seconds: a.dispatch_min_interval,
    max_interval_seconds: a.dispatch_max_interval,
    allowed_start_hour: a.allowed_start_hour,
    allowed_end_hour: a.allowed_end_hour,
    personalize_with_ai: !!a.dispatch_personalize,
    humanize_messages: !!a.dispatch_humanize,
    ai_model: a.dispatch_ai_model,
    ai_prompt: a.dispatch_ai_prompt,
    media_url: a.dispatch_media_url || null,
    media_type: a.dispatch_media_type || null,
    media_caption: a.dispatch_media_caption || null,
    media_file_name: a.dispatch_media_file_name || null,
    media_mimetype: a.dispatch_media_mimetype || null,
    status: "draft",
    total_targets: leads.length,
    automation_id: a.id,
  };
  let { data: camp, error: cErr } = await supabase
    .from("campaigns")
    .insert(campInsert)
    .select("id")
    .single();
  if (cErr && (cErr as any).code === "PGRST204") {
    // Coluna automation_id não existe ainda — fallback sem ela.
    console.warn("[AUTOMATION] coluna campaigns.automation_id não existe, rodando sem o filtro.");
    delete campInsert.automation_id;
    const retry = await supabase.from("campaigns").insert(campInsert).select("id").single();
    camp = retry.data; cErr = retry.error;
  }
  if (cErr || !camp?.id) return markError(a.id, `Falha criando campanha: ${cErr?.message}`);

  // 2) campaign_targets
  const targets = leads.map(l => ({
    campaign_id: camp.id,
    client_id: clientId,
    remote_jid: l.remoteJid,
    nome_negocio: l.nome_negocio,
    ramo_negocio: l.ramo_negocio,
    status: "pending",
  }));
  const { error: tErr } = await supabase
    .from("campaign_targets")
    .upsert(targets, { onConflict: "campaign_id,remote_jid", ignoreDuplicates: true });
  if (tErr) return markError(a.id, `Falha criando targets: ${tErr.message}`);

  // 3) start
  const linked = await updateAutomationCapture(clientId, a.id, current =>
    current.phase === "dispatching" && !current.campaign_id &&
    current.scrape_filters._captureSessionId === a.scrape_filters?._captureSessionId
      ? { campaign_id: camp.id, scraped_count: leads.length } : null);
  if (!linked || linked.status !== "running") return;
  await resumeDispatchCampaign(linked);
  console.log(`[AUTOMATION ${a.id}] Campanha ${camp.id} disparada com ${leads.length} leads.`);
  await log(a.id, "dispatch", "info",
    `📨 Disparo iniciado. ${leads.length} lead(s) na fila. Intervalo ${a.dispatch_min_interval}-${a.dispatch_max_interval}s, janela ${a.allowed_start_hour}h-${a.allowed_end_hour}h.${a.dispatch_personalize ? " IA reescrevendo cada mensagem." : ""}`,
    { metadata: { campaign_id: camp.id, count: leads.length, ai: !!a.dispatch_personalize } }
  );
}

type CapturedLead = { id: number; remoteJid: string; nome_negocio: string | null; ramo_negocio: string | null };

/** Só IDs persistidos desta captura, sempre no tenant; nunca uma faixa temporal do CRM. */
async function selectCapturedLeads(a: AutomationRow): Promise<CapturedLead[]> {
  const clientId = requireAutomationClientId(a);
  const ids = validCaptureIds(a.scrape_filters);
  const leads: CapturedLead[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabase.from("leads_extraidos")
      .select("id, remoteJid, nome_negocio, ramo_negocio, status")
      .eq("client_id", clientId).in("id", ids.slice(i, i + 500)).not("remoteJid", "is", null);
    if (error) throw new Error(`Falha lendo leads colhidos: ${error.message}`);
    for (const lead of data || []) {
      if (!lead.remoteJid || lead.status === "invalid_number" || seen.has(lead.remoteJid)) continue;
      seen.add(lead.remoteJid);
      leads.push(lead as CapturedLead);
    }
  }
  return leads;
}

/**
 * Validação WhatsApp + unificação de JID canônico. Remove da lista (e marca
 * no CRM) leads cujo número não existe no WhatsApp. Devolve a lista válida e
 * quantos foram removidos.
 */
async function canonicalizeAndFilterLeads(
  a: AutomationRow,
  leads: CapturedLead[],
): Promise<{ leads: CapturedLead[]; removed: number }> {
  const clientId = requireAutomationClientId(a);
  const phoneOf = (jid: string): string => jid.replace(/@.*$/, "").replace(/\D/g, "");
  let checks: Awaited<ReturnType<typeof channel.checkWhatsAppNumbersDetailed>> = {};
  try {
    checks = await channel.checkWhatsAppNumbersDetailed(leads.map(lead => phoneOf(lead.remoteJid)), a.instance_name);
  } catch (err) {
    console.warn(`[AUTOMATION ${a.id}] Validação WhatsApp temporariamente indisponível (${(err as Error).message}). Prosseguindo com os números capturados.`);
  }
  const valid: CapturedLead[] = [];
  const seen = new Set<string>();
  for (const lead of leads) {
    const entry = checks[phoneOf(lead.remoteJid)];
    if (entry?.exists === false) {
      const { error } = await supabase.from("leads_extraidos").update({ status: "invalid_number" })
        .eq("id", lead.id).eq("client_id", clientId);
      if (error) throw new Error(`Falha persistindo número inválido: ${error.message}`);
      continue;
    }
    const jid = entry?.jid || lead.remoteJid;
    if (seen.has(jid)) continue;
    if (jid !== lead.remoteJid) {
      const { error } = await supabase.from("leads_extraidos").update({ remoteJid: jid })
        .eq("id", lead.id).eq("client_id", clientId);
      // Colisão com lead pré-existente não transfere sua propriedade para esta captura.
      if (error?.code === "23505") continue;
      if (error) throw new Error(`Falha persistindo JID canônico: ${error.message}`);
    }
    seen.add(jid);
    valid.push({ ...lead, remoteJid: jid });
  }
  return { leads: valid, removed: leads.length - valid.length };
}

/** Reposição persistida para o próximo tick; nunca bloqueia o scheduler esperando navegador. */
async function topUpInvalidLeads(a: AutomationRow, leads: CapturedLead[]): Promise<boolean> {
  if (leads.length === captureGoal(a)) return false;
  const valid = new Set(leads.map(lead => lead.id));
  const row = await updateAutomationCapture(requireAutomationClientId(a), a.id, current => {
    if (current.status !== "running" || current.phase !== "dispatching" || current.campaign_id ||
      current.scrape_filters._captureSessionId !== a.scrape_filters?._captureSessionId) return null;
    const rejected = [...new Set([...readRejectedCaptureIds(current.scrape_filters), ...readCaptureIds(current.scrape_filters).filter(id => !valid.has(id))])];
    return {
      phase: "scraping", scraped_count: leads.length,
      last_error: "Reposição pendente: leads inválidos ou repetidos não contam para a meta.",
      scrape_filters: {
        ...current.scrape_filters, _rejectedLeadIds: rejected,
        _captureAttemptId: null, _captureLeaseUntil: null,
        _captureRetryAt: new Date(Date.now() + 30_000).toISOString(),
      },
    };
  });
  if (row) await log(a.id, "scrape", "warning", `Reposição agendada: ${leads.length}/${captureGoal(a)} válidos. Nenhum disparo iniciado.`);
  return true;
}


/** startCampaign reseta enviados quando não há pending: nunca chamar sem auditar a fila. */
async function resumeDispatchCampaign(a: AutomationRow): Promise<void> {
  if (!a.campaign_id || a.status !== "running") return;
  const clientId = requireAutomationClientId(a);
  const { data: campaign, error } = await supabase.from("campaigns").select("status")
    .eq("id", a.campaign_id).eq("client_id", clientId).maybeSingle();
  if (error) throw new Error(`Falha lendo campanha: ${error.message}`);
  if (!campaign || !["paused", "draft"].includes(campaign.status)) return;
  const count = async (status: string): Promise<number> => {
    const result = await supabase.from("campaign_targets").select("*", { count: "exact", head: true })
      .eq("campaign_id", a.campaign_id).eq("client_id", clientId).eq("status", status);
    if (result.error) throw new Error(`Falha lendo fila da campanha: ${result.error.message}`);
    return result.count || 0;
  };
  const [pending, processing] = await Promise.all([count("pending"), count("processing")]);
  if (processing) throw new Error("Campanha com envio em processing ambíguo. Revise o WhatsApp antes de retomar para evitar duplicidade.");
  if (!pending) return;
  const capturedLeads = await selectCapturedLeads(a);
  const allowedJids = new Set(capturedLeads.map(lead => lead.remoteJid));
  const { data: targetRows, error: targetsError } = await supabase.from("campaign_targets")
    .select("remote_jid").eq("campaign_id", a.campaign_id).eq("client_id", clientId);
  if (targetsError) throw new Error(`Falha validando alvos da campanha: ${targetsError.message}`);
  if ((targetRows || []).some(target => !allowedJids.has(target.remote_jid))) {
    throw new Error("Campanha contém destinatários fora do escopo confirmado da captura. Revise a propriedade antes de retomar.");
  }
  const current = await updateAutomationCapture(clientId, a.id, row => {
    if (row.status !== "running" || row.phase !== "dispatching" || row.campaign_id !== a.campaign_id) return null;
    if (row.scraped_count !== captureGoal(row)) throw new Error("Disparo abaixo da meta ou com contagem divergente. Campanha e progresso preservados; revise antes de retomar.");
    return {};
  });
  if (!current) return;
  const result = await startCampaign(a.campaign_id);
  if (!result.ok) throw new Error(`Falha startando campanha: ${result.error}`);
  // Se a pausa venceu durante startCampaign, não deixa o timer recém-criado ativo.
  const after = await updateAutomationCapture(clientId, a.id, row => row.status === "running" && row.campaign_id === a.campaign_id ? {} : null);
  if (!after) await pauseCampaign(a.campaign_id);
}

async function checkDispatchDone(a: AutomationRow): Promise<{
  done: boolean;
  status: string | null;
  sent: number;
  failed: number;
  pending: number;
  total: number;
}> {
  const empty = { done: false, status: null, sent: 0, failed: 0, pending: 0, total: 0 };
  if (!a.campaign_id) return empty;
  const clientId = requireAutomationClientId(a);
  const { data: c } = await supabase
    .from("campaigns")
    .select("status")
    .eq("id", a.campaign_id)
    .eq("client_id", clientId)
    .maybeSingle();
  const status = c?.status || null;

  const countBy = async (st: string) => {
    const { count } = await supabase
      .from("campaign_targets")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", a.campaign_id)
      .eq("client_id", clientId)
      .eq("status", st);
    return count || 0;
  };
  const [sent, failed, pending, processing] = await Promise.all([
    countBy("sent"),
    countBy("failed"),
    countBy("pending"),
    countBy("processing"),
  ]);

  return {
    done: status === "done" && processing === 0,
    status,
    sent,
    failed,
    pending,
    total: sent + failed + pending,
  };
}

async function resumeFollowupCampaign(a: AutomationRow): Promise<void> {
  if (!a.followup_campaign_id || a.status !== "running") return;
  const clientId = requireAutomationClientId(a);
  const active = await updateAutomationCapture(clientId, a.id, row =>
    row.status === "running" && row.phase === "following" && row.followup_campaign_id === a.followup_campaign_id ? {} : null);
  if (!active) return;
  const { error } = await supabase.from("followup_campaigns")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", a.followup_campaign_id).eq("client_id", clientId).eq("status", "paused");
  if (error) throw new Error(`Falha retomando follow-up: ${error.message}`);
  const after = await updateAutomationCapture(clientId, a.id, row =>
    row.status === "running" && row.phase === "following" && row.followup_campaign_id === a.followup_campaign_id ? {} : null);
  if (!after) {
    const paused = await supabase.from("followup_campaigns").update({ status: "paused", updated_at: new Date().toISOString() })
      .eq("id", a.followup_campaign_id).eq("client_id", clientId).eq("status", "active");
    if (paused.error) throw new Error(`Falha preservando pausa do follow-up: ${paused.error.message}`);
  }
}

/**
 * FASE 3 — Cria a follow-up campaign e enrola os leads que foram disparados.
 */
async function startFollowupPhase(a: AutomationRow): Promise<void> {
  const clientId = requireAutomationClientId(a);
  // Idempotência: se já criou follow-up, pula.
  if (a.followup_campaign_id) {
    console.log(`[AUTOMATION ${a.id}] startFollowupPhase já criou follow-up ${a.followup_campaign_id} — pulando.`);
    return;
  }
  // Trava atômica: só prossegue se conseguiu mudar phase=dispatching → following.
  const claimed = await updateAutomationCapture(clientId, a.id, row =>
    row.status === "running" && row.phase === "dispatching" && row.campaign_id === a.campaign_id && !row.followup_campaign_id
      ? { phase: "following" } : null);
  if (!claimed) {
    console.log(`[AUTOMATION ${a.id}] outro tick já avançou pra following — pulando.`);
    return;
  }

  const steps = Array.isArray(a.followup_steps) ? a.followup_steps : [];
  // followup_enabled é o toggle explícito do usuário (default TRUE).
  // Se desligado OU sem steps → pula direto pra done.
  const followupEnabled = a.followup_enabled !== false;
  if (!followupEnabled || steps.length === 0) {
    await log(a.id, "state", "info",
      followupEnabled
        ? "✓ Sem follow-up configurado. Automação concluída."
        : "✓ Follow-up desativado. Automação concluída.",
    );
    await updateAutomationCapture(clientId, a.id, row =>
      row.status === "running" && row.phase === "following" && row.campaign_id === a.campaign_id
        ? { phase: "done", status: "done" } : null);
    return;
  }

  // Pega leads que JÁ foram disparados com sucesso.
  const { data: targets, error: targetsError } = await supabase
    .from("campaign_targets")
    .select("remote_jid")
    .eq("campaign_id", a.campaign_id)
    .eq("client_id", clientId)
    .eq("status", "sent");
  if (targetsError) throw new Error(`Falha lendo destinatários do follow-up: ${targetsError.message}`);
  if (!targets || targets.length === 0) {
    await updateAutomationCapture(clientId, a.id, row =>
      row.status === "running" && row.phase === "following" && row.campaign_id === a.campaign_id
        ? { phase: "done", status: "done", last_error: "Nenhum lead foi disparado com sucesso — pulando follow-up." } : null);
    return;
  }

  // 1) cria followup_campaigns
  const { data: fcamp, error: fcErr } = await supabase
    .from("followup_campaigns")
    .insert({
      client_id: clientId,
      name: `[Auto] ${a.name}`,
      instance_name: a.instance_name,
      ai_enabled: !!a.followup_ai_enabled,
      humanize_messages: !!a.dispatch_humanize,
      ai_model: a.followup_ai_model,
      ai_prompt: a.followup_ai_prompt,
      media_url: a.dispatch_media_url || null,
      media_type: a.dispatch_media_type || null,
      media_caption: a.dispatch_media_caption || null,
      media_file_name: a.dispatch_media_file_name || null,
      media_mimetype: a.dispatch_media_mimetype || null,
      steps,
      min_interval_seconds: a.followup_min_interval,
      max_interval_seconds: a.followup_max_interval,
      allowed_start_hour: a.allowed_start_hour,
      allowed_end_hour: a.allowed_end_hour,
      auto_execute: true,
      status: "paused",
    })
    .select("id")
    .single();
  if (fcErr || !fcamp?.id) return markError(a.id, `Falha criando follow-up: ${fcErr?.message}`);

  // 2) Enrola enquanto a campanha está pausada; ativação somente após checkpoint.
  const remoteJids = targets.map(t => t.remote_jid).filter(Boolean);
  const leadIds: number[] = [];
  for (let offset = 0; offset < remoteJids.length; offset += 100) {
    const chunk = remoteJids.slice(offset, offset + 100);
    const { data: leadRows, error: leadsError } = await supabase
      .from("leads_extraidos")
      .select("id")
      .eq("client_id", clientId)
      .in("remoteJid", chunk);
    if (leadsError) throw new Error(`Falha lendo leads do follow-up: ${leadsError.message}`);
    leadIds.push(...(leadRows || []).map(l => Number(l.id)));
  }
  const r = await enrollLeads({ campaignId: fcamp.id, leadIds, clientId });
  if (!r.ok) return markError(a.id, `Falha enrolando follow-up: ${r.error}`);
  const linked = await updateAutomationCapture(clientId, a.id, row =>
    row.phase === "following" && row.campaign_id === a.campaign_id && !row.followup_campaign_id
      ? { followup_campaign_id: fcamp.id } : null);
  if (!linked) return;
  await resumeFollowupCampaign(linked);
  console.log(`[AUTOMATION ${a.id}] Follow-up ${fcamp.id} ativo com ${r.enrolled} leads.`);
  await log(a.id, "dispatch", "success",
    `✓ Disparo concluído. ${targets.length} lead(s) entregue(s).`,
    { metadata: { sent: targets.length } }
  );
  await log(a.id, "followup", "info",
    `🔁 Follow-up ativado. ${r.enrolled} lead(s) na cadência de ${steps.length} step(s).${a.followup_ai_enabled ? " IA personalizando." : ""}`,
    { metadata: { followup_campaign_id: fcamp.id, enrolled: r.enrolled, steps: steps.length, ai: !!a.followup_ai_enabled } }
  );
}

/**
 * Verifica se o follow-up terminou (ninguém mais "pending" ou "waiting").
 * Devolve também a contagem de leads ativos pra o tick logar o progresso.
 */
async function checkFollowupDone(a: AutomationRow): Promise<{ done: boolean; active: number }> {
  if (!a.followup_campaign_id) return { done: false, active: 0 };
  const clientId = requireAutomationClientId(a);
  const { count: ativos, error } = await supabase
    .from("followup_targets")
    .select("*", { count: "exact", head: true })
    .eq("followup_campaign_id", a.followup_campaign_id)
    .eq("client_id", clientId)
    .in("status", ["pending", "waiting", "processing"]);
  if (error) throw new Error(`Falha lendo progresso do follow-up: ${error.message}`);
  return { done: (ativos || 0) === 0, active: ativos || 0 };
}

/**
 * Tick por automação: avança 1 fase se aplicável. Idempotente.
 */
async function tickOne(a: AutomationRow) {
  if (a.status !== "running") return;

  try {
    const clientId = requireAutomationClientId(a);
    automationTenantCache.set(a.id, clientId);
    if (a.phase === "idle") {
      // GUARDA: 2 ticks concorrentes (imediato + 60s) podem ler phase=idle
      // juntos e disparar o scraper 2×. O Set segura o segundo até o
      // primeiro concluir (aí a phase já virou "scraping" no banco).
      if (!scrapeStartInFlight.has(a.id)) {
        scrapeStartInFlight.add(a.id);
        try {
          await startScrapingPhase(a);
        } finally {
          scrapeStartInFlight.delete(a.id);
        }
      }
      return;
    }

    if (a.phase === "scraping") {
      const reconciled = await reconcileCapture(a);
      if (!reconciled) return;
      const r = await checkScrapingDone(reconciled);
      const checkpoint = await updateAutomationCapture(clientId, a.id, current => {
        if (current.status !== "running" || current.phase !== "scraping" ||
          current.scrape_filters._captureSessionId !== reconciled.scrape_filters._captureSessionId) return null;
        // Não grava contagem de um snapshot anterior sobre INSERT recém-confirmado.
        if (JSON.stringify(readCaptureIds(current.scrape_filters)) !== JSON.stringify(readCaptureIds(reconciled.scrape_filters))) return null;
        return {
          scraped_count: r.scrapedNow,
          scrape_filters: { ...current.scrape_filters, ...(r.progressed ? { _lastProgressAt: new Date().toISOString(), _captureFailures: 0 } : {}) },
        };
      });
      if (!checkpoint) return;
      if (r.done) {
        try { await startDispatchPhase(checkpoint, { reason: r.doneReason, scrapedNow: r.scrapedNow }); }
        catch (error) { await markError(a.id, error instanceof Error ? error.message : String(error)); }
        return;
      }
      const filters = checkpoint.scrape_filters;
      const localActive = getScraperStatus(clientId, a.id).isScraping;
      if (hasCaptureLease(filters) || (localActive && !filters._scrapeFinishedAt)) return;
      if (!filters._captureRetryAt) {
        await scheduleCaptureRetry(checkpoint, "Tentativa encerrada ou indisponível abaixo da meta.");
      } else if (Date.parse(String(filters._captureRetryAt)) <= Date.now() && !localActive && !scrapeStartInFlight.has(a.id)) {
        scrapeStartInFlight.add(a.id);
        try { await startScrapingPhase(checkpoint); } finally { scrapeStartInFlight.delete(a.id); }
      }
      return;
    }

    if (a.phase === "dispatching") {
      if (!a.campaign_id) {
        await startDispatchPhase(a);
        return;
      }
      await resumeDispatchCampaign(a);
      const d = await checkDispatchDone(a);
      if (d.done) {
        lastProgressLog.delete(a.id);
        await log(a.id, "dispatch", "success",
          `📨 Disparo concluído — ${d.sent} enviado(s)${d.failed > 0 ? `, ${d.failed} falha(s)` : ""}. Avançando para o follow-up…`,
          { metadata: { sent: d.sent, failed: d.failed, total: d.total } });
        await startFollowupPhase(a);
      } else {
        // Heartbeat de disparo — só grava quando enviados/falhas mudaram,
        // pra não encher o log de linhas idênticas a cada 60s.
        const prev = lastProgressLog.get(a.id);
        if (!prev || prev.dispSent !== d.sent || prev.dispFailed !== d.failed) {
          await log(a.id, "dispatch", "info",
            `📨 Disparo em andamento — ${d.sent}/${d.total} enviado(s)${d.failed > 0 ? ` · ${d.failed} falha(s)` : ""} · ${d.pending} na fila.`,
            { metadata: { sent: d.sent, failed: d.failed, pending: d.pending, total: d.total, status: d.status } });
        }
        lastProgressLog.set(a.id, {
          dispSent: d.sent,
          dispFailed: d.failed,
          follActive: prev?.follActive ?? -1,
        });
      }
      return;
    }

    if (a.phase === "following") {
      const f = await checkFollowupDone(a);
      if (f.done) {
        lastProgressLog.delete(a.id);
        const completed = await updateAutomationCapture(clientId, a.id, row =>
          row.status === "running" && row.phase === "following" && row.followup_campaign_id === a.followup_campaign_id
            ? { phase: "done", status: "done" } : null);
        if (completed) await log(a.id, "state", "success", "🏁 Automação concluída. Todos os leads foram processados.");
      } else {
        // Heartbeat de follow-up — só grava quando o nº de leads ativos muda.
        const prev = lastProgressLog.get(a.id);
        if (!prev || prev.follActive !== f.active) {
          await log(a.id, "followup", "info",
            `🔁 Follow-up em andamento — ${f.active} lead(s) ainda na cadência.`,
            { metadata: { active: f.active } });
        }
        lastProgressLog.set(a.id, {
          dispSent: prev?.dispSent ?? -1,
          dispFailed: prev?.dispFailed ?? -1,
          follActive: f.active,
        });
      }
      return;
    }

    // Fase desconhecida — não deveria acontecer, mas registra pra não sumir.
    if (a.phase && !["error", "paused", "done"].includes(a.phase)) {
      await log(a.id, "state", "warning",
        `⚠️ Automação em fase desconhecida ("${a.phase}"). Clique em Iniciar pra recomeçar.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (["idle", "scraping"].includes(a.phase) && !/Progresso legado|Meta de captação inválida/.test(message)) {
        await scheduleCaptureRetry(a, `Falha temporária de captação: ${message}`);
      } else {
        await markError(a.id, message);
      }
    } catch (persistError) { console.error(`[AUTOMATION ${a.id}] falha preservando estado:`, persistError); }
  }
}

/**
 * Tick global. Chamado pelo instrumentation a cada 60s.
 */
export async function tickAllAutomations(): Promise<number> {
  // Lock anti-reentrada: tick imediato do Iniciar + tick do timer de 60s
  // não podem rodar sobrepostos — davam 2× startScrapingPhase/heartbeat.
  if (ticking) return 0;
  ticking = true;
  try {
    const { data } = await supabase
      .from("automations")
      .select("*")
      .eq("status", "running")
      .neq("phase", "done");
    if (!data || data.length === 0) return 0;
    for (const a of data) {
      await tickOne(a);
    }
    return data.length;
  } finally {
    ticking = false;
  }
}

/** Retoma o checkpoint existente; reiniciar não significa apagar progresso nem reenviar. */
export async function startAutomation(id: string, clientIdInput: string): Promise<{ ok: boolean; error?: string; phase?: string }> {
  const clientId = requireClientId(clientIdInput);
  // Debounce local complementa o CAS persistido; pausa limpa a trava para permitir retomada imediata.
  const last = lastStartAt.get(id) || 0;
  if (Date.now() - last < 8000) {
    return { ok: false, error: "Automação já foi iniciada há poucos segundos — aguarde ela arrancar antes de clicar de novo." };
  }
  lastStartAt.set(id, Date.now());

  const { data: a } = await supabase.from("automations").select("*").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!a) return { ok: false, error: "Automação não encontrada." };
  automationTenantCache.set(id, clientId);

  await log(id, "state", "info", "▶️ Botão Iniciar acionado — validando configuração…");

  // Validação de pré-requisitos antes de virar status=running. Sem esses,
  // a automação morreria silenciosamente no primeiro tick. Cada falha vira
  // log de erro pra ficar visível no painel (não só no retorno da API).
  const fail = async (msg: string): Promise<{ ok: false; error: string }> => {
    await log(id, "error", "error", `❌ Não foi possível iniciar: ${msg}`);
    return { ok: false, error: msg };
  };
  const niches  = Array.isArray(a.niches)  ? a.niches  : [];
  const regions = Array.isArray(a.regions) ? a.regions : [];
  if (niches.length === 0) return fail("Configure pelo menos 1 nicho antes de iniciar.");
  if (regions.length === 0) return fail("Configure pelo menos 1 região antes de iniciar.");
  if (!a.instance_name) return fail("Selecione uma instância WhatsApp.");
  if (!a.dispatch_template?.trim()) return fail("Template de disparo está vazio.");

  try {
    const dispatchPhase = a.followup_campaign_id ? "following" : a.campaign_id ? "dispatching" : null;
    if (a.status === "done" && dispatchPhase) return { ok: true, phase: "done" };
    const checkpoint = await reconcileCapture(a);
    if (!checkpoint) return fail("Estado alterado durante a retomada. Atualize e tente novamente.");
    const resumed = await updateAutomationCapture(clientId, id, current => {
      if (current.status !== checkpoint.status || current.phase !== checkpoint.phase) return null;
      const filters = current.scrape_filters;
      const phase = current.followup_campaign_id ? "following" : current.campaign_id ? "dispatching"
        : ["dispatching", "following"].includes(current.phase) ? current.phase
        : typeof filters._resumePhase === "string" && ["dispatching", "following"].includes(filters._resumePhase) ? filters._resumePhase
        : "scraping";
      if (phase === "following" && !current.followup_campaign_id) {
        throw new Error("Follow-up interrompido sem vínculo de campanha. Revise a campanha antes de retomar para evitar duplicidade.");
      }
      return {
        status: "running", phase,
        started_at: current.started_at || new Date().toISOString(),
        last_error: null, last_error_at: null,
        scrape_filters: {
          ...filters, _resumePhase: phase,
          ...(phase === "scraping" ? {
            _captureSessionId: filters._captureSessionId || randomUUID(),
            _capturedLeadIds: readCaptureIds(filters), _rejectedLeadIds: readRejectedCaptureIds(filters),
          } : {}),
        },
      };
    });
    if (!resumed) return fail("Estado alterado durante a retomada. Atualize e tente novamente.");
    if (resumed.phase === "dispatching") {
      await resumeDispatchCampaign(resumed);
    } else if (resumed.phase === "following" && resumed.followup_campaign_id) {
      await resumeFollowupCampaign(resumed);
    } else {
      const filters = resumed.scrape_filters;
      if (validCaptureIds(filters).length >= captureGoal(resumed)) {
        await tickOne(resumed);
      } else if (!hasCaptureLease(filters) && !Date.parse(String(filters._captureRetryAt || "")) && !getScraperStatus(clientId, id).isScraping) {
        await startScrapingPhase(resumed);
      } else {
        await tickOne(resumed);
      }
    }
    const { data: after, error } = await supabase.from("automations").select("phase, status, last_error")
      .eq("id", id).eq("client_id", clientId).maybeSingle();
    if (error) throw new Error(error.message);
    if (after?.status === "error") return fail(after.last_error || "Falha ao iniciar automação.");
    return { ok: true, phase: after?.phase };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Pausa durável primeiro; callbacks antigos perdem seu token antes de fechar o navegador. */
export async function pauseAutomation(id: string, clientIdInput: string): Promise<{ ok: boolean; error?: string; stopped: { scraper: boolean; campaign: boolean; followup: boolean } }> {
  const clientId = requireClientId(clientIdInput);
  const stopped = { scraper: false, campaign: false, followup: false };
  let a: AutomationCaptureRow | null;
  try {
    a = await updateAutomationCapture(clientId, id, current => ({
      status: "paused",
      scrape_filters: {
        ...current.scrape_filters,
        _resumePhase: ["paused", "error"].includes(current.phase) ? current.scrape_filters._resumePhase || "scraping" : current.phase,
        _captureAttemptId: null, _captureRetryAt: null, _captureLeaseUntil: null,
      },
    }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), stopped };
  }
  if (!a) return { ok: false, error: "Automação não encontrada.", stopped };
  automationTenantCache.set(id, clientId);
  lastStartAt.delete(id);
  let pauseError: string | undefined;

  // 1) Para somente o proprietário exato, mesmo que a fase tenha avançado.
  try {
    const sc = getScraperStatus(clientId, id);
    if (sc.isScraping && sc.automationId === id) {
      stopped.scraper = stopScraper(clientId, id);
      await log(id, "scrape", "warning", "⏸ Scraper parado pelo usuário.");
    }
  } catch (e) {
    pauseError = `Falha parando scraper: ${(e as Error).message}`;
    console.warn("[AUTOMATION] erro parando scraper:", (e as Error).message);
  }

  // 2) Campanha de disparo — pausa a campaign-worker.
  if (a.campaign_id) {
    try {
      const { data: campaign, error } = await supabase.from("campaigns").select("status")
        .eq("id", a.campaign_id).eq("client_id", clientId).maybeSingle();
      if (error) throw new Error(error.message);
      if (campaign && !["done", "cancelled"].includes(campaign.status)) {
        await pauseCampaign(a.campaign_id);
        stopped.campaign = true;
        await log(id, "dispatch", "warning", "⏸ Disparo pausado pelo usuário.");
      }
    } catch (e) {
      pauseError = `Falha pausando campanha: ${(e as Error).message}`;
      console.warn("[AUTOMATION] erro pausando campanha:", (e as Error).message);
    }
  }

  // 3) Follow-up — vira a campanha pra paused. O ticker `tickAllAutoCampaigns`
  //    em followup-worker filtra por status="active", então paused = parado.
  if (a.followup_campaign_id) {
    try {
      const { error } = await supabase
        .from("followup_campaigns")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", a.followup_campaign_id)
        .eq("client_id", clientId);
      if (error) throw new Error(error.message);
      stopped.followup = true;
      await log(id, "followup", "warning", "⏸ Follow-up pausado pelo usuário.");
    } catch (e) {
      pauseError = `Falha pausando follow-up: ${(e as Error).message}`;
      console.warn("[AUTOMATION] erro pausando follow-up:", (e as Error).message);
    }
  }
  await log(id, "state", "warning",
    `⏸ Automação pausada. Etapas paradas: ${[
      stopped.scraper && "scraper",
      stopped.campaign && "disparo",
      stopped.followup && "follow-up",
    ].filter(Boolean).join(", ") || "nenhuma (nada estava rodando)"}.`,
  );

  return { ok: !pauseError, ...(pauseError ? { error: pauseError } : {}), stopped };
}
