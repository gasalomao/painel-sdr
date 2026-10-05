type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
type ContextMessage = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string };

/** Preserve instructions, images, errors and the latest two tool rounds. Older source
 * snapshots are recoverable through read; keeping them indefinitely repeats stale code. */
export function compactWebsiteToolHistory<T extends ContextMessage>(messages: readonly T[]): T[] {
  const rounds = messages.flatMap((message, index) => message.role === "assistant" && Array.isArray(message.tool_calls) ? [index] : []);
  const cutoff = rounds.length > 2 ? rounds[rounds.length - 2] : 0;
  const reads = new Map<string, string>();
  return messages.map((message, index) => {
    if (index >= cutoff) return message;
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const calls = (message.tool_calls as ToolCall[]).map((call) => {
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          if (["read", "read_files", "search"].includes(call.function.name)) reads.set(call.id, JSON.stringify(args));
          if (["write", "create"].includes(call.function.name) && typeof args.content === "string" && args.content.length > 2000) {
            return { ...call, function: { ...call.function, arguments: JSON.stringify({ ...args, content: "[Conteúdo anterior omitido. Use read para obter o arquivo atual.]" }) } };
          }
        } catch { /* Keep malformed calls intact for diagnosis. */ }
        return call;
      });
      return { ...message, tool_calls: calls };
    }
    const source = message.tool_call_id && reads.get(message.tool_call_id);
    if (message.role === "tool" && source && typeof message.content === "string" && message.content.length > 2000) {
      try {
        const result: unknown = JSON.parse(message.content);
        if (result && typeof result === "object" && "error" in result) return message;
      } catch { return message; }
      return { ...message, content: JSON.stringify({ omitted: "Leitura antiga omitida. Use read/search para consultar o conteúdo atual.", source }) };
    }
    return message;
  });
}
