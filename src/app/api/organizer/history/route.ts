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

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 200), 500);
  const statusNovo = req.nextUrl.searchParams.get("status_novo");

  const scopeToTenant = !ctx.isAdmin || ctx.impersonating;

  let histQ = supabaseAdmin
    .from("historico_ia_leads")
    .select("id, client_id, remote_jid, nome_negocio, status_antigo, status_novo, razao, resumo, batch_id, created_at")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (scopeToTenant) histQ = histQ.eq("client_id", ctx.clientId);
  if (statusNovo && statusNovo !== "all") {
    histQ = histQ.eq("status_novo", statusNovo);
  }

  let runsQ = supabaseAdmin
    .from("ai_organizer_runs")
    .select("id, batch_id, triggered_by, started_at, finished_at, duration_ms, model, provider, chats_analyzed, leads_moved, status, error, summary")
    .order("started_at", { ascending: false })
    .limit(30);
  if (scopeToTenant) runsQ = runsQ.eq("client_id", ctx.clientId);

  const [{ data: history, error: histErr }, { data: runs }] = await Promise.all([histQ, runsQ]);
  if (histErr) {
    console.error("[organizer/history/GET] Erro:", histErr.message);
    return NextResponse.json({ ok: false, error: "Falha ao carregar histórico" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, history: history || [], runs: runs || [] });
}

/**
 * DELETE /api/organizer/history              → apaga TODO o histórico do cliente atual
 * DELETE /api/organizer/history?id=123       → apaga só esse item (com ownership check)
 * DELETE /api/organizer/history?batch_id=xyz → apaga um lote inteiro (ou legacy para NULL)
 */
export async function DELETE(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const idParam = req.nextUrl.searchParams.get("id");
  const batchParam = req.nextUrl.searchParams.get("batch_id");

  if (idParam) {
    const id = Number(idParam);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ ok: false, error: "id inválido" }, { status: 400 });
    }
    const { data, error } = await supabaseAdmin
      .from("historico_ia_leads")
      .delete()
      .eq("id", id)
      .eq("client_id", ctx.clientId)
      .select("id");
    if (error) {
      console.error("[organizer/history/DELETE id] Erro:", error.message);
      return NextResponse.json({ ok: false, error: "Falha ao apagar registro" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, deleted: data?.length ?? 0 });
  }

  if (batchParam) {
    let q = supabaseAdmin
      .from("historico_ia_leads")
      .delete()
      .eq("client_id", ctx.clientId);
    if (batchParam === "legacy") {
      q = q.is("batch_id", null);
    } else {
      q = q.eq("batch_id", batchParam);
    }
    const { data, error } = await q.select("id");
    if (error) {
      console.error("[organizer/history/DELETE batch] Erro:", error.message);
      return NextResponse.json({ ok: false, error: "Falha ao apagar lote do histórico" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, deleted: data?.length ?? 0 });
  }

  const { data, error } = await supabaseAdmin
    .from("historico_ia_leads")
    .delete()
    .eq("client_id", ctx.clientId)
    .select("id");
  if (error) {
    console.error("[organizer/history/DELETE all] Erro:", error.message);
    return NextResponse.json({ ok: false, error: "Falha ao limpar histórico" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted: data?.length ?? 0 });
}
