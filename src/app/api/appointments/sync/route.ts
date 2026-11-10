/**
 * /api/appointments/sync  GET ?from=&to=&agent_id=
 *
 * Sincroniza eventos do Google Calendar para `appointments`.
 * Multi-tenant: clientes comuns sincronizam apenas agentes do próprio tenant.
 * Admin sem impersonação pode sincronizar qualquer agente.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { syncGoogleEventsForAgent } from "@/lib/google-calendar-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const params = req.nextUrl.searchParams;
  const from = params.get("from") ? new Date(params.get("from")!) : new Date();
  const to = params.get("to")
    ? new Date(params.get("to")!)
    : new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const agentIdFilter = params.get("agent_id");

  let agentsQuery = supabaseAdmin
    .from("agent_settings")
    .select("id, client_id, name, scheduler_config")
    .eq("is_scheduler", true);
  if (!auth.isAdmin) agentsQuery = agentsQuery.eq("client_id", auth.clientId);
  if (agentIdFilter) agentsQuery = agentsQuery.eq("id", Number(agentIdFilter));

  const { data: agents, error } = await agentsQuery;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!agents?.length) {
    return NextResponse.json({
      ok: true,
      synced: 0,
      agents: [],
      note: "Nenhum agente scheduler com Google conectado pra sincronizar",
    });
  }

  const results = [];
  let totalSynced = 0;

  for (const agent of agents) {
    const result = await syncGoogleEventsForAgent(
      {
        id: agent.id,
        name: agent.name,
        client_id: agent.client_id,
        scheduler_config: agent.scheduler_config,
      },
      from,
      to,
    );
    totalSynced += result.upserted;
    results.push({
      agent_id: agent.id,
      agent_name: agent.name || `agent-${agent.id}`,
      pulled: result.pulled,
      upserted: result.upserted,
      error: result.error,
    });
  }

  return NextResponse.json({
    ok: true,
    synced: totalSynced,
    agents: results,
    from: from.toISOString(),
    to: to.toISOString(),
  });
}
