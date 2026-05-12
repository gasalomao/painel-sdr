import { NextRequest, NextResponse } from "next/server";

/**
 * Endpoint de Debug para visualizar exatamente o que o n8n está enviando.
 * Útil para ajustar as variáveis antes de salvar no banco principal.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    console.log("\n========================================");
    console.log("📨 WEBHOOK DEBUG RECEIVED");
    console.log("Timestamp:", new Date().toISOString());
    console.log("Body:", JSON.stringify(body, null, 2));
    console.log("========================================\n");

    return NextResponse.json({ 
      success: true, 
      received: {
        message_id: body.message_id || body.data?.key?.id,
        remote_jid: body.remote_jid || body.data?.key?.remoteJid,
        content: body.content || body.data?.message?.conversation
      },
      raw_body: body 
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: "JSON Inválido" }, { status: 400 });
  }
}
