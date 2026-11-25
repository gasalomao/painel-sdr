import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { requireFeatureAccess } from "@/lib/saas-limits";
import { resolveModelForClient } from "@/lib/ai-default-model";
import { summarizeReviewsForLead } from "@/lib/reviews-ai";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/prospeccao-sites/reviews-ai
 *   { lead_ids: number[], model: string, prompt?: string, force?: boolean }
 *   → roda o resumo IA das avaliações de cada lead (sequencial, cache 7d).
 * GET  /api/prospeccao-sites/reviews-ai?logs=1&limit=50
 *   → últimos logs (o que a IA retornou).
 * GET  /api/prospeccao-sites/reviews-ai?lead_id=123
 *   → resumo cacheado do lead + logs dele.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    const denied = requireFeatureAccess(ctx, "prospeccao_sites");
    if (denied) return denied;

    const body = await req.json();
    const leadIds: number[] = Array.isArray(body?.lead_ids)
      ? body.lead_ids.map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 50)
      : [];
    const requestedModel = String(body?.model || "").trim();
    const model = ctx.isAdmin ? requestedModel : await resolveModelForClient(ctx.clientId);
    if (!leadIds.length) return NextResponse.json({ success: false, error: "lead_ids é obrigatório (máx 50)" }, { status: 400 });
    if (!model) return NextResponse.json({ success: false, error: "model é obrigatório" }, { status: 400 });

    const results: any[] = [];
    for (const id of leadIds) {
      try {
        const r = await summarizeReviewsForLead({
          leadId: id,
          model,
          customPrompt: body?.prompt || null,
          force: body?.force === true,
          clientId: ctx.clientId,
          source: "manual",
        });
        results.push("error" in r ? { lead_id: id, ok: false, error: r.error } : { ...r, ok: true });
      } catch (e: any) {
        results.push({ lead_id: id, ok: false, error: e?.message || String(e) });
      }
    }
    return NextResponse.json({ success: true, results });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    const denied = requireFeatureAccess(ctx, "prospeccao_sites");
    if (denied) return denied;

    const leadId = Number(req.nextUrl.searchParams.get("lead_id") || 0);
    const logs = req.nextUrl.searchParams.get("logs") === "1";
    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 50) || 50, 200);

    // Resumo cacheado do lead (coluna) — com fallback pra reviews_ai_logs
    if (leadId && !logs) {
      if (!ctx.isAdmin) {
        const { data: leadOwned } = await supabase
          .from("leads_extraidos")
          .select("id")
          .eq("id", leadId)
          .eq("client_id", ctx.clientId)
          .maybeSingle();
        if (!leadOwned) {
          return NextResponse.json({ success: false, error: "Lead não encontrado" }, { status: 404 });
        }
      }
      const { getCachedReviewsSummary } = await import("@/lib/reviews-ai");
      const resumo = await getCachedReviewsSummary({ leadId });
      let leadLogsQ = supabase
        .from("reviews_ai_logs")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (!ctx.isAdmin) {
        leadLogsQ = leadLogsQ.eq("client_id", ctx.clientId);
      }
      const { data: leadLogs, error } = await leadLogsQ;
      return NextResponse.json({
        success: true,
        resumo,
        logs: error ? [] : leadLogs || [],
        logsAvailable: !error,
      });
    }

    // Últimos logs globais do cliente
    let q = supabase.from("reviews_ai_logs").select("*").order("created_at", { ascending: false }).limit(limit);
    if (!ctx.isAdmin) q = q.eq("client_id", ctx.clientId);
    const { data, error } = await q;
    if (error) {
      // 42P01 = tabela da migração ainda não criada
      return NextResponse.json({ success: true, logs: [], logsAvailable: false, needsMigration: true });
    }
    return NextResponse.json({ success: true, logs: data || [], logsAvailable: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
