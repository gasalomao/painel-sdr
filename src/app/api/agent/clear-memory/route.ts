import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

/**
 * Limpa toda a memória de um contato — apaga histórico em ambas tabelas
 * para que a IA volte a conversar do zero, sem contexto algum.
 *
 * Apaga:
 *   - messages (V2)         — fonte do histórico que a IA lê
 *   - chats_dashboard       — fonte do que o painel mostra
 *
 * Reseta na sessão:
 *   - last_message_at = null
 *   - unread_count    = 0
 */
export async function POST(req: NextRequest) {
  // AUTH + OWNERSHIP: cliente só apaga conversas das próprias instâncias.
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;

  try {
    const { remoteJid, instanceName } = await req.json();

    if (!remoteJid || !instanceName) {
      return NextResponse.json({ success: false, error: "Missing remoteJid or instanceName" }, { status: 400 });
    }

    // Verifica ownership da instância (admin pula)
    if (!ctx.isAdmin) {
      const { data: conn } = await supabase
        .from("channel_connections")
        .select("client_id")
        .eq("instance_name", instanceName)
        .maybeSingle();
      if (!conn || conn.client_id !== ctx.clientId) {
        return NextResponse.json({ success: false, error: "Instância não pertence à sua conta" }, { status: 403 });
      }
    }

    // 1. Encontrar contato
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("remote_jid", remoteJid)
      .maybeSingle();

    let v2Deleted = 0;
    if (contact?.id) {
      // 2. Encontrar sessão deste contato nesta instância
      const { data: session } = await supabase
        .from("sessions")
        .select("id")
        .eq("contact_id", contact.id)
        .eq("instance_name", instanceName)
        .maybeSingle();

      if (session?.id) {
        // 3. Apagar mensagens V2 (que a IA lê como histórico)
        const { error: v2Err, count } = await supabase
          .from("messages")
          .delete({ count: "exact" })
          .eq("session_id", session.id);
        if (v2Err) console.warn("[CLEAR_MEMORY] V2 delete:", v2Err.message);
        v2Deleted = count || 0;

        // 4. Resetar marcadores de atividade na sessão
        await supabase
          .from("sessions")
          .update({ 
            last_message_at: null, 
            unread_count: 0,
            variables: '{}',
            current_stage_id: null
          })
          .eq("id", session.id);
      }
    }

    // 5. Apagar do legado chats_dashboard (visualização do painel)
    const { error: legacyErr, count: legacyCount } = await supabase
      .from("chats_dashboard")
      .delete({ count: "exact" })
      .eq("remote_jid", remoteJid)
      .eq("instance_name", instanceName);

    if (legacyErr) {
      console.error("[CLEAR_MEMORY] Erro ao apagar chats_dashboard:", legacyErr);
      return NextResponse.json({ success: false, error: legacyErr.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      v2Deleted,
      legacyDeleted: legacyCount || 0,
      message: "Memória limpa. A IA não tem mais contexto deste contato.",
    });
  } catch (err: any) {
    console.error("[CLEAR_MEMORY] Fatal:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
