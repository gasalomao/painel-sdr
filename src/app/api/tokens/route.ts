import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import { ensurePricing, lookupPriceSync, computeCost, getCacheState, ensureFxRate, getFxState } from "@/lib/pricing";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const adminClient = supabaseAdmin || supabase;

const SOURCES = ["agent", "disparo", "followup", "organizer", "other"] as const;

/**
 * GET /api/tokens?from=ISO&to=ISO[&brl=5.10]
 *
 * Devolve um pacote completo pra UI:
 *   - totals      — prompt/completion/total/cost USD/BRL/calls
 *   - bySource    — agregado por feature (agent, disparo, ...)
 *   - bySourceLabel — agregado por agent/campanha (label)
 *   - byModel     — agregado por modelo + preço unitário (input/output) atualizados online
 *   - byDayStacked — uma linha por dia, com colunas por feature (cost USD) — pronto pra stacked chart
 *   - recent      — últimas 50 linhas
 *   - pricingState — { source, fetchedAt, modelCount } — pra UI mostrar "preços de X data"
 *
 * O cost_usd das linhas é recalculado em tempo de leitura usando o preço online corrente,
 * pra a UI sempre refletir a tabela mais nova mesmo se o tracking gravou um valor antigo.
 */
export async function GET(req: NextRequest) {
  try {
    // Multi-tenant: cliente só vê os próprios tokens. Admin (não-impersonando)
    // vê TUDO (sem filtro client_id) pra dashboard global do sistema.
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;

    await Promise.all([ensurePricing(), ensureFxRate()]);

    const fromIso = req.nextUrl.searchParams.get("from");
    const toIso   = req.nextUrl.searchParams.get("to");
    const fxState = await getFxState();
    const brlOverride = req.nextUrl.searchParams.get("brl");
    const brlRate = brlOverride ? Number(brlOverride) : fxState.rate;

    let q = adminClient.from("ai_token_usage").select("*").order("created_at", { ascending: false });
    if (!ctx.isAdmin) q = q.eq("client_id", ctx.clientId);
    if (fromIso) q = q.gte("created_at", fromIso);
    if (toIso) q = q.lte("created_at", toIso);

    const { data, error } = await q.limit(20000);
    if (error) {
      if ((error as any).code === "42P01") {
        return NextResponse.json({
          success: true,
          notReady: true,
          message: "Tabela ai_token_usage não existe. Rode SETUP_COMPLETO.sql no Supabase.",
          totals: { prompt: 0, completion: 0, total: 0, cost: 0, costBrl: 0, calls: 0, brlRate },
          bySource: [], bySourceLabel: [], byModel: [], byDayStacked: [], recent: [],
          pricingState: { source: "fallback", fetchedAt: 0, modelCount: 0 },
        });
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const rows = (data || []) as any[];

    // Recalcula cost com preço online ATUAL (não confia no cost_usd antigo)
    for (const r of rows) {
      const price = lookupPriceSync(r.model);
      r._cost_live = computeCost(price, r.prompt_tokens || 0, r.completion_tokens || 0);
      r._has_price = !!price;
    }

    // Totals
    let totalPrompt = 0, totalCompletion = 0, totalTokens = 0, totalCost = 0;
    for (const r of rows) {
      totalPrompt     += Number(r.prompt_tokens || 0);
      totalCompletion += Number(r.completion_tokens || 0);
      totalTokens     += Number(r.total_tokens || 0);
      totalCost       += r._cost_live;
    }

    const agg = (keyOf: (r: any) => string) => {
      const map: Record<string, { total: number; cost: number; calls: number; prompt: number; completion: number }> = {};
      for (const r of rows) {
        const k = keyOf(r) || "(sem nome)";
        if (!map[k]) map[k] = { total: 0, cost: 0, calls: 0, prompt: 0, completion: 0 };
        map[k].total      += Number(r.total_tokens || 0);
        map[k].cost       += r._cost_live;
        map[k].calls      += 1;
        map[k].prompt     += Number(r.prompt_tokens || 0);
        map[k].completion += Number(r.completion_tokens || 0);
      }
      return Object.entries(map)
        .map(([k, v]) => ({ key: k, ...v }))
        .sort((a, b) => b.cost - a.cost || b.total - a.total);
    };

    const bySource = agg(r => String(r.source || "other"))
      .map(x => ({ source: x.key, total: x.total, cost: x.cost, calls: x.calls, prompt: x.prompt, completion: x.completion }));

    const bySourceLabel = agg(r => `${r.source}::${r.source_label || r.source_id || ""}`)
      .map(x => {
        const [source, label] = x.key.split("::");
        return { source, label: label || source, total: x.total, cost: x.cost, calls: x.calls };
      });

    // Por modelo + preço atual
    const byModelAgg = agg(r => String(r.model || "unknown"));
    const byModel = byModelAgg.map(x => {
      const price = lookupPriceSync(x.key);
      return {
        model: x.key,
        total: x.total,
        cost: x.cost,
        calls: x.calls,
        prompt: x.prompt,
        completion: x.completion,
        priceKnown: !!price,
        input_per_1m:  price ? price.input_per_token  * 1_000_000 : null,
        output_per_1m: price ? price.output_per_token * 1_000_000 : null,
      };
    });

    // Por dia, COM stacking por feature (cada source vira coluna)
    const byDayMap: Record<string, any> = {};
    for (const r of rows) {
      const day = new Date(r.created_at).toISOString().slice(0, 10);
      if (!byDayMap[day]) {
        byDayMap[day] = { day, total: 0, cost: 0, calls: 0 };
        for (const s of SOURCES) byDayMap[day][s] = 0; // cost por feature
      }
      const src = (SOURCES as readonly string[]).includes(r.source) ? r.source : "other";
      byDayMap[day][src] += r._cost_live;
      byDayMap[day].total += Number(r.total_tokens || 0);
      byDayMap[day].cost  += r._cost_live;
      byDayMap[day].calls += 1;
    }
    const byDayStacked = Object.values(byDayMap).sort((a: any, b: any) => a.day.localeCompare(b.day));

    const pricingState = await getCacheState();

    return NextResponse.json({
      success: true,
      totals: {
        prompt: totalPrompt,
        completion: totalCompletion,
        total: totalTokens,
        cost: totalCost,
        costBrl: totalCost * brlRate,
        calls: rows.length,
        brlRate,
      },
      fx: { ...fxState, override: !!brlOverride },
      bySource,
      bySourceLabel,
      byModel,
      byDayStacked,
      recent: rows.slice(0, 50).map(r => ({
        id: r.id,
        source: r.source,
        source_label: r.source_label,
        model: r.model,
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        total_tokens: r.total_tokens,
        cost_usd: r._cost_live,
        cost_brl: r._cost_live * brlRate,
        priceKnown: r._has_price,
        created_at: r.created_at,
      })),
      pricingState,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || String(err) }, { status: 500 });
  }
}
