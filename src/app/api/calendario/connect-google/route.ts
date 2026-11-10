/**
 * /api/calendario/connect-google  POST
 *
 * Salva o JSON do OAuth Web Client do Google Cloud no agente escolhido e
 * devolve a URL pra iniciar o fluxo OAuth. Permite que o usuário conecte o
 * Google Calendar diretamente da página /calendario, sem precisar ir até
 * /agente/[id] → aba Calendar.
 *
 * Body:
 *   - agent_id  (obrigatório) — qual agente vai receber as credenciais
 *   - google_credentials_json (obrigatório) — string do JSON exportado do
 *     Google Cloud Console → OAuth client → Download JSON
 *
 * Multi-tenant: cliente comum só conecta nos próprios agentes. Admin
 * não-impersonando conecta em qualquer um.
 *
 * Depois de salvar, o frontend abre /api/auth/google/url?agentId=X que devolve
 * a URL de autorização Google — usuário aprova → callback grava tokens.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { resolveGoogleCredentials, hasCalendarConnected } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const agentId = req.nextUrl.searchParams.get("agent_id");
  if (!agentId) return NextResponse.json({ ok: false, error: "agent_id obrigatório" }, { status: 400 });

  const { data: agent } = await supabaseAdmin
    .from("agent_settings")
    .select("id, client_id, name, options")
    .eq("id", Number(agentId))
    .maybeSingle();

  if (!agent) return NextResponse.json({ ok: false, error: "Agente não encontrado" }, { status: 404 });
  if (!auth.isAdmin && agent.client_id && agent.client_id !== auth.clientId) {
    return NextResponse.json({ ok: false, error: "Agente não pertence a este cliente" }, { status: 403 });
  }

  const conn = await hasCalendarConnected(agent.id);
  const resolved = await resolveGoogleCredentials(agent.options);

  return NextResponse.json({
    ok: true,
    agent_id: agent.id,
    agent_name: agent.name,
    connected: conn.connected,
    email: conn.email || null,
    has_platform_credentials: !resolved?.isCustom && Boolean(resolved),
    has_custom_credentials: Boolean(resolved?.isCustom),
    can_connect: Boolean(resolved),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const { agent_id, google_credentials_json, action } = body || {};
  if (!agent_id) {
    return NextResponse.json({ ok: false, error: "agent_id obrigatório" }, { status: 400 });
  }

  // Valida ownership do agente
  const { data: agent } = await supabaseAdmin
    .from("agent_settings")
    .select("id, client_id, name, options")
    .eq("id", Number(agent_id))
    .maybeSingle();
  if (!agent) return NextResponse.json({ ok: false, error: "Agente não encontrado" }, { status: 404 });
  if (!auth.isAdmin && agent.client_id && agent.client_id !== auth.clientId) {
    return NextResponse.json({ ok: false, error: "Agente não pertence a este cliente" }, { status: 403 });
  }

  const currentOptions = (agent.options as any) || {};

  // Ação de Desconectar
  if (action === "disconnect") {
    const updated = { ...currentOptions };
    delete updated.google_tokens;
    delete updated.calendar_connected_email;

    const { error: discErr } = await supabaseAdmin
      .from("agent_settings")
      .update({ options: updated })
      .eq("id", agent.id);

    if (discErr) return NextResponse.json({ ok: false, error: discErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, disconnected: true, agent_id: agent.id });
  }

  // Se o usuário passou JSON customizado
  if (google_credentials_json && typeof google_credentials_json === "string" && google_credentials_json.trim()) {
    let parsed: any;
    try {
      parsed = JSON.parse(google_credentials_json.trim());
    } catch {
      return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
    }
    const creds = parsed?.web || parsed?.installed;
    if (!creds?.client_id || !creds?.client_secret || !Array.isArray(creds?.redirect_uris) || creds.redirect_uris.length === 0) {
      return NextResponse.json(
        { ok: false, error: "JSON precisa ter web.client_id, web.client_secret e web.redirect_uris" },
        { status: 400 }
      );
    }

    const newOptions = {
      ...currentOptions,
      google_credentials: google_credentials_json.trim(),
    };
    const { error: updErr } = await supabaseAdmin
      .from("agent_settings")
      .update({ options: newOptions })
      .eq("id", agent.id);

    if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
  } else {
    // 1-Clique com credenciais centralizadas da plataforma
    const resolved = await resolveGoogleCredentials(currentOptions);
    if (!resolved) {
      return NextResponse.json({
        ok: false,
        error: "Credenciais do Google não configuradas no servidor (defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET) nem no agente.",
      }, { status: 400 });
    }
  }

  // Retorna URL pra iniciar OAuth
  return NextResponse.json({
    ok: true,
    agent_id: agent.id,
    agent_name: agent.name,
    next_url: `/api/auth/google/url?agentId=${agent.id}`,
  });
}
