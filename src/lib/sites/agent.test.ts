import { describe, expect, it, vi } from "vitest";
import { AiEmptyResponseError } from "@/lib/ai-provider";
import { extractCodeBlockEdits, WebsiteAgentRuntime, type WebsiteAgentDependencies } from "./agent";
import { getStarterFiles } from "./starter";
import { WebsiteTools, WEBSITE_TOOLS } from "./tools";
import { normalizeWebsitePath, validateFiles, validateWebsiteContent } from "./validation";import type { WebsiteBuildResult, WebsiteModel, WebsiteProject, WebsiteRun, WebsiteSettings } from "./types";

vi.mock("@/lib/supabase", () => ({ supabase: null, supabaseAdmin: null }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: null }));

const project: WebsiteProject = {
  id: "11111111-1111-4111-8111-111111111111", client_id: "22222222-2222-4222-8222-222222222222",
  name: "Padaria Modelo", slug: "padaria-modelo", lead_id: null,
  client_context: { name: "Padaria Modelo", phone: "11999999999", whatsapp: "11999999999" },
  instructions: "Site direto e rápido.", model_mode: "auto", model_id: null, selected_skill_ids: [],
  cta: { type: "whatsapp", value: "11999999999" }, status: "draft",
  current_revision_id: "33333333-3333-4333-8333-333333333333", published_deployment_id: null,
  published_url: null, last_published_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
};

const run: WebsiteRun = {
  id: "44444444-4444-4444-8444-444444444444", client_id: project.client_id, project_id: project.id,
  status: "planning", prompt: "Ajuste o título para Pães Artesanais.", model_id: null,
  base_revision_id: project.current_revision_id, asset_ids: [], error: null, cancel_requested: false,
  lease_expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

const settings: WebsiteSettings = {
  creative_prompt: "Evite clichês.", max_sites: 5, max_runs_per_day: 10, max_builds_per_day: 10,
  max_deploys_per_day: 5, max_storage_mb: 50, max_images_per_day: 0, max_tokens_per_month: 100_000,
  model_allowlist: [], quality_model: "anthropic/claude-3.5-sonnet", economy_model: "openai/gpt-4o-mini",
  image_model: "", image_generation_enabled: false, base_domain: "",
};

const models: WebsiteModel[] = [
  { id: "anthropic/claude-3.5-sonnet", name: "Claude Sonnet", supportsTools: true, contextLength: 200_000, pricing: { prompt: "0.000003", completion: "0.000015" } },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", supportsTools: true, inputModalities: ["text", "image"], contextLength: 128_000, pricing: { prompt: "0.00000015", completion: "0.0000006" } },
];

const buildSuccess: WebsiteBuildResult = {
  success: true, status: "ready", logs: "OK", duration_ms: 1200,
  artifact: { "/index.html": { content: "PGh0bWw+", mime: "text/html" } }, errors: [], warnings: [],
  screenshots: { desktop: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mobile: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
  qa: { passed: true, errors: [], warnings: [] },
};

describe("virtual website workspace", () => {
  it.each(["../secret", "/src/a.ts", "src/../a.ts", "src\\a.ts", "src/%2e%2e/a.ts", "src/.env", "public/x.html", "src//a.ts", "src/CON.ts", "package.json"])("rejects unsafe editable path %s", (path) => {
    expect(() => normalizeWebsitePath(path)).toThrow();
  });

  it("accepts starter but rejects changed or missing infrastructure", () => {
    const files = getStarterFiles();
    expect(() => validateFiles(files)).not.toThrow();
    expect(validateWebsiteContent(files).passed).toBe(true);
    expect(() => validateFiles({ ...files, "package.json": "{}" })).toThrow();
    delete files["tsconfig.json"];
    expect(() => validateFiles(files)).toThrow();
  });

  it("patches only exact unique text, restores a checkpoint and never mutates the original", async () => {
    const files = getStarterFiles();
    const tools = new WebsiteTools(files, { context: {}, assets: [] });
    await tools.execute("create", { path: "src/example.ts", content: "export const value = 1;" });
    await tools.execute("checkpoint", { name: "before" });
    await tools.execute("patch", { path: "src/example.ts", old: "1", new: "2" });
    expect(tools.files["src/example.ts"]).toContain("2");
    await expect(tools.execute("patch", { path: "src/example.ts", old: "absent", new: "x" })).rejects.toThrow();
    await tools.execute("restore", { name: "before" });
    expect(tools.files["src/example.ts"]).toContain("1");
    expect(files["src/example.ts"]).toBeUndefined();
    await expect(tools.execute("shell", { command: "whoami" })).rejects.toThrow();
    await expect(tools.execute("write", { path: "package.json", content: "{}" })).rejects.toThrow();
  });

  it("rejects output overflow atomically and preserves rename targets", async () => {
    const tools = new WebsiteTools(getStarterFiles(), { context: {}, assets: [] });
    await tools.execute("create", { path: "src/a.ts", content: "a" });
    await tools.execute("create", { path: "src/b.ts", content: "b" });
    await expect(tools.execute("rename", { path: "src/a.ts", to: "src/b.ts" })).rejects.toThrow();
    await expect(tools.execute("write", { path: "src/a.ts", content: "x".repeat(300_000) })).rejects.toThrow();
    expect(tools.files["src/a.ts"]).toBe("a");
  });
});

function dependencies(): WebsiteAgentDependencies {
  return {
    load: async () => ({ project, files: getStarterFiles(project), assets: [], models, settings, systemPrompt: "Prompt", history: [] }),
    check: vi.fn(async () => undefined), event: vi.fn(async () => undefined), status: vi.fn(async () => undefined),
    reserveTokens: vi.fn(async () => "reservation"),
    usage: vi.fn(async () => undefined), build: vi.fn(async () => structuredClone(buildSuccess)), complete: vi.fn(async () => undefined),
    chat: vi.fn(async () => ({ model: models[1].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { content: JSON.stringify({ passed: true, issues: [], summary: "Visual aprovado." }) } }] } })),
  };
}

