import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  verifySession,
  isSessionLive,
  findClientById,
  hashPassword,
  verifyPassword,
  revokeAllClientSessions,
} from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 * Usuário troca a própria senha. Revoga todas as outras sessões — força
 * relogin em outros devices se a senha foi mudada por motivo de segurança.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ ok: false, error: "Não autenticado" }, { status: 401 });
  const claims = await verifySession(token);
  if (!claims || !(await isSessionLive(claims.sessionId, token))) {
    return NextResponse.json({ ok: false, error: "Sessão inválida" }, { status: 401 });
  }

  const { currentPassword, newPassword } = await req.json().catch(() => ({}));
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ ok: false, error: "Senha atual e nova senha obrigatórias." }, { status: 400 });
  }
  if (String(newPassword).length < 8) {
    return NextResponse.json({ ok: false, error: "Nova senha precisa ter no mínimo 8 caracteres." }, { status: 400 });
  }

  const client = await findClientById(claims.actorId);
  if (!client || !client.password_hash || !verifyPassword(currentPassword, client.password_hash)) {
    return NextResponse.json({ ok: false, error: "Senha atual incorreta." }, { status: 403 });
  }

  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  const { error } = await supabaseAdmin
    .from("clients")
    .update({ password_hash: hashPassword(newPassword), updated_at: new Date().toISOString() })
    .eq("id", claims.actorId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Revoga todas as outras sessões — exceto a atual (que continua válida pra UI não deslogar agora)
  await revokeAllClientSessions(claims.actorId);

  return NextResponse.json({ ok: true });
}
