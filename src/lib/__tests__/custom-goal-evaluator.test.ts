import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeCustomGoalConfig,
  parseBinaryGoalResponse,
  evaluateCustomGoal,
  CUSTOM_GOAL_EVAL_SYSTEM_PROMPT,
} from "../custom-goal-evaluator";

const generateTextMock = vi.fn();

vi.mock("@/lib/ai-provider", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

describe("Custom Goal Evaluator (Objetivo Personalizado)", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  describe("normalizeCustomGoalConfig", () => {
    it("retorna valores padrão seguros quando options está vazio", () => {
      const cfg = normalizeCustomGoalConfig(null);
      expect(cfg).toEqual({
        enabled: false,
        goalText: "",
        pauseMode: "timed",
        pauseMinutes: 30,
      });
    });

    it("normaliza objetivo livre em modo por tempo (minutos)", () => {
      const cfg = normalizeCustomGoalConfig({
        custom_goal_enabled: true,
        custom_goal_text: "  enviar a chave PIX  ",
        custom_goal_pause_mode: "timed",
        custom_goal_pause_minutes: 60,
      });
      expect(cfg).toEqual({
        enabled: true,
        goalText: "enviar a chave PIX",
        pauseMode: "timed",
        pauseMinutes: 60,
      });
    });

    it("normaliza objetivo livre em modo por tempo indeterminado (manual)", () => {
      const cfg = normalizeCustomGoalConfig({
        custom_goal_enabled: true,
        custom_goal_text: "obter o e-mail do cliente",
        custom_goal_pause_mode: "indefinite",
        custom_goal_pause_minutes: 45,
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.goalText).toBe("obter o e-mail do cliente");
      expect(cfg.pauseMode).toBe("indefinite");
      expect(cfg.pauseMinutes).toBe(45);
    });
  });

  describe("parseBinaryGoalResponse", () => {
    it("interpreta respostas afirmativas de 1 token (SIM, S, YES, TRUE)", () => {
      expect(parseBinaryGoalResponse("SIM")).toBe(true);
      expect(parseBinaryGoalResponse("sim.")).toBe(true);
      expect(parseBinaryGoalResponse("S")).toBe(true);
      expect(parseBinaryGoalResponse("{\"achieved\":true}")).toBe(true);
    });

    it("interpreta respostas negativas (NAO, NÃO, N, NO, FALSE)", () => {
      expect(parseBinaryGoalResponse("NAO")).toBe(false);
      expect(parseBinaryGoalResponse("NÃO")).toBe(false);
      expect(parseBinaryGoalResponse("N")).toBe(false);
      expect(parseBinaryGoalResponse("{\"achieved\":false}")).toBe(false);
      expect(parseBinaryGoalResponse("")).toBe(false);
    });
  });

  describe("evaluateCustomGoal", () => {
    it("faz curto-circuito com 0 tokens quando o objetivo está vazio", async () => {
      const res = await evaluateCustomGoal({
        goalText: "   ",
        messages: [{ role: "user", content: "Oi" }],
      });
      expect(res).toEqual({ achieved: false, method: "skipped", tokensUsed: 0 });
      expect(generateTextMock).not.toHaveBeenCalled();
    });

    it("envia apenas as últimas 4 mensagens truncadas com maxOutputTokens=5 e reasoningMode=0", async () => {
      generateTextMock.mockResolvedValueOnce({
        text: "SIM",
        usage: { promptTokens: 92, completionTokens: 1, totalTokens: 93 },
        provider: "gemini",
        modelUsed: "gemini-2.0-flash",
        didFallback: false,
      });

      const res = await evaluateCustomGoal({
        goalText: "obter o e-mail do cliente",
        messages: [
          { role: "agent", content: "Msg 1 antiga ignorada" },
          { role: "user", content: "Msg 2 antiga ignorada" },
          { role: "agent", content: "Qual seu melhor e-mail para eu enviar a proposta?" },
          { role: "user", content: "Meu e-mail é contato@empresa.com.br" },
          { role: "agent", content: "Perfeito! Anotei seu e-mail contato@empresa.com.br." },
        ],
        modelRef: "gemini-2.0-flash",
      });

      expect(res.achieved).toBe(true);
      expect(res.method).toBe("ai");
      expect(res.tokensUsed).toBe(93);

      expect(generateTextMock).toHaveBeenCalledTimes(1);
      const callArg = generateTextMock.mock.calls[0][0];
      expect(callArg.system).toBe(CUSTOM_GOAL_EVAL_SYSTEM_PROMPT);
      expect(callArg.maxOutputTokens).toBe(5);
      expect(callArg.temperature).toBe(0);
      expect(callArg.reasoningMode).toBe(0);
      expect(callArg.prompt).not.toContain("Msg 1 antiga ignorada");
      expect(callArg.prompt).toContain("OBJETIVO: obter o e-mail do cliente");
      expect(callArg.prompt).toContain("C: Meu e-mail é contato@empresa.com.br");
    });
  });
});

