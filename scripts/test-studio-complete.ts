#!/usr/bin/env node
/**
 * Teste completo do Site Studio: criação, edição econômica, recuperação entre modelos
 * Autorizado pelo usuário para validar economia de tokens e continuidade
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { WebsiteAgentDependencies } from "../src/lib/sites/agent";
import type { WebsiteRunCheckpoint } from "../src/lib/sites/run-checkpoint";
import type { WebsiteFiles, WebsiteProject, WebsiteRun, WebsiteModel } from "../src/lib/sites/types";
import { getCleanStarterFiles } from "../src/lib/sites/starter";
import { validateWebsiteContent } from "../src/lib/sites/validation";
import { assertFreeTestQuota, createFreeTestQuota, reserveFreeTestTokens, settleFreeTestUsage, startFreeTestRequest, validateFreeTestModel, FREE_TEST_LIMITS } from "./test-site-free";

interface TestMetrics {
  phase: string;
  modelId: string;
  requests: number;
  conservativeTokens: number;
  outputTokens: number;
  duration: number;
  success: boolean;
  economyAchieved?: boolean;
  recoveryPreserved?: boolean;
}

const metrics: TestMetrics[] = [];

function logMetric(phase: string, data: Partial<TestMetrics>): void {
  const entry: TestMetrics = {
    phase,
    modelId: data.modelId || "unknown",
    requests: data.requests || 0,
    conservativeTokens: data.conservativeTokens || 0,
    outputTokens: data.outputTokens || 0,
    duration: data.duration || 0,
    success: data.success ?? false,
    economyAchieved: data.economyAchieved,
    recoveryPreserved: data.recoveryPreserved,
  };
  metrics.push(entry);
  console.log(JSON.stringify({ event: "metric", ...entry }));
}

/** Fase 1: Criação do zero com modelo gratuito */
async function testCreation(model: WebsiteModel, signal: AbortSignal): Promise<{ files: WebsiteFiles; checkpoint: WebsiteRunCheckpoint }> {
  const startTime = Date.now();
  const { WebsiteAgentRuntime } = await import("../src/lib/sites/agent");
  const { composeWebsitePrompt, DEFAULT_WEBSITE_SETTINGS } = await import("../src/lib/sites/prompts");
  const { websiteChatAttempt } = await import("../src/lib/sites/models");
  const { websiteTokenBudget } = await import("../src/lib/sites/agent");

  let quota = createFreeTestQuota(Date.now(), 160_000); // Limite para criação
  let lastCheckpoint: WebsiteRunCheckpoint | undefined;
  let totalOutputTokens = 0;

  const stamp = new Date(0).toISOString();
  const project: WebsiteProject = {
    id: "00000000-0000-4000-8000-000000000001",
    client_id: "00000000-0000-4000-8000-000000000002",
    name: "Test Site Studio",
    slug: "test-site-studio",
    lead_id: null,
    client_context: { name: "Test Site", segment: "Teste", description: "Site de teste para validação do Studio" },
    instructions: "Site simples e econômico. Sem imagens externas, sem recursos remotos.",
    model_mode: "manual",
    model_id: model.id,
    selected_skill_ids: [],
    cta: { type: "form", value: "" },
    status: "draft",
    current_revision_id: null,
    published_deployment_id: null,
    published_url: null,
    last_published_at: null,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  };

  const run: WebsiteRun = {
    id: "00000000-0000-4000-8000-000000000004",
    client_id: project.client_id,
    project_id: project.id,
    kind: "agent",
    status: "editing",
    prompt: "Crie uma landing page simples: cabeçalho com título, seção hero com CTA, 2 cards de features e rodapé. Use cores azul e branco, design limpo. Escreva src/App.tsx e src/styles.css. Valide e conclua.",
    model_id: model.id,
    base_revision_id: null,
    asset_ids: [],
    error: null,
    cancel_requested: false,
    lease_expires_at: null,
    created_at: stamp,
    updated_at: stamp,
  };

  const files = getCleanStarterFiles();
  const settings = { ...DEFAULT_WEBSITE_SETTINGS, model_allowlist: [model.id], economy_model: model.id, quality_model: model.id };

  const deps: WebsiteAgentDependencies = {
    load: async () => ({
      project,
      files,
      assets: [],
      models: [model],
      settings,
      systemPrompt: composeWebsitePrompt(project, [], settings.creative_prompt, run.prompt, files),
      history: [],
    }),
    check: async () => { signal.throwIfAborted(); assertFreeTestQuota(quota); },
    event: async () => {},
    status: async () => {},
    checkpoint: async (_run, value) => {
      signal.throwIfAborted();
      assertFreeTestQuota(quota);
      lastCheckpoint = structuredClone(value);
    },
    reserveTokens: async (_run, amount) => {
      signal.throwIfAborted();
      quota = reserveFreeTestTokens(quota, amount);
      return `creation-${quota.requests}`;
    },
    usage: async (_run, usage) => {
      quota = settleFreeTestUsage(quota, usage);
      if (usage?.completionTokens) totalOutputTokens += usage.completionTokens;
    },
    chat: async (models, body, signal) => {
      signal.throwIfAborted();
      assertFreeTestQuota(quota);
      assert.equal(models[0].id, model.id);
      const bounded = { ...body, max_tokens: 8000 };
      quota = startFreeTestRequest(quota);
      return await websiteChatAttempt(model, bounded, signal);
    },
    build: async () => ({
      status: "unconfigured",
      success: false,
      logs: "",
      errors: [],
      warnings: ["Build not executed in test"],
      duration_ms: 0,
      artifact: {},
      screenshots: {},
      qa: { passed: false, errors: [], warnings: [] },
    }),
    complete: async (_run, files, _build) => {
      assert.ok(validateWebsiteContent(files).passed, "Created files invalid");
    },
  };

  await new WebsiteAgentRuntime(deps).run(run, signal);

  const duration = Date.now() - startTime;
  assert.ok(lastCheckpoint, "No checkpoint saved");

  logMetric("creation", {
    modelId: model.id,
    requests: quota.requests,
    conservativeTokens: quota.accountedTokens,
    outputTokens: totalOutputTokens,
    duration,
    success: true,
  });

  return { files: lastCheckpoint.files, checkpoint: lastCheckpoint };
}

