import { describe, it, expect } from "vitest";
import { buildReviewsInput, DEFAULT_REVIEWS_PROMPT } from "@/lib/reviews-ai";
import { renderTemplate } from "@/lib/template-vars";
import { splitMessage } from "@/lib/agent-format";
import { generateText, startAiChat } from "@/lib/ai-provider";
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

  /**
   * Fluxo da AUTOMAÇÃO de prospecção com "Reescrever com IA" + "Humanizar
   * (picotar)" ligados — espelha campaign-worker.personalizeWithAI +
   * splitMessage: template renderizado → IA reescreve (modelo free
   * OpenRouter do catálogo ATUAL) → splitMessage pica em chunks humanos.
   */
  it("automação: IA reescreve disparo (modelo free) e splitMessage pica em chunks", async () => {
    const keys = await getAiKeys();
    if (!keys.openrouter) {
      console.log("Sem chave OpenRouter — pulando teste live de automação (IA).");
      return;
    }

    // 1. Template renderizado (mesma base da automação de prospecção de sites)
    const baseMessage = renderTemplate(
      `{{saudacao}}! Tudo bem?

Estava dando uma olhada no perfil da {{nome_empresa}} no Google e parabéns pela nota {{avaliacao}} com {{reviews}} avaliações!

Notei que muitos clientes chegam até vocês pelas buscas, mas ainda falta uma página própria no setor de {{ramo}} para converter quem pesquisa online.

Posso te enviar o PDF da prévia de um site sem compromisso para você ver como ficou?`,
      {
        nome_negocio: "Padaria Pão de Nozes",
        ramo_negocio: "Panificadora",
        avaliacao: 4.8,
        reviews: 92,
      },
    );
    expect(baseMessage).toContain("Padaria Pão de Nozes");
    expect(baseMessage).not.toContain("{{");

    // 2. IA reescreve — mesma chamada do campaign-worker.personalizeWithAI,
    //    tentando os modelos :free REAIS do catálogo atual do OpenRouter.
    const freeChain = [
      "openrouter:minimax/minimax-m3:free",
      "openrouter:liquid/lfm-2.5-2.6b:free",
      "openrouter:nvidia/nemotron-3.5-lightning:free",
    ];
    let rewritten = "";
    let usedModel = "";
    for (const modelRef of freeChain) {
      try {
        const session = await startAiChat({
          modelRef,
          systemInstruction: `Você é um SDR experiente fazendo uma primeira abordagem PROFISSIONAL via WhatsApp.

DADOS DO LEAD:
- Empresa: Padaria Pão de Nozes
- Ramo: Panificadora

MENSAGEM-BASE (template do operador):
"""
${baseMessage}
"""

INSTRUÇÕES:
- Reescreva a MENSAGEM-BASE de forma natural, curta (até 3 frases), em PT-BR.
- Mantenha o sentido original do template.
- Personalize SUTILMENTE pra empresa/ramo (sem inventar nada).
- Devolva APENAS a mensagem final, sem aspas e sem explicação.`,
          history: [],
          tools: [],
          thinkingBudget: 0,
          openrouterApiKey: keys.openrouter,
        });
        const turn = await session.sendUser(
          "Gere a mensagem final agora. IMPORTANTE: escreva o texto REAL e completo, NUNCA use variáveis ou chaves {{ }} na resposta.",
        );
        if (turn.text?.trim()) {
          rewritten = turn.text.trim();
          usedModel = session.modelUsed();
          break;
        }
      } catch (err: any) {
        console.warn(`Modelo ${modelRef} falhou: ${err?.message}`);
      }
    }

    // Rede de segurança: se todos os :free estouraram quota agora, o teste
    // ainda valida o picotamento com o texto-base (o split é lógica pura).
    const finalMessage = rewritten || baseMessage;
    console.log(`\n=== AUTOMAÇÃO: IA reescreveu? ${rewritten ? `SIM (${usedModel})` : "não (quota free esgotada agora) — usando base"} ===`);
    console.log(`"${finalMessage}"`);
    if (rewritten) {
      expect(rewritten.length).toBeGreaterThan(20);
      expect(rewritten).not.toContain("{{");
    }

    // 3. Picotamento (humanize_messages=true no campaign-worker)
    const chunks = splitMessage(finalMessage);
    console.log(`\n=== AUTOMAÇÃO: ${chunks.length} chunks picotados ===`);
    chunks.forEach((c, i) => console.log(`[${i + 1}] (${c.length} chars) ${c.slice(0, 60)}${c.length > 60 ? "…" : ""}`));

    // Contrato do picotamento: nenhum chunk vazio, nenhum > 450 chars.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    chunks.forEach((c) => {
      expect(c.trim().length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(450);
    });
    // A junção dos chunks preserva o conteúdo completo entregue ao lead.
    expect(chunks.join("\n\n").replace(/\s+/g, " ")).toContain(
      finalMessage.replace(/\s+/g, " ").slice(0, 40),
    );
  }, 90000);
});
