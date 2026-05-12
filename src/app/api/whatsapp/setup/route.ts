import { NextRequest, NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";

export async function POST(req: NextRequest) {
  try {
    const { instanceName, appUrl } = await req.json();

    if (!instanceName) {
      return NextResponse.json({ error: "Instance name is required" }, { status: 400 });
    }

    // Se appUrl não for enviado, tenta usar o que está no .env ou na requisição
    let finalAppUrl = appUrl || process.env.NEXT_PUBLIC_APP_URL;

    if (!finalAppUrl) {
       // Se estiver rodando no servidor, podemos tentar inferir a URL da própria requisição
       const host = req.headers.get("host");
       const protocol = host?.includes("localhost") || host?.includes(".app") ? "https" : "http";
       finalAppUrl = `${protocol}://${host}`;
    }

    if (!finalAppUrl) {
      return NextResponse.json({ error: "Não foi possível determinar a APP_URL. Configure no .env.local" }, { status: 400 });
    }

    const webhookUrl = `${finalAppUrl.endsWith("/") ? finalAppUrl.slice(0, -1) : finalAppUrl}/api/webhooks/whatsapp`;

    console.log(`[SETUP-WHATSAPP] Registrando Webhook para '${instanceName}' -> ${webhookUrl}`);

    const result = await evolution.setWebhook(webhookUrl, instanceName);

    return NextResponse.json({
      success: true,
      webhookUrl,
      result
    });
  } catch (err: any) {
    console.error("[SETUP-WHATSAPP] Erro:", err.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
