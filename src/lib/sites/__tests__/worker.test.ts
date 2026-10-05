import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiEmptyResponseError, ProviderHttpError } from "@/lib/ai-provider";
import { SitesError } from "../server";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  rpc: vi.fn(),
  chat: vi.fn(),
  build: vi.fn(),
  buildConfigured: vi.fn(),
  resume: vi.fn(),
  configured: vi.fn(),
  sign: vi.fn(),
  insertError: null as { message: string } | null,
}));

vi.mock("@/lib/supabase", () => ({ get supabaseAdmin() { return fakeClient(); } }));
vi.mock("@/lib/supabase_admin", () => ({ get supabaseAdmin() { return fakeClient(); } }));
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/gemini-model-discovery", () => ({
  listAvailableGeminiModels: async () => [],
}));
vi.mock("@/lib/gateway-model-discovery", () => ({
  listAvailableGatewayModels: async () => [],
  resolveGatewayEndpointForModel: async () => null,
  listEndpointsForModel: async () => [],
}));
vi.mock("@/lib/openrouter-model-discovery", () => ({
  listAvailableOpenRouterModels: async () => [
    { id: "test/model", name: "Test Model", supportsTools: true, contextLength: 100_000, pricing: { prompt: "0", completion: "0" } },
    { id: "test/vision", name: "Test Vision", supportsTools: true, inputModalities: ["text", "image"], contextLength: 100_000, pricing: { prompt: "0", completion: "0" } },
  ],
}));
vi.mock("@/lib/ai-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-provider")>("@/lib/ai-provider");
  return { ...actual, openRouterChatWithFailover: (...args: unknown[]) => state.chat(...args) };
});
vi.mock("../build-provider", () => ({
  createSiteBuildProvider: () => ({ configured: () => state.buildConfigured(), build: (...args: unknown[]) => state.build(...args) }),
  SITE_PROVIDER_NOT_CONFIGURED: "READY — AWAITING CREDENTIALS",
}));
vi.mock("../deployment-provider", () => ({
  createSiteDeploymentProvider: () => ({ configured: () => state.configured() }),
  resumeSiteDeployment: (...args: unknown[]) => state.resume(...args),
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, value: unknown, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(value); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }),
}));

function fakeClient(): SupabaseClient {
  return {
    storage: { from: () => ({ createSignedUrl: state.sign }) },
    rpc: (...args: unknown[]) => {
      const result = state.rpc(...args);
      return Object.assign(result, { abortSignal: () => result });
    },
    from(table: string) {
      const filters: Array<[string, [string, unknown]]> = [];
      let single = false;
      let mode: "select" | "update" | "insert" = "select";
      const query: Record<string, unknown> = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push(["eq", [key, value]]); return query; },
        in: (key: string, value: unknown) => { filters.push(["in", [key, value]]); return query; },
        gt: (key: string, value: unknown) => { filters.push(["gt", [key, value]]); return query; },
        is: (key: string, value: unknown) => { filters.push(["is", [key, value]]); return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: () => { single = true; return query; },
        insert: (row: Record<string, unknown>) => {
          if (state.insertError) return Promise.resolve({ data: null, error: state.insertError });
          state.tables[table] ??= []; state.tables[table].push(row); return Promise.resolve({ data: null, error: null });
        },
        update: (patch: Record<string, unknown>) => {
          mode = "update";
          const rows = (state.tables[table] ?? []).filter((row) => matches(row));
          rows.forEach((row) => Object.assign(row, patch));
          (query as { rows?: unknown[] }).rows = rows;
          return query;
        },
        then(resolve: (value: unknown) => unknown) {
          if (mode === "insert") return Promise.resolve({ data: null, error: null }).then(resolve);
          let rows = (state.tables[table] ?? []).filter((row) => matches(row));
          if (mode === "update") rows = (query as { rows?: unknown[] }).rows as Record<string, unknown>[];
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
        },
      };
      return query;
      function matches(row: Record<string, unknown>): boolean {
        return filters.every(([op, [key, value]]) => {
          if (op === "eq") return row[key] === value;
          if (op === "in") return Array.isArray(value) && (value as unknown[]).includes(row[key]);
          if (op === "gt") return String(row[key]) > String(value);
          if (op === "is") return row[key] === value;
          return false;
        });
      }
    },
  } as unknown as SupabaseClient;
}

