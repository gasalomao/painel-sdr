import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, revokeSession, verifySession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 * Revoga a sessão atual no DB e limpa o cookie.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const claims = await verifySession(token);
    if (claims?.sessionId && claims.sessionId !== "pending") {
      await revokeSession(claims.sessionId).catch(() => {});
    }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
