/**
 * Testa o roteamento de failover do ai-provider (isFailoverableStatus +
 * ProviderHttpError). São as peças que decidem "trocar de conta conectada"
 * vs "erro do request, não adianta trocar".
 *
 * Cobertura:
 *  - HTTP 429, 402 → failover (quota esgotou em uma conta)
 *  - HTTP 401, 403 → failover (credencial morta)
 *  - HTTP 5xx, 0 (rede) → failover (transitório)
 *  - HTTP 400 com msg de quota → failover
 *  - HTTP 400 bad request puro → NÃO (outra conta dá o mesmo erro)
 *  - HTTP 404 → NÃO (modelo/rota inexistente — não é falha de conta)
 *  - ProviderHttpError preserva status + endpointId
 */
import { describe, it, expect } from "vitest";
import {
  ProviderHttpError,
  isFailoverableStatus,
  resolveReasoningMode,
  applyReasoning,
} from "../ai-provider";

describe("isFailoverableStatus — quando trocar de conta?", () => {
  it("429 (rate limit) → troca", () => {
    expect(isFailoverableStatus(429)).toBe(true);
  });

  it("402 (payment required) → troca (quota)", () => {
    expect(isFailoverableStatus(402)).toBe(true);
  });

  it("401 e 403 (auth) → troca (credencial morta)", () => {
    expect(isFailoverableStatus(401)).toBe(true);
    expect(isFailoverableStatus(403)).toBe(true);
  });

  it("5xx (server error) → troca (transitório)", () => {
    expect(isFailoverableStatus(500)).toBe(true);
    expect(isFailoverableStatus(502)).toBe(true);
    expect(isFailoverableStatus(503)).toBe(true);
    expect(isFailoverableStatus(599)).toBe(true);
  });

  it("status 0 (rede/timeout) → troca", () => {
    expect(isFailoverableStatus(0)).toBe(true);
  });

  it("400 com mensagem de quota → troca (alguns proxies devolvem 400 em vez de 429)", () => {
    expect(isFailoverableStatus(400, "You exceeded your quota")).toBe(true);
    expect(isFailoverableStatus(400, "rate limit exceeded")).toBe(true);
    expect(isFailoverableStatus(400, "too many requests")).toBe(true);
    expect(isFailoverableStatus(400, "insufficient credits")).toBe(true);
  });

  it("400 bad request puro → NÃO troca (outra conta daria o mesmo erro)", () => {
    expect(isFailoverableStatus(400, "invalid model")).toBe(false);
    expect(isFailoverableStatus(400, "malformed payload")).toBe(false);
  });

  it("404 (not found) → NÃO troca (modelo/rota inexistente)", () => {
    expect(isFailoverableStatus(404)).toBe(false);
  });

  it("200 (OK) → NÃO troca (não é erro)", () => {
    expect(isFailoverableStatus(200)).toBe(false);
  });
});

describe("ProviderHttpError — preserva status + endpointId", () => {
  it("carrega status e message", () => {
    const err = new ProviderHttpError(429, "quota exceeded");
    expect(err.status).toBe(429);
    expect(err.message).toBe("quota exceeded");
    expect(err.name).toBe("ProviderHttpError");
    expect(err instanceof Error).toBe(true);
  });

  it("carrega endpointId quando fornecido", () => {
    const err = new ProviderHttpError(401, "not authorized", "conn-42");
    expect(err.endpointId).toBe("conn-42");
  });

  it("endpointId fica undefined quando não fornecido", () => {
    const err = new ProviderHttpError(500, "boom");
    expect(err.endpointId).toBeUndefined();
  });
});

describe("resolveReasoningMode — retrocompat com thinkingBudget", () => {
  it("mode explícito sempre vence", () => {
    expect(resolveReasoningMode(0)).toBe(0);
    expect(resolveReasoningMode(1)).toBe(1);
    expect(resolveReasoningMode(2)).toBe(2);
  });

  it("thinkingBudget = 0 vira econômico (mode 0)", () => {
    expect(resolveReasoningMode(undefined, 0)).toBe(0);
  });

  it("thinkingBudget > 0 vira equilibrado (mode 1)", () => {
    expect(resolveReasoningMode(undefined, 256)).toBe(1);
    expect(resolveReasoningMode(undefined, 8192)).toBe(1);
  });

  it("thinkingBudget = -1 (dinâmico) vira intenso (mode 2)", () => {
    expect(resolveReasoningMode(undefined, -1)).toBe(2);
  });

  it("sem nada → econômico (default seguro)", () => {
    expect(resolveReasoningMode(undefined, undefined)).toBe(0);
    expect(resolveReasoningMode(null, null)).toBe(0);
  });
});

describe("applyReasoning — mapa por provedor", () => {
  it("Gemini é no-op (thinkingBudget tratado em outro lugar)", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 2, "gemini", "gemini-2.5-flash");
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("GPT-5 / OpenAI recebe reasoning.effort", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 0, "openrouter", "openai/gpt-5");
    expect(body.reasoning).toEqual({ effort: "minimal" });

    const body2: Record<string, any> = {};
    applyReasoning(body2, 1, "openrouter", "openai/gpt-5");
    expect(body2.reasoning).toEqual({ effort: "medium" });

    const body3: Record<string, any> = {};
    applyReasoning(body3, 2, "openrouter", "openai/gpt-5");
    expect(body3.reasoning).toEqual({ effort: "high" });
  });

  it("Claude recebe thinking.budget_tokens só quando NÃO econômico", () => {
    const body0: Record<string, any> = {};
    applyReasoning(body0, 0, "gateway", "claude-3-5-sonnet");
    expect(body0.thinking).toBeUndefined();

    const body1: Record<string, any> = {};
    applyReasoning(body1, 1, "gateway", "claude-3-5-sonnet");
    expect(body1.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });

    const body2: Record<string, any> = {};
    applyReasoning(body2, 2, "gateway", "claude-3-5-sonnet");
    expect(body2.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });

  it("DeepSeek e outros — sem campo de raciocínio (no-op)", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 2, "openrouter", "deepseek-chat");
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });
});
