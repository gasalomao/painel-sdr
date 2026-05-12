import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";

export const dynamic = 'force-dynamic';

/**
 * API para gerenciar a URL pública (ngrok) do sistema.
 * 
 * GET  - Retorna a URL pública atual
 * POST - Salva nova URL e registra webhook automaticamente em todas as instâncias
 */

// Tabela: app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ)
const SETTING_KEY = "public_url";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const detect = searchParams.get("detect");

  // MODO: Auto-detectar via Ngrok local API
  if (detect === "true") {
    try {
      console.log("[NGROK] Tentando detectar túnel local...");
      const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(2000) });
      const data = await res.json();
      const tunnels = data.tunnels || [];
      const publicUrl = tunnels.find((t: any) => t.proto === "https")?.public_url 
                     || tunnels[0]?.public_url;

      if (publicUrl) {
         console.log("[NGROK] Detectado automaticamente:", publicUrl);
         return NextResponse.json({ success: true, url: publicUrl, detected: true });
      }
    } catch (err: any) {
      console.warn("[NGROK] Falha ao detectar:", err.message);
    }
  }

  try {
    // 1. Tenta buscar do banco
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", SETTING_KEY)
      .single();

    // 2. Fallback para .env.local
    const url = data?.value || process.env.NEXT_PUBLIC_APP_URL || "";

    return NextResponse.json({ success: true, url });
  } catch {
    return NextResponse.json({ 
      success: true, 
      url: process.env.NEXT_PUBLIC_APP_URL || "" 
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();

    if (!url || (!url.startsWith("https://") && !url.startsWith("http://"))) {
      return NextResponse.json({ error: "URL inválida. Use https://..." }, { status: 400 });
    }

    // Normaliza: remove barra final
    const cleanUrl = url.endsWith("/") ? url.slice(0, -1) : url;

    console.log(`[NGROK] Salvando URL pública: ${cleanUrl}`);

    // 1. Salvar no banco (upsert)
    const { error: upsertError } = await supabase
      .from("app_settings")
      .upsert({
        key: SETTING_KEY,
        value: cleanUrl,
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" });

    if (upsertError) {
      console.warn("[NGROK] Tabela app_settings pode não existir, criando...");
      // Se a tabela não existir, vamos tentar criar via RPC ou simpleSmente ignorar
      // e usar o .env.local como fallback
    }

    // 2. Buscar todas as conexões e registrar webhook conforme o provider
    const { data: instances } = await supabase
      .from("channel_connections")
      .select("instance_name, provider, provider_config");

    const webhookUrlEvolution = `${cleanUrl}/api/webhooks/whatsapp`;
    const webhookUrlCloud     = `${cleanUrl}/api/webhooks/whatsapp-cloud`;
    const results: { instance: string; provider: string; success: boolean; error?: string; detail?: string }[] = [];

    if (instances && instances.length > 0) {
      for (const inst of instances) {
        const prov = inst.provider || "evolution";
        try {
          if (prov === "whatsapp_cloud") {
            // WhatsApp Cloud: a URL do webhook é definida UMA VEZ no Meta App (campo "Callback URL"),
            // não por número. O que conseguimos fazer programaticamente é:
            //   POST /{waba_id}/subscribed_apps  → assina o WABA no app (pra eventos fluírem)
            // O usuário ainda precisa colar a URL pública + verify_token no Meta App Dashboard
            // se ainda não fez. Logamos a URL que ele deve usar.
            const cfg = inst.provider_config || {};
            const wabaId = cfg.business_account_id;
            const token  = cfg.access_token;
            const ver    = cfg.graph_version || "v21.0";

            if (!token) throw new Error("Sem access_token configurado.");

            if (wabaId) {
              try {
                await axios.post(
                  `https://graph.facebook.com/${ver}/${wabaId}/subscribed_apps`,
                  {},
                  { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
                );
              } catch (subErr: any) {
                // Se já estiver assinado, Meta retorna sucesso ou erro 100; não-fatal
                console.warn("[NGROK Cloud] subscribed_apps:", subErr?.response?.data || subErr.message);
              }
            }

            results.push({
              instance: inst.instance_name,
              provider: prov,
              success: true,
              detail: `Use no Meta App: Callback URL=${webhookUrlCloud} + Verify Token salvo. ${wabaId ? "(WABA já assinado)" : "Forneça business_account_id pra eu assinar o WABA automático.)"}`,
            });
          } else {
            console.log(`[NGROK] Registrando webhook Evolution para ${inst.instance_name}: ${webhookUrlEvolution}`);
            await evolution.setWebhook(webhookUrlEvolution, inst.instance_name);
            results.push({ instance: inst.instance_name, provider: prov, success: true });
          }
        } catch (err: any) {
          console.error(`[NGROK] Erro webhook ${inst.instance_name}:`, err.message);
          results.push({ instance: inst.instance_name, provider: prov, success: false, error: err.message });
        }
      }
    } else {
      try {
        await evolution.setWebhook(webhookUrlEvolution);
        results.push({ instance: evolution.instanceName, provider: "evolution", success: true });
      } catch (err: any) {
        results.push({ instance: evolution.instanceName, provider: "evolution", success: false, error: err.message });
      }
    }

    return NextResponse.json({
      success: true,
      url: cleanUrl,
      webhookUrl: webhookUrlEvolution,
      webhookUrlCloud,
      webhookResults: results,
    });

  } catch (err: any) {
    console.error("[NGROK] Erro:", err.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
