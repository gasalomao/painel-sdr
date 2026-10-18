/**
 * Cobertura dos helpers de filtro antecipado e dedupe de place do scraper.
 * A ordem de precedência dos motivos é contrato da UI de logs:
 * Sem telefone > Telefone duplicado > Telefone fixo > Com site.
 */
import { describe, expect, it } from "vitest";
import { evaluateLeadFilters, placeUrlKey, type Lead } from "../scraper-engine";

const settings = {
  filterEmpty: true,
  filterDuplicates: true,
  filterLandlines: true,
  filterWithWebsite: true,
};

const lead = (phones: string): Lead => ({
  name: "X",
  phones,
  remoteJid: "",
  fullAddress: "",
  categories: "",
  averageRating: "",
  reviewCount: "",
  website: "",
  instagram: "",
  facebook: "",
  extractedAt: "",
});

describe("evaluateLeadFilters", () => {
  it("passa lead com celular válido e sem site", () => {
    const r = evaluateLeadFilters("5511999998888", "", settings, []);
    expect(r.pass).toBe(true);
    expect(r.reason).toBe("");
  });

  it("descarta sem telefone antes de qualquer outro motivo", () => {
    expect(evaluateLeadFilters("", "site.com", settings, []).reason).toBe("Sem telefone");
  });

  it("descarta telefone duplicado contra leads já capturados", () => {
    expect(evaluateLeadFilters("5511999998888", "", settings, [lead("+55 (11) 99999-8888")]).reason).toBe("Telefone duplicado");
  });

  it("descarta telefone fixo", () => {
    expect(evaluateLeadFilters("551133334444", "", settings, []).reason).toBe("Telefone fixo");
  });

  it("descarta com site mesmo tendo celular válido", () => {
    expect(evaluateLeadFilters("5511999998888", "https://exemplo.com", settings, []).reason).toBe("Com site");
  });

  it("filtra pelo total inclusivo antes das reviews profundas, não pela nota", () => {
    const filtered = { minReviews: 100 };
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "99").pass).toBe(false);
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "100").pass).toBe(true);
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "").pass).toBe(false);
    expect(evaluateLeadFilters("5511999998888", "", {}, [], "").pass).toBe(true);
  });

  it("exige perfil confirmado somente com o filtro Instagram ativo", () => {
    const filtered = { filterWithInstagram: true };
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "", "")).toEqual({ pass: false, reason: "Sem Instagram" });
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "", "https://instagram.com/loja/").pass).toBe(true);
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "", "https://fakeinstagram.com/loja/").pass).toBe(false);
    expect(evaluateLeadFilters("5511999998888", "", {}, [], "", "").pass).toBe(true);
    expect(evaluateLeadFilters("5511999998888", "", { filterWithInstagram: false }, [], "", "").pass).toBe(true);
  });

  it("combina Instagram, mínimo de avaliações e filtros anteriores sem alterar precedência", () => {
    const filtered = { ...settings, minReviews: 100, filterWithInstagram: true };
    expect(evaluateLeadFilters("", "", filtered, [], "100", "").reason).toBe("Sem telefone");
    expect(evaluateLeadFilters("5511999998888", "https://site.com", filtered, [], "100", "https://instagram.com/loja/").reason).toBe("Com site");
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "99", "https://instagram.com/loja/").pass).toBe(false);
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "100", "").reason).toBe("Sem Instagram");
    expect(evaluateLeadFilters("5511999998888", "", filtered, [], "100", "https://instagram.com/loja/").pass).toBe(true);
  });

  it("respeita flags desligadas", () => {
    const off = { filterEmpty: false, filterDuplicates: false, filterLandlines: false, filterWithWebsite: false };
    expect(evaluateLeadFilters("", "site.com", off, []).pass).toBe(true);
  });
});

describe("placeUrlKey", () => {
  it("mesmo place em buscas diferentes (viewports distintos) gera a mesma chave", () => {
    const a = "https://www.google.com/maps/place/NTH/@-23.55,-46.63,17z/data=!1m1!123abc?hl=pt-BR";
    const b = "https://www.google.com/maps/place/NTH/@-23.60,-46.70,15z/data=!1m1!123abc";
    expect(placeUrlKey(a)).toBe(placeUrlKey(b));
  });

  it("places diferentes geram chaves diferentes", () => {
    const a = "https://www.google.com/maps/place/A/@-23.5,-46.6,17z/data=!1m1!aaa";
    const b = "https://www.google.com/maps/place/B/@-23.5,-46.6,17z/data=!1m1!bbb";
    expect(placeUrlKey(a)).not.toBe(placeUrlKey(b));
  });
});
