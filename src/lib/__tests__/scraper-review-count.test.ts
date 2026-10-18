import { describe, expect, it } from "vitest";
import { extractGoogleReviewCount, parseGoogleReviewCount, parseMinReviews, reviewCountFilterReason } from "../scraper-review-count";

describe("quantidade agregada de avaliações", () => {
  it.each([
    ["0", 0], ["123", 123], ["1.234", 1234], ["1,234", 1234],
    ["1 234", 1234], ["1\u00a0234", 1234], ["1\u202f234", 1234],
    ["1.234.567", 1234567], ["1.2k", 1200], ["2,5K", 2500],
    ["1,2 mil", 1200], ["3M", 3000000],
  ])("normaliza %s sem confundir separadores e abreviações", (raw, expected) => {
    expect(parseGoogleReviewCount(raw)).toBe(expected);
  });

  it.each(["", "desconhecido", "4,8", "4.8", "-5", "1e3", "123 comentários", "4,8 (123)", null, undefined, "9999999999999999"])("não inventa total para %s", (raw) => {
    expect(parseGoogleReviewCount(raw)).toBeNull();
  });

  it.each([
    [["4,8 estrelas", "(123)"], "123"],
    [["4,8(1.234) · Pizzaria"], "1.234"],
    [["4,8 · (1\u00a0234)"], "1\u00a0234"],
    [["1,2 mil avaliações"], "1,2 mil"],
    [["1.2k reviews", "1,234 avaliações"], "1,234"],
    [["Avaliação 4,8 de 5", "Telefone (11) 99999-8888"], ""],
    [["Rua 123 (400) - São Paulo"], ""],
    [["5 estrelas (100)"], "100"],
    [["123 avaliações", "4,8 estrelas"], "123"],
    [["4,5 estrelas 4.659 comentários"], "4.659"],
    [["4.8 1,234 reviews"], "1,234"],
    [["4,8\n123 avaliações"], "123"],
    [["Rated 4.8 out of 5, 123 reviews"], "123"],
    [["1 234 avaliações"], "1 234"],
    [["Avaliações de clientes"], ""],
  ])("extrai só o total agregado de %j", (sources, expected) => {
    expect(extractGoogleReviewCount(sources)).toBe(expected);
  });

  it("preserva o cartão exato se o painel só trouxer aproximação", () => {
    expect(extractGoogleReviewCount(["1,2 mil avaliações"], "1.234")).toBe("1.234");
    expect(extractGoogleReviewCount(["1.250 avaliações"], "1.234")).toBe("1.250");
    expect(extractGoogleReviewCount(["1.234 avaliações"], "1,2 mil")).toBe("1.234");
    expect(extractGoogleReviewCount([], "1,2 mil")).toBe("1,2 mil");
    expect(extractGoogleReviewCount([], "inválido")).toBe("");
  });

  it("desativa apenas quando o mínimo é zero ou ausente", () => {
    expect(parseMinReviews(undefined)).toBe(0);
    expect(parseMinReviews(0)).toBe(0);
    expect(parseMinReviews(150)).toBe(150);
    expect(parseMinReviews(2147483647)).toBe(2147483647);
    for (const value of [null, -1, 1.5, "100", true, {}, NaN, Infinity, 2147483648]) {
      expect(parseMinReviews(value)).toBeNull();
    }
    expect(reviewCountFilterReason("", 0)).toBe("");
  });

  it("inclui o limiar e independe da nota ou comentários", () => {
    expect(reviewCountFilterReason("99", 100)).not.toBe("");
    expect(reviewCountFilterReason("100", 100)).toBe("");
    expect(reviewCountFilterReason("101", 100)).toBe("");
  });

  it("desconhecido usa os detalhes existentes, mas não passa na defesa final", () => {
    expect(reviewCountFilterReason("", 100, true)).toBe("");
    expect(reviewCountFilterReason("", 100)).toContain("não informada");
    expect(reviewCountFilterReason("0", 100, true)).not.toBe("");
  });

  it("não descarta cartão abreviado e exige margem segura no total aproximado final", () => {
    expect(reviewCountFilterReason("1,2 mil", 1250, true)).toBe("");
    expect(reviewCountFilterReason("1,2 mil", 2000, true)).not.toBe("");
    expect(reviewCountFilterReason("1,2 mil", 1000)).toBe("");
    expect(reviewCountFilterReason("1,2 mil", 1200)).not.toBe("");
    expect(reviewCountFilterReason("1200", 1200)).toBe("");
  });
});
