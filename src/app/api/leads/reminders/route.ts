import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/leads/reminders
 * Retorna contagem e lista de lembretes pendentes/atrasados para o dashboard e header
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 10, 1), 50);

    const nowIso = new Date().toISOString();
    const next24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Executa consultas de atrasados e próximos em paralelo
    const [
      { data: overdue, error: errOverdue, count: overdueCount },
      { data: upcoming, error: errUpcoming, count: upcomingCount },
    ] = await Promise.all([
      supabaseAdmin
        .from("leads_extraidos")
        .select("id, nome_negocio, telefone, ramo_negocio, next_follow_up, observacoes, remoteJid, business_details", { count: "exact" })
        .eq("client_id", auth.clientId)
        .not("next_follow_up", "is", null)
        .lt("next_follow_up", nowIso)
        .order("next_follow_up", { ascending: true })
        .limit(limit),
      supabaseAdmin
        .from("leads_extraidos")
        .select("id, nome_negocio, telefone, ramo_negocio, next_follow_up, observacoes, remoteJid, business_details", { count: "exact" })
        .eq("client_id", auth.clientId)
        .not("next_follow_up", "is", null)
        .gte("next_follow_up", nowIso)
        .lte("next_follow_up", next24h)
        .order("next_follow_up", { ascending: true })
        .limit(limit),
    ]);

    if (errOverdue) {
      return NextResponse.json({ error: errOverdue.message }, { status: 500 });
    }

    if (errUpcoming) {
      return NextResponse.json({ error: errUpcoming.message }, { status: 500 });
    }

    const mapReminder = (lead: NonNullable<typeof overdue>[number]) => ({
      id: lead.id,
      nome_negocio: lead.nome_negocio,
      telefone: lead.telefone,
      ramo_negocio: lead.ramo_negocio,
      next_follow_up: lead.next_follow_up,
      observacoes: lead.observacoes,
      lembrete_texto: lead.business_details?.lembrete_texto || lead.observacoes || "",
      remoteJid: lead.remoteJid,
    });

    const overdueList = (overdue || []).map(mapReminder);
    const upcomingList = (upcoming || []).map(mapReminder);

    return NextResponse.json({
      totalOverdue: overdueCount ?? overdueList.length,
      totalUpcomingToday: upcomingCount ?? upcomingList.length,
      overdue: overdueList,
      upcomingToday: upcomingList,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erro interno" }, { status: 500 });
  }
}
