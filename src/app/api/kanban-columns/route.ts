import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Colunas padrão do Kanban. Usadas no seed de cliente novo (admin/clients) e
 * no auto-seed lazy do GET — assim TODO tenant sempre tem um kanban funcional,
 * mesmo contas antigas/admin que nunca passaram pelo fluxo de criação.
 */
export const DEFAULT_KANBAN_COLUMNS = [
  { status_key: "novo",             label: "Lead Extraído",   color: "#3b82f6", order_index: 0, is_system: true  },
  { status_key: "primeiro_contato", label: "Primeiro Contato", color: "#06b6d4", order_index: 1, is_system: false },
  { status_key: "interessado",      label: "Interessado",      color: "#a855f7", order_index: 2, is_system: false },
  { status_key: "follow-up",        label: "Follow-Up",        color: "#f59e0b", order_index: 3, is_system: false },
  { status_key: "agendado",         label: "Agendado",         color: "#f97316", order_index: 4, is_system: false },
  { status_key: "fechado",          label: "Venda Fechada",    color: "#22c55e", order_index: 5, is_system: false },
  { status_key: "sem_interesse",    label: "Sem Interesse",    color: "#ef4444", order_index: 6, is_system: false },
  { status_key: "descartado",       label: "Descartado",       color: "#737373", order_index: 7, is_system: false },
];

// Assinatura do auto-seed ANTIGO (errado) que não batia com os status reais
// dos leads. Usada pra auto-curar tenants que receberam esse seed e nunca o
// editaram — substituímos pelo conjunto correto. Set de status_keys.
const STALE_DEFAULT_KEYS = ["novo", "primeiro_contato", "follow-up", "qualificado", "fechado", "perdido"];
function isStaleDefault(cols: { status_key: string }[]): boolean {
  if (cols.length !== STALE_DEFAULT_KEYS.length) return false;
  const set = new Set(cols.map((c) => c.status_key));
  return STALE_DEFAULT_KEYS.every((k) => set.has(k));
}

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
    .select("id, status_key, label, color, order_index, is_system, is_terminal")
    .eq("client_id", ctx.clientId)
    .order("order_index");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const seedDefaults = async () => {
    const { data: seeded, error: seedErr } = await supabaseAdmin!
      .from("kanban_columns")
      .insert(DEFAULT_KANBAN_COLUMNS.map((c) => ({ ...c, client_id: ctx.clientId })))
      .select("id, status_key, label, color, order_index, is_system, is_terminal");
    if (seedErr) {
      const { data: reread } = await supabaseAdmin!
        .from("kanban_columns")
        .select("id, status_key, label, color, order_index, is_system, is_terminal")
        .eq("client_id", ctx.clientId)
        .order("order_index");
      return NextResponse.json({ ok: true, columns: reread || [], seeded: false });
    }
    return NextResponse.json({ ok: true, columns: seeded || [], seeded: true });
  };

  // Auto-seed lazy: tenant sem nenhuma coluna (conta antiga/admin que não passou
  // pelo seed de criação) recebe o kanban padrão agora — sem isso, dropdowns de
  // auto-promote e a própria tela de Organizador ficam vazios.
  if (!data || data.length === 0) {
    return seedDefaults();
  }

  // Auto-cura: tenant com o seed ANTIGO/errado (intocado) é migrado pro conjunto
  // correto que bate com os status reais dos leads (interessado, agendado, etc).
  // Só dispara na assinatura exata do seed velho — config customizada é preservada.
  if (isStaleDefault(data)) {
    await supabaseAdmin
      .from("kanban_columns")
      .delete()
      .eq("client_id", ctx.clientId);
    return seedDefaults();
  }

  return NextResponse.json({ ok: true, columns: data });
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
      is_terminal: !!body.is_terminal,
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