describe("integration regressions", () => {
  it("accepts HTTPS signed assets and screenshots without fetching them locally", async () => {
    const deps = dependencies();
    const input = await deps.load(run);
    const url = "https://storage.example.test/signed/logo.png?token=fixture";
    deps.load = async () => ({ ...input, assets: [{ id: "asset", client_id: project.client_id, project_id: project.id, name: "Logo", path: "logo.png", mime: "image/png", size: 100, width: 1, height: 1, purpose: "logo", url, created_at: project.created_at }] });
    vi.mocked(deps.build).mockResolvedValue({ ...structuredClone(buildSuccess), screenshots: { desktop: url, mobile: url } });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(JSON.stringify(vi.mocked(deps.chat).mock.calls[0][1])).toContain(url);
    expect(deps.complete).toHaveBeenCalledOnce();
    const reserved = vi.mocked(deps.reserveTokens).mock.calls[0][1];
    expect(reserved).toBeGreaterThan(4096);
    expect(reserved).toBeLessThan(models[1].contextLength!);
  });

  it.each(["http://storage.example.test/image.png", "https://user:pass@storage.example.test/image.png", "file:///image.png", "javascript:alert(1)"])("rejects unsafe vision URL %s before a paid call", async (url) => {
    const deps = dependencies();
    vi.mocked(deps.build).mockResolvedValue({ ...structuredClone(buildSuccess), screenshots: { desktop: url, mobile: url } });
    await expect(new WebsiteAgentRuntime(deps).run({ ...run, kind: "build" }, new AbortController().signal)).rejects.toThrow();
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.reserveTokens).not.toHaveBeenCalled();
  });

  it("build-only skips editing but runs the visual critic", async () => {
    const deps = dependencies();
    await new WebsiteAgentRuntime(deps).run({ ...run, kind: "build" }, new AbortController().signal);
    expect(deps.chat).toHaveBeenCalledTimes(1);
    expect(deps.status).not.toHaveBeenCalledWith(expect.anything(), "editing");
    expect(deps.complete).toHaveBeenCalledWith(expect.anything(), null, expect.objectContaining({ qa: expect.objectContaining({ visual_review: "Visual aprovado." }) }), expect.any(String), expect.any(String));
  });

  it("keeps the build-only economy critic on free vision instead of paid quality", async () => {
    const deps = dependencies();
    const input = await deps.load(run);
    const free: WebsiteModel = { id: "stealth/space-bunny-alpha", name: "Free code", supportsTools: true, inputModalities: ["text"], contextLength: 128_000, pricing: { prompt: "0", completion: "0" }, provider: "openrouter", isFree: true };
    const freeVision: WebsiteModel = { ...free, id: "vendor/vision:free", inputModalities: ["text", "image"] };
    deps.load = async () => ({ ...input, project: { ...project, model_mode: "economy" }, models: [free, freeVision, models[1]], settings: { ...settings, economy_model: free.id, quality_model: models[1].id } });
    vi.mocked(deps.chat).mockImplementation(async ([model]) => ({ model: model.id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { content: JSON.stringify({ passed: true, issues: [], summary: "Visual aprovado." }) } }] } }));
    const buildRun = { ...run, kind: "build" as const };
    await new WebsiteAgentRuntime(deps).run(buildRun, new AbortController().signal);
    expect(deps.chat).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.chat).mock.calls[0][0].map((model) => model.id)).toEqual([freeVision.id]);
    expect(deps.status).not.toHaveBeenCalledWith(buildRun, "editing");
    expect(deps.complete).toHaveBeenCalledWith(buildRun, null, expect.objectContaining({ success: true }), expect.any(String), freeVision.id);
  });

  it.each(["auto", "quality", "economy", "manual"] as const)("never dispatches a vanished suffixless free target in %s mode", async (mode) => {
    for (const selected of [false, true]) {
      const deps = dependencies();
      const input = await deps.load(run);
      const lost = "stealth/space-bunny-alpha";
      deps.load = async () => ({ ...input, project: { ...project, model_mode: mode }, settings: selected ? settings : { ...settings, quality_model: lost, economy_model: lost } });
      await expect(new WebsiteAgentRuntime(deps).run({ ...run, model_id: selected ? lost : null }, new AbortController().signal)).rejects.toThrow("indisponível");
      expect(deps.chat).not.toHaveBeenCalled();
      expect(deps.reserveTokens).not.toHaveBeenCalled();
      expect(deps.build).not.toHaveBeenCalled();
      expect(deps.complete).not.toHaveBeenCalled();
    }
  });

  it.each(["started", "result"])("stops on a tool %s event failure without executing subsequent tools or calls", async (phase) => {
    const deps = dependencies();
    const failure = new SyntaxError("event persistence");
    const execute = vi.spyOn(WebsiteTools.prototype, "execute");
    vi.mocked(deps.chat).mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { tool_calls: [
      { id: "list-1", type: "function", function: { name: "list", arguments: "{}" } },
      { id: "list-2", type: "function", function: { name: "list", arguments: "{}" } },
    ] } }] } });
    vi.mocked(deps.event).mockImplementation(async (_run, event) => {
      const value = JSON.parse(event.content);
      if (value.tool === "list" && (phase === "started" ? value.status === "started" : "result" in value)) throw failure;
    });
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(phase === "started" ? 0 : 1);
    expect(deps.chat).toHaveBeenCalledOnce();
    expect(deps.reserveTokens).toHaveBeenCalledOnce();
    expect(deps.usage).toHaveBeenCalledOnce();
    expect(deps.usage).toHaveBeenCalledWith(run, { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, models[0].id, "reservation", true);
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["{", "JSON de ferramenta inválido."],
    ["{}", "Argumento inválido: path"],
  ])("keeps tool parse or execution errors recoverable for arguments %s", async (args, error) => {
    const deps = dependencies();
    vi.mocked(deps.chat)
      .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: args } }] } }] } })
      .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { content: "Finalizei." } }] } });
    vi.mocked(deps.build).mockResolvedValue({ ...structuredClone(buildSuccess), status: "unconfigured" });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(deps.chat).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.chat).mock.calls[1][1].messages).toContainEqual({ role: "tool", tool_call_id: "read-1", content: JSON.stringify({ error }) });
    expect(deps.complete).toHaveBeenCalledOnce();
  });

  it("continues a token-truncated response instead of completing partially edited sources", async () => {
    const deps = dependencies();
    const input = await deps.load(run);
    deps.load = async () => ({ ...input, project: { ...project, model_mode: "manual", model_id: models[1].id } });
    vi.mocked(deps.build).mockResolvedValue({ ...structuredClone(buildSuccess), success: false, status: "unconfigured", artifact: {}, screenshots: {} });
    vi.mocked(deps.chat)
      .mockResolvedValueOnce({ model: models[1].id, usage: { promptTokens: 10, completionTokens: 6000, totalTokens: 6010 }, response: { choices: [{ finish_reason: "length", message: { content: null } }] } })
      .mockResolvedValueOnce({ model: models[1].id, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, response: { choices: [{ message: { tool_calls: [{ id: "patch-1", type: "function", function: { name: "patch", arguments: JSON.stringify({ path: "src/content.json", old: '"name": "Padaria Modelo"', new: '"name": "Pães Artesanais"' }) } }] } }] } })
      .mockResolvedValueOnce({ model: models[1].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ finish_reason: "stop", message: { content: "Site criado." } }] } });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(deps.chat).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(vi.mocked(deps.chat).mock.calls[1][1])).toContain("resposta anterior atingiu o limite");
    expect(deps.complete).toHaveBeenCalledWith(run, expect.objectContaining({ "src/content.json": expect.stringContaining("Pães Artesanais") }), expect.objectContaining({ status: "unconfigured" }), expect.any(String), models[1].id);
  });

  it("rejects an empty response after tools instead of declaring a partial site completed", async () => {
    const deps = dependencies();
    vi.mocked(deps.chat)
      .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { tool_calls: [{ id: "list-1", type: "function", function: { name: "list", arguments: "{}" } }] } }] } })
      .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ finish_reason: "stop", message: { content: null } }] } });
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toThrow("O agente retornou resposta vazia sem executar nenhuma ação.");
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.build).not.toHaveBeenCalled();
  });

  it("generates a text-only draft using a single free model without requiring vision", async () => {
    const deps = dependencies();
    const input = await deps.load(run);
    const free: WebsiteModel = { id: "vendor/code:free", name: "Free code", supportsTools: true, inputModalities: ["text"], contextLength: 128_000, pricing: { prompt: "0", completion: "0" }, isFree: true, provider: "openrouter" };
    deps.load = async () => ({ ...input, models: [free], settings: { ...settings, quality_model: free.id } });
    vi.mocked(deps.chat)
      .mockResolvedValueOnce({ model: free.id, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, response: { choices: [{ message: { tool_calls: [{ id: "write-1", type: "function", function: { name: "patch", arguments: JSON.stringify({ path: "src/content.json", old: '"name": "Padaria Modelo"', new: '"name": "Pães Artesanais"' }) } }] } }] } })
      .mockResolvedValueOnce({ model: free.id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { content: "Site criado." } }] } });
    vi.mocked(deps.build).mockResolvedValue({ ...structuredClone(buildSuccess), success: false, status: "unconfigured", artifact: {}, screenshots: {}, qa: { passed: false, errors: ["READY — AWAITING CREDENTIALS"], warnings: [] } });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(deps.complete).toHaveBeenCalledWith(run, expect.objectContaining({ "src/content.json": expect.stringContaining("Pães Artesanais") }), expect.objectContaining({ status: "unconfigured" }), expect.any(String), free.id);
    expect(deps.event).toHaveBeenCalledWith(run, { role: "system", content: JSON.stringify({ model_call: { model: free.id, status: "started" } }) });
    expect(deps.event).toHaveBeenCalledWith(run, { role: "system", content: JSON.stringify({ tool: "patch", status: "started", path: "src/content.json" }) });
  });

  it("preserves safe edited sources as a nonpublishable draft without E2B", async () => {
    const deps = dependencies();
    deps.build = vi.fn(async () => ({ ...structuredClone(buildSuccess), success: false, status: "unconfigured" as const, artifact: {}, screenshots: {}, qa: { passed: false, errors: ["READY — AWAITING CREDENTIALS"], warnings: [] } }));
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(deps.complete).toHaveBeenCalledWith(run, expect.objectContaining({ "src/App.tsx": expect.any(String) }), expect.objectContaining({ success: false, status: "unconfigured", qa: expect.objectContaining({ passed: false }) }), expect.any(String), expect.any(String));
  });

  it("does not persist tool file contents, tool arguments or system prompts in chat", async () => {
    const deps = dependencies();
    deps.build = vi.fn(async () => ({ ...structuredClone(buildSuccess), success: false, status: "failed" as const, artifact: {}, screenshots: {}, errors: ["Render failed: SECRET_INTERNAL_TECHNICAL_PAYLOAD at node_modules/vite/dist/node:1"], warnings: [], qa: { passed: false, errors: ["Render failed: SECRET_INTERNAL_TECHNICAL_PAYLOAD at node_modules/vite/dist/node:1"], warnings: [] } }));
    vi.mocked(deps.chat)
      .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, response: { choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_files", arguments: JSON.stringify({ paths: ["src/App.tsx"] }) } }] } }] } })
      .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, response: { choices: [{ message: { content: "Finalizei." } }] } });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    const persisted = JSON.stringify(vi.mocked(deps.event).mock.calls);
    expect(persisted).toContain("read_files");
    expect(persisted).not.toContain("SECRET_INTERNAL_TECHNICAL_PAYLOAD");
    expect(vi.mocked(deps.event).mock.calls.some((call) => JSON.stringify(call[1]).includes("systemPrompt"))).toBe(false);
    expect(vi.mocked(deps.event).mock.calls.some((call) => String(call[1].content).includes("src/App.tsx"))).toBe(true);
  });

  it("rejects relative imports that escape the source workspace", () => {
    expect(validateWebsiteContent({ ...getStarterFiles(), "src/leak.ts": 'import secret from "../../.env?raw"; export default secret;' }).passed).toBe(false);
  });

  it("reserves public asset and deployment-control paths", async () => {
    const tools = new WebsiteTools(getStarterFiles(), { context: {}, assets: [] });
    await expect(tools.execute("create", { path: "public/assets/fake.svg", content: "<svg/>" })).rejects.toThrow();
    await expect(tools.execute("create", { path: "public/functions/leak.json", content: "{}" })).rejects.toThrow();
  });
});

