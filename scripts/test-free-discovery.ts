#!/usr/bin/env node
/**
 * Descoberta e teste de modelos gratuitos para Site Studio
 * Testa cada modelo com chamada simples antes de usar em criação completa
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  console.log(JSON.stringify({ event: "discovery_started", timestamp: new Date().toISOString() }));

  // Carregar env
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  config({ quiet: true });

  const { validateFreeTestModel } = await import("./test-site-free");

  // Buscar catálogo
  const response = await fetch("https://openrouter.ai/api/v1/models");
  assert.ok(response.ok, "Catalog unavailable");
  const catalog: any = await response.json();

  // Filtrar modelos gratuitos com tools
  const freeModels = catalog.data.filter((entry: any) => {
    if (!entry.id || !entry.pricing) return false;
    const pricing = entry.pricing;
    const isZero = (price: string) => /^0(?:\.0+)?$/.test(price);
    return isZero(pricing.prompt) && isZero(pricing.completion) &&
           entry.supported_parameters?.includes("tools");
  });

  console.log(JSON.stringify({ event: "free_models_found", count: freeModels.length }));

  // Testar cada modelo com chamada simples
  const workingModels: any[] = [];

  for (const entry of freeModels.slice(0, 10)) {
    try {
      const model = validateFreeTestModel(entry, entry.id);
      console.log(JSON.stringify({ event: "testing_model", id: model.id }));

      // Teste simples: chamada com tools
      const { websiteChatAttempt } = await import("../src/lib/sites/models");

      const testBody = {
        model: model.id,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "What is 2+2?" }
        ],
        tools: [{
          type: "function",
          function: {
            name: "calculate",
            description: "Calculate math",
            parameters: {
              type: "object",
              properties: { expr: { type: "string" } },
              required: ["expr"]
            }
          }
        }],
        max_tokens: 100,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const result = await websiteChatAttempt(model, testBody, controller.signal);

        if (result.response.choices?.[0]?.message) {
          workingModels.push({
            id: model.id,
            name: model.name,
            context: model.contextLength,
            tested: true,
            working: true,
          });
          console.log(JSON.stringify({ event: "model_working", id: model.id }));
        } else {
          console.log(JSON.stringify({ event: "model_empty_response", id: model.id }));
        }
      } catch (error) {
        console.log(JSON.stringify({
          event: "model_failed",
          id: model.id,
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        clearTimeout(timeout);
      }

      // Rate limit: aguardar entre testes
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
      console.log(JSON.stringify({
        event: "model_validation_failed",
        id: entry.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  // Salvar resultado
  const report = {
    timestamp: new Date().toISOString(),
    totalFound: freeModels.length,
    tested: Math.min(10, freeModels.length),
    working: workingModels.length,
    models: workingModels,
    recommendations: workingModels.slice(0, 3).map(m => m.id),
  };

  await writeFile("test-results/free-models-discovery.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: "discovery_complete", working: workingModels.length, report }));

  if (workingModels.length === 0) {
    console.error("Nenhum modelo gratuito funcionando encontrado");
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    event: "discovery_failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
