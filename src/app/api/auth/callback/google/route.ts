import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { supabase } from '@/lib/supabase';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const agentId = searchParams.get('state');

    if (!code || !agentId) {
      return NextResponse.redirect(new URL('/agente?tab=ajustes&error=Missing_code_or_state', req.url));
    }

    // Get the agent's Google Credentials JSON
    const { data: agent, error } = await supabase
      .from('agent_settings')
      .select('options')
      .eq('id', agentId)
      .single();

    if (error || !agent) {
      return NextResponse.redirect(new URL('/agente?tab=ajustes&error=Agent_not_found', req.url));
    }

    const creds = JSON.parse(agent.options.google_credentials);
    const { client_id, client_secret, redirect_uris } = creds.web || creds.installed;
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

    // Exchange authorization code for refresh/access tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Retrieve userinfo to verify connected email
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: 'v2'
    });

    const userInfo = await oauth2.userinfo.get();
    
    const updatedOptions = {
        ...agent.options,
        google_tokens: tokens,
        calendar_connected_email: userInfo.data.email
    };

    // Save tokens in database options
    const { error: errorUpd } = await supabase
      .from('agent_settings')
      .update({ options: updatedOptions })
      .eq('id', agentId);

    if (errorUpd) {
       console.error("Token save error:", errorUpd);
       return NextResponse.redirect(new URL('/agente?tab=ajustes&error=Token_Saved_Error', req.url));
    }

    // Success: Token and Email saved. Redirect back to platform Settings Tab.
    return NextResponse.redirect(new URL('/agente?tab=ajustes&success=true', req.url));

  } catch (error: any) {
    console.error("OAuth Callback Error:", error);
    return NextResponse.redirect(new URL('/agente?tab=ajustes&error=OAuth_Exception', req.url));
  }
}
