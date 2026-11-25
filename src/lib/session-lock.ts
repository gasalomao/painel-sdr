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

export async function acquireSessionLock(sessionId: string): Promise<() => void> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(sessionId, current);
  await previous;
  return () => {
    release();
    if (locks.get(sessionId) === current) locks.delete(sessionId);
  };
}

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireSessionLock(sessionId);
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