describe("cost admission", () => {
  it("admits a short request and its fallback with a 1M context and monthly quota", async () => {
    const deps = dependencies();
    const input = await deps.load(run);
    deps.load = async () => ({ ...input, models: [{ ...models[0], contextLength: 1_000_000 }, models[1]], settings: { ...settings, max_tokens_per_month: 1_000_000 } });
    let reserved = 0;
    vi.mocked(deps.reserveTokens).mockImplementation(async (_run, amount) => {
      reserved += amount;
      if (reserved > 1_000_000) throw new Error("quota");
      return "reservation";
    });
    vi.mocked(deps.chat).mockRejectedValueOnce(new Error("timeout"));
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(deps.chat).toHaveBeenCalledTimes(3);
    expect(deps.complete).toHaveBeenCalledOnce();
  });

  it("reserves UTF-8 input, tool schemas and output with a realistic ceiling", async () => {
    const deps = dependencies();
    const input = await deps.load(run);
    const systemPrompt = "漢字".repeat(3000);
    deps.load = async () => ({ ...input, systemPrompt });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    const bodyBytes = Buffer.byteLength(JSON.stringify({ messages: [{ role: "system", content: systemPrompt }, { role: "user", content: run.prompt }], tools: WEBSITE_TOOLS }));
    const reserved = vi.mocked(deps.reserveTokens).mock.calls[0][1];
    expect(reserved).toBeGreaterThanOrEqual(Math.ceil(bodyBytes / 3) + 6000);
    expect(reserved).toBeLessThanOrEqual(bodyBytes + 6000 + 4096);
  });

  it("uses a fitting fallback without dispatching or reserving an oversized request", async () => {
    const deps = dependencies();
    const input = await deps.load(run);
    deps.load = async () => ({ ...input, models: [{ ...models[0], contextLength: 100 }, models[1]] });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(vi.mocked(deps.chat).mock.calls.every(([candidates]) => candidates[0].id === models[1].id)).toBe(true);
    expect(deps.reserveTokens).toHaveBeenCalledTimes(2);
  });

  it("retains reservations for estimated attempts even when the aggregate is not flagged", async () => {
    const deps = dependencies();
    vi.mocked(deps.chat).mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, attempts: [{ provider: "openrouter", model: models[0].id, promptTokens: 10, completionTokens: 10, totalTokens: 20, estimated: true }] }, response: { choices: [{ message: { content: "Pronto." } }] } });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(deps.usage).toHaveBeenNthCalledWith(1, run, expect.objectContaining({ totalTokens: 20 }), models[0].id, "reservation", false);
  });

  it("does not call either provider when the token reservation is refused", async () => {
    const deps = dependencies();
    vi.mocked(deps.reserveTokens).mockRejectedValue(new Error("quota"));
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toThrow("quota");
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.usage).not.toHaveBeenCalled();
  });

  it("reserves each fallback separately and stops when its reservation fails", async () => {
    const deps = dependencies();
    vi.mocked(deps.chat).mockRejectedValueOnce(Object.assign(new Error("provider"), { usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }));
    vi.mocked(deps.reserveTokens).mockResolvedValueOnce("first").mockRejectedValueOnce(new Error("quota"));
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toThrow("quota");
    const reserved = vi.mocked(deps.reserveTokens).mock.calls[0][1];
    expect(reserved).toBeGreaterThan(6000 + Math.ceil(Buffer.byteLength(JSON.stringify(WEBSITE_TOOLS)) / 3));
    expect(reserved).toBeLessThan(models[0].contextLength!);
    expect(deps.chat).toHaveBeenCalledTimes(1);
    expect(deps.usage).toHaveBeenCalledWith(run, expect.objectContaining({ totalTokens: 6 }), models[0].id, "first", true);
    expect(deps.build).not.toHaveBeenCalled();
  });

  it("settles a billed empty response before reserving its fallback", async () => {
    const deps = dependencies();
    const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };
    vi.mocked(deps.chat).mockRejectedValueOnce(new AiEmptyResponseError("openrouter", models[0].id, usage));
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(deps.usage).toHaveBeenNthCalledWith(1, run, usage, models[0].id, "reservation", true);
    expect(vi.mocked(deps.usage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.reserveTokens).mock.invocationCallOrder[1]);
  });

  it.each(["started event", "pre-dispatch guard"])("releases zero usage and never falls back when the model %s fails", async (phase) => {
    const deps = dependencies();
    const failure = new Error("persistence or lease");
    if (phase === "started event") {
      vi.mocked(deps.event).mockImplementation(async (_run, event) => {
        if (JSON.parse(event.content).model_call?.status === "started") throw failure;
      });
    } else {
      vi.mocked(deps.reserveTokens).mockImplementationOnce(async () => {
        vi.mocked(deps.check).mockRejectedValueOnce(failure);
        return "reservation";
      });
    }
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toBe(failure);
    expect(deps.reserveTokens).toHaveBeenCalledOnce();
    expect(deps.usage).toHaveBeenCalledOnce();
    expect(deps.usage).toHaveBeenCalledWith(run, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, models[0].id, "reservation", true);
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(vi.mocked(deps.event).mock.calls.some(([, event]) => JSON.parse(event.content).model_call?.status === "failed")).toBe(false);
  });

  it.each(["abort signal", "lease loss"])("releases zero usage without dispatch on %s during started event persistence", async (phase) => {
    const deps = dependencies();
    const controller = new AbortController();
    const failure = new Error(phase);
    vi.mocked(deps.event).mockImplementation(async (_run, event) => {
      if (JSON.parse(event.content).model_call?.status !== "started") return;
      await Promise.resolve();
      if (phase === "abort signal") controller.abort(failure);
      else vi.mocked(deps.check).mockRejectedValue(failure);
    });
    await expect(new WebsiteAgentRuntime(deps).run(run, controller.signal)).rejects.toBe(failure);
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.reserveTokens).toHaveBeenCalledOnce();
    expect(deps.usage).toHaveBeenCalledOnce();
    expect(deps.usage).toHaveBeenCalledWith(run, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, models[0].id, "reservation", true);
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("settles a known response before any further work and stops on bookkeeping failure", async () => {
    const deps = dependencies();
    vi.mocked(deps.usage).mockRejectedValueOnce(new Error("ledger"));
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toThrow("ledger");
    expect(deps.chat).toHaveBeenCalledTimes(1);
    expect(deps.usage).toHaveBeenCalledTimes(1);
    expect(deps.usage).toHaveBeenCalledWith(run, expect.objectContaining({ totalTokens: 20 }), models[1].id, "reservation", true);
    expect(deps.build).not.toHaveBeenCalled();
  });

  it("settles uncertain usage as complete and does not fallback after bookkeeping fails", async () => {
    const deps = dependencies();
    vi.mocked(deps.chat).mockRejectedValueOnce(new Error("network"));
    vi.mocked(deps.usage).mockRejectedValueOnce(new Error("ledger"));
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toThrow("ledger");
    expect(deps.usage).toHaveBeenCalledWith(run, null, models[0].id, "reservation", true);
    expect(deps.chat).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the model context budget is unknown", async () => {
    const deps = dependencies();
    const input = await deps.load(run);
    deps.load = async () => ({ ...input, models: input.models.map((model) => ({ ...model, contextLength: undefined })) });
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toThrow("orçamento");
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it("releases a confirmed reservation only when cancelled before dispatch", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    vi.mocked(deps.reserveTokens).mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      return "not-dispatched";
    });
    await expect(new WebsiteAgentRuntime(deps).run(run, controller.signal)).rejects.toThrow("cancelled");
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.usage).toHaveBeenCalledWith(run, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, models[0].id, "not-dispatched", true);
  });

  it("keeps the reservation when a successful response omits usage", async () => {
    const deps = dependencies();
    vi.mocked(deps.chat).mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, response: { choices: [{ message: { content: "Pronto." } }] } });
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(deps.usage).toHaveBeenNthCalledWith(1, run, expect.objectContaining({ totalTokens: 0 }), models[0].id, "reservation", false);
    expect(vi.mocked(deps.reserveTokens).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.chat).mock.invocationCallOrder[0]);
  });

  it("records paid usage even when the run is cancelled during the response", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    vi.mocked(deps.chat).mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      return { model: models[0].id, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, response: {} };
    });
    await expect(new WebsiteAgentRuntime(deps).run(run, controller.signal)).rejects.toThrow("cancelled");
    expect(deps.usage).toHaveBeenCalledWith(run, expect.objectContaining({ totalTokens: 15 }), models[0].id, "reservation", true);
    expect(deps.build).not.toHaveBeenCalled();
  });
});

