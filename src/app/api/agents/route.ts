/**
 * /api/agents  GET
 *
 * Lista os agentes do TENANT atual. Mesmo admin não-impersonando vê só os
 * próprios — ele também é um tenant (tem client_id próprio). Pra ver agentes
 * de OUTRO cliente, admin deve impersonar.
 *
 * Apenas com ?scope=all (admin não-impersonando) o endpoint devolve agentes
 * de todos os tenants — usado por dashboards admin específicos.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { hasCalendarConnected } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  // SaaS: sempre escopado pelo client_id do usuário logado. Admin precisa
  // explicitar ?scope=all pra ver agentes de outros tenants — não é o default
  // porque os selects do UI (ex: conectar Google, criar appointment) precisam
  // mostrar SÓ os agentes do tenant atual mesmo logado como admin.
  const scope = req.nextUrl.searchParams.get("scope");
  const wantAll = scope === "all" && auth.isAdmin;

  let q = supabaseAdmin
    .from("agent_settings")
    .select("id, client_id, name, role, is_active, is_scheduler, scheduler_config, options")
    .order("id", { ascending: true });
  if (!wantAll) q = q.eq("client_id", auth.clientId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Enriquecimento: flag google_connected — útil pra UI decidir mostrar
  // o "✓" no select. NÃO faz request de rede (apenas checa se tem refresh_token).
  const enriched = await Promise.all((data || []).map(async (a: any) => {
    let google_connected = false;
    let google_email: string | null = null;
    try {
      const c = await hasCalendarConnected(a.id);
      google_connected = c.connected;
      google_email = c.email || null;
    } catch { /* ignora */ }
    return {
      id: a.id,
      client_id: a.client_id,
      name: a.name,
      role: a.role,
      is_active: a.is_active,
      is_scheduler: !!a.is_scheduler,
      scheduler_config: a.scheduler_config || null,
      google_connected,
      google_email,
    };
  }));

  return NextResponse.json({ ok: true, agents: enriched });
}
