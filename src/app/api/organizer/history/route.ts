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

  // historico_ia_leads não tem client_id direto — fazemos lookup pelo remote_jid
  // → leads_extraidos.client_id. Pra performance, pegamos primeiro os JIDs do
  // cliente e filtramos o histórico por esses JIDs.
  let myJids: string[] | null = null;
  if (!ctx.isAdmin) {
    const { data: leads } = await supabaseAdmin
      .from("leads_extraidos")
      .select("remoteJid")
      .eq("client_id", ctx.clientId)
      .limit(5000);
    myJids = (leads || []).map((l: any) => l.remoteJid).filter(Boolean);
    if (myJids.length === 0) {
      return NextResponse.json({ ok: true, history: [], runs: [] });
    }
  }

  let histQ = supabaseAdmin
    .from("historico_ia_leads")
    .select("id, remote_jid, nome_negocio, status_antigo, status_novo, razao, resumo, batch_id, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (myJids) histQ = histQ.in("remote_jid", myJids);

  // Em paralelo: últimas runs (admin vê todas; cliente também — runs são globais).
  const runsP = supabaseAdmin
    .from("ai_organizer_runs")
    .select("id, batch_id, triggered_by, started_at, finished_at, duration_ms, model, chats_analyzed, leads_moved, status, summary")
    .order("started_at", { ascending: false })
    .limit(20);

  const [{ data: history, error: histErr }, { data: runs }] = await Promise.all([histQ, runsP]);
  if (histErr) return NextResponse.json({ ok: false, error: histErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, history: history || [], runs: runs || [] });
}
