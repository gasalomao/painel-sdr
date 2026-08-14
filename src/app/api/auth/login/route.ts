import { NextRequest, NextResponse } from "next/server";
import {
  findClientByEmail,
  verifyPassword,
  signSession,
  createAuthSession,
  SESSION_COOKIE,
  SESSION_TTL,
} from "@/lib/auth";
import { randomUUID } from "crypto";

// Rate limit login: 10 tentativas por janela de 15 min (por IP+email).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_ATTEMPTS = new Map<string, { count: number; windowStart: number; blockedUntil: number }>();
// Higiene: limpa entradas velhas quando o mapa cresce (evita leak de memória).
if (typeof setInterval !== "undefined") {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of LOGIN_ATTEMPTS) {
      if (now - v.windowStart > LOGIN_WINDOW_MS * 2 && v.blockedUntil < now) LOGIN_ATTEMPTS.delete(k);
    }
  }, 60_000);
  (timer as any).unref?.();
}

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Define cookie httpOnly se sucesso. Retorna { ok, isAdmin } pra UI redirecionar.
 */
export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json().catch(() => ({}));
    if (!email || !password) {
      return NextResponse.json({ ok: false, error: "Email e senha obrigatórios." }, { status: 400 });
    }

    // Rate limit anti-brute-force (por IP+email): 10 tentativas / 15 min.
    // In-memory — suficiente pra painel single-instance; reseta no redeploy.
    const rlKey = `${req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"}|${String(email).toLowerCase()}`;
    const now = Date.now();
    const entry = LOGIN_ATTEMPTS.get(rlKey);
    if (entry && entry.blockedUntil > now) {
      return NextResponse.json({ ok: false, error: "Muitas tentativas. Tente novamente em alguns minutos." }, { status: 429 });
    }
    const attempts = entry && now - entry.windowStart < LOGIN_WINDOW_MS ? entry.count : 0;
    LOGIN_ATTEMPTS.set(rlKey, { count: attempts + 1, windowStart: entry?.windowStart || now, blockedUntil: entry?.blockedUntil || 0 });
    if (attempts + 1 >= LOGIN_MAX_ATTEMPTS) {
      LOGIN_ATTEMPTS.set(rlKey, { count: attempts + 1, windowStart: entry?.windowStart || now, blockedUntil: now + LOGIN_WINDOW_MS });
      return NextResponse.json({ ok: false, error: "Muitas tentativas. Tente novamente em alguns minutos." }, { status: 429 });
    }

    const client = await findClientByEmail(String(email));
    // Mensagem genérica de propósito — evita enumeração de emails.
    if (!client || !client.password_hash || !verifyPassword(String(password), client.password_hash)) {
      return NextResponse.json({ ok: false, error: "Credenciais inválidas." }, { status: 401 });
    }
    // Sucesso limpa o contador deste par
    LOGIN_ATTEMPTS.delete(rlKey);
    if (!client.is_active) {
      return NextResponse.json({ ok: false, error: "Conta desativada. Fale com o administrador." }, { status: 403 });
    }

    // Cria o ID da sessão e gera o JWT final
    const sessionId = randomUUID();
    const token = await signSession({
      sessionId,
      clientId: client.id,
      actorId: client.id,
      email: client.email,
      name: client.name,
      isAdmin: client.is_admin,
      impersonating: false,
      features: client.features || {},
    });
    
    // Grava no banco com o Hash do token FINAL
    await createAuthSession({
      id: sessionId,
      clientId: client.id,
      token: token,
      userAgent: req.headers.get("user-agent") || undefined,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
    });

    const res = NextResponse.json({
      ok: true,
      isAdmin: client.is_admin,
      name: client.name,
      features: client.features || {},
    });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL,
    });
    return res;
  } catch (err: any) {
    console.error("[auth/login] erro:", err?.message);
    return NextResponse.json({ ok: false, error: "Erro interno" }, { status: 500 });
  }
}
