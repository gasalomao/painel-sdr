import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { AiUsage } from "../src/lib/ai-provider";
import type { WebsiteFiles, WebsiteModel, WebsiteProject, WebsiteRun } from "../src/lib/sites/types";

export const FREE_TEST_LIMITS = Object.freeze({ requests: 10, tokens: 60_000, durationMs: 600_000, outputTokens: 1200 });
export interface FreeTestQuota {
  readonly deadline: number;
  readonly tokenLimit: number;
  readonly requests: number;
  readonly predictedTokens: number;
  readonly accountedTokens: number;
  readonly pending: { readonly prediction: number; readonly started: boolean } | null;
}

function validClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid deadline clock.");
}

export function createFreeTestQuota(now: number = Date.now(), tokenLimit: number = FREE_TEST_LIMITS.tokens): FreeTestQuota {
  validClock(now);
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0 || tokenLimit > 160_000) throw new Error("Invalid free test token ceiling.");
  return { deadline: now + FREE_TEST_LIMITS.durationMs, tokenLimit, requests: 0, predictedTokens: 0, accountedTokens: 0, pending: null };
}

export function assertFreeTestQuota(state: FreeTestQuota, now: number = Date.now()): void {
  validClock(now);
  if (now >= state.deadline) throw new Error("Free test deadline reached.");
  if (Math.max(state.predictedTokens, state.accountedTokens) > state.tokenLimit) throw new Error("Free test tokens exceeded.");
}

export function reserveFreeTestTokens(state: FreeTestQuota, amount: number, now: number = Date.now()): FreeTestQuota {
  assertFreeTestQuota(state, now);
  if (state.pending) throw new Error("Overlapping token reservation.");
  if (!Number.isSafeInteger(amount) || amount <= 0 || Math.max(state.predictedTokens, state.accountedTokens) + amount > state.tokenLimit) throw new Error("Free test tokens admission denied.");
  return { ...state, predictedTokens: state.predictedTokens + amount, pending: { prediction: amount, started: false } };
}

export function startFreeTestRequest(state: FreeTestQuota, now: number = Date.now()): FreeTestQuota {
  assertFreeTestQuota(state, now);
  if (state.requests >= FREE_TEST_LIMITS.requests) throw new Error("Free test requests exhausted.");
  if (!state.pending || state.pending.started) throw new Error("Request requires a fresh reservation.");
  return { ...state, requests: state.requests + 1, pending: { ...state.pending, started: true } };
}

export function settleFreeTestUsage(state: FreeTestQuota, usage: AiUsage | null): FreeTestQuota {
  if (!state.pending) throw new Error("Usage requires a reservation.");
  const counts = usage ? [usage.promptTokens, usage.completionTokens, usage.totalTokens] : [];
  const complete = usage && !usage.estimated && !usage.attempts?.some(attempt => attempt.estimated)
    && counts.every(count => Number.isSafeInteger(count) && count >= 0)
    && usage.totalTokens > 0 && usage.totalTokens >= usage.promptTokens + usage.completionTokens;
  const observed = complete ? usage.totalTokens : 0;
  return { ...state, accountedTokens: state.accountedTokens + Math.max(state.pending.prediction, observed), pending: null };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid public catalog entry.");
  return value as Record<string, unknown>;
}

