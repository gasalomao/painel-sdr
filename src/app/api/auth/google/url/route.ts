import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { supabase } from '@/lib/supabase';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const agentId = searchParams.get('agentId');

    if (!agentId) {
      return NextResponse.json({ error: "agentId missing" }, { status: 400 });
    }

    // Get the agent's Google Credentials JSON
    const { data: agent, error } = await supabase
      .from('agent_settings')
      .select('options')
      .eq('id', agentId)
      .single();

    if (error || !agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const jsonStr = agent.options?.google_credentials;
    if (!jsonStr) {
      return NextResponse.json({ error: "Google credentials not configured" }, { status: 400 });
    }

    let creds;
    try {
      creds = JSON.parse(jsonStr);
    } catch (e) {
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
      'https://www.googleapis.com/auth/userinfo.profile'
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state: agentId // Pass the agent ID in the state to retrieve it in callback
    });

    return NextResponse.json({ url });

  } catch (error: any) {
    console.error("Auth URL generation error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
