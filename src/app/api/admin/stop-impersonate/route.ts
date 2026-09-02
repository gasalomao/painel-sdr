import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_TTL,
  verifySession,
  isSessionLiveStrict,
  findClientById,
  signSession,
  createAuthSession,
  revokeSession,
} from "@/lib/auth";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/stop-impersonate
 * Encerra a impersonação e devolve o admin à própria conta.
 *
 * Security: o cookie legado ADMIN_SESSION_COOKIE NUNCA é confiável. O token
 * admin é reemitido do zero a partir do actorId da sessão impersonada —
 * validada por assinatura JWT + liveness no DB. Isso fecha o cenário em que
 * um cookie admin guardado podia ser reinstalado por qualquer sessão
 * posterior no mesmo navegador.
 */
export async function POST(req: NextRequest) {
  const currentToken = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = currentToken ? await verifySession(currentToken) : null;

  const finish = (res: NextResponse) => {
    res.cookies.delete("ADMIN_SESSION_COOKIE"); // legado: sempre apagar
    return res;
  };

  if (!claims || !currentToken || !(await isSessionLiveStrict(claims.sessionId, currentToken))) {
    return finish(NextResponse.json({ ok: false, error: "Sessão inválida" }, { status: 401 }));
  }

  // Sessão comum (não-personificada): nada a restaurar.
  if (!claims.impersonating || !claims.actorId || claims.actorId === claims.clientId) {
    return finish(NextResponse.json({ ok: true, restored: false }));
  }

  const admin = await findClientById(claims.actorId);
  if (!admin || !admin.is_admin || !admin.is_active) {
    // Admin original não existe mais ou perdeu privilégio — derruba a sessão.
    await revokeSession(claims.sessionId).catch(() => {});
    const res = NextResponse.json({ ok: true, redirectedToLogin: true });
    res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return finish(res);
  }

  const newSessionId = randomUUID();
  const newToken = await signSession({
    sessionId: newSessionId,
    clientId: admin.id,
    actorId: admin.id,
    email: admin.email,
    name: admin.name,
    isAdmin: true,
    impersonating: false,
    features: admin.features || {},
  });
  await createAuthSession({
    id: newSessionId,
    clientId: admin.id,
    token: newToken,
    userAgent: req.headers.get("user-agent") || undefined,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
  });
  await revokeSession(claims.sessionId).catch(() => {});

  const res = NextResponse.json({ ok: true, restored: true });
  res.cookies.set(SESSION_COOKIE, newToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL,
  });
  return finish(res);
}
