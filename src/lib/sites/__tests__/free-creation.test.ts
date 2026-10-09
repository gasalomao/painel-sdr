import { describe, expect, it, vi } from "vitest";
import { runFreeCreationRecovery } from "../../../../scripts/test-site-creation";
import { getCleanStarterFiles } from "../starter";
import { DEFAULT_WEBSITE_SETTINGS } from "../prompts";
import type { WebsiteProject, WebsiteRun } from "../types";
import type { WebsiteAgentDependencies } from "../agent";

const stamp = new Date(0).toISOString();
const project = { id: "11111111-1111-4111-8111-111111111111", client_id: "22222222-2222-4222-8222-222222222222", current_revision_id: null, name: "Casa do Agricultor", client_context: {}, cta: { type: "form", value: "" }, model_mode: "manual", model_id: "test/code:free" } as WebsiteProject;
const run: WebsiteRun = { id: "33333333-3333-4333-8333-333333333333", client_id: project.client_id, project_id: project.id, kind: "agent", status: "editing", prompt: "Crie uma landing page agrícola", model_id: project.model_id, base_revision_id: null, asset_ids: [], error: null, cancel_requested: false, lease_expires_at: null, created_at: stamp, updated_at: stamp };
const model = { id: "test/code:free", name: "Synthetic", provider: "openrouter" as const, supportsTools: true, isFree: true, contextLength: 256000, pricing: { prompt: "0", completion: "0" } };

function dependencies(): WebsiteAgentDependencies {
  let calls = 0;
  return {
    load: async () => ({ project, files: getCleanStarterFiles(), assets: [], models: [model], settings: { ...DEFAULT_WEBSITE_SETTINGS, model_allowlist: [model.id] }, systemPrompt: "Synthetic", history: [] }),
    check: async () => {}, event: async () => {}, status: async () => {}, reserveTokens: async () => "reserved", usage: async () => {},
    chat: async () => {
      calls++;
      return { model: model.id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: calls === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "write-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "src/App.tsx", content: 'export default function App(){return <main><h1>Casa do Agricultor</h1><a href="#contato">Contato</a><section id="contato">Cultivo responsável</section></main>}' }) } }] }
        : { role: "assistant", content: "Rascunho concluído." } }] } };
    },
    build: async () => ({ status: "unconfigured", success: false, logs: "", errors: [], warnings: [], duration_ms: 0, artifact: {}, screenshots: {}, qa: { passed: false, errors: [], warnings: [] } }),
    complete: async () => {},
  };
}

describe("free creation recovery fixture", () => {
  it("interrupts only after an edited checkpoint and resumes its files and consumed budget", async () => {
    const deps = dependencies();
    const complete = vi.fn(deps.complete);
    const result = await runFreeCreationRecovery({ ...deps, complete }, run);
    expect(result.files["src/App.tsx"]).toContain("Casa do Agricultor");
    expect(result.files["src/App.tsx"]).not.toContain("Preparando seu site");
    expect(result.interrupted).toBe(true);
    expect(result.checkpoint.budgetConsumed?.requests).toBeGreaterThan(0);
    expect(result.checkpoint.progress?.changedPaths).toContain("src/App.tsx");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not disguise a provider failure as the expected interruption", async () => {
    const deps = dependencies();
    await expect(runFreeCreationRecovery({ ...deps, chat: async () => { throw new Error("provider stopped"); } }, run)).rejects.toThrow("provider stopped");
  });
});
