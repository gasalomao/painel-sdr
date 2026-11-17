import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Calcula início do dia atual e próximo dia no fuso America/Sao_Paulo (-03:00),
 * evitando deslocamento de métricas diárias em servidores UTC.
 */
function resolveDayWindowIso(now = new Date()): { startIso: string; endIso: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  const start = new Date(`${dateStr}T00:00:00-03:00`);
  const end = new Date(start.getTime() + 86_400_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * GET /api/dashboard/summary
 * Substitui as 9 queries diretas do cliente Supabase em `/` por uma agregação BFF única
 * escopada estritamente por `auth.clientId`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ success: false, error: "Banco de dados indisponível" }, { status: 500 });
  }

  try {
    const { startIso, endIso } = resolveDayWindowIso();
    const clientId = auth.clientId;

    const [
      totalLeadsRes,
      leadsTodayRes,
      conversationsTodayRes,
      appointmentsTodayRes,
      onlineInstancesRes,
      campaignsRes,
      followUpsRes,
      aiTodayRes,
      recentLeadsRes,
    ] = await Promise.all([
      supabaseAdmin
        .from("leads_extraidos")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId),
      supabaseAdmin
        .from("leads_extraidos")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId)
        .gte("created_at", startIso),
      supabaseAdmin
        .from("chats_dashboard")
        .select("remote_jid")
        .eq("client_id", clientId)
        .gte("created_at", startIso)
        .limit(2000),
      supabaseAdmin
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId)
        .gte("start_at", startIso)
        .lt("start_at", endIso)
        .in("status", ["confirmed", "tentative"]),
      supabaseAdmin
        .from("channel_connections")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("status", "open"),
      supabaseAdmin
        .from("campaigns")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId)
        .in("status", ["running", "sending"]),
      supabaseAdmin
        .from("followup_campaigns")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId)
        .in("status", ["running", "sending"]),
      supabaseAdmin
        .from("chats_dashboard")
        .select("*", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("sender_type", "ai")
        .gte("created_at", startIso),
      supabaseAdmin
        .from("leads_extraidos")
        .select("id, nome_negocio, ramo_negocio, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(6),
    ]);

    const conversasHoje = new Set(
      ((conversationsTodayRes.data || []) as Array<{ remote_jid?: string }>)
        .map((c) => c.remote_jid)
        .filter(Boolean),
    ).size;

    return NextResponse.json({
      success: true,
      metrics: {
        totalLeads: totalLeadsRes.count || 0,
        leadsHoje: leadsTodayRes.count || 0,
        conversasHoje,
        agendamentosHoje: appointmentsTodayRes.count || 0,
        instanciasOnline: onlineInstancesRes.count || 0,
        disparosAtivos: campaignsRes.count || 0,
        followUpCampanhas: followUpsRes.count || 0,
        iaInteracoesHoje: aiTodayRes.count || 0,
      },
      recentLeads: recentLeadsRes.data || [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao carregar resumo do dashboard";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

