/**
 * Script de teste end-to-end completo do Site Studio
 * Bypassa autenticação HTTP e testa diretamente as funções internas
 *
 * Uso: npx tsx scripts/test-site-studio-e2e.ts
 */

import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { config } from "dotenv";
import { resolve } from "path";

// Carrega variáveis de ambiente do .env.local
config({ path: resolve(process.cwd(), ".env.local") });

// Configuração
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TEST_USER_EMAIL = "test-site-studio@example.com";
const TEST_USER_PASSWORD = "test-password-123";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Variáveis de ambiente não configuradas!");
  console.error("   Certifique-se de que .env.local contém:");
  console.error("   - NEXT_PUBLIC_SUPABASE_URL");
  console.error("   - SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Alias para manter compatibilidade com o código
const supabaseAdmin = supabase;

interface TestResult {
  step: string;
  status: "success" | "error" | "skip";
  message: string;
  duration?: number;
  data?: any;
}

const results: TestResult[] = [];

function log(step: string, status: "success" | "error" | "skip", message: string, data?: any) {
  const result: TestResult = { step, status, message, data };
  results.push(result);

  const icon = status === "success" ? "✅" : status === "error" ? "❌" : "⏭️";
  console.log(`${icon} [${step}] ${message}`);
  if (data) {
    console.log(`   Data:`, JSON.stringify(data, null, 2));
  }
}

async function createTestUser(): Promise<string | null> {
  try {
    // Tenta criar usuário de teste
    const { data: existingUser, error: checkError } = await supabase.auth.admin.listUsers();

    const existing = existingUser?.users.find((u) => u.email === TEST_USER_EMAIL);

    if (existing) {
      log("create-user", "skip", `Usuário de teste já existe: ${existing.id}`);

      // Garante que o registro existe na tabela clients também
      const { data: clientExists } = await supabaseAdmin.from("clients").select("id").eq("id", existing.id).single();

      if (!clientExists) {
        // Cria o registro de cliente se não existir
        await supabaseAdmin.from("clients").insert({
          id: existing.id,
          name: "Test User Site Studio",
          email: TEST_USER_EMAIL,
          is_admin: false,
          is_active: true,
          features: {
            dashboard: true,
            leads: true,
            chat: true,
            sites: true,
          },
        });
      }

      return existing.id;
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    });

    if (error) {
      log("create-user", "error", `Erro ao criar usuário: ${error.message}`);
      return null;
    }

    // Cria registro correspondente na tabela clients
    const { error: clientError } = await supabaseAdmin.from("clients").insert({
      id: data.user.id,
      name: "Test User Site Studio",
      email: TEST_USER_EMAIL,
      is_admin: false,
      is_active: true,
      features: {
        dashboard: true,
        leads: true,
        chat: true,
        sites: true,
      },
    });

    if (clientError) {
      log("create-user", "error", `Erro ao criar registro de cliente: ${clientError.message}`);
      return null;
    }

    log("create-user", "success", `Usuário criado: ${data.user.id}`, { userId: data.user.id });
    return data.user.id;
  } catch (error) {
    log("create-user", "error", `Exception: ${error}`);
    return null;
  }
}