import { WebsiteLeaseLost, claimWebsiteRun, createWebsiteAgentDependencies, executeWebsiteRun, startWebsiteWorker, type ClaimedRun } from "../worker";

const CLIENT = "00000000-0000-0000-0000-000000000001";
const PROJECT = "00000000-0000-0000-0000-000000000010";
const RUN = "00000000-0000-0000-0000-000000000020";
const REVISION = "00000000-0000-0000-0000-000000000011";
const WORKER = "00000000-0000-0000-0000-000000000030";

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN, client_id: CLIENT, project_id: PROJECT, kind: "agent", status: "planning",
    prompt: "Ajuste o título.", model_id: null, base_revision_id: REVISION, asset_ids: [],
    error: null, cancel_requested: false, lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    worker_id: WORKER, actor_id: CLIENT, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function claimed(overrides: Record<string, unknown> = {}): ClaimedRun {
  return runRow(overrides) as unknown as ClaimedRun;
}

function chatResult(content: string) {
  return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
}

const unconfiguredBuild = { success: false, status: "unconfigured", logs: "", duration_ms: 0, artifact: {}, errors: ["READY — AWAITING CREDENTIALS"], warnings: [], screenshots: {}, qa: { passed: false, errors: ["READY — AWAITING CREDENTIALS"], warnings: [] } };
const shot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

beforeEach(() => {
  vi.resetAllMocks();
  state.tables = {
    clients: [{ id: CLIENT, is_active: true, is_admin: false, features: { sites: true } }],
    website_projects: [{ id: PROJECT, client_id: CLIENT, current_revision_id: REVISION, deleted_at: null, name: "Site", slug: "site", cta: { type: "form", value: "" }, client_context: {}, instructions: "", model_mode: "auto", model_id: null, selected_skill_ids: [] }],
    website_revisions: [{ id: REVISION, client_id: CLIENT, project_id: PROJECT, files: {} }],
    website_skills: [],
    website_runs: [runRow()],
    website_messages: [],
  };
  state.insertError = null;
  state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "website_complete_run") return { data: { ok: true }, error: null };
    if (fn === "website_reserve_tokens" || fn === "website_settle_tokens") return { data: args.p_reservation_id, error: null };
    if (fn === "website_consume_quota") return { data: 1, error: null };
    return { data: null, error: null };
  });
  state.chat.mockImplementation(async () => chatResult(JSON.stringify({ passed: true, issues: [], summary: "Visual aprovado." })));
  state.build.mockImplementation(async () => unconfiguredBuild);
  state.buildConfigured.mockReturnValue(true);
  state.configured.mockReturnValue(true);
  state.resume.mockResolvedValue({ status: "published" });
  state.sign.mockImplementation(async (path: string) => ({ data: { signedUrl: `https://storage.example.test/${path}?token=temporary` }, error: null }));
});

