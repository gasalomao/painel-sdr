import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { evolution } from "@/lib/evolution";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

export const dynamic = 'force-dynamic';

/**
 * GET - Lista o webhook configurado na instância
 * POST - Registra/atualiza o webhook na Evolution API
 */

export async function GET(req: NextRequest) {
  try {
    const instanceName = req.nextUrl.searchParams.get("instance") || evolution.instanceName || "sdr";

    // Evolution API v2: GET /webhook/find/{instance}
    const EVO_URL = process.env.EVOLUTION_API_URL;
    const EVO_KEY = process.env.EVOLUTION_API_KEY;

    if (!EVO_URL || EVO_URL.includes("url_aqui")) {
      return NextResponse.json({ success: false, error: "EVOLUTION_API_URL não configurada no .env.local" });
    }

    const res = await fetch(`${EVO_URL}/webhook/find/${instanceName}`, {
      headers: { apikey: EVO_KEY || "" }
    });

    const data = await res.json();
    return NextResponse.json({ success: true, webhook: data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { instanceName, appUrl, agentId } = await req.json();

    const instance = instanceName || evolution.instanceName || "sdr";

    // Prioridade para buscar URL pública (ao clicar "Sincronizar Agora"):
    //   1. appUrl enviado pelo front-end (geralmente window.location.origin → o
    //      domínio que o usuário está acessando AGORA, é o mais correto)
    //   2. Banco de dados (app_settings.public_url)
    //   3. .env.local (NEXT_PUBLIC_APP_URL)
    // O front-end sempre manda window.location.origin se não tiver appUrl, então
    // dar prioridade pro frontend garante que o webhook fica com a URL atual da
    // tela — exatamente o que o user espera ao clicar "Sincronizar".
    let url: string = "";

    if (appUrl && !appUrl.includes("localhost")) {
      url = appUrl;
    }

    if (!url) {
      try {
        const { data: setting } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "public_url")
          .single();
        if (setting?.value && !setting.value.includes("localhost")) {
          url = setting.value;
        }
      } catch {}
    }

    if (!url) {
      const envAppUrl = process.env.NEXT_PUBLIC_APP_URL;
      if (envAppUrl && !envAppUrl.includes("localhost")) {
        url = envAppUrl;
      }
    }

    // Último recurso
    if (!url) {
      return NextResponse.json({
        success: false,
        error: "Nenhuma URL pública configurada. Configure NEXT_PUBLIC_APP_URL no .env (ex: https://seu-dominio.easypanel.host) ou salve uma URL pública em Configurações."
      }, { status: 400 });
    }

    // Normaliza a URL (Remove barra final se existir)
    const baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;

    // Persiste a URL efetiva — assim a próxima abertura do painel já sabe qual é
    // a URL pública atual sem o user precisar clicar em Salvar em outro canto.
    // (a) app_settings.public_url — fonte global usada por outras rotas
    try {
      await supabase.from("app_settings").upsert(
        { key: "public_url", value: baseUrl, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    } catch (e) {
      console.warn("[register] não consegui persistir app_settings.public_url:", (e as Error).message);
    }
    // (b) agent_settings.options.app_url — fonte usada pela aba do Agente
    if (agentId) {
      try {
        const { data: agent } = await supabase
          .from("agent_settings")
          .select("options")
          .eq("id", agentId)
          .single();
        const newOptions = { ...((agent?.options as any) || {}), app_url: baseUrl };
        await supabase.from("agent_settings").update({ options: newOptions }).eq("id", agentId);
      } catch (e) {
        console.warn("[register] não consegui persistir agent_settings.options.app_url:", (e as Error).message);
      }
    }

    // Identifica o provider — Evolution registra webhook por instância na própria Evolution;
    // Cloud é só sanity check + WABA subscribe (a Callback URL é registrada no Meta App).
    const { data: chRow } = await supabase
      .from("channel_connections")
      .select("provider, provider_config")
      .eq("instance_name", instance)
      .maybeSingle();

    const provider = chRow?.provider || "evolution";

    if (provider === "whatsapp_cloud") {
      const cfg = chRow?.provider_config || {};
      const webhookUrl = `${baseUrl}/api/webhooks/whatsapp-cloud`;

      if (!cfg.access_token) {
        return NextResponse.json({
          success: false,
          error: "Conexão Cloud sem access_token. Configure em /whatsapp.",
        }, { status: 400 });
      }

      // Tenta assinar o WABA no App Meta (necessário pra eventos chegarem)
      let subscribed = false;
      let subDetail = "";
      if (cfg.business_account_id) {
        try {
          await axios.post(
            `https://graph.facebook.com/${cfg.graph_version || "v21.0"}/${cfg.business_account_id}/subscribed_apps`,
            {},
            { headers: { Authorization: `Bearer ${cfg.access_token}` }, timeout: 15000 }
          );
          subscribed = true;
        } catch (e: any) {
          subDetail = e?.response?.data?.error?.message || e.message;
        }
      } else {
        subDetail = "Forneça business_account_id pra eu assinar o WABA automático.";
      }

      return NextResponse.json({
        success: true,
        provider: "whatsapp_cloud",
        webhookUrl,
        appUrl: baseUrl,
        subscribed,
        message: `Cole no Meta App: Callback URL=${webhookUrl} + Verify Token (configurado em /whatsapp). ${subscribed ? "WABA assinado no app." : `WABA: ${subDetail}`}`,
      });
    }

    // Evolution
    let webhookUrl = `${baseUrl}/api/webhooks/whatsapp`;
    if (agentId) webhookUrl += `?agentId=${agentId}`;

    console.log(">>> REGISTRANDO WEBHOOK Evolution:", webhookUrl, "para instancia:", instance);
    const result = await evolution.setWebhook(webhookUrl, instance);

    return NextResponse.json({ success: true, provider: "evolution", webhook: result, webhookUrl, appUrl: baseUrl });
  } catch (err: any) {
    console.error(">>> ERRO AO REGISTRAR WEBHOOK:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
