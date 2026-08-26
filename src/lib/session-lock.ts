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

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = prev.then(
    () => new Promise<void>((r) => release()),
    () => new Promise<void>((r) => release())
  );
  locks.set(sessionId, current);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(sessionId) === current) locks.delete(sessionId);
  }
}

/** Visibilidade p/ testes. */
export function __pendingLocks(): number {
  return locks.size;
}
