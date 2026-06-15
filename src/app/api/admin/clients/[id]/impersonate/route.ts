import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_TTL,
  verifySession,
  isSessionLive,
  findClientById,
  signSession,
  createAuthSession,
  revokeSession,
} from "@/lib/auth";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/clients/[id]/impersonate
 * Admin "entra como cliente" — cria nova sessão JWT com:
 *   - clientId    = id do cliente personificado (governa features/dados)
 *   - actorId     = admin original (preservado pra audit + voltar)
 *   - impersonating = true
 *
 * A sessão ANTIGA (admin) é revogada — o admin sai da conta dele.
 * Pra voltar, ele faz logout + login normal de novo (ou clica "voltar pra admin"
 * que vai pra POST /api/admin/stop-impersonate, que faz o caminho inverso).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ ok: false, error: "Não autenticado" }, { status: 401 });
  const claims = await verifySession(token);
  if (!claims || !(await isSessionLive(claims.sessionId, token))) {
    return NextResponse.json({ ok: false, error: "Sessão inválida" }, { status: 401 });
  }
  if (!claims.isAdmin) return NextResponse.json({ ok: false, error: "Apenas admin" }, { status: 403 });

  const { id: targetId } = await params;
  const target = await findClientById(targetId);
  if (!target) return NextResponse.json({ ok: false, error: "Cliente não encontrado" }, { status: 404 });
  if (!target.is_active) return NextResponse.json({ ok: false, error: "Cliente desativado" }, { status: 403 });

  // Cria nova sessão impersonando com ID já definido
  const newSessionId = randomUUID();
  const newToken = await signSession({
    sessionId: newSessionId,
    clientId: target.id,
    actorId: claims.actorId,
    email: target.email,
    name: target.name,
    isAdmin: target.is_admin,
    impersonating: true,
    features: target.features || {},
  });
  
  await createAuthSession({
    id: newSessionId,
    clientId: target.id,
    impersonatedAs: target.id,
    token: newToken,
    userAgent: req.headers.get("user-agent") || undefined,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
  });

  const res = NextResponse.json({ ok: true, clientId: target.id, name: target.name });

  // Salva o token atual (do admin) para permitir restauração posterior
  res.cookies.set("ADMIN_SESSION_COOKIE", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL,
  });

  res.cookies.set(SESSION_COOKIE, newToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL,
  });
  return res;
}
