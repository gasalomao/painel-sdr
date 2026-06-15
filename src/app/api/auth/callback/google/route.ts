import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { supabaseAdmin as supabase } from '@/lib/supabase_admin';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const dynamic = "force-dynamic";

/** Valida HMAC do state e devolve payload — ou null se inválido/expirado. */
function verifyOauthState(state: string): { agentId: string; clientId: string } | null {
  const secret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!secret) return null;
  const dot = state.lastIndexOf(".");
  if (dot < 0) return null;
  const b64 = state.slice(0, dot);
  const macHex = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(b64).digest("hex");
  const a = Buffer.from(macHex, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (!payload.a || !payload.c || !payload.t) return null;
    // Expira em 10 min — protege contra replay de state vazado.
    if (Date.now() - Number(payload.t) > 10 * 60 * 1000) return null;
    return { agentId: String(payload.a), clientId: String(payload.c) };
  } catch {
    return null;
  }
}

/**
 * Página de resultado do OAuth. Em vez de redirecionar pro app inteiro dentro
 * do popup (usuário não sabia se conectou), mostra um status claro, avisa a
 * janela-mãe (postMessage) e fecha o popup sozinho. Se foi aberto em aba cheia,
 * o botão "Voltar ao sistema" cobre o caso.
 */
function resultPage(ok: boolean, title: string, message: string): NextResponse {
  const icon = ok ? "✅" : "⚠️";
  const accent = ok ? "#22c55e" : "#ef4444";
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#0a0a0f;color:#fff;font-family:system-ui,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;max-width:400px;padding:32px">
  <div style="font-size:56px;line-height:1">${icon}</div>
  <h1 style="font-size:20px;margin:18px 0 8px;color:${accent}">${title}</h1>
  <p style="color:#9ca3af;font-size:14px;margin:0 0 22px;line-height:1.5">${message}</p>
  <a href="/agente?tab=ajustes" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:600;font-size:14px">Voltar ao sistema</a>
  <p id="auto" style="color:#6b7280;font-size:12px;margin-top:18px"></p>
</div>
<script>
  try { if (window.opener) { window.opener.postMessage({ type: "google-calendar", ok: ${ok ? "true" : "false"} }, "*"); } } catch (e) {}
  if (window.opener) {
    var el = document.getElementById("auto");
    if (el) el.textContent = "Esta janela fecha sozinha em instantes...";
    setTimeout(function () { try { window.close(); } catch (e) {} }, 2500);
  }
</script>
</body></html>`;
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const stateRaw = searchParams.get('state');

    if (!code || !stateRaw) {
      return resultPage(false, "Falha ao conectar", "Faltou o código de autorização do Google. Tente conectar novamente.");
    }
    const state = verifyOauthState(stateRaw);
    if (!state) {
      return resultPage(false, "Sessão expirada", "O link de autorização expirou (vale 10 min). Clique em \"Testar conexão\" de novo.");
    }
    const { agentId, clientId } = state;

    // Ownership: o agent precisa pertencer ao clientId do state.
    const { data: agent, error } = await supabase
      .from('agent_settings')
      .select('options, client_id')
      .eq('id', agentId)
      .single();

    if (error || !agent) {
      return resultPage(false, "Falha ao conectar", "Agente não encontrado. Recarregue a página e tente de novo.");
    }
    if (agent.client_id && agent.client_id !== clientId) {
      return resultPage(false, "Acesso negado", "Esse agente não pertence à sua conta.");
    }

    const creds = JSON.parse(agent.options.google_credentials);
    const { client_id, client_secret, redirect_uris } = creds.web || creds.installed;
    const { data: config } = await supabase.from('ai_organizer_config').select('app_url').eq('id', 1).single();
    const appUrl = config?.app_url;

    const redirectUri = appUrl
      ? redirect_uris.find((r: string) => r.startsWith(appUrl.replace(/\/$/, ''))) || redirect_uris[0]
      : redirect_uris.find((r: string) => r.includes('localhost:3000')) || redirect_uris[0];

    const oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: 'v2',
    });

    const userInfo = await oauth2.userinfo.get();

    const updatedOptions = {
      ...agent.options,
      google_tokens: tokens,
      calendar_connected_email: userInfo.data.email,
    };

    const { error: errorUpd } = await supabase
      .from('agent_settings')
      .update({ options: updatedOptions })
      .eq('id', agentId);

    if (errorUpd) {
      console.error("Token save error:", errorUpd);
      return resultPage(false, "Quase lá...", "Conectamos no Google mas falhou ao salvar o acesso. Tente novamente.");
    }

    return resultPage(
      true,
      "Google Calendar conectado!",
      `Conectado como <strong style="color:#fff">${userInfo.data.email || "sua conta Google"}</strong>. A IA já pode agendar reuniões. Pode fechar esta janela.`
    );
  } catch (error: any) {
    console.error("OAuth Callback Error:", error?.message);
    return resultPage(false, "Falha ao conectar", "Ocorreu um erro ao finalizar a conexão com o Google. Tente novamente.");
  }
}
