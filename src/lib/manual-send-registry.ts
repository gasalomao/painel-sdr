/**
 * Registro in-memory de IDs de mensagens enviadas MANUALMENTE pelo painel.
 *
 * Problema: quando /api/send-message envia via Evolution, a Evolution
 * dispara um webhook com fromMe=true. O webhook não sabe se o envio veio
 * do painel ou da IA, e por padrão rotula como 'ai' quando o bot está
 * ativo — fazendo tuas mensagens aparecerem como mensagens da IA.
 *
 * Solução: quando o painel envia, registra o msgId aqui por 2 min.
 * O webhook consulta — se bate, rotula como 'human' em vez de 'ai'.
 */
declare global {
  // eslint-disable-next-line no-var
  var __manualSendRegistry: Map<string, number> | undefined;
}

const TTL_MS = 2 * 60 * 1000; // 2 min

function getStore(): Map<string, number> {
  if (!globalThis.__manualSendRegistry) {
    globalThis.__manualSendRegistry = new Map();
  }
  return globalThis.__manualSendRegistry;
}

function prune(store: Map<string, number>) {
  const now = Date.now();
  for (const [k, expiresAt] of store) {
    if (expiresAt <= now) store.delete(k);
  }
}

export function registerManualSend(msgId: string) {
  if (!msgId) return;
  const store = getStore();
  prune(store);
  store.set(msgId, Date.now() + TTL_MS);
}

export function isManualSend(msgId: string): boolean {
  if (!msgId) return false;
  const store = getStore();
  prune(store);
  return store.has(msgId);
}
