import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { hashPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/clients          → lista todos os clientes (admin-only via middleware)
 * POST /api/admin/clients          → cria cliente { name, email, password, features?, default_ai_model? }
 *
 * Não exposto pra cliente: o middleware bloqueia /api/admin/* pra não-admins.
 */

export async function GET() {
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, name, email, is_admin, is_active, default_ai_model, features, organizer_enabled, organizer_prompt, created_at, updated_at, notes")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, clients: data });
}

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  const body = await req.json().catch(() => ({}));
  const { name, email, password, features, default_ai_model, organizer_prompt, organizer_enabled, notes, is_admin } = body;

  if (!name || !email || !password) {
    return NextResponse.json({ ok: false, error: "name, email e password são obrigatórios" }, { status: 400 });
  }
  if (String(password).length < 8) {
    return NextResponse.json({ ok: false, error: "Senha precisa ter no mínimo 8 caracteres" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password_hash: hashPassword(password),
      is_admin: !!is_admin,
      is_active: true,
      default_ai_model: default_ai_model || null,
      features: features || undefined, // deixa o default do schema
      organizer_prompt: organizer_prompt || null,
      // Default = TRUE quando não enviado (organizador roda por padrão)
      organizer_enabled: typeof organizer_enabled === "boolean" ? organizer_enabled : true,
      notes: notes || null,
    })
    .select("id, name, email, is_admin, is_active, default_ai_model, features, organizer_enabled, organizer_prompt")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ ok: false, error: "Já existe um cliente com esse email" }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Seed das colunas padrão do Kanban pro cliente novo
  await supabaseAdmin.from("kanban_columns").insert([
    { client_id: data.id, status_key: "novo",             label: "Novos",            color: "#3b82f6", order_index: 0, is_system: true },
    { client_id: data.id, status_key: "primeiro_contato", label: "Primeiro contato", color: "#06b6d4", order_index: 1, is_system: false },
    { client_id: data.id, status_key: "follow-up",        label: "Follow-up",        color: "#eab308", order_index: 2, is_system: false },
    { client_id: data.id, status_key: "qualificado",      label: "Qualificado",      color: "#10b981", order_index: 3, is_system: false },
    { client_id: data.id, status_key: "fechado",          label: "Fechado",          color: "#22c55e", order_index: 4, is_system: false },
    { client_id: data.id, status_key: "perdido",          label: "Perdido",          color: "#ef4444", order_index: 5, is_system: false },
  ]).then(({ error: kbErr }) => kbErr && console.warn("[admin/clients] seed kanban:", kbErr.message));

  // Seed do Agente padrão pro cliente novo
  await supabaseAdmin.from("agent_settings").insert([
    { 
      client_id: data.id, 
      name: "Agente Principal", 
      main_prompt: "Você é o assistente virtual oficial da empresa. Seu objetivo é qualificar leads e agendar reuniões.",
      is_active: true
    }
  ]).then(({ error: agErr }) => agErr && console.warn("[admin/clients] seed agent:", agErr.message));

  return NextResponse.json({ ok: true, client: data });
}
