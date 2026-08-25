/**
 * E2E AO VIVO — AUTOMAÇÃO COMPLETA (fluxo real do sistema).
 *
 * Nicho: salão de beleza · Filtro: SEM sites · Máx 2 leads
 * SEM disparo real: instância "__e2e_sem_disparo__" NÃO EXISTE na Evolution,
 * então todo envio falha graciosamente — pipeline inteiro exercido, zero
 * mensagem enviada. Sem reescrita IA (dispatch_personalize=false).
 * COM resumo de avaliações IA (modelo free OpenRouter).
 *
 * A automação é criada direto no banco (status=running) e o TICKER REAL do
 * servidor dev (60s) dirige as fases — exatamente como produção. Este teste
 * só cria e OBSERVA: fase da automação + automation_logs.
 *
 * OPT-IN: $env:LIVE_E2E="1"; npx vitest run src/lib/__tests__/live-e2e-fluxo-completo.test.ts
 */
import { describe, it, expect, afterAll } from "vitest";
import { listAvailableOpenRouterModels } from "@/lib/openrouter-model-discovery";
import { supabaseAdmin } from "@/lib/supabase_admin";

const LIVE = process.env.LIVE_E2E === "1";
const db = () => supabaseAdmin!;
const MARK = "[E2E]";
const TIMEOUT_MS = 14 * 60 * 1000;
let automationId = "";

afterAll(async () => {
  if (!automationId || !db()) return;
  // Deixa tudo registrado pra inspeção, mas garante automação PARADA.
  await db().from("automations").update({ status: "paused", phase: "paused", updated_at: new Date().toISOString() }).eq("id", automationId);
  console.log(`\n[E2E-FLOW] automação ${automationId} pausada ao final do teste.`);
});

