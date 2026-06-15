import { NextRequest, NextResponse } from "next/server";
import { hasInternalSecret } from "@/lib/internal-auth";

/**
 * Endpoint de Debug para visualizar exatamente o que o n8n está enviando.
 * Protegido por header X-Internal-Secret — não responde a chamadas anônimas
 * em produção (proxy passa /api/webhooks/* sem auth, então o gate é aqui).
 */
export async function POST(req: NextRequest) {
  if (!hasInternalSecret(req)) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }
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
        content: body.content || body.data?.message?.conversation,
      },
      raw_body: body,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: "JSON Inválido" }, { status: 400 });
  }
}
