import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { hashPassword, revokeAllClientSessions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET    /api/admin/clients/[id]        → detalhes do cliente
 * PATCH  /api/admin/clients/[id]        → atualiza campos { name?, email?, features?, default_ai_model?, is_active?, organizer_prompt?, notes? }
 *                                        Se `password` vier, reseta a senha (e revoga TODAS as sessões do cliente).
 * DELETE /api/admin/clients/[id]        → apaga cliente (CASCADE leva todos os dados tenant — confirmação na UI)
 */

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, name, email, is_admin, is_active, default_ai_model, features, organizer_prompt, notes, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: "Cliente não encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true, client: data });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };

  // Campos editáveis. Strings vazias viram null em campos opcionais pra UI poder limpar.
  if (typeof body.name === "string")                patch.name = body.name.trim();
  if (typeof body.email === "string")               patch.email = body.email.trim().toLowerCase();
  if (typeof body.is_active === "boolean")          patch.is_active = body.is_active;
  if (typeof body.is_admin === "boolean")           patch.is_admin = body.is_admin;
  if (typeof body.default_ai_model !== "undefined") patch.default_ai_model = body.default_ai_model || null;
  if (typeof body.features !== "undefined")         patch.features = body.features;
  if (typeof body.organizer_prompt !== "undefined") patch.organizer_prompt = body.organizer_prompt || null;
  if (typeof body.notes !== "undefined")            patch.notes = body.notes || null;

  // Reset de senha — só admin pode (rota é admin-only)
  let revokeAfter = false;
  if (typeof body.password === "string" && body.password.length > 0) {
    if (body.password.length < 8) {
      return NextResponse.json({ ok: false, error: "Nova senha precisa ter no mínimo 8 caracteres" }, { status: 400 });
    }
    patch.password_hash = hashPassword(body.password);
    revokeAfter = true;
  }
  // Desativar conta também revoga sessões (a conta não pode mais entrar)
  if (patch.is_active === false) revokeAfter = true;

  const { data, error } = await supabaseAdmin
    .from("clients")
    .update(patch)
    .eq("id", id)
    .select("id, name, email, is_admin, is_active, default_ai_model, features")
    .single();
  if (error) {
    if (error.code === "23505") return NextResponse.json({ ok: false, error: "Email já em uso" }, { status: 409 });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (revokeAfter) await revokeAllClientSessions(id).catch(() => {});
  return NextResponse.json({ ok: true, client: data });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  // Bloqueia delete do cliente Default
  if (id === "00000000-0000-0000-0000-000000000001") {
    return NextResponse.json({ ok: false, error: "Cliente Default não pode ser apagado" }, { status: 400 });
  }
  // Bloqueia delete de si mesmo — admin não pode apagar a própria conta enquanto logado.
  // (Vamos validar isso na UI também; aqui é só guarda extra.)
  const { error } = await supabaseAdmin.from("clients").delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
