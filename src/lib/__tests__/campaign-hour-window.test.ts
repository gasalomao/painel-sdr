import { describe, it, expect } from "vitest";
import { isWithinHourWindow } from "../campaign-worker";

// Janela INCLUSIVA nas duas pontas: "8h às 23h" tem que enviar até 23:59.
// Bug histórico: h < endHour bloqueava a hora final inteira (23:00-23:59).

describe("isWithinHourWindow — janela inclusiva", () => {
  it("janela de dia inteiro (0-23) nunca bloqueia", () => {
    // Com pontas inclusivas, qualquer hora do dia cai dentro de 0-23.
    expect(isWithinHourWindow(0, 23)).toBe(true);
  });

  it("janela invertida (22 → 6) cobre a madrugada", () => {
    const h = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(new Date()));
    expect(isWithinHourWindow(22, 6)).toBe(h >= 22 || h <= 6);
  });

  it("janela de 1 hora só vale na própria hora", () => {
    const h = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(new Date()));
    expect(isWithinHourWindow(10, 10)).toBe(h === 10);
  });
});
