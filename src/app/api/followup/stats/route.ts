import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

/**
 * GET /api/followup/stats?agent_id=X
 *
 * Retorna estatísticas de follow-ups para um agente específico.
 * Multi-tenant: só retorna dados do client_id do usuário logado.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    const clientId = ctx.clientId;
    const agentId = req.nextUrl.searchParams.get("agent_id") || "";
    if (!/^[1-9]\d*$/.test(agentId) || !Number.isSafeInteger(Number(agentId))) {
      return NextResponse.json({ error: "agent_id deve ser um inteiro positivo" }, { status: 400 });
    }
    if (!supabaseAdmin) throw new Error("Banco administrativo não configurado.");
    const supabase = supabaseAdmin;

    // Verifica se agente pertence ao cliente
    const { data: agent } = await supabase
      .from("agent_settings")
      .select("id, name")
      .eq("id", Number(agentId))
      .eq("client_id", clientId)
      .single();

    if (!agent) {
      return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
    }

    // Busca estatísticas
    const { data: followups, error } = await supabase
      .from("agent_followups")
      .select("status, current_step, created_at, next_send_at")
      .eq("agent_id", Number(agentId))
      .eq("client_id", clientId);

    if (error) throw error;

    // Calcula métricas
    const total = followups?.length || 0;
    const pending = followups?.filter(f => f.status === "pending").length || 0;
    const sent = followups?.filter(f => f.status === "sent").length || 0;
    const completed = followups?.filter(f => f.status === "completed").length || 0;
    const cancelled = followups?.filter(f => f.status === "cancelled").length || 0;
    const failed = followups?.filter(f => f.status === "failed").length || 0;

    // Métricas por step
    const byStep = {
      step_1: followups?.filter(f => f.current_step === 1).length || 0,
      step_2: followups?.filter(f => f.current_step === 2).length || 0,
      step_3: followups?.filter(f => f.current_step === 3).length || 0,
      step_4: followups?.filter(f => f.current_step === 4).length || 0,
    };

    // Próximos agendados (próximas 24h)
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const nextScheduled = followups?.filter(f =>
      f.status === "pending" &&
      new Date(f.next_send_at) <= tomorrow
    ).length || 0;

    // Taxa de conversão (leads que responderam = cancelados)
    const conversionRate = total > 0 ? ((cancelled / total) * 100).toFixed(1) : "0.0";

    return NextResponse.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
      },
      stats: {
        total,
        pending,
        sent,
        completed,
        cancelled,
        failed,
        nextScheduled,
        conversionRate: `${conversionRate}%`,
      },
      byStep,
    });

  } catch {
    console.error("[FOLLOWUP STATS] Falha ao consultar estatísticas.");
    return NextResponse.json({ success: false, error: "Não foi possível carregar as estatísticas de follow-up." }, { status: 500 });
  }
}
