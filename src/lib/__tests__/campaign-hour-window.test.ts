import { describe, it, expect, beforeEach } from "vitest";
import {
  isHourInWindow,
  isWithinHourWindow,
  resetCampaignWarningThrottleForTests,
  shouldEmitCampaignWarning,
} from "../campaign-worker";

describe("isHourInWindow & isWithinHourWindow — Janela de Disparo", () => {
  it("janela comercial comum (8h às 18h): permite de 8h às 17h59 e BLOQUEIA às 18h", () => {
    // Horas permitidas
    expect(isHourInWindow(8, 8, 18)).toBe(true);
    expect(isHourInWindow(12, 8, 18)).toBe(true);
    expect(isHourInWindow(17, 8, 18)).toBe(true);

    // Horas bloqueadas (às 18h em ponto encerra!)
    expect(isHourInWindow(18, 8, 18)).toBe(false);
    expect(isHourInWindow(19, 8, 18)).toBe(false);
    expect(isHourInWindow(7, 8, 18)).toBe(false);
    expect(isHourInWindow(0, 8, 18)).toBe(false);
  });

  it("janela de dia inteiro (0h às 23h ou até 24h): nunca bloqueia", () => {
    for (let h = 0; h <= 23; h++) {
      expect(isHourInWindow(h, 0, 23)).toBe(true);
      expect(isHourInWindow(h, 0, 24)).toBe(true);
      expect(isHourInWindow(h, 8, 24)).toBe(true);
    }
  });

  it("janela noturna invertida (22h às 6h): cobre das 22h até as 05h59", () => {
    expect(isHourInWindow(22, 22, 6)).toBe(true);
    expect(isHourInWindow(23, 22, 6)).toBe(true);
    expect(isHourInWindow(0, 22, 6)).toBe(true);
    expect(isHourInWindow(3, 22, 6)).toBe(true);
    expect(isHourInWindow(5, 22, 6)).toBe(true);

    // Bloqueia das 6h em diante até as 21h59
    expect(isHourInWindow(6, 22, 6)).toBe(false);
    expect(isHourInWindow(12, 22, 6)).toBe(false);
    expect(isHourInWindow(21, 22, 6)).toBe(false);
  });

  it("janela de 1 hora só vale na própria hora (10h às 10h)", () => {
    expect(isHourInWindow(10, 10, 10)).toBe(true);
    expect(isHourInWindow(9, 10, 10)).toBe(false);
    expect(isHourInWindow(11, 10, 10)).toBe(false);
  });

  it("isWithinHourWindow com hora atual do sistema", () => {
    const h = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(new Date()));
    expect(isWithinHourWindow(0, 23)).toBe(true);
    expect(isWithinHourWindow(h, h + 1)).toBe(true);
  });
});

describe("shouldEmitCampaignWarning — Debounce de CAMPAIGN_WARNING", () => {
  beforeEach(() => {
    resetCampaignWarningThrottleForTests();
  });

  it("suprime avisos idênticos em < 30 min e volta a emitir se mudar mensagem ou expirar cooldown", () => {
    const t0 = 1_700_000_000_000;
    expect(shouldEmitCampaignWarning("camp-1", "out_of_hours", "Fora do horário", t0)).toBe(true);
    // Mesmo aviso dentro de 30 min -> suprimido
    expect(shouldEmitCampaignWarning("camp-1", "out_of_hours", "Fora do horário", t0 + 5 * 60_000)).toBe(false);
    // Outro motivo ou outra campanha -> independe
    expect(shouldEmitCampaignWarning("camp-2", "out_of_hours", "Fora do horário", t0 + 5 * 60_000)).toBe(true);
    // Mudou a mensagem -> emite imediatamente
    expect(shouldEmitCampaignWarning("camp-1", "out_of_hours", "Janela alterada", t0 + 6 * 60_000)).toBe(true);
    // Passou 30 min -> volta a emitir
    expect(shouldEmitCampaignWarning("camp-1", "out_of_hours", "Janela alterada", t0 + 37 * 60_000)).toBe(true);
  });
});