describe("deployment recovery in the website worker", () => {
  let controller: AbortController;
  let running: Promise<void> | undefined;
  const deployment = { id: REVISION, client_id: CLIENT, project_id: PROJECT };
  const other = { id: RUN, client_id: WORKER, project_id: CLIENT };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("SITES_WORKER_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    controller = new AbortController();
    running = undefined;
    state.rpc.mockImplementation(async (fn: string) => ({ data: fn === "website_list_recoverable_deployments" ? [deployment] : null, error: null }));
  });

  afterEach(async () => {
    controller.abort();
    await running;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("resumes the existing deployment with its tenant and keeps the idle heartbeat alive", async () => {
    state.resume.mockImplementation(async (_client: string, _project: string, _id: string, signal: AbortSignal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    });
    running = startWebsiteWorker(controller.signal, WORKER);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.resume).toHaveBeenCalledWith(CLIENT, PROJECT, REVISION, expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(state.rpc.mock.calls.filter(([fn]) => fn === "website_claim_next_run")).toHaveLength(4);
    expect(state.rpc.mock.calls.filter(([fn]) => fn === "website_list_recoverable_deployments")).toHaveLength(1);
    expect(state.chat).not.toHaveBeenCalled();
    expect(state.build).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalledWith("website_begin_deployment", expect.anything());
    expect(state.rpc).not.toHaveBeenCalledWith("website_consume_quota", expect.anything());
  });

  it("isolates failed claims, preserves tenant IDs and does not leak provider errors", async () => {
    state.rpc.mockImplementation(async (fn: string) => ({ data: fn === "website_list_recoverable_deployments" ? [deployment, other] : null, error: null }));
    state.resume.mockRejectedValueOnce(new Error("SENSITIVE_PROVIDER_INTERNAL_DETAIL"));
    running = startWebsiteWorker(controller.signal, WORKER);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.resume).toHaveBeenCalledTimes(2);
    expect(state.resume).toHaveBeenNthCalledWith(2, WORKER, CLIENT, RUN, expect.any(AbortSignal));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SENSITIVE_PROVIDER_INTERNAL_DETAIL");
  });

  it("paces recovery and rotates through full batches even if every deployment fails", async () => {
    const batch = Array.from({ length: 5 }, (_, index) => ({ ...deployment, id: `00000000-0000-0000-0000-00000000010${index}` }));
    state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => ({
      data: fn === "website_list_recoverable_deployments" ? (args.p_after_id ? [] : batch) : null, error: null,
    }));
    state.resume.mockRejectedValue(new Error("pending"));
    running = startWebsiteWorker(controller.signal, WORKER);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.resume).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(state.resume).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.rpc).toHaveBeenCalledWith("website_list_recoverable_deployments", { p_after_id: batch[4].id });
    expect(state.resume).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.resume).toHaveBeenCalledTimes(10);
  });

  it("does not overlap recovery batches while a deployment is still running", async () => {
    let finish!: () => void;
    state.resume.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    running = startWebsiteWorker(controller.signal, WORKER);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.resume).toHaveBeenCalledOnce();
    try {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(state.rpc.mock.calls.filter(([fn]) => fn === "website_list_recoverable_deployments")).toHaveLength(1);
    } finally { finish(); }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.resume).toHaveBeenCalledTimes(2);
  });

  it("continues recovery while the agent run is busy", async () => {
    let finish!: () => void;
    state.build.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(unconfiguredBuild); }));
    let issued = false;
    state.rpc.mockImplementation(async (fn: string) => {
      if (fn === "website_claim_next_run" && !issued) { issued = true; return { data: runRow({ kind: "build" }), error: null }; }
      return { data: fn === "website_list_recoverable_deployments" ? [deployment] : fn === "website_consume_quota" ? 1 : null, error: null };
    });
    running = startWebsiteWorker(controller.signal, WORKER);
    await vi.waitFor(() => expect(state.build).toHaveBeenCalledOnce());
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.resume).toHaveBeenCalledTimes(2);
    } finally { finish(); }
  });

  it("retries discovery errors without starving runs or exposing database details", async () => {
    let queries = 0;
    state.rpc.mockImplementation(async (fn: string) => {
      if (fn === "website_list_recoverable_deployments") {
        return ++queries === 1 ? { data: null, error: { message: "SENSITIVE_DATABASE_DETAIL" } } : { data: [deployment], error: null };
      }
      return { data: null, error: null };
    });
    running = startWebsiteWorker(controller.signal, WORKER);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.resume).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.resume).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SENSITIVE_DATABASE_DETAIL");
  });

  it("skips discovery when Cloudflare is not configured without stopping runs", async () => {
    state.configured.mockReturnValue(false);
    running = startWebsiteWorker(controller.signal, WORKER);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.rpc).not.toHaveBeenCalledWith("website_list_recoverable_deployments", expect.anything());
    expect(state.rpc).toHaveBeenCalledWith("website_claim_next_run", { p_worker_id: WORKER });
    expect(state.resume).not.toHaveBeenCalled();
  });

  it("aborts in-flight recovery on shutdown, skips later items and clears timers", async () => {
    state.rpc.mockImplementation(async (fn: string) => ({ data: fn === "website_list_recoverable_deployments" ? [deployment, other] : null, error: null }));
    let finished = false;
    state.resume.mockImplementation(async (_client: string, _project: string, _id: string, signal: AbortSignal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      finished = true;
      signal.throwIfAborted();
    });
    running = startWebsiteWorker(controller.signal, WORKER);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.resume).toHaveBeenCalledOnce();
    controller.abort();
    await running;
    expect(finished).toBe(true);
    expect(state.resume).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not discover or claim work when already stopped", async () => {
    controller.abort();
    running = startWebsiteWorker(controller.signal, WORKER);
    await running;
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.resume).not.toHaveBeenCalled();
  });
});

