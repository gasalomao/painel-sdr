/**
 * OTIMIZAÇÃO #3: Context Compactor
 *
 * Compactação agressiva de histórico de mensagens.
 * Remove redundâncias e comprime respostas longas.
 * Economiza 20-30% de tokens no contexto.
 */

type Message = { role: "system" | "user" | "assistant" | "tool"; content: unknown };

export function compactAgentHistory(messages: Message[], maxMessages: number): Message[] {
  if (messages.length <= maxMessages) return messages;

  // Estratégia: mantém as primeiras (contexto inicial) e as últimas (contexto recente)
  const keepFirst = Math.floor(maxMessages * 0.3); // 30% do início
  const keepLast = maxMessages - keepFirst; // 70% do fim

  const first = messages.slice(0, keepFirst);
  const last = messages.slice(-keepLast);

  // Compacta cada mensagem
  return [...first, ...last].map(msg => compactMessage(msg));
}

function compactMessage(msg: Message): Message {
  if (msg.role === "tool") {
    return compactToolMessage(msg);
  }

  if (msg.role === "assistant") {
    return compactAssistantMessage(msg);
  }

  if (msg.role === "user" && typeof msg.content === "string") {
    return compactUserMessage(msg);
  }

  return msg;
}

function compactToolMessage(msg: Message): Message {
  if (typeof msg.content !== "string") return msg;

  try {
    const parsed = JSON.parse(msg.content);

    // Compacta grandes retornos de leitura
    if (parsed.content && typeof parsed.content === "string" && parsed.content.length > 2000) {
      return {
        ...msg,
        content: JSON.stringify({
          ...parsed,
          content: parsed.content.slice(0, 2000) + `\n... [${Math.floor((parsed.content.length - 2000) / 1000)}k chars omitidos]`
        })
      };
    }

    // Compacta listas longas de arquivos
    if (Array.isArray(parsed.files) && parsed.files.length > 20) {
      return {
        ...msg,
        content: JSON.stringify({
          ...parsed,
          files: [
            ...parsed.files.slice(0, 15),
            `... [${parsed.files.length - 15} arquivos omitidos]`
          ]
        })
      };
    }

    return msg;
  } catch {
    // Não é JSON, retorna original
    return msg;
  }
}

function compactAssistantMessage(msg: Message): Message {
  if (typeof msg.content !== "string") return msg;

  const content = msg.content;

  // Remove explicações longas, mantém apenas ações
  if (content.length > 1500) {
    // Mantém apenas primeiras 700 chars + últimas 500 chars
    const truncated = content.slice(0, 700) + "\n... [conteúdo compactado] ...\n" + content.slice(-500);
    return { ...msg, content: truncated };
  }

  return msg;
}

function compactUserMessage(msg: Message): Message {
  const content = msg.content as string;

  // Remove warnings repetitivos de loop
  if (content.includes("Leitura repetida") || content.includes("Loop detectado")) {
    return { ...msg, content: "[aviso de loop anterior]" };
  }

  // Compacta feedbacks longos de validação
  if (content.length > 1500 && content.includes("erro")) {
    return { ...msg, content: content.slice(0, 1500) + "\n... [feedback truncado]" };
  }

  return msg;
}

/**
 * Compacta especificamente histórico de tool calls para economizar tokens.
 */
export function compactToolHistory(messages: Message[]): Message[] {
  const seenTools = new Map<string, number>(); // tool_name -> count

  return messages.map(msg => {
    if (msg.role === "tool") {
      try {
        const parsed = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        const toolName = parsed.tool || "unknown";

        const count = (seenTools.get(toolName) ?? 0) + 1;
        seenTools.set(toolName, count);

        // Se já vimos essa tool 3+ vezes, compacta agressivamente
        if (count >= 3) {
          return {
            ...msg,
            content: JSON.stringify({
              tool: toolName,
              result: "[resultado omitido - tool repetida]"
            })
          };
        }
      } catch {}
    }

    return msg;
  });
}
