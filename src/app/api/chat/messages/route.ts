import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifySession } from "@/lib/auth";

/**
 * DELETE /api/chat/messages
 * Body: { messageIds?: string[], conversationId?: string, clientId: string }
 * - messageIds: apaga mensagens específicas de uma conversa
 * - conversationId: apaga TODAS as mensagens da conversa + a sessão
 *
 * Auth: verifySession (JWT cookie). RLS scoping via client_id.
 */
export async function DELETE(req: NextRequest) {
  const session = await verifySession(req);
  if (!session || !session.clientId) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { messageIds, conversationId } = body as {
      messageIds?: string[];
      conversationId?: string;
    };

    if (!messageIds?.length && !conversationId) {
      return NextResponse.json(
        { error: "messageIds ou conversationId obrigatório" },
        { status: 400 }
      );
    }

    // Caso 1: deletar conversa inteira (mensagens + sessão)
    if (conversationId && !messageIds?.length) {
      const { error: errMsgs } = await supabase
        .from("chats_dashboard")
        .delete()
        .eq("client_id", session.clientId)
        .eq("remote_jid", conversationId);

      if (errMsgs) {
        console.error("[chat/messages] delete messages error:", errMsgs.message);
        return NextResponse.json({ error: errMsgs.message }, { status: 500 });
      }

      const { error: errSession } = await supabase
        .from("sessions")
        .delete()
        .eq("client_id", session.clientId)
        .eq("remote_jid", conversationId);

      if (errSession) {
        console.error("[chat/messages] delete session error:", errSession.message);
        // não aborta — mensagens já foram, sessão órfã cleanup depois
      }

      return NextResponse.json({
        success: true,
        deleted: { conversationId, scope: "conversation" },
      });
    }

    // Caso 2: deletar mensagens específicas
    const ids = (messageIds || []).filter(Boolean);
    if (!ids.length) {
      return NextResponse.json({ error: "messageIds vazio" }, { status: 400 });
    }

    const { error } = await supabase
      .from("chats_dashboard")
      .delete()
      .eq("client_id", session.clientId)
      .in("id", ids);

    if (error) {
      console.error("[chat/messages] delete error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      deleted: { messageIds: ids, scope: "messages" },
    });
  } catch (err) {
    console.error("[chat/messages] API error:", err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
