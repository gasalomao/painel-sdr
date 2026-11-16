const OUTBOUND_SENDER_TYPES = new Set([
  "ai",
  "human",
  "assistant",
  "agent",
  "sdr",
  "bot",
]);

export function isChatRowOutbound(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  if (row.is_from_me === true) return true;
  const senderType = String(row.sender_type || "").toLowerCase();
  return OUTBOUND_SENDER_TYPES.has(senderType);
}

export function isChatRowInbound(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  const senderType = String(row.sender_type || "").toLowerCase();
  if (senderType === "customer") return true;
  if (row.is_from_me === false && !OUTBOUND_SENDER_TYPES.has(senderType)) return true;
  return false;
}

