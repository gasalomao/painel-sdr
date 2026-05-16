import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL, verifySession, revokeSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/stop-impersonate
 * Restaura a sessão do administrador original após um "impersonate".
 */
export async function POST(req: NextRequest) {
  const currentToken = req.cookies.get(SESSION_COOKIE)?.value;
  const adminToken = req.cookies.get("ADMIN_SESSION_COOKIE")?.value;

  if (!adminToken) {
    // Se não houver cookie de admin (ex: impersonou antes da atualização),
    // apenas revoga a sessão atual e força o login para não ficar preso.
    if (currentToken) {
      try {
        const claims = await verifySession(currentToken);
        if (claims) await revokeSession(claims.sessionId).catch(() => {});
      } catch {}
    }
    const res = NextResponse.json({ ok: true, redirectedToLogin: true });
    res.cookies.delete(SESSION_COOKIE);
    res.cookies.delete("ADMIN_SESSION_COOKIE");
    return res;
  }

  // Revoga a sessão "falsa" do cliente (impersonated), se houver uma válida
  if (currentToken) {
    try {
      const claims = await verifySession(currentToken);
      if (claims) {
        await revokeSession(claims.sessionId).catch(() => {});
      }
    } catch {}
  }

  // Restaura o token do Admin para o cookie principal
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, adminToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL,
  });
  
  // Remove o cookie temporário
  res.cookies.delete("ADMIN_SESSION_COOKIE");

  return res;
}
