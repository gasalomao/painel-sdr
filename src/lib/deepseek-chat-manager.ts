/**
 * DeepSeek "modo conta" — usa a SESSÃO DE NAVEGADOR de chat.deepseek.com no
 * lugar de uma API key. Totalmente ISOLADO do conector OAuth oficial e do
 * `gateway_endpoints` do Supabase: tudo vive em disco local, em pasta própria
 * (`.deepseek-chat/`). Se este módulo quebrar, NADA dos outros provedores é
 * afetado — é a forma de "fazer aparte" que o usuário pediu.
 *
 * ⚠ ATENÇÃO: chat.deepseek.com NÃO foi feito pra acesso programático. O DeepSeek
 *   pode banir contas que detectar usando isso em volume. As medidas embutidas
 *   aqui (rate-limit por token, headers de browser real, HTTP proxy opcional)
 *   REDUZEM mas NÃO eliminam o risco. Esse módulo é "use por sua conta e risco"
 *   por design — a UI deixa isso vermelho e explícito.
 *
 * Server-only (fs). Não importa nada do gateway-proxy-manager pra manter zero
 * acoplamento — se um quebrar, o outro continua.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

/**
 * Fingerprint estável atribuído a uma conta na hora que ela é criada. A IDEIA
 * é: cada conta sua tem um "navegador" próprio (User-Agent, locale, sec-ch-ua
 * pareados de um Chrome real). O DeepSeek vê N pessoas diferentes — não o mesmo
 * bot rodando N vezes. Estável no tempo: a mesma conta SEMPRE manda os mesmos
 * headers (mudar User-Agent toda hora seria suspeito).
 */
export interface DsFingerprint {
  ua: string;
  locale: string;
  secChUa: string;
  secChUaPlatform: string;
  appVersion: string;
}

/** Token salvo em disco. Sem campos sensíveis derivados — só o que precisamos. */
export interface DsToken {
  id: string;
  label: string;
  token: string;          // userToken capturado do chat.deepseek.com
  paused: boolean;
  createdAt: string;
  /** Fingerprint estável (sempre o mesmo pra ESTA conta). Gerado na criação. */
  fingerprint?: DsFingerprint;
  /**
   * Cooldown temporário (timestamp ms) depois de um 429 — a rotação pula esta
   * conta até o prazo expirar, quando ela volta SOZINHA à rotação (sem o admin
   * precisar retomar manualmente). Diferente de `paused` (que é permanente até
   * ação humana em 401/403 = token morto). Recuo exponencial leve anti-ban.
   */
  pausedUntil?: number;
}

/**
 * Visão "segura" pra UI — esconde o token em si (só o tail pra usuário
 * confirmar qual é qual). A UI NUNCA precisa do token completo de novo: pra
 * trocar, o usuário cola um novo.
 */
export interface DsTokenPublic {
  id: string;
  label: string;
  tokenTail: string;      // últimos 4 chars, pra distinguir tokens parecidos
  paused: boolean;
  createdAt: string;
}

function dirWritable(d: string): boolean {
  try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; }
}

function resolveBaseDir(): string {
  // Mesma estratégia do gateway-proxy-manager: tenta env, depois cwd, depois tmp.
  const candidates = [
    process.env.DEEPSEEK_CHAT_DIR,
    path.join(process.cwd(), ".deepseek-chat"),
    path.join(os.tmpdir(), "painel-deepseek-chat"),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (dirWritable(c)) return c;
  return path.join(process.cwd(), ".deepseek-chat"); // deixa estourar com erro claro
}

const DIR = resolveBaseDir();
const TOKENS_PATH = path.join(DIR, "tokens.json");

// Estado pra rotação round-robin entre tokens não-pausados.
let rrCursor = 0;

function readAll(): DsToken[] {
  try {
    const raw = fs.readFileSync(TOKENS_PATH, "utf8");
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    const list = j.filter((t) => t && typeof t.id === "string" && typeof t.token === "string");
    // Limpa cooldowns expirados (e persiste) só se houver mudança — barato.
    return expireStaleCooldowns(list);
  } catch {
    return [];
  }
}

function writeAll(list: DsToken[]): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(list, null, 2), "utf8");
  // Backup duplo (fire-and-forget): salva tokens no Supabase pra sobreviver a
  // redeploys sem volume persistente. Não bloqueia — falha é não-fatal.
  import("@/lib/gateway-auth-backup").then((m) => m.backupDeepSeekData()).catch(() => {});
}

/**
 * Limpa o rótulo "(cooldown...)" de contas cujo prazo JÁ EXPIROU e zera o
 * pausedUntil. Idempotente e barato. Chamado nas leituras que alimentam a UI
 * e a rotação — assim o label sempre reflete o estado real (conta voltou à
 * rotação, o "(cooldown)" some sozinho sem o admin mexer).
 */