/** Catalog data, never a :free suffix or local discovery flag, authorizes this model. */
export function validateFreeTestModel(value: unknown, explicitId: string): WebsiteModel {
  const entry = record(value);
  if (typeof explicitId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:+-]{0,199}$/.test(explicitId)
    || /^(?:gateway|gemini|nvidia|openrouter):/.test(explicitId) || entry.id !== explicitId) throw new Error("Explicit raw OpenRouter model required from catalog.");
  const pricing = record(entry.pricing);
  const zero = (price: unknown): boolean => typeof price === "string" && /^0(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(price) && Number(price) === 0;
  if (!zero(pricing.prompt) || !zero(pricing.completion) || !Object.values(pricing).every(zero)) throw new Error("All catalog billable pricing must be confirmed zero.");
  const architecture = record(entry.architecture);
  const text = (modalities: unknown): boolean => Array.isArray(modalities) && modalities.includes("text") && modalities.every(item => typeof item === "string");
  if (!Array.isArray(entry.supported_parameters) || !entry.supported_parameters.includes("tools")
    || !text(architecture.input_modalities) || !text(architecture.output_modalities)
    || !Number.isSafeInteger(entry.context_length) || Number(entry.context_length) <= 0) throw new Error("Catalog must confirm tools, text input/output and context.");
  return {
    id: explicitId, name: explicitId, provider: "openrouter", isFree: true, supportsTools: true,
    contextLength: Number(entry.context_length), inputModalities: ["text"], outputModalities: ["text"],
    pricing: { prompt: pricing.prompt as string, completion: pricing.completion as string },
  };
}

// Only fixed metric fields reach stdout. Never log provider messages, source, keys or URLs.
function metric(event: string, fields: Record<string, number | boolean | string> = {}): void {
  process.stdout.write(JSON.stringify({ event, ...fields }) + "\n");
}

function syntheticProject(model: WebsiteModel): WebsiteProject {
  const stamp = new Date(0).toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000001", client_id: "00000000-0000-4000-8000-000000000002",
    name: "Casa do Agricultor", slug: "fixture-casa-do-agricultor", lead_id: null,
    client_context: { name: "Casa do Agricultor", segment: "Loja agrícola", description: "Fixture sintética para teste de edição, sem dados de clientes." },
    instructions: "Fixture sintética. Preserve tudo fora do ajuste solicitado. Não gerar imagens nem buscar recursos externos.",
    model_mode: "manual", model_id: model.id, selected_skill_ids: [], cta: { type: "form", value: "" },
    status: "draft", current_revision_id: "00000000-0000-4000-8000-000000000003",
    published_deployment_id: null, published_url: null, last_published_at: null,
    created_at: stamp, updated_at: stamp, deleted_at: null,
  };
}

function fixtureFiles(starter: WebsiteFiles): WebsiteFiles {
  const rows = Array.from({ length: 70 }, (_, index) => `      <article className="produto-${index}"><h3>Cuidados com o campo ${index + 1}</h3><p>Informações de cultivo, solo e ferramentas para o agricultor.</p></article>`).join("\n");
  const rules = Array.from({ length: 70 }, (_, index) => `.produto-${index} { padding: var(--space-2); border-bottom: 1px solid var(--color-border); }`).join("\n");
  return {
    ...starter,
    "src/App.tsx": `import content from "./content.json";\nimport { ContactForm } from "./components/ContactForm";\nexport default function App() {\n  return (<>\n    <header><a href="#inicio">Casa do Agricultor</a><nav aria-label="Principal"><a href="#contato">Contato</a></nav></header>\n    <main id="inicio"><section className="hero"><h1>Tudo para o seu campo</h1><p>Fixture sintética de loja agrícola.</p><a className="button" href="#contato">Fale conosco</a></section>\n    <section aria-labelledby="cultivo"><h2 id="cultivo">Cultivo e ferramentas</h2>\n${rows}\n    </section><section id="contato"><h2>Contato</h2><ContactForm endpoint="" /></section></main>\n    <footer>{content.name}</footer>\n  </>);\n}\n`,
    "src/styles.css": `${starter["src/styles.css"]}\n${rules}\n`,
  };
}

