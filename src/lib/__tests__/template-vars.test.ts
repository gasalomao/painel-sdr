import { describe, it, expect } from "vitest";
import {
  renderTemplate,
  greetingFor,
  leadRowToTemplateContext,
  PROMPT_VARIABLES,
  TEMPLATE_VARIABLES,
} from "../template-vars";
import {
  DEFAULT_PREVIEW_SAMPLE,
  leadToPreviewSample,
} from "@/app/agente/_components/lead-selector";

/**
 * Cobre o bug real: o disparo saiu com "{{saudacao}}, estou falando com a
 * {{nome_empresa}}?" literal — variáveis não substituídas. Estes testes
 * garantem que renderTemplate resolve as variáveis do disparo e do Agente IA.
 */
describe("renderTemplate — variáveis do disparo e Google Maps", () => {
  // 'now' fixo (14h SP) pra a saudação ser determinística nos testes.
  const tarde = new Date("2026-05-22T17:00:00.000Z"); // sexta-feira, 22/05/2026 14h em São Paulo (UTC-3)

  it("substitui {{saudacao}} e {{nome_empresa}} — o caso exato do bug", () => {
    const out = renderTemplate(
      "{{saudacao}}, estou falando com a {{nome_empresa}}?",
      { nome_negocio: "Carvalho & Santos", now: tarde },
    );
    expect(out).toBe("Boa tarde, estou falando com a Carvalho & Santos?");
    expect(out).not.toContain("{{");
  });

  it("lembrete de agendamento: resolve {nome}, {servico} e {meet_link} via `variables`", () => {
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

  it("alias {{nome_negocio}} resolve igual a {{nome_empresa}} (coluna do CRM)", () => {
    const out = renderTemplate("Olá {{nome_negocio}}!", { nome_negocio: "Padaria Pão Quente", now: tarde });
    expect(out).toBe("Olá Padaria Pão Quente!");
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

  it("resolve o bloco exato de DADOS DO CLIENTE no Agente IA ({{nota}}, {{avaliacoes}}, {{data_atual}})", () => {
    const prompt = [
      "# 2. DADOS DO CLIENTE (VARIÁVEIS)",
      '- Empresa: "{{nome_empresa}}"',
      '- Ramo: "{{ramo}}"',
      '- Nota no Google: "{{nota}}"',
      '- Quantidade de Avaliações: "{{avaliacoes}}"',
      '- Data e Dia de Hoje (se disponível): "{{data_atual}}"',
    ].join("\n");

    const ctx = leadRowToTemplateContext(DEFAULT_PREVIEW_SAMPLE as Record<string, unknown>, { now: tarde });
    const rendered = renderTemplate(prompt, ctx);

    expect(rendered).toContain('- Empresa: "Padaria Centro"');
    expect(rendered).toContain('- Ramo: "Alimentação"');
    expect(rendered).toContain('- Nota no Google: "4.8"');
    expect(rendered).toContain('- Quantidade de Avaliações: "127"');
    expect(rendered).toContain('- Data e Dia de Hoje (se disponível): "sexta-feira, 22/05/2026"');
    expect(rendered).not.toContain("{{");
  });

  it("resolve todas as variáveis ricas do Google Maps e seus aliases a partir de uma linha de leads_extraidos", () => {
    const dbLeadRow = {
      id: 42,
      remoteJid: "5511988887777@s.whatsapp.net",
      nome_negocio: "Clínica Sorriso Perfeito Ltda",
      ramo_negocio: "Odontologia",
      categoria: "Dentista",
      endereco: "Av. Paulista, 1000 - Bela Vista, São Paulo - SP, 01310-100, Brasil",
      website: "https://sorrisoperfeito.com.br",
      telefone: "11988887777",
      avaliacao: 4.9,
      reviews: 312,
      resumo_avaliacoes: "Pacientes destacam pontualidade e implantes sem dor.",
      year_established: "2019",
      instagram: "@sorrisoperfeito",
      facebook: "facebook.com/sorrisoperfeito",
      maps_url: "https://maps.google.com/?cid=999",
      price_range: "$$$",
      open_now: "Aberto ⋅ Fecha às 19:00",
      opening_hours: { "segunda-feira": "08:00–19:00", "terça-feira": "08:00–19:00" },
      attributes: ["Acessível para cadeirantes", "Wi-Fi gratuito"],
      owner_name: "Dra. Mariana Costa",
      claimed: true,
      business_status: "Operacional",
      total_photo_count: 85,
      review_topics: { implante: "24", atendimento: "19" },
      additional_categories: ["Ortodontista", "Clínica de estética dental"],
      featured_reviews: ["Melhor dentista da região", "Atendimento impecável"],
      distribuicao_estrelas: { "5estrelas": 290, "4estrelas": 20, "1estrelas": 2 },
      business_details: {
        descricao: "Clínica odontológica especializada em implantes e lentes.",
        services: ["Implantes", "Clareamento"],
        menuUrl: "https://sorrisoperfeito.com.br/tratamentos",
        reservaUrl: "https://sorrisoperfeito.com.br/agendar",
      },
      link_previa: "https://clinica-sorriso.vercel.app",
    };

    const ctx = leadRowToTemplateContext(dbLeadRow, { now: tarde });
    const tpl = [
      "Nota: {{nota}} / {{avaliacao}} / {{nota_google}} / {{rating}}",
      "Reviews: {{avaliacoes}} / {{reviews}} / {{qtd_avaliacoes}} / {{total_avaliacoes}}",
      "Resumo: {{resumo_avaliacoes}}",
      "Ano Maps: {{ano_google}} / {{desde_ano}} / {{year_established}}",
      "Local: {{rua}} | {{bairro}} | {{cidade}} | {{estado}} ({{uf}}) | {{cep}}",
      "Links: {{website}} | {{site}} | {{instagram}} | {{facebook}} | {{maps_url}} | {{link_maps}} | {{link_previa}}",
      "Funcionamento: {{horario_funcionamento}} | {{aberto_agora}} | {{faixa_preco}}",
      "Extras: {{atributos}} | {{proprietario}} | {{reivindicado}} | {{situacao_empresa}} | {{total_fotos}}",
      "Tópicos: {{topicos_avaliacoes}} | Categorias: {{categorias_adicionais}}",
      "Sobre: {{descricao_google}} | Serviços: {{servicos_google}} | Menu: {{menu_url}} | Reserva: {{reserva_url}}",
      "Data: {{dia_semana}} | {{data_atual}} | {{ano_atual}}",
    ].join("\n");

    const out = renderTemplate(tpl, ctx);
    expect(out).not.toContain("{{");
    expect(out).toContain("Nota: 4.9 / 4.9 / 4.9 / 4.9");
    expect(out).toContain("Reviews: 312 / 312 / 312 / 312");
    expect(out).toContain("Resumo: Pacientes destacam pontualidade e implantes sem dor.");
    expect(out).toContain("Ano Maps: 2019 / 2019 / 2019");
    expect(out).toContain("Local: Av. Paulista, 1000 | Bela Vista | São Paulo | SP (SP) | 01310-100");
    expect(out).toContain("Links: https://sorrisoperfeito.com.br | https://sorrisoperfeito.com.br | @sorrisoperfeito | facebook.com/sorrisoperfeito | https://maps.google.com/?cid=999 | https://maps.google.com/?cid=999 | https://clinica-sorriso.vercel.app");
    expect(out).toContain("Funcionamento: segunda-feira: 08:00–19:00 | terça-feira: 08:00–19:00 | Aberto ⋅ Fecha às 19:00 | $$$");
    expect(out).toContain("Extras: Acessível para cadeirantes, Wi-Fi gratuito | Dra. Mariana Costa | Sim | Operacional | 85");
    expect(out).toContain("Tópicos: implante (24), atendimento (19) | Categorias: Ortodontista, Clínica de estética dental");
    expect(out).toContain("Sobre: Clínica odontológica especializada em implantes e lentes. | Serviços: Implantes, Clareamento");
    expect(out).toContain("Data: sexta-feira | sexta-feira, 22/05/2026 | 2026");

    // Também valida que leadToPreviewSample popula o simulador da UI com todos os campos do Maps
    const sample = leadToPreviewSample(dbLeadRow as any);
    expect(sample.avaliacao).toBe("4.9");
    expect(sample.reviews).toBe("312");
    expect(sample.ano_google).toBe("2019");
    expect(sample.cidade).toBe("São Paulo");
    expect(sample.bairro).toBe("Bela Vista");
    expect(sample.estado).toBe("SP");
    expect(sample.cep).toBe("01310-100");
    expect(sample.proprietario).toBe("Dra. Mariana Costa");
    expect(sample.total_fotos).toBe("85");
  });

  it("todas as variáveis em PROMPT_VARIABLES resolvem com valor não-vazio usando DEFAULT_PREVIEW_SAMPLE", () => {
    const ctx = leadRowToTemplateContext(DEFAULT_PREVIEW_SAMPLE as Record<string, unknown>, { now: tarde });
    for (const v of PROMPT_VARIABLES) {
      const val = renderTemplate(`{{${v.key}}}`, ctx);
      expect(val, `Variável {{${v.key}}} deveria resolver no sample padrão`).not.toBe(`{{${v.key}}}`);
      expect(val.trim().length, `Variável {{${v.key}}} não deveria ficar vazia no sample padrão`).toBeGreaterThan(0);
    }
    expect(TEMPLATE_VARIABLES.length).toBeGreaterThan(PROMPT_VARIABLES.length);
  });
});
