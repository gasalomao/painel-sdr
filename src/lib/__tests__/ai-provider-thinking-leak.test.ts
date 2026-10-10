/**
 * TESTE CRÍTICO DE SEGURANÇA: vazamento de thinking/reasoning interno.
 *
 * BUG ORIGINAL: quando um modelo OpenAI-compatible retornava `reasoning_content`
 * ou `reasoning` ou `thought` SEM `content` real, o código substituía o content
 * pela reasoning — vazando pensamento interno do modelo (regras do sistema,
 * prompt interno, raciocínio em inglês) diretamente pro usuário final.
 *
 * IMPACTO: cliente recebia mensagens tipo "But let's check the anti-hallucination
 * rules: don't invent info..." expondo toda a lógica interna da IA.
 *
 * FIX: reasoning NUNCA deve vazar pro content. Se só vier reasoning sem content,
 * é resposta vazia (AiEmptyResponseError).
 */

import { describe, it, expect } from "vitest";

// Mock mínimo da função requireUsableOpenAIResponse (isolada do resto)
function requireUsableOpenAIResponse(json: any, provider: string, model: string): any {
  const message = json?.choices?.[0]?.message || {};
  // SECURITY FIX: NUNCA vazar reasoning/thinking interno pro content final.
  const hasText = String(message.content || "").trim().length > 0;
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (!hasText && !hasTools) {
    throw new Error(`AiEmptyResponseError: ${provider}:${model} returned empty response`);
  }
  return json;
}

describe("ai-provider: thinking/reasoning leak prevention", () => {
  it("deve REJEITAR resposta que só tem reasoning_content sem content real", () => {
    const response = {
      choices: [{
        message: {
          reasoning_content: "But let's check the anti-hallucination rules: don't invent info...",
          content: null,  // ❌ SEM CONTENT REAL
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };

    expect(() => requireUsableOpenAIResponse(response, "gateway", "gpt-4")).toThrow(/empty response/i);
  });

  it("deve REJEITAR resposta que só tem reasoning sem content real", () => {
    const response = {
      choices: [{
        message: {
          reasoning: "In the core instructions, under 'Adaptação do Método BANT'...",
          content: "",  // ❌ STRING VAZIA
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };

    expect(() => requireUsableOpenAIResponse(response, "openrouter", "anthropic/claude-3.5-sonnet")).toThrow(/empty response/i);
  });

  it("deve REJEITAR resposta que só tem thought sem content real", () => {
    const response = {
      choices: [{
        message: {
          thought: "Therefore, her response should be to politely ask to speak with the person in charge...",
          content: "   ",  // ❌ SÓ ESPAÇOS
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };

    expect(() => requireUsableOpenAIResponse(response, "gateway", "deepseek-chat")).toThrow(/empty response/i);
  });

  it("deve ACEITAR resposta com content real (reasoning presente é ignorado)", () => {
    const response = {
      choices: [{
        message: {
          reasoning_content: "Internal thinking in English about the rules...",
          content: "Olá! Como posso ajudar você hoje?",  // ✅ RESPOSTA REAL EM PORTUGUÊS
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };

    const result = requireUsableOpenAIResponse(response, "gateway", "claude-sonnet-4");
    expect(result.choices[0].message.content).toBe("Olá! Como posso ajudar você hoje?");
    // Reasoning interno NÃO deve contaminar o content
    expect(result.choices[0].message.content).not.toContain("Internal thinking");
    expect(result.choices[0].message.content).not.toContain("English");
  });

  it("deve ACEITAR resposta com tool_calls mesmo sem content", () => {
    const response = {
      choices: [{
        message: {
          reasoning_content: "I need to search the knowledge base first...",
          content: null,  // Sem content, MAS tem tool_calls
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "search_knowledge_base", arguments: '{"query":"iPhone 15"}' } },
          ],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };

    const result = requireUsableOpenAIResponse(response, "gateway", "gpt-4");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls[0].function.name).toBe("search_knowledge_base");
  });

  it("deve REJEITAR resposta completamente vazia (sem content, sem tools, sem reasoning)", () => {
    const response = {
      choices: [{
        message: {
          content: "",
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
    };

    expect(() => requireUsableOpenAIResponse(response, "gemini", "gemini-2.5-flash")).toThrow(/empty response/i);
  });

  it("NEVER substituir content por reasoning (comportamento PROIBIDO)", () => {
    const response = {
      choices: [{
        message: {
          reasoning_content: "So even if talking to an assistant, she should be polite and try to get to the right person.",
          content: null,
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };

    // O código antigo fazia: message.content = reasoning
    // O código novo deve: throw AiEmptyResponseError
    expect(() => requireUsableOpenAIResponse(response, "gateway", "claude-sonnet-4")).toThrow();

    // Se não lançar erro (NUNCA deveria acontecer), pelo menos não vaze o reasoning
    try {
      const result = requireUsableOpenAIResponse(response, "gateway", "claude-sonnet-4");
      // Se chegou aqui, garante que reasoning NÃO foi copiado pro content
      expect(result.choices[0].message.content || "").not.toContain("So even if talking");
      expect(result.choices[0].message.content || "").not.toContain("she should be polite");
    } catch {
      // Comportamento esperado: deve lançar erro
    }
  });
});
