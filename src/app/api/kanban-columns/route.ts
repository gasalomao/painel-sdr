import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET    /api/kanban-columns         → lista colunas do cliente (order_index)
 * POST   /api/kanban-columns         → cria { status_key, label, color, order_index }
 * PATCH  /api/kanban-columns         → reordenar em lote: { columns: [{id, order_index}] }
 * (use /api/kanban-columns/[id] pra editar/apagar coluna individual)
 */

export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const { data, error } = await supabaseAdmin
    .from("kanban_columns")
    .select("id, status_key, label, color, order_index, is_system")
    .eq("client_id", ctx.clientId)
    .order("order_index");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, columns: data || [] });
}

export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const status_key = String(body.status_key || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const label      = String(body.label || "").trim();
  if (!status_key || !label) {
    return NextResponse.json({ ok: false, error: "status_key e label são obrigatórios" }, { status: 400 });
  }

  // Calcula próximo order_index automaticamente
  const { data: maxRow } = await supabaseAdmin
    .from("kanban_columns")
    .select("order_index")
    .eq("client_id", ctx.clientId)
    .order("order_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  const order_index = body.order_index ?? ((maxRow?.order_index ?? -1) + 1);

  const { data, error } = await supabaseAdmin
    .from("kanban_columns")
    .insert({
      client_id: ctx.clientId,
      status_key,
      label,
      color: body.color || "#6b7280",
      order_index,
      is_system: false,
    })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") return NextResponse.json({ ok: false, error: "Já existe uma coluna com esse status_key" }, { status: 409 });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, column: data });
}

/**
 * PATCH em lote pra reordenar:
 *   body: { columns: [{ id, order_index }, ...] }
 * Útil pra drag-and-drop salvar todas as posições novas de uma vez.
 */
export async function PATCH(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const updates: Array<{ id: string; order_index: number }> = Array.isArray(body.columns) ? body.columns : [];
  if (updates.length === 0) return NextResponse.json({ ok: false, error: "columns vazio" }, { status: 400 });

  // Promise.all em paralelo — cada update filtra por client_id pra blindar IDOR
  const results = await Promise.all(
    updates.map((u) =>
      supabaseAdmin
        .from("kanban_columns")
        .update({ order_index: u.order_index, updated_at: new Date().toISOString() })
        .eq("id", u.id)
        .eq("client_id", ctx.clientId)
    )
  );
  const firstError = results.find((r) => r.error);
  if (firstError?.error) return NextResponse.json({ ok: false, error: firstError.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, updated: updates.length });
}
