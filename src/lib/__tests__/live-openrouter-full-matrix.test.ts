/**
 * BATERIA DE TESTES AO VIVO — OPENROUTER MODELOS FREE + MULTI-KEY
 *
 * Testa de ponta a ponta contra a API real do OpenRouter usando as chaves
 * configuradas no projeto (.env.local / Supabase).
 *
 * Executa com: LIVE_E2E=1 npx vitest run src/lib/__tests__/live-openrouter-full-matrix.test.ts
 */
import { describe, it, expect } from "vitest";
import { getAiKeys } from "@/lib/ai-keys";
import { generateText, startAiChat } from "@/lib/ai-provider";
import { listAvailableOpenRouterModels } from "@/lib/openrouter-model-discovery";

const RUN_LIVE = process.env.LIVE_E2E === "1";

describe.skipIf(!RUN_LIVE)("LIVE: OpenRouter modelos free + multi-chaves", () => {
  it("1. Carrega as chaves reais de OpenRouter (multi-key)", async () => {
    const keys = await getAiKeys();
    console.log("CHAVES ENCONTRADAS:");
    console.log(`  - Legada (openrouter): ${keys.openrouter ? `${keys.openrouter.slice(0, 12)}... (len ${keys.openrouter.length})` : "NENHUMA"}`);
    console.log(`  - Multi-keys total: ${keys.openrouterKeys?.length || 0}`);
    (keys.openrouterKeys || []).forEach((k, idx) => {
      console.log(`    [${idx + 1}] ${k.slice(0, 12)}... (len ${k.length})`);
    });
    expect(Boolean(keys.openrouter || (keys.openrouterKeys?.length || 0) > 0)).toBe(true);
  });

  it("2. Descobre todos os modelos :free ativos no catálogo do OpenRouter", async () => {
    const models = await listAvailableOpenRouterModels(true);
    const freeModels = models.filter((m) => m.id.endsWith(":free") || m.id.includes(":free"));
    console.log(`\nMODELOS :free DISPONÍVEIS NO OPENROUTER (${freeModels.length}):`);
    freeModels.forEach((m) => console.log(`  • ${m.id} — ${m.name}`));
    expect(freeModels.length).toBeGreaterThan(0);
  });

  it("3. Testa chamada nos modelos :free REAIS do catálogo", async () => {
    const candidates = [
      "openrouter:google/gemma-4-26b-a4b-it:free",
      "openrouter:google/gemma-4-31b-it:free",
      "openrouter:minimax/minimax-m2.7:free",
      "openrouter:minimax/minimax-m3:free",
      "openrouter:nvidia/nemotron-3.5-lightning:free",
      "openrouter:z-ai/glm-5.2:free",
      "openrouter:liquid/lfm-2.5-2.6b:free",
    ];

    const results: Array<{ model: string; ok: boolean; response?: string; error?: string }> = [];

    for (const modelRef of candidates) {
      try {
        const t0 = Date.now();
        const res = await generateText({
          modelRef,
          prompt: "Diga apenas: OK.",
          maxOutputTokens: 20,
          noGatewayFallback: true, // Testa o modelo direto sem mascarar
        });
        const elapsed = Date.now() - t0;
        results.push({ model: modelRef, ok: true, response: `"${res.text.slice(0, 40)}" (${elapsed}ms)` });
      } catch (err: any) {
        results.push({ model: modelRef, ok: false, error: String(err?.message || err).slice(0, 120) });
      }
    }

    console.log("\nRESULTADO DOS MODELOS :free REAIS:");
    results.forEach((r) => {
      if (r.ok) console.log(`  ✅ ${r.model} → ${r.response}`);
      else console.log(`  ❌ ${r.model} → ${r.error}`);
    });

    const anyOk = results.some((r) => r.ok);
    expect(anyOk).toBe(true);
  }, 90000);

  it("4. Testa o caso real do disparo: reescrita em modelo :free (ou fallback automático se free falhar)", async () => {
    const keys = await getAiKeys();
    const session = await startAiChat({
      modelRef: "openrouter:google/gemma-4-26b-a4b-it:free",
      systemInstruction: `Você é um SDR profissional via WhatsApp.
Reescreva a mensagem de forma curta, natural e profissional em PT-BR.
Devolva APENAS a mensagem final, sem aspas e sem explicação.`,
      history: [],
      tools: [],
      thinkingBudget: 0,
      geminiApiKey: keys.gemini,
      openrouterApiKey: keys.openrouter,
      openrouterKeys: keys.openrouterKeys,
    });

    const res = await session.sendUser(
      "Reescreva para a Padaria Pão Quente: Olá! Vi sua empresa no Google e notei que ainda não tem site."
    );

    console.log("\nREESCRITA GERADA (modelo usado: " + session.modelUsed() + "):");
    console.log(`"${res.text}"`);
    expect(res.text.length).toBeGreaterThan(10);
    expect(res.text).not.toContain("{{");
  }, 25000);

  it("5. Testa reviews-ai em modelo :free (ou fallback automático se free falhar)", async () => {
    const keys = await getAiKeys();
    const reviewsInput = `NEGÓCIO: Mecânica do João · RAMO: Oficina Mecânica
NOTA MÉDIA GOOGLE: 4.8/5 (12 avaliações)
AVALIAÇÕES:
- (5★ · há 2 semanas) "Ótimo atendimento, trocaram a suspensão rapidinho e com preço justo."
- (5★ · há 1 mês) "Melhor oficina do bairro, honestos demais."
- (3★ · há 2 meses) "Serviço bom, mas aos sábados demora pra ser atendido."`;

    const res = await generateText({
      modelRef: "openrouter:google/gemma-4-26b-a4b-it:free",
      system: `Analise as avaliações do Google e devolva um resumo curto com:
ELOGIOS: principais pontos elogiados
RECLAMAÇÕES: principais queixas
GANCHO: uma frase de gancho comercial`,
      prompt: reviewsInput,
      maxOutputTokens: 300,
      geminiApiKey: keys.gemini,
      openrouterApiKey: keys.openrouter,
      openrouterKeys: keys.openrouterKeys,
    });

    console.log("\nRESUMO DE AVALIAÇÕES GERADO (modelo usado: " + res.modelUsed + ", didFallback: " + res.didFallback + "):");
    console.log(res.text);
    expect(res.text.length).toBeGreaterThan(20);
  }, 25000);

  it("6. ESCADA DE FALLBACK: modelo descontinuado/inexistente sobrevive e responde via fallback", async () => {
    const keys = await getAiKeys();
    // Modelo descontinuado do OpenRouter (Llama 3.1 8b free era muito usado)
    const res = await generateText({
      modelRef: "openrouter:meta-llama/llama-3.1-8b-instruct:free",
      prompt: "Diga apenas: FUNCIONOU.",
      maxOutputTokens: 20,
      geminiApiKey: keys.gemini,
      openrouterApiKey: keys.openrouter,
      openrouterKeys: keys.openrouterKeys,
    });
    console.log(`\nRESPOSTA DO FALLBACK APÓS MODELO DESCONTINUADO:`);
    console.log(`  - didFallback: ${res.didFallback}`);
    console.log(`  - modelUsed: ${res.modelUsed}`);
    console.log(`  - text: "${res.text}"`);
    expect(res.didFallback).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
  }, 25000);
});
