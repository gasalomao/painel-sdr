import { NextRequest, NextResponse } from "next/server";
import { requireClientId, type TenantContext } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";

const recentActions = new Map<string, number>();

export async function requireBackupAdmin(req: NextRequest): Promise<TenantContext> {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx;
  if (!ctx.isAdmin || ctx.impersonating) {
    return { ok: false, response: NextResponse.json({ success: false, error: "Backup completo disponível somente para administradores." }, { status: 403 }) };
  }
  if (!["GET", "HEAD"].includes(req.method)) {
    const origin = req.headers.get("origin");
    const allowed = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
    if (!origin || origin !== new URL(allowed).origin) {
      return { ok: false, response: NextResponse.json({ success: false, error: "Origem da solicitação inválida." }, { status: 403 }) };
    }
  }
  if (req.method === "POST" || req.nextUrl.pathname.endsWith("/diagnostics") || req.nextUrl.pathname.endsWith("/auth")) {
    const key = `${ctx.clientId}:${req.nextUrl.pathname}`;
    const now = Date.now();
    if ((recentActions.get(key) || 0) > now - 5000) {
      return { ok: false, response: NextResponse.json({ success: false, error: "Aguarde alguns segundos antes de repetir esta operação." }, { status: 429 }) };
    }
    for (const [existing, time] of recentActions) if (time < now - 60000) recentActions.delete(existing);
    // ponytail: limite local por processo; lock persistido protege exportações entre réplicas.
    recentActions.set(key, now);
  }
  return ctx;
}

export function backupDatabase(): NonNullable<typeof supabaseAdmin> {
  if (!supabaseAdmin) throw new Error("Cliente administrativo do banco não configurado.");
  return supabaseAdmin;
}

// Nunca repassar mensagens de subprocessos/SDKs antigos: podem conter credenciais.
export function safeBackupError(error: unknown): string {
  if (error instanceof BackupError) return error.message;
  return "Operação de backup falhou. Verifique os diagnósticos de conexão e ferramentas.";
}

export class BackupError extends Error {}