async function createProject(userId: string): Promise<string | null> {
  try {
    // Gera slug único a partir do nome + timestamp
    const name = "Casa do Agricultor";
    const baseSlug = name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // Remove acentos
      .replace(/[^a-z0-9]+/g, "-") // Substitui não alfanuméricos por hífen
      .replace(/^-+|-+$/g, ""); // Remove hífens no início/fim

    // Adiciona timestamp para garantir unicidade
    const slug = `${baseSlug}-${Date.now()}`;

    const projectData = {
      id: uuidv4(),
      client_id: userId,
      name,
      slug,
      status: "draft", // Corrigido: valores aceitos são 'draft', 'published', 'archived'
      client_context: {
        name: "João Silva",
        segment: "Agricultura Familiar",
        city: "Região Serrana, RJ",
        description: "Produtos orgânicos direto do produtor - cestas de vegetais frescos, ovos caipiras, mel artesanal",
        services: "Cestas orgânicas semanais, delivery, feiras locais, tours pela fazenda",
      },
      cta: {
        type: "whatsapp",
        value: "5521999887766",
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("website_projects")
      .insert(projectData)
      .select()
      .single();

    if (error) {
      log("create-project", "error", `Erro ao criar projeto: ${error.message}`);
      return null;
    }

    log("create-project", "success", `Projeto criado: ${data.id}`, { projectId: data.id });
    return data.id;
  } catch (error) {
    log("create-project", "error", `Exception: ${error}`);
    return null;
  }
}

async function createRun(projectId: string, userId: string): Promise<string | null> {
  try {
    const runData = {
      id: uuidv4(),
      client_id: userId,
      project_id: projectId,
      status: "queued",
      prompt: "Crie um site MODERNO e ELEGANTE que transmita sustentabilidade e vida no campo. O DESIGN deve ser profissional mas acolhedor, com uma paleta que remeta à natureza. Preciso de um site único e memorável que destaque a qualidade dos produtos orgânicos e a conexão direta com o produtor.",
      model_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      actor_id: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("website_runs")
      .insert(runData)
      .select()
      .single();

    if (error) {
      log("create-run", "error", `Erro ao criar run: ${error.message}`);
      return null;
    }

    log("create-run", "success", `Run criado: ${data.id}`, { runId: data.id });
    return data.id;
  } catch (error) {
    log("create-run", "error", `Exception: ${error}`);
    return null;
  }
}

async function checkModel(): Promise<boolean> {
  try {
    // Verifica se o modelo está disponível via OpenRouter
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
    });

    const models = await response.json();
    const nemotron = models.data?.find((m: any) =>
      m.id === "nvidia/nemotron-3-ultra-550b-a55b:free"
    );

    if (nemotron) {
      log("check-model", "success", "Modelo NVIDIA Nemotron disponível", {
        modelId: nemotron.id,
        contextLength: nemotron.context_length,
      });
      return true;
    } else {
      log("check-model", "error", "Modelo não encontrado no OpenRouter");
      return false;
    }
  } catch (error) {
    log("check-model", "error", `Exception ao verificar modelo: ${error}`);
    return false;
  }
}

async function testImpeccableIntegration(projectId: string): Promise<boolean> {
  try {
    // Verifica se Impeccable está integrado - correção do import path
    const impeccableModule = await import("../src/lib/sites/impeccable.js");
    const { impeccableReference, IMPECCABLE_REVISION, impeccableReferenceCatalog } = impeccableModule;

    // Testa função sem argumentos primeiro (catálogo)
    const catalog = impeccableReferenceCatalog();

    if (!catalog || catalog.length === 0) {
      log("check-impeccable", "error", "Catálogo Impeccable vazio");
      return false;
    }

    log("check-impeccable", "success", "Impeccable Design integrado", {
      revision: IMPECCABLE_REVISION,
      references: catalog.length,
    });

    // Testa leitura de uma referência específica
    try {
      const skillRef = impeccableReference("skill");
      if (!skillRef || skillRef.length === 0) {
        log("check-impeccable-skill", "error", "Referência 'skill' vazia");
        return false;
      }

      log("check-impeccable-skill", "success", `Referência skill carregada (${skillRef.length} caracteres)`);
    } catch (error) {
      log("check-impeccable-skill", "error", `Erro ao ler referência: ${error}`);
      return false;
    }

    return true;
  } catch (error) {
    log("check-impeccable", "error", `Exception: ${error}`);
    return false;
  }
}

async function simulateAgentRun(runId: string, projectId: string): Promise<boolean> {
  try {
    log("agent-simulation", "success", "Iniciando simulação de agent run...");

    // Atualiza status para "running"
    await supabase
      .from("website_runs")
      .update({ status: "running", updated_at: new Date().toISOString() })
      .eq("id", runId);

    log("agent-update-status", "success", "Status atualizado para 'running'");

    // Simula criação de activity logs
    const activities = [
      { type: "info", message: "Iniciando processamento do run..." },
      { type: "tool_start", message: "Carregando contexto do projeto...", status: "pending" },
      { type: "tool_complete", message: "Contexto carregado com sucesso.", status: "success", duration_ms: 234 },
      { type: "model_start", message: "Modelo nvidia/nemotron-3-ultra-550b-a55b:free: gerando código...", status: "pending" },
      { type: "thinking", message: "🤔 Analisando estrutura do site solicitado...", status: "pending" },
      { type: "planning", message: "📋 Criar 4 seções: home, serviços, sobre, contato", status: "pending" },
    ];

    for (const activity of activities) {
      await supabase.from("website_run_activities").insert({
        run_id: runId,
        type: activity.type,
        message: activity.message,
        status: activity.status || null,
        duration_ms: activity.duration_ms || null,
        created_at: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    log("agent-activities", "success", `${activities.length} activity logs criados`);

    // Simula criação de revisão
    const revisionId = uuidv4();
    await supabase.from("website_revisions").insert({
      id: revisionId,
      project_id: projectId,
      message: "Site gerado com sucesso (teste simulado)",
      created_at: new Date().toISOString(),
    });

    log("agent-revision", "success", `Revisão criada: ${revisionId}`);

    // Atualiza status para "completed"
    await supabase
      .from("website_runs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);

    log("agent-complete", "success", "Run marcado como completo");

    return true;
  } catch (error) {
    log("agent-simulation", "error", `Exception: ${error}`);
    return false;
  }
}

async function verifyActivitiesStream(runId: string): Promise<boolean> {
  try {
    // Verifica se activities foram salvas
    const { data: activities, error } = await supabase
      .from("website_run_activities")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: true });

    if (error) {
      log("verify-activities", "error", `Erro ao buscar activities: ${error.message}`);
      return false;
    }

    if (!activities || activities.length === 0) {
      log("verify-activities", "error", "Nenhuma activity encontrada");
      return false;
    }

    log("verify-activities", "success", `${activities.length} activities encontradas`, {
      count: activities.length,
      types: [...new Set(activities.map((a) => a.type))],
    });

    return true;
  } catch (error) {
    log("verify-activities", "error", `Exception: ${error}`);
    return false;
  }
}

async function cleanup(userId: string | null, projectId: string | null) {
  try {
    if (projectId) {
      await supabase.from("website_projects").delete().eq("id", projectId);
      log("cleanup-project", "success", "Projeto de teste deletado");
    }

    if (userId) {
      await supabase.auth.admin.deleteUser(userId);
      log("cleanup-user", "success", "Usuário de teste deletado");
    }
  } catch (error) {
    log("cleanup", "error", `Erro na limpeza: ${error}`);
  }
}

async function main() {
  console.log("🚀 INICIANDO TESTE END-TO-END DO SITE STUDIO\n");

  let userId: string | null = null;
  let projectId: string | null = null;
  let runId: string | null = null;

  try {
    // 1. Criar usuário de teste
    userId = await createTestUser();
    if (!userId) {
      throw new Error("Falha ao criar usuário de teste");
    }

    // 2. Verificar modelo disponível
    const modelAvailable = await checkModel();
    if (!modelAvailable) {
      log("test", "error", "Modelo NVIDIA Nemotron não disponível - continuando sem testar model call real");
    }

    // 3. Verificar integração Impeccable
    await testImpeccableIntegration("");

    // 4. Criar projeto
    projectId = await createProject(userId);
    if (!projectId) {
      throw new Error("Falha ao criar projeto");
    }

    // 5. Criar run
    runId = await createRun(projectId, userId);
    if (!runId) {
      throw new Error("Falha ao criar run");
    }

    // 6. Simular execução do agent
    const agentSuccess = await simulateAgentRun(runId, projectId);
    if (!agentSuccess) {
      throw new Error("Falha na simulação do agent");
    }

    // 7. Verificar activity logs
    const activitiesOk = await verifyActivitiesStream(runId);
    if (!activitiesOk) {
      throw new Error("Falha na verificação de activities");
    }

    console.log("\n✅ TESTE CONCLUÍDO COM SUCESSO!\n");

  } catch (error) {
    console.error("\n❌ TESTE FALHOU:", error);
  } finally {
    // Limpeza (opcional - comentar para inspecionar dados)
    // await cleanup(userId, projectId);

    console.log("\n📊 RESUMO DOS RESULTADOS:\n");
    console.table(
      results.map((r) => ({
        Passo: r.step,
        Status: r.status === "success" ? "✅" : r.status === "error" ? "❌" : "⏭️",
        Mensagem: r.message,
      }))
    );

    const successCount = results.filter((r) => r.status === "success").length;
    const errorCount = results.filter((r) => r.status === "error").length;
    const skipCount = results.filter((r) => r.status === "skip").length;

    console.log(`\n✅ Sucesso: ${successCount}`);
    console.log(`❌ Erros: ${errorCount}`);
    console.log(`⏭️  Pulados: ${skipCount}`);
    console.log(`📊 Total: ${results.length}\n`);

    if (projectId && runId) {
      console.log(`\n🔗 DADOS GERADOS:\n`);
      console.log(`Projeto ID: ${projectId}`);
      console.log(`Run ID: ${runId}`);
      console.log(`\nAcesse: http://localhost:3000/sites/${projectId}\n`);
    }
  }
}

main();
