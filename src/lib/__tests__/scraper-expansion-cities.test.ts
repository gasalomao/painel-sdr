/**
 * Self-check da expansão automática pra cidades vizinhas (scraper-engine).
 * A expansão depende de extractLocation ler corretamente o endereço no
 * formato que o card do Google Maps entrega. Aqui validamos os formatos
 * reais vistos em produção + os casos que NÃO devem virar cidade.
 */
import { describe, expect, it } from "vitest";
import { extractLocation } from "@/lib/lead-intelligence";

const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

describe("extractLocation — colheita de cidades pra expansão", () => {
  it("endereço Maps completo: rua, bairro, cidade - UF, CEP", () => {
    const r = extractLocation("Av. do Contorno, 455 - Santa Efigênia, Belo Horizonte - MG, 30110-021");
    expect(norm(r.cidade)).toBe("belo horizonte");
    expect(r.estado).toBe("MG");
  });

  it("endereço de cidade vizinha no mesmo formato", () => {
    const r = extractLocation("R. Sete, 123 - Centro, Contagem - MG, 32010-000");
    expect(norm(r.cidade)).toBe("contagem");
  });

  it("cidade sem estado ainda cai no fallback heurístico (não vaza vazio)", () => {
    const r = extractLocation("Rua X, 10 - Centro, Betim");
    expect(r.cidade.length).toBeGreaterThan(0);
  });

  it("cidade igual à região original é dedupável via norm()", () => {
    // Região configurada "Belo horizonte" (digitada) vs cidade colhida do
    // card "Belo Horizonte" — norm() tem que colidir pra expansão pular.
    const r = extractLocation("Av. Brasil, 100 - Centro, Belo Horizonte - MG, 30140-000");
    expect(norm(r.cidade)).toBe(norm("Belo horizonte"));
  });

  it("endereço vazio/nulo não quebra", () => {
    expect(extractLocation("").cidade).toBe("");
    expect(extractLocation(null).cidade).toBe("");
  });
});
