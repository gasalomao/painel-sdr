/**
 * Sistema de autenticação multi-tenant — admin + clientes (Node-only).
 *
 * Esse arquivo carrega node:crypto e fica fora do middleware (edge runtime).
 * Pra usar em middleware/middleware.ts → "@/lib/auth-edge".
 *
 * Design:
 *   - Senha: PBKDF2-SHA256 (100k iterações, salt 16 bytes) — node:crypto nativo
 *   - Sessão: JWT (jose) em cookie httpOnly + persistência em `auth_sessions`
 *     pra permitir revoke explícito (logout, troca de senha, disable cliente)
 *   - Impersonation: admin "entra como cliente" — JWT carrega `actorId`
 *     (admin original) e `clientId` (cliente personificado)
 */

import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";

// Re-exporta tudo do auth-edge pra calls antigos continuarem funcionando
// (import { signSession, verifySession, SESSION_COOKIE, ... } from "@/lib/auth")
export {
  SESSION_COOKIE,
  SESSION_TTL,
  signSession,
  verifySession,
  type SessionClaims,
} from "@/lib/auth-edge";

// ============= HASH DE SENHA (Node-only — usa node:crypto) =============
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

// JWT / sign / verify / cookie / SessionClaims vêm de @/lib/auth-edge (re-exportados acima).

/**
 * SHA-256 do token JWT pra guardar em auth_sessions (não guardamos o token
 * em si — se vazar o DB, ninguém impersona com o hash sozinho).
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Alias local pra usar nas funções de DB abaixo (importado pra evitar circular)
import { SESSION_TTL as SESSION_TTL_SECONDS } from "@/lib/auth-edge";

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
