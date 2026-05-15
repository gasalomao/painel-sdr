/**
 * Sistema de autenticação multi-tenant — admin + clientes.
 *
 * Design:
 *   - Senha: PBKDF2-SHA256 (100k iterações, salt 16 bytes) — sem dep nativa,
 *     funciona em edge runtime e nodejs.
 *   - Sessão: JWT assinado HS256 (jose) em cookie httpOnly + persistência em
 *     `auth_sessions` pra permitir revoke explícito (logout, troca de senha).
 *   - Impersonation: admin pode "entrar como cliente" — JWT carrega
 *     `actorId` (admin original) e `clientId` (cliente personificado).
 *     Toda revogação é por `auth_sessions.token_hash`.
 *
 * Por que NÃO bcrypt: bcryptjs roda em edge mas é lento; bcrypt-node é
 * binário nativo e não roda em edge runtime do Next.js. PBKDF2 do `crypto`
 * é nativo Node + Web Crypto, sem dep externa.
 */

import { SignJWT, jwtVerify } from "jose";
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";

// ============= HASH DE SENHA =============
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_DIGEST = "sha256";

/**
 * Gera hash de senha no formato `pbkdf2$iterations$saltHex$hashHex`.
 * Inclui as iterações no string pra permitir rotação sem invalidar usuários.
 */
export function hashPassword(plain: string): string {
  if (!plain) throw new Error("Senha vazia");
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const hash = pbkdf2Sync(plain, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  if (!plain || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  const got = pbkdf2Sync(plain, salt, iterations, expected.length, PBKDF2_DIGEST);
  // timingSafeEqual evita timing attack — tempo constante mesmo com hash errado.
  try { return timingSafeEqual(expected, got); } catch { return false; }
}

// ============= JWT / COOKIE =============
const JWT_ALG = "HS256";
const COOKIE_NAME = "sdr_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias

function getSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!s) throw new Error("AUTH_SECRET ou SUPABASE_SERVICE_ROLE_KEY ausente — não posso assinar JWTs.");
  return new TextEncoder().encode(s);
}

export type SessionClaims = {
  /** Cliente "logado" (ou personificado, em caso de impersonation) */
  clientId: string;
  /** Admin que iniciou a sessão. Igual a clientId em login normal; diferente quando impersonando. */
  actorId: string;
  /** Email do clientId (denormalizado pra UI) */
  email: string;
  /** Nome do clientId (denormalizado) */
  name: string;
  /** TRUE quando actorId é admin */
  isAdmin: boolean;
  /** TRUE quando actor !== client (admin entrou como cliente) */
  impersonating: boolean;
  /** Permissões granulares por módulo */
  features: Record<string, boolean>;
  /** ID da auth_session pra revoke */
  sessionId: string;
};

export async function signSession(claims: Omit<SessionClaims, "sessionId"> & { sessionId: string }): Promise<string> {
  return new SignJWT(claims as any)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: [JWT_ALG] });
    return payload as unknown as SessionClaims;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_TTL = SESSION_TTL_SECONDS;

/**
 * SHA-256 do token JWT pra guardar em auth_sessions (não guardamos o token
 * em si — se vazar o DB, ninguém impersona com o hash sozinho).
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ============= INTEGRAÇÃO COM `clients` + `auth_sessions` =============

const supabase = supabaseAdmin;

if (!supabase) {
  // Erro só dispara em runtime quando alguém chama login/etc — não trava import.
  console.warn("[auth] supabaseAdmin não configurado — auth não vai funcionar até SUPABASE_SERVICE_ROLE_KEY estar setada.");
}

export type ClientRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string | null;
  is_admin: boolean;
  is_active: boolean;
  default_ai_model: string | null;
  features: Record<string, boolean>;
  organizer_prompt: string | null;
};

export async function findClientByEmail(email: string): Promise<ClientRow | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("clients")
    .select("id, name, email, password_hash, is_admin, is_active, default_ai_model, features, organizer_prompt")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  return (data as ClientRow) || null;
}

export async function findClientById(id: string): Promise<ClientRow | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("clients")
    .select("id, name, email, password_hash, is_admin, is_active, default_ai_model, features, organizer_prompt")
    .eq("id", id)
    .maybeSingle();
  return (data as ClientRow) || null;
}

/**
 * Cria registro em auth_sessions com o hash do token.
 * Retorna o ID da sessão pra incluir no JWT (permite revoke individual).
 */
export async function createAuthSession(opts: {
  clientId: string;
  impersonatedAs?: string | null;
  token: string;
  userAgent?: string;
  ip?: string;
}): Promise<string> {
  if (!supabase) throw new Error("Supabase admin não disponível");
  const tokenHash = hashToken(opts.token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const { data, error } = await supabase
    .from("auth_sessions")
    .insert({
      client_id: opts.clientId,
      impersonated_as: opts.impersonatedAs || null,
      token_hash: tokenHash,
      user_agent: opts.userAgent?.slice(0, 500),
      ip: opts.ip?.slice(0, 64),
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Confirma que o token (do cookie) AINDA é válido no DB — bloqueia tokens
 * já revogados ou expirados mesmo que o JWT seja crypto-válido.
 */
export async function isSessionLive(sessionId: string, token: string): Promise<boolean> {
  if (!supabase) return false;
  const tokenHash = hashToken(token);
  const { data } = await supabase
    .from("auth_sessions")
    .select("id, revoked_at, expires_at")
    .eq("id", sessionId)
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!data) return false;
  if (data.revoked_at) return false;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return false;
  return true;
}

export async function revokeSession(sessionId: string): Promise<void> {
  if (!supabase) return;
  await supabase.from("auth_sessions").update({ revoked_at: new Date().toISOString() }).eq("id", sessionId);
}

export async function revokeAllClientSessions(clientId: string): Promise<void> {
  if (!supabase) return;
  await supabase.from("auth_sessions").update({ revoked_at: new Date().toISOString() }).eq("client_id", clientId).is("revoked_at", null);
}
