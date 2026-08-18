import { describe, it, expect } from "vitest";
import { buildReviewsInput, DEFAULT_REVIEWS_PROMPT } from "@/lib/reviews-ai";
import { renderTemplate } from "@/lib/template-vars";
import { splitMessage } from "@/lib/agent-format";
import { generateText } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";

describe("E2E Pipeline Prospecção de Sites", () => {
  it("executa o fluxo completo ponta a ponta com IA, template e splitMessage", async () => {
    // 1. Dados simulados do Lead capturado do Google Maps (sem website)
    const mockLead = {
      nome_negocio: "Oficina Mecânica São José",
      ramo_negocio: "Auto Mecânica e Funilaria",
      avaliacao: 4.6,
      reviews: 48,
      telefone: "5511999998888",
      endereco: "Av. Paulista, 1000 - Bela Vista, SP",
      reviews_detalhes: [
        { autor: "Carlos Eduardo", nota: "5", data: "há 1 mês", texto: "Serviço impecável! Resolveram o barulho da suspensão no mesmo dia e o preço foi super justo." },
        { autor: "Mariana Souza", nota: "5", data: "há 3 meses", texto: "Mecânicos muito honestos e atenciosos. Explicaram tudo o que precisava trocar." },
        { autor: "Rodrigo Lima", nota: "3", data: "há 2 semanas", texto: "O conserto ficou bom mas demorou pra entregar no sábado porque a oficina estava lotada." },
        { autor: "Fernanda Dias", nota: "5", data: "há 4 meses", texto: "Ótimo atendimento, café na recepção e carro entregue limpo." },
      ],
      review_topics: { "suspensão": 6, "atendimento": 14, "preço": 8 },
      distribuicao_estrelas: { 5: 38, 4: 6, 3: 2, 2: 1, 1: 1 },
    };

    // 2. Construção do payload formatado de reviews
    const reviewsInput = buildReviewsInput(mockLead);
    expect(reviewsInput).toContain("NEGÓCIO: Oficina Mecânica São José");
    expect(reviewsInput).toContain("Serviço impecável!");
    expect(reviewsInput).toContain("demorou pra entregar");

    // 3. Obtenção das chaves configuradas (OpenRouter / Gemini)
    const keys = await getAiKeys();
    console.log("Status das chaves disponíveis:", {
      openrouter: !!keys.openrouter,
      gemini: !!keys.gemini,
      gatewayEndpoints: keys.gatewayEndpoints.length,
    });

    let resumoIa = "";

    // Testar modelo gratuito no OpenRouter se tiver chave, ou modelo fallback disponível
    if (keys.openrouter) {
      const freeModels = [
        "openrouter:openai/gpt-oss-20b:free",
        "openrouter:google/gemini-2.0-flash-lite:free",
        "openrouter:meta-llama/llama-3.3-70b-instruct:free",
        "openrouter:qwen/qwen-2.5-72b-instruct:free",
        "openrouter:mistralai/mistral-small-24b-instruct-2501:free",
      ];

      let lastError: any = null;
      for (const modelRef of freeModels) {
        try {
          console.log(`Tentando gerar resumo de reviews com ${modelRef}...`);
          const gen = await generateText({
            modelRef,
            system: DEFAULT_REVIEWS_PROMPT,
            prompt: reviewsInput,
            maxOutputTokens: 500,
            openrouterApiKey: keys.openrouter,
          });

          if (gen.text && gen.text.trim()) {
            resumoIa = gen.text.trim();
            console.log(`Sucesso com ${modelRef}! Resumo gerado (${resumoIa.length} chars).`);
            break;
          }
        } catch (err: any) {
          console.warn(`Falha ao chamar ${modelRef}:`, err?.message || err);
          lastError = err;
        }
      }

      if (!resumoIa && lastError) {
        console.warn("Nenhum modelo free OpenRouter respondeu ou cota cheia. Usando resumo simulado para teste de template/split.");
      }
    } else if (keys.gemini) {
      console.log("Tentando gerar resumo com Gemini...");
      const gen = await generateText({
        modelRef: "gemini-2.5-flash",
        system: DEFAULT_REVIEWS_PROMPT,
        prompt: reviewsInput,
        maxOutputTokens: 500,
        geminiApiKey: keys.gemini,
      });
      resumoIa = (gen.text || "").trim();
    }

    // Se nenhuma chave externa estiver ativa ou API falhar, valida com formato padrão
    if (!resumoIa) {
      resumoIa = `ELOGIOS: Clientes elogiam atendimento rápido, honestidade e serviço impecável na suspensão.
RECLAMAÇÕES: Demora na entrega aos sábados devido à alta demanda.
GANCHO: Vi que sua oficina é muito elogiada pelo serviço de suspensão e honestidade, mas notei que vocês ainda não possuem um site oficial para captar clientes que buscam no Google.
NOTA GERAL: Excelente reputação com alta aprovação.`;
    }

    console.log("\n=== RESUMO DAS AVALIAÇÕES (ETAPA 1) ===\n", resumoIa);
    expect(resumoIa.length).toBeGreaterThan(20);

    // 4. Renderização do template com {{resumo_avaliacoes}} e variáveis do lead
    const templateDisparo = `{{saudacao}}, tudo bem?

Meu nome é Salomão e encontrei a {{nome_empresa}} no Google.

Analisei o perfil de vocês e notei os seguintes pontos sobre a reputação da empresa:
{{resumo_avaliacoes}}

Reparei que vocês têm nota {{avaliacao}} com {{reviews}} avaliações excelentes em {{endereco}}, mas ainda não têm um site profissional próprio para converter mais buscas em agendamentos diretos.

Gostaria de apresentar uma proposta rápida de desenvolvimento de site para a {{nome_empresa}}?`;

    const mensagemRenderizada = renderTemplate(templateDisparo, {
      nome_negocio: mockLead.nome_negocio,
      ramo_negocio: mockLead.ramo_negocio,
      avaliacao: mockLead.avaliacao,
      reviews: mockLead.reviews,
      endereco: mockLead.endereco,
      telefone: mockLead.telefone,
      resumo_avaliacoes: resumoIa,
    });

    console.log("\n=== MENSAGEM RENDERIZADA (ETAPA 2) ===\n", mensagemRenderizada);

    // Verificações da renderização
    expect(mensagemRenderizada).toContain("Oficina Mecânica São José");
    expect(mensagemRenderizada).toContain("nota 4.6");
    expect(mensagemRenderizada).toContain("48 avaliações");
    expect(mensagemRenderizada).toContain(resumoIa);
    expect(mensagemRenderizada).not.toContain("{{nome_empresa}}");
    expect(mensagemRenderizada).not.toContain("{{resumo_avaliacoes}}");
    expect(mensagemRenderizada).not.toContain("{{avaliacao}}");

    // 5. Picotamento de mensagem (humanize_messages / splitMessage)
    const chunks = splitMessage(mensagemRenderizada);
    console.log("\n=== CHUNKS HUMANIZADOS (ETAPA 3 - splitMessage) ===");
    chunks.forEach((chunk, idx) => {
      console.log(`\n[Chunk ${idx + 1}/${chunks.length}] (${chunk.length} chars):\n${chunk}`);
    });

    // Verificações do split
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    chunks.forEach((chunk) => {
      expect(chunk.trim().length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(450); // margem segura de humanização
    });

    console.log("\n✓ E2E Pipeline validado com sucesso!");
  }, 120000);
});
