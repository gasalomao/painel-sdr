import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: (...args: any[]) => mockFrom(...args),
  },
}));

const mockGetAiKeys = vi.fn();
vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: (...args: any[]) => mockGetAiKeys(...args),
}));

import { chunkText, extractRagKeywords, searchKnowledge } from "@/lib/rag";
import { normalizeOpenAiToolSchema } from "@/lib/ai-provider";
import {
  cheapModelForSummary,
  summarizeMiddleMessages,
  invalidateHistorySummary,
} from "@/lib/history-summary";
import { mediaPlaceholder } from "@/app/api/webhooks/shared-helpers";

describe("1. RAG Universal (Qualquer Domínio) + Proteção contra Bomba de Tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAiKeys.mockResolvedValue({
      gemini: null,
      openrouter: null,
      nvidia: null,
      gatewayEndpoints: [],
    });
  });

  it("extractRagKeywords remove stopwords em português e preserva termos de vendas, serviços, FAQs e produtos", () => {
    expect(extractRagKeywords("Como funciona o plano empresarial de consultoria?")).toEqual([
      "plano",
      "empresarial",
      "consultoria",
    ]);
    expect(extractRagKeywords("Qual o valor e prazo de entrega do site institucional?")).toEqual([
      "prazo",
      "entrega",
      "site",
      "institucional",
    ]);
  });

  it("chunkText mantém cabeçalhos de FAQ / Scripts de Objeção unidos ao parágrafo de resposta", () => {
    const intro = "Introdução do playbook comercial. ".repeat(55); // ~1870 chars
    const header = "## Objeção: Achei o valor caro";
    const answer =
      "Resposta recomendada: Mostre o retorno sobre investimento (ROI) em 30 dias e ofereça o parcelamento em até 12x.";
    const doc = `${intro}\n\n${header}\n\n${answer}`;

    const chunks = chunkText(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // O cabeçalho "## Objeção: Achei o valor caro" nunca pode ficar separado da sua resposta
    const chunkWithHeader = chunks.find((c) => c.includes(header));
    expect(chunkWithHeader).toBeDefined();
    expect(chunkWithHeader).toContain("Mostre o retorno sobre investimento (ROI)");
  });

  it("searchKnowledge NÃO duplica documento bruto quando a busca vetorial já encontrou os chunks relevantes", async () => {
    // Simula falha/ausência de chave ou mock de embed via RPC caso embedQuery falhe ou funcione:
    // Vamos testar o fallback quando o vetor falha (ex.: usuário usando 100% OpenCode/Gateway sem key de embedding)
    const bigFaqDoc = [
      "## Dúvida 1: Prazo de implantação\nA implantação completa leva 48 horas úteis após o envio do briefing.",
      "## Dúvida 2: Garantia e suporte\nOferecemos suporte dedicado via WhatsApp de segunda a sábado e garantia de 90 dias.",
      "## Dúvida 3: Cancelamento\nO cliente pode solicitar cancelamento sem multa nos primeiros 7 dias. ".repeat(40),
    ].join("\n\n");

    const limitMock = vi.fn().mockResolvedValue({
      data: [
        {
          id: "doc-faq-1",
          title: "Manual de Implantação e Suporte",
          content: bigFaqDoc,
          client_id: "tenant-1",
        },
      ],
    });
    const orMock2 = vi.fn().mockReturnValue({ limit: limitMock });
    const orMock1 = vi.fn().mockReturnValue({ or: orMock2 });
    const eqMock = vi.fn().mockReturnValue({ or: orMock1 });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: eqMock, maybeSingle: vi.fn().mockResolvedValue({ data: null }) }),
    });

    const matches = await searchKnowledge({
      query: "Qual o prazo de implantação?",
      agentId: 1,
      clientId: "tenant-1",
      apiKey: "",
      topK: 5,
    });

    expect(matches.length).toBeGreaterThan(0);
    // Deve retornar apenas o chunk relevante (~500 tokens) e NÃO o documento inteiro gigante
    expect(matches[0].content).toContain("48 horas úteis");
    expect(matches[0].content.length).toBeLessThan(bigFaqDoc.length);
  });
});

