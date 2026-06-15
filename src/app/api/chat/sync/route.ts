import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { hasInternalSecret } from "@/lib/internal-auth";

/**
 * Sync Chat Messages from n8n or External Sources.
 *
 * AUTH: chamada server-to-server (n8n / integração externa) — exige header
 * X-Internal-Secret. Antes era PÚBLICO: qualquer um injetava mensagens
 * forjadas em qualquer tenant.
 */
export async function POST(req: NextRequest) {
  if (!hasInternalSecret(req)) {
    return NextResponse.json({ success: false, error: "Header X-Internal-Secret inválido" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const { 
      remoteJid, type, content, 
      message_id, base64_content, media_url, media_type, 
      mimetype, file_name 
    } = body;

    if (!remoteJid || !type) {
      return NextResponse.json({ 
        success: false, 
        error: "Campos obrigatórios: remoteJid, type" 
      }, { status: 400 });
    }

    // Insert into Chat Dashboard table
    const insertData: Record<string, unknown> = {
      remote_jid: remoteJid,
      sender_type: type,
      content: content || "",
      created_at: new Date().toISOString()
    };

    // Campos opcionais
    if (message_id) insertData.message_id = message_id;
    if (base64_content) insertData.base64_content = base64_content;
    if (media_url) insertData.media_url = media_url;
    if (media_type) insertData.media_type = media_type;
    if (mimetype) insertData.mimetype = mimetype;
    if (file_name) insertData.file_name = file_name;

    const { data, error } = await supabase
      .from("chats_dashboard")
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error("Supabase Sync Error:", error);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("Chat Sync API Error:", err);
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
