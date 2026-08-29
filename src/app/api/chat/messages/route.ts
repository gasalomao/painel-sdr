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
  
  try {
    const body = await req.json().catch(() => ({}));
    const { messageIds, conversationId } = body as {
      messageIds?: string[];
      conversationId?: string;
    };

    // SECURITY: escopo vem SÓ da sessão autenticada — clientId do body é
    // dado do atacante, nunca autoridade de tenant.
    if (!session?.clientId) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
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

      // 1. Buscar as sessões correspondentes sem disparar erro de sintaxe UUID no Postgres
      let sessionsQuery = supabase
        .from("sessions")
        .select("id, remote_jid, contact_id, contact:contacts(id, phone_number, remote_jid)")
        .eq("client_id", targetClientId);

      if (isUuid) {
        sessionsQuery = sessionsQuery.or(`id.eq.${conversationId},remote_jid.in.(${initialJids.map((j) => `"${j}"`).join(",")})`);
      } else {
        sessionsQuery = sessionsQuery.in("remote_jid", initialJids);
      }

      const { data: sessionRows, error: sErr } = await sessionsQuery;
      if (sErr) {
        console.error("[chat/messages] error querying sessions:", sErr.message);
      }

      const contactIdsSet = new Set<string>();

      if (sessionRows && sessionRows.length > 0) {
        for (const sRow of sessionRows) {
          if (sRow.remote_jid) jidSet.add(sRow.remote_jid);
          if (sRow.contact_id) contactIdsSet.add(sRow.contact_id);

          const contact = sRow.contact as any;
          if (contact?.id) contactIdsSet.add(contact.id);
          if (contact?.remote_jid) jidSet.add(contact.remote_jid);
          if (contact?.phone_number) {
            const rawPhone = contact.phone_number.replace(/\D/g, "");
            if (rawPhone) {
              jidSet.add(rawPhone);
              jidSet.add(`${rawPhone}@s.whatsapp.net`);
              jidSet.add(`${rawPhone}@c.us`);
              jidSet.add(`phone:${rawPhone}`);
            }
          }
        }
      }

      // 2. Se houver telefone, buscar também os contatos correspondentes no banco
      if (cleanPhone && cleanPhone.length >= 8) {
        const { data: matchedContacts } = await supabase
          .from("contacts")
          .select("id, remote_jid, phone_number")
          .eq("client_id", targetClientId)
          .or(`phone_number.ilike.%${cleanPhone}%,remote_jid.ilike.%${cleanPhone}%`);

        if (matchedContacts) {
          for (const c of matchedContacts) {
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
          }
        }
      }

      const allJids = Array.from(jidSet).filter(Boolean);
      const allContactIds = Array.from(contactIdsSet).filter(Boolean);

      // 3. Deleta TODAS as mensagens do chats_dashboard pelas variações de JID
      if (allJids.length > 0) {
        const { error: errMsgs } = await supabase
          .from("chats_dashboard")
          .delete()
          .eq("client_id", targetClientId)
          .in("remote_jid", allJids);

        if (errMsgs) {
          console.error("[chat/messages] delete messages error:", errMsgs.message);
        }
      }

      // 4. Deleta TODAS as sessões por remote_jid
      if (allJids.length > 0) {
        const { error: errSessJid } = await supabase
          .from("sessions")
          .delete()
          .eq("client_id", targetClientId)
          .in("remote_jid", allJids);

        if (errSessJid) {
          console.error("[chat/messages] delete sessions by jid error:", errSessJid.message);
        }
      }

      // 5. Deleta TODAS as sessões por contact_id
      if (allContactIds.length > 0) {
        const { error: errSessContact } = await supabase
          .from("sessions")
          .delete()
          .eq("client_id", targetClientId)
          .in("contact_id", allContactIds);

        if (errSessContact) {
          console.error("[chat/messages] delete sessions by contact_id error:", errSessContact.message);
        }
      }

      // 6. Deleta a sessão especificamente por ID se for UUID
      if (isUuid) {
        await supabase
          .from("sessions")
          .delete()
          .eq("client_id", targetClientId)
          .eq("id", conversationId);
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
