import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { requireFeatureAccess } from "@/lib/saas-limits";

export const dynamic = "force-dynamic";

type LogEntry = {
  id: string;
  ts: string;
  kind: string;
  level: string;
  message: string;
  remote_jid?: string | null;
};

/**
 * GET /api/automations/[id]/logs
 * Retorna histórico unificado da automação (automation_logs, campaign_logs, followup_logs,
 * scrapeFeed e respostas recebidas) ou ?scrape_count=1 com validação de ownership pelo tenant.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireFeatureAccess(auth, ["automacao", "prospeccao_sites"]);
  if (denied) return denied;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ ok: false, error: "ID da automação obrigatório" }, { status: 400 });
  }

  const { data: automation, error: autoErr } = await supabaseAdmin
    .from("automations")
    .select("id, client_id, campaign_id, followup_campaign_id, started_at")
    .eq("id", id)
    .eq("client_id", auth.clientId)
    .maybeSingle();

  if (autoErr) {
    return NextResponse.json({ ok: false, error: autoErr.message }, { status: 500 });
  }
  if (!automation) {
    return NextResponse.json({ ok: false, error: "Automação não encontrada" }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  if (sp.get("scrape_count") === "1") {
    const startedAt = sp.get("started_at") || (automation.started_at as string | null);
    if (!startedAt) {
      return NextResponse.json({ ok: true, leadIds: [] });
    }
    const maxLimit = Math.min(2000, Math.max(50, Number(sp.get("limit") || 200)));
    const { data: leads, error: leadsErr } = await supabaseAdmin
      .from("leads_extraidos")
      .select("id")
      .eq("client_id", auth.clientId)
      .gte("created_at", startedAt)
      .not("remoteJid", "is", null)
      .limit(maxLimit);

    if (leadsErr) {
      return NextResponse.json({ ok: false, error: leadsErr.message }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      leadIds: (leads || []).map((r: { id: number }) => r.id),
    });
  }

  const onlyAutomation = sp.get("only") === "automation";
  const merged: LogEntry[] = [];

  const { data: alogs, error: alogsErr } = await supabaseAdmin
    .from("automation_logs")
    .select("id, kind, level, message, remote_jid, created_at")
    .eq("automation_id", id)
    .eq("client_id", auth.clientId)
    .order("created_at", { ascending: false })
    .limit(onlyAutomation ? 100 : 500);

  if (alogsErr) {
    return NextResponse.json({ ok: false, error: alogsErr.message }, { status: 500 });
  }

  if (onlyAutomation) {
    return NextResponse.json({ ok: true, logs: alogs || [] });
  }

  for (const r of (alogs || []) as Array<{
    id: string | number;
    kind: string;
    level: string;
    message: string;
    remote_jid?: string | null;
    created_at: string;
  }>) {
    merged.push({
      id: `a:${r.id}`,
      ts: r.created_at,
      kind: r.kind,
      level: r.level,
      message: r.message,
      remote_jid: r.remote_jid,
    });
  }

  const campaignId = automation.campaign_id as string | null;
  const followupCampaignId = automation.followup_campaign_id as string | null;
  const startedAt = automation.started_at as string | null;

  const [clogsRes, flogsRes, leadsRes, targetsRes] = await Promise.all([
    campaignId
      ? supabaseAdmin
          .from("campaign_logs")
          .select("id, message, level, created_at")
          .eq("campaign_id", campaignId)
          .eq("client_id", auth.clientId)
          .order("created_at", { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [] }),
    followupCampaignId
      ? supabaseAdmin
          .from("followup_logs")
          .select("id, message, level, created_at")
          .eq("followup_campaign_id", followupCampaignId)
          .eq("client_id", auth.clientId)
          .order("created_at", { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [] }),
    startedAt
      ? supabaseAdmin
          .from("leads_extraidos")
          .select("id, nome_negocio, created_at")
          .eq("client_id", auth.clientId)
          .gte("created_at", startedAt)
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] }),
    campaignId
      ? supabaseAdmin
          .from("campaign_targets")
          .select("remote_jid")
          .eq("campaign_id", campaignId)
          .eq("client_id", auth.clientId)
      : Promise.resolve({ data: [] }),
  ]);

  for (const r of (clogsRes.data || []) as Array<{
    id: string | number;
    message: string;
    level?: string | null;
    created_at: string;
  }>) {
    merged.push({
      id: `c:${r.id}`,
      ts: r.created_at,
      kind: "dispatch",
      level: r.level || "info",
      message: r.message,
    });
  }

  for (const r of (flogsRes.data || []) as Array<{
    id: string | number;
    message: string;
    level?: string | null;
    created_at: string;
  }>) {
    merged.push({
      id: `f:${r.id}`,
      ts: r.created_at,
      kind: "followup",
      level: r.level || "info",
      message: r.message,
    });
  }

  const jids = ((targetsRes.data || []) as Array<{ remote_jid?: string | null }>)
    .map((t) => t.remote_jid)
    .filter((j): j is string => Boolean(j));

  if (jids.length > 0) {
    const { data: replies } = await supabaseAdmin
      .from("chats_dashboard")
      .select("id, remote_jid, content, created_at")
      .eq("client_id", auth.clientId)
      .in("remote_jid", jids)
      .eq("sender_type", "customer")
      .order("created_at", { ascending: false })
      .limit(100);

    for (const r of (replies || []) as Array<{
      id: string | number;
      remote_jid: string;
      content?: string | null;
      created_at: string;
    }>) {
      const snippet = (r.content || "").slice(0, 100);
      merged.push({
        id: `r:${r.id}`,
        ts: r.created_at,
        kind: "reply",
        level: "success",
        message: `💬 Cliente respondeu: "${snippet}${(r.content || "").length > 100 ? "…" : ""}"`,
        remote_jid: r.remote_jid,
      });
    }
  }

  merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  return NextResponse.json({
    ok: true,
    entries: merged.slice(-800),
    scrapeFeed: leadsRes.data || [],
  });
}

