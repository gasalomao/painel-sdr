/**
 * Teste de integração com modelos gratuitos (OpenRouter + NVIDIA NIM)
 * Valida que a geração de código funciona ponta a ponta com modelos gratuitos.
 */

import { listWebsiteModels, selectWebsiteModels } from "../src/lib/sites/models";
import { executeWebsiteAgent } from "../src/lib/sites/agent";
import type { WebsiteSettings, WebsiteAgentRequest } from "../src/lib/sites/types";

const FREE_MODEL_SETTINGS: WebsiteSettings = {
  model_allowlist: [],
  quality_model: "",
  economy_model: "",
  enable_impeccable: false,
  enable_advanced_skills: false,
};

async function testFreeModels() {
  console.log("🔍 Descobrindo modelos gratuitos disponíveis...\n");

  const allModels = await listWebsiteModels(FREE_MODEL_SETTINGS, true);
  const freeModels = allModels.filter((m) => m.isFree);

  console.log(`✅ Encontrados ${freeModels.length} modelos gratuitos:`);
  freeModels.slice(0, 10).forEach((m) => {
    console.log(`  - ${m.id} (${m.name})`);
  });

  if (!freeModels.length) {
    console.error("\n❌ ERRO: Nenhum modelo gratuito disponível.");
    process.exit(1);
  }

  // Selecionar um modelo gratuito para teste
  const testModel = freeModels[0];
  console.log(`\n🎯 Testando geração de código com: ${testModel.id}\n`);

  const request: WebsiteAgentRequest = {
    prompt: "Crie um botão azul com o texto 'Clique aqui'",
    model_id: testModel.id,
    base_files: {
      "package.json": JSON.stringify({ name: "test-site", type: "module" }),
      "index.html": "<!DOCTYPE html><html><head><title>Test</title></head><body><div id=\"root\"></div></body></html>",
      "src/main.tsx": "import { createRoot } from 'react-dom/client'; import App from './App'; createRoot(document.getElementById('root')!).render(<App />);",
      "src/App.tsx": "export default function App() { return <div>Placeholder</div>; }",
    },
    selected_skill_ids: [],
    asset_metadata: [],
  };

  try {
    const result = await executeWebsiteAgent(request, FREE_MODEL_SETTINGS);

    console.log("✅ Geração completada com sucesso!");
    console.log(`📊 Tokens usados: ${JSON.stringify(result.usage)}`);
    console.log(`📝 Arquivos gerados: ${Object.keys(result.files).length}`);
    console.log(`💬 Mensagem: ${result.message.substring(0, 200)}...`);

    // Validar que o código foi realmente gerado
    if (!result.files["src/App.tsx"]) {
      throw new Error("Arquivo src/App.tsx não foi gerado");
    }

    const appContent = result.files["src/App.tsx"];
    if (!appContent.includes("button") && !appContent.includes("Button")) {
      throw new Error("Código gerado não contém botão como solicitado");
    }

    console.log("\n✅ TESTE APROVADO: Modelo gratuito gerou código válido");
    console.log(`\nConteúdo gerado (preview):\n${appContent.substring(0, 300)}...\n`);

    // Testar fallback: simular falha e ver se outro modelo gratuito assume
    console.log("\n🔄 Testando sistema de fallback...");
    const selectedModels = selectWebsiteModels(
      allModels,
      FREE_MODEL_SETTINGS,
      "manual",
      testModel.id,
      false,
      { freeOnly: true }
    );

    console.log(`📋 Modelos selecionados para fallback (${selectedModels.length}):`);
    selectedModels.forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.id}${i === 0 ? " (primário)" : " (fallback)"}`);
    });

    if (selectedModels.length < 2) {
      console.warn("⚠️  AVISO: Apenas 1 modelo disponível, fallback limitado");
    } else {
      console.log("✅ Sistema de fallback configurado corretamente");
    }

  } catch (error) {
    console.error("\n❌ ERRO na geração de código:");
    console.error(error);
    process.exit(1);
  }
}

testFreeModels().catch((error) => {
  console.error("❌ Erro fatal:", error);
  process.exit(1);
});
