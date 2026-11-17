import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { CONVERSATION_SELECT } from "@/lib/inbox/conversations";

export const dynamic = "force-dynamic";

/**
 * GET /api/inbox/conversations?mode=full|poll
 *
 * Carrega conversas (`sessions` + preview de `chats_dashboard`) escopadas ao tenant.
 * Em `mode=full` (padrão), também devolve `kanban_columns` e `leads_extraidos` para filtro.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const mode = req.nextUrl.searchParams.get("mode") === "poll" ? "poll" : "full";

  const sessionsPromise = supabaseAdmin
    .from("sessions")
    .select(CONVERSATION_SELECT)
    .eq("client_id", auth.clientId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(100);

  const msgsPromise = supabaseAdmin
    .from("chats_dashboard")
    .select("remote_jid, content, created_at, media_type, media_url")
    .eq("client_id", auth.clientId)
    .order("created_at", { ascending: false })
    .limit(600);

  if (mode === "poll") {
    const [sessionsRes, msgsRes] = await Promise.all([sessionsPromise, msgsPromise]);
    if (sessionsRes.error) {
      console.error("[inbox/conversations] poll error:", sessionsRes.error.message);
      return NextResponse.json({ ok: false, error: "Falha ao carregar conversas" }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      sessions: sessionsRes.data || [],
      messages: msgsRes.data || [],
    });
  }

  const colsPromise = supabaseAdmin
    .from("kanban_columns")
    .select("id, status_key, label, color, order_index")
    .eq("client_id", auth.clientId)
    .order("order_index");

  const leadsPromise = supabaseAdmin
    .from("leads_extraidos")
    .select("id, remoteJid, telefone, nome_negocio, status, photos, created_at")
    .eq("client_id", auth.clientId)
    .order("created_at", { ascending: false })
    .limit(2000);

  const [sessionsRes, msgsRes, colsRes, leadsRes] = await Promise.all([
    sessionsPromise,
    msgsPromise,
    colsPromise,
    leadsPromise,
  ]);

  if (sessionsRes.error) {
    console.error("[inbox/conversations] full error:", sessionsRes.error.message);
    return NextResponse.json({ ok: false, error: "Falha ao carregar conversas" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    sessions: sessionsRes.data || [],
    messages: msgsRes.data || [],
    columns: colsRes.data || [],
    leads: leadsRes.data || [],
  });
}

