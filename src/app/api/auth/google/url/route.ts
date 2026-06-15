import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { supabaseAdmin as supabase } from '@/lib/supabase_admin';
import { requireClientId } from '@/lib/tenant';
import { createHmac, randomBytes } from 'node:crypto';

export const dynamic = "force-dynamic";

/**
 * Assina um state OAuth pra prevenir CSRF + IDOR.
 * Format: base64url(payload).hmacHex
 * Payload: { a: agentId, c: clientId, t: ts (ms), n: nonce }
 *
 * Validade: 10 minutos. Verificado em /api/auth/callback/google.
 */
function signOauthState(agentId: string, clientId: string): string {
  const secret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!secret) throw new Error("AUTH_SECRET não configurado — OAuth Google indisponível");
  const payload = {
    a: agentId,
    c: clientId,
    t: Date.now(),
    n: randomBytes(8).toString("hex"),
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(b64).digest("hex");
  return `${b64}.${mac}`;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(req.url);
    const agentId = searchParams.get('agentId');

    if (!agentId) {
      return NextResponse.json({ error: "agentId missing" }, { status: 400 });
    }

    // Ownership: o agent precisa pertencer ao cliente da sessão.
    const { data: agent, error } = await supabase
      .from('agent_settings')
      .select('options, client_id')
      .eq('id', agentId)
      .single();

    if (error || !agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    if (agent.client_id && agent.client_id !== auth.clientId) {
      return NextResponse.json({ error: "Agent não pertence a este cliente" }, { status: 403 });
    }

    const jsonStr = agent.options?.google_credentials;
    if (!jsonStr) {
      return NextResponse.json({ error: "Google credentials not configured" }, { status: 400 });
    }

    let creds;
    try {
      creds = JSON.parse(jsonStr);
    } catch {
      return NextResponse.json({ error: "Invalid JSON format in google_credentials" }, { status: 400 });
    }

    const { client_id, client_secret, redirect_uris } = creds.web || creds.installed;

    if (!client_id || !client_secret || !redirect_uris || !redirect_uris.length) {
      return NextResponse.json({ error: "Incomplete OAuth credentials in JSON" }, { status: 400 });
    }

    // Get global config for APP_URL
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

    const scopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state: signOauthState(agentId, auth.clientId),
    });

    return NextResponse.json({ url });
  } catch (error: any) {
    console.error("Auth URL generation error:", error?.message);
    return NextResponse.json({ error: "Erro ao gerar URL OAuth" }, { status: 500 });
  }
}
