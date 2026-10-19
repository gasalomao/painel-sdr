import { describe, expect, it } from "vitest";
import {
  computeExpansionCandidates,
  extractUFFromText,
  getNeighboringCities,
  isValidCityName,
  proximitySearchTerm,
} from "@/lib/geo-regions";

describe("geo-regions — identidade geográfica e proximidade offline", () => {
  it.each([
    ["São Paulo", "SP"],
    ["Minas Gerais", "MG"],
    ["Mato Grosso do Sul", "MS"],
    ["Rio Grande do Norte", "RN"],
    ["Belo Horizonte - Minas Gerais", "MG"],
    ["Campinas, São Paulo", "SP"],
    ["Vitória / Espírito Santo", "ES"],
    ["Paracatu Minas Gerais", "MG"],
    ["Mato Grosso", "MT"],
    ["Paraíba", "PB"],
    ["Goiás", "GO"],
    ["Santa Catarina", "SC"],
    ["Distrito Federal", "DF"],
    ["Rua São Paulo, 100 - Centro, Belo Horizonte - MG", "MG"],
    ["São Paulo - Paraná", "PR"],
  ])("reconhece estado por extenso em %s", (text, uf) => {
    expect(extractUFFromText(text)).toBe(uf);
  });

  it.each(["São Paulo de Olivença", "Santa Bárbara do Pará", "Pé de Serra", "Campinas - SP / MG", "constructor", "__proto__"])(
    "não confunde nome de município, ruído ou estados contraditórios com UF: %s",
    text => expect(extractUFFromText(text)).toBeNull(),
  );

  it.each([
    "Interior SP",
    "bairro São Paulo",
    "Restaurante em São Paulo",
    "São Paulo de Olivença",
    "Cascavel",
    "Belo Horizonte - SP",
    "Campinas - Minas Gerais",
    "São Paulo - SP - MG",
    "Centro - MG",
    "Bairro Nova Lima - MG",
    "constructor",
    "__proto__",
  ])("não salta para capital a partir de região parcial, ambígua ou contraditória: %s", region => {
    const cities = getNeighboringCities(region);
    if (region === "São Paulo de Olivença") {
      expect(cities.length).toBeGreaterThan(0);
      expect(cities.every(city => city.endsWith(" - AM"))).toBe(true);
    } else {
      expect(cities).toEqual([]);
    }
  });

  it("resolve cidade exata, UF por extenso e somente aliases conhecidos completos", () => {
    expect(getNeighboringCities("BH - Minas Gerais")).toEqual(getNeighboringCities("Belo Horizonte - MG"));
    expect(getNeighboringCities("Campinas, São Paulo")).toEqual(getNeighboringCities("Campinas - SP"));
    expect(getNeighboringCities("Cascavel - Ceará").every(city => city.endsWith(" - CE"))).toBe(true);
    expect(getNeighboringCities("BH")).toEqual(getNeighboringCities("Belo Horizonte"));
  });

  it("expande município pequeno sem depender de resultados colhidos ou rede", () => {
    const out = computeExpansionCandidates({
      regions: ["Altinópolis - SP"],
      cityCounts: new Map(),
      alreadySearched: new Set(),
      limit: 20,
    });
    expect(out).toHaveLength(20);
    expect(out.every(city => city.endsWith(" - SP"))).toBe(true);
    expect(out).not.toContain("Altinópolis - SP");
    expect(out.slice(0, 5)).not.toContain("São Paulo - SP");
    expect(out).toContain("Batatais - SP");
  });

  it("usa proximidade municipal real em vez da ordem estática ou frequência de resultados", () => {
    const out = computeExpansionCandidates({
      regions: ["Belo Horizonte - Minas Gerais"],
      cityCounts: new Map([["Betim - MG", 99999], ["Manaus - AM", 999999]]),
      alreadySearched: new Set(),
      limit: 20,
    });
    expect(out.indexOf("Nova Lima - MG")).toBeLessThan(out.indexOf("Betim - MG"));
    expect(out).not.toContain("Manaus - AM");
    expect(out).not.toContain("Belo Horizonte - MG");
  });

  it("normaliza cidade sem UF, com UF e alias já buscados sem remover nomes por prefixo", () => {
    const out = computeExpansionCandidates({
      regions: ["BH"],
      cityCounts: new Map([["Contagem", 2], ["Contagem - MG", 3]]),
      alreadySearched: new Set(["BH", "CONTAGEM", "Nova Lima - Minas Gerais"]),
      limit: 1000,
    });
    expect(out).not.toContain("Belo Horizonte - MG");
    expect(out).not.toContain("Contagem - MG");
    expect(out).not.toContain("Nova Lima - MG");
    expect(out).toContain("Lima Duarte - MG");
    expect(new Set(out).size).toBe(out.length);
  });

  it("preserva nomes municipais por inteiro sem filtrar prefixos semelhantes", () => {
    const out = computeExpansionCandidates({
      regions: ["São José - SC"],
      cityCounts: new Map(),
      alreadySearched: new Set(["São José - SC"]),
      limit: 1000,
    });
    expect(out).toContain("São José do Cedro - SC");
    expect(out).toContain("São José do Cerrito - SC");
    expect(out).not.toContain("São José - SC");
  });

  it("não confunde município buscado em outro UF com cidade homônima elegível", () => {
    const out = computeExpansionCandidates({
      regions: ["Cascavel - PR"],
      cityCounts: new Map(),
      alreadySearched: new Set(["Toledo - MG"]),
      limit: 10,
    });
    expect(out).toContain("Toledo - PR");
  });

  it("avança além das primeiras dez mantendo a origem, sem repetição nem ciclos", () => {
    const opts = { regions: ["Paracatu - MG"], cityCounts: new Map<string, number>(), limit: 10 };
    const searched = new Set(["Paracatu"]);
    const first = computeExpansionCandidates({ ...opts, alreadySearched: searched });
    first.forEach(city => searched.add(city));
    const second = computeExpansionCandidates({ ...opts, alreadySearched: searched });
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(second.every(city => city.endsWith(" - MG") && !first.includes(city))).toBe(true);
    expect([...first, ...second]).toEqual(computeExpansionCandidates({
      ...opts, alreadySearched: new Set(["Paracatu - MG"]), limit: 20,
    }));
  });

  it("mantém cada origem no próprio UF sem fazer a primeira região ocultar as demais", () => {
    const opts = {
      cityCounts: new Map<string, number>(),
      alreadySearched: new Set<string>(),
      limit: 2000,
    };
    const out = computeExpansionCandidates({ ...opts, regions: ["Paracatu - MG", "Altinópolis - SP"] });
    expect(out).toContain("Unaí - MG");
    expect(out).toContain("Batatais - SP");
    expect(out.every(city => / - (MG|SP)$/.test(city))).toBe(true);
    expect(out).not.toContain("Paracatu - MG");
    expect(out).not.toContain("Altinópolis - SP");
    expect(out).toEqual(computeExpansionCandidates({ ...opts, regions: ["Altinópolis - SP", "Paracatu - MG"] }));
  });

  it("não retorna uma origem ambígua como destino de outra origem válida", () => {
    const out = computeExpansionCandidates({
      regions: ["Belém", "Maceió - AL"],
      cityCounts: new Map(),
      alreadySearched: new Set(),
      limit: 1000,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("Belém - AL");
    expect(out).not.toContain("Maceió - AL");
    expect(out.every(city => city.endsWith(" - AL"))).toBe(true);
  });

  it("não atribui UF a município ambíguo, desconhecido ou bairro usando cityCounts", () => {
    for (const region of ["Cascavel", "Interior SP", "Cidade inexistente - SP", "Bairro Jardim América - SP"]) {
      expect(computeExpansionCandidates({
        regions: [region],
        cityCounts: new Map([["São Paulo - SP", 100], ["Bairro Centro - SP", 10], ["Curitiba - PR", 1]]),
        alreadySearched: new Set(),
        limit: 10,
      })).toEqual([]);
    }
  });

  it("evidência dinâmica não promove cidade sem UF, rua, bairro ou cidade inventada", () => {
    const opts = { regions: ["Paracatu - MG"], alreadySearched: new Set<string>(), limit: 1000 };
    const out = computeExpansionCandidates({
      ...opts,
      cityCounts: new Map([
        ["Cidade inventada", 1000],
        ["Cidade inventada - MG", 1000],
        ["Rua das Flores - MG", 1000],
        ["Bairro Jardim América - MG", 1000],
        ["Centro - MG", 1000],
        ["Guarulhos - SP", 1000],
      ]),
    });
    expect(out).toEqual(computeExpansionCandidates({ ...opts, cityCounts: new Map() }));
  });

  it.each(["Bairro Centro", "bairro Jardim América", "Jardim América", "Centro Histórico", "Rua X", "123", "Cidade 1"])(
    "rejeita rótulo genérico de bairro/endereço: %s", text => expect(isValidCityName(text)).toBe(false),
  );

  it("não confunde regiões administrativas do DF ou vizinhos interestaduais com municípios do mesmo estado", () => {
    expect(getNeighboringCities("Brasília - DF")).toEqual([]);
    expect(getNeighboringCities("Petrolina - PE")).not.toContain("Juazeiro - BA");
    expect(getNeighboringCities("Teresina - PI")).not.toContain("Timon - MA");
  });

  it("é determinístico mesmo mudando ordem e empates da evidência colhida", () => {
    const opts = { regions: ["Altinópolis - SP"], alreadySearched: new Set<string>(), limit: 30 };
    const entries: Array<[string, number]> = [["Batatais - SP", 2], ["Cajuru - SP", 2], ["Serrana", 2]];
    expect(computeExpansionCandidates({ ...opts, cityCounts: new Map(entries) })).toEqual(
      computeExpansionCandidates({ ...opts, cityCounts: new Map(entries.reverse()) }),
    );
  });

  it("limite inválido não gera expansão e proximidade mantém o nicho original", () => {
    for (const limit of [0, -1, NaN, Infinity]) {
      expect(computeExpansionCandidates({
        regions: ["Campinas - SP"], cityCounts: new Map(), alreadySearched: new Set(), limit,
      })).toEqual([]);
    }
    expect(proximitySearchTerm("  Restaurante vegano sem glúten  ", "  Paracatu - MG "))
      .toBe("Restaurante vegano sem glúten perto de Paracatu - MG");
  });
});
