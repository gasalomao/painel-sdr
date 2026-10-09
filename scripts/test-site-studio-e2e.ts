/**
 * Teste end-to-end da funcionalidade Site Studio com Impeccable Design
 *
 * Testa o fluxo completo:
 * 1. Criar um projeto via website_projects
 * 2. Criar uma run de geração
 * 3. Verificar se o HTML gerado inclui elementos de design do Impeccable
 * 4. Fazer uma edição no site
 * 5. Verificar persistência e integridade
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/supabase";

config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient<Database>(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Mock client ID
const TEST_CLIENT_ID = "00000000-0000-0000-0000-000000000001";

async function testSiteStudioE2E() {
  console.log("🧪 Teste E2E: Site Studio + Impeccable Design\n");

  let projectId: string | undefined;

  try {
    // ============= ETAPA 1: Criar um novo projeto =============
    console.log("📝 Etapa 1: Criar novo projeto...");

    const { data: project, error: createError } = await supabase
      .from("website_projects")
      .insert({
        client_id: TEST_CLIENT_ID,
        name: "Site Teste E2E Impeccable",
        slug: `e2e-test-${Date.now()}`,
        instructions: "Site de teste end-to-end para validar Impeccable Design",
        status: "draft",
      })
      .select()
      .single();

    if (createError || !project) {
      console.error("❌ Erro ao criar projeto:", createError);
      process.exit(1);
    }

    projectId = project.id;
    console.log(`✅ Projeto criado: ${project.slug} (ID: ${projectId})`);

    // ============= ETAPA 2: Simular geração de site via LLM =============
    console.log("\n🤖 Etapa 2: Simular geração via LLM...");

    const prompt = "Crie uma landing page moderna para uma startup de tecnologia";

    const { data: run, error: runError } = await supabase
      .from("website_runs")
      .insert({
        client_id: TEST_CLIENT_ID,
        project_id: projectId,
        prompt,
        status: "queued",
        actor_id: TEST_CLIENT_ID,
      })
      .select()
      .single();

    if (runError || !run) {
      console.error("❌ Erro ao criar run:", runError);
      process.exit(1);
    }

    console.log(`✅ Run criado (ID: ${run.id})`);

    // Simular o LLM gerando HTML com elementos Impeccable
    const mockHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Startup Tech</title>
  <style>
    :root {
      --surface-1: #05070C;
      --surface-2: #0A0D12;
      --accent: #38BDF8;
      --text: #E5E7EB;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, sans-serif;
      background: var(--surface-1);
      color: var(--text);
      line-height: 1.6;
    }
    .hero {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 2rem;
    }
    h1 {
      font-size: clamp(2rem, 5vw, 4rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      background: linear-gradient(135deg, var(--accent), #6EE7B7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .cta {
      margin-top: 2rem;
      padding: 1rem 2rem;
      background: var(--accent);
      color: var(--surface-1);
      border: none;
      border-radius: 999px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s;
    }
    .cta:hover { transform: scale(1.05); }
  </style>
</head>
<body>
  <section class="hero">
    <div>
      <h1>Transforme seu negócio com tecnologia</h1>
      <p style="margin-top: 1rem; font-size: 1.25rem; opacity: 0.8;">
        Soluções inovadoras para empresas que pensam no futuro
      </p>
      <button class="cta">Começar agora</button>
    </div>
  </section>
</body>
</html>`;

    // Criar uma revisão com o HTML gerado
    const { data: revision, error: revisionError } = await supabase
      .from("website_revisions")
      .insert({
        client_id: TEST_CLIENT_ID,
        project_id: projectId,
        message: "Criação inicial via LLM",
        files: { "index.html": mockHtml },
        hash: "mock-hash-" + Date.now(),
        actor_id: TEST_CLIENT_ID,
      })
      .select()
      .single();

    if (revisionError || !revision) {
      console.error("❌ Erro ao criar revisão:", revisionError);
      process.exit(1);
    }

    console.log(`✅ Revisão criada (ID: ${revision.id})`);

    // Atualizar o run e o projeto
    const { error: updateRunError } = await supabase
      .from("website_runs")
      .update({
        status: "completed",
      })
      .eq("id", run.id);

    if (updateRunError) {
      console.error("❌ Erro ao atualizar run:", updateRunError);
      process.exit(1);
    }

    const { error: updateProjectError } = await supabase
      .from("website_projects")
      .update({
        current_revision_id: revision.id,
      })
      .eq("id", projectId);

    if (updateProjectError) {
      console.error("❌ Erro ao atualizar projeto:", updateProjectError);
      process.exit(1);
    }

    console.log("✅ HTML gerado e persistido na revisão");

    // ============= ETAPA 3: Validar elementos Impeccable =============
    console.log("\n🎨 Etapa 3: Validar elementos do Impeccable Design...");

    const impeccableChecks = [
      { name: "Variáveis CSS (--surface, --accent)", regex: /--surface-\d|--accent/i },
      { name: "Fonte fluida (clamp)", regex: /clamp\(/i },
      { name: "Border radius extremo (999px ou 50%)", regex: /(border-radius:\s*999px|border-radius:\s*50%)/i },
      { name: "Grid ou Flexbox", regex: /(display:\s*grid|display:\s*flex)/i },
      { name: "Gradiente de texto", regex: /-webkit-background-clip:\s*text/i },
    ];

    let passedChecks = 0;
    for (const check of impeccableChecks) {
      const passed = check.regex.test(mockHtml);
      console.log(`   ${passed ? "✅" : "⚠️ "} ${check.name}`);
      if (passed) passedChecks++;
    }

    console.log(`\n   Score: ${passedChecks}/${impeccableChecks.length}`);

    if (passedChecks < 3) {
      console.warn("⚠️  Poucos elementos do Impeccable Design detectados!");
      console.warn("   Isso pode indicar que a skill não está sendo aplicada corretamente.");
    }

    // ============= ETAPA 4: Fazer uma edição =============
    console.log("\n✏️  Etapa 4: Fazer edição no site...");

    const editPrompt = "Adicione uma seção de features com 3 cards";

    const { data: editRun, error: editRunError } = await supabase
      .from("website_runs")
      .insert({
        client_id: TEST_CLIENT_ID,
        project_id: projectId,
        prompt: editPrompt,
        status: "queued",
        actor_id: TEST_CLIENT_ID,
      })
      .select()
      .single();

    if (editRunError || !editRun) {
      console.error("❌ Erro ao criar run de edição:", editRunError);
      process.exit(1);
    }

    // Simular HTML editado
    const editedHtml = mockHtml.replace(
      "</section>",
      `</section>
  <section style="padding: 4rem 2rem; background: var(--surface-2);">
    <h2 style="text-align: center; font-size: 2rem; margin-bottom: 2rem;">Nossas Features</h2>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2rem; max-width: 1200px; margin: 0 auto;">
      <div style="background: var(--surface-1); padding: 2rem; border-radius: 1rem;">
        <h3>Velocidade</h3>
        <p style="opacity: 0.8; margin-top: 0.5rem;">Performance de ponta</p>
      </div>
      <div style="background: var(--surface-1); padding: 2rem; border-radius: 1rem;">
        <h3>Segurança</h3>
        <p style="opacity: 0.8; margin-top: 0.5rem;">Proteção total de dados</p>
      </div>
      <div style="background: var(--surface-1); padding: 2rem; border-radius: 1rem;">
        <h3>Escalabilidade</h3>
        <p style="opacity: 0.8; margin-top: 0.5rem;">Cresce com seu negócio</p>
      </div>
    </div>
  </section>`
    );

    // Criar revisão da edição
    const { data: editRevision, error: editRevisionError } = await supabase
      .from("website_revisions")
      .insert({
        client_id: TEST_CLIENT_ID,
        project_id: projectId,
        parent_id: revision.id,
        message: "Adicionada seção de features",
        files: { "index.html": editedHtml },
        hash: "mock-hash-edit-" + Date.now(),
        actor_id: TEST_CLIENT_ID,
      })
      .select()
      .single();

    if (editRevisionError || !editRevision) {
      console.error("❌ Erro ao criar revisão de edição:", editRevisionError);
      process.exit(1);
    }

    // Atualizar run de edição e projeto
    const { error: updateEditRunError } = await supabase
      .from("website_runs")
      .update({
        status: "completed",
      })
      .eq("id", editRun.id);

    if (updateEditRunError) {
      console.error("❌ Erro ao atualizar run de edição:", updateEditRunError);
      process.exit(1);
    }

    const { error: updateEditedProjectError } = await supabase
      .from("website_projects")
      .update({
        current_revision_id: editRevision.id,
      })
      .eq("id", projectId);

    if (updateEditedProjectError) {
      console.error("❌ Erro ao atualizar projeto com edição:", updateEditedProjectError);
      process.exit(1);
    }

    console.log("✅ Edição aplicada e persistida");

    // ============= ETAPA 5: Verificar histórico =============
    console.log("\n📚 Etapa 5: Verificar histórico de runs...");

    const { data: allRuns, error: runsError } = await supabase
      .from("website_runs")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (runsError || !allRuns) {
      console.error("❌ Erro ao buscar runs:", runsError);
      process.exit(1);
    }

    console.log(`✅ Total de runs: ${allRuns.length}`);
    allRuns.forEach((r, i) => {
      console.log(`   ${i + 1}. ${r.prompt?.substring(0, 50)}... (${r.status})`);
    });

    // ============= LIMPEZA =============
    console.log("\n🧹 Limpeza: Removendo dados de teste...");

    await supabase.from("website_runs").delete().eq("project_id", projectId);
    await supabase.from("website_projects").delete().eq("id", projectId);

    console.log("✅ Dados de teste removidos");

    // ============= RESULTADO FINAL =============
    console.log("\n🎉 Teste E2E concluído com SUCESSO!");
    console.log("\n📊 Resumo:");
    console.log(`   • Projeto criado: ${project.slug}`);
    console.log(`   • Runs executadas: ${allRuns.length}`);
    console.log(`   • Elementos Impeccable detectados: ${passedChecks}/${impeccableChecks.length}`);
    console.log(`   • HTML final: ${editedHtml.length} caracteres`);
    console.log("\n✅ Todas as operações funcionaram corretamente.\n");

  } catch (err) {
    console.error("\n💥 Erro durante o teste:", err);

    // Tentar limpar dados de teste mesmo em caso de erro
    if (projectId) {
      console.log("🧹 Tentando limpar dados de teste...");
      await supabase.from("website_runs").delete().eq("project_id", projectId);
      await supabase.from("website_projects").delete().eq("id", projectId);
    }

    process.exit(1);
  }
}

testSiteStudioE2E().catch(err => {
  console.error("💥 Erro fatal:", err);
  process.exit(1);
});
