/**
 * Helpers de multi-tenancy — usados em TODAS as rotas API pra obter o
 * `client_id` do request e blindar queries do Supabase contra cross-tenant
 * leak.
 *
 * Padrão de uso numa rota:
 *
 *   import { requireClientId } from "@/lib/tenant";
 *
 *   export async function GET(req: NextRequest) {
 *     const ctx = await requireClientId(req);
 *     if (!ctx.ok) return ctx.response;
 *     const { clientId } = ctx;
 *     // ... .from("leads").select("*").eq("client_id", clientId)
 *   }
 *
 * Pra webhooks (sem cookie de sessão), usa `clientIdFromInstance(name)`
 * que faz lookup em channel_connections.
 */

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession, type SessionClaims } from "@/lib/auth-edge";
import { supabaseAdmin } from "@/lib/supabase_admin";

export type TenantContext =
  | { ok: true; clientId: string; isAdmin: boolean; impersonating: boolean; claims: SessionClaims }
  | { ok: false; response: NextResponse };

/**
 * Obtém o `client_id` da sessão. Retorna `{ ok: false, response }` com 401
 * se não autenticado — o caller só precisa `if (!ctx.ok) return ctx.response`.
 *
 * Importante sobre admin: o `clientId` retornado é sempre o do **escopo
 * atual** — em login normal admin, é o próprio id do admin (ele tem dados
 * tipo agente padrão também); durante impersonation, é o cliente personificado.
 * `isAdmin` indica se ele tem privilégios admin (pra rotas que precisam
 * checar isso).
 */
export async function requireClientId(req: NextRequest): Promise<TenantContext> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }) };
  }
  const claims = await verifySession(token);
  if (!claims) {
    return { ok: false, response: NextResponse.json({ error: "Sessão inválida" }, { status: 401 }) };
  }
  return {
    ok: true,
    clientId: claims.clientId,
    isAdmin: !!claims.isAdmin && !claims.impersonating,
    impersonating: !!claims.impersonating,
    claims,
  };
}

/**
 * Versão soft de requireClientId — retorna null se não autenticado em vez de
 * erro. Útil pra rotas que aceitam request anônimo mas QUEREM filtrar se
 * autenticado (ex: dashboards públicos).
 */
export async function getClientIdFromRequest(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifySession(token);
  return claims?.clientId || null;
}

/**
 * Lookup do client_id pelo nome da instância de WhatsApp. Usado em webhooks
 * (Evolution não manda cookie da sessão — só o nome da instância). Cache
 * leve em memória pra evitar 1 query Supabase por mensagem.
 */
const INSTANCE_CACHE = new Map<string, { clientId: string | null; at: number }>();
const INSTANCE_CACHE_TTL = 60_000; // 1 minuto

export async function clientIdFromInstance(instanceName: string): Promise<string | null> {
  if (!instanceName || !supabaseAdmin) return null;
  const cached = INSTANCE_CACHE.get(instanceName);
  if (cached && Date.now() - cached.at < INSTANCE_CACHE_TTL) return cached.clientId;

  const { data } = await supabaseAdmin
    .from("channel_connections")
    .select("client_id")
    .eq("instance_name", instanceName)
    .maybeSingle();
  const clientId = (data?.client_id as string) || null;
  INSTANCE_CACHE.set(instanceName, { clientId, at: Date.now() });
  return clientId;
}

/** Invalida o cache (chamado quando a UI faz vínculo/troca de instância). */
export function invalidateInstanceCache(instanceName?: string) {
  if (instanceName) INSTANCE_CACHE.delete(instanceName);
  else INSTANCE_CACHE.clear();
}

/** Cliente "Default" — onde caem dados pré-multi-tenant e fallback. */
export const DEFAULT_CLIENT_ID = "00000000-0000-0000-0000-000000000001";