/** Fase 2: Edição simples - deve economizar tokens */
async function testSimpleEdit(
  model: WebsiteModel,
  baseFiles: WebsiteFiles,
  baseCheckpoint: WebsiteRunCheckpoint,
  signal: AbortSignal
): Promise<{ files: WebsiteFiles; economyAchieved: boolean }> {
  const startTime = Date.now();
  const { WebsiteAgentRuntime } = await import("../src/lib/sites/agent");
  const { composeWebsitePrompt, DEFAULT_WEBSITE_SETTINGS } = await import("../src/lib/sites/prompts");
  const { websiteChatAttempt } = await import("../src/lib/sites/models");

  let quota = createFreeTestQuota(Date.now(), 60_000); // Limite menor para edição
  let totalOutputTokens = 0;
  let finalFiles: WebsiteFiles | undefined;

  const stamp = new Date(0).toISOString();
  const project: WebsiteProject = {
    id: "00000000-0000-4000-8000-000000000001",
    client_id: "00000000-0000-4000-8000-000000000002",
    name: "Test Site Studio",
    slug: "test-site-studio",
    lead_id: null,
    client_context: { name: "Test Site", segment: "Teste", description: "Site de teste para validação do Studio" },
    instructions: "Preserve arquivos existentes. Faça apenas ajustes solicitados.",
    model_mode: "manual",
    model_id: model.id,
    selected_skill_ids: [],
    cta: { type: "form", value: "" },
    status: "draft",
    current_revision_id: "00000000-0000-4000-8000-000000000003",
    published_deployment_id: null,
    published_url: null,
    last_published_at: null,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  };

  const run: WebsiteRun = {
    id: "00000000-0000-4000-8000-000000000005",
    client_id: project.client_id,
    project_id: project.id,
    kind: "agent",
    status: "editing",
    prompt: 'Altere apenas o texto do título principal para "Site de Teste Validado". Preserve todo o resto.',
    model_id: model.id,
    base_revision_id: project.current_revision_id,
    asset_ids: [],
    error: null,
    cancel_requested: false,
    lease_expires_at: null,
    created_at: stamp,
    updated_at: stamp,
  };

  const settings = { ...DEFAULT_WEBSITE_SETTINGS, model_allowlist: [model.id], economy_model: model.id };

  const deps: WebsiteAgentDependencies = {
    load: async () => ({
      project,
      files: baseFiles,
      assets: [],
      models: [model],
      settings,
      systemPrompt: composeWebsitePrompt(project, [], settings.creative_prompt, run.prompt, baseFiles),
      history: [],
    }),
    check: async () => { signal.throwIfAborted(); assertFreeTestQuota(quota); },
    event: async () => {},
    status: async () => {},
    checkpoint: async () => {},
    reserveTokens: async (_run, amount) => {
      signal.throwIfAborted();
      quota = reserveFreeTestTokens(quota, amount);
      return `edit-${quota.requests}`;
    },
    usage: async (_run, usage) => {
      quota = settleFreeTestUsage(quota, usage);
      if (usage?.completionTokens) totalOutputTokens += usage.completionTokens;
    },
    chat: async (models, body, signal) => {
      signal.throwIfAborted();
      assertFreeTestQuota(quota);
      quota = startFreeTestRequest(quota);
      return await websiteChatAttempt(models[0], body, signal);
    },
    build: async () => ({
      status: "unconfigured",
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
      finalFiles = { ...files };
    },
  };

  await new WebsiteAgentRuntime(deps).run(run, signal);

  const duration = Date.now() - startTime;
  const economyAchieved = quota.accountedTokens < 10_000; // Edição deve usar <10k tokens

  logMetric("simple_edit", {
    modelId: model.id,
    requests: quota.requests,
    conservativeTokens: quota.accountedTokens,
    outputTokens: totalOutputTokens,
    duration,
    success: !!finalFiles,
    economyAchieved,
  });

  assert.ok(finalFiles, "Edit did not complete");
  return { files: finalFiles, economyAchieved };
}

/** Fase 3: Recuperação entre modelos */
async function testModelRecovery(
  model1: WebsiteModel,
  model2: WebsiteModel,
  signal: AbortSignal
): Promise<{ success: boolean; preserved: boolean }> {
  const startTime = Date.now();
  console.log(JSON.stringify({ event: "recovery_test", model1: model1.id, model2: model2.id }));

  // Simular checkpoint salvo pelo modelo 1
  const checkpointFromModel1: WebsiteRunCheckpoint = {
    files: {
      "src/App.tsx": "export default function App() { return <div>Checkpoint from Model 1</div>; }",
      "src/styles.css": "body { margin: 0; }",
    },
    request: "Continue development",
    notes: "Partial work from model 1",
    designDirection: "Clean and simple",
    budgetConsumed: { chatRequests: 2, totalTokens: 5000, outputTokens: 1000 },
    progress: {
      status: "editing",
      changedPaths: ["src/App.tsx"],
      diagnostics: [],
      nextAction: "Continue with model 2",
    },
  };

  // Modelo 2 retoma do checkpoint
  const { WebsiteAgentRuntime } = await import("../src/lib/sites/agent");
  const { composeWebsitePrompt, DEFAULT_WEBSITE_SETTINGS } = await import("../src/lib/sites/prompts");
  const { websiteChatAttempt } = await import("../src/lib/sites/models");

  let quota = createFreeTestQuota(Date.now(), 60_000);
  let recovered = false;

  const stamp = new Date(0).toISOString();
  const project: WebsiteProject = {
    id: "00000000-0000-4000-8000-000000000001",
    client_id: "00000000-0000-4000-8000-000000000002",
    name: "Recovery Test",
    slug: "recovery-test",
    lead_id: null,
    client_context: { name: "Recovery", segment: "Test", description: "Test recovery" },
    instructions: "Complete the work started by another model",
    model_mode: "manual",
    model_id: model2.id,
    selected_skill_ids: [],
    cta: { type: "form", value: "" },
    status: "draft",
    current_revision_id: null,
    published_deployment_id: null,
    published_url: null,
    last_published_at: null,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  };

  const run: WebsiteRun = {
    id: "00000000-0000-4000-8000-000000000006",
    client_id: project.client_id,
    project_id: project.id,
    kind: "agent",
    status: "editing",
    prompt: "Continue o trabalho anterior e adicione um parágrafo explicativo. Valide e conclua.",
    model_id: model2.id,
    base_revision_id: null,
    asset_ids: [],
    error: null,
    cancel_requested: false,
    lease_expires_at: null,
    created_at: stamp,
    updated_at: stamp,
  };

  const settings = { ...DEFAULT_WEBSITE_SETTINGS, model_allowlist: [model2.id], economy_model: model2.id };

  const deps: WebsiteAgentDependencies = {
    load: async () => ({
      project,
      files: checkpointFromModel1.files,
      assets: [],
      models: [model2],
      settings,
      systemPrompt: composeWebsitePrompt(project, [], settings.creative_prompt, run.prompt, checkpointFromModel1.files),
      history: [],
      pendingRequest: checkpointFromModel1.request,
      pendingNotes: checkpointFromModel1.notes,
      pendingProgress: checkpointFromModel1.progress,
      designDirection: checkpointFromModel1.designDirection,
      budgetConsumed: checkpointFromModel1.budgetConsumed,
    }),
    check: async () => { signal.throwIfAborted(); assertFreeTestQuota(quota); },
    event: async () => {},
    status: async () => {},
    checkpoint: async () => {},
    reserveTokens: async (_run, amount) => {
      signal.throwIfAborted();
      quota = reserveFreeTestTokens(quota, amount);
      return `recovery-${quota.requests}`;
    },
    usage: async (_run, usage) => {
      quota = settleFreeTestUsage(quota, usage);
    },
    chat: async (models, body, signal) => {
      signal.throwIfAborted();
      assertFreeTestQuota(quota);
      quota = startFreeTestRequest(quota);
      return await websiteChatAttempt(models[0], body, signal);
    },
    build: async () => ({
      status: "unconfigured",
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
      recovered = files["src/App.tsx"].includes("Checkpoint from Model 1");
    },
  };

  await new WebsiteAgentRuntime(deps).run(run, signal);

  const duration = Date.now() - startTime;

  logMetric("recovery", {
    modelId: model2.id,
    requests: quota.requests,
    conservativeTokens: quota.accountedTokens,
    outputTokens: 0,
    duration,
    success: recovered,
    recoveryPreserved: recovered,
  });

  return { success: recovered, preserved: recovered };
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200_000); // 20min total

  try {
    console.log(JSON.stringify({ event: "test_suite_started", timestamp: new Date().toISOString() }));

    // Carregar env
    const { config } = await import("dotenv");
    config({ path: ".env.local", quiet: true });
    config({ quiet: true });

    // Buscar modelos gratuitos do catálogo
    console.log(JSON.stringify({ event: "fetching_catalog" }));
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
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

    // Escolher modelos para teste (priorizar modelos conhecidos e confiáveis)
    const preferredIds = [
      "cohere/command-r7b-12-2024:free",
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.2-3b-instruct:free",
      "qwen/qwen-2.5-7b-instruct:free",
      "mistralai/mistral-7b-instruct:free",
    ];

    const testModels: WebsiteModel[] = [];

    // Tentar modelos preferidos primeiro
    for (const id of preferredIds) {
      const entry = freeModels.find((m: any) => m.id === id);
      if (entry) {
        try {
          const model = validateFreeTestModel(entry, id);
          testModels.push(model);
          console.log(JSON.stringify({ event: "model_validated", id: model.id }));
          if (testModels.length >= 2) break;
        } catch (e) {
          console.log(JSON.stringify({ event: "model_validation_failed", id, reason: e instanceof Error ? e.message : String(e) }));
        }
      }
    }

    // Fallback para outros modelos gratuitos
    if (testModels.length < 2) {
      for (const entry of freeModels) {
        if (testModels.length >= 2) break;
        try {
          const model = validateFreeTestModel(entry, entry.id);
          if (!testModels.find(m => m.id === model.id)) {
            testModels.push(model);
            console.log(JSON.stringify({ event: "model_validated", id: model.id }));
          }
        } catch { /* Skip invalid */ }
      }
    }

    assert.ok(testModels.length >= 1, "No free models available");
    console.log(JSON.stringify({ event: "models_selected", models: testModels.map(m => m.id) }));

    // FASE 1: Criação (tentar múltiplos modelos até um funcionar)
    console.log(JSON.stringify({ event: "phase_1_creation_start" }));
    let createdFiles: WebsiteFiles | undefined;
    let checkpoint: WebsiteRunCheckpoint | undefined;
    let creationModel: WebsiteModel | undefined;

    for (const model of testModels) {
      try {
        console.log(JSON.stringify({ event: "trying_model_for_creation", model: model.id }));
        const result = await testCreation(model, controller.signal);
        createdFiles = result.files;
        checkpoint = result.checkpoint;
        creationModel = model;
        console.log(JSON.stringify({ event: "phase_1_complete", model: model.id, filesCreated: Object.keys(createdFiles).length }));
        break;
      } catch (error) {
        console.log(JSON.stringify({
          event: "model_failed",
          model: model.id,
          error: error instanceof Error ? error.message : String(error),
        }));
        if (model === testModels[testModels.length - 1]) {
          throw new Error("All models failed for creation");
        }
      }
    }

    assert.ok(createdFiles && checkpoint && creationModel, "Creation failed with all models");

    // FASE 2: Edição simples
    console.log(JSON.stringify({ event: "phase_2_edit_start" }));
    const { files: editedFiles, economyAchieved } = await testSimpleEdit(
      creationModel,
      createdFiles,
      checkpoint,
      controller.signal
    );
    console.log(JSON.stringify({ event: "phase_2_complete", economyAchieved }));

    // FASE 3: Recuperação entre modelos (se houver 2 modelos disponíveis)
    if (testModels.length >= 2) {
      const recoveryModel = testModels.find(m => m.id !== creationModel.id) || testModels[1];
      console.log(JSON.stringify({ event: "phase_3_recovery_start" }));
      const { success: recoverySuccess, preserved } = await testModelRecovery(
        creationModel,
        recoveryModel,
        controller.signal
      );
      console.log(JSON.stringify({ event: "phase_3_complete", success: recoverySuccess, preserved }));
    }

    // Relatório final
    const report = {
      timestamp: new Date().toISOString(),
      totalPhases: metrics.length,
      phases: metrics,
      summary: {
        allSucceeded: metrics.every(m => m.success),
        totalRequests: metrics.reduce((sum, m) => sum + m.requests, 0),
        totalTokens: metrics.reduce((sum, m) => sum + m.conservativeTokens, 0),
        totalDuration: metrics.reduce((sum, m) => sum + m.duration, 0),
        economyAchieved: metrics.find(m => m.phase === "simple_edit")?.economyAchieved ?? false,
        recoveryPreserved: metrics.find(m => m.phase === "recovery")?.recoveryPreserved ?? false,
      },
    };

    await writeFile("test-results/studio-complete-report.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ event: "test_suite_complete", report: report.summary }));

    if (!report.summary.allSucceeded) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "test_suite_failed",
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
