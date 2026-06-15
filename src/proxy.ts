import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth-edge";

// Mesma constante do lib/internal-auth.ts (não importamos diretamente porque
// internal-auth depende de bindings node não disponíveis no edge runtime).
const INTERNAL_SECRET_HEADER = "x-internal-secret";

/**
 * Proxy Next.js — protege rotas e aplica feature-gating.
 *
 * Garante que:
 *  - Rotas públicas (ex: /login, webhooks, assets) passam direto.
 *  - Rotas não-públicas só abrem com sessão válida (redirect /login ou 401 JSON).
 *  - Rotas de admin (/admin/* ou /api/admin/*) exigem claims de admin (exceto stop-impersonate).
 *  - Páginas de feature (ex: /captador) só abrem se o cliente tem aquela
 *    feature marcada pelo admin (clients.features[key] !== false).
 *  - Admin (não-impersonando) passa em tudo, ignorando feature-gating.
 */

// Mapeia path raiz → feature key em clients.features.
// Path que NÃO está aqui é considerado "sem gate" (qualquer logado acessa).
const PATH_TO_FEATURE: Record<string, string> = {
  "/leads":        "leads",
  "/chat":         "chat",
  "/agente":       "agente",
  "/automacao":    "automacao",
  "/disparo":      "disparo",
  "/follow-up":    "followup",
  "/captador":     "captador",
  "/whatsapp":     "whatsapp",
  "/tokens":       "tokens",
  "/organizador":  "organizador",
  "/configuracoes": "configuracoes",
};

function getFeatureForPath(pathname: string): string | null {
  // Match exato OU prefixo + "/"
  if (PATH_TO_FEATURE[pathname]) return PATH_TO_FEATURE[pathname];
  for (const [path, feat] of Object.entries(PATH_TO_FEATURE)) {
    if (path !== "/" && pathname.startsWith(path + "/")) return feat;
  }
  return null;
}

export async function proxy(req: NextRequest) {
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

  // Chamadas server-to-server internas (scheduler, workers, webhook→agent):
  // passam direto se trouxerem o X-Internal-Secret. O próprio endpoint
  // valida o secret. Sem essa passagem, o proxy.ts retornava 401 ANTES do
  // endpoint conseguir checar o header — quebrava todo o scheduler do
  // organizador, follow-up workers etc.
  // SAFE: presença do header só BYPASSA o gate de cookie — endpoint ainda
  // valida o valor exato. Sem o secret correto, endpoint devolve 401 igual.
  if (pathname.startsWith("/api/") && req.headers.get(INTERNAL_SECRET_HEADER)) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = token ? await verifySession(token) : null;

  // Sem sessão → redireciona pra /login ou retorna 401
  if (!claims) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Não autenticado" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  // Rotas admin-only — não-admin é bloqueado (exceto stop-impersonate).
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    const isStopImpersonate = pathname === "/api/admin/stop-impersonate";
    
    if (!claims.isAdmin && !isStopImpersonate) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ ok: false, error: "Apenas admin" }, { status: 403 });
      }
      const url = req.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
  }

  // APIs gerenciam feature gates no handler ou não precisam de redirect
  if (pathname.startsWith("/api/")) return NextResponse.next();

  // Admin vê tudo (exceto cliente impersonado — abaixo cai no fluxo de feature).
  const isAdmin = !!claims.isAdmin && !claims.impersonating;
  if (isAdmin) return NextResponse.next();

  // Cliente comum (ou admin impersonando): aplica feature gate.
  const feature = getFeatureForPath(pathname);
  if (feature) {
    const features = claims.features || {};
    const allowed = features[feature] !== false; // default = true se não setado
    if (!allowed) {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      url.searchParams.set("blocked", feature);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Aplica em tudo exceto arquivos estáticos e imagens comuns por performance
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
