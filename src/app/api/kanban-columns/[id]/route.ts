import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * PATCH  /api/kanban-columns/[id]   → edita { label?, color?, status_key? }
 * DELETE /api/kanban-columns/[id]   → apaga (bloqueia is_system=true)
 *
 * Ownership: filtra por client_id da sessão pra evitar editar coluna de outro.
 */

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (typeof body.label === "string") patch.label = body.label.trim();
  if (typeof body.color === "string") patch.color = body.color.trim();
  if (typeof body.status_key === "string") {
    patch.status_key = body.status_key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  }
  if (typeof body.order_index === "number") patch.order_index = body.order_index;

  const { error } = await supabaseAdmin
    .from("kanban_columns")
    .update(patch)
    .eq("id", id)
    .eq("client_id", ctx.clientId);
  if (error) {
    if (error.code === "23505") return NextResponse.json({ ok: false, error: "Já existe coluna com esse status_key" }, { status: 409 });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  const { id } = await params;

  // Verifica is_system pra não deletar coluna obrigatória ("novo")
  const { data } = await supabaseAdmin
    .from("kanban_columns")
    .select("is_system")
    .eq("id", id)
    .eq("client_id", ctx.clientId)
    .maybeSingle();
  if (!data) return NextResponse.json({ ok: false, error: "Coluna não encontrada" }, { status: 404 });
  if (data.is_system) {
    return NextResponse.json({ ok: false, error: "Coluna de sistema não pode ser apagada" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("kanban_columns")
    .delete()
    .eq("id", id)
    .eq("client_id", ctx.clientId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
