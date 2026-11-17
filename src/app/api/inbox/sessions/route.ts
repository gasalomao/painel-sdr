import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const ALLOWED_BOT_STATUSES = new Set(["bot_active", "bot_paused", "closed"]);

/**
 * GET /api/inbox/sessions?session_id=...&contact_id=...
 * Lê `agent_id` e `instance_name` da sessão no escopo do tenant autenticado.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const sp = req.nextUrl.searchParams;
  const sessionId = (sp.get("session_id") || "").trim();
  const contactId = (sp.get("contact_id") || "").trim();
  if (!sessionId && !contactId) {
    return NextResponse.json({ ok: false, error: "session_id ou contact_id obrigatório" }, { status: 400 });
  }

  let query = supabaseAdmin
    .from("sessions")
    .select("agent_id, instance_name")
    .eq("client_id", auth.clientId);

  query = sessionId
    ? query.eq("id", sessionId)
    : query
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1);

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error("[inbox/sessions/GET] Erro:", error.message);
    return NextResponse.json({ ok: false, error: "Falha ao consultar sessão" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, session: data || null });
}

/**
 * PATCH /api/inbox/sessions
 * Atualiza estado permitido (`unread_count`, `bot_status`, `agent_id`) para `sessionId`
 * ou `contactId` estritamente no escopo do `client_id` autenticado.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    contactId?: unknown;
    unread_count?: unknown;
    bot_status?: unknown;
    agent_id?: unknown;
  };
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
  if (!sessionId && !contactId) {
    return NextResponse.json({ ok: false, error: "sessionId ou contactId é obrigatório" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.unread_count === "number" && Number.isFinite(body.unread_count) && body.unread_count >= 0) {
    patch.unread_count = Math.trunc(body.unread_count);
  }
  if (typeof body.bot_status === "string") {
    if (!ALLOWED_BOT_STATUSES.has(body.bot_status)) {
      return NextResponse.json({ ok: false, error: "bot_status inválido" }, { status: 400 });
    }
    patch.bot_status = body.bot_status;
  }
  if ("agent_id" in body) {
    if (body.agent_id === null) {
      patch.agent_id = null;
    } else if (typeof body.agent_id === "number" && Number.isFinite(body.agent_id) && body.agent_id > 0) {
      const agentId = Math.trunc(body.agent_id);
      const { data: agentRow } = await supabaseAdmin
        .from("agent_settings")
        .select("id, client_id")
        .eq("id", agentId)
        .maybeSingle();
      if (!agentRow || agentRow.client_id !== auth.clientId) {
        return NextResponse.json({ ok: false, error: "Agente não encontrado neste tenant" }, { status: 404 });
      }
      patch.agent_id = agentId;
    } else {
      return NextResponse.json({ ok: false, error: "agent_id inválido" }, { status: 400 });
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nenhum campo válido para atualizar" }, { status: 400 });
  }

  let query = supabaseAdmin.from("sessions").update(patch).eq("client_id", auth.clientId);
  query = sessionId ? query.eq("id", sessionId) : query.eq("contact_id", contactId);

  const { error } = await query;
  if (error) {
    console.error("[inbox/sessions/PATCH] Erro:", error.message);
    return NextResponse.json({ ok: false, error: "Falha ao atualizar sessão" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
