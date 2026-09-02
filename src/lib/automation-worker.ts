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

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { startCampaign, pauseCampaign } from "@/lib/campaign-worker";
import { enrollLeads } from "@/lib/followup-worker";
import { startScraperRun, stopScraper, getStatus as getScraperStatus } from "@/lib/scraper-engine";
import { requireAutomationClientId as requireClientId, resolveCapturedLeadScope } from "@/lib/automation-lead-scope";
import { summarizeReviewsForLead } from "@/lib/reviews-ai";
import { evolution } from "@/lib/evolution";
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
  let query = supabase
    .from("automations")
    .update({
      status: "error",
      phase: "error",
      last_error: String(msg).slice(0, 500),
      last_error_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  query = clientId ? query.eq("client_id", clientId) : query.is("client_id", null);
  await query;
}

/**
 * FASE 1 — Scrape. Chama o endpoint /api/scraper em modo "save" + filtros.
 * O scraper é fire-and-forget (volta OK rapidamente). Acompanhamos pelo
 * crescimento de scraped_count: quando para de subir por 60s, consideramos
 * concluído e avançamos pra phase=dispatching.
 */
async function startScrapingPhase(a: AutomationRow): Promise<void> {
  const niches  = Array.isArray(a.niches)  ? a.niches  : [];
  const regions = Array.isArray(a.regions) ? a.regions : [];
  if (niches.length === 0 || regions.length === 0) {
    return markError(a.id, "Niches e regiões são obrigatórios pra fase de scraping.");
  }

  const filters = a.scrape_filters || {};
  const clientId = requireAutomationClientId(a);

  // Conta leads ANTES (filtrando por tenant) pra detectar incremento depois.
  // SEM filtro por client_id era cross-tenant: outro cliente scrapeando inflava
  // o "scrapedNow" e podia disparar campanha pra leads alheios.
  const { count: before } = await supabase
    .from("leads_extraidos")
    .select("*", { count: "exact", head: true })
    .eq("client_id", clientId);

  // Marca d'água: maior `id` existente AGORA na tabela (global, não por
  // tenant — id é sequência única). Todo lead que o scraper inserir terá
  // id MAIOR que isto. É o que startDispatchPhase usa pra selecionar SÓ os
  // leads desta captação. Antes usava-se _baselineCount (uma contagem) como
  // se fosse id — bug que fazia o disparo pegar o CRM inteiro.
  const { data: maxRow } = await supabase
    .from("leads_extraidos")
    .select("id")
    .eq("client_id", clientId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const baselineMaxId = Number(maxRow?.id) || 0;

  await supabase.from("automations").update({
    phase: "scraping",
    scraped_count: 0,
    last_error: null,
    last_error_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", a.id).eq("client_id", clientId);

  await log(a.id, "state", "info",
    `🚀 Automação iniciada. Captando leads em ${niches.length} nicho(s) × ${regions.length} região(ões). Limite: ${a.scrape_max_leads}.`,
    { metadata: { niches, regions, max: a.scrape_max_leads } }
  );

  // Chama a engine DIRETO em memória — mesma engine que o /captador usa
  // (lib/scraper-engine). Sem HTTP, sem self-call, sem rede. Se /captador
  // funciona, isso aqui funciona — é literalmente a mesma função.
  try {
    const r = startScraperRun({
      niches,
      regions,
      mode: "batch",
      filterEmpty: filters.filterEmpty !== false,
      filterDuplicates: filters.filterDuplicates !== false,
      filterLandlines: filters.filterLandlines === true,
      filterWithWebsite: filters.filterWithWebsite === true,
      captureAllReviews: filters.captureAllReviews === true,
      webhookEnabled: false,
      maxLeads: Number(a.scrape_max_leads) || 200,  // ← respeita o limite configurado
      automation_id: a.id,
      client_id: clientId,
      forceRestart: true,
    });
    if (!r.ok && r.busy) {
      await supabase.from("automations").update({
        phase: "idle",
        updated_at: new Date().toISOString(),
      }).eq("id", a.id).eq("client_id", clientId);
      await log(a.id, "scrape", "info", "⏳ Scraper ocupado por outra captura. Nova tentativa no próximo ciclo.");
      return;
    }
    if (!r.ok) {
      return markError(a.id, `Scraper rejeitou: ${r.error}`);
    }
    if (r.alreadyRunning) {
      await log(a.id, "scrape", "warning",
        "⏳ Scraper já estava rodando (aba /captador aberta?). Os leads que ele captar a partir de agora vão aparecer aqui.",
      );
    } else {
      await log(a.id, "scrape", "info",
        `🤖 Scraper disparado: ${niches.length} × ${regions.length} = ${niches.length * regions.length} busca(s) no Google Maps.`,
        { metadata: { niches, regions } }
      );
    }
  } catch (err: any) {
    return markError(a.id, `Falha ao chamar engine do scraper: ${err?.message || String(err)}`);
  }

  // Marca o snapshot inicial pro tick comparar depois.
  const nowIso = new Date().toISOString();
  await supabase.from("automations").update({
    scrape_filters: {
      ...filters,
      _baselineCount: before || 0,
      _baselineMaxId: baselineMaxId,
      _scrapeStartedAt: nowIso,
      _lastProgressAt: nowIso,
    },
    updated_at: nowIso,
  }).eq("id", a.id).eq("client_id", clientId);
}

/**
 * Verifica se o scrape terminou. Heurística:
 *   - Atingiu scrape_max_leads → done
 *   - Sem leads novos há ≥120s desde a última vez que detectamos progresso → done
 *   - Passaram >15min totais de scrape → done (timeout duro)
 */
type ScrapeCheck = {
  done: boolean;
  scrapedNow: number;
  progressed: boolean;
  /** segundos desde a última vez que um lead novo foi detectado */
  idleSeconds: number;
  /** segundos totais desde que o scrape começou */
  elapsedSeconds: number;
  /** motivo da conclusão (só quando done=true) — vai pro log */
  doneReason: string | null;
};

async function checkScrapingDone(a: AutomationRow): Promise<ScrapeCheck> {
  const clientId = requireAutomationClientId(a);
  const baseline = (a.scrape_filters?._baselineCount as number) || 0;
  const scrapeStartedAtMs = a.scrape_filters?._scrapeStartedAt
    ? new Date(a.scrape_filters._scrapeStartedAt).getTime()
    : Date.now();
  const lastProgressAtMs = a.scrape_filters?._lastProgressAt
    ? new Date(a.scrape_filters._lastProgressAt).getTime()
    : scrapeStartedAtMs;

  // Mesmo filtro de tenant do startScrapingPhase — count cross-tenant inflava o resultado
  const { count: now } = await supabase
    .from("leads_extraidos")
    .select("*", { count: "exact", head: true })
    .eq("client_id", clientId);
  const scrapedNow = Math.max(0, (now || 0) - baseline);

  const idleSeconds = Math.round((Date.now() - lastProgressAtMs) / 1000);
  const elapsedSeconds = Math.round((Date.now() - scrapeStartedAtMs) / 1000);
  const lastCount = a.scraped_count || 0;
  const progressed = scrapedNow > lastCount;
  const base = { scrapedNow, progressed, idleSeconds, elapsedSeconds };

  // O scraper-engine sinaliza `_scrapeFinishedAt` quando termina a captação
  // de verdade. Confiar nisso é melhor que adivinhar pela heurística de
  // 120s ocioso — conclui na hora e não depende do ticker.
  if (a.scrape_filters?._scrapeFinishedAt) {
    return { ...base, done: true, doneReason: "scraper finalizou a captação" };
  }

  // Atingiu o limite máximo: termina já.
  const hardCap = Number(a.scrape_max_leads || 200);
  if (scrapedNow >= hardCap) {
    return { ...base, done: true, doneReason: `limite de ${hardCap} leads atingido` };
  }

  // Timeout duro: 15min sem nada — escapa de scraper travado.
  if (Date.now() - scrapeStartedAtMs > 15 * 60_000 && scrapedNow === 0) {
    return { ...base, done: true, doneReason: "timeout de 15min sem captar nenhum lead" };
  }

  // X sem progresso = scraper terminou (ou travou). Note: usamos
  // _lastProgressAt salvo separado de updated_at, porque updated_at é bumpado
  // a cada tick e mascarava esse timer. Com captureAllReviews, carregar TODAS
  // as reviews de 1 negócio leva minutos sem salvar lead novo — o timer de
  // 120s cortava a captação no meio (leads perdidos). Sobe pra 6min.
  const idleLimitMs = a.scrape_filters?.captureAllReviews ? 360_000 : 120_000;
  if (!progressed && Date.now() - lastProgressAtMs > idleLimitMs && scrapedNow > 0) {
    return { ...base, done: true, doneReason: `${idleSeconds}s sem leads novos — scraper concluído` };
  }
  // Se ainda nem captou 1 lead após 5min, também encerra (scraper provavelmente
  // não conseguiu nem abrir o Maps).
  if (scrapedNow === 0 && Date.now() - scrapeStartedAtMs > 5 * 60_000) {
    return { ...base, done: true, doneReason: "5min sem captar nenhum lead — scraper não respondeu" };
  }

  return { ...base, done: false, doneReason: null };
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
  // GUARDA DE IDEMPOTÊNCIA: se já existe campanha pra esta automação,
  // NÃO cria outra. Antes, race condition entre 2 ticks ou re-clicks fazia
  // 2 campanhas pros mesmos leads → mesmo número recebia 2x → ban no zap.
  if (a.campaign_id) {
    console.log(`[AUTOMATION ${a.id}] startDispatchPhase já criou campanha ${a.campaign_id} — pulando.`);
    return;
  }

  // Trava atômica via UPDATE condicional. Só prossegue se ESTE chamador
  // conseguiu mudar phase=scraping → phase=dispatching primeiro. Se outro
  // tick chegou antes, ele já mudou pra "dispatching" e este UPDATE retorna 0 rows.
  const { data: claimed, error: claimErr } = await supabase
    .from("automations")
    .update({ phase: "dispatching", updated_at: new Date().toISOString() })
    .eq("id", a.id)
    .eq("client_id", clientId)
    .eq("phase", "scraping")  // <-- só se ainda estiver scraping
    .select("id")
    .maybeSingle();
  if (claimErr) return markError(a.id, `Falha claim de fase: ${claimErr.message}`);
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

  // IDENTIFICAÇÃO DOS LEADS DESTA CAPTAÇÃO — lógica pura, testada em
  // automation-lead-scope.test.ts. Resolve a marca d'água `_baselineMaxId`;
  // se os marcadores se perderam, aborta com erro claro em vez de disparar
  // pro CRM inteiro.
  const scope = resolveCapturedLeadScope(a.scrape_filters, a.started_at);
  if (!scope.ok) return markError(a.id, scope.reason);

  let leads = await selectCapturedLeads(a, scope);

  if (leads.length === 0) {
    // Nada pra disparar → conclui.
    await log(a.id, "state", "warning", "Nenhum lead colhido. Automação encerrada sem disparar.");
    await supabase.from("automations").update({
      phase: "done",
      status: "done",
      last_error: "Nenhum lead colhido — automação encerrada sem disparar.",
      updated_at: new Date().toISOString(),
    }).eq("id", a.id).eq("client_id", clientId);
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
  await topUpInvalidLeads(a, scope, leads, validated.removed);

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
  await supabase.from("automations").update({
    phase: "dispatching",
    campaign_id: camp.id,
    scraped_count: leads.length,
    updated_at: new Date().toISOString(),
  }).eq("id", a.id).eq("client_id", clientId);

  const r = await startCampaign(camp.id);
  if (!r.ok) return markError(a.id, `Falha startando campanha: ${r.error}`);
  console.log(`[AUTOMATION ${a.id}] Campanha ${camp.id} disparada com ${leads.length} leads.`);
  await log(a.id, "dispatch", "info",
    `📨 Disparo iniciado. ${leads.length} lead(s) na fila. Intervalo ${a.dispatch_min_interval}-${a.dispatch_max_interval}s, janela ${a.allowed_start_hour}h-${a.allowed_end_hour}h.${a.dispatch_personalize ? " IA reescrevendo cada mensagem." : ""}`,
    { metadata: { campaign_id: camp.id, count: leads.length, ai: !!a.dispatch_personalize } }
  );
}

/**
 * Seleciona do CRM SÓ os leads colhidos durante esta automação (escopo por
 * _baselineMaxId/startedAt + tenant). Deduplica por remoteJid.
 */
async function selectCapturedLeads(
  a: AutomationRow,
  scope: { baselineMaxId: number | null; startedAt: string | null },
): Promise<{ id: any; remoteJid: string; nome_negocio: string | null; ramo_negocio: string | null }[]> {
  const clientId = requireAutomationClientId(a);
  let leadsQuery = supabase
    .from("leads_extraidos")
    .select("id, remoteJid, nome_negocio, ramo_negocio")
    .eq("client_id", clientId)
    .not("remoteJid", "is", null);
  if (scope.baselineMaxId !== null) leadsQuery = leadsQuery.gt("id", scope.baselineMaxId);
  if (scope.startedAt) leadsQuery = leadsQuery.gte("created_at", scope.startedAt);
  const { data: rawLeads, error } = await leadsQuery;
  if (error) throw new Error(`Falha lendo leads colhidos: ${error.message}`);
  const seenJids = new Set<string>();
  const leads = (rawLeads || []).filter((l: any) => {
    if (!l.remoteJid || seenJids.has(l.remoteJid)) return false;
    seenJids.add(l.remoteJid);
    return true;
  });
  if (rawLeads && rawLeads.length !== leads.length) {
    await log(a.id, "scrape", "warning",
      `🔁 Deduplicados ${rawLeads.length - leads.length} lead(s) repetidos antes de criar campanha (não vão receber duplicado).`,
    );
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
  leads: { id: any; remoteJid: string; nome_negocio: string | null; ramo_negocio: string | null }[],
): Promise<{ leads: typeof leads; removed: number }> {
  const clientId = requireAutomationClientId(a);
  // ───────── UNIFICAÇÃO PRECOCE DE JID CANÔNICO (WhatsApp) ─────────
  // Scraper extrai telefones e gera JIDs brutos (que no Brasil podem vir com
  // o nono dígito a mais). A Evolution API resolve o JID canônico real do
  // WhatsApp (sem o nono dígito para contas antigas). Unificar precocemente
  // garante que o "Lead Intelligence" já grave a análise sob o JID canônico real,
  // impedindo gastos duplicados redundantes na IA, e que os targets da campanha
  // já nasçam perfeitos para que o /chat vincule nome e briefing no primeiro instante.
  const phoneNumbers = leads.map(l => l.remoteJid.replace(/@.*$/, "").replace(/\D/g, "")).filter(Boolean);
  if (phoneNumbers.length > 0) {
    await log(a.id, "scrape", "info", `🔍 Validando e unificando JIDs canônicos de ${leads.length} lead(s) via Evolution API...`);
    try {
      const checkResult = await channel.checkWhatsAppNumbersDetailed(phoneNumbers, a.instance_name);
      
      // Iremos processar cada lead e atualizar sua referência
      for (const lead of leads) {
        const phone = lead.remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
        const entry = checkResult[phone] || Object.values(checkResult).find((v: any) => v.jid && v.jid.includes(phone)) || null;
        
        if (entry && entry.jid) {
          const sendJid = entry.jid;
          if (sendJid !== lead.remoteJid) {
            console.log(`[AUTOMATION ${a.id}] JID divergente na automação. Original: ${lead.remoteJid} · Canônico: ${sendJid}. Unificando precocemente...`);
            
            // 1. Tentar atualizar a tabela leads_extraidos de forma resiliente para o JID canônico
            try {
              const { error: updErr } = await supabase
                .from("leads_extraidos")
                .update({ remoteJid: sendJid })
                .eq("id", lead.id)
                .eq("client_id", clientId);

              if (updErr) {
                // Se der erro 23505 (unique remoteJid colision), faz o merge do CRM e deleta a duplicada
                if (updErr.code === "23505" || updErr.message?.includes("unique")) {
                  console.log(`[AUTOMATION ${a.id}] JID canônico ${sendJid} já existe em leads_extraidos. Iniciando merge precoce de inteligência e dados.`);
                  const { data: oldLead } = await supabase
                    .from("leads_extraidos")
                    .select("*")
                    .eq("id", lead.id)
                    .eq("client_id", clientId)
                    .maybeSingle();

                  if (oldLead) {
                    const mergePayload: Record<string, any> = {};
                    const fieldsToMerge = [
                      "nome_negocio", "ramo_negocio", "categoria", "endereco", "website",
                      "instagram", "facebook", "avaliacao", "reviews", "status",
                      "intelligence", "intelligence_at", "icp_score", "lead_type",
                      "justificativa_ia", "resumo_ia", "ia_last_analyzed_at"
                    ];

                    for (const field of fieldsToMerge) {
                      if (oldLead[field] !== undefined && oldLead[field] !== null) {
                        mergePayload[field] = oldLead[field];
                      }
                    }

                    // Atualiza o registro canônico que já existia com os dados do lead capturado
                    await supabase
                      .from("leads_extraidos")
                      .update(mergePayload)
                      .eq("remoteJid", sendJid)
                      .eq("client_id", clientId);

                    // Deleta o lead capturado antigo duplicado
                    await supabase
                      .from("leads_extraidos")
                      .delete()
                      .eq("id", oldLead.id)
                      .eq("client_id", clientId);

                    // Busca o ID do lead canônico correspondente para atualizar a lista em memória
                    const { data: canonicalLead } = await supabase
                      .from("leads_extraidos")
                      .select("id")
                      .eq("remoteJid", sendJid)
                      .eq("client_id", clientId)
                      .maybeSingle();

                    if (canonicalLead) {
                      lead.id = canonicalLead.id;
                    }
                    console.log(`[AUTOMATION ${a.id}] Merge precoce concluído para JID ${sendJid}.`);
                  }
                } else {
                  throw updErr;
                }
              }
            } catch (err) {
              console.error(`[AUTOMATION ${a.id}] Erro na unificação precoce de leads_extraidos:`, err);
            }

            lead.remoteJid = sendJid;
          }
        }
      }

      // Filtra leads que existem no WhatsApp (se entry.exists === false, nós removemos da lista)
      const initialCount = leads.length;
      const validLeads = [];
      for (const lead of leads) {
        const phone = lead.remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
        const entry = checkResult[phone] || Object.values(checkResult).find((v: any) => v.jid && v.jid.includes(phone)) || null;
        
        if (entry && entry.exists === false) {
          // Atualiza status do lead no banco para que o CRM saiba que o número é inválido
          await supabase
            .from("leads_extraidos")
            .update({ status: "invalid_number" })
            .eq("id", lead.id)
            .eq("client_id", clientId);
          continue;
        }
        validLeads.push(lead);
      }

      if (validLeads.length !== initialCount) {
        await log(a.id, "scrape", "warning", `⊘ Removidos ${initialCount - validLeads.length} lead(s) com números inválidos/sem WhatsApp antes do Lead Intelligence e envio.`);
      }
      return { leads: validLeads, removed: initialCount - validLeads.length };

    } catch (err: any) {
      await log(a.id, "scrape", "warning", `⚠️ Falha durante a validação precoce de JIDs: ${err?.message || err}. Prosseguindo com leads originais.`);
      return { leads, removed: 0 };
    }
  }
  return { leads, removed: 0 };
}

/**
 * REPOSIÇÃO (top-up): a validação de WhatsApp remove números inválidos DEPOIS
 * da captação — sem isto a automação disparava pro objetivo menos os inválidos
 * (40 captados − 6 inválidos = 34 enviados com objetivo 45). Aqui a gente
 * re-captura a diferença antes de criar a campanha. Máx. 2 rodadas pra não
 * loopar infinito em região com muitos números mortos.
 */
async function topUpInvalidLeads(
  a: AutomationRow,
  scope: { baselineMaxId: number | null; startedAt: string | null },
  leads: { id: any; remoteJid: string; nome_negocio: string | null; ramo_negocio: string | null }[],
  removedCount: number,
): Promise<void> {
  const objetivo = Number(a.scrape_max_leads) || 0;
  if (objetivo <= 0 || leads.length >= objetivo || removedCount <= 0) return;

  const filters = a.scrape_filters || {};
  const clientId = requireAutomationClientId(a);
  const roundsDone = Number(filters._topupRounds) || 0;
  if (roundsDone >= 2) {
    await log(a.id, "scrape", "warning",
      `♻️ Ainda faltam ${objetivo - leads.length} lead(s) pro objetivo, mas o limite de 2 reposições foi atingido. Seguindo com ${leads.length}.`);
    return;
  }

  const deficit = objetivo - leads.length;
  await log(a.id, "scrape", "info",
    `♻️ Reposição: ${removedCount} inválido(s) removido(s) → ${leads.length}/${objetivo} leads. Capturando até ${deficit} lead(s) adicional(is)...`);

  const r = startScraperRun({
    niches: Array.isArray(a.niches) ? a.niches : [],
    regions: Array.isArray(a.regions) ? a.regions : [],
    mode: "batch",
    filterEmpty: filters.filterEmpty !== false,
    filterDuplicates: filters.filterDuplicates !== false,
    filterLandlines: filters.filterLandlines === true,
    filterWithWebsite: filters.filterWithWebsite === true,
    captureAllReviews: filters.captureAllReviews === true,
    webhookEnabled: false,
    maxLeads: deficit,
    automation_id: a.id,
    client_id: clientId,
    forceRestart: false,
    topup: true,
  });
  if (!r.ok) {
    await log(a.id, "scrape", "warning", `♻️ Reposição não iniciou (${r.error || "scraper ocupado"}). Seguindo com ${leads.length} lead(s).`);
    return;
  }

  // Espera o run de reposição terminar (poll 5s, teto 20min — captação de
  // poucos leads leva poucos minutos; se estourar, segue com o que tem).
  const deadline = Date.now() + 20 * 60 * 1000;
  while (getScraperStatus(clientId, a.id).isScraping && Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 5000));
  }
  if (getScraperStatus(clientId, a.id).isScraping) {
    await log(a.id, "scrape", "warning",
      `♻️ Reposição demorou mais que 20min — seguindo com ${leads.length} lead(s) válidos. Os extras ficam no CRM pra próxima.`);
    return;
  }

  // Re-seleciona o escopo inteiro e valida SÓ os leads novos.
  const fresh = await selectCapturedLeads(a, scope);
  const known = new Set(leads.map(l => String(l.id)));
  const novos = fresh.filter(l => !known.has(String(l.id)));
  if (novos.length === 0) {
    await log(a.id, "scrape", "info", `♻️ Reposição não achou leads novos (região esgotada). Seguindo com ${leads.length}.`);
  } else {
    await log(a.id, "scrape", "info", `♻️ Validando ${novos.length} lead(s) novo(s) da reposição...`);
    const validNovos = await canonicalizeAndFilterLeads(a, novos);
    leads.push(...validNovos.leads);
    await log(a.id, "scrape", "success",
      `♻️ Reposição: +${validNovos.leads.length} lead(s) válido(s) → ${leads.length}/${objetivo}.`);
  }

  // Persiste a rodada pra um restart da automação não re-repor sem parar.
  try {
    const { data: row } = await supabase.from("automations").select("scrape_filters").eq("id", a.id).eq("client_id", clientId).maybeSingle();
    await supabase.from("automations").update({
      scrape_filters: { ...((row?.scrape_filters as any) || {}), _topupRounds: roundsDone + 1 },
      updated_at: new Date().toISOString(),
    }).eq("id", a.id).eq("client_id", clientId);
  } catch { /* best-effort */ }
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
  const [sent, failed, pending] = await Promise.all([
    countBy("sent"),
    countBy("failed"),
    countBy("pending"),
  ]);

  return {
    done: status === "done",
    status,
    sent,
    failed,
    pending,
    total: sent + failed + pending,
  };
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
  const { data: claimed } = await supabase
    .from("automations")
    .update({ phase: "following", updated_at: new Date().toISOString() })
    .eq("id", a.id)
    .eq("client_id", clientId)
    .eq("phase", "dispatching")
    .select("id")
    .maybeSingle();
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
    await supabase.from("automations").update({
      phase: "done",
      status: "done",
      updated_at: new Date().toISOString(),
    }).eq("id", a.id).eq("client_id", clientId);
    return;
  }

  // Pega leads que JÁ foram disparados com sucesso.
  const { data: targets } = await supabase
    .from("campaign_targets")
    .select("remote_jid")
    .eq("campaign_id", a.campaign_id)
    .eq("client_id", clientId)
    .eq("status", "sent");
  if (!targets || targets.length === 0) {
    await supabase.from("automations").update({
      phase: "done",
      status: "done",
      last_error: "Nenhum lead foi disparado com sucesso — pulando follow-up.",
      updated_at: new Date().toISOString(),
    }).eq("id", a.id).eq("client_id", clientId);
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
      status: "active",
    })
    .select("id")
    .single();
  if (fcErr || !fcamp?.id) return markError(a.id, `Falha criando follow-up: ${fcErr?.message}`);

  // 2) busca leadIds (precisa de id pra enrollLeads)
  const remoteJids = targets.map((t: any) => t.remote_jid).filter(Boolean);
  const { data: leadRows } = await supabase
    .from("leads_extraidos")
    .select("id")
    .eq("client_id", clientId)
    .in("remoteJid", remoteJids);
  const leadIds = (leadRows || []).map((l: any) => l.id);
  const r = await enrollLeads({ campaignId: fcamp.id, leadIds, clientId });
  if (!r.ok) return markError(a.id, `Falha enrolando follow-up: ${r.error}`);

  await supabase.from("automations").update({
    phase: "following",
    followup_campaign_id: fcamp.id,
    updated_at: new Date().toISOString(),
  }).eq("id", a.id).eq("client_id", clientId);
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
  const { count: ativos } = await supabase
    .from("followup_targets")
    .select("*", { count: "exact", head: true })
    .eq("followup_campaign_id", a.followup_campaign_id)
    .eq("client_id", clientId)
    .in("status", ["pending", "waiting"]);
  return { done: (ativos || 0) === 0, active: ativos || 0 };
}

/**
 * Tick por automação: avança 1 fase se aplicável. Idempotente.
 */
async function tickOne(a: AutomationRow) {
  if (a.status !== "running") return;

  try {
    const clientId = requireAutomationClientId(a);
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
      const r = await checkScrapingDone(a);
      // Atualiza contador. Se houve progresso, marca _lastProgressAt no
      // scrape_filters pra a próxima checagem comparar com o tempo certo.
      const nextFilters = { ...(a.scrape_filters || {}) };
      if (r.progressed) {
        nextFilters._lastProgressAt = new Date().toISOString();
        await log(a.id, "scrape", "info",
          `📥 ${r.scrapedNow} lead(s) captado(s) até agora · ${r.elapsedSeconds}s de captação.`,
          { metadata: { count: r.scrapedNow, elapsedSeconds: r.elapsedSeconds } });
      } else if (!r.done) {
        // Heartbeat — o scraper continua, mas neste tick não veio lead novo.
        // É O log que faltava: mostra a automação VIVA e o tempo ocioso
        // subindo quando o scraper trava de verdade.
        await log(a.id, "scrape", "info",
          `⏳ Captação em andamento — ${r.scrapedNow} lead(s) até agora · ${r.idleSeconds}s sem novidade · ${r.elapsedSeconds}s no total.`,
          { metadata: { scrapedNow: r.scrapedNow, idleSeconds: r.idleSeconds, elapsedSeconds: r.elapsedSeconds } });
      }
      await supabase.from("automations").update({
        scraped_count: r.scrapedNow,
        scrape_filters: nextFilters,
        updated_at: new Date().toISOString(),
      }).eq("id", a.id).eq("client_id", clientId);
      if (r.done) {
        // O log de transição vive DENTRO do startDispatchPhase, só pra quem
        // ganha a trava atômica — senão 2 ticks concorrentes duplicam a linha.
        await startDispatchPhase(
          { ...a, scraped_count: r.scrapedNow, scrape_filters: nextFilters },
          { reason: r.doneReason, scrapedNow: r.scrapedNow },
        );
      }
      return;
    }

    if (a.phase === "dispatching") {
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
        await supabase.from("automations").update({
          phase: "done",
          status: "done",
          updated_at: new Date().toISOString(),
        }).eq("id", a.id).eq("client_id", clientId);
        await log(a.id, "state", "success", "🏁 Automação concluída. Todos os leads foram processados.");
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
  } catch (e: any) {
    await markError(a.id, e?.message || String(e));
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

/** Liga uma automação. SEMPRE reseta pra idle e re-tick — clicar Iniciar
 *  significa "rode agora", mesmo se o status já estava como running de uma
 *  tentativa anterior travada (que era o motivo de "nada acontecer"). */
export async function startAutomation(id: string, clientIdInput: string): Promise<{ ok: boolean; error?: string; phase?: string }> {
  const clientId = requireClientId(clientIdInput);
  // GUARDA anti-duplo-clique: se um Iniciar desta automação aconteceu há
  // menos de 8s, ignora. O primeiro click já está processando (reset +
  // tick + scraper); um segundo click nesse intervalo só criaria corrida
  // e scraper duplicado. Restart deliberado continua funcionando (>8s).
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

  // CANCELA campanha + follow-up anteriores ANTES de resetar. Se uma
  // campanha velha estiver rodando (timer ativo), ela continuaria mandando
  // mensagens enquanto a nova arranca → leads recebem duplicado. Solução:
  // pause da velha primeiro.
  if (a.campaign_id) {
    try {
      await pauseCampaign(a.campaign_id);
      // Marca status="cancelled" pra ela não retomar em recoverRunningCampaigns.
       await supabase.from("campaigns")
         .update({ status: "cancelled", finished_at: new Date().toISOString() })
         .eq("id", a.campaign_id)
         .eq("client_id", clientId);
    } catch (e) {
      console.warn(`[AUTOMATION] cancelamento de campanha antiga falhou: ${(e as Error).message}`);
    }
  }
  if (a.followup_campaign_id) {
    try {
       await supabase.from("followup_campaigns")
         .update({ status: "cancelled", updated_at: new Date().toISOString() })
         .eq("id", a.followup_campaign_id)
         .eq("client_id", clientId);
    } catch {}
  }

  // Reset COMPLETO em todos os casos. Sem early-return: clicar Iniciar = recomeçar.
  // Limpa também os _baselineCount/_scrapeStartedAt/_lastProgressAt antigos pra
  // a heurística de progresso começar do zero.
  const cleanFilters = { ...(a.scrape_filters || {}) };
  delete cleanFilters._baselineCount;
  delete cleanFilters._baselineMaxId;
  delete cleanFilters._scrapeStartedAt;
  delete cleanFilters._lastProgressAt;
  delete cleanFilters._scrapeFinishedAt;

  const { error: updErr } = await supabase.from("automations").update({
    status: "running",
    phase: "idle",
    started_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
    campaign_id: null,
    followup_campaign_id: null,
    scraped_count: 0,
    scrape_filters: cleanFilters,
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("client_id", clientId);
  if (updErr) return fail("Erro interno ao iniciar automação: " + updErr.message);

  // Tick síncrono imediato — garante que phase muda pra "scraping" e o
  // scraper é disparado antes da resposta voltar pro frontend.
  try {
    await tickAllAutomations();
  } catch (e) {
    console.warn("[AUTOMATION] tick imediato falhou:", (e as Error).message);
  }

  // Lê o estado atualizado pra retornar pra UI.
  const { data: after } = await supabase.from("automations").select("phase, last_error").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (after?.last_error) return { ok: false, error: after.last_error };
  return { ok: true, phase: after?.phase };
}

/**
 * Pausa GLOBAL: para todas as etapas que estiverem ativas pra esta automação.
 *  - Scraper (engine in-memory): chama stopScraper() se a automação estiver
 *    atrelada ao scraper atualmente rodando.
 *  - Campanha de disparo: status → paused (campaign-worker respeita).
 *  - Follow-up: status → paused (ticker pula campanhas paused).
 *  - Linha da automação: phase=paused, status=paused.
 *
 * Quando o usuário clicar Iniciar de novo, startAutomation faz reset duro
 * (phase=idle, campaign_id=null, etc.) e recomeça do zero.
 */
export async function pauseAutomation(id: string, clientIdInput: string): Promise<{ ok: boolean; stopped: { scraper: boolean; campaign: boolean; followup: boolean } }> {
  const clientId = requireClientId(clientIdInput);
  const { data: a } = await supabase.from("automations").select("*").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!a) return { ok: false as any, stopped: { scraper: false, campaign: false, followup: false } };
  automationTenantCache.set(id, clientId);

  const stopped = { scraper: false, campaign: false, followup: false };

  // 1) Scraper — só para se a automação ATUAL estiver atrelada (scraper tem
  //    estado in-memory, e pode estar servindo /captador também). Heurística:
  //    se a fase é "scraping" + scraper rodando, esta é nossa.
  try {
    const sc = getScraperStatus(clientId, id);
    if (sc.isScraping && sc.automationId === id && a.phase === "scraping") {
      stopScraper(clientId, id);
      stopped.scraper = true;
      await log(id, "scrape", "warning", "⏸ Scraper parado pelo usuário.");
    }
  } catch (e) {
    console.warn("[AUTOMATION] erro parando scraper:", (e as Error).message);
  }

  // 2) Campanha de disparo — pausa a campaign-worker.
  if (a.campaign_id) {
    try {
      await pauseCampaign(a.campaign_id);
      stopped.campaign = true;
      await log(id, "dispatch", "warning", "⏸ Disparo pausado pelo usuário.");
    } catch (e) {
      console.warn("[AUTOMATION] erro pausando campanha:", (e as Error).message);
    }
  }

  // 3) Follow-up — vira a campanha pra paused. O ticker `tickAllAutoCampaigns`
  //    em followup-worker filtra por status="active", então paused = parado.
  if (a.followup_campaign_id) {
    try {
      await supabase
        .from("followup_campaigns")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", a.followup_campaign_id)
        .eq("client_id", clientId);
      stopped.followup = true;
      await log(id, "followup", "warning", "⏸ Follow-up pausado pelo usuário.");
    } catch (e) {
      console.warn("[AUTOMATION] erro pausando follow-up:", (e as Error).message);
    }
  }

  // 4) Marca a automação em si.
  await supabase
    .from("automations")
    .update({ status: "paused", phase: "paused", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("client_id", clientId);
  await log(id, "state", "warning",
    `⏸ Automação pausada. Etapas paradas: ${[
      stopped.scraper && "scraper",
      stopped.campaign && "disparo",
      stopped.followup && "follow-up",
    ].filter(Boolean).join(", ") || "nenhuma (nada estava rodando)"}.`,
  );

  return { ok: true, stopped };
}
