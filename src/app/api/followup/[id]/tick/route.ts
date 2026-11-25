import { NextRequest, NextResponse } from "next/server";
import { tickCampaign } from "@/lib/followup-worker";
import { requireClientId } from "@/lib/tenant";
import { checkTenantAiQuota, checkTenantRateLimit, requireFeatureAccess } from "@/lib/saas-limits";

export const dynamic = "force-dynamic";
// Tick pode demorar (vários envios com jitter) — Next route padrão aceita até ~60s
export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  const denied = requireFeatureAccess(ctx, "followup");
  if (denied) return denied;
  if (!ctx.isAdmin) {
    const rl = checkTenantRateLimit(`followup_tick:${ctx.clientId}`, 4, 5 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: `Aguarde ${rl.retryAfterSec ?? 1}s antes de disparar novo ciclo de follow-up.` },
        { status: 429 },
      );
    }
    const quota = await checkTenantAiQuota(ctx.clientId, false);
    if (!quota.allowed) {
      return NextResponse.json(
        { success: false, error: quota.reason || "Limite mensal de IA do plano atingido." },
        { status: 429 },
      );
    }
  }

  try {
    const { id } = await params;
    const r = await tickCampaign(id, ctx.clientId);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, processed: r.processed });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
