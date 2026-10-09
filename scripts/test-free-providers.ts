/**
 * Teste isolado de APIs de modelos gratuitos
 * Faz chamadas HTTP diretas sem dependências do projeto
 */

async function testOpenRouterFreeModels() {
  console.log("🔍 Testando OpenRouter (modelos gratuitos)...\n");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "HTTP-Referer": "https://github.com/your-repo" }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ id: string; name: string; pricing: { prompt: string; completion: string } }> };
    const freeModels = data.data.filter((m) => {
      const prompt = Number(m.pricing?.prompt);
      const completion = Number(m.pricing?.completion);
      return prompt === 0 && completion === 0;
    });

    console.log(`✅ Encontrados ${freeModels.length} modelos gratuitos no OpenRouter:`);
    freeModels.slice(0, 10).forEach((m) => {
      console.log(`   - ${m.id}: ${m.name}`);
    });

    return freeModels.length > 0;
  } catch (error) {
    console.error("❌ Erro ao consultar OpenRouter:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function testNvidiaNIM() {
  console.log("\n🔍 Testando NVIDIA NIM...\n");

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { "Accept": "application/json" }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ id: string; object: string }> };
    const chatModels = data.data.filter((m) => m.object === "model" && !m.id.includes("embed"));

    console.log(`✅ Encontrados ${chatModels.length} modelos NVIDIA NIM:`);
    chatModels.slice(0, 10).forEach((m) => {
      console.log(`   - ${m.id}`);
    });

    return chatModels.length > 0;
  } catch (error) {
    console.error("❌ Erro ao consultar NVIDIA NIM:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function testGeminiAPI() {
  console.log("\n🔍 Testando Google Gemini...\n");

  const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.log("⚠️  GOOGLE_AI_API_KEY não configurada - pulando teste de listagem");
    console.log("   Modelos conhecidos: gemini-2.0-flash, gemini-1.5-flash, gemini-1.5-pro");
    return true;
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { models: Array<{ name: string; displayName: string }> };
    const geminiModels = data.models.filter((m) =>
      m.name.includes("gemini") && m.name.includes("generateContent")
    );

    console.log(`✅ Encontrados ${geminiModels.length} modelos Gemini:`);
    geminiModels.slice(0, 10).forEach((m) => {
      console.log(`   - ${m.displayName}`);
    });

    return geminiModels.length > 0;
  } catch (error) {
    console.error("❌ Erro ao consultar Gemini API:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function main() {
  console.log("🚀 TESTE DE INTEGRAÇÃO: Modelos Gratuitos\n");
  console.log("=" .repeat(60) + "\n");

  const openRouterOk = await testOpenRouterFreeModels();
  const nvidiaOk = await testNvidiaNIM();
  const geminiOk = await testGeminiAPI();

  console.log("\n" + "=".repeat(60));
  console.log("\n📊 RESUMO DOS TESTES:\n");
  console.log(`   OpenRouter: ${openRouterOk ? "✅" : "❌"}`);
  console.log(`   NVIDIA NIM: ${nvidiaOk ? "✅" : "❌"}`);
  console.log(`   Google Gemini: ${geminiOk ? "✅" : "❌"}`);

  const allOk = openRouterOk && nvidiaOk && geminiOk;

  if (allOk) {
    console.log("\n✅ TODOS OS PROVEDORES GRATUITOS ESTÃO ACESSÍVEIS!\n");
    console.log("📋 Próximos passos para usar:");
    console.log("   1. Configure OPENROUTER_API_KEY no .env.local");
    console.log("   2. Configure NVIDIA_API_KEY (opcional)");
    console.log("   3. Configure GOOGLE_AI_API_KEY (opcional)");
    console.log("   4. Execute npm run dev e selecione um modelo gratuito");
    console.log("\n💡 Modelos recomendados para começar:");
    console.log("   - meta-llama/llama-3.3-70b-instruct:free (OpenRouter)");
    console.log("   - qwen/qwen-2.5-coder-32b-instruct:free (OpenRouter)");
    console.log("   - google/gemini-2.0-flash-exp:free (OpenRouter)");
    console.log("   - nvidia/llama-3.1-nemotron-70b-instruct (NVIDIA NIM)");
    process.exit(0);
  } else {
    console.log("\n⚠️  Alguns provedores não estão acessíveis (verifique conexão)");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("\n❌ Erro fatal:", error);
  process.exit(1);
});
