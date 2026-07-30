import { describe, expect, test } from "vitest";
import { formatResultsForAI, needsFreshWebSearch } from "../web-search";

describe("needsFreshWebSearch", () => {
  test("detecta pedido explícito de pesquisa", () => {
    expect(needsFreshWebSearch("Pesquise na internet o horário desta empresa")).toBe(true);
    expect(needsFreshWebSearch("Procure no Google notícias sobre o mercado")).toBe(true);
  });

  test("detecta assuntos que precisam de dado atual", () => {
    expect(needsFreshWebSearch("Qual a cotação do dólar?")).toBe(true);
    expect(needsFreshWebSearch("Como está o clima hoje em São Paulo?")).toBe(true);
    expect(needsFreshWebSearch("Quem é o presidente atual?")).toBe(true);
  });

  test("não pesquisa conversa comercial comum", () => {
    expect(needsFreshWebSearch("Oi, quero saber mais sobre o produto")).toBe(false);
    expect(needsFreshWebSearch("Qual é o preço do iPhone?")).toBe(false);
  });
});

describe("formatResultsForAI", () => {
  test("preserva título, URL e resumo de cada fonte", () => {
    const text = formatResultsForAI([
      { title: "Fonte oficial", url: "https://exemplo.com", snippet: "Informação atualizada" },
      { title: "Segunda fonte", url: "https://outro.com", snippet: "Confirmação" },
    ]);

    expect(text).toContain("[1] Fonte oficial");
    expect(text).toContain("https://exemplo.com");
    expect(text).toContain("[2] Segunda fonte");
  });
});