function expireStaleCooldowns(list: DsToken[]): DsToken[] {
  const now = Date.now();
  let changed = false;
  for (const t of list) {
    if (t.pausedUntil && t.pausedUntil <= now) {
      t.pausedUntil = undefined;
      t.label = t.label.replace(/\s*\(cooldown[^)]*\)\s*/g, "").trim() || t.label;
      changed = true;
    }
  }
  if (changed) {
    try { writeAll(list); } catch { /* não-fatal */ }
  }
  return list;
}

function publicShape(t: DsToken): DsTokenPublic {
  const s = t.token || "";
  const tail = s.length >= 4 ? s.slice(-4) : s;
  return { id: t.id, label: t.label, tokenTail: tail, paused: !!t.paused, createdAt: t.createdAt };
}

export function listTokens(): DsTokenPublic[] {
  return readAll().map(publicShape);
}

/**
 * Pool de fingerprints REAIS pareados (User-Agent + sec-ch-ua + platform). Vem
 * de captura de browsers de verdade — não inventar valores ou DeepSeek detecta
 * combinações impossíveis (ex.: UA Mac com sec-ch-ua Windows). Atualizar 1x
 * por ano com versões correntes.
 */
const FINGERPRINT_POOL: DsFingerprint[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaPlatform: '"Windows"',
    appVersion: "20241129.5",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    locale: "en-US,en;q=0.9",
    secChUa: '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    secChUaPlatform: '"Windows"',
    appVersion: "20241129.5",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "pt-BR,pt;q=0.9,en;q=0.8",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaPlatform: '"macOS"',
    appVersion: "20241129.5",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0",
    locale: "pt-BR,pt;q=0.9",
    secChUa: '"Microsoft Edge";v="132", "Chromium";v="132", "Not_A Brand";v="24"',
    secChUaPlatform: '"Windows"',
    appVersion: "20241129.5",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US,en;q=0.9,pt-BR;q=0.8",
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaPlatform: '"Linux"',
    appVersion: "20241129.5",
  },
];

function pickFingerprint(): DsFingerprint {
  return FINGERPRINT_POOL[crypto.randomInt(FINGERPRINT_POOL.length)];
}

function cleanTokenString(rawToken: string): string {
  let t = rawToken.trim().replace(/^"|"$/g, "");
  if (t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t);
      const extracted = parsed.userToken || parsed.token || parsed.access_token || parsed.accessToken || parsed.value || parsed.user_token;
      if (extracted && typeof extracted === "string") {
        t = extracted.trim().replace(/^"|"$/g, "");
      }
    } catch (_) {}
  }
  return t;
}

export function addToken(input: { label: string; token: string }): DsTokenPublic {
  const token = cleanTokenString(input.token);
  if (!token) throw new Error("Token vazio.");
  if (token.length < 20) throw new Error("Token muito curto pra ser um userToken válido do chat.deepseek.com.");
  const label = String(input.label || "").slice(0, 60).trim() || "DeepSeek";
  const list = readAll();
  const t: DsToken = {
    id: crypto.randomBytes(6).toString("hex"),
    label,
    token,
    paused: false,
    createdAt: new Date().toISOString(),
    fingerprint: pickFingerprint(),
  };
  list.push(t);
  writeAll(list);
  return publicShape(t);
}

export function updateToken(id: string, patch: { label?: string; paused?: boolean }): DsTokenPublic {
  const list = readAll();
  const ix = list.findIndex((t) => t.id === id);
  if (ix < 0) throw new Error("Token não encontrado.");
  if (typeof patch.label === "string") list[ix].label = patch.label.slice(0, 60).trim() || list[ix].label;
  if (typeof patch.paused === "boolean") list[ix].paused = patch.paused;
  writeAll(list);
  return publicShape(list[ix]);
}

export function deleteToken(id: string): void {
  const list = readAll();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) throw new Error("Token não encontrado.");
  writeAll(next);
}

/**
 * Coloca uma conta em COOLDOWN temporário (recuo exponencial leve anti-ban).
 * Usado quando o upstream devolve 429 (rate-limit). A conta volta SOZINHA à
 * rotação quando o prazo expira — não exige ação do admin. PRAZO cresce a cada
 * 429 consecutivo: 2min → 5min → 15min → 1h (cap em 1h).
 *
 * Diferente de `autoPauseToken` (pausa PERMANENTE pra 401/403 = token morto),
 * cooldown é temporário e reversível sozinho.
 */
