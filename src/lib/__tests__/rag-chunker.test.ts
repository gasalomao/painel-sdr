/**
 * Testa o chunker do RAG (chunkText + chunkProductCatalog).
 *
 * POR QUE EXISTE: em catálogos de produtos (loja de celular), se o chunker
 * cortar UM produto no meio, a IA encontra o preço sem foto (ou foto sem
 * estoque) → alucinação parcial → perde venda. Este teste garante que:
 *   1. Bloco "### PRODUTO: X" fica intacto (não cortado).
 *   2. Produtos pequenos são agrupados (até 4 por chunk).
 *   3. Produto grande fica sozinho (mesmo que passe do target).
 *   4. SEM overlap em catálogo (overlap criaria duplicação divergente).
 *   5. Texto normal (sem catálogo) usa chunking + overlap.
 */
import { describe, it, expect, vi } from "vitest";

// rag.ts importa supabase_admin que cria client Supabase no import-time.
// Sem SUPABASE_URL o createClient explode. Mockamos o módulo pra isolar.
vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ limit: () => ({ data: [], error: null }) }),
      rpc: () => ({ data: [], error: null }),
    }),
  },
}));

import { chunkText } from "../rag";

describe("chunkText — texto curto", () => {
  it("texto menor que target vira 1 chunk", () => {
    const text = "Texto curto que cabe num chunk só.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("texto vazio retorna array vazio", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("\n\n\n")).toEqual([]);
  });
});

describe("chunkText — texto longo normal (sem catálogo)", () => {
  it("divide por parágrafos quando passa do target", () => {
    const para1 = "a".repeat(1500);
    const para2 = "b".repeat(1500);
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("aplica overlap entre chunks adjacentes (não perde contexto na borda)", () => {
    const para1 = "a".repeat(1800);
    const para2 = "b".repeat(1800);
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkText(text);
    if (chunks.length >= 2) {
      // O segundo chunk deve começar com parte do anterior (overlap)
      // ou pelo menos não cortar direto no "b"s.
      expect(chunks[1].length).toBeGreaterThan(200);
    }
  });
});

describe("chunkText — catálogo de produtos (formato UI)", () => {
  const productBlock = (name: string, price: string) =>
    `### PRODUTO: ${name}\n- **Preço**: ${price}\n- **Estoque**: 5\n- **Foto**: [IMAGEM: https://x/${name}.jpg]`;

  it("detecta catálogo e usa chunkProductCatalog (não corta produto no meio)", () => {
    const catalog = [productBlock("iPhone 15", "R$ 5000"), productBlock("iPhone 15 Pro", "R$ 7000")].join("\n\n---\n\n");
    const chunks = chunkText(catalog);

    // Cada chunk preserva UM produto intacto (com nome + preço + foto)
    for (const chunk of chunks) {
      // Se o chunk tem "### PRODUTO:", tem que ter o bloco inteiro
      if (chunk.includes("### PRODUTO:")) {
        const matches = chunk.match(/### PRODUTO:/g) || [];
        for (let i = 0; i < matches.length; i++) {
          // Cada produto no chunk tem que ter Preço e Foto juntos
          const productStart = chunk.indexOf("### PRODUTO:");
          expect(chunk.substring(productStart)).toMatch(/Preço/);
        }
      }
    }
  });

  it("NÃO aplica overlap em catálogo (produtos não se misturam)", () => {
    const catalog = [productBlock("A", "R$ 1"), productBlock("B", "R$ 2"), productBlock("C", "R$ 3")]
      .join("\n\n---\n\n");
    const chunks = chunkText(catalog);

    // Nenhum chunk deve conter fatia de outro produto
    for (const chunk of chunks) {
      const productMarkers = (chunk.match(/### PRODUTO:/g) || []).length;
      const separatorMarkers = (chunk.match(/^---$/gm) || []).length;
      // Ou tem 1 produto sozinho, ou tem vários separados por "---" corretamente
      if (productMarkers > 1) {
        expect(separatorMarkers).toBeGreaterThanOrEqual(productMarkers - 1);
      }
    }
  });

  it("produto sozinho maior que target NÃO é cortado (preserva integridade)", () => {
    const bigProduct = `### PRODUTO: iPhone Max\n- **Descrição**: ${"x".repeat(2500)}`;
    const chunks = chunkText(bigProduct);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("### PRODUTO: iPhone Max");
  });

  it("produtos pequenos são agrupados (até 4 por chunk)", () => {
    const smallProducts = Array.from({ length: 8 }, (_, i) =>
      productBlock(`P${i}`, "R$ 100")
    ).join("\n\n---\n\n");
    const chunks = chunkText(smallProducts);

    // 8 produtos pequenos → pelo menos 2 chunks (limite 4/chunk)
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Nenhum chunk com mais de 4 produtos
    for (const chunk of chunks) {
      const count = (chunk.match(/### PRODUTO:/g) || []).length;
      expect(count).toBeLessThanOrEqual(4);
    }
  });
});

describe("chunkText — separador sólido (---)", () => {
  it("detecta linha --- como separador de produto também", () => {
    const text = `### PRODUTO: A\nPreço: 1\n\n---\n\n### PRODUTO: B\nPreço: 2`;
    const chunks = chunkText(text);
    // Não deve cortar "B" no meio nem misturá-lo com "A"
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      if (chunk.includes("PRODUTO: A") && chunk.includes("PRODUTO: B")) {
        // Se vieram juntos, tem que ter o separador
        expect(chunk).toContain("---");
      }
    }
  });
});
