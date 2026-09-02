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
    // DeepSeek: as rotas de captura (import-bookmarklet, userscript.user.js) e
    // o proxy OpenAI-shape (/v1/*) são chamadas CROSS-ORIGIN — do navegador do
    // usuário no chat.deepseek.com (sem cookie de sessão do painel). O token é
    // autenticado pela `subscription`/`code` dentro do handler, não por cookie.
    // Sem isso aqui o proxy devolve 401 e o token NUNCA chega (bug histórico:
    // userscript capturava mas o painel rejeitava a import).
    pathname.startsWith("/api/deepseek-chat/import-bookmarklet") ||
    pathname.startsWith("/api/deepseek-chat/userscript.user.js") ||
    pathname.startsWith("/api/deepseek-chat/v1/") ||
    pathname === "/login" ||
    pathname === "/favicon.ico" ||
    pathname.match(/\.(png|jpg|svg|ico|webp)$/i)
  ) {
    return NextResponse.next();
  }

  // Chamadas server-to-server internas (scheduler, workers, webhook→agent):
  // passam direto com o X-Internal-Secret CORRETO (valor, não só presença).
  // SECURITY FIX: antes bastava PRESENÇA do header — presença sem comparar o
  // valor abria bypass total em rotas que não revalidam o secret no handler
  // (ex: /api/admin/*, devolvendo dados sem sessão). Rotas /api/admin nunca
  // são chamadas server-to-server: exigem admin JWT sempre.
  // (Edge runtime: env de build. Se o secret não estiver disponível aqui, o
  // header cai no fluxo normal de cookie — scheduler loga 401 e o env pode
  // ser corrigido no build.)
  const internalSecret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const internalHeader = req.headers.get(INTERNAL_SECRET_HEADER);
  if (
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/admin") &&
    internalHeader &&
    internalSecret &&
    internalHeader === internalSecret
  ) {
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
