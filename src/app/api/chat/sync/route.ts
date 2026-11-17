import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
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
  if (!supabase) {
    return NextResponse.json({ success: false, error: "DB indisponível" }, { status: 500 });
  }
  try {
    const body = await req.json();
    const {
      remoteJid,
      type,
      content,
      message_id,
      base64_content,
      media_url,
      media_type,
      mimetype,
      file_name,
      client_id,
      clientId,
      instance_name,
      instanceName,
    } = body;

    if (!remoteJid || !type) {
      return NextResponse.json(
        {
          success: false,
          error: "Campos obrigatórios: remoteJid, type",
        },
        { status: 400 }
      );
    }

    const explicitClientId = String(client_id || clientId || "").trim();
    const resolvedInstanceName = String(instance_name || instanceName || "").trim();

    let instanceOwnerId: string | null = null;
    if (resolvedInstanceName) {
      const { data: conn } = await supabase
        .from("channel_connections")
        .select("client_id")
        .eq("instance_name", resolvedInstanceName)
        .maybeSingle();
      instanceOwnerId = conn?.client_id ? String(conn.client_id).trim() : null;
    }

    if (explicitClientId && instanceOwnerId && instanceOwnerId !== explicitClientId) {
      return NextResponse.json(
        {
          success: false,
          error: "Instância não pertence ao client_id informado",
        },
        { status: 403 }
      );
    }

    const resolvedClientId = explicitClientId || instanceOwnerId || "";
    if (!resolvedClientId) {
      return NextResponse.json(
        {
          success: false,
          error: "client_id (ou instanceName vinculado) é obrigatório para isolar o tenant",
        },
        { status: 400 }
      );
    }

    // Insert into Chat Dashboard table (sempre escopado pelo tenant)
    const insertData: Record<string, unknown> = {
      client_id: resolvedClientId,
      remote_jid: remoteJid,
      sender_type: type,
      content: content || "",
      created_at: new Date().toISOString(),
    };

    if (resolvedInstanceName) insertData.instance_name = resolvedInstanceName;

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
      console.error("Supabase Sync Error:", error.message);
      return NextResponse.json({ success: false, error: "Falha ao sincronizar mensagem" }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("Chat Sync API Error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Erro interno ao sincronizar chat" }, { status: 500 });
  }
}
