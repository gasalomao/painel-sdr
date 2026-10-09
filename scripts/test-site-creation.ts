import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import type { WebsiteAgentDependencies } from "../src/lib/sites/agent";
import type { WebsiteRunCheckpoint } from "../src/lib/sites/run-checkpoint";
import type { WebsiteFiles, WebsiteProject, WebsiteRun } from "../src/lib/sites/types";
import { getCleanStarterFiles } from "../src/lib/sites/starter";
import { validateWebsiteContent } from "../src/lib/sites/validation";
import { assertFreeTestQuota, createFreeTestQuota, reserveFreeTestTokens, settleFreeTestUsage, startFreeTestRequest, validateFreeTestModel } from "./test-site-free";

/** In-memory fixture only: verifies runtime recovery, not database durability or build approval. */
export async function runFreeCreationRecovery(dependencies: WebsiteAgentDependencies, run: WebsiteRun, signal: AbortSignal = new AbortController().signal): Promise<{ files: WebsiteFiles; checkpoint: WebsiteRunCheckpoint; interrupted: true }> {
  const { WebsiteAgentRuntime } = await import("../src/lib/sites/agent");
  const interruption = new Error("Synthetic checkpoint interruption");
  let checkpoint: WebsiteRunCheckpoint | undefined;
  let interrupted = false;
  const output: { files?: WebsiteFiles } = {};
  const deps: WebsiteAgentDependencies = {
    ...dependencies,
    checkpoint: async (current, value) => {
      await dependencies.checkpoint?.(current, value);
      checkpoint = structuredClone(value);
      if (!interrupted && value.progress?.changedPaths.length) { interrupted = true; throw interruption; }
    },
    complete: async (...args) => {
      assert.ok(interrupted, "Creation must recover before completion.");
      assert.ok(args[1]);
      output.files = { ...args[1] };
      await dependencies.complete(...args);
    },
  };
  try { await new WebsiteAgentRuntime(deps).run(run, signal); }
  catch (error) { if (error !== interruption) throw error; }
  assert.ok(interrupted && checkpoint, "No edited checkpoint was confirmed.");
  assert.equal(output.files, undefined, "Premature completion.");
  const saved = structuredClone(checkpoint);
  const recovered: WebsiteAgentDependencies = { ...deps, load: async current => {
    const input = await dependencies.load(current);
    return { ...input, files: { ...saved.files }, pendingRequest: saved.request, pendingNotes: saved.notes, pendingProgress: saved.progress, pendingQaReport: saved.qaReport, designDirection: saved.designDirection, budgetConsumed: saved.budgetConsumed };
  } };
  await new WebsiteAgentRuntime(recovered).run({ ...run, prompt: "Continue a criação preservando os arquivos confirmados. Conclua somente o rascunho." }, signal);
  const completed = Reflect.get(output, "files") as WebsiteFiles | undefined;
  assert.ok(completed, "Recovery did not complete.");
  assert.ok(validateWebsiteContent(completed).passed, "Created sources are invalid.");
  assert.ok(!completed["src/App.tsx"].includes("Preparando seu site"), "Creation left the placeholder.");
  return { files: completed, checkpoint: saved, interrupted: true };
}

