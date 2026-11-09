import { describe, expect, it } from "vitest";
import {
  applyAntiBanMixer,
  cleanCompanyNameForApproach,
  effectiveDateForWindow,
  isDefaultApproachTemplate,
  syncGreetingToCurrentHour,
} from "../antiban-mixer";
import { greetingFor } from "../template-vars";

describe("antiban-mixer & saudação inteligente por horário real", () => {
  it("atualiza 'Boa madrugada' pré-gerada na madrugada para 'Bom dia' quando o disparo sai às 9h (America/Sao_Paulo)", () => {
    // 09:15 BRT = 12:15 UTC
    const nineAmBrt = new Date("2026-11-09T12:15:00.000Z");
    const preGeneratedAtMidnight = "Boa madrugada! Tudo bem? Vidraçaria Silva?";
    const synced = syncGreetingToCurrentHour(preGeneratedAtMidnight, nineAmBrt);
    expect(synced).toBe("Bom dia! Tudo bem? Vidraçaria Silva?");
  });

  it("preserva caixa baixa quando a saudação está no meio da frase ('Oi, boa madrugada' -> 'Oi, bom dia')", () => {
    const nineAmBrt = new Date("2026-11-09T12:15:00.000Z");
    const msg = "Oi, boa madrugada! Tudo bem por aí? É da Vidraçaria Silva?";
    expect(syncGreetingToCurrentHour(msg, nineAmBrt)).toBe(
      "Oi, bom dia! Tudo bem por aí? É da Vidraçaria Silva?"
    );
  });

  it("atualiza para 'Boa tarde' às 14h e 'Boa noite' às 20h", () => {
    const twoPmBrt = new Date("2026-11-09T17:00:00.000Z"); // 14:00 BRT
    const eightPmBrt = new Date("2026-11-09T23:00:00.000Z"); // 20:00 BRT
    expect(syncGreetingToCurrentHour("Bom dia! Tudo bem? Clínica Sorriso?", twoPmBrt)).toBe(
      "Boa tarde! Tudo bem? Clínica Sorriso?"
    );
    expect(syncGreetingToCurrentHour("Bom dia! Tudo bem? Clínica Sorriso?", eightPmBrt)).toBe(
      "Boa noite! Tudo bem? Clínica Sorriso?"
    );
  });

  it("effectiveDateForWindow ajusta horário da madrugada (00h30) para a abertura da janela (08h00)", () => {
    // 00:30 BRT = 03:30 UTC
    const midnightBrt = new Date("2026-11-09T03:30:00.000Z");
    const adjusted = effectiveDateForWindow(midnightBrt, 8, 18);
    expect(greetingFor(adjusted)).toBe("Bom dia");
  });

  it("limpa caudas de SEO do Google Maps, sufixos jurídicos (LTDA/MEI) e CAIXA ALTA no nome da empresa", () => {
    expect(cleanCompanyNameForApproach("Vidraçaria Silva - Box, Espelhos e Fechamento de Sacada")).toBe(
      "Vidraçaria Silva"
    );
    expect(cleanCompanyNameForApproach("ADVOCACIA MEDEIROS | Advogado Trabalhista LTDA")).toBe(
      "Advocacia Medeiros"
    );
    expect(cleanCompanyNameForApproach("Clínica Odontológica Sorriso MEI")).toBe(
      "Clínica Odontológica Sorriso"
    );
  });

  it("reconhece o template base padrão '{{saudacao}}! Tudo bem? {{nome_empresa}}?'", () => {
    expect(isDefaultApproachTemplate("{{saudacao}}! Tudo bem? {{nome_empresa}}?")).toBe(true);
    expect(isDefaultApproachTemplate("{{saudacao}}! Tudo bem?  {{nome_empresa}}?")).toBe(true);
    expect(isDefaultApproachTemplate("{{saudacao}}! Tudo bem? {{nome_empresa}}")).toBe(true);
    expect(isDefaultApproachTemplate("Olá, veja nossa promoção especial de sites")).toBe(false);
  });

  it("mistura variações sem repetir duas seguidas e mantém o sentido com saudação do horário real", () => {
    const nineAmBrt = new Date("2026-11-09T12:00:00.000Z"); // 09:00 BRT -> Bom dia
    const template = "{{saudacao}}! Tudo bem? {{nome_empresa}}?";
    const results: string[] = [];

    for (let i = 0; i < 15; i++) {
      const msg = applyAntiBanMixer({
        template,
        renderedFallback: "Boa madrugada! Tudo bem? VIDRAÇARIA SILVA - BOX E ESPELHOS LTDA?",
        companyName: "VIDRAÇARIA SILVA - BOX E ESPELHOS LTDA",
        enabled: true,
        scopeKey: "test-campaign-1",
        now: nineAmBrt,
      });
      expect(msg.toLowerCase()).toContain("bom dia");
      expect(msg).toContain("Vidraçaria Silva");
      expect(msg).not.toContain("LTDA");
      expect(msg).not.toContain("BOX E ESPELHOS");
      if (results.length > 0) {
        expect(msg).not.toBe(results[results.length - 1]);
      }
      results.push(msg);
    }

    // Deve ter gerado múltiplas variações distintas
    expect(new Set(results).size).toBeGreaterThan(5);
  });

  it("quando Misturador Anti-Ban está desativado (enabled=false), mantém o texto fixo mas corrige a saudação para o horário atual", () => {
    const nineAmBrt = new Date("2026-11-09T12:00:00.000Z"); // 09:00 BRT -> Bom dia
    const msg = applyAntiBanMixer({
      template: "{{saudacao}}! Tudo bem? {{nome_empresa}}?",
      renderedFallback: "Boa madrugada! Tudo bem? Vidraçaria Silva?",
      companyName: "Vidraçaria Silva",
      enabled: false,
      scopeKey: "test-campaign-off",
      now: nineAmBrt,
    });
    expect(msg).toBe("Bom dia! Tudo bem? Vidraçaria Silva?");
  });
});

