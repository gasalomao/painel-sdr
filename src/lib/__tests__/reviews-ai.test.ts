import { describe, it, expect } from "vitest";
import { formatReviewLine, buildReviewsInput, DEFAULT_REVIEWS_PROMPT } from "@/lib/reviews-ai";
import { renderTemplate } from "@/lib/template-vars";

describe("reviews-ai", () => {
  it("formatReviewLine formata com autor, nota, data e texto limpo", () => {
    const line = formatReviewLine({
      autor: "João Silva",
      nota: "5",
      data: "há 2 semanas",
      texto: "Atendimento excelente!\nSuper recomendo.",
    });
    expect(line).toBe('- (5★ · há 2 semanas) João Silva: "Atendimento excelente! Super recomendo."');
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
