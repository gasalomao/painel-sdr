import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/organizer/history?limit=50
 *
 * Retorna histórico de movimentações que o Organizador IA fez nos leads
 * do cliente atual. Junta historico_ia_leads (uma linha por mudança) com
 * leads_extraidos (pra trazer nome/telefone).
 *
 * Cliente vê só os próprios; admin vê tudo.
 *
 * Estrutura cada item:
 *  { id, remote_jid, nome_negocio, status_antigo, status_novo, razao, resumo, batch_id, created_at }
 */
export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 50), 200);

  let histQ = supabaseAdmin
    .from("historico_ia_leads")
    .select("id, remote_jid, nome_negocio, status_antigo, status_novo, razao, resumo, batch_id, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!ctx.isAdmin) histQ = histQ.eq("client_id", ctx.clientId);

  let runsQ = supabaseAdmin
    .from("ai_organizer_runs")
    .select("id, batch_id, triggered_by, started_at, finished_at, duration_ms, model, chats_analyzed, leads_moved, status, summary")
    .order("started_at", { ascending: false })
    .limit(20);
  if (!ctx.isAdmin) runsQ = runsQ.eq("client_id", ctx.clientId);

  const [{ data: history, error: histErr }, { data: runs }] = await Promise.all([histQ, runsQ]);
  if (histErr) return NextResponse.json({ ok: false, error: histErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, history: history || [], runs: runs || [] });
}

/**
 * DELETE /api/organizer/history          → apaga TODO o histórico do cliente atual
 * DELETE /api/organizer/history?id=123   → apaga só esse item (com ownership check)
 *
 * Cliente só apaga o próprio; admin apaga qualquer (do sistema todo se sem id).
 */
export async function DELETE(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const idParam = req.nextUrl.searchParams.get("id");

  if (idParam) {
    const id = Number(idParam);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ ok: false, error: "id inválido" }, { status: 400 });
    }
    let q = supabaseAdmin.from("historico_ia_leads").delete().eq("id", id);
    if (!ctx.isAdmin) q = q.eq("client_id", ctx.clientId);
    const { data, error } = await q.select("id");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, deleted: data?.length ?? 0 });
  }

  let q = supabaseAdmin.from("historico_ia_leads").delete();
  if (!ctx.isAdmin) q = q.eq("client_id", ctx.clientId);
  else q = q.gte("id", 0);
  const { data, error } = await q.select("id");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: data?.length ?? 0 });
}
