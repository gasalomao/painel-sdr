import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth-edge";

/**
 * Middleware de feature-gating + auth.
 *
 * Garante que:
 *  - Rotas não-públicas só abrem com sessão válida (redirect /login)
 *  - Páginas de feature (ex: /captador) só abrem se o cliente tem aquela
 *    feature marcada pelo admin (clients.features[key] !== false)
 *  - Admin (não-impersonando) passa em tudo, inclusive /admin/*
 *  - Cliente comum NUNCA acessa /admin/* mesmo digitando URL
 *
 * O sidebar já oculta os itens não liberados — esse middleware bloqueia
 * o acesso direto via URL (defesa em profundidade).
 */

// Rotas públicas — não precisam de sessão
const PUBLIC_PATHS = new Set<string>(["/login"]);

// Mapeia path raiz → feature key em clients.features.
// Path que NÃO está aqui é considerado "sem gate" (qualquer logado acessa).
const PATH_TO_FEATURE: Record<string, string> = {
  // "/" não tem gate pra evitar loop de redirect caso dashboard esteja off.
  // A própria página /dashboard mostra mensagem se cliente não tem features.
  "/leads":        "leads",
  "/chat":         "chat",
  "/agente":       "agente",
  "/automacao":    "automacao",
  "/disparo":      "disparo",
  "/follow-up":    "followup",
  "/captador":     "captador",
  "/inteligencia": "inteligencia",
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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Liberados sempre
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  // APIs gerenciam auth próprias (requireClientId)
  if (pathname.startsWith("/api/")) return NextResponse.next();
  // Assets do Next / estáticos
  if (pathname.startsWith("/_next/") || pathname.startsWith("/favicon")) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }
  const claims = await verifySession(token);
  if (!claims) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  const isAdmin = !!claims.isAdmin && !claims.impersonating;

  // /admin/* é EXCLUSIVO de admin não-impersonando.
  if (pathname.startsWith("/admin")) {
    if (!isAdmin) {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // Admin vê tudo (exceto cliente impersonado — abaixo cai no fluxo de feature).
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

// Filtro de rotas que o middleware processa.
// Exclui assets, imagens e API (API trata auth sozinha) por performance.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
