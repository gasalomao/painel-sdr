import { describe, it, expect, beforeEach } from "vitest";
import { AgentLoopDetector } from "../agent-loop-detector";
import { AgentResponseCache } from "../agent-response-cache";
import { SmartValidator } from "../agent-smart-validator";
import { compactAgentHistory } from "../agent-context-compactor";

describe("AgentLoopDetector", () => {
  let detector: AgentLoopDetector;

  beforeEach(() => {
    detector = new AgentLoopDetector(2);
  });

  it("detecta primeira repetição e retorna aviso", () => {
    const files = { "index.html": "<html></html>" };

    // Primeira chamada
    detector.detect("read", { path: "index.html" }, files);

    // Segunda chamada (primeira repetição)
    const result = detector.detect("read", { path: "index.html" }, files);

    expect(result.repeatCount).toBe(2);
    expect(result.shouldBlock).toBe(false);
    expect(result.message).toContain("Leitura repetida detectada");
  });

  it("bloqueia após 2 repetições", () => {
    const files = { "index.html": "<html></html>" };

    detector.detect("read", { path: "index.html" }, files);
    detector.detect("read", { path: "index.html" }, files);
    const result = detector.detect("read", { path: "index.html" }, files);

    expect(result.repeatCount).toBe(3);
    expect(result.shouldBlock).toBe(true);
    expect(result.message).toContain("Execução interrompida");
  });

  it("não detecta loop quando arquivos mudam", () => {
    detector.detect("read", { path: "index.html" }, { "index.html": "v1" });
    const result = detector.detect("read", { path: "index.html" }, { "index.html": "v2" });

    expect(result.repeatCount).toBe(1);
    expect(result.shouldBlock).toBe(false);
  });
});

describe("AgentResponseCache", () => {
  let cache: AgentResponseCache;

  beforeEach(() => {
    cache = new AgentResponseCache(5, 50);
  });

  it("retorna null quando não há cache", () => {
    const request = { messages: [{ role: "user" as const, content: "test" }], tools: [] };
    expect(cache.get(request)).toBeNull();
  });

  it("retorna resultado em cache quando existe", () => {
    const request = { messages: [{ role: "user" as const, content: "test" }], tools: [] };
    const result = {
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      response: { choices: [{ message: { role: "assistant" as const, content: "response" } }] }
    };

    cache.set(request, result);
    const cached = cache.get(request);

    expect(cached).toEqual(result);
  });

  it("diferencia requests com mensagens diferentes", () => {
    const request1 = { messages: [{ role: "user" as const, content: "test1" }], tools: [] };
    const request2 = { messages: [{ role: "user" as const, content: "test2" }], tools: [] };

    const result1 = {
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      response: { choices: [{ message: { role: "assistant" as const, content: "response1" } }] }
    };

    cache.set(request1, result1);

    expect(cache.get(request1)).toEqual(result1);
    expect(cache.get(request2)).toBeNull();
  });
});

describe("SmartValidator", () => {
  let validator: SmartValidator;

  beforeEach(() => {
    validator = new SmartValidator();
  });

  it("detecta progresso quando erros são resolvidos", () => {
    const files1 = { "index.html": "v1" };
    const files2 = { "index.html": "v2" };

    validator.recordValidation(files1, ["erro1", "erro2", "erro3"]);
    validator.recordValidation(files2, ["erro3"]); // 2 resolvidos

    const comparison = validator.compareErrors(["erro3"]);

    expect(comparison.resolvedErrors).toHaveLength(2);
    expect(comparison.persistentErrors).toHaveLength(1);
    expect(comparison.newErrors).toHaveLength(0);
  });

  it("detecta loop quando mesmos erros persistem", () => {
    const files = { "index.html": "v1" };
    const errors = ["erro1", "erro2"];

    validator.recordValidation(files, errors);
    validator.recordValidation(files, errors);
    validator.recordValidation(files, errors);

    expect(validator.isInValidationLoop()).toBe(true);
    expect(validator.getValidationFeedback()).toContain("Loop detectado");
  });

  it("fornece feedback quando nenhum progresso é feito", () => {
    const files1 = { "index.html": "v1" };
    const files2 = { "index.html": "v2" };
    const errors = ["erro1", "erro2"];

    validator.recordValidation(files1, errors);
    validator.recordValidation(files2, errors); // Mesmos erros

    const feedback = validator.getValidationFeedback();
    expect(feedback).toContain("Nenhum erro corrigido");
  });
});

describe("compactAgentHistory", () => {
  it("compacta histórico longo mantendo início e fim", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}`
    }));

    const compacted = compactAgentHistory(messages, 10);

    expect(compacted).toHaveLength(10);
    expect(compacted[0].content).toBe("message 0"); // Mantém início
    expect(compacted[compacted.length - 1].content).toBe("message 49"); // Mantém fim
  });

  it("não altera histórico curto", () => {
    const messages = [
      { role: "user" as const, content: "msg1" },
      { role: "assistant" as const, content: "response1" }
    ];

    const compacted = compactAgentHistory(messages, 10);

    expect(compacted).toHaveLength(2);
    expect(compacted).toEqual(messages);
  });

  it("compacta mensagens longas de assistente", () => {
    const longContent = "a".repeat(2000);
    // Criar mais mensagens que maxMessages para forçar compactação
    // Colocar mensagem do assistente no final (será mantida)
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: (i === 14 ? "assistant" : "user") as const,
      content: i === 14 ? longContent : `message ${i}`
    }));

    const compacted = compactAgentHistory(messages, 10);

    // Deve compactar para 10 mensagens
    expect(compacted).toHaveLength(10);

    // A última mensagem deve ser do assistente e estar compactada
    const lastMsg = compacted[compacted.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect((lastMsg.content as string).length).toBeLessThan(2000);
    expect(lastMsg.content).toContain("compactado");
  });
});