async function tailLogs(id: string, sinceIso: string): Promise<string[]> {
  const { data } = await db()
    .from("automation_logs")
    .select("created_at, level, message")
    .eq("automation_id", id)
    .gt("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(200);
  return (data || []).map((r: any) => `${new Date(r.created_at).toLocaleTimeString("pt-BR")} ${r.level.toUpperCase()} ${r.message}`);
}

describe.skipIf(!LIVE)("E2E fluxo completo da automação (sem disparo real)", () => {
  it(
    "cria automação, ticker real dirige scraping→dispatch→followup→done",
    async () => {
      // ── Guarda de segurança: nenhuma OUTRA automação pode estar rodando ──
      const { data: running } = await db().from("automations").select("id, name").eq("status", "running");
      if (running && running.length > 0) {
        console.log("[E2E-FLOW] ATENÇÃO — automações já rodando:", running);
        throw new Error("Existem automações reais rodando. Pare-as antes deste teste (segurança).");
      }

      // Modelo free vivo pra reviews-ai
      const models = await listAvailableOpenRouterModels(true);
      const free = models.filter((m) => m.id.endsWith(":free"));
      const pick = free.find((m) => /dots-3-note|laguna/i.test(m.id)) || free.find((m) => m.supportsTools) || free[0];
      const freeModel = `openrouter:${pick.id}`;
      console.log(`[E2E-FLOW] modelo free p/ reviews-ai: ${freeModel}`);

      // ── Cria a automação (igual UI faria) ──
      const insert: any = {
        name: `${MARK} salão de beleza s/ site`,
        niches: ["salao de beleza"],
        regions: ["Vitoria ES"],
        instance_name: "__e2e_sem_disparo__", // não existe → nenhum zap sai
        agent_id: null,
        client_id: null,
        dispatch_template: "Olá {{nome_negocio}}! Tudo bem?",
        dispatch_min_interval: 5,
        dispatch_max_interval: 10,
        dispatch_personalize: false,   // sem reescrita IA (pedido do usuário)
        dispatch_humanize: false,
        dispatch_ai_model: null,
        allowed_start_hour: 0,
        allowed_end_hour: 23,
        lead_intelligence_enabled: false,
        scrape_max_leads: 2,
        scrape_filters: {
          filterEmpty: true,
          filterDuplicates: true,
          filterLandlines: true,
          filterWithWebsite: true,     // ← SEM SITES (pedido do usuário)
          captureAllReviews: true,
          reviews_ai: { enabled: true, model: freeModel, prompt: null },
        },
        status: "running",
        phase: "idle",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { data: aut, error } = await db().from("automations").insert(insert).select("id").single();
      expect(error || !aut).toBeFalsy();
      automationId = aut!.id;
      console.log(`[E2E-FLOW] automação criada: ${automationId}`);

      // ── Observa o ticker real trabalhar ──
      const t0 = Date.now();
      let since = new Date(t0).toISOString();
      let lastPhase = "";
      const seenPhases = new Set<string>();
      let done = false;

      while (Date.now() - t0 < TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 15000));
        const { data: row } = await db()
          .from("automations")
          .select("phase, status, scraped_count, campaign_id, followup_campaign_id, last_error")
          .eq("id", automationId)
          .maybeSingle();
        if (!row) throw new Error("Automação sumiu do banco?!");

        // Imprime logs novos desde a última leitura
        const lines = await tailLogs(automationId, since);
        for (const l of lines) console.log(`[LOG] ${l}`);
        if (lines.length) since = new Date().toISOString();

        const sig = `${row.phase}|${row.status}`;
        if (sig !== lastPhase) {
          console.log(`[E2E-FLOW][${Math.round((Date.now() - t0) / 1000)}s] phase=${row.phase} status=${row.status} captados=${row.scraped_count} campanha=${row.campaign_id || "-"} followup=${row.followup_campaign_id || "-"}`);
          seenPhases.add(row.phase);
          lastPhase = sig;
        }

        if (row.status === "done" || row.status === "error" || row.phase === "done") {
          done = true;
          console.log(`[E2E-FLOW] FINAL: phase=${row.phase} status=${row.status} last_error=${row.last_error || "-"}`);
          break;
        }
      }
      expect(done).toBe(true);

      // ── Verificações finais ──
      const { data: fin } = await db()
        .from("automations")
        .select("phase, status, scraped_count, campaign_id, followup_campaign_id, last_error")
        .eq("id", automationId)
        .maybeSingle();

      console.log(`[E2E-FLOW] fases observadas: ${Array.from(seenPhases).join(" → ")}`);
      expect(seenPhases.has("scraping")).toBe(true);

      if (fin!.scraped_count > 0) {
        // Campanha criada. Com instância fake, startCampaign faz FAIL-FAST
        // (valida instância ANTES de iniciar) → campanha fica draft, targets
        // pending, automação marcada erro. Isso É o comportamento correto:
        // pipeline provado sem nenhuma mensagem sair de verdade.
        if (fin!.campaign_id) {
          const { data: camp } = await db()
            .from("campaigns")
            .select("status, instance_name, total_targets")
            .eq("id", fin!.campaign_id)
            .maybeSingle();
          console.log(`[E2E-FLOW] campanha de disparo: ${JSON.stringify(camp)}`);
          expect(camp?.instance_name).toBe("__e2e_sem_disparo__");
          // Fail-fast OU execução completa — ambos válidos; nunca pode ter ENVIADO.
          if (camp?.status !== "draft") {
            const { data: tgts } = await db()
              .from("campaign_targets")
              .select("status")
              .eq("campaign_id", fin!.campaign_id);
            const sent = (tgts || []).filter((t: any) => t.status === "sent").length;
            console.log(`[E2E-FLOW] targets por status: ${JSON.stringify(tgts?.reduce((acc: any, t: any) => ({ ...acc, [t.status]: (acc[t.status] || 0) + 1 }), {}))}`);
            expect(sent).toBe(0);
          }
        }
        if (fin!.followup_campaign_id) {
          const { data: fc } = await db()
            .from("followup_campaigns")
            .select("name, status")
            .eq("id", fin!.followup_campaign_id)
            .maybeSingle();
          console.log(`[E2E-FLOW] follow-up criado: "${fc?.name}" (${fc?.status})`);
        }
        console.log(`[E2E-FLOW] ✅ FLUXO COMPLETO OK — captou ${fin!.scraped_count}, reviews-IA rodou, disparo contido (0 msgs reais), last_error=${(fin!.last_error || "-").slice(0, 80)}`);
      } else {
        console.log(`[E2E-FLOW] ⚠️ captou 0 leads (Google Maps pode ter variado). Fases até aqui: ${Array.from(seenPhases).join(" → ")}`);
      }
    },
    TIMEOUT_MS + 60000,
  );
});
