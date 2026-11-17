import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/campaigns/logs?campaign_id=...&limit=100
 * GET /api/campaigns/logs?latest_ids=id1,id2,...
 * DELETE /api/campaigns/logs?campaign_id=...
 * Todos validam ownership em `campaigns` pelo `auth.clientId`.
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
      .from("campaigns")
      .select("id")
      .eq("client_id", auth.clientId)
      .in("id", requestedIds);

    const ownedIds = ((owned || []) as Array<{ id: string }>).map((c) => c.id);
    if (ownedIds.length === 0) {
      return NextResponse.json({ success: true, latestById: {} });
    }

    const { data: logs, error } = await supabaseAdmin
      .from("campaign_logs")
      .select("campaign_id, message, level, created_at")
      .eq("client_id", auth.clientId)
      .in("campaign_id", ownedIds)
      .order("created_at", { ascending: false })
      .limit(ownedIds.length * 3);

    if (error) {
      console.error("[campaigns/logs/latest] Erro:", error.message);
      return NextResponse.json({ success: false, error: "Falha ao consultar logs da campanha" }, { status: 500 });
    }

    const latestById: Record<string, Record<string, unknown>> = {};
    for (const row of (logs || []) as Array<{ campaign_id: string } & Record<string, unknown>>) {
      if (!latestById[row.campaign_id]) latestById[row.campaign_id] = row;
    }
    return NextResponse.json({ success: true, latestById });
  }

  const campaignId = sp.get("campaign_id")?.trim();
  if (!campaignId) {
    return NextResponse.json({ success: false, error: "campaign_id obrigatório" }, { status: 400 });
  }

  const { data: campaign } = await supabaseAdmin
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("client_id", auth.clientId)
    .maybeSingle();

  if (!campaign) {
    return NextResponse.json({ success: false, error: "Campanha não encontrada" }, { status: 404 });
  }

  const limit = Math.min(500, Math.max(10, Number(sp.get("limit") || 100)));
  const { data: logs, error } = await supabaseAdmin
    .from("campaign_logs")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("client_id", auth.clientId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[campaigns/logs/GET] Erro:", error.message);
    return NextResponse.json({ success: false, error: "Falha ao consultar logs da campanha" }, { status: 500 });
  }

  return NextResponse.json({ success: true, logs: logs || [] });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ success: false, error: "DB indisponível" }, { status: 500 });
  }

  const campaignId = req.nextUrl.searchParams.get("campaign_id")?.trim();
  if (!campaignId) {
    return NextResponse.json({ success: false, error: "campaign_id obrigatório" }, { status: 400 });
  }

  const { data: campaign } = await supabaseAdmin
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("client_id", auth.clientId)
    .maybeSingle();

  if (!campaign) {
    return NextResponse.json({ success: false, error: "Campanha não encontrada" }, { status: 404 });
  }

  const { error } = await supabaseAdmin
    .from("campaign_logs")
    .delete()
    .eq("campaign_id", campaignId)
    .eq("client_id", auth.clientId);

  if (error) {
    console.error("[campaigns/logs/DELETE] Erro:", error.message);
    return NextResponse.json({ success: false, error: "Falha ao apagar logs da campanha" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

