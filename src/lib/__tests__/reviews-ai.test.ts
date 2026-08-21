import { describe, it, expect } from "vitest";
import { formatReviewLine, buildReviewsInput, DEFAULT_REVIEWS_PROMPT } from "@/lib/reviews-ai";
import { renderTemplate } from "@/lib/template-vars";

describe("reviews-ai", () => {
  it("formatReviewLine formata com nota, data e texto limpo (sem autor — ruído)", () => {
    const line = formatReviewLine({
      autor: "João Silva",
      nota: "5",
      data: "há 2 semanas",
      texto: "Atendimento excelente!\nSuper recomendo.",
    });
    expect(line).toBe('- (5★ · há 2 semanas) "Atendimento excelente! Super recomendo."');
  });

  it("formatReviewLine corta review gigante em ~450 chars sem quebrar palavra", () => {
    const longo = "Frase inicial completa. ".repeat(100) + "final";
    const line = formatReviewLine({ nota: "4", texto: longo });
    expect(line.length).toBeLessThan(520);
    expect(line.endsWith('…"')).toBe(true);
  });

  it("formatReviewLine ignora review sem texto", () => {
    expect(formatReviewLine({ autor: "X", nota: "5", texto: "" })).toBe("");
    expect(formatReviewLine(null as any)).toBe("");
  });

  it("buildReviewsInput consolida reviews_detalhes + featured_reviews sem duplicar", () => {
    const lead = {
      nome_negocio: "Pizzaria Bella",
      ramo_negocio: "Pizzaria",
      avaliacao: 4.8,
      reviews: 120,
      reviews_detalhes: [
        { autor: "Maria", nota: "5", texto: "Melhor pizza da cidade, massa fininha!" },
        { autor: "Carlos", nota: "3", texto: "Demorou 1 hora pra entregar no sábado." },
      ],
      featured_reviews: [
        // duplicada (mesmo texto) — deve dedup
        { autor: "Maria", nota: "5", texto: "Melhor pizza da cidade, massa fininha!" },
        // nova
        { autor: "Ana", nota: "5", texto: "Ambiente agradável e garçons simpáticos." },
      ],
      review_topics: { "massa fina": 12, entrega: 8 },
      distribuicao_estrelas: { 5: 90, 4: 20, 3: 5, 2: 3, 1: 2 },
    };
    const input = buildReviewsInput(lead);
    expect(input).toContain("NEGÓCIO: Pizzaria Bella · RAMO: Pizzaria");
    expect(input).toContain("NOTA MÉDIA GOOGLE: 4.8/5 (120 avaliações)");
    expect(input).toContain("TÓPICOS DO GOOGLE: massa fina: 12 · entrega: 8");
    expect(input).toContain("DISTRIBUIÇÃO: 1★:2 · 2★:3 · 3★:5 · 4★:20 · 5★:90");
    expect(input).toContain("AVALIAÇÕES (3 capturadas):");
    expect(input).toContain("Melhor pizza");
    expect(input).toContain("Demorou 1 hora");
    expect(input).toContain("Ambiente agradável");
  });

  it("buildReviewsInput com volume grande: 1★ entra mesmo com 300 reviews 5★ na frente", () => {
    const reviews: any[] = [];
    for (let i = 0; i < 300; i++) reviews.push({ autor: `A${i}`, nota: "5", data: `há ${i} dias`, texto: `Atendimento maravilhoso número ${i}, recomendo demais, voltarei com certeza.` });
    for (let i = 0; i < 30; i++) reviews.push({ autor: `R${i}`, nota: "1", data: `há ${i} dias`, texto: `Péssimo atendimento, demorou 2 horas e ninguém respondeu no WhatsApp.` });
    const input = buildReviewsInput({ nome_negocio: "Grande", reviews_detalhes: reviews });
    // orçamento respeitado
    expect(input.length).toBeLessThanOrEqual(16000);
    // segmento de queixa PRESENTE (antes era cortado pela cauda)
    expect(input).toContain("Péssimo atendimento");
    // rodízio: as primeiras linhas já misturam 1★ e 5★
    const first10 = input.split("\n").filter((l) => l.startsWith("- (")).slice(0, 10);
    expect(first10.some((l) => l.includes("1★"))).toBe(true);
    expect(first10.some((l) => l.includes("5★"))).toBe(true);
    // rodapé de transparência mostra o que não entrou (todas as 1★ couberam; sobrou só cauda 5★)
    expect(input).toMatch(/não incluídas por limite de tamanho: 5★: \d+/);
    expect(input).not.toMatch(/1★: \d+ —/);
  });

  it("buildReviewsInput entra TUDO quando cabe no orçamento (sem perda)", () => {
    const reviews = [
      { autor: "A", nota: "5", texto: "bom" },
      { autor: "B", nota: "4", texto: "ok" },
      { autor: "C", nota: "2", texto: "ruim" },
    ];
    const input = buildReviewsInput({ nome_negocio: "Peq", reviews_detalhes: reviews });
    expect(input).toContain("(3 capturadas):");
    expect(input).toContain("bom");
    expect(input).toContain("ok");
    expect(input).toContain("ruim");
    expect(input).not.toContain("não incluídas");
  });

  it("DEFAULT_REVIEWS_PROMPT pede elogios, reclamações e gancho", () => {
    expect(DEFAULT_REVIEWS_PROMPT).toContain("ELOGIOS");
    expect(DEFAULT_REVIEWS_PROMPT).toContain("RECLAMAÇÕES");
    expect(DEFAULT_REVIEWS_PROMPT).toContain("GANCHO");
  });

  it("renderTemplate substitui {{resumo_avaliacoes}} quando presente no contexto", () => {
    const resumo = "ELOGIOS: comida boa. RECLAMAÇÕES: demora. GANCHO: vi que elogiam a comida mas sofrem com fila.";
    const tpl = "Olá {{nome_empresa}}! {{resumo_avaliacoes}}";
    const out = renderTemplate(tpl, {
      nome_negocio: "Restaurante Bom Sabor",
      resumo_avaliacoes: resumo,
    });
    expect(out).toBe(`Olá Restaurante Bom Sabor! ${resumo}`);
  });

  it("renderTemplate resolve {resumo_avaliacoes} (chaves simples) também", () => {
    const resumo = "Gancho top";
    const tpl = "Info: {resumo_avaliacoes}";
    const out = renderTemplate(tpl, { resumo_avaliacoes: resumo });
    expect(out).toBe("Info: Gancho top");
  });

  it("renderTemplate deixa {{resumo_avaliacoes}} vazio quando ausente (sem vazar a tag)", () => {
    const tpl = "Olá {{nome_empresa}}! {{resumo_avaliacoes}}";
    const out = renderTemplate(tpl, { nome_negocio: "Loja X" });
    expect(out).toBe("Olá Loja X! ");
  });
});
