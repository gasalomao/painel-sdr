import { describe, it, expect } from "vitest";
import { extractLocation } from "@/lib/lead-intelligence";
import { getNeighboringCities, isValidCityName, extractUFFromText, ufFromCep, computeExpansionCandidates, proximitySearchTerm } from "@/lib/geo-regions";

describe("geo-regions & extractLocation — Expansão inteligente para todo o Brasil", () => {
  it("extractUFFromText identifica corretamente as siglas de estado", () => {
    expect(extractUFFromText("Belo Horizonte - MG")).toBe("MG");
    expect(extractUFFromText("São Paulo - SP")).toBe("SP");
    expect(extractUFFromText("Salvador, BA")).toBe("BA");
    expect(extractUFFromText("Patos de Minas MG")).toBe("MG");
    expect(extractUFFromText("Porto Alegre / RS")).toBe("RS");
    expect(extractUFFromText("Av. Brasil, 100")).toBe(null);
  });

  it("Belo Horizonte retorna cidades vizinhas reais da Grande BH no mesmo estado", () => {
    const bhNeighbors = getNeighboringCities("Belo Horizonte");
    expect(bhNeighbors).toContain("Contagem - MG");
    expect(bhNeighbors).toContain("Betim - MG");
    expect(bhNeighbors).toContain("Nova Lima - MG");
    expect(bhNeighbors).toContain("Santa Luzia - MG");

    const bhShort = getNeighboringCities("BH");
    expect(bhShort).toContain("Contagem - MG");
    expect(bhShort).toContain("Betim - MG");

    const bhFull = getNeighboringCities("Belo Horizonte - MG");
    expect(bhFull).toContain("Contagem - MG");
  });

  it("Capitais de todas as regiões brasileiras têm vizinhas metropolitanas mapeadas", () => {
    // Sudeste
    expect(getNeighboringCities("São Paulo")).toContain("Guarulhos - SP");
    expect(getNeighboringCities("Rio de Janeiro")).toContain("Niterói - RJ");
    expect(getNeighboringCities("Vitória")).toContain("Vila Velha - ES");
    expect(getNeighboringCities("Campinas")).toContain("Paulínia - SP");

    // Sul
    expect(getNeighboringCities("Curitiba")).toContain("São José dos Pinhais - PR");
    expect(getNeighboringCities("Porto Alegre")).toContain("Canoas - RS");
    expect(getNeighboringCities("Florianópolis")).toContain("São José - SC");

    // Centro-Oeste
    expect(getNeighboringCities("Brasília")).toContain("Taguatinga - DF");
    expect(getNeighboringCities("Goiânia")).toContain("Aparecida de Goiânia - GO");
    expect(getNeighboringCities("Cuiabá")).toContain("Várzea Grande - MT");

    // Nordeste
    expect(getNeighboringCities("Salvador")).toContain("Lauro de Freitas - BA");
    expect(getNeighboringCities("Recife")).toContain("Olinda - PE");
    expect(getNeighboringCities("Fortaleza")).toContain("Caucaia - CE");

    // Norte
    expect(getNeighboringCities("Manaus")).toContain("Iranduba - AM");
    expect(getNeighboringCities("Belém")).toContain("Ananindeua - PA");
  });

  it("isValidCityName rejeita nomes de ruas, avenidas e logradouros", () => {
    expect(isValidCityName("· Av. Amazonas")).toBe(false);
    expect(isValidCityName("Av. Amazonas")).toBe(false);
    expect(isValidCityName("Avenida Amazonas")).toBe(false);
    expect(isValidCityName("· R. Riachuelo")).toBe(false);
    expect(isValidCityName("Rua Riachuelo")).toBe(false);
    expect(isValidCityName("R. Francisco Dumont")).toBe(false);
    expect(isValidCityName("Praça Sete")).toBe(false);
    expect(isValidCityName("Rodovia BR-040")).toBe(false);
    expect(isValidCityName("Alameda da Serra")).toBe(false);
    expect(isValidCityName("Centro")).toBe(false);
    expect(isValidCityName("MG")).toBe(false);
    expect(isValidCityName("AM")).toBe(false);
    expect(isValidCityName("SP")).toBe(false);
    expect(isValidCityName("")).toBe(false);
    expect(isValidCityName(null)).toBe(false);
  });

  it("isValidCityName aceita nomes reais de cidades brasileiras (capitais e interior)", () => {
    expect(isValidCityName("Contagem")).toBe(true);
    expect(isValidCityName("Betim")).toBe(true);
    expect(isValidCityName("Nova Lima")).toBe(true);
    expect(isValidCityName("Santa Luzia")).toBe(true);
    expect(isValidCityName("Belo Horizonte")).toBe(true);
    expect(isValidCityName("São Paulo")).toBe(true);
    expect(isValidCityName("Guarulhos")).toBe(true);
    expect(isValidCityName("Patos de Minas")).toBe(true);
    expect(isValidCityName("Juazeiro do Norte")).toBe(true);
    expect(isValidCityName("Chapecó")).toBe(true);
    expect(isValidCityName("Sobral")).toBe(true);
  });

  it("extractLocation extrai cidades e estados corretamente de endereços reais", () => {
    const r1 = extractLocation("Av. do Contorno, 455 - Santa Efigênia, Belo Horizonte - MG, 30110-021");
    expect(r1.cidade).toBe("Belo Horizonte");
    expect(r1.estado).toBe("MG");

    const r2 = extractLocation("R. Sete, 123 - Centro, Contagem - MG, 32010-000");
    expect(r2.cidade).toBe("Contagem");
    expect(r2.estado).toBe("MG");

    const r3 = extractLocation("R. São Paulo, 100 - Bairro Alto, Patos de Minas - MG, 38700-000");
    expect(r3.cidade).toBe("Patos de Minas");
    expect(r3.estado).toBe("MG");

    // Endereço truncado do Maps que contém apenas a rua NÃO deve retornar a rua como cidade
    const rRua = extractLocation("· Av. Amazonas, 1234");
    expect(rRua.cidade).toBe(""); // Rua rejeitada como cidade
  });

  it("ufFromCep infere o estado pelo CEP em todo o Brasil", () => {
    expect(ufFromCep("38700-000")).toBe("MG"); // Patos de Minas
    expect(ufFromCep("01310-100")).toBe("SP"); // Av. Paulista
    expect(ufFromCep("20031-050")).toBe("RJ");
    expect(ufFromCep("60115-000")).toBe("CE");
    expect(ufFromCep("80010-000")).toBe("PR");
    expect(ufFromCep("90010-000")).toBe("RS");
    expect(ufFromCep("88010-000")).toBe("SC");
    expect(ufFromCep("69010-000")).toBeNull(); // AM/RR ambíguo → não arrisca
    expect(ufFromCep("")).toBeNull();
    expect(ufFromCep(null)).toBeNull();
  });

  it("proximitySearchTerm monta busca de proximidade", () => {
    expect(proximitySearchTerm("Petshop", "Paracatu - MG")).toBe("Petshop perto de Paracatu - MG");
  });

  it("computeExpansionCandidates: BH conhecido → vizinhas metropolitanas, rua rejeitada", () => {
    const out = computeExpansionCandidates({
      regions: ["Belo Horizonte"],
      cityCounts: new Map([
        ["Av. Amazonas", 10],     // rua — rejeitada
        ["Contagem - MG", 8],
        ["Manaus - AM", 3],       // outro estado — rejeitada
      ]),
      alreadySearched: new Set(["belo horizonte"]),
      limit: 5,
    });
    expect(out).toContain("Contagem - MG");
    expect(out.some(c => c.includes("Amazonas"))).toBe(false);
    expect(out.some(c => c.includes("Manaus"))).toBe(false);
  });

  it("computeExpansionCandidates: cidade do interior NÃO mapeada expande por cidades colhidas no mesmo estado", () => {
    // Paracatu não está no dicionário — a garantia vem da colheita de endereços.
    const out = computeExpansionCandidates({
      regions: ["Paracatu - MG"],
      cityCounts: new Map([
        ["João Pinheiro - MG", 6],   // colhida do painel de detalhes
        ["Unaí - MG", 4],
        ["Cristalina - GO", 9],      // outro estado — rejeitada mesmo colhendo mais
        ["· Rod. BR-040", 7],        // rua com prefixo — rejeitada
      ]),
      alreadySearched: new Set(["paracatu - mg"]),
      limit: 5,
    });
    expect(out).toContain("João Pinheiro - MG");
    expect(out).toContain("Unaí - MG");
    expect(out.some(c => c.includes("GO"))).toBe(false);
    expect(out.some(c => c.includes("Rod"))).toBe(false);
    // Ordem: colhidas por frequência denominada
    expect(out.indexOf("João Pinheiro - MG")).toBeLessThan(out.indexOf("Unaí - MG"));
  });

  it("computeExpansionCandidates: cidade sem UF no nome do lead ganha sufixo do estado de origem", () => {
    const out = computeExpansionCandidates({
      regions: ["Sobral"],
      cityCounts: new Map([["Forquilha", 5], ["Massapê", 3]]),
      alreadySearched: new Set(["sobral"]),
      limit: 5,
    });
    // Sobral está mapeada (Forquilha - CE, Massapê - CE)
    expect(out).toContain("Forquilha - CE");
    expect(out).toContain("Massapê - CE");
  });

  it("computeExpansionCandidates: região sem UF e sem dicionário aceita candidatos colhidos com qualquer UF conhecido", () => {
    const out = computeExpansionCandidates({
      regions: ["Xique-Xique"],
      cityCounts: new Map([["Barra - BA", 4], ["Petrolândia - PE", 2]]),
      alreadySearched: new Set(["xique-xique"]),
      limit: 5,
    });
    expect(out).toContain("Barra - BA");
    expect(out).toContain("Petrolândia - PE");
  });

  it("computeExpansionCandidates: não repete cidade já buscada e respeita o limite", () => {
    const out = computeExpansionCandidates({
      regions: ["São Paulo"],
      cityCounts: new Map(),
      alreadySearched: new Set(["sao paulo", "guarulhos - sp"]),
      limit: 2,
    });
    expect(out).not.toContain("Guarulhos - SP");
    expect(out.length).toBeLessThanOrEqual(2);
  });
});
