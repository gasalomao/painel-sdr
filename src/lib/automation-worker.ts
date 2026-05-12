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

type AutomationRow = any;

/**
 * Insere um log estruturado pra automação. Visível em tempo real na UI
 * via realtime em automation_logs. NUNCA throw — falha em log nunca pode
 * derrubar o pipeline.
 */
async function log(
  automationId: string,
  kind: "scrape" | "dispatch" | "followup" | "reply" | "state" | "error",
  level: "info" | "success" | "warning" | "error",
  message: string,
  extra?: { remote_jid?: string; metadata?: Record<string, any> }
) {
  try {
    await supabase.from("automation_logs").insert({
      automation_id: automationId,
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
  await log(id, "error", "error", msg);
  await supabase
    .from("automations")
    .update({
      status: "error",
      phase: "error",
      last_error: String(msg).slice(0, 500),
      last_error_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
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

  // Conta leads ANTES pra detectar incremento depois.
  const { count: before } = await supabase
    .from("leads_extraidos")
    .select("*", { count: "exact", head: true });

  await supabase.from("automations").update({
    phase: "scraping",
    scraped_count: 0,
    last_error: null,
    last_error_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", a.id);

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
      filterLandlines: filters.filterLandlines !== false,
      webhookEnabled: false,
      maxLeads: Number(a.scrape_max_leads) || 200,  // ← respeita o limite configurado
      automation_id: a.id,
    });
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
      _scrapeStartedAt: nowIso,
      _lastProgressAt: nowIso,
    },
    updated_at: nowIso,
  }).eq("id", a.id);
}

/**
 * Verifica se o scrape terminou. Heurística:
 *   - Atingiu scrape_max_leads → done
 *   - Sem leads novos há ≥120s desde a última vez que detectamos progresso → done
 *   - Passaram >15min totais de scrape → done (timeout duro)
 */
async function checkScrapingDone(a: AutomationRow): Promise<{ done: boolean; scrapedNow: number; progressed: boolean }> {
  const baseline = (a.scrape_filters?._baselineCount as number) || 0;
  const scrapeStartedAtMs = a.scrape_filters?._scrapeStartedAt
    ? new Date(a.scrape_filters._scrapeStartedAt).getTime()
    : Date.now();
  const lastProgressAtMs = a.scrape_filters?._lastProgressAt
    ? new Date(a.scrape_filters._lastProgressAt).getTime()
    : scrapeStartedAtMs;

  const { count: now } = await supabase
    .from("leads_extraidos")
    .select("*", { count: "exact", head: true });
  const scrapedNow = Math.max(0, (now || 0) - baseline);

  // Atingiu o limite máximo: termina já.
  const hardCap = Number(a.scrape_max_leads || 200);
  if (scrapedNow >= hardCap) return { done: true, scrapedNow, progressed: false };

  const lastCount = a.scraped_count || 0;
  const progressed = scrapedNow > lastCount;

  // Timeout duro: 15min sem nada — escapa de scraper travado.
  if (Date.now() - scrapeStartedAtMs > 15 * 60_000 && scrapedNow === 0) {
    return { done: true, scrapedNow, progressed };
  }

  // 120s sem progresso = scraper terminou (ou travou). Note: usamos
  // _lastProgressAt salvo separado de updated_at, porque updated_at é bumpado
  // a cada tick e mascarava esse timer.
  if (!progressed && Date.now() - lastProgressAtMs > 120_000 && scrapedNow > 0) {
    return { done: true, scrapedNow, progressed };
  }
  // Se ainda nem captou 1 lead após 5min, também encerra (scraper provavelmente
  // não conseguiu nem abrir o Maps).
  if (scrapedNow === 0 && Date.now() - scrapeStartedAtMs > 5 * 60_000) {
    return { done: true, scrapedNow, progressed };
  }

  return { done: false, scrapedNow, progressed };
}

/**
 * FASE 2 — Cria a campanha de disparo a partir dos leads novos colhidos
 * desde que a automação começou e dispara via campaign-worker.
 */
async function startDispatchPhase(a: AutomationRow): Promise<void> {
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
    .eq("phase", "scraping")  // <-- só se ainda estiver scraping
    .select("id")
    .maybeSingle();
  if (claimErr) return markError(a.id, `Falha claim de fase: ${claimErr.message}`);
  if (!claimed) {
    console.log(`[AUTOMATION ${a.id}] outro tick já avançou pra dispatching — pulando.`);
    return;
  }

  const baseline   = (a.scrape_filters?._baselineCount as number) || 0;
  // startedAt pode vir nulo/undefined em automações antigas ou quando o scrape
  // ainda não setou o marker — nesse caso filtramos só por baseline (sem date).
  const startedAtRaw = a.scrape_filters?._scrapeStartedAt || a.started_at;
  const startedAt = (typeof startedAtRaw === "string" && startedAtRaw.trim() && startedAtRaw !== "undefined")
    ? startedAtRaw
    : null;
  if (!a.dispatch_template?.trim()) return markError(a.id, "Template de disparo vazio.");

  // Pega leads colhidos durante esta automação (id > baseline E, se houver, created_at >= startedAt).
  // DEDUPE por remoteJid: se o scraper salvou o mesmo lead 2x (raro, mas
  // pode acontecer com upsert), aqui só vai 1 disparo pra esse número.
  let leadsQuery = supabase
    .from("leads_extraidos")
    .select("id, remoteJid, nome_negocio, ramo_negocio")
    .gt("id", baseline)
    .not("remoteJid", "is", null);
  if (startedAt) leadsQuery = leadsQuery.gte("created_at", startedAt);
  const { data: rawLeads, error } = await leadsQuery;
  if (error) return markError(a.id, `Falha lendo leads colhidos: ${error.message}`);
  // Deduplicação client-side: mantém só o primeiro de cada remoteJid.
  const seenJids = new Set<string>();
  const leads = (rawLeads || []).filter(l => {
    if (!l.remoteJid || seenJids.has(l.remoteJid)) return false;
    seenJids.add(l.remoteJid);
    return true;
  });
  if (rawLeads && rawLeads.length !== leads.length) {
    await log(a.id, "scrape", "warning",
      `🔁 Deduplicados ${rawLeads.length - leads.length} lead(s) repetidos antes de criar campanha (não vão receber duplicado).`,
    );
  }
  if (leads.length === 0) {
    // Nada pra disparar → conclui.
    await log(a.id, "state", "warning", "Nenhum lead colhido. Automação encerrada sem disparar.");
    await supabase.from("automations").update({
      phase: "done",
      status: "done",
      last_error: "Nenhum lead colhido — automação encerrada sem disparar.",
      updated_at: new Date().toISOString(),
    }).eq("id", a.id);
    return;
  }
  await log(a.id, "scrape", "success",
    `✅ Captação concluída · ${leads.length} lead(s) novo(s)`,
    { metadata: { count: leads.length } }
  );

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
      const intelModel = modelRow?.value || "gemini-2.5-flash";
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
  let campInsert: any = {
    name: `[Auto] ${a.name}`,
    instance_name: a.instance_name,
    agent_id: a.agent_id,
    message_template: a.dispatch_template,
    min_interval_seconds: a.dispatch_min_interval,
    max_interval_seconds: a.dispatch_max_interval,
    allowed_start_hour: a.allowed_start_hour,
    allowed_end_hour: a.allowed_end_hour,
    personalize_with_ai: !!a.dispatch_personalize,
    ai_model: a.dispatch_ai_model,
    ai_prompt: a.dispatch_ai_prompt,
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
  }).eq("id", a.id);

  const r = await startCampaign(camp.id);
  if (!r.ok) return markError(a.id, `Falha startando campanha: ${r.error}`);
  console.log(`[AUTOMATION ${a.id}] Campanha ${camp.id} disparada com ${leads.length} leads.`);
  await log(a.id, "dispatch", "info",
    `📨 Disparo iniciado. ${leads.length} lead(s) na fila. Intervalo ${a.dispatch_min_interval}-${a.dispatch_max_interval}s, janela ${a.allowed_start_hour}h-${a.allowed_end_hour}h.${a.dispatch_personalize ? " IA reescrevendo cada mensagem." : ""}`,
    { metadata: { campaign_id: camp.id, count: leads.length, ai: !!a.dispatch_personalize } }
  );
}

/**
 * Verifica se a campanha de disparo terminou.
 */
async function checkDispatchDone(a: AutomationRow): Promise<boolean> {
  if (!a.campaign_id) return false;
  const { data: c } = await supabase
    .from("campaigns")
    .select("status")
    .eq("id", a.campaign_id)
    .maybeSingle();
  return c?.status === "done";
}

/**
 * FASE 3 — Cria a follow-up campaign e enrola os leads que foram disparados.
 */
async function startFollowupPhase(a: AutomationRow): Promise<void> {
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
    }).eq("id", a.id);
    return;
  }

  // Pega leads que JÁ foram disparados com sucesso.
  const { data: targets } = await supabase
    .from("campaign_targets")
    .select("remote_jid")
    .eq("campaign_id", a.campaign_id)
    .eq("status", "sent");
  if (!targets || targets.length === 0) {
    await supabase.from("automations").update({
      phase: "done",
      status: "done",
      last_error: "Nenhum lead foi disparado com sucesso — pulando follow-up.",
      updated_at: new Date().toISOString(),
    }).eq("id", a.id);
    return;
  }

  // 1) cria followup_campaigns
  const { data: fcamp, error: fcErr } = await supabase
    .from("followup_campaigns")
    .insert({
      name: `[Auto] ${a.name}`,
      instance_name: a.instance_name,
      ai_enabled: !!a.followup_ai_enabled,
      ai_model: a.followup_ai_model,
      ai_prompt: a.followup_ai_prompt,
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
    .in("remoteJid", remoteJids);
  const leadIds = (leadRows || []).map((l: any) => l.id);
  const r = await enrollLeads({ campaignId: fcamp.id, leadIds });
  if (!r.ok) return markError(a.id, `Falha enrolando follow-up: ${r.error}`);

  await supabase.from("automations").update({
    phase: "following",
    followup_campaign_id: fcamp.id,
    updated_at: new Date().toISOString(),
  }).eq("id", a.id);
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
 */
async function checkFollowupDone(a: AutomationRow): Promise<boolean> {
  if (!a.followup_campaign_id) return false;
  const { count: ativos } = await supabase
    .from("followup_targets")
    .select("*", { count: "exact", head: true })
    .eq("followup_campaign_id", a.followup_campaign_id)
    .in("status", ["pending", "waiting"]);
  return (ativos || 0) === 0;
}

/**
 * Tick por automação: avança 1 fase se aplicável. Idempotente.
 */
async function tickOne(a: AutomationRow) {
  if (a.status !== "running") return;

  try {
    if (a.phase === "idle") {
      await startScrapingPhase(a);
      return;
    }
    if (a.phase === "scraping") {
      const r = await checkScrapingDone(a);
      // Atualiza contador. Se houve progresso, marca _lastProgressAt no
      // scrape_filters pra a próxima checagem comparar com o tempo certo.
      const nextFilters = { ...(a.scrape_filters || {}) };
      if (r.progressed) {
        nextFilters._lastProgressAt = new Date().toISOString();
        await log(a.id, "scrape", "info", `📥 ${r.scrapedNow} lead(s) captado(s) até agora.`, { metadata: { count: r.scrapedNow } });
      }
      await supabase.from("automations").update({
        scraped_count: r.scrapedNow,
        scrape_filters: nextFilters,
        updated_at: new Date().toISOString(),
      }).eq("id", a.id);
      if (r.done) await startDispatchPhase({ ...a, scraped_count: r.scrapedNow, scrape_filters: nextFilters });
      return;
    }
    if (a.phase === "dispatching") {
      const done = await checkDispatchDone(a);
      if (done) await startFollowupPhase(a);
      return;
    }
    if (a.phase === "following") {
      const done = await checkFollowupDone(a);
      if (done) {
        await supabase.from("automations").update({
          phase: "done",
          status: "done",
          updated_at: new Date().toISOString(),
        }).eq("id", a.id);
        await log(a.id, "state", "success", "🏁 Automação concluída. Todos os leads foram processados.");
      }
      return;
    }
  } catch (e: any) {
    await markError(a.id, e?.message || String(e));
  }
}

/**
 * Tick global. Chamado pelo instrumentation a cada 60s.
 */
export async function tickAllAutomations(): Promise<number> {
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
}

/** Liga uma automação. SEMPRE reseta pra idle e re-tick — clicar Iniciar
 *  significa "rode agora", mesmo se o status já estava como running de uma
 *  tentativa anterior travada (que era o motivo de "nada acontecer"). */
export async function startAutomation(id: string): Promise<{ ok: boolean; error?: string; phase?: string }> {
  const { data: a } = await supabase.from("automations").select("*").eq("id", id).maybeSingle();
  if (!a) return { ok: false, error: "Automação não encontrada." };

  // Validação de pré-requisitos antes de virar status=running. Sem esses,
  // a automação morreria silenciosamente no primeiro tick.
  const niches  = Array.isArray(a.niches)  ? a.niches  : [];
  const regions = Array.isArray(a.regions) ? a.regions : [];
  if (niches.length === 0) return { ok: false, error: "Configure pelo menos 1 nicho antes de iniciar." };
  if (regions.length === 0) return { ok: false, error: "Configure pelo menos 1 região antes de iniciar." };
  if (!a.instance_name) return { ok: false, error: "Selecione uma instância WhatsApp." };
  if (!a.dispatch_template?.trim()) return { ok: false, error: "Template de disparo está vazio." };

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
        .eq("id", a.campaign_id);
    } catch (e) {
      console.warn(`[AUTOMATION] cancelamento de campanha antiga falhou: ${(e as Error).message}`);
    }
  }
  if (a.followup_campaign_id) {
    try {
      await supabase.from("followup_campaigns")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", a.followup_campaign_id);
    } catch {}
  }

  // Reset COMPLETO em todos os casos. Sem early-return: clicar Iniciar = recomeçar.
  // Limpa também os _baselineCount/_scrapeStartedAt/_lastProgressAt antigos pra
  // a heurística de progresso começar do zero.
  const cleanFilters = { ...(a.scrape_filters || {}) };
  delete cleanFilters._baselineCount;
  delete cleanFilters._scrapeStartedAt;
  delete cleanFilters._lastProgressAt;

  const { error: updErr } = await supabase.from("automations").update({
    status: "running",
    phase: "idle",
    last_error: null,
    last_error_at: null,
    campaign_id: null,
    followup_campaign_id: null,
    scraped_count: 0,
    scrape_filters: cleanFilters,
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (updErr) return { ok: false, error: "Erro interno ao iniciar automação: " + updErr.message };

  // Tick síncrono imediato — garante que phase muda pra "scraping" e o
  // scraper é disparado antes da resposta voltar pro frontend.
  try {
    await tickAllAutomations();
  } catch (e) {
    console.warn("[AUTOMATION] tick imediato falhou:", (e as Error).message);
  }

  // Lê o estado atualizado pra retornar pra UI.
  const { data: after } = await supabase.from("automations").select("phase, last_error").eq("id", id).maybeSingle();
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
export async function pauseAutomation(id: string): Promise<{ ok: boolean; stopped: { scraper: boolean; campaign: boolean; followup: boolean } }> {
  const { data: a } = await supabase.from("automations").select("*").eq("id", id).maybeSingle();
  if (!a) return { ok: false as any, stopped: { scraper: false, campaign: false, followup: false } };

  const stopped = { scraper: false, campaign: false, followup: false };

  // 1) Scraper — só para se a automação ATUAL estiver atrelada (scraper tem
  //    estado in-memory, e pode estar servindo /captador também). Heurística:
  //    se a fase é "scraping" + scraper rodando, esta é nossa.
  try {
    const sc = getScraperStatus();
    if (sc.isScraping && a.phase === "scraping") {
      stopScraper();
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
        .eq("id", a.followup_campaign_id);
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
    .eq("id", id);
  await log(id, "state", "warning",
    `⏸ Automação pausada. Etapas paradas: ${[
      stopped.scraper && "scraper",
      stopped.campaign && "disparo",
      stopped.followup && "follow-up",
    ].filter(Boolean).join(", ") || "nenhuma (nada estava rodando)"}.`,
  );

  return { ok: true, stopped };
}
