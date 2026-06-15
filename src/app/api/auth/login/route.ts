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

    const client = await findClientByEmail(String(email));
    // Mensagem genérica de propósito — evita enumeração de emails.
    if (!client || !client.password_hash || !verifyPassword(String(password), client.password_hash)) {
      return NextResponse.json({ ok: false, error: "Credenciais inválidas." }, { status: 401 });
    }
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
