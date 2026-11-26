import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { loadMentorFunnelMetricsForClient } from "@/lib/mentor-metrics";
import { computeCampaignAbSummary, type CampaignAbSummary } from "@/lib/campaign-ab-testing";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const summary = await loadMentorFunnelMetricsForClient(auth.clientId);
  const abCampaigns: CampaignAbSummary[] = [];
  try {
    const { data: camps } = await supabaseAdmin
      .from("campaigns")
      .select("id, name")
      .eq("client_id", auth.clientId)
      .order("created_at", { ascending: false })
      .limit(30);
    for (const c of (camps || []) as Array<{ id?: string; name?: string | null }>) {
      if (!c?.id) continue;
      const ab = await computeCampaignAbSummary(auth.clientId, c.id, c.name);
      if (ab.summary) abCampaigns.push(ab.summary);
    }
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ ok: true, metrics: summary, ab_campaigns: abCampaigns });
}
