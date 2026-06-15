import { NextRequest, NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";
import { requireClientId, clientIdFromInstance } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { isPrivateOrLocalHost } from "@/lib/url-guard";
import { randomBytes } from "node:crypto";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { instanceName, appUrl } = await req.json();

    if (!instanceName) {
      return NextResponse.json({ error: "Instance name is required" }, { status: 400 });
    }

    // Ownership: cliente só configura webhook da própria instância.
    const owner = await clientIdFromInstance(instanceName);
    if (owner && owner !== auth.clientId) {
      return NextResponse.json({ error: "Instância não pertence a este cliente" }, { status: 403 });
    }

    // appUrl: prioridade body → app_settings.public_url → NEXT_PUBLIC_APP_URL → host header.
    let finalAppUrl: string | null = appUrl || null;
    if (!finalAppUrl && supabaseAdmin) {
      const { data } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", "public_url")
        .maybeSingle();
      if (data?.value) finalAppUrl = String(data.value);
    }
    if (!finalAppUrl) finalAppUrl = process.env.NEXT_PUBLIC_APP_URL || null;
    if (!finalAppUrl) {
      const host = req.headers.get("host");
      const protocol = host?.includes("localhost") || host?.includes(".app") ? "https" : "http";
      finalAppUrl = `${protocol}://${host}`;
    }
    if (!finalAppUrl) {
      return NextResponse.json({ error: "Não foi possível determinar a APP_URL. Configure no .env.local" }, { status: 400 });
    }

    // Em produção, exige HTTPS e bloqueia rede interna — defesa SSRF.
    if (process.env.NODE_ENV === "production") {
      try {
        const u = new URL(finalAppUrl);
        if (u.protocol !== "https:" || isPrivateOrLocalHost(u.hostname)) {
          return NextResponse.json(
            { error: "appUrl deve ser HTTPS pública (sem IPs privados nem localhost)" },
            { status: 400 }
          );
        }
      } catch {
        return NextResponse.json({ error: "appUrl inválida" }, { status: 400 });
      }
    }

    const webhookUrl = `${finalAppUrl.endsWith("/") ? finalAppUrl.slice(0, -1) : finalAppUrl}/api/webhooks/whatsapp`;

    // Gera/reaproveita webhook_secret per-instância e salva em provider_config.
    // Evolution v2 vai mandar X-Webhook-Secret em cada webhook → nosso handler valida.
    let webhookSecret: string | null = null;
    if (supabaseAdmin) {
      try {
        const { data: existing } = await supabaseAdmin
          .from("channel_connections")
          .select("provider_config")
          .eq("instance_name", instanceName)
          .maybeSingle();
        webhookSecret = (existing?.provider_config as any)?.webhook_secret || null;
        if (!webhookSecret) {
          webhookSecret = randomBytes(32).toString("hex");
          const newConfig = { ...((existing?.provider_config as any) || {}), webhook_secret: webhookSecret };
          await supabaseAdmin
            .from("channel_connections")
            .upsert(
              {
                instance_name: instanceName,
                provider: "evolution",
                provider_config: newConfig,
                client_id: auth.clientId,
              },
              { onConflict: "instance_name" }
            );
        }
      } catch (e) {
        console.warn(`[SETUP-WHATSAPP] não persistiu webhook_secret: ${(e as Error).message}`);
        webhookSecret = null;
      }
    }

    console.log(`[SETUP-WHATSAPP] Registrando Webhook para '${instanceName}' -> ${webhookUrl}`);

    const result = await evolution.setWebhook(webhookUrl, instanceName, webhookSecret);

    return NextResponse.json({
      success: true,
      webhookUrl,
      result,
      secured: !!webhookSecret,
    });
  } catch (err: any) {
    console.error("[SETUP-WHATSAPP] Erro:", err.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
