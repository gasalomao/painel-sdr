import { describe, expect, it } from "vitest";
import {
  __resetAntiBanHistoryForTests,
  applyAntiBanMixer,
  cleanCompanyNameForApproach,
  effectiveDateForWindow,
  enforceShortHandshakeGuard,
  generatePersonalizedPraiseOpener,
  isDefaultApproachTemplate,
  isPersonalizedPraiseOpenerTemplate,
  PRAISE_OPENER_PATTERN_COUNTS,
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

  it("enforceShortHandshakeGuard bloqueia URLs e textos comerciais longos gerados pela IA quando o template é curto (Two-Step Handshake)", () => {
    const nineAmBrt = new Date("2026-11-09T12:00:00.000Z");
    const template = "{{saudacao}}! Tudo bem? {{nome_empresa}}?";

    const blockedUrl = enforceShortHandshakeGuard({
      template,
      candidateText: "Bom dia! Veja nossa oferta especial em https://meusite.com.br para a Vidraçaria Silva!",
      companyName: "VIDRAÇARIA SILVA LTDA",
      now: nineAmBrt,
      scopeKey: "test-guard",
    });
    expect(blockedUrl).not.toContain("https://");
    expect(blockedUrl).toContain("Vidraçaria Silva");

    const blockedLongPitch = enforceShortHandshakeGuard({
      template,
      candidateText:
        "Bom dia! Sou consultor especializado em marketing digital e criação de sites de alta conversão e gostaria de apresentar uma proposta completa para aumentar suas vendas ainda esta semana!",
      companyName: "Vidraçaria Silva",
      now: nineAmBrt,
      scopeKey: "test-guard",
    });
    expect(blockedLongPitch.length).toBeLessThanOrEqual(140);
    expect(blockedLongPitch).toContain("Vidraçaria Silva");
  });

  it("Personalized Google/IG Praise + Easy 1-Word Question Opener oferece >= 24 variações (com e sem nota), máx 2 linhas, sem pitch/links/crítica", () => {
    __resetAntiBanHistoryForTests();
    const nineAmBrt = new Date("2026-11-09T12:15:00.000Z"); // 09:15 BRT
    const praiseTemplate =
      "{{saudacao}}! Vi a {{nome_empresa}} no Google com nota {{nota}} ({{avaliacoes}} avaliações).\nHoje vocês têm site próprio ou usam mais Instagram e WhatsApp?";

    expect(isPersonalizedPraiseOpenerTemplate(praiseTemplate)).toBe(true);
    expect(isDefaultApproachTemplate(praiseTemplate)).toBe(false);
    expect(PRAISE_OPENER_PATTERN_COUNTS.total).toBeGreaterThanOrEqual(24);

    // 1. Com nota >= 4.0 e avaliações: 16 variações sintáticas distintas, <= 2 linhas, sem URL/pitch/crítica
    const withRatingSet = new Set<string>();
    for (let i = 0; i < PRAISE_OPENER_PATTERN_COUNTS.withRating; i++) {
      const msg = applyAntiBanMixer({
        template: praiseTemplate,
        companyName: "CLÍNICA SORRISO - IMPLANTES LTDA",
        rating: 4.9,
        reviews: 142,
        now: nineAmBrt,
        scopeKey: "praise-rated",
        deterministicIndex: i,
      });
      const lines = msg.split(/\r?\n/).filter((l) => l.trim().length > 0);
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(msg.toLowerCase()).toContain("bom dia");
      expect(msg).toContain("Clínica Sorriso");
      expect(msg).toContain("4,9");
      expect(msg).toContain("142");
      expect(msg.toLowerCase()).toContain("site próprio");
      expect(msg.toLowerCase()).toContain("instagram");
      expect(msg).not.toMatch(/https?:\/\/|wa\.me|promoção|desconto|não têm site|sem site/i);
      withRatingSet.add(msg);
    }
    expect(withRatingSet.size).toBe(PRAISE_OPENER_PATTERN_COUNTS.withRating);

    // 2. Sem nota ou com nota baixa (< 4.0): cai nas variações sem menção à nota (nunca elogia nota ruim!)
    const withoutRatingSet = new Set<string>();
    for (let i = 0; i < PRAISE_OPENER_PATTERN_COUNTS.withoutRating; i++) {
      const msg = generatePersonalizedPraiseOpener({
        companyName: "Padaria Central MEI",
        rating: 2.8,
        reviews: 12,
        now: nineAmBrt,
        scopeKey: "praise-norating",
        deterministicIndex: i,
      });
      const lines = msg.split(/\r?\n/).filter((l) => l.trim().length > 0);
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(msg).toContain("Padaria Central");
      expect(msg).not.toContain("2,8");
      expect(msg).not.toContain("2.8");
      expect(msg.toLowerCase()).toContain("site próprio");
      withoutRatingSet.add(msg);
    }
    expect(withoutRatingSet.size).toBe(PRAISE_OPENER_PATTERN_COUNTS.withoutRating);

    // 3. enforceShortHandshakeGuard bloqueia URLs, pitch e críticas negativas no 1º contato de elogio
    const guardedCriticism = enforceShortHandshakeGuard({
      template: praiseTemplate,
      candidateText: "Bom dia! Vi que vocês não têm site e estão perdendo clientes. Veja https://agencia.test",
      companyName: "Clínica Sorriso",
      rating: 4.8,
      reviews: 90,
      now: nineAmBrt,
      scopeKey: "praise-guard",
    });
    expect(guardedCriticism).not.toMatch(/https?:\/\/|não têm site|perdendo clientes/i);
    expect(guardedCriticism).toContain("Clínica Sorriso");
    expect(guardedCriticism.split(/\r?\n/).filter(Boolean).length).toBeLessThanOrEqual(2);
  });
});

