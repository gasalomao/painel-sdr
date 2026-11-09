import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { isTerminalColumn } from "@/lib/organizer-prompt";

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

function normalizeColumnRow(r: any) {
  const inferredTerminal =
    typeof r?.is_terminal === "boolean"
      ? r.is_terminal
      : isTerminalColumn({ status_key: r?.status_key || "", label: r?.label || "" });
  return {
    id: r.id,
    status_key: r.status_key,
    label: r.label,
    color: r.color,
    order_index: r.order_index,
    is_system: !!r.is_system,
    is_terminal: inferredTerminal,
  };
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

  const selectCols = (rows: any[] | null) => (rows || []).map(normalizeColumnRow);

  const { data, error } = await supabaseAdmin
    .from("kanban_columns")
    .select("*")
    .eq("client_id", ctx.clientId)
    .order("order_index");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const seedDefaults = async () => {
    const { data: seeded, error: seedErr } = await supabaseAdmin!
      .from("kanban_columns")
      .insert(DEFAULT_KANBAN_COLUMNS.map((c) => ({ ...c, client_id: ctx.clientId })))
      .select("*");
    if (seedErr) {
      const { data: reread } = await supabaseAdmin!
        .from("kanban_columns")
        .select("*")
        .eq("client_id", ctx.clientId)
        .order("order_index");
      return NextResponse.json({ ok: true, columns: selectCols(reread), seeded: false });
    }
    return NextResponse.json({ ok: true, columns: selectCols(seeded), seeded: true });
  };

  if (!data || data.length === 0) {
    return seedDefaults();
  }

  if (isStaleDefault(data)) {
    await supabaseAdmin
      .from("kanban_columns")
      .delete()
      .eq("client_id", ctx.clientId);
    return seedDefaults();
  }

  return NextResponse.json({ ok: true, columns: selectCols(data) });
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

  const { data: maxRow } = await supabaseAdmin
    .from("kanban_columns")
    .select("order_index")
    .eq("client_id", ctx.clientId)
    .order("order_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  const order_index = body.order_index ?? ((maxRow?.order_index ?? -1) + 1);

  const baseInsert = {
    client_id: ctx.clientId,
    status_key,
    label,
    color: body.color || "#6b7280",
    order_index,
    is_system: !!body.is_system,
  };

  let { data, error } = await supabaseAdmin
    .from("kanban_columns")
    .insert({ ...baseInsert, is_terminal: !!body.is_terminal })
    .select()
    .single();

  // Fallback se a coluna is_terminal ainda não existir no banco remoto
  if (error && /is_terminal/i.test(error.message || "")) {
    const retry = await supabaseAdmin
      .from("kanban_columns")
      .insert(baseInsert)
      .select()
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    if (error.code === "23505") return NextResponse.json({ ok: false, error: "Já existe uma coluna com esse status_key" }, { status: 409 });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    column: {
      ...normalizeColumnRow(data),
      is_terminal: typeof body.is_terminal === "boolean" ? body.is_terminal : normalizeColumnRow(data).is_terminal,
    },
  });
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const updates: Array<{ id: string; order_index: number }> = Array.isArray(body.columns) ? body.columns : [];
  if (updates.length === 0) return NextResponse.json({ ok: false, error: "columns vazio" }, { status: 400 });

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
