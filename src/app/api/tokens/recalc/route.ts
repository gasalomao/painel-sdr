/**
 * POST /api/tokens/recalc
 *
 * Re-aplica os preços atuais (online, do LiteLLM) em TODAS as linhas
 * de ai_token_usage que tenham cost_usd zerado ou desatualizado.
 * Útil quando o tracking gravou cost=0 (preço não mapeado naquele momento)
 * e agora o cache tem o preço certo.
 *
 * Lê em lotes de 1000 pra não estourar memória.
 */
import { NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import { ensurePricing, lookupPriceSync, computeCost } from "@/lib/pricing";

export const dynamic = "force-dynamic";
const adminClient = supabaseAdmin || supabase;

export async function POST() {
  await ensurePricing(true); // sempre busca os preços mais recentes antes
  let updated = 0;
  let scanned = 0;
  let skipped = 0;
  const unknownModels = new Set<string>();

  const PAGE = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await adminClient
      .from("ai_token_usage")
      .select("id, model, prompt_tokens, completion_tokens, cost_usd")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      if ((error as any).code === "42P01") {
        return NextResponse.json({ success: false, error: "Tabela ai_token_usage não existe." }, { status: 400 });
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    if (!data || data.length === 0) break;
    scanned += data.length;

    const updates: Array<PromiseLike<any>> = [];
    for (const row of data as any[]) {
      const price = lookupPriceSync(row.model);
      if (!price) {
        unknownModels.add(row.model || "(null)");
        skipped++;
        continue;
      }
      const novoCost = computeCost(price, row.prompt_tokens || 0, row.completion_tokens || 0);
      const atual = Number(row.cost_usd || 0);
      // Só atualiza se a diferença for relevante (> 1e-9 USD)
      if (Math.abs(novoCost - atual) > 1e-9) {
        updates.push(
          adminClient.from("ai_token_usage").update({ cost_usd: novoCost }).eq("id", row.id)
        );
        updated++;
      }
    }
    // Aplica em paralelo (Supabase aguenta tranquilo até 50)
    for (let i = 0; i < updates.length; i += 50) {
      await Promise.all(updates.slice(i, i + 50));
    }

    if (data.length < PAGE) break;
    from += PAGE;
  }

  return NextResponse.json({
    success: true,
    scanned,
    updated,
    skipped,
    unknownModels: Array.from(unknownModels).slice(0, 30),
  });
}