const COOLDOWN_STEPS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export function setCooldown(id: string, reason: string): void {
  try {
    const list = readAll();
    const t = list.find((x) => x.id === id);
    if (!t || t.paused) return; // já pausada permanentemente — deixa quieto
    // Recuo exponencial: se já estava em cooldown, dobra o passo (até o cap).
    const inCooldown = t.pausedUntil && t.pausedUntil > Date.now();
    const stepIndex = inCooldown
      ? Math.min(COOLDOWN_STEPS_MS.length - 1, COOLDOWN_STEPS_MS.findIndex((s) => s >= (t.pausedUntil! - Date.now()) * 2) + 1)
      : 0;
    const ms = COOLDOWN_STEPS_MS[Math.max(0, stepIndex)];
    t.pausedUntil = Date.now() + ms;
    if (!/\(cooldown/.test(t.label)) {
      t.label = `${t.label} (cooldown ${Math.round(ms / 60000)}min: ${reason.slice(0, 20)})`.slice(0, 60);
    }
    writeAll(list);
  } catch { /* não-fatal */ }
}

/**
 * Seleciona um token ATIVO (não-pausado e fora de cooldown) pra atender a
 * próxima request, em round-robin. Retorna `null` se não houver nenhum — o
 * caller responde 503 e a UI mostra "nenhuma conta DeepSeek ativa".
 */
export function pickToken(): DsToken | null {
  const now = Date.now();
  const list = readAll().filter((t) => !t.paused && !(t.pausedUntil && t.pausedUntil > now));
  if (!list.length) return null;
  const pick = list[rrCursor % list.length];
  rrCursor = (rrCursor + 1) % list.length;
  return pick;
}

/**
 * Pausa um token AUTOMATICAMENTE (não-fatal — silencioso se já foi removido).
 * Chamado quando o cliente recebe um erro forte do DeepSeek (401/403 indicam
 * token revogado/banido). Anti-banimento: se a conta tá em apuros, sair fora
 * sozinho protege as outras na rotação.
 */
export function autoPauseToken(id: string, reason: string): void {
  try {
    const list = readAll();
    const t = list.find((x) => x.id === id);
    if (!t || t.paused) return;
    t.paused = true;
    // Anexa motivo no label pra usuário ver o porquê quando voltar na UI.
    if (!/\(auto-pausada/.test(t.label)) {
      t.label = `${t.label} (auto-pausada: ${reason.slice(0, 30)})`.slice(0, 60);
    }
    writeAll(list);
  } catch { /* não-fatal */ }
}

/**
 * Conta tokens ativos — usado pela rota /models pra responder cedo "503: sem
 * conta DeepSeek" sem nem precisar bater no upstream.
 */
export function countActiveTokens(): number {
  return readAll().filter((t) => !t.paused).length;
}

// ---------------------------------------------------------------------------
// Sistema de IMPORT CODE pro bookmarklet — captura em 1 clique
// ---------------------------------------------------------------------------

/**
 * Códigos de import vivem só em memória: 1 instância de painel = 1 conjunto.
 * Não persistir é proposital — restart invalida todo mundo, o que é OK pra um
 * mecanismo de "use em 15 min ou refaça". TTL curto + uso único.
 */
interface ImportCodeEntry {
  expiresAt: number;
  labelHint?: string;
}
const IMPORT_CODES = new Map<string, ImportCodeEntry>();
const IMPORT_CODE_TTL_MS = 15 * 60 * 1000;

function purgeExpiredCodes(): void {
  const now = Date.now();
  for (const [code, e] of IMPORT_CODES) if (e.expiresAt < now) IMPORT_CODES.delete(code);
}

/**
 * Gera um código de import (URL-safe, 24 chars). Inválida após 15min OU 1 uso.
 * O code fica embutido no bookmarklet — funciona como "senha de uso único" pra
 * autenticar o POST que vem da aba do chat.deepseek.com (cross-origin), sem
 * precisar de cookie de sessão.
 */
export function generateImportCode(labelHint?: string): { code: string; expiresAt: number } {
  purgeExpiredCodes();
  const code = crypto.randomBytes(18).toString("base64url");
  const expiresAt = Date.now() + IMPORT_CODE_TTL_MS;
  IMPORT_CODES.set(code, { expiresAt, labelHint });
  return { code, expiresAt };
}

/**
 * Usa um código de import pra adicionar um token. Idempotente do lado do code
 * (após uso, é deletado mesmo em falha; força o usuário a gerar outro — limita
 * brute-force/replay). Retorna o token público criado.
 */
export function consumeImportCode(code: string, token: string): DsTokenPublic {
  purgeExpiredCodes();
  const entry = IMPORT_CODES.get(code);
  IMPORT_CODES.delete(code); // ALWAYS delete, mesmo em falha — não permite replay
  if (!entry) throw new Error("Código de import inválido ou expirado. Gere outro.");
  if (entry.expiresAt < Date.now()) throw new Error("Código de import expirou. Gere outro.");
  return addToken({ token, label: entry.labelHint || "DeepSeek (bookmarklet)" });
}

// ---------------------------------------------------------------------------
// Subscriptions — userscript do Tampermonkey
// ---------------------------------------------------------------------------
//
// Bookmarklet usa `importCode` (uso único, 15 min) — uma captura por vez. O
// USERSCRIPT, em vez disso, fica RODANDO no chat.deepseek.com toda vez que o
// usuário visita. Precisa de credencial:
//   - longa duração (não expira sozinha; só se o admin revogar)
//   - múltiplo uso (rodar 100x não problem)
//   - idempotente em token igual (não cria duplicata se o userToken não mudou)
//
// Isso é a `subscription`. Cada userscript instalado tem a sua. Persiste em
// disco junto com os tokens, em arquivo separado.

interface DsSubscription {
  code: string;
  createdAt: string;
  lastUsedAt?: string;
  totalImports: number;     // contador de IMPORTS QUE CRIARAM TOKEN NOVO
  totalSyncs: number;       // contador de syncs no-op (token já existia)
}

export interface DsSubscriptionPublic {
  code: string;             // exposto pra admin colar no Tampermonkey "Import"
  createdAt: string;
  lastUsedAt?: string;
  totalImports: number;
  totalSyncs: number;
}

const SUBS_PATH = path.join(DIR, "subscriptions.json");

function readSubs(): DsSubscription[] {
  try {
    const raw = fs.readFileSync(SUBS_PATH, "utf8");
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.filter((s) => s && typeof s.code === "string") : [];
  } catch { return []; }
}

function writeSubs(list: DsSubscription[]): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SUBS_PATH, JSON.stringify(list, null, 2), "utf8");
  // Backup duplo (fire-and-forget): subscriptions também vão pro Supabase.
  import("@/lib/gateway-auth-backup").then((m) => m.backupDeepSeekData()).catch(() => {});
}

