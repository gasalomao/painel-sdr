#!/usr/bin/env node
/**
 * Teste de recuperação entre modelos
 * Simula falha do Nemotron e recuperação com Cohere
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  console.log(JSON.stringify({ event: "recovery_test_started", timestamp: new Date().toISOString() }));

  // Carregar env
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  config({ quiet: true });

  const { validateFreeTestModel, createFreeTestQuota, reserveFreeTestTokens, startFreeTestRequest, settleFreeTestUsage, assertFreeTestQuota } = await import("./test-site-free");
  const { WebsiteAgentRuntime } = await import("../src/lib/sites/agent");
  const { composeWebsitePrompt, DEFAULT_WEBSITE_SETTINGS } = await import("../src/lib/sites/prompts");
  const { websiteChatAttempt } = await import("../src/lib/sites/models");
  const { getCleanStarterFiles } = await import("../src/lib/sites/starter");
  const { validateWebsiteContent } = await import("../src/lib/sites/validation");

  // Buscar modelos
  console.log(JSON.stringify({ event: "fetching_models" }));
  const response = await fetch("https://openrouter.ai/api/v1/models");
  assert.ok(response.ok, "Catalog unavailable");
  const catalog: any = await response.json();

  // Modelo 1: Nemotron (para criar parcialmente)
  const nemotronEntry = catalog.data.find((m: any) => m.id === "nvidia/nemotron-3.5-lightning:free");
  assert.ok(nemotronEntry, "Nemotron not found");
  const model1 = validateFreeTestModel(nemotronEntry, "nvidia/nemotron-3.5-lightning:free");
  console.log(JSON.stringify({ event: "model1_validated", model: model1.id }));

  // Modelo 2: Cohere (para recuperar)
  const cohereEntry = catalog.data.find((m: any) => m.id === "cohere/north-mini-code:free");
  assert.ok(cohereEntry, "Cohere not found");
  const model2 = validateFreeTestModel(cohereEntry, "cohere/north-mini-code:free");
  console.log(JSON.stringify({ event: "model2_validated", model: model2.id }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);

  try {
    // FASE 1: Criar com Nemotron (simular falha após 2 requests)
    console.log(JSON.stringify({ event: "phase_1_partial_creation", model: model1.id }));

    let quota1 = createFreeTestQuota(Date.now(), 60_000); // Limite baixo para forçar "falha"
    let checkpoint1: any = null;
    let files1: any = null;

    const stamp = new Date(0).toISOString();
    const project = {
      id: "00000000-0000-4000-8000-000000000001",
      client_id: "00000000-0000-4000-8000-000000000002",
      name: "Test Recovery",
      slug: "test-recovery",
      lead_id: null,
      client_context: {
        name: "Recovery Test",
        segment: "Teste",
        description: "Teste de recuperação entre modelos"
      },
      instructions: "Site simples. Header, hero, 2 features, footer. Sem imagens externas.",
      model_mode: "manual" as const,
      model_id: model1.id,
      selected_skill_ids: [],
      cta: { type: "form" as const, value: "" },
      status: "draft" as const,
      current_revision_id: null,
      published_deployment_id: null,
      published_url: null,
      last_published_at: null,
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    };

    const run1 = {
      id: "00000000-0000-4000-8000-000000000004",
      client_id: project.client_id,
      project_id: project.id,
      kind: "agent" as const,
      status: "editing" as const,
      prompt: "Crie landing page: header, hero com título/subtítulo, 2 features, footer. Design azul. Valide e conclua.",
      model_id: model1.id,
      base_revision_id: null,
      asset_ids: [],
      error: null,
      cancel_requested: false,
      lease_expires_at: null,
      created_at: stamp,
      updated_at: stamp,
    };

    const starterFiles = getCleanStarterFiles();
    const settings = { ...DEFAULT_WEBSITE_SETTINGS, model_allowlist: [model1.id, model2.id] };

    try {
      await new WebsiteAgentRuntime({
        load: async () => ({
          project,
          files: starterFiles,
          assets: [],
          models: [model1],
          settings,
          systemPrompt: composeWebsitePrompt(project, [], settings.creative_prompt, run1.prompt, starterFiles),
          history: [],
        }),
        check: async () => {
          if (quota1.requests >= 2) {
            throw new Error("Simulando esgotamento de quota do modelo 1");
          }
          assertFreeTestQuota(quota1);
        },
        event: async () => {},
        status: async () => {},
        checkpoint: async (_run, value) => {
          checkpoint1 = value;
          files1 = value.files;
          console.log(JSON.stringify({
            event: "checkpoint_saved_model1",
            filesCount: Object.keys(value.files).length,
            budget: value.budgetConsumed,
          }));
        },
        reserveTokens: async (_run, amount) => {
          quota1 = reserveFreeTestTokens(quota1, amount);
          return `m1-${quota1.requests}`;
        },
        usage: async (_run, usage) => {
          quota1 = settleFreeTestUsage(quota1, usage);
        },
        chat: async (models, body, signal) => {
          quota1 = startFreeTestRequest(quota1);
          console.log(JSON.stringify({ event: "model1_request", number: quota1.requests }));
          return await websiteChatAttempt(models[0], body, signal);
        },
        build: async () => ({
          status: "unconfigured" as const,
          success: false,
          logs: "",
          errors: [],
          warnings: [],
          duration_ms: 0,
          artifact: {},
          screenshots: {},
          qa: { passed: false, errors: [], warnings: [] },
        }),
        complete: async (_run, files) => {
          files1 = files;
        },
      }).run(run1, controller.signal);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({ event: "model1_stopped", reason: msg, checkpointSaved: !!checkpoint1 }));
    }

    assert.ok(checkpoint1 && files1, "Modelo 1 não salvou checkpoint antes de falhar");
    console.log(JSON.stringify({
      event: "phase_1_complete",
      model: model1.id,
      requests: quota1.requests,
      tokens: quota1.accountedTokens,
      filesCreated: Object.keys(files1).length,
      checkpointSaved: true,
    }));

    // FASE 2: Recuperar com Cohere
    console.log(JSON.stringify({ event: "phase_2_recovery", model: model2.id }));

    let quota2 = createFreeTestQuota(Date.now(), 100_000);
    let files2: any = null;

    const run2 = {
      ...run1,
      id: "00000000-0000-4000-8000-000000000005",
      model_id: model2.id,
      prompt: "Continue de onde parou: termine o site. Valide e conclua.",
      base_revision_id: "00000000-0000-4000-8000-000000000003",
    };

    await new WebsiteAgentRuntime({
      load: async () => ({
        project: { ...project, current_revision_id: "00000000-0000-4000-8000-000000000003" },
        files: files1, // Carrega arquivos do checkpoint do modelo 1!
        assets: [],
        models: [model2],
        settings: { ...settings, model_allowlist: [model2.id] },
        systemPrompt: composeWebsitePrompt(
          { ...project, current_revision_id: "00000000-0000-4000-8000-000000000003" },
          [],
          settings.creative_prompt,
          run2.prompt,
          files1
        ),
        history: [],
      }),
      check: async () => assertFreeTestQuota(quota2),
      event: async () => {},
      status: async () => {},
      checkpoint: async (_run, value) => {
        console.log(JSON.stringify({
          event: "checkpoint_saved_model2",
          filesCount: Object.keys(value.files).length,
        }));
      },
      reserveTokens: async (_run, amount) => {
        quota2 = reserveFreeTestTokens(quota2, amount);
        return `m2-${quota2.requests}`;
      },
      usage: async (_run, usage) => {
        quota2 = settleFreeTestUsage(quota2, usage);
      },
      chat: async (models, body, signal) => {
        quota2 = startFreeTestRequest(quota2);
        console.log(JSON.stringify({ event: "model2_request", number: quota2.requests }));
        return await websiteChatAttempt(models[0], body, signal);
      },
      build: async () => ({
        status: "unconfigured" as const,
        success: false,
        logs: "",
        errors: [],
        warnings: [],
        duration_ms: 0,
        artifact: {},
        screenshots: {},
        qa: { passed: false, errors: [], warnings: [] },
      }),
      complete: async (_run, files) => {
        const validation = validateWebsiteContent(files);
        assert.ok(validation.passed, "Modelo 2 criou arquivos inválidos");
        files2 = files;
        console.log(JSON.stringify({
          event: "recovery_complete",
          validation: validation.passed,
        }));
      },
    }).run(run2, controller.signal);

    // Validar recuperação
    assert.ok(files2, "Modelo 2 não completou");

    const filesPreserved = Object.keys(files1).every(path => path in files2);
    const progressPreserved = Object.keys(files2).length >= Object.keys(files1).length;

    console.log(JSON.stringify({
      event: "phase_2_complete",
      model: model2.id,
      requests: quota2.requests,
      tokens: quota2.accountedTokens,
      filesPreserved,
      progressPreserved,
    }));

    // Relatório final
    const report = {
      timestamp: new Date().toISOString(),
      success: true,
      model1: {
        id: model1.id,
        requests: quota1.requests,
        tokens: quota1.accountedTokens,
        filesCreated: Object.keys(files1).length,
      },
      model2: {
        id: model2.id,
        requests: quota2.requests,
        tokens: quota2.accountedTokens,
        filesFinal: Object.keys(files2).length,
      },
      recovery: {
        filesPreserved,
        progressPreserved,
        totalRequests: quota1.requests + quota2.requests,
        totalTokens: quota1.accountedTokens + quota2.accountedTokens,
      },
    };

    await writeFile("test-results/recovery-test-report.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ event: "test_complete", success: true, report }));

  } catch (error) {
    console.error(JSON.stringify({
      event: "test_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