async function main(): Promise<void> {
  assert.equal(process.argv.length, 4, "Use --model ID explícito do catálogo público.");
  assert.equal(process.argv[2], "--model", "Use --model ID explícito do catálogo público.");
  const explicitId = process.argv[3];
  assert.match(explicitId, /^[a-zA-Z0-9][a-zA-Z0-9/_.:+-]{0,199}$/);
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  config({ quiet: true });
  let quota = createFreeTestQuota();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FREE_TEST_LIMITS.durationMs);
  const check = (): void => { controller.signal.throwIfAborted(); assertFreeTestQuota(quota); };
  try {
    // Include public catalog GET in the physical OpenRouter ceiling; charge one conservative token.
    quota = reserveFreeTestTokens(quota, 1);
    quota = startFreeTestRequest(quota);
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal, redirect: "error" });
    assert.ok(response.ok, "Catálogo público indisponível.");
    const catalog = record(await response.json());
    assert.ok(Array.isArray(catalog.data), "Catálogo público inválido.");
    const entries = catalog.data.filter((entry: unknown) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === explicitId);
    assert.equal(entries.length, 1, "Modelo explícito ausente ou ambíguo no catálogo.");
    const model = validateFreeTestModel(entries[0], explicitId);
    quota = settleFreeTestUsage(quota, null);
    metric("catalog_confirmed", { model: model.id, physicalRequests: quota.requests });

    const { getAiKeys } = await import("../src/lib/ai-keys");
    const keys = await getAiKeys(); // Existing read-only credential resolution; no tenant/settings writes.
    assert.ok(keys.openrouterKeys.length > 0, "OpenRouter não configurado.");
    check();
    const { WebsiteAgentRuntime, WEBSITE_EDIT_BUDGET, websiteTokenBudget } = await import("../src/lib/sites/agent");
    const { websiteChatAttempt } = await import("../src/lib/sites/models");
    assert.equal(typeof websiteChatAttempt, "function", "Contrato websiteChatAttempt não disponível.");
    const { composeWebsitePrompt, DEFAULT_WEBSITE_SETTINGS } = await import("../src/lib/sites/prompts");
    const { getStarterFiles } = await import("../src/lib/sites/starter");
    const project = Object.freeze(syntheticProject(model));
    const starter = getStarterFiles(); // No application URL/project endpoint injected into the fixture.
    let files = Object.freeze(fixtureFiles({ ...starter, "src/content.json": JSON.stringify({ name: project.name }) }));
    const settings = { ...DEFAULT_WEBSITE_SETTINGS, model_allowlist: [model.id], quality_model: model.id, economy_model: model.id };
    const cases = [
      { name: "text", path: "src/App.tsx", old: "Tudo para o seu campo", replacement: "Soluções para o seu campo" },
      { name: "color", path: "src/tokens.css", old: "--color-brand:#3b82f6", replacement: "--color-brand:#166534" },
    ];
    for (const scenario of cases) {
      check();
      const before = Object.freeze({ ...files });
      assert.equal(before[scenario.path].split(scenario.old).length, 2, "Trecho deve ser único.");
      const prompt = `Altere ${scenario.name === "text" ? "o texto" : "a cor"} em ${scenario.path}: troque exatamente '${scenario.old}' por '${scenario.replacement}'. Preserve todos os demais bytes e arquivos. Use patch mínimo e valide fontes. Não executar build nem publicar.`;
      const run: WebsiteRun = {
        id: `fixture-${scenario.name}`, client_id: project.client_id, project_id: project.id, kind: "agent", status: "editing",
        prompt, model_id: model.id, base_revision_id: project.current_revision_id, asset_ids: [], error: null,
        cancel_requested: false, lease_expires_at: null, created_at: project.created_at, updated_at: project.updated_at,
      };
      let completedFiles: WebsiteFiles | null = null;
      let buildSkipped = false;
      let eventCount = 0;
      let toolCount = 0;
      const runtime = new WebsiteAgentRuntime({
        load: async () => ({ project, files: { ...before }, assets: [], models: [model], settings, activeSkills: [],
          systemPrompt: composeWebsitePrompt(project, [], settings.creative_prompt, prompt, before), history: [] }),
        check: async () => check(), checkpoint: async () => { check(); }, status: async () => { check(); },
        event: async (_run, event) => {
          eventCount++;
          if (event.role !== "system") return;
          let data: Record<string, unknown>;
          try { data = record(JSON.parse(event.content)); } catch { return; }
          if (typeof data.tool === "string" && data.status === "started") toolCount++;
        },
        reserveTokens: async (_run, amount) => {
          check();
          // Keep the runtime reservation conservative; transport output is capped below.
          quota = reserveFreeTestTokens(quota, amount);
          return `memory-${quota.requests + 1}`;
        },
        usage: async (_run, usage, usedModel) => {
          assert.equal(usedModel, model.id);
          quota = settleFreeTestUsage(quota, usage);
          metric("usage", { scenario: scenario.name, physicalRequests: quota.requests, predictedTokens: quota.predictedTokens, conservativeTokens: quota.accountedTokens });
        },
        chat: async (models, body, signal) => {
          try {
            check();
            assert.equal(models.length, 1);
            assert.equal(models[0].id, model.id);
            assert.equal(body.max_tokens, WEBSITE_EDIT_BUDGET.turnTokens, "Somente chamada de edição suportada.");
            const boundedBody = { ...body, max_tokens: FREE_TEST_LIMITS.outputTokens };
            assert.ok(quota.pending && websiteTokenBudget(boundedBody, model.contextLength, FREE_TEST_LIMITS.outputTokens) <= quota.pending.prediction, "Previsão insuficiente.");
            quota = startFreeTestRequest(quota); // Synchronous admission immediately before one physical transport.
            metric("transport_started", { scenario: scenario.name, physicalRequests: quota.requests });
            const result = await websiteChatAttempt(model, boundedBody, signal);
            assert.equal(result.model, model.id, "Modelo inesperado; interromper sem fallback.");
            metric("transport_received", { scenario: scenario.name, physicalRequests: quota.requests, toolCalls: result.response.choices?.[0]?.message?.tool_calls?.length ?? 0 });
            return result;
          } catch (error) {
            const status = error && typeof error === "object" && "status" in error && Number.isSafeInteger(error.status) ? Number(error.status) : 0;
            metric("transport_stopped", { scenario: scenario.name, status, aborted: signal.aborted });
            controller.abort(); // Prevent runtime retry/fallback even for transient transport errors.
            throw new Error("Free test transport stopped.");
          }
        },
        build: async () => {
          check();
          buildSkipped = true;
          return { success: false, status: "unconfigured", logs: "", duration_ms: 0, artifact: {}, screenshots: {},
            errors: [], warnings: ["Build não executado."], qa: { passed: false, errors: [], warnings: ["Renderização não executada."] } };
        },
        complete: async (_run, output, build) => {
          check();
          assert.equal(build.status, "unconfigured", "Somente fontes; build não executado.");
          assert.ok(output);
          completedFiles = { ...output };
        },
      });
      await runtime.run(run, controller.signal);
      assert.ok(completedFiles, "Execução não concluiu edição.");
      const expected = { ...before, [scenario.path]: before[scenario.path].replace(scenario.old, scenario.replacement) };
      assert.deepEqual(completedFiles, expected, "Alteração fora do escopo ou edição solicitada ausente.");
      files = Object.freeze(expected);
      metric("edit_evidence", { scenario: scenario.name, exactRequestedChange: true, outsideChangesPreserved: true, eventCount, toolCount, buildExecuted: false, rendered: false, published: false, buildSkipped });
    }
    metric("finished_source_only", { physicalRequests: quota.requests, predictedTokens: quota.predictedTokens, conservativeTokens: quota.accountedTokens, buildExecuted: false, visualQualityVerified: false });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Importing policy helpers in Vitest never reads dotenv/DB or starts a live transport.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    metric("stopped", { buildExecuted: false, visualQualityVerified: false, published: false });
    process.exitCode = 1;
  });
}
