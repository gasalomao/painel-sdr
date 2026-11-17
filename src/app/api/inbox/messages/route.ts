import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/inbox/messages?jids=...&session_id=...&conversation_id=...&limit=100&poll=0|1
 *
 * Retorna histórico de mensagens da conversa (chats_dashboard com fallback V2 messages)
 * estritamente escopado pelo `client_id` da sessão autenticada.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const sp = req.nextUrl.searchParams;
  const rawJids = sp.get("jids") || "";
  const sessionId = (sp.get("session_id") || "").trim();
  const conversationId = (sp.get("conversation_id") || "").trim();
  const isPoll = sp.get("poll") === "1";
  const parsedLimit = Number(sp.get("limit") || 100);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200) : 100;

  const jids = Array.from(
    new Set(
      rawJids
        .split(",")
        .map((j) => j.trim())
        .filter(Boolean)
        .slice(0, 50),
    ),
  );

  if (jids.length === 0) {
    return NextResponse.json({ ok: true, rows: [], source: "chats_dashboard" });
  }

  const { data: initialData, error } = await supabaseAdmin
    .from("chats_dashboard")
    .select("*")
    .eq("client_id", auth.clientId)
    .in("remote_jid", jids)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[inbox/messages] chats_dashboard error:", error.message);
    return NextResponse.json({ ok: false, error: "Falha ao carregar mensagens" }, { status: 500 });
  }

  if ((!initialData || initialData.length === 0) && sessionId && !isPoll) {
    const { data: v2Msgs, error: v2Err } = await supabaseAdmin
      .from("messages")
      .select("*")
      .eq("client_id", auth.clientId)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (v2Err) {
      console.error("[inbox/messages] messages v2 error:", v2Err.message);
      return NextResponse.json({ ok: false, error: "Falha ao carregar mensagens" }, { status: 500 });
    }

    if (v2Msgs && v2Msgs.length > 0) {
      const mapped = v2Msgs.map((raw: Record<string, unknown>) => ({
        id: raw.id,
        remote_jid: conversationId || jids[0],
        sender_type: raw.sender === "customer" ? "customer" : raw.sender === "ai" ? "ai" : "human",
        content: raw.content || raw.text || "",
        media_type: raw.media_category || raw.media_type,
        media_url: raw.media_url,
        mimetype: raw.mimetype,
        file_name: raw.file_name,
        message_id: raw.message_id,
        status_envio: raw.delivery_status || "sent",
        created_at: raw.created_at,
        is_from_me: raw.sender !== "customer",
      }));
      return NextResponse.json({ ok: true, rows: mapped, source: "messages" });
    }
  }

  return NextResponse.json({ ok: true, rows: initialData || [], source: "chats_dashboard" });
}