describe("website worker", () => {
  const priorId = "00000000-0000-0000-0000-000000000040";
  const referenceId = "00000000-0000-0000-0000-000000000041";
  const priorAsset = { id: priorId, client_id: CLIENT, project_id: PROJECT, name: "logo.png", path: `${CLIENT}/${PROJECT}/${priorId}.png`, mime: "image/png", size: 68, purpose: "logo", status: "ready" };

  it.each(["agent", "build"])("materializes prior revision assets for %s without adding them to vision", async (kind) => {
    const { getStarterFiles } = await import("../starter");
    state.tables.website_assets = [priorAsset];
    state.tables.website_revisions[0].files = { ...getStarterFiles(), "src/App.tsx": `export default function App(){return <img src="/assets/${priorId}.png" alt="Logo"/>}` };
    await executeWebsiteRun(fakeClient(), claimed({ kind }), WORKER);
    expect(state.build).toHaveBeenCalledWith(expect.objectContaining({ assets: [priorAsset] }), expect.any(AbortSignal));
    expect(state.sign).not.toHaveBeenCalled();
    expect(JSON.stringify(state.chat.mock.calls)).not.toContain('"image_url"');
  });

  it("keeps selected visual references out of materialized assets", async () => {
    state.tables.website_assets = [priorAsset, { ...priorAsset, id: referenceId, path: `${CLIENT}/${PROJECT}/${referenceId}.png`, purpose: "reference" }];
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    const run = claimed({ asset_ids: [referenceId] });
    const input = await deps.load(run);
    expect(input.assets.map((asset) => asset.id)).toEqual([referenceId]);
    expect(state.sign).toHaveBeenCalledTimes(1);
    const files = { ...input.files, "src/App.tsx": `export default function App(){return <img src="/assets/${priorId}.png"/>}` };
    await deps.build(run, { project: input.project, files, assets: input.assets }, new AbortController().signal);
    expect(state.build).toHaveBeenCalledWith({ project: input.project, files, assets: [priorAsset] }, expect.any(AbortSignal));
    expect(files["src/App.tsx"]).not.toContain("token=");
  });

  it.each([{ purpose: "reference" }, { status: "deleting" }, { client_id: WORKER }, { project_id: WORKER }])("rejects unavailable source assets before spending build quota: %j", async (patch) => {
    state.tables.website_assets = [{ ...priorAsset, ...patch }];
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    const run = claimed();
    const input = await deps.load(run);
    await expect(deps.build(run, { project: input.project, files: { ...input.files, "src/App.tsx": `"/assets/${priorId}.png"` }, assets: [] }, new AbortController().signal)).rejects.toThrow();
    expect(state.build).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalledWith("website_consume_quota", expect.anything());
  });

  it("returns null when the queue is empty", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(claimWebsiteRun(fakeClient(), WORKER)).resolves.toBeNull();
  });

  it("rejects claims issued to another worker or without a live lease", async () => {
    state.rpc.mockResolvedValueOnce({ data: runRow({ worker_id: "outro" }), error: null });
    await expect(claimWebsiteRun(fakeClient(), WORKER)).rejects.toThrow(WebsiteLeaseLost);
    state.rpc.mockResolvedValueOnce({ data: runRow({ lease_expires_at: new Date(Date.now() - 1000).toISOString() }), error: null });
    await expect(claimWebsiteRun(fakeClient(), WORKER)).rejects.toThrow(WebsiteLeaseLost);
  });

  it("accepts a valid claim", async () => {
    state.rpc.mockResolvedValueOnce({ data: runRow(), error: null });
    await expect(claimWebsiteRun(fakeClient(), WORKER)).resolves.toMatchObject({ id: RUN, worker_id: WORKER });
  });

  it("settles usage without another admission check and logs every model", async () => {
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    const run = claimed();
    const reservation = await deps.reserveTokens(run, 106000);
    const usage = { promptTokens: 5, completionTokens: 7, totalTokens: 12 };
    await deps.usage(run, usage, "test/model", reservation, true);
    expect(state.rpc).toHaveBeenCalledWith("website_reserve_tokens", { p_client_id: CLIENT, p_project_id: PROJECT, p_run_id: RUN, p_worker_id: WORKER, p_reservation_id: reservation, p_amount: 106000 });
    expect(state.rpc).toHaveBeenCalledWith("website_settle_tokens", { p_client_id: CLIENT, p_project_id: PROJECT, p_run_id: RUN, p_worker_id: WORKER, p_reservation_id: reservation, p_usage: usage, p_model: "test/model", p_complete: true });
    expect(state.rpc).not.toHaveBeenCalledWith("website_consume_quota", expect.objectContaining({ p_metric: "tokens" }));
    const { logTokenUsage } = await import("@/lib/token-usage");
    expect(logTokenUsage).toHaveBeenCalledOnce();
    expect(state.tables.website_messages.at(-1)).toMatchObject({ role: "system" });
  });

  it("retains the reservation when failed attempts report zero tokens", async () => {
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    await deps.usage(claimed(), { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, "test/model", RUN, false);
    expect(state.rpc).toHaveBeenCalledWith("website_settle_tokens", expect.objectContaining({ p_complete: false }));
    expect(state.tables.website_messages.at(-1)).toMatchObject({ role: "system" });
  });

  it("never spends when token admission fails or returns no confirmation", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "website_quota_exceeded" } });
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    expect(state.chat).not.toHaveBeenCalled();
    expect(state.build).not.toHaveBeenCalled();
    expect(state.tables.website_runs[0].status).toBe("failed");
    state.tables.website_runs = [runRow()];
    state.rpc.mockResolvedValue({ data: null, error: null });
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    expect(state.chat).not.toHaveBeenCalled();
    expect(state.build).not.toHaveBeenCalled();
  });

  it("does not lose logs or continue spending after settlement fails", async () => {
    state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => fn === "website_reserve_tokens"
      ? { data: args.p_reservation_id, error: null } : { data: null, error: { message: "ledger offline" } });
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    const { logTokenUsage } = await import("@/lib/token-usage");
    expect(logTokenUsage).toHaveBeenCalledOnce();
    expect(state.tables.website_messages.some((row) => String(row.content).includes('"totalTokens":20'))).toBe(true);
    expect(state.chat).toHaveBeenCalledTimes(1);
    expect(state.build).not.toHaveBeenCalled();
    expect(state.tables.website_runs[0].status).toBe("failed");
  });

  it("keeps settling and logging when the message insert fails", async () => {
    state.insertError = { message: "message offline" };
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    await expect(deps.usage(claimed(), { promptTokens: 5, completionTokens: 7, totalTokens: 12 }, "test/model", RUN, true)).resolves.toBeUndefined();
    expect(state.rpc).toHaveBeenCalledWith("website_settle_tokens", expect.objectContaining({ p_usage: expect.objectContaining({ totalTokens: 12 }) }));
    const { logTokenUsage } = await import("@/lib/token-usage");
    expect(logTokenUsage).toHaveBeenCalledOnce();
  });

  it("records over-reservation usage even after cancellation or lease loss", async () => {
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    state.tables.website_runs[0] = runRow({ status: "cancelled", worker_id: null, lease_expires_at: null });
    await deps.usage(claimed(), { promptTokens: 200000, completionTokens: 20000, totalTokens: 220000 }, "test/model", RUN, true);
    expect(state.rpc).toHaveBeenCalledWith("website_settle_tokens", expect.objectContaining({ p_usage: expect.objectContaining({ totalTokens: 220000 }), p_complete: true }));
  });

  it.each(["agent", "build"])("completes an unconfigured %s draft without spending exhausted build quota", async (kind) => {
    state.buildConfigured.mockReturnValue(false);
    const rpc = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => fn === "website_consume_quota"
      ? Promise.resolve({ data: null, error: { message: "website_quota_exceeded" } }) : rpc(fn, args));
    await executeWebsiteRun(fakeClient(), claimed({ kind }), WORKER);
    expect(state.rpc).toHaveBeenCalledWith("website_complete_run", expect.objectContaining({
      p_client_id: CLIENT, p_project_id: PROJECT, p_run_id: RUN, p_worker_id: WORKER,
      p_files: kind === "build" ? null : expect.any(Object),
      p_build: expect.objectContaining({ status: "unconfigured", success: false, qa: expect.objectContaining({ passed: false }) }),
    }));
    expect(state.build).toHaveBeenCalledOnce();
    expect(state.rpc).not.toHaveBeenCalledWith("website_consume_quota", expect.anything());
    expect(state.tables.website_runs[0].error).toBeNull();
  });

  it.each([false, true])("uses the existing E2B presence check when the provider has no configured method (%s)", async (configured) => {
    const providers = await import("../build-provider");
    vi.spyOn(providers, "createSiteBuildProvider").mockReturnValue({ build: state.build });
    vi.stubEnv("E2B_API_KEY", configured ? "test-only" : "");
    vi.stubEnv("E2B_SITE_TEMPLATE_ID", "test-only");
    try {
      const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
      const run = claimed();
      await deps.build(run, await deps.load(run), new AbortController().signal);
      expect(state.rpc.mock.calls.filter(([fn]) => fn === "website_consume_quota")).toHaveLength(configured ? 1 : 0);
      expect(state.build).toHaveBeenCalledOnce();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    { cancel_requested: true },
    { lease_expires_at: new Date(0).toISOString() },
    { worker_id: CLIENT },
    { client_id: WORKER },
    { project_id: WORKER },
  ])("rechecks run guards after an unconfigured provider check: %j", async (patch) => {
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    const run = claimed();
    const input = await deps.load(run);
    state.buildConfigured.mockImplementation(() => { Object.assign(state.tables.website_runs[0], patch); return false; });
    await expect(deps.build(run, input, new AbortController().signal)).rejects.toThrow();
    expect(state.build).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalledWith("website_consume_quota", expect.anything());
  });

  it("rechecks abort after the provider configuration check without spending quota", async () => {
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    const run = claimed();
    const input = await deps.load(run);
    const controller = new AbortController();
    state.buildConfigured.mockImplementation(() => { controller.abort(new Error("stopped")); return false; });
    await expect(deps.build(run, input, controller.signal)).rejects.toThrow("stopped");
    expect(state.build).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalledWith("website_consume_quota", expect.anything());
  });

  it.each(["agent", "build"])("admits each %s build before E2B and stops at the daily limit", async (kind) => {
    let builds = 0;
    state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "website_consume_quota") return ++builds <= 1 ? { data: 1, error: null } : { data: null, error: { message: "website_quota_exceeded" } };
      if (fn === "website_reserve_tokens" || fn === "website_settle_tokens") return { data: args.p_reservation_id, error: null };
      return { data: { ok: true }, error: null };
    });
    state.build.mockImplementation(async () => {
      expect(state.rpc).toHaveBeenCalledWith("website_consume_quota", { p_client_id: CLIENT, p_metric: "builds", p_amount: 1 });
      return { ...unconfiguredBuild, status: "failed" };
    });
    await executeWebsiteRun(fakeClient(), claimed({ kind }), WORKER);
    expect(state.build).toHaveBeenCalledTimes(1);
    expect(builds).toBe(kind === "agent" ? 2 : 1);
  });

  it.each([{ message: "website_quota_exceeded" }, null])("does not call E2B or the critic without build admission (%s)", async (error) => {
    state.rpc.mockResolvedValue({ data: null, error });
    await executeWebsiteRun(fakeClient(), claimed({ kind: "build" }), WORKER);
    expect(state.build).not.toHaveBeenCalled();
    expect(state.chat).not.toHaveBeenCalled();
  });

  it("charges all three agent validations and never refunds a failed provider", async () => {
    state.build.mockResolvedValue({ ...unconfiguredBuild, status: "failed" });
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    expect(state.build).toHaveBeenCalledTimes(3);
    expect(state.rpc.mock.calls.filter(([fn]) => fn === "website_consume_quota")).toHaveLength(3);
    state.rpc.mockClear();
    state.tables.website_runs = [runRow()];
    state.build.mockRejectedValueOnce(new Error("E2B failed"));
    await executeWebsiteRun(fakeClient(), claimed({ kind: "build" }), WORKER);
    expect(state.rpc.mock.calls.filter(([fn]) => fn === "website_consume_quota")).toHaveLength(1);
    expect(state.rpc).toHaveBeenCalledWith("website_consume_quota", { p_client_id: CLIENT, p_metric: "builds", p_amount: 1 });
    expect(state.tables.website_runs[0].status).toBe("failed");
  });

  it("charges failed provider attempts and bounds fallback to one request per reservation", async () => {
    state.chat.mockRejectedValueOnce(new Error("network"));
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    expect(state.rpc.mock.calls.filter(([fn]) => fn === "website_reserve_tokens")).toHaveLength(2);
    expect(state.rpc).toHaveBeenCalledWith("website_settle_tokens", expect.objectContaining({ p_complete: true }));
    expect(state.chat).toHaveBeenCalledTimes(2);
    for (const [, options] of state.chat.mock.calls) expect(options).toMatchObject({ maxAttempts: 1, attemptBudget: { remaining: 1 } });
    const reservations = state.rpc.mock.calls.filter(([fn]) => fn === "website_reserve_tokens").map(([, args]) => args.p_reservation_id);
    expect(new Set(reservations).size).toBe(2);
  });

  it("passes the model actually used to the completion RPC", async () => {
    const deps = createWebsiteAgentDependencies(fakeClient(), WORKER);
    await deps.complete(claimed(), null, { success: true, status: "ready", logs: "", duration_ms: 1, artifact: {}, errors: [], warnings: [], screenshots: {}, qa: { passed: true, errors: [], warnings: [] } }, "Resumo.", "test/vision");
    expect(state.rpc).toHaveBeenCalledWith("website_complete_run", expect.objectContaining({ p_run_id: RUN, p_model_used: "test/vision" }));
  });

  it("marks the run failed with a generic message and no lease when the model call fails", async () => {
    const boom = () => { throw new Error("SENSITIVE_PROVIDER_INTERNAL_DETAIL"); };
    state.chat.mockImplementationOnce(boom).mockImplementationOnce(boom);
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    const row = state.tables.website_runs[0];
    expect(row.status).toBe("failed");
    expect(row.lease_expires_at).toBeNull();
    expect(String(row.error)).not.toContain("SENSITIVE_PROVIDER_INTERNAL_DETAIL");
    expect(JSON.stringify(state.tables.website_messages)).not.toContain("SENSITIVE_PROVIDER_INTERNAL_DETAIL");
  });

  it.each([
    [new Error("READY — AWAITING CREDENTIALS: nenhum modelo compatível disponível."), "Nenhum modelo compatível disponível. Verifique os modelos e as credenciais."],
    [new Error("Modelo manual indisponível ou sem suporte a ferramentas."), "Modelo manual indisponível ou sem suporte a ferramentas."],
    [new Error("O agente retornou resposta vazia sem executar nenhuma ação."), "O agente retornou resposta vazia sem executar nenhuma ação."],
    [new AiEmptyResponseError("openrouter", "SENSITIVE_PROVIDER_INTERNAL_DETAIL", 0), "O agente retornou resposta vazia sem executar nenhuma ação."],
    ...[
      "Limite de turnos ou saída atingido.", "Limite de saída atingido.", "Saída do modelo excede o limite.",
      "Limite de ferramentas atingido.", "Contexto da execução excede o limite.",
      "Modelo sem orçamento de contexto confiável.", "Pedido excede o orçamento de contexto do modelo.",
      "Reserva de tokens não confirmada.", "Quota de build não confirmada.", "Contabilização de tokens não confirmada.",
    ].map((message) => [new Error(message), message]),
    [new SitesError(429, "Limite do Site Studio atingido."), "Limite do Site Studio atingido."],
    [new ProviderHttpError(401, "SENSITIVE_PROVIDER_INTERNAL_DETAIL"), "Autenticação do provedor de IA recusada. Verifique as credenciais em Configurações."],
    [new ProviderHttpError(403, "SENSITIVE_PROVIDER_INTERNAL_DETAIL"), "Autenticação do provedor de IA recusada. Verifique as credenciais em Configurações."],
    [new ProviderHttpError(429, "SENSITIVE_PROVIDER_INTERNAL_DETAIL"), "Limite de requisições do provedor de IA atingido. Tente novamente mais tarde."],
    [new ProviderHttpError(402, "SENSITIVE_PROVIDER_INTERNAL_DETAIL"), "Saldo ou quota do provedor de IA insuficiente. Verifique sua conta."],
  ])("reports only bounded run failures: %s", async (error, message) => {
    state.chat.mockRejectedValue(error);
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    expect(state.tables.website_runs[0]).toMatchObject({ status: "failed", error: message, lease_expires_at: null });
    expect(state.tables.website_messages.at(-1)).toMatchObject({ role: "system", content: message });
    expect(JSON.stringify(state.tables.website_messages)).not.toContain("SENSITIVE_PROVIDER_INTERNAL_DETAIL");
  });

  it.each([
    new SitesError(503, "SENSITIVE_PROVIDER_INTERNAL_DETAIL"),
    new ProviderHttpError(400, "SENSITIVE_PROVIDER_INTERNAL_DETAIL"),
    new Error("Limite de saída atingido. SENSITIVE_PROVIDER_INTERNAL_DETAIL"),
    new Error("HTTP 401 SENSITIVE_PROVIDER_INTERNAL_DETAIL"),
  ])("redacts unknown errors even when they resemble safe failures: %s", async (error) => {
    state.chat.mockRejectedValue(error);
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    expect(state.tables.website_runs[0].error).toBe("A execução não foi concluída. Os arquivos anteriores foram preservados.");
    expect(JSON.stringify(state.tables.website_messages)).not.toContain("SENSITIVE_PROVIDER_INTERNAL_DETAIL");
  });

  it("marks the run cancelled when cancellation is requested mid-flight", async () => {
    state.chat.mockImplementationOnce(async () => {
      state.tables.website_runs[0].cancel_requested = true;
      throw new Error("interrompido");
    });
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    expect(state.tables.website_runs[0].status).toBe("cancelled");
    expect(state.tables.website_runs[0].error).toBeNull();
  });

  it("completes an agent run without E2B by persisting a nonpublishable draft", async () => {
    state.chat.mockImplementationOnce(async () => chatResult("Editei o hero."));
    await executeWebsiteRun(fakeClient(), claimed(), WORKER);
    expect(state.rpc).toHaveBeenCalledWith("website_reserve_tokens", expect.objectContaining({ p_run_id: RUN }));
    const complete = state.rpc.mock.calls.find(([fn]) => fn === "website_complete_run");
    expect(complete).toBeDefined();
    const args = complete?.[1] as Record<string, unknown>;
    expect(args.p_build).toMatchObject({ success: false, status: "unconfigured", qa: { passed: false } });
    expect(args.p_files).not.toBeNull();
    expect(String(args.p_summary)).toContain("rascunho");
    expect(state.tables.website_runs[0].status).toBe("validating");
  });

  it("runs build-only claims through the visual critic without editing", async () => {
    state.build.mockImplementation(async () => ({ ...unconfiguredBuild, success: true, status: "ready", errors: [], screenshots: { desktop: shot, mobile: shot }, qa: { passed: true, errors: [], warnings: [] } }));
    await executeWebsiteRun(fakeClient(), claimed({ kind: "build" }), WORKER);
    const complete = state.rpc.mock.calls.find(([fn]) => fn === "website_complete_run");
    expect(complete).toBeDefined();
    const args = complete?.[1] as Record<string, unknown>;
    expect(args.p_files).toBeNull();
    expect(args.p_build).toMatchObject({ qa: { passed: true, visual_review: "Visual aprovado." } });
    expect(state.chat).toHaveBeenCalledTimes(1);
    expect(state.tables.website_messages.some((row) => row.role === "system" && String(row.content).includes("checkpoint"))).toBe(true);
  });
});
