import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession, isSessionLive } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/session
 * Retorna a sessão atual (ou null). Útil pra UI saber quem está logado e
 * quais features mostrar no sidebar.
 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ authenticated: false });
  const claims = await verifySession(token);
  if (!claims) return NextResponse.json({ authenticated: false });
  const live = await isSessionLive(claims.sessionId, token);
  if (!live) return NextResponse.json({ authenticated: false, reason: "revoked_or_expired" });
  return NextResponse.json({
    authenticated: true,
    clientId: claims.clientId,
    actorId: claims.actorId,
    name: claims.name,
    email: claims.email,
    isAdmin: claims.isAdmin,
    impersonating: claims.impersonating,
    features: claims.features || {},
  });
}
