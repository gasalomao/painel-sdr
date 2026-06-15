import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/instances/stats
 *
 * Devolve a contagem de conversas por instância pro cliente atual.
 * Substitui o `select("instance_name, remote_jid").limit(20000)` que /chat
 * fazia no browser (transferia 2-5MB e travava o event loop).
 *
 * Resposta:
 *   { ok: true, instances: [{ instance_name, conversation_count }] }
 */
export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  // Tenta via RPC (mais barato) — se RPC não existir, cai pro fallback abaixo
  try {
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc("instances_stats", {
      p_client_id: ctx.isAdmin ? null : ctx.clientId,
    });
    if (!rpcErr && rpcData) {
      // Filtra sentinela "__all__" caso esteja contaminando os dados
      const cleaned = (rpcData as any[]).filter((r) => r?.instance_name !== "__all__");
      return NextResponse.json({ ok: true, instances: cleaned });
    }
  } catch { /* fallback abaixo */ }

  // Fallback: query agregando client-side. Limita 50k linhas pra evitar OOM
  // em conta enorme. Não é tão ruim quanto antes (20k transferidos pro browser).
  let q = supabaseAdmin
    .from("chats_dashboard")
    .select("instance_name, remote_jid")
    .not("instance_name", "is", null)
    .neq("instance_name", "__all__")
    .limit(50000);
  if (!ctx.isAdmin) q = q.eq("client_id", ctx.clientId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Conta conversas únicas (instance_name + remote_jid) por instância.
  const map = new Map<string, Set<string>>();
  for (const row of data || []) {
    const inst = (row as any).instance_name as string;
    const jid = (row as any).remote_jid as string;
    if (!inst || !jid) continue;
    if (!map.has(inst)) map.set(inst, new Set());
    map.get(inst)!.add(jid);
  }
  const instances = Array.from(map.entries()).map(([instance_name, jids]) => ({
    instance_name,
    conversation_count: jids.size,
  }));

  return NextResponse.json({ ok: true, instances });
}