describe("2. Normalização Universal de Tools para OpenCode / Gateway, OpenRouter e NVIDIA NIM", () => {
  it("converte SchemaType maiúsculo do Gemini (OBJECT, STRING, NUMBER) para JSON Schema minúsculo válido", () => {
    const geminiSchema = {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Termos da busca" },
        quantity_sold: { type: "NUMBER", description: "Quantidade" },
        filters: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING" },
          },
        },
      },
      required: ["query"],
    };

    const normalized = normalizeOpenAiToolSchema(geminiSchema);
    expect(normalized).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Termos da busca" },
        quantity_sold: { type: "number", description: "Quantidade" },
        filters: {
          type: "object",
          properties: {
            category: { type: "string" },
          },
        },
      },
      required: ["query"],
    });
  });

  it("garante schema { type: 'object', properties: {} } para tools sem parâmetros (ex: complete_current_stage)", () => {
    expect(normalizeOpenAiToolSchema(undefined)).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeOpenAiToolSchema(null)).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("3. Multi-Provedor e Memória Persistente em Blocos (OpenCode/Gateway, NVIDIA, OpenRouter, Gemini)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateHistorySummary("tenant-1", "5511999999999@s.whatsapp.net");
  });

  it("cheapModelForSummary prioriza modelo do OpenCode/Gateway ou Combo quando configurado no agente", async () => {
    mockGetAiKeys.mockResolvedValue({
      gemini: null,
      openrouter: null,
      nvidia: null,
      gatewayEndpoints: [{ id: "ep1", label: "OpenCode", baseUrl: "http://127.0.0.1:8317/v1" }],
    });

    const chosen = await cheapModelForSummary({
      preferredModelRef: "gateway:claude-sonnet-4",
    });
    expect(chosen).not.toBeNull();
    expect(chosen?.modelRef).toBe("gateway:claude-sonnet-4");
  });

  it("summarizeMiddleMessages reaproveita resumo persistido em sessions.variables._history_summary ao trocar de modelo sem gastar novos tokens", async () => {
    const middleMsgs = Array.from({ length: 8 }, (_, idx) => ({
      sender_type: idx % 2 === 0 ? "customer" : "ai",
      content: `Mensagem importante número ${idx + 1} sobre o contrato anual.`,
    }));

    const { contentHash } = await import("@/lib/history-summary");
    const expectedHash = contentHash(middleMsgs);

    const sessionVariables: Record<string, any> = {
      _history_summary: {
        hash: expectedHash,
        summary: "Cliente João confirmou interesse no plano anual de R$ 497/mês e pediu reunião às 15h.",
      },
    };

    // Adiciona mais 2 mensagens no meio (total 10: 8 no bloco estável + 2 na cauda residual)
    const tenMsgs = [
      ...middleMsgs,
      { sender_type: "customer", content: "Meu e-mail é joao@empresa.com.br" },
      { sender_type: "ai", content: "Perfeito João, anotei seu e-mail!" },
    ];

    const result = await summarizeMiddleMessages(
      "tenant-1",
      "5511999999999@s.whatsapp.net",
      tenMsgs,
      {
        preferredModelRef: "gateway:gpt-4o",
        sessionVariables,
      },
    );

    expect(result).toContain("Cliente João confirmou interesse no plano anual");
    expect(result).toContain("joao@empresa.com.br");
  });
});

describe("4. Correção do Placeholder de Transcrição de Áudio", () => {
  it("mediaPlaceholder para áudio não retorna mais '[🎤 Áudio — transcrevendo...]' eterno", () => {
    expect(mediaPlaceholder("audio")).toBe("[🎤 Áudio]");
    expect(mediaPlaceholder("audio")).not.toContain("transcrevendo");
  });
});

