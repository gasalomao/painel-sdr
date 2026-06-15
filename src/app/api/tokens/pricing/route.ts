/**
 * GET  /api/tokens/pricing            → preços atuais em cache (LiteLLM)
 * POST /api/tokens/pricing            → força refresh remoto, devolve novo cache
 *
 * Saída:
 * {
 *   source: "remote" | "db" | "fallback",
 *   fetchedAt: <ms>,
 *   modelCount: <n>,
 *   gemini: [{ model, input_per_1m, output_per_1m }],
 *   url: "https://...litellm.../model_prices..."
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import { ensurePricing, getCacheState, listGeminiPrices, getFxState, ensureFxRate } from "@/lib/pricing";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const SOURCE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export async function GET() {
  await ensurePricing();
  const [state, gemini, fx] = await Promise.all([
    getCacheState(),
    listGeminiPrices(),
    getFxState(),
  ]);
  return NextResponse.json({ success: true, ...state, gemini, fx, url: SOURCE_URL });
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!auth.isAdmin) return NextResponse.json({ success: false, error: "Apenas admin" }, { status: 403 });
  // Força refresh dos DOIS: preços e câmbio.
  const [fresh] = await Promise.all([ensurePricing(true), ensureFxRate(true)]);
  const [gemini, fx] = await Promise.all([listGeminiPrices(), getFxState()]);
  return NextResponse.json({
    success: true,
    source: fresh.source,
    fetchedAt: fresh.fetchedAt,
    modelCount: Object.keys(fresh.map).length,
    gemini,
    fx,
    url: SOURCE_URL,
  });
}
