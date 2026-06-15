/**
 * /api/instances  GET
 *
 * Lista as instâncias de WhatsApp (channel_connections) do tenant.
 * NÃO conta conversas — é só pra UIs que precisam selecionar a instância
 * (ex: modal de envio do calendário, agente, follow-up).
 *
 * Cliente comum vê APENAS as próprias.
 * Admin não-impersonando vê todas (pra suporte).
 *
 * Distinto do /api/instances/stats que agrega chats_dashboard pra dashboard
 * — esse aqui é leve, devolve só metadata do canal.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  let q = supabaseAdmin
    .from("channel_connections")
    .select("instance_name, provider, status, agent_id, client_id")
    .order("instance_name", { ascending: true });

  // Cliente comum vê apenas as próprias. Tolerante a rows legacy sem
  // client_id: trata como "não atribuída" — aparecem só pro admin.
  if (!auth.isAdmin) q = q.eq("client_id", auth.clientId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    instances: (data || []).map((r) => ({
      instance_name: r.instance_name,
      provider: r.provider,
      status: r.status,
      agent_id: r.agent_id,
    })),
  });
}
