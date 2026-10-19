import { describe, it, expect } from "vitest";
import { extractLocation } from "@/lib/lead-intelligence";
import { getNeighboringCities, isValidCityName, extractUFFromText, ufFromCep, computeExpansionCandidates, proximitySearchTerm } from "@/lib/geo-regions";

describe("geo-regions & extractLocation — Expansão municipal offline no Brasil", () => {
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

  it("capitais resolvidas têm municípios próximos do mesmo UF, com DF isolado", () => {
    // Sudeste
    expect(getNeighboringCities("São Paulo")).toContain("Guarulhos - SP");
    expect(getNeighboringCities("Rio de Janeiro")).toContain("Niterói - RJ");
    expect(getNeighboringCities("Vitória")).toContain("Vila Velha - ES");
    expect(getNeighboringCities("Campinas")).toContain("Paulínia - SP");

    // Sul
    expect(getNeighboringCities("Curitiba")).toContain("São José dos Pinhais - PR");
    expect(getNeighboringCities("Porto Alegre")).toContain("Canoas - RS");
    expect(getNeighboringCities("Florianópolis")).toContain("São José - SC");

    // O DF não tem outro município; bairros/regiões administrativas não viram cidades.
    expect(getNeighboringCities("Brasília")).toEqual([]);
    // Centro-Oeste
    expect(getNeighboringCities("Goiânia")).toContain("Aparecida de Goiânia - GO");
    expect(getNeighboringCities("Cuiabá")).toContain("Várzea Grande - MT");

    // Nordeste
    expect(getNeighboringCities("Salvador")).toContain("Lauro de Freitas - BA");
    expect(getNeighboringCities("Recife")).toContain("Olinda - PE");
    expect(getNeighboringCities("Fortaleza")).toContain("Caucaia - CE");

    // Norte
    expect(getNeighboringCities("Manaus")).toContain("Iranduba - AM");
    // Belém também existe em AL e PB: a capital precisa de UF explícito.
    expect(getNeighboringCities("Belém - PA")).toContain("Ananindeua - PA");
    expect(getNeighboringCities("Belém")).toEqual([]);
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

  it("computeExpansionCandidates: município interiorano expande por coordenadas no próprio estado", () => {
    // Paracatu não existia no dicionário legado; a base local cobre o município.
    const out = computeExpansionCandidates({
      regions: ["Paracatu - MG"],
      cityCounts: new Map([
        ["João Pinheiro - MG", 4],   // colhida do painel de detalhes
        ["Unaí - MG", 60],
        ["Cristalina - GO", 9],      // outro estado — rejeitada mesmo colhendo mais
        ["· Rod. BR-040", 7],        // rua com prefixo — rejeitada
      ]),
      alreadySearched: new Set(["paracatu - mg"]),
      limit: 20,
    });
    expect(out).toContain("João Pinheiro - MG");
    expect(out).toContain("Unaí - MG");
    expect(out.some(c => c.includes("GO"))).toBe(false);
    expect(out.some(c => c.includes("Rod"))).toBe(false);
    // Frequência não prova proximidade: a ordem agora usa as coordenadas municipais.
    expect(out.indexOf("João Pinheiro - MG")).toBeLessThan(out.indexOf("Unaí - MG"));
  });

  it("computeExpansionCandidates: evidência sem UF não duplica os municípios da base", () => {
    const out = computeExpansionCandidates({
      regions: ["Sobral"],
      cityCounts: new Map([["Forquilha", 5], ["Massapê", 3]]),
      alreadySearched: new Set(["sobral"]),
      limit: 5,
    });
    expect(out).toContain("Forquilha - CE");
    expect(out).toContain("Massapê - CE");
    expect(new Set(out).size).toBe(out.length);
  });

  it("computeExpansionCandidates: região desconhecida não inventa estado a partir dos resultados", () => {
    const out = computeExpansionCandidates({
      regions: ["Cidade não identificada"],
      cityCounts: new Map([["Barra - BA", 4], ["Petrolândia - PE", 2]]),
      alreadySearched: new Set(["cidade não identificada"]),
      limit: 5,
    });
    expect(out).toEqual([]);
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
