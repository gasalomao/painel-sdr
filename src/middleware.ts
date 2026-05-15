import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";

/**
 * Middleware Next.js — protege rotas que exigem autenticação.
 *
 * Rotas PÚBLICAS (sem auth):
 *   - /login, /api/auth/*, /api/webhooks/* (Evolution precisa bater sem cookie),
 *     /_next/*, /favicon, /qr-*.png
 *
 * Rotas ADMIN-ONLY:
 *   - /admin/*, /api/admin/*
 *
 * Tudo o resto: precisa estar autenticado.
 *
 * Nota: NÃO verifica revoke no DB aqui — o middleware roda em edge runtime
 * e bater no Supabase em cada request seria pesado. O check de revoke fica
 * em /api/auth/session (chamado uma vez por load de página).
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Rotas públicas — passa direto
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/webhooks/") ||
    pathname === "/login" ||
    pathname === "/favicon.ico" ||
    pathname.match(/\.(png|jpg|svg|ico|webp)$/i)
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = token ? await verifySession(token) : null;

  // Sem sessão → redireciona pra /login
  if (!claims) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Não autenticado" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  // Rotas admin-only — não-admin é bloqueado (impersonating admin ainda passa
  // porque o actor real continua admin)
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    if (!claims.isAdmin) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ ok: false, error: "Apenas admin" }, { status: 403 });
      }
      const url = req.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Aplica em tudo exceto arquivos estáticos
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
