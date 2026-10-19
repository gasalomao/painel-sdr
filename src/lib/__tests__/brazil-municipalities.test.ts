import { describe, expect, it } from "vitest";
import data from "@/lib/data/brazil-municipalities.json";

type Municipality = [name: string, uf: string, latitude: number, longitude: number];
const municipalities = data as Municipality[];
const validUFs = new Set([
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT",
  "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
]);

describe("base local de municípios brasileiros", () => {
  it("preserva todos os registros do commit fixado nas 27 UFs", () => {
    // O README diz 5.570, mas o commit fixado inclui Boa Esperança do Norte/MT.
    expect(municipalities).toHaveLength(5571);
    expect(new Set(municipalities.map(([, uf]) => uf))).toEqual(validUFs);
  });

  it("contém apenas tuplas compactas com nomes, UFs e coordenadas válidas no Brasil", () => {
    const invalid = municipalities.filter((row) => {
      const [name, uf, latitude, longitude] = row;
      return row.length !== 4
        || typeof name !== "string" || !name.trim() || name.includes("\uFFFD")
        || !validUFs.has(uf)
        || !Number.isFinite(latitude) || latitude < -34 || latitude > 6
        || !Number.isFinite(longitude) || longitude < -74 || longitude > -32;
    });
    expect(invalid).toEqual([]);
  });

  it("não duplica município por UF e preserva cidades homônimas de estados diferentes", () => {
    const keys = municipalities.map(([name, uf]) =>
      `${name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()}|${uf}`,
    );
    expect(new Set(keys).size).toBe(municipalities.length);
    expect(municipalities.filter(([name]) => name === "Belém").map(([, uf]) => uf).sort())
      .toEqual(["AL", "PA", "PB"]);
  });

  it("preserva coordenadas de São Paulo e Guarulhos para expansão próxima", () => {
    expect(municipalities.find(([name, uf]) => name === "São Paulo" && uf === "SP"))
      .toEqual(["São Paulo", "SP", -23.5329, -46.6395]);
    expect(municipalities.find(([name, uf]) => name === "Guarulhos" && uf === "SP"))
      .toEqual(["Guarulhos", "SP", -23.4538, -46.5333]);
  });

  it("cobre municípios pequenos e do interior, sem se limitar a capitais", () => {
    const keys = new Set(municipalities.map(([name, uf]) => `${name}|${uf}`));
    for (const key of [
      "Serra da Saudade|MG", "Borá|SP", "Jardim de Angicos|RN", "Santa Rosa do Purus|AC",
      "Paracatu|MG", "João Pinheiro|MG", "Unaí|MG", "Xique-Xique|BA",
      "Boa Esperança do Norte|MT",
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
  });
});
