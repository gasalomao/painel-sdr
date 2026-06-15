import { describe, it, expect } from "vitest";
import { renderTemplate, greetingFor } from "../template-vars";

/**
 * Cobre o bug real: o disparo saiu com "{{saudacao}}, estou falando com a
 * {{nome_empresa}}?" literal — variáveis não substituídas. Estes testes
 * garantem que renderTemplate resolve as variáveis do disparo.
 */
describe("renderTemplate — variáveis do disparo", () => {
  // 'now' fixo (14h SP) pra a saudação ser determinística nos testes.
  const tarde = new Date("2026-05-22T17:00:00.000Z"); // 14h em São Paulo (UTC-3)

  it("substitui {{saudacao}} e {{nome_empresa}} — o caso exato do bug", () => {
    const out = renderTemplate(
      "{{saudacao}}, estou falando com a {{nome_empresa}}?",
      { nome_negocio: "Carvalho & Santos", now: tarde },
    );
    expect(out).toBe("Boa tarde, estou falando com a Carvalho & Santos?");
    expect(out).not.toContain("{{");
  });

  it("lembrete de agendamento: resolve {nome}, {servico} e {meet_link} via `variables`", () => {
    // Bug real: o lembrete saía "Oi ! ... ({servico})" — {nome} vazio e
    // {servico} literal. O worker agora passa as vars de agendamento em
    // `variables` (mapa dinâmico), que renderTemplate resolve por qualquer chave.
    const out = renderTemplate(
      "Oi {nome}! Em 1h é o seu agendamento ({servico}). Link: {meet_link}",
      { variables: { nome: "Carol", servico: "Consulta", meet_link: "https://meet.google.com/abc" } },
    );
    expect(out).toBe("Oi Carol! Em 1h é o seu agendamento (Consulta). Link: https://meet.google.com/abc");
    expect(out).not.toContain("{servico}");
    expect(out).not.toContain("{meet_link}");
  });

  it("substitui o template padrão da automação", () => {
    const out = renderTemplate(
      "{{saudacao}} {{nome_empresa}}! Sou da Sarah Tech, vi sua empresa no Maps.",
      { nome_negocio: "Padaria do Zé", now: tarde },
    );
    expect(out).toBe("Boa tarde Padaria do Zé! Sou da Sarah Tech, vi sua empresa no Maps.");
  });

  it("resolve variáveis extras do lead ({{ramo}}, {{endereco}}, {{website}})", () => {
    const out = renderTemplate(
      "Vi que a {{nome_empresa}} atua em {{ramo}} — site {{website}}.",
      { nome_negocio: "ABC", ramo_negocio: "Advocacia", website: "abc.com.br", now: tarde },
    );
    expect(out).toBe("Vi que a ABC atua em Advocacia — site abc.com.br.");
  });

  it("variável desconhecida fica intacta (não quebra, mas é detectável)", () => {
    const out = renderTemplate("Oi {{variavel_inexistente}}", { now: tarde });
    expect(out).toBe("Oi {{variavel_inexistente}}");
  });

  it("render idempotente — rodar 2x (rede de segurança) não muda o resultado", () => {
    const tpl = "{{saudacao}}, {{nome_empresa}}!";
    const once = renderTemplate(tpl, { nome_negocio: "XPTO", now: tarde });
    const twice = renderTemplate(once, { nome_negocio: "XPTO", now: tarde });
    expect(twice).toBe(once);
    expect(twice).toBe("Boa tarde, XPTO!");
  });

  it("nome_empresa vazio vira string vazia, não fica {{nome_empresa}}", () => {
    const out = renderTemplate("Olá {{nome_empresa}}", { now: tarde });
    expect(out).toBe("Olá ");
  });

  it("greetingFor cobre as 4 faixas do dia", () => {
    expect(greetingFor(new Date("2026-05-22T06:00:00.000Z"))).toBe("Boa madrugada"); // 03h SP
    expect(greetingFor(new Date("2026-05-22T12:00:00.000Z"))).toBe("Bom dia");       // 09h SP
    expect(greetingFor(new Date("2026-05-22T18:00:00.000Z"))).toBe("Boa tarde");     // 15h SP
    expect(greetingFor(new Date("2026-05-22T23:00:00.000Z"))).toBe("Boa noite");     // 20h SP
  });
});