export function listSubscriptions(): DsSubscriptionPublic[] {
  return readSubs().map((s) => ({
    code: s.code,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    totalImports: s.totalImports,
    totalSyncs: s.totalSyncs,
  }));
}

/** Gera uma subscription nova (long-lived). Devolve o code completo. */
export function generateSubscriptionCode(): DsSubscriptionPublic {
  const code = crypto.randomBytes(24).toString("base64url");
  const sub: DsSubscription = {
    code,
    createdAt: new Date().toISOString(),
    totalImports: 0,
    totalSyncs: 0,
  };
  const list = readSubs();
  list.push(sub);
  writeSubs(list);
  return { code, createdAt: sub.createdAt, totalImports: 0, totalSyncs: 0 };
}

/** Revoga (apaga) uma subscription. O userscript instalado para de funcionar. */
export function revokeSubscription(code: string): void {
  const list = readSubs();
  const next = list.filter((s) => s.code !== code);
  if (next.length === list.length) throw new Error("Subscription não encontrada.");
  writeSubs(next);
}

/**
 * Recebe um token vindo do userscript. IDEMPOTENTE: se o `token` já existe na
 * lista de DsToken, só atualiza `lastUsedAt` da subscription (no-op) e devolve
 * o token existente. Senão, cria entrada nova.
 *
 * Retorna { added: true } quando criou conta NOVA — útil pro client poder
 * mostrar uma notificação só nas mudanças relevantes.
 */
export function consumeSubscription(code: string, token: string): { added: boolean; tokenId: string } {
  const tokenTrimmed = String(token || "").trim();
  if (!tokenTrimmed || tokenTrimmed.length < 20) throw new Error("Token inválido.");

  const subs = readSubs();
  const sub = subs.find((s) => s.code === code);
  if (!sub) throw new Error("Subscription inválida ou revogada.");

  const tokens = readAll();
  const existing = tokens.find((t) => t.token === tokenTrimmed);
  sub.lastUsedAt = new Date().toISOString();

  if (existing) {
    sub.totalSyncs += 1;
    writeSubs(subs);
    return { added: false, tokenId: existing.id };
  }

  // Token novo — cria via addToken (que assina fingerprint estável + tudo).
  const created = addToken({
    token: tokenTrimmed,
    label: `DeepSeek auto-${tokens.length + 1}`,
  });
  sub.totalImports += 1;
  writeSubs(subs);
  return { added: true, tokenId: created.id };
}

// ---------------------------------------------------------------------------
// Acesso interno (server-side only) — pra rota de chat completions
// ---------------------------------------------------------------------------

/**
 * Lê o objeto TOKEN COMPLETO (com fingerprint) de um id. Usado pelo cliente
 * pra montar os headers da request ao chat.deepseek.com. NUNCA exportar pra
 * o client browser — sai do servidor.
 */
export function getFullToken(id: string): DsToken | null {
  return readAll().find((t) => t.id === id) || null;
}
