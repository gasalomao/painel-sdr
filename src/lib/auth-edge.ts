/**
 * Auth helpers compatíveis com Edge Runtime (middleware.ts).
 *
 * Por que existe: middleware Next.js roda em V8 isolate (edge runtime) que
 * NÃO suporta `node:crypto` (pbkdf2, randomBytes etc). Aqui ficam só as
 * funções que dependem exclusivamente de Web APIs (jose usa Web Crypto).
 *
 * Coisas que NÃO podem entrar aqui:
 *   - import "crypto" (Node-only)
 *   - import "@/lib/supabase" (carrega @supabase/supabase-js que pode usar Buffer)
 *   - hashPassword / verifyPassword (precisam de pbkdf2)
 *
 * O arquivo Node-only (lib/auth.ts) RE-EXPORTA tudo daqui + adiciona o
 * resto. Use:
 *   - middleware.ts → "@/lib/auth-edge"
 *   - rotas API     → "@/lib/auth" (tudo)
 */

import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "sdr_session";
export const SESSION_TTL = 60 * 60 * 24 * 30; // 30 dias em segundos
const JWT_ALG = "HS256";

export type SessionClaims = {
  clientId: string;
  actorId: string;
  email: string;
  name: string;
  isAdmin: boolean;
  impersonating: boolean;
  features: Record<string, boolean>;
  sessionId: string;
};

function getSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!s) throw new Error("AUTH_SECRET ou SUPABASE_SERVICE_ROLE_KEY ausente — não posso assinar/verificar JWTs.");
  return new TextEncoder().encode(s);
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT(claims as any)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL}s`)
    .sign(getSecret());
}

export function timingSafeEqualEdge(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: [JWT_ALG] });
    return payload as unknown as SessionClaims;
  } catch {
    return null;
  }
}
