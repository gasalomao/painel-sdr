/**
 * Trava de serialização por SESSÃO (in-process).
 *
 * PROBLEMA: cliente manda 2 mensagens em segundos → 2 runs do agent/process
 * disparam EM PARALELO, cada um gerando e enviando sua própria resposta
 * (respostas duplicadas/conflitantes + contexto corrompido).
 *
 * SOLUÇÃO: cadeia de promises por sessionId — o run da M2 espera o da M1
 * terminar e então responde com contexto completo (comportamento humano:
 * responde as duas, na ordem). Single-container EasyPanel = mapa em memória
 * é suficiente; multi-réplica exigiria advisory lock no Postgres.
 */

const locks = new Map<string, Promise<unknown>>();
const DEFAULT_SESSION_LOCK_TTL_MS = 90_000;

/**
 * Adquire lock sequencial por sessão com watchdog TTL automático.
 * Se uma execução anterior travar por erro inesperado/hang, o watchdog libera
 * a fila após `ttlMs` para impedir deadlock permanente na conversa.
 */
export async function acquireSessionLock(
  sessionId: string,
  ttlMs = DEFAULT_SESSION_LOCK_TTL_MS,
): Promise<() => void> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let released = false;
  let releaseResolve!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  locks.set(sessionId, current);

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const doRelease = () => {
    if (released) return;
    released = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    releaseResolve();
    if (locks.get(sessionId) === current) {
      locks.delete(sessionId);
    }
  };

  await previous;

  if (Number.isFinite(ttlMs) && ttlMs > 0) {
    watchdog = setTimeout(() => {
      if (!released) {
        console.warn(`[session-lock] Watchdog liberou trava órfã após ${ttlMs}ms (${sessionId}).`);
        doRelease();
      }
    }, ttlMs);
    if (typeof (watchdog as { unref?: () => void }).unref === "function") {
      (watchdog as { unref: () => void }).unref();
    }
  }

  return doRelease;
}

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  ttlMs = DEFAULT_SESSION_LOCK_TTL_MS,
): Promise<T> {
  const release = await acquireSessionLock(sessionId, ttlMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Visibilidade p/ testes e detecção de contenção. */
export function __pendingLocks(): number {
  return locks.size;
}

export function hasActiveSessionLock(sessionId: string): boolean {
  return locks.has(sessionId);
}

const HANDLED_MESSAGE_TTL_MS = 10 * 60_000;
const HANDLED_MESSAGE_MAX_ENTRIES = 5_000;
const handledSessionMessages = new Map<string, number>();

function pruneHandledMessages(now = Date.now()): void {
  for (const [key, expiresAt] of handledSessionMessages.entries()) {
    if (expiresAt <= now) {
      handledSessionMessages.delete(key);
    }
  }
  if (handledSessionMessages.size > HANDLED_MESSAGE_MAX_ENTRIES) {
    const excess = handledSessionMessages.size - HANDLED_MESSAGE_MAX_ENTRIES;
    let deleted = 0;
    for (const key of handledSessionMessages.keys()) {
      handledSessionMessages.delete(key);
      deleted++;
      if (deleted >= excess) break;
    }
  }
}

function buildHandledKey(lockKey: string, messageId: string): string {
  return `${lockKey}::${messageId}`;
}

/**
 * Registra message_ids já atendidos por um turno para evitar que um segundo
 * turno concorrente responda novamente à mesma mensagem consolidada.
 */
export function markSessionMessagesHandled(
  lockKey: string,
  messageIds: ReadonlyArray<string | null | undefined>,
  nowMs = Date.now(),
): void {
  if (!lockKey || !Array.isArray(messageIds) || messageIds.length === 0) return;
  pruneHandledMessages(nowMs);
  const expiresAt = nowMs + HANDLED_MESSAGE_TTL_MS;
  for (const rawId of messageIds) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id) continue;
    handledSessionMessages.set(buildHandledKey(lockKey, id), expiresAt);
  }
}

export function isSessionMessageHandled(
  lockKey: string,
  messageId: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  const id = typeof messageId === "string" ? messageId.trim() : "";
  if (!lockKey || !id) return false;
  const key = buildHandledKey(lockKey, id);
  const expiresAt = handledSessionMessages.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= nowMs) {
    handledSessionMessages.delete(key);
    return false;
  }
  return true;
}

export function resetHandledMessagesForTests(): void {
  handledSessionMessages.clear();
}
