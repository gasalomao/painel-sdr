import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { evolution } from "@/lib/evolution";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = 'force-dynamic';

/**
 * Cliente comum pode registrar/ver webhook SE for dono da instância.
 * Admin não-impersonando pode tudo (precisa pra setup inicial e suporte).
 *
 * Retorna { ok: true, clientId, isAdmin, instance } OU NextResponse de erro.
 */
async function requireInstanceAccess(req: NextRequest, instanceName: string) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  // Admin não-impersonando: bypass — ele administra qualquer instância.
  if (ctx.isAdmin) {
    return { ok: true as const, clientId: ctx.clientId, isAdmin: true, instance: instanceName };
  }
  // Cliente comum (ou admin impersonando): valida ownership da instância.
  if (!instanceName) {
    return NextResponse.json({ success: false, error: "instance é obrigatório" }, { status: 400 });
  }
  const { data: conn } = await supabase
    .from("channel_connections")
    .select("client_id")
    .eq("instance_name", instanceName)
    .maybeSingle();
  // Se a row não existe OU é legacy (client_id NULL), permitimos o cliente
  // adotá-la — é o primeiro "Registrar Webhook" de uma instância nova.
  // Se já tem dono e é OUTRO cliente, bloqueia.
  if (conn?.client_id && conn.client_id !== ctx.clientId) {
    return NextResponse.json({ success: false, error: "Instância não pertence a este cliente" }, { status: 403 });
  }
  return { ok: true as const, clientId: ctx.clientId, isAdmin: false, instance: instanceName };
}

/**
 * GET - Lista o webhook configurado na instância
 * POST - Registra/atualiza o webhook na Evolution API
 */

export async function GET(req: NextRequest) {
  const instanceName = req.nextUrl.searchParams.get("instance") || (await evolution.getActiveInstance().catch(() => ""));
  if (!instanceName) {
    return NextResponse.json({ success: false, error: "Sem instância configurada. Crie uma em Configurações → Evolution API." }, { status: 400 });
  }
  const access = await requireInstanceAccess(req, instanceName);
  if (!("ok" in access)) return access;
  try {

    // Usa getEvolutionConfig() que lê do banco (app_settings) com fallback pro .env
    // Isso garante que funcione quando a Evolution foi configurada pela UI (sem rebuild).
    const { getEvolutionConfig } = await import("@/lib/evolution");
    const cfg = await getEvolutionConfig(true);
    const EVO_URL = cfg.url;
    const EVO_KEY = cfg.apiKey;

    if (!EVO_URL || EVO_URL.includes("url_aqui")) {
      return NextResponse.json({ success: false, error: "Evolution API URL não configurada. Configure em Configurações → Evolution API ou no .env.local" });
    }

    const base = EVO_URL.endsWith("/") ? EVO_URL.slice(0, -1) : EVO_URL;
    const res = await fetch(`${base}/webhook/find/${instanceName}`, {
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

    const instance = instanceName || (await evolution.getActiveInstance().catch(() => ""));
    if (!instance) {
      return NextResponse.json({ success: false, error: "Sem instância configurada. Crie uma em Configurações → Evolution API." }, { status: 400 });
    }
    const access = await requireInstanceAccess(req, instance);
    if (!("ok" in access)) return access;

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

    // SSRF guard: em produção exige HTTPS pública e bloqueia IPs internos.
    if (process.env.NODE_ENV === "production") {
      const { isUrlSafeForProd } = await import("@/lib/url-guard");
      if (!isUrlSafeForProd(baseUrl)) {
        return NextResponse.json(
          { success: false, error: "URL pública deve ser HTTPS válida e não apontar pra rede privada." },
          { status: 400 }
        );
      }
    }

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

    // Gera secret per-instância (32 bytes hex) e salva em provider_config.
    // Quando a Evolution v2 receber esse webhook config, vai mandar o header
    // X-Webhook-Secret em todo evento. Nosso /api/webhooks/whatsapp valida.
    // Idempotente: se já tem secret, reusa.
    const { randomBytes } = await import("node:crypto");
    let webhookSecret: string | null = null;
    try {
      const { data: existing } = await supabase
        .from("channel_connections")
        .select("provider_config")
        .eq("instance_name", instance)
        .maybeSingle();
      webhookSecret = (existing?.provider_config as any)?.webhook_secret || null;
      if (!webhookSecret) {
        webhookSecret = randomBytes(32).toString("hex");
        const newConfig = { ...((existing?.provider_config as any) || {}), webhook_secret: webhookSecret };
        await supabase
          .from("channel_connections")
          .upsert(
            {
              instance_name: instance,
              provider: "evolution",
              provider_config: newConfig,
            },
            { onConflict: "instance_name" }
          );
      }
    } catch (e) {
      console.warn("[register] não consegui persistir webhook_secret:", (e as Error).message);
      // Sem secret persistido, segue sem mandar header (backwards-compat)
      webhookSecret = null;
    }

    console.log(">>> REGISTRANDO WEBHOOK Evolution:", webhookUrl, "para instancia:", instance);
    const result = await evolution.setWebhook(webhookUrl, instance, webhookSecret);

    return NextResponse.json({
      success: true,
      provider: "evolution",
      webhook: result,
      webhookUrl,
      appUrl: baseUrl,
      secured: !!webhookSecret,
    });
  } catch (err: any) {
    console.error(">>> ERRO AO REGISTRAR WEBHOOK:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
