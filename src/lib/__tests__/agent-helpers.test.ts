import { describe, test, expect } from "vitest";
import { resolveFunnelStage, checkSchedulesSync, splitMessage, type FunnelStage } from "../agent-format";

/* ============================================================
   FUNIL — resolveFunnelStage
   ============================================================ */
describe("resolveFunnelStage", () => {
  const stages: FunnelStage[] = [
    { id: "s0", title: "Boas-vindas" },
    { id: "s1", title: "Qualificação", condition_variable: "interesse", condition_operator: "equals", condition_value: "sim" },
    { id: "s2", title: "Agendamento" },
  ];

  test("sem etapas → activeStage null", () => {
    const r = resolveFunnelStage([], {}, 0, []);
    expect(r.activeStage).toBeNull();
    expect(r.currentStageIndex).toBe(0);
  });

  test("primeira etapa sem condição é a ativa", () => {
    const r = resolveFunnelStage(stages, {}, 0, []);
    expect(r.activeStage?.id).toBe("s0");
    expect(r.skippedStages).toEqual([]);
  });

  test("equals satisfeito → mantém a etapa", () => {
    const r = resolveFunnelStage(stages, { interesse: "SIM" }, 1, []);
    expect(r.activeStage?.id).toBe("s1");
  });

  test("equals NÃO satisfeito → pula pra próxima e registra skip", () => {
    const r = resolveFunnelStage(stages, { interesse: "não" }, 1, []);
    expect(r.activeStage?.id).toBe("s2");
    expect(r.skippedStages).toContain(1);
    expect(r.currentStageIndex).toBe(2);
  });

  test("contains case-insensitive", () => {
    const s = [{ id: "x", condition_variable: "msg", condition_operator: "contains", condition_value: "preço" }];
    expect(resolveFunnelStage(s as any, { msg: "qual o PREÇO?" }, 0, []).activeStage?.id).toBe("x");
    expect(resolveFunnelStage(s as any, { msg: "bom dia" }, 0, []).activeStage).toBeNull();
  });

  test("not_equals", () => {
    const s = [{ id: "y", condition_variable: "status", condition_operator: "not_equals", condition_value: "fechado" }];
    expect(resolveFunnelStage(s as any, { status: "aberto" }, 0, []).activeStage?.id).toBe("y");
    expect(resolveFunnelStage(s as any, { status: "fechado" }, 0, []).activeStage).toBeNull();
  });

  test("não muta o skippedStages de entrada", () => {
    const original: number[] = [];
    resolveFunnelStage(stages, { interesse: "não" }, 1, original);
    expect(original).toEqual([]); // cópia, não mutação
  });
});

/* ============================================================
   HORÁRIO COMERCIAL — checkSchedulesSync (true = FECHADO)
   ============================================================ */
describe("checkSchedulesSync", () => {
  const schedules = [
    { day: "Quarta-feira", active: true, start: "08:00", end: "18:00" },
    { day: "Domingo", active: false, start: "08:00", end: "18:00" },
  ];

  test("sem escala válida → aberto (false)", () => {
    expect(checkSchedulesSync(null)).toBe(false);
    expect(checkSchedulesSync("nope" as any)).toBe(false);
  });

  test("dentro da janela (Qua 10h BRT) → ABERTO", () => {
    // 10:00 BRT = 13:00 UTC, 2026-05-27 é quarta-feira
    const now = new Date("2026-05-27T13:00:00Z");
    expect(checkSchedulesSync(schedules, now)).toBe(false);
  });

  test("fora da janela (Qua 20h BRT) → FECHADO", () => {
    const now = new Date("2026-05-27T23:00:00Z"); // 20:00 BRT
    expect(checkSchedulesSync(schedules, now)).toBe(true);
  });

  test("dia inativo (Domingo) → FECHADO", () => {
    // 2026-05-31 é domingo, 13:00 UTC = 10:00 BRT
    const now = new Date("2026-05-31T13:00:00Z");
    expect(checkSchedulesSync(schedules, now)).toBe(true);
  });

  test("dia sem escala configurada → FECHADO", () => {
    // 2026-05-28 é quinta — não está na lista
    const now = new Date("2026-05-28T13:00:00Z");
    expect(checkSchedulesSync(schedules, now)).toBe(true);
  });
});

/* ============================================================
   HUMANIZAÇÃO — splitMessage
   ============================================================ */
describe("splitMessage", () => {
  test("vazio → []", () => {
    expect(splitMessage("")).toEqual([]);
  });

  test("texto curto → 1 chunk", () => {
    expect(splitMessage("Olá, tudo bem?")).toEqual(["Olá, tudo bem?"]);
  });

  test("parágrafos viram chunks separados", () => {
    const r = splitMessage("Primeiro parágrafo.\n\nSegundo parágrafo.");
    expect(r).toEqual(["Primeiro parágrafo.", "Segundo parágrafo."]);
  });

  test("parágrafo longo (>400) é quebrado por frase", () => {
    const longSentence = "Esta é uma frase de teste razoavelmente longa para forçar a quebra. ".repeat(10);
    const r = splitMessage(longSentence);
    expect(r.length).toBeGreaterThan(1);
    // nenhum chunk deve estar absurdamente grande (a quebra é por frase ~<400)
    expect(r.every((c) => c.length < 500)).toBe(true);
  });
});
