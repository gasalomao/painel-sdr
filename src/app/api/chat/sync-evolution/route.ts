import { NextRequest, NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";
import { supabase } from "@/lib/supabase";

/**
 * Sync messages directly from Evolution API to Supabase
 * Captura TODAS as mensagens (enviadas e recebidas) incluindo as da IA
 */
export async function POST(req: NextRequest) {
  try {
    const { remoteJid, count = 20 } = await req.json();

    if (!remoteJid) {
      return NextResponse.json({ error: "remoteJid é obrigatório" }, { status: 400 });
    }

    const evoData = await evolution.findMessages(remoteJid, count);
    
    // A Evolution pode retornar em vários formatos
    const messages = evoData?.records || evoData?.messages || (Array.isArray(evoData) ? evoData : []);

    if (!messages.length) {
       return NextResponse.json({ success: true, count: 0, message: "Nenhuma mensagem encontrada." });
    }

    // Verificar quais message_ids já existem no banco para evitar duplicatas
    const msgIds = messages
      .map((msg: any) => msg.key?.id)
      .filter((id: string) => id);
    
    const { data: existingMsgs } = await supabase
      .from("chats_dashboard")
      .select("message_id")
      .in("message_id", msgIds);
    
    const existingIds = new Set((existingMsgs || []).map(m => m.message_id));

    // Reverter para garantir ordem cronológica (mais antiga para mais recente)
    // A Evolution retorna do mais novo para o mais antigo.
    const orderedMessages = [...messages].reverse();

    // Filtrar apenas mensagens novas
    const newMessages = orderedMessages.filter((msg: any) => {
      const id = msg.key?.id;
      return id && !existingIds.has(id);
    });

    if (newMessages.length === 0) {
      return NextResponse.json({ success: true, count: 0, message: "Todas já sincronizadas." });
    }

    console.log(`[SYNC-EVO] ${newMessages.length} mensagens novas para ${remoteJid} (${messages.length} total da API)`);

    const insertData = newMessages.map((msg: any) => {
        const msgObject = msg.message || {};
        
        // Extração robusta de conteúdo — cobre todos os tipos de mensagem
        const messageType = msg.messageType || Object.keys(msgObject).find(k => k !== 'messageContextInfo') || 'conversation';
        const mediaType = messageType?.replace('Message', '');
        const mediaObj = msgObject?.[messageType];
        
        // Conteúdo de texto: tenta múltiplos campos
        const content = msgObject?.conversation 
          || msgObject?.extendedTextMessage?.text 
          || mediaObj?.caption 
          || mediaObj?.text
          || "";
        
        // Determinar sender_type: fromMe pode ser IA ou humano
        // A IA envia via Evolution, então fromMe = true
        const senderType = msg.key?.fromMe ? "ai" : "customer";
        
        return {
            message_id: msg.key?.id,
            remote_jid: msg.key?.remoteJid || remoteJid,
            sender_type: senderType,
            content,
            media_type: (mediaType === "conversation" || mediaType === "extendedText") ? null : mediaType,
            mimetype: mediaObj?.mimetype || null,
            file_name: mediaObj?.fileName || null,
            base64_content: msg.message?.base64 || null,
            media_url: msg.mediaUrl || null,
            status_envio: msg.status || (msg.key?.fromMe ? "sent" : null),
            created_at: msg.messageTimestamp 
              ? new Date(
                  typeof msg.messageTimestamp === 'number' 
                    ? msg.messageTimestamp * 1000 
                    : parseInt(msg.messageTimestamp) * 1000
                ).toISOString() 
              : new Date().toISOString()
        };
    });

    // INSERT ignorando conflitos (mensagens que já existem pelo message_id)
    const { error: insertError } = await supabase
      .from("chats_dashboard")
      .insert(insertData);

    if (insertError) {
       // Se for erro de duplicata, ignorar
       if (insertError.message?.includes('duplicate') || insertError.code === '23505') {
         console.log("[SYNC-EVO] Algumas mensagens duplicadas ignoradas");
       } else {
         console.error("[SYNC-EVO] Supabase Insert Error:", insertError.message);
         throw insertError;
       }
    }

    return NextResponse.json({ 
       success: true, 
       count: insertData.length,
       last_sync: new Date().toISOString()
    });

  } catch (err: any) {
    // Se a Evolution API estiver inacessível, falha silenciosamente
    // O fluxo principal de dados vem do n8n salvando direto no Supabase
    if (err.message?.includes('502') || err.message?.includes('ECONNREFUSED') || err.message?.includes('Not Found') || err.message?.includes('Timeout')) {
      return NextResponse.json({ success: true, count: 0, message: "Evolution API indisponível, usando dados do Supabase." });
    }
    console.error("[SYNC-EVO] Erro Crítico:", err.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