async function main(): Promise<void> {
  assert.equal(process.argv.length, 6, "Use --model ID --output caminho-novo.json");
  assert.equal(process.argv[2], "--model");
  assert.equal(process.argv[4], "--output");
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  config({ quiet: true });
  const { composeWebsitePrompt, DEFAULT_WEBSITE_SETTINGS } = await import("../src/lib/sites/prompts");
  const { websiteChatAttempt } = await import("../src/lib/sites/models");
  const { websiteTokenBudget } = await import("../src/lib/sites/agent");
  // Creation reserves 16000 output tokens per turn even when transport output is capped.
  let quota = createFreeTestQuota(Date.now(), 160_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);
  const check = (): void => { controller.signal.throwIfAborted(); assertFreeTestQuota(quota); };
  const metric = (event: string): void => { process.stdout.write(JSON.stringify({ event, requests: quota.requests, conservativeTokens: quota.accountedTokens }) + "\n"); };
  let lastCheckpoint: WebsiteRunCheckpoint | undefined;
  try {
    quota = startFreeTestRequest(reserveFreeTestTokens(quota, 1));
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal, redirect: "error" });
    assert.ok(response.ok, "Catalog unavailable.");
    const catalog: unknown = await response.json();
    assert.ok(catalog && typeof catalog === "object" && "data" in catalog && Array.isArray(catalog.data));
    const candidates = catalog.data.filter((entry: unknown) => entry && typeof entry === "object" && "id" in entry && entry.id === process.argv[3]);
    assert.equal(candidates.length, 1);
    const model = validateFreeTestModel(candidates[0], process.argv[3]);
    quota = settleFreeTestUsage(quota, null);
    metric("catalog_confirmed");
    const stamp = new Date(0).toISOString();
    const project: WebsiteProject = { id: "00000000-0000-4000-8000-000000000001", client_id: "00000000-0000-4000-8000-000000000002", name: "Casa do Agricultor", slug: "fixture-casa-do-agricultor", lead_id: null, client_context: { name: "Casa do Agricultor", segment: "Loja agrícola", description: "Fixture sintética, sem dados reais." }, instructions: "Sem imagens externas, formulários enviados ou recursos remotos. Não publicar.", model_mode: "manual", model_id: model.id, selected_skill_ids: [], cta: { type: "form", value: "" }, status: "draft", current_revision_id: null, published_deployment_id: null, published_url: null, last_published_at: null, created_at: stamp, updated_at: stamp, deleted_at: null };
    const run: WebsiteRun = { id: "00000000-0000-4000-8000-000000000004", client_id: project.client_id, project_id: project.id, kind: "agent", status: "editing", prompt: "Crie uma pequena landing page para Casa do Agricultor: cabeçalho, hero, três serviços agrícolas e contato por âncora. Direção editorial clara com verde escuro e fundo creme, responsiva e acessível. Sem imagens/fontes externas ou formulários. Escreva src/App.tsx e src/styles.css com chamadas write pequenas, valide fontes e conclua como rascunho. Não executar build nem publicar.", model_id: model.id, base_revision_id: null, asset_ids: [], error: null, cancel_requested: false, lease_expires_at: null, created_at: stamp, updated_at: stamp };
    const files = getCleanStarterFiles();
    const settings = { ...DEFAULT_WEBSITE_SETTINGS, model_allowlist: [model.id], economy_model: model.id, quality_model: model.id };
    const result = await runFreeCreationRecovery({
      load: async () => ({ project, files, assets: [], models: [model], settings, systemPrompt: composeWebsitePrompt(project, [], settings.creative_prompt, run.prompt, files), history: [] }),
      check: async () => check(), event: async (_run, event) => {
        check();
        if (event.role !== "system") return;
        try {
          const value: unknown = JSON.parse(event.content);
          if (value && typeof value === "object" && "tool" in value && typeof value.tool === "string") {
            const known = ["read", "write", "create", "patch", "run_validation", "read_files", "search"].includes(value.tool) ? value.tool : "other";
            process.stdout.write(JSON.stringify({ event: "tool", tool: known, started: "status" in value && value.status === "started" }) + "\n");
          }
        } catch { /* Text status is not a structured diagnostic. */ }
      }, status: async () => check(), checkpoint: async (_run, value) => { check(); lastCheckpoint = structuredClone(value); },
      reserveTokens: async (_run, amount) => { check(); quota = reserveFreeTestTokens(quota, amount); return `fixture-${quota.requests}`; },
      usage: async (_run, usage) => { quota = settleFreeTestUsage(quota, usage); metric("usage"); },
      chat: async (models, body, signal) => {
        check(); assert.equal(models.length, 1); assert.equal(models[0].id, model.id);
        const bounded = { ...body, max_tokens: 8000 };
        assert.ok(quota.pending && websiteTokenBudget(bounded, model.contextLength, 8000) <= quota.pending.prediction);
        quota = startFreeTestRequest(quota);
        metric("transport_started");
        try {
          const result = await websiteChatAttempt(model, bounded, signal);
          process.stdout.write(JSON.stringify({ event: "transport_received", toolCalls: result.response.choices?.[0]?.message?.tool_calls?.length ?? 0, truncated: result.response.choices?.[0]?.finish_reason === "length" }) + "\n");
          return result;
        }
        catch { controller.abort(); throw new Error("Free creation transport stopped."); }
      },
      build: async () => ({ status: "unconfigured", success: false, logs: "", errors: [], warnings: ["Build/render not executed."], duration_ms: 0, artifact: {}, screenshots: {}, qa: { passed: false, errors: [], warnings: [] } }),
      complete: async (_run, _files, build) => { check(); assert.equal(build.status, "unconfigured"); },
    }, run, controller.signal);
    await writeFile(process.argv[5], JSON.stringify(result.files), { flag: "wx", encoding: "utf8" });
    metric("creation_recovered_source_only");
  } catch (error) {
    if (lastCheckpoint?.progress?.changedPaths.length) {
      // Sources only, never credential-bearing checkpoint metadata or a success claim.
      const recovered = { files: lastCheckpoint.files, passed: validateWebsiteContent(lastCheckpoint.files).passed };
      try {
        await writeFile(`${process.argv[5]}.partial.json`, JSON.stringify(recovered), { flag: "wx", encoding: "utf8" });
        metric("partial_sources_preserved");
      } catch { metric("partial_preservation_failed"); }
    }
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : "";
    const reason = message.includes("tokens") || message.includes("budget") ? "quota" : message.includes("transport") ? "transport" : message.includes("checkpoint") ? "checkpoint" : "validation";
    const errorClass = error instanceof Error && ["AssertionError", "AbortError", "WebsiteAgentBudgetError", "WebsiteQaFailedError", "AiEmptyResponseError", "ProviderHttpError", "Error"].includes(error.name) ? error.name : "unknown";
    process.stdout.write(JSON.stringify({ event: "creation_stopped", reason, errorClass, buildExecuted: false, published: false }) + "\n");
    process.exitCode = 1;
  });
}
