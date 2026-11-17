import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

/**
 * DELETE /api/chat/messages
 * Body: { messageIds?: string[], conversationId?: string, clientId: string }
 * - messageIds: apaga mensagens específicas de uma conversa
 * - conversationId: apaga TODAS as mensagens da conversa + a sessão
 *
 * Auth: verifySession (JWT cookie). RLS scoping via client_id.
 */
export async function DELETE(req: NextRequest) {
  const session = await requireClientId(req);

  try {
    const body = await req.json().catch(() => ({}));
    const { messageIds, conversationId } = body as {
      messageIds?: string[];
      conversationId?: string;
    };

    // SECURITY: escopo vem SÓ da sessão autenticada e ativa — clientId do body é
    // dado do atacante, nunca autoridade de tenant.
    if (!session.ok) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }
    if (!supabase) {
      return NextResponse.json({ error: "DB indisponível" }, { status: 500 });
    }
    const targetClientId = session.clientId;

    if (!messageIds?.length && !conversationId) {
      return NextResponse.json(
        { error: "messageIds ou conversationId obrigatório" },
        { status: 400 }
      );
    }

    // Caso 1: deletar conversa inteira (mensagens + sessão)
    if (conversationId && !messageIds?.length) {
      const cleanPhone = conversationId.replace(/\D/g, "");
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId);

      const jidSet = new Set<string>();
      if (conversationId) jidSet.add(conversationId);
      if (cleanPhone) {
        jidSet.add(cleanPhone);
        jidSet.add(`${cleanPhone}@s.whatsapp.net`);
        jidSet.add(`${cleanPhone}@c.us`);
        jidSet.add(`phone:${cleanPhone}`);
      }

      const initialJids = Array.from(jidSet);
      const contactIdsSet = new Set<string>();
      const sessionIdsSet = new Set<string>();

      const addContactVariations = (c: { id?: string | null; remote_jid?: string | null; phone_number?: string | null }) => {
        if (c.id) contactIdsSet.add(c.id);
        if (c.remote_jid) jidSet.add(c.remote_jid);
        if (c.phone_number) {
          const rawPhone = c.phone_number.replace(/\D/g, "");
          if (rawPhone) {
            jidSet.add(rawPhone);
            jidSet.add(`${rawPhone}@s.whatsapp.net`);
            jidSet.add(`${rawPhone}@c.us`);
            jidSet.add(`phone:${rawPhone}`);
          }
        }
      };

      // 1. Buscar contatos exatos pelo JID (sessions não possui coluna remote_jid; o vínculo fica em contacts)
      if (initialJids.length > 0) {
        const { data: exactContacts, error: cErr } = await supabase
          .from("contacts")
          .select("id, remote_jid, phone_number")
          .eq("client_id", targetClientId)
          .in("remote_jid", initialJids);
        if (cErr) {
          console.error("[chat/messages] error querying contacts by jid:", cErr.message);
        }
        for (const c of exactContacts || []) addContactVariations(c);
      }

      // 2. Se houver telefone, buscar também contatos equivalentes por phone_number / ilike
      if (cleanPhone && cleanPhone.length >= 8) {
        const { data: matchedContacts } = await supabase
          .from("contacts")
          .select("id, remote_jid, phone_number")
          .eq("client_id", targetClientId)
          .or(`phone_number.ilike.%${cleanPhone}%,remote_jid.ilike.%${cleanPhone}%`);
        for (const c of matchedContacts || []) addContactVariations(c);
      }

      // 3. Se conversationId for UUID, buscar sessão pelo ID válido (e coletar contato vinculado)
      if (isUuid) {
        sessionIdsSet.add(conversationId);
        const { data: sessionById, error: sErr } = await supabase
          .from("sessions")
          .select("id, contact_id, contact:contacts(id, phone_number, remote_jid)")
          .eq("client_id", targetClientId)
          .eq("id", conversationId)
          .maybeSingle();
        if (sErr) {
          console.error("[chat/messages] error querying session by id:", sErr.message);
        }
        if (sessionById) {
          if (sessionById.contact_id) contactIdsSet.add(sessionById.contact_id);
          const contact = sessionById.contact as { id?: string; phone_number?: string; remote_jid?: string } | null;
          if (contact) addContactVariations(contact);
        }
      }

      const allContactIds = Array.from(contactIdsSet).filter(Boolean);
      if (allContactIds.length > 0) {
        const { data: contactSessions } = await supabase
          .from("sessions")
          .select("id")
          .eq("client_id", targetClientId)
          .in("contact_id", allContactIds);
        for (const s of Array.isArray(contactSessions) ? contactSessions : []) {
          if (s.id) sessionIdsSet.add(s.id);
        }
      }

      const allJids = Array.from(jidSet).filter(Boolean);
      const allSessionIds = Array.from(sessionIdsSet).filter(Boolean);

      // 4. Deleta mensagens em chats_dashboard e messages (V2) dentro do tenant
      if (allJids.length > 0) {
        const { error: errMsgs } = await supabase
          .from("chats_dashboard")
          .delete()
          .eq("client_id", targetClientId)
          .in("remote_jid", allJids);
        if (errMsgs) {
          console.error("[chat/messages] delete chats_dashboard error:", errMsgs.message);
          return NextResponse.json({ error: "Falha ao apagar histórico de mensagens" }, { status: 500 });
        }
      }

      if (allSessionIds.length > 0) {
        const { error: errV2 } = await supabase
          .from("messages")
          .delete()
          .eq("client_id", targetClientId)
          .in("session_id", allSessionIds);
        if (errV2) {
          console.error("[chat/messages] delete messages v2 error:", errV2.message);
        }
      }

      // 5. Deleta sessões por contact_id e/ou id dentro do tenant
      if (allContactIds.length > 0) {
        const { error: errSessContact } = await supabase
          .from("sessions")
          .delete()
          .eq("client_id", targetClientId)
          .in("contact_id", allContactIds);
        if (errSessContact) {
          console.error("[chat/messages] delete sessions by contact_id error:", errSessContact.message);
          return NextResponse.json({ error: "Falha ao apagar sessões da conversa" }, { status: 500 });
        }
      }

      if (isUuid) {
        const { error: errSessId } = await supabase
          .from("sessions")
          .delete()
          .eq("client_id", targetClientId)
          .eq("id", conversationId);
        if (errSessId) {
          console.error("[chat/messages] delete session by id error:", errSessId.message);
          return NextResponse.json({ error: "Falha ao apagar sessão" }, { status: 500 });
        }
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
      .eq("client_id", targetClientId)
      .in("id", ids);

    if (error) {
      console.error("[chat/messages] delete error:", error.message);
      return NextResponse.json({ error: "Falha ao apagar mensagens" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      deleted: { messageIds: ids, scope: "messages" },
    });
  } catch (err) {
    console.error("[chat/messages] API error:", err);
    return NextResponse.json(
      { error: "Erro interno ao apagar mensagens" },
      { status: 500 }
    );
  }
}
