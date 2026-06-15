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

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const { agent_id, google_credentials_json } = body || {};
  if (!agent_id || !google_credentials_json) {
    return NextResponse.json({ ok: false, error: "agent_id e google_credentials_json obrigatórios" }, { status: 400 });
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

  // Valida JSON: precisa ter creds.web ou creds.installed com client_id +
  // client_secret + redirect_uris. Falha cedo pra UI mostrar erro decente.
  let parsed: any;
  try {
    parsed = typeof google_credentials_json === "string"
      ? JSON.parse(google_credentials_json)
      : google_credentials_json;
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

  // Salva como string em options.google_credentials (formato que callback espera)
  const newOptions = {
    ...((agent.options as any) || {}),
    google_credentials: typeof google_credentials_json === "string"
      ? google_credentials_json
      : JSON.stringify(google_credentials_json),
  };
  const { error: updErr } = await supabaseAdmin
    .from("agent_settings")
    .update({ options: newOptions })
    .eq("id", agent.id);

  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

  // Retorna URL pra iniciar OAuth — o frontend redireciona o usuário pra ela
  // OU abre em nova aba. /api/auth/google/url já existe e devolve { url } com
  // state HMAC assinado.
  return NextResponse.json({
    ok: true,
    agent_id: agent.id,
    agent_name: agent.name,
    next_url: `/api/auth/google/url?agentId=${agent.id}`,
  });
}
