#!/usr/bin/env node
/**
 * Teste end-to-end completo do Site Studio
 * Usa NVIDIA Nemotron 3.5 Lightning (gratuito, 1M contexto)
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface TestResult {
  phase: string;
  success: boolean;
  model: string;
  requests: number;
  totalTokens: number;
  outputTokens: number;
  duration: number;
  filesCreated?: number;
  economyAchieved?: boolean;
  error?: string;
}

const results: TestResult[] = [];

function logResult(result: TestResult): void {
  results.push(result);
  console.log(JSON.stringify({ event: "phase_complete", ...result }));
}

async function testCreationWithNemotron(): Promise<void> {
  const startTime = Date.now();
  console.log(JSON.stringify({ event: "test_started", timestamp: new Date().toISOString() }));

  // Carregar env
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  config({ quiet: true });

  const { validateFreeTestModel, createFreeTestQuota, reserveFreeTestTokens, startFreeTestRequest, settleFreeTestUsage, assertFreeTestQuota } = await import("./test-site-free");
  const { WebsiteAgentRuntime } = await import("../src/lib/sites/agent");
  const { composeWebsitePrompt, DEFAULT_WEBSITE_SETTINGS } = await import("../src/lib/sites/prompts");
  const { websiteChatAttempt } = await import("../src/lib/sites/models");
  const { websiteTokenBudget } = await import("../src/lib/sites/agent");
  const { getCleanStarterFiles } = await import("../src/lib/sites/starter");
  const { validateWebsiteContent } = await import("../src/lib/sites/validation");

  // Buscar e validar Nemotron
  console.log(JSON.stringify({ event: "fetching_nemotron" }));
  const response = await fetch("https://openrouter.ai/api/v1/models");
  assert.ok(response.ok, "Catalog unavailable");
  const catalog: any = await response.json();

  const nemotronEntry = catalog.data.find((m: any) => m.id === "nvidia/nemotron-3.5-lightning:free");
  assert.ok(nemotronEntry, "Nemotron not found in catalog");

  const model = validateFreeTestModel(nemotronEntry, "nvidia/nemotron-3.5-lightning:free");
  console.log(JSON.stringify({ event: "model_validated", model: model.id, context: model.contextLength }));

  // FASE 1: Criação
  console.log(JSON.stringify({ event: "phase_1_creation" }));
  let quota = createFreeTestQuota(Date.now(), 160_000);
  let totalOutputTokens = 0;
  let checkpointSaved = false;
  let filesCreated: any = null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);

  try {
    const stamp = new Date(0).toISOString();
    const project = {
      id: "00000000-0000-4000-8000-000000000001",
      client_id: "00000000-0000-4000-8000-000000000002",
      name: "Test Landing Page",
      slug: "test-landing",
      lead_id: null,
      client_context: {
        name: "Test Landing",
        segment: "Teste",
        description: "Landing page de teste para validação"
      },
      instructions: "Site simples e direto. Sem imagens externas nem recursos remotos.",
      model_mode: "manual" as const,
      model_id: model.id,
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

    const run = {
      id: "00000000-0000-4000-8000-000000000004",
      client_id: project.client_id,
      project_id: project.id,
      kind: "agent" as const,
      status: "editing" as const,
      prompt: "Crie uma landing page simples: header com logo e nav, hero com título/subtítulo/CTA, seção de 3 features com ícones emoji, footer. Design limpo azul e branco, totalmente responsivo. Escreva App.tsx e styles.css. Valide e conclua.",
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

    await new WebsiteAgentRuntime({
      load: async () => ({
        project,
        files,
        assets: [],
        models: [model],
        settings,
        systemPrompt: composeWebsitePrompt(project, [], settings.creative_prompt, run.prompt, files),
        history: [],
      }),
      check: async () => {
        controller.signal.throwIfAborted();
        assertFreeTestQuota(quota);
      },
      event: async () => {},
      status: async () => {},
      checkpoint: async (_run, value) => {
        checkpointSaved = true;
        console.log(JSON.stringify({
          event: "checkpoint_saved",
          filesCount: Object.keys(value.files).length,
          changedPaths: value.progress?.changedPaths.length || 0,
        }));
      },
      reserveTokens: async (_run, amount) => {
        quota = reserveFreeTestTokens(quota, amount);
        return `creation-${quota.requests}`;
      },
      usage: async (_run, usage) => {
        quota = settleFreeTestUsage(quota, usage);
        if (usage?.completionTokens) totalOutputTokens += usage.completionTokens;
        console.log(JSON.stringify({
          event: "tokens_used",
          total: quota.accountedTokens,
          output: totalOutputTokens,
        }));
      },
      chat: async (models, body, signal) => {
        quota = startFreeTestRequest(quota);
        const bounded = { ...body, max_tokens: 8000 };
        console.log(JSON.stringify({ event: "chat_request", number: quota.requests }));
        return await websiteChatAttempt(models[0], bounded, signal);
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
      complete: async (_run, files, _build) => {
        const validation = validateWebsiteContent(files);
        assert.ok(validation.passed, "Invalid files created");
        filesCreated = files;
        console.log(JSON.stringify({
          event: "creation_complete",
          files: Object.keys(files),
          validation: validation.passed,
        }));
      },
    }).run(run, controller.signal);

    logResult({
      phase: "creation",
      success: true,
      model: model.id,
      requests: quota.requests,
      totalTokens: quota.accountedTokens,
      outputTokens: totalOutputTokens,
      duration: Date.now() - startTime,
      filesCreated: filesCreated ? Object.keys(filesCreated).length : 0,
    });

    // FASE 2: Edição Simples (testar economia)
    console.log(JSON.stringify({ event: "phase_2_simple_edit" }));
    const editStart = Date.now();
    let editQuota = createFreeTestQuota(Date.now(), 60_000);
    let editOutputTokens = 0;

    const editRun = {
      ...run,
      id: "00000000-0000-4000-8000-000000000005",
      prompt: 'Altere apenas o título principal do hero para "Landing Page Validada". Preserve todo o resto.',
      base_revision_id: "00000000-0000-4000-8000-000000000003",
    };

    const editProject = { ...project, current_revision_id: "00000000-0000-4000-8000-000000000003" };

    let editedFiles: any = null;

    await new WebsiteAgentRuntime({
      load: async () => ({
        project: editProject,
        files: filesCreated,
        assets: [],
        models: [model],
        settings,
        systemPrompt: composeWebsitePrompt(editProject, [], settings.creative_prompt, editRun.prompt, filesCreated),
        history: [],
      }),
      check: async () => assertFreeTestQuota(editQuota),
      event: async () => {},
      status: async () => {},
      checkpoint: async () => {},
      reserveTokens: async (_run, amount) => {
        editQuota = reserveFreeTestTokens(editQuota, amount);
        return `edit-${editQuota.requests}`;
      },
      usage: async (_run, usage) => {
        editQuota = settleFreeTestUsage(editQuota, usage);
        if (usage?.completionTokens) editOutputTokens += usage.completionTokens;
      },
      chat: async (models, body, signal) => {
        editQuota = startFreeTestRequest(editQuota);
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
        editedFiles = files;
      },
    }).run(editRun, controller.signal);

    const economyAchieved = editQuota.accountedTokens < 15_000; // Meta: <15k tokens para edição simples

    logResult({
      phase: "simple_edit",
      success: !!editedFiles,
      model: model.id,
      requests: editQuota.requests,
      totalTokens: editQuota.accountedTokens,
      outputTokens: editOutputTokens,
      duration: Date.now() - editStart,
      economyAchieved,
    });

    // Relatório final
    const report = {
      timestamp: new Date().toISOString(),
      model: model.id,
      modelContext: model.contextLength,
      totalDuration: Date.now() - startTime,
      phases: results,
      summary: {
        creationSuccess: results[0]?.success || false,
        editSuccess: results[1]?.success || false,
        checkpointSaved,
        totalRequests: results.reduce((sum, r) => sum + r.requests, 0),
        totalTokens: results.reduce((sum, r) => sum + r.totalTokens, 0),
        economyAchieved: results.find(r => r.phase === "simple_edit")?.economyAchieved || false,
        economyPercentage: results[1] ? Math.round((1 - results[1].totalTokens / results[0].totalTokens) * 100) : 0,
      },
    };

    await writeFile("test-results/studio-end-to-end-report.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ event: "test_complete", success: true, report: report.summary }));

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "test_failed", error: errorMsg }));

    logResult({
      phase: "failed",
      success: false,
      model: model.id,
      requests: quota.requests,
      totalTokens: quota.accountedTokens,
      outputTokens: totalOutputTokens,
      duration: Date.now() - startTime,
      error: errorMsg,
    });

    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  testCreationWithNemotron();
}
