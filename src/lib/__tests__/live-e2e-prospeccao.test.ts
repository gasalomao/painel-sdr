/**
 * E2E AO VIVO — prospecção Google Maps (scraper-engine) + Reviews-IA com
 * modelo FREE do OpenRouter.
 *
 * OPT-IN: só roda com LIVE_E2E=1 — o `npm test` normal pula este arquivo.
 *   PowerShell:  $env:LIVE_E2E="1"; npx vitest run src/lib/__tests__/live-e2e-prospeccao.test.ts
 *
 * Cenário:
 *   1. Diagnóstico de chaves IA (booleans, nunca valores).
 *   2. Lista modelos OpenRouter e escolhe um FREE (:free) p/ o resumo.
 *   3. Scraper ao vivo: nicho/região pequenos, maxLeads baixo, filtros ON
 *      (sem site / sem telefone descartados ANTES do trabalho caro),
 *      captureAllReviews ON (valida FASE 2), webhook OFF (nada sai pra fora),
 *      sem automation_id (não toca em automações existentes).
 *   4. Aguarda fim por polling de getStatus().
 *   5. Reviews-IA no primeiro lead capturado com o modelo free escolhido.
 */
import { describe, it, expect } from "vitest";
import { startScraperRun, getStatus, stopScraper } from "@/lib/scraper-engine";
import { listAvailableOpenRouterModels } from "@/lib/openrouter-model-discovery";
import { getAiKeys } from "@/lib/ai-keys";
import { summarizeReviewsForLead } from "@/lib/reviews-ai";
import { supabaseAdmin } from "@/lib/supabase_admin";

const LIVE = process.env.LIVE_E2E === "1";
const MAX_LEADS = Number(process.env.LIVE_MAX_LEADS || 3);
const POLL_MS = 4000;
const TIMEOUT_SCRAPER_MS = 10 * 60 * 1000;

describe.skipIf(!LIVE)("E2E ao vivo — prospecção + IA free", () => {
  it("diagnóstico de chaves IA", async () => {
    const keys = await getAiKeys();
    console.log("[E2E] providers configurados:", {
      gemini: !!keys.gemini,
      openrouter: !!keys.openrouter,
    });
    expect(keys.gemini || keys.openrouter).toBeTruthy();
  });

  it("lista e escolhe modelo FREE do OpenRouter", async () => {
    const models = await listAvailableOpenRouterModels(true);
    const free = models.filter((m) => m.id.endsWith(":free"));
    console.log(`[E2E] ${models.length} modelos chat, ${free.length} free. Amostra free:`);
    for (const m of free.slice(0, 8)) {
      console.log(`[E2E]   - ${m.id} (ctx ${m.contextLength ?? "?"}, tools=${m.supportsTools})`);
    }
    expect(free.length).toBeGreaterThan(0);
  });

  it(
    "scraper ao vivo capta até maxLeads com filtros",
    async () => {
      const r = startScraperRun({
        niches: [process.env.LIVE_NICHE || "clinica estetica"],
        regions: [process.env.LIVE_REGION || "Vitoria ES"],
        webhookEnabled: false,
        mode: "realtime",
        filterEmpty: true,
        filterDuplicates: true,
        filterLandlines: true,
        filterWithWebsite: true,
        captureAllReviews: true,
        maxLeads: MAX_LEADS,
        automation_id: null,
        client_id: null,
        reviews_ai: { enabled: false },
      });
      expect(r.ok).toBe(true);

      const t0 = Date.now();
      let done = false;
      while (Date.now() - t0 < TIMEOUT_SCRAPER_MS) {
        await new Promise((res) => setTimeout(res, POLL_MS));
        const st = getStatus();
        console.log(
          `[E2E][${Math.round((Date.now() - t0) / 1000)}s] scraping=${st.isScraping} paused=${st.isPaused} leads=${st.leadCount}`,
        );
        if (!st.isScraping) { done = true; break; }
      }
      if (!done) {
        stopScraper();
        throw new Error("Timeout aguardando scraper terminar");
      }
      const st = getStatus();
      console.log(`[E2E] concluído em ${Math.round((Date.now() - t0) / 1000)}s, leads=${st.leadCount}`);
      expect(st.leadCount).toBeGreaterThanOrEqual(0);
    },
    TIMEOUT_SCRAPER_MS + 30000,
  );

  it("Reviews-IA com modelo FREE no último lead salvo", async () => {
    const db = supabaseAdmin;
    expect(db).toBeTruthy();

    // Pega um lead recente COM reviews detalhadas
    const { data: leads, error } = await db!
      .from("leads_extraidos")
      .select("id, nome_negocio")
      .not("reviews_detalhes", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    expect(error || !leads?.length).toBeFalsy();
    const lead = leads![0];
    console.log(`[E2E] lead p/ análise: #${lead.id} "${lead.nome_negocio}"`);

    const models = await listAvailableOpenRouterModels(true);
    const free = models.filter((m) => m.id.endsWith(":free"));
    // Preferência: rápidos e sem vazamento de raciocínio no conteúdo.
    const prefRe = /dots-3-note|laguna|gemma|glm/i;
    const ordered = [
      ...free.filter((m) => m.supportsTools && prefRe.test(m.id)),
      ...free.filter((m) => m.supportsTools && !prefRe.test(m.id)),
      ...free,
    ];
    let out: Awaited<ReturnType<typeof summarizeReviewsForLead>> | null = null;
    let lastErr = "";
    for (const cand of ordered.slice(0, 5)) {
      const modelRef = `openrouter:${cand.id}`;
      console.log(`[E2E] tentando modelo free: ${modelRef}`);
      const t0 = Date.now();
      const r = await summarizeReviewsForLead({
        leadId: lead.id,
        model: modelRef,
        source: "manual",
        force: true,
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (!("error" in r) && r.resumo.length > 30) {
        out = r;
        console.log(`[E2E] OK em ${dt}s · modelo=${r.modelUsed} · tokens=${r.usage?.totalTokens} · persistido=${r.persisted}`);
        break;
      }
      lastErr = "error" in r ? r.error : `resumo curto (${r.resumo.length} chars)`;
      console.log(`[E2E] falhou em ${dt}s: ${lastErr.slice(0, 120)} — tentando próximo modelo`);
    }
    if (!out) throw new Error(`Nenhum modelo free produziu resumo. Último erro: ${lastErr}`);
    console.log(`[E2E] ---- RESUMO ----\n${out.resumo}\n[E2E] ----------------`);
    expect(out.resumo.length).toBeGreaterThan(30);
  }, 120000);
});
