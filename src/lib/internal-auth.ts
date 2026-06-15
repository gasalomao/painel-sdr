/**
 * Auth interno pra rotas que são chamadas por:
 *  - Cookie de sessão (user/admin) → validamos com requireClientId
 *  - Outra rota interna (server-to-server) → header X-Internal-Secret
 *  - Webhook externo já validado → também header X-Internal-Secret
 *
 * Use em rotas que NÃO são chamadas direto pelo browser, mas que precisam
 * aceitar tanto disparo via UI (com cookie) quanto disparo programático.
 *
 * O segredo vem de AUTH_SECRET (mesmo do JWT) ou SUPABASE_SERVICE_ROLE_KEY.
 */

import type { NextRequest } from "next/server";

export const INTERNAL_SECRET_HEADER = "x-internal-secret";

export function getInternalSecret(): string {
  return process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

/** Confere header X-Internal-Secret. Use server-to-server. */
export function hasInternalSecret(req: NextRequest): boolean {
  const secret = getInternalSecret();
  if (!secret) return false;
  const header = req.headers.get(INTERNAL_SECRET_HEADER);
  return !!header && header === secret;
}
