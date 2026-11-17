import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/followup/logs?campaign_id=...
 * GET /api/followup/logs?latest_ids=id1,id2,...
 * Valida ownership em `followup_campaigns` pelo `auth.clientId`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ success: false, error: "DB indisponível" }, { status: 500 });
  }

  const sp = req.nextUrl.searchParams;
  const latestRaw = sp.get("latest_ids");

  if (latestRaw) {
    const requestedIds = latestRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);

    if (requestedIds.length === 0) {
      return NextResponse.json({ success: true, latestById: {} });
    }

    const { data: owned } = await supabaseAdmin
      .from("followup_campaigns")
      .select("id")
      .eq("client_id", auth.clientId)
      .in("id", requestedIds);

    const ownedIds = ((owned || []) as Array<{ id: string }>).map((c) => c.id);
    if (ownedIds.length === 0) {
      return NextResponse.json({ success: true, latestById: {} });
    }

    const { data: logs, error } = await supabaseAdmin
      .from("followup_logs")
      .select("*")
      .eq("client_id", auth.clientId)
      .in("followup_campaign_id", ownedIds)
      .order("created_at", { ascending: false })
      .limit(ownedIds.length * 3);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const latestById: Record<string, Record<string, unknown>> = {};
    for (const row of (logs || []) as Array<{ followup_campaign_id: string } & Record<string, unknown>>) {
      if (!latestById[row.followup_campaign_id]) {
        latestById[row.followup_campaign_id] = row;
      }
    }
    return NextResponse.json({ success: true, latestById });
  }

  const campaignId = sp.get("campaign_id")?.trim();
  if (!campaignId) {
    return NextResponse.json({ success: false, error: "campaign_id obrigatório" }, { status: 400 });
  }

  const { data: campaign } = await supabaseAdmin
    .from("followup_campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("client_id", auth.clientId)
    .maybeSingle();

  if (!campaign) {
    return NextResponse.json({ success: false, error: "Campanha de follow-up não encontrada" }, { status: 404 });
  }

  const { data: logs, error } = await supabaseAdmin
    .from("followup_logs")
    .select("*")
    .eq("followup_campaign_id", campaignId)
    .eq("client_id", auth.clientId)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, logs: logs || [] });
}