describe("WebsiteAgentRuntime", () => {
  it("executes the tool loop, completes build and critic, and saves atomically", async () => {
    const complete = vi.fn(async () => undefined);
    const deps: WebsiteAgentDependencies = {
      load: async () => ({ project, files: getStarterFiles(project), assets: [], models, settings, systemPrompt: "Prompt", history: [] }),
      check: async () => undefined,
      event: async () => undefined,
      status: async () => undefined,
      reserveTokens: async () => "reservation",
      usage: async () => undefined,
      build: async () => buildSuccess,
      complete,
      chat: vi.fn()
        .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "patch", arguments: JSON.stringify({ path: "src/content.json", old: '"name": "Padaria Modelo"', new: '"name": "Pães Artesanais"' }) } }] } }] } })
        .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, response: { choices: [{ message: { content: "Título atualizado." } }] } })
        .mockResolvedValueOnce({ model: models[1].id, usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 }, response: { choices: [{ message: { content: JSON.stringify({ passed: true, issues: [], summary: "Visual aprovado." }) } }] } }),
    };
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(complete).toHaveBeenCalledOnce();
    const calls = complete.mock.calls as unknown as Array<[WebsiteRun, Record<string, string>, WebsiteBuildResult, string]>;
    const savedFiles = calls[0]?.[1];
    expect(savedFiles?.["src/content.json"]).toContain("Pães Artesanais");
  });

  it("aborts when lease check fails", async () => {
    const deps: WebsiteAgentDependencies = {
      load: async () => ({ project, files: getStarterFiles(project), assets: [], models, settings, systemPrompt: "Prompt", history: [] }),
      check: vi.fn().mockRejectedValue(new Error("Lease expirou.")),
      event: async () => undefined,
      status: async () => undefined,
      reserveTokens: async () => "reservation",
      usage: async () => undefined,
      build: async () => buildSuccess,
      complete: async () => undefined,
      chat: async () => ({ model: models[0].id, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, response: {} }),
    };
    await expect(new WebsiteAgentRuntime(deps).run(run, new AbortController().signal)).rejects.toThrow("Lease expirou.");
  });

  it("applies feedback and retries up to two times on failing critic", async () => {
    const complete = vi.fn(async () => undefined);
    const deps: WebsiteAgentDependencies = {
      load: async () => ({ project, files: getStarterFiles(project), assets: [], models, settings, systemPrompt: "Prompt", history: [] }),
      check: async () => undefined,
      event: async () => undefined,
      status: async () => undefined,
      reserveTokens: async () => "reservation",
      usage: async () => undefined,
      build: async () => structuredClone(buildSuccess),
      complete,
      chat: vi.fn()
        .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, response: { choices: [{ message: { content: "Primeira tentativa." } }] } })
        .mockResolvedValueOnce({ model: models[1].id, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, response: { choices: [{ message: { content: JSON.stringify({ passed: false, issues: ["Hero cortado em 375px."], summary: "Ajustar layout mobile." }) } }] } })
        .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, response: { choices: [{ message: { content: null, tool_calls: [{ id: "call-2", type: "function", function: { name: "patch", arguments: JSON.stringify({ path: "src/styles.css", old: "padding:clamp(2rem,7vw,6rem) 0;", new: "padding:clamp(1.5rem,5vw,4rem) 0;" }) } }] } }] } })
        .mockResolvedValueOnce({ model: models[0].id, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, response: { choices: [{ message: { content: "Ajuste responsivo aplicado." } }] } })
        .mockResolvedValueOnce({ model: models[1].id, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, response: { choices: [{ message: { content: JSON.stringify({ passed: true, issues: [], summary: "Agora aprovado." }) } }] } }),
    };
    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(complete).toHaveBeenCalledOnce();
    expect(deps.chat).toHaveBeenCalledTimes(5);
  });

  it("extracts code blocks from markdown attributes, headers, and comments", () => {
    const files = getStarterFiles();
    const markdown = `
Aqui está a alteração das cores do site:

\`\`\`css path="src/tokens.css"
:root{--color-bg:#000000;--color-brand:#ff0000}
\`\`\`

E a alteração dos textos:

### src/content.json
\`\`\`json
{"name":"Padaria Nova","description":"Melhores pães"}
\`\`\`
`;
    const edits = extractCodeBlockEdits(markdown, files);
    expect(edits).toHaveLength(2);
    expect(edits[0].path).toBe("src/tokens.css");
    expect(edits[0].content).toContain("--color-brand:#ff0000");
    expect(edits[1].path).toBe("src/content.json");
    expect(edits[1].content).toContain("Padaria Nova");
  });

  it("applies edits when reasoning/non-tool model outputs code blocks instead of tool_calls", async () => {
    let savedFiles: Record<string, string> | null = null;
    const complete = vi.fn(async (_run: unknown, files: Record<string, string> | null) => {
      savedFiles = files;
    });
    const reasoningResponse = `
Com certeza! Alterei as cores do site para o tema azul conforme solicitado:

\`\`\`css path="src/tokens.css"
:root{--color-bg:#f0f8ff;--color-surface:#ffffff;--color-text:#001122;--color-text-muted:#334455;--color-brand:#0066cc;--color-brand-contrast:#ffffff;--color-border:#ccddee;--color-focus:#004488;--font-body:system-ui,sans-serif;--font-display:var(--font-body);--size--1:.875rem;--size-0:1rem;--size-1:clamp(1.5rem,4vw,2.5rem);--size-2:clamp(2.5rem,8vw,5.5rem);--space-1:.75rem;--space-2:1.5rem;--radius:.5rem;--shadow:0 1px 2px rgb(0 17 34 / .08)}
\`\`\`

Pronto, as cores foram trocadas para azul.
`;
    const deps: WebsiteAgentDependencies = {
      load: async () => ({ project, files: getStarterFiles(project), assets: [], models, settings, systemPrompt: "Prompt", history: [] }),
      check: async () => undefined,
      event: async () => undefined,
      status: async () => undefined,
      reserveTokens: async () => "reservation",
      usage: async () => undefined,
      build: async () => structuredClone(buildSuccess),
      complete,
      chat: vi.fn()
        .mockResolvedValueOnce({ model: "gateway:deepseek-reasoner", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, response: { choices: [{ message: { content: reasoningResponse } }] } })
        .mockResolvedValueOnce({ model: models[1].id, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, response: { choices: [{ message: { content: JSON.stringify({ passed: true, issues: [], summary: "Visual aprovado." }) } }] } }),
    };

    await new WebsiteAgentRuntime(deps).run(run, new AbortController().signal);
    expect(complete).toHaveBeenCalledOnce();
    expect(savedFiles).not.toBeNull();
    expect(savedFiles!["src/tokens.css"]).toContain("--color-brand:#0066cc");
  });
});
