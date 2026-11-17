/**
 * Combina logs recebidos via Realtime evitando duplicatas quando há
 * polling periódico concorrendo com eventos INSERT.
 */
export function mergeRealtimeLog<T extends { id?: unknown; created_at?: string; message?: string }>(
  prev: T[],
  incoming: T,
  maxItems = 100,
  order: "append" | "prepend" = "append"
): T[] {
  if (!incoming || typeof incoming !== "object") return prev;

  if (incoming.id !== undefined && incoming.id !== null && prev.some((item) => item?.id === incoming.id)) {
    return prev;
  }

  if (
    incoming.id === undefined &&
    incoming.created_at &&
    incoming.message &&
    prev.some((item) => item?.created_at === incoming.created_at && item?.message === incoming.message)
  ) {
    return prev;
  }

  return order === "prepend"
    ? [incoming, ...prev].slice(0, maxItems)
    : [...prev, incoming].slice(-maxItems);
}

