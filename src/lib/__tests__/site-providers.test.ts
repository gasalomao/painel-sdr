import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { getStarterFiles } from "@/lib/sites/starter";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true,
  rows: {} as Record<string, Record<string, unknown>[]>,
  rpc: vi.fn(),
  query: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
  dbError: false,
}));

const sandboxMock = vi.hoisted(() => ({
  create: vi.fn(), write: vi.fn(), read: vi.fn(), run: vi.fn(), kill: vi.fn(),
}));
vi.mock("e2b", () => ({ Sandbox: { create: sandboxMock.create } }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: null }));
vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    if (!state.enabled) return null;
    return {
      rpc(name: string, args: Record<string, unknown>) {
        let signal: AbortSignal | undefined;
        const query = {
          abortSignal(value: AbortSignal) { signal = value; return query; },
          then(resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) {
            return Promise.resolve().then(() => state.rpc(name, args, signal)).then(resolve, reject);
          },
        };
        return query;
      },
      from(table: string) {
        const filters: Record<string, unknown> = {};
        let kind: "select" | "insert" | "update" = "select";
        let patch: Record<string, unknown> = {};
        let single = false;
        let signal: AbortSignal | undefined;
        type Query = {
          abortSignal: (value: AbortSignal) => Query;
          select: () => Query;
          insert: (row: Record<string, unknown>) => Query;
          update: (value: Record<string, unknown>) => Query;
          eq: (key: string, value: unknown) => Query;
          is: (key: string, value: unknown) => Query;
          order: () => Query;
          limit: () => Query;
          maybeSingle: () => Query;
          single: () => Query;
          then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) => Promise<unknown>;
        };
        const query: Query = {
          abortSignal: (value) => { signal = value; return query; },
          select: () => query,
          insert: (row) => { kind = "insert"; patch = row; state.inserts.push({ table, row }); return query; },
          update: (value) => { kind = "update"; patch = value; state.updates.push({ table, patch: value }); return query; },
          eq: (key, value) => { filters[key] = value; return query; },
          is: (key, value) => { filters[key] = value; return query; },
          order: () => query,
          limit: () => query,
          maybeSingle: () => { single = true; return query; },
          single: () => { single = true; return query; },
          then(resolve, reject) {
            return Promise.resolve().then(() => state.query(table, filters, signal, () => {
              const rows = (state.rows[table] ?? []).filter((row) => Object.entries(filters).every(([key, value]) =>
                Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
              if (state.dbError) return { data: null, error: { message: "private detail" } };
              if (kind === "insert") {
                const row = { ...patch, id: patch.id ?? `row-${state.inserts.length}` };
                return { data: single ? row : [row], error: null };
              }
              if (kind === "update") {
                rows.forEach((row) => Object.assign(row, patch));
                const row = single ? { ...patch, id: rows[0]?.id ?? "updated" } : null;
                return { data: row, error: null };
              }
              return { data: single ? rows[0] ?? null : rows, error: null };
            })).then(resolve, reject);
          },
        };
        return query;
      },
    };
  },
}));
import { assertPublishableBuild, createCloudflareManifest, createSiteDeploymentProvider, publishSite, reserveSiteDomain, resumeSiteDeployment, siteWorkerName } from "@/lib/sites/deployment-provider";
import { createSiteBuildProvider, SITE_PROVIDER_NOT_CONFIGURED } from "@/lib/sites/build-provider";
import type { WebsiteBuild, WebsiteProject } from "@/lib/sites/types";

const CLIENT = "00000000-0000-0000-0000-000000000001";
const PROJECT = "00000000-0000-0000-0000-000000000010";
const REVISION = "00000000-0000-0000-0000-000000000011";
const BUILD = "00000000-0000-0000-0000-000000000012";
const VERSION = "00000000-0000-0000-0000-000000000013";
const OLD_DEPLOY = "00000000-0000-0000-0000-000000000015";
const VERSION_OLD = "00000000-0000-0000-0000-000000000016";
const DEPLOY = "00000000-0000-0000-0000-000000000014";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";
const HTML_B64 = Buffer.from("<!doctype html><html lang=pt-BR><body>ok</body></html>").toString("base64");
const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);
const WORKER = `site-${PROJECT.replaceAll("-", "")}`;
const ENV_KEYS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_WORKERS_SUBDOMAIN", "E2B_API_KEY", "E2B_SITE_TEMPLATE_ID"];

function projectFixture(): WebsiteProject {
  return {
    id: PROJECT, client_id: CLIENT, name: "Loja", slug: "loja", lead_id: null, client_context: {},
    instructions: "", model_mode: "auto", model_id: null, selected_skill_ids: [], cta: { type: "whatsapp", value: "" },
    status: "draft", current_revision_id: REVISION, published_deployment_id: null, published_url: null,
    last_published_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", deleted_at: null,
  };
}

function buildFixture(overrides: Partial<WebsiteBuild> = {}): WebsiteBuild {
  return {
    id: BUILD, client_id: CLIENT, project_id: PROJECT, revision_id: REVISION, created_at: "2026-01-01T00:00:00Z",
    success: true, status: "ready", logs: "", duration_ms: 1000,
    artifact: { "/index.html": { content: HTML_B64, mime: "text/html" } },
    errors: [], warnings: [], screenshots: { desktop: PNG, mobile: PNG },
    qa: { passed: true, errors: [], warnings: [], visual_review: "Layout aprovado sem defeitos." },
    ...overrides,
  };
}

function cloudflareEnv(zone = false): void {
  process.env.CLOUDFLARE_API_TOKEN = "tok";
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  process.env.CLOUDFLARE_WORKERS_SUBDOMAIN = "acme";
  if (zone) process.env.CLOUDFLARE_ZONE_ID = ZONE;
}

function envelope(result: unknown): Response {
  return Response.json({ success: true, result });
}

function stubCloudflare(options: { activeVersion?: string; versions?: Array<{ id: string; annotations?: Record<string, string> }>; buckets?: string[][] } = {}): void {
  let activeVersion = options.activeVersion;
  const versions = options.versions ?? [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    init.signal?.throwIfAborted();
    const method = init.method ?? "GET";
    const url = String(input);
    let body: unknown;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    if (init.body instanceof FormData) {
      const metadata = init.body.get("metadata");
      if (metadata instanceof Blob) body = JSON.parse(await metadata.text());
    }
    state.calls.push({ method, url, body });
    if (url === `https://${WORKER}.acme.workers.dev/` || url === "https://old/") return new Response("ok", { headers: { "content-type": "text/html" } });
    if (url.endsWith("/workers/subdomain") && method === "GET") return envelope({ subdomain: "acme" });
    if (url.endsWith("/subdomain") && method === "POST") return envelope({ enabled: true });
    if (url.includes("/assets-upload-session")) return envelope({ jwt: "session-jwt", buckets: options.buckets ?? [] });
    if (url.includes("/assets/upload")) return envelope({ jwt: "completion-jwt" });
    if (url.includes("/versions") && method === "GET") {
      const page = Number(new URL(url).searchParams.get("page"));
      return envelope({ items: versions.slice((page - 1) * 100, page * 100) });
    }
    if (url.includes("/versions") && method === "POST") {
      versions.push({ id: VERSION, annotations: (body as { annotations: Record<string, string> }).annotations });
      return envelope({ id: VERSION });
    }
    if (url.includes("/deployments") && method === "POST") {
      activeVersion = (body as { versions: Array<{ version_id: string }> }).versions[0].version_id;
      return envelope({ deployment_id: "dep" });
    }
    if (url.includes("/deployments") && method === "GET") return envelope({ deployments: activeVersion ? [{ versions: [{ version_id: activeVersion, percentage: 100 }] }] : [] });
    if (url.endsWith("/workers") && method === "POST") return envelope({ id: WORKER });
    if (url.endsWith(`/workers/${WORKER}`) && method === "GET") return new Response(null, { status: 404 });
    throw new Error(`Unexpected fetch ${method} ${url}`);
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  state.enabled = true;
  state.dbError = false;
  state.rows = {
    clients: [{ id: CLIENT, is_active: true, is_admin: false, features: { sites: true } }],
    website_projects: [projectFixture() as unknown as Record<string, unknown>],
    website_builds: [buildFixture() as unknown as Record<string, unknown>],
  };
  state.inserts = [];
  state.updates = [];
  state.calls = [];
  ENV_KEYS.forEach((key) => { vi.stubEnv(key, undefined); });
  state.rpc.mockImplementation((_name, _args, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return { data: true, error: null };
  });
  state.query.mockImplementation((_table, _filters, signal: AbortSignal | undefined, next: () => unknown) => {
    signal?.throwIfAborted();
    return next();
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
});

describe("createCloudflareManifest", () => {
  it("deriva hash sha256(base64+ext) truncado e tamanho decodificado", () => {
    const manifest = createCloudflareManifest({ "/index.html": { content: HTML_B64, mime: "text/html" } });
    expect(manifest["/index.html"]).toEqual({
      hash: createHash("sha256").update(HTML_B64 + "html").digest("hex").slice(0, 32),
      size: Buffer.from(HTML_B64, "base64").length,
    });
  });

  it("exige /index.html", () => {
    expect(() => createCloudflareManifest({ "/app.js": { content: Buffer.from("x").toString("base64"), mime: "text/javascript" } }))
      .toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => createCloudflareManifest({})).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it.each([
    "index.html",
    "/_worker.js",
    "/functions/f.js",
    "/package.json",
    "/.env",
    "/a/../b.html",
    `/${"a".repeat(240)}.html`,
    "/sem%20ext",
  ])("rejeita caminho perigoso %s", (path) => {
    expect(() => createCloudflareManifest({ [path]: { content: HTML_B64, mime: "text/html" } }))
      .toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("rejeita mime incompatível com a extensão", () => {
    expect(() => createCloudflareManifest({ "/index.html": { content: HTML_B64, mime: "text/html" }, "/app.js": { content: HTML_B64, mime: "text/html" } }))
      .toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("rejeita base64 inválido", () => {
    expect(() => createCloudflareManifest({ "/index.html": { content: "não é base64!!", mime: "text/html" } }))
      .toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("rejeita mais de 500 arquivos", () => {
    const artifact: Record<string, { content: string; mime: string }> = { "/index.html": { content: HTML_B64, mime: "text/html" } };
    for (let index = 0; index < 501; index += 1) artifact[`/p${index}.html`] = { content: HTML_B64, mime: "text/html" };
    expect(() => createCloudflareManifest(artifact)).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe("assertPublishableBuild", () => {
  it("aceita build verde da revisão atual", () => {
    expect(() => assertPublishableBuild(projectFixture(), buildFixture())).not.toThrow();
  });

  it.each([
    { label: "revisão divergente", build: () => buildFixture({ revision_id: "00000000-0000-0000-0000-000000000099" }) },
    { label: "qa reprovado", build: () => buildFixture({ qa: { passed: false, errors: ["overflow"], warnings: [], visual_review: "ok" } }) },
    { label: "sem crítica visual", build: () => buildFixture({ qa: { passed: true, errors: [], warnings: [], visual_review: " " } }) },
    { label: "screenshot inválido", build: () => buildFixture({ screenshots: { desktop: "data:image/jpeg;base64,abc", mobile: PNG } }) },
    { label: "build com erros", build: () => buildFixture({ errors: ["erro"] }) },
    { label: "status não ready", build: () => buildFixture({ status: "failed" }) },
  ])("bloqueia publicação quando $label", ({ build }) => {
    expect(() => assertPublishableBuild(projectFixture(), build())).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("bloqueia projeto arquivado ou excluído", () => {
    const archived = { ...projectFixture(), status: "archived" as const };
    expect(() => assertPublishableBuild(archived, buildFixture())).toThrowError(expect.objectContaining({ status: 409 }));
    const deleted = { ...projectFixture(), deleted_at: "2026-01-02T00:00:00Z" };
    expect(() => assertPublishableBuild(deleted, buildFixture())).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("permite rollback de build antigo ignorando revisão atual", () => {
    const stale = buildFixture({ revision_id: "00000000-0000-0000-0000-000000000099" });
    expect(() => assertPublishableBuild(projectFixture(), stale, true)).not.toThrow();
  });
});

describe("provider Cloudflare", () => {
  it("não configurado sem credenciais", () => {
    expect(createSiteDeploymentProvider().configured()).toBe(false);
  });

  it("nome de worker derivado do projeto e valida uuids", () => {
    expect(siteWorkerName(projectFixture())).toBe(WORKER);
    expect(() => siteWorkerName({ ...projectFixture(), id: "não-uuid" })).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("hostname workers.dev exige subdomínio configurado", () => {
    cloudflareEnv();
    expect(createSiteDeploymentProvider().hostname(projectFixture(), "")).toBe(`${WORKER}.acme.workers.dev`);
    delete process.env.CLOUDFLARE_WORKERS_SUBDOMAIN;
    expect(() => createSiteDeploymentProvider().hostname(projectFixture(), "")).toThrowError(expect.objectContaining({ status: 503 }));
  });

  it("hostname com zona gerencia domínio personalizado e valida entradas", () => {
    cloudflareEnv(true);
    const provider = createSiteDeploymentProvider();
    expect(provider.hostname(projectFixture(), "cli.example.com")).toBe("loja.cli.example.com");
    expect(() => provider.hostname({ ...projectFixture(), slug: "Invalid_Slug" }, "cli.example.com")).toThrowError(expect.objectContaining({ status: 400 }));
    process.env.CLOUDFLARE_ZONE_ID = "zz";
    expect(() => createSiteDeploymentProvider().hostname(projectFixture(), "cli.example.com")).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("reserva de domínio falha fechado sem subdomínio", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
    await expect(reserveSiteDomain(projectFixture(), "")).rejects.toMatchObject({ status: 503 });
  });
});

function deploymentRpc(overrides: { begin?: { data?: unknown; error?: { message: string } | null }; claim?: unknown; row?: Record<string, unknown> } = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: DEPLOY, client_id: CLIENT, project_id: PROJECT, build_id: BUILD, provider: "cloudflare",
    status: "deploying", provider_id: null, url: null, error: null, created_at: "2026-01-01T00:00:00Z",
    hostname: `${WORKER}.acme.workers.dev`, phase: "reserved", expected_revision_id: REVISION, rollback_id: null,
    claim_id: null, lease_expires_at: null, ...overrides.row,
  };
  state.rpc.mockImplementation(async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (name === "website_begin_deployment") {
      if (overrides.begin) return overrides.begin;
      if (args.p_rollback_id && row.phase === "reserved") Object.assign(row, { provider_id: VERSION_OLD, phase: "version_ready", rollback_id: OLD_DEPLOY });
      return { data: { ...row }, error: null };
    }
    if (args.p_client_id !== row.client_id || args.p_project_id !== row.project_id || args.p_deployment_id !== row.id) return { data: null, error: { message: "website_not_found" } };
    if (name === "website_claim_deployment") {
      if (overrides.claim !== undefined) return overrides.claim;
      if (row.status !== "deploying" || (row.claim_id && Number(row.lease_expires_at) > Date.now())) return { data: null, error: null };
      Object.assign(row, { claim_id: args.p_claim_id, lease_expires_at: Date.now() + 300_000 });
      return { data: { ...row }, error: null };
    }
    if (row.status !== "deploying" || args.p_claim_id !== row.claim_id || Number(row.lease_expires_at) <= Date.now()) return { data: null, error: { message: "website_lease_lost" } };
    if (name === "website_renew_deployment") {
      row.lease_expires_at = Date.now() + 300_000;
      return { data: true, error: null };
    }
    if (name === "website_checkpoint_deployment") {
      Object.assign(row, { phase: args.p_phase, provider_id: args.p_provider_id });
      return { data: { ...row }, error: null };
    }
    if (name === "website_finish_deployment") {
      if (row.phase === "activating" && args.p_status === "failed") return { data: null, error: { message: "website_invalid_input" } };
      Object.assign(row, { claim_id: null, status: args.p_status, url: args.p_status === "published" ? `https://${WORKER}.acme.workers.dev` : null, error: args.p_error ?? null });
      return { data: { ...row }, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
  return row;
}

function rpcNames(): string[] { return state.rpc.mock.calls.map((call) => call[0]); }

describe("publishSite", () => {
  it("rejeita sem credenciais antes de tocar o provedor", async () => {
    await expect(publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "key-1234567890abcdef", baseDomain: "" }))
      .rejects.toMatchObject({ status: 503, message: SITE_PROVIDER_NOT_CONFIGURED });
    expect(state.inserts).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it("rejeita Idempotency-Key inválida", async () => {
    cloudflareEnv();
    stubCloudflare();
    await expect(publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "curto", baseDomain: "" }))
      .rejects.toMatchObject({ status: 400 });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejeita quando o build não existe", async () => {
    cloudflareEnv();
    stubCloudflare();
    deploymentRpc({ begin: { data: null, error: { message: "website_not_found" } } });
    await expect(publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "key-1234567890abcdef", baseDomain: "" }))
      .rejects.toMatchObject({ status: 404 });
    expect(rpcNames()).toEqual(["website_begin_deployment"]);
    expect(state.calls).toEqual([]);
  });

  it("bloqueia por cota diária dentro da reserva atômica", async () => {
    cloudflareEnv();
    stubCloudflare();
    deploymentRpc({ begin: { data: null, error: { message: "website_quota_exceeded" } } });
    await expect(publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "key-1234567890abcdef", baseDomain: "" }))
      .rejects.toMatchObject({ status: 429 });
    expect(rpcNames()).toEqual(["website_begin_deployment"]);
    expect(state.calls).toEqual([]);
  });

  it("rejeita quando o projeto mudou de revisão durante a publicação", async () => {
    cloudflareEnv();
    stubCloudflare();
    deploymentRpc({ begin: { data: null, error: { message: "website_revision_conflict" } } });
    await expect(publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "key-1234567890abcdef", baseDomain: "" }))
      .rejects.toMatchObject({ status: 409 });
    expect(state.calls).toEqual([]);
  });

  it("chave repetida de deployment concluído retorna sem novos efeitos externos", async () => {
    cloudflareEnv();
    stubCloudflare();
    deploymentRpc({ begin: { data: { id: DEPLOY, status: "published", provider_id: VERSION, url: "https://published" }, error: null } });
    const deployment = await publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "key-1234567890abcdef", baseDomain: "" });
    expect(deployment.status).toBe("published");
    expect(rpcNames()).toEqual(["website_begin_deployment"]);
    expect(state.calls).toEqual([]);
  });

  it("claim ocupado por outra execução retorna 409", async () => {
    cloudflareEnv();
    stubCloudflare();
    deploymentRpc({ claim: { data: null, error: null } });
    await expect(publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "key-1234567890abcdef", baseDomain: "" }))
      .rejects.toMatchObject({ status: 409, message: "Publicação em andamento por outra execução." });
    expect(rpcNames()).toEqual(["website_begin_deployment", "website_claim_deployment"]);
    expect(state.calls).toEqual([]);
  });

  it("publica build pronto via reserva atômica, upload de assets, versão e ativação confirmada", async () => {
    cloudflareEnv();
    stubCloudflare();
    deploymentRpc();
    const deployment = await publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "key-1234567890abcdef", baseDomain: "" });
    expect(deployment.status).toBe("published");
    expect(rpcNames().filter((name) => name !== "website_renew_deployment")).toEqual(["website_begin_deployment", "website_claim_deployment", "website_checkpoint_deployment", "website_checkpoint_deployment", "website_checkpoint_deployment", "website_finish_deployment"]);
    const beginArgs = state.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(beginArgs).toMatchObject({ p_client_id: CLIENT, p_project_id: PROJECT, p_build_id: BUILD, p_rollback_id: null, p_idempotency_key: "key-1234567890abcdef", p_hostname: `${WORKER}.acme.workers.dev` });
    expect(state.calls.some((call) => call.url.includes("/assets-upload-session"))).toBe(true);
    expect(state.calls.find((call) => call.url.includes("/versions"))).toMatchObject({ method: "POST", body: { annotations: annotationsOf(DEPLOY) } });
    const activationMethods = state.calls.filter((call) => call.url.includes("/deployments")).map((call) => call.method);
    expect(activationMethods).toEqual(["GET", "POST", "GET"]);
    const release = state.calls.find((call) => call.url.includes("/deployments") && call.method === "POST");
    expect(JSON.stringify(release?.body)).toContain(VERSION);
    expect(state.calls.some((call) => call.url === `https://${WORKER}.acme.workers.dev/`)).toBe(true);
    expect(state.inserts.find((insert) => insert.table === "website_deployments")).toBeUndefined();
  });

  it("falha externa após versão deixa deployment em deploying com erro para retomada", async () => {
    cloudflareEnv();
    stubCloudflare();
    interceptFetch(async (url, init, next) => url.endsWith("/deployments") && init.method === "POST" ? new Response(null, { status: 502 }) : next());
    deploymentRpc();
    await expect(publishSite({ clientId: CLIENT, projectId: PROJECT, buildId: BUILD, idempotencyKey: "key-1234567890abcdef", baseDomain: "" }))
      .rejects.toMatchObject({ status: 503 });
    const finish = state.rpc.mock.calls.find((call) => call[0] === "website_finish_deployment");
    expect(finish?.[1]).toMatchObject({ p_status: "deploying" });
    expect((finish?.[1] as Record<string, unknown>).p_error).toBeTruthy();
  });

  it("rollback reutiliza version_id anterior sem criar nova versão", async () => {
    cloudflareEnv();
    stubCloudflare();
    state.rows.website_deployments = [{
      id: OLD_DEPLOY, client_id: CLIENT, project_id: PROJECT, build_id: BUILD,
      provider: "cloudflare", status: "published", provider_id: VERSION_OLD,
      url: "https://old", error: null, created_at: "2026-01-01T00:00:00Z",
    }];
    deploymentRpc();
    const deployment = await publishSite({ clientId: CLIENT, projectId: PROJECT, rollbackId: OLD_DEPLOY, idempotencyKey: "key-1234567890abcdef", baseDomain: "" });
    expect(deployment.status).toBe("published");
    expect(state.calls.some((call) => call.url.includes("/versions"))).toBe(false);
    expect(state.calls.some((call) => call.url.includes("/assets-upload-session"))).toBe(false);
    const release = state.calls.find((call) => call.url.includes("/deployments") && call.method === "POST");
    expect(JSON.stringify(release?.body)).toContain(VERSION_OLD);
    const beginArgs = state.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(beginArgs.p_rollback_id).toBe(OLD_DEPLOY);
  });

  it("rollback de deployment ausente, de outro tenant ou sem versão é bloqueado antes da reserva", async () => {
    cloudflareEnv();
    stubCloudflare();
    deploymentRpc();
    state.rows.website_deployments = [];
    await expect(publishSite({ clientId: CLIENT, projectId: PROJECT, rollbackId: OLD_DEPLOY, idempotencyKey: "key-1234567890abcdef", baseDomain: "" }))
      .rejects.toMatchObject({ status: 404 });
    expect(rpcNames()).toEqual([]);
    expect(state.calls).toEqual([]);
  });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const versionPosts = () => state.calls.filter((call) => call.method === "POST" && call.url.includes("/versions"));
const activationPosts = () => state.calls.filter((call) => call.method === "POST" && call.url.includes("/deployments"));

function interceptFetch(handler: (url: string, init: RequestInit, next: () => Promise<Response>) => Promise<Response>): void {
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((input: string | URL, init: RequestInit = {}) => handler(String(input), init, () => original(input, init))));
}

function interceptRpc(handler: (name: string, args: Record<string, unknown>, next: () => Promise<unknown>, signal?: AbortSignal) => Promise<unknown>): void {
  const original = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((name: string, args: Record<string, unknown>, signal?: AbortSignal) => handler(name, args, () => original(name, args, signal), signal));
}

const annotationsOf = (id: string) => ({ "workers/tag": id.replaceAll("-", ""), "workers/message": `deployment:${id}` });

function waitForAbort(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (!signal) return reject(new Error("AbortSignal obrigatório"));
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setupResume(row: Record<string, unknown> = {}, activeVersion?: string): Record<string, unknown> {
  cloudflareEnv();
  stubCloudflare({ activeVersion });
  return deploymentRpc({ row });
}

const resume = (signal?: AbortSignal) => resumeSiteDeployment(CLIENT, PROJECT, DEPLOY, signal);

function stubDatabaseTimeout(): void {
  const timeout = AbortSignal.timeout;
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    if (ms !== 10_000) return timeout(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Database timeout", "TimeoutError")), ms);
    return controller.signal;
  });
}

const databaseStages = [
  "website_claim_deployment", "website_projects", "website_builds", "website_renew_deployment",
  "version_creating", "version_ready", "activating", "published", "failed", "deploying",
];

function interceptDatabaseStage(stage: string, handler: (signal: AbortSignal | undefined, next: () => Promise<unknown>) => Promise<unknown>): void {
  interceptRpc(async (name, args, next, signal) => {
    const matches = name === stage || (name === "website_checkpoint_deployment" && args.p_phase === stage) ||
      (name === "website_finish_deployment" && args.p_status === stage);
    return matches ? handler(signal, next) : next();
  });
  state.query.mockImplementation((table: string, _filters: unknown, signal: AbortSignal | undefined, next: () => unknown) => {
    signal?.throwIfAborted();
    return table === stage ? handler(signal, async () => next()) : next();
  });
}

function setupDatabaseStage(stage: string): Record<string, unknown> {
  const row = setupResume();
  if (stage === "failed") state.rows.website_builds[0].errors = ["QA inválido"];
  if (stage === "deploying") {
    interceptFetch(async (url, _init, next) => url.endsWith("/deployments") ? new Response(null, { status: 502 }) : next());
  }
  return row;
}

describe("cancelamento Supabase na retomada", () => {
  it.each(databaseStages)("shutdown cancela request pendurado em %s sem novos efeitos", async (stage) => {
    const row = setupDatabaseStage(stage);
    const controller = new AbortController();
    const reason = new DOMException("Shutdown", "AbortError");
    const started = deferred();
    let requestSignal: AbortSignal | undefined;
    let settled = false;
    interceptDatabaseStage(stage, async (signal) => {
      requestSignal = signal;
      started.resolve();
      try { return await waitForAbort(signal); } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : "aborted" } };
      }
    });
    const result = resume(controller.signal).finally(() => { settled = true; });
    const assertion = expect(result).rejects.toBe(reason);
    await started.promise;
    const calls = state.calls.length;
    const rpcs = state.rpc.mock.calls.length;
    const reads = state.query.mock.calls.length;
    expect(settled).toBe(false);
    controller.abort(reason);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
    expect(state.calls).toHaveLength(calls);
    expect(state.rpc.mock.calls).toHaveLength(rpcs);
    expect(state.query.mock.calls).toHaveLength(reads);
    expect(row.status).toBe("deploying");
  });

  it.each(databaseStages)("timeout cancela request pendurado em %s sem novos efeitos", async (stage) => {
    vi.useFakeTimers();
    stubDatabaseTimeout();
    const row = setupDatabaseStage(stage);
    const started = deferred();
    let requestSignal: AbortSignal | undefined;
    interceptDatabaseStage(stage, async (signal) => {
      requestSignal = signal;
      started.resolve();
      return waitForAbort(signal);
    });
    const result = resume();
    const assertion = expect(result).rejects.toMatchObject(stage === "website_renew_deployment" ? { status: 503 } : { name: "TimeoutError" });
    await started.promise;
    const calls = state.calls.length;
    const rpcs = state.rpc.mock.calls.length;
    const reads = state.query.mock.calls.length;
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(10_001)]);
    expect(requestSignal?.aborted).toBe(true);
    expect(state.calls).toHaveLength(calls);
    expect(state.rpc.mock.calls).toHaveLength(rpcs);
    expect(state.query.mock.calls).toHaveLength(reads);
    expect(row.status).toBe("deploying");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(databaseStages)("resposta bem-sucedida em %s após aborto não inicia efeitos", async (stage) => {
    setupDatabaseStage(stage);
    const controller = new AbortController();
    const reason = new DOMException("Shutdown", "AbortError");
    let calls = 0;
    let rpcs = 0;
    let reads = 0;
    interceptDatabaseStage(stage, async (_signal, next) => {
      const result = await next();
      calls = state.calls.length;
      rpcs = state.rpc.mock.calls.length;
      reads = state.query.mock.calls.length;
      controller.abort(reason);
      return result;
    });
    await expect(resume(controller.signal)).rejects.toBe(reason);
    expect(state.calls).toHaveLength(calls);
    expect(state.rpc.mock.calls).toHaveLength(rpcs);
    expect(state.query.mock.calls).toHaveLength(reads);
  });

  it("aborto anterior ao claim não consulta banco nem provedor", async () => {
    setupResume();
    const controller = new AbortController();
    controller.abort();
    await expect(resume(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.query).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("mantém escopo de cliente, projeto e deleted_at nas leituras", async () => {
    setupResume();
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(state.query).toHaveBeenCalledWith("website_projects", { client_id: CLIENT, id: PROJECT, deleted_at: null }, expect.any(AbortSignal), expect.any(Function));
    expect(state.query).toHaveBeenCalledWith("website_builds", { client_id: CLIENT, project_id: PROJECT, id: BUILD }, expect.any(AbortSignal), expect.any(Function));
  });
});

describe("recuperação de deployments", () => {
  it.each(["resposta perdida", "checkpoint perdido"])("reconcilia versão por deployment.id após %s sem repetir criação", async (failure) => {
    const row = setupResume();
    let fail = true;
    if (failure === "resposta perdida") {
      interceptFetch(async (url, init, next) => {
        const result = await next();
        if (url.endsWith("/versions") && init.method === "POST" && fail) {
          fail = false;
          throw new DOMException("Resposta perdida", "TimeoutError");
        }
        return result;
      });
    } else {
      interceptRpc(async (name, args, next) => {
        if (name === "website_checkpoint_deployment" && args.p_phase === "version_ready" && fail) {
          fail = false;
          return { data: null, error: { message: "connection lost" } };
        }
        return next();
      });
    }
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row).toMatchObject({ phase: "version_creating", status: "deploying", provider_id: null });
    expect(versionPosts()).toHaveLength(1);
    await expect(resume()).resolves.toMatchObject({ status: "published", provider_id: VERSION });
    expect(versionPosts()).toHaveLength(1);
    expect(state.calls.some((call) => call.method === "GET" && call.url.includes("/versions?"))).toBe(true);
  });

  it("recupera checkpoint aplicado cuja resposta se perdeu sem upload adicional", async () => {
    const row = setupResume();
    let fail = true;
    interceptRpc(async (name, args, next) => {
      const result = await next();
      if (name === "website_checkpoint_deployment" && args.p_phase === "version_ready" && fail) {
        fail = false;
        throw new Error("Resposta do banco perdida");
      }
      return result;
    });
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row.phase).toBe("version_ready");
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(versionPosts()).toHaveLength(1);
  });

  it("não recria versão ausente após intenção persistida, nem com 404 remoto", async () => {
    const row = setupResume({ phase: "version_creating" });
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    interceptFetch(async (url, _init, next) => url.includes("/versions?") ? new Response(null, { status: 404 }) : next());
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row.status).toBe("deploying");
    expect(versionPosts()).toHaveLength(0);
    expect(state.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("não cria versão nem ativa se o checkpoint de intenção falhar após preparar assets", async () => {
    const row = setupResume();
    let fail = true;
    interceptRpc(async (name, args, next) => {
      if (name === "website_checkpoint_deployment" && args.p_phase === "version_creating" && fail) {
        fail = false;
        return { data: null, error: { message: "unavailable" } };
      }
      return next();
    });
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row).toMatchObject({ phase: "reserved", status: "deploying" });
    expect(state.calls.some((call) => call.url.endsWith("/assets-upload-session"))).toBe(true);
    expect(versionPosts()).toHaveLength(0);
    expect(activationPosts()).toHaveLength(0);
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(versionPosts()).toHaveLength(1);
  });

  it("checkpoint de intenção aplicado com resposta perdida não autoriza recriação", async () => {
    const row = setupResume();
    interceptRpc(async (name, args, next) => {
      const result = await next();
      if (name === "website_checkpoint_deployment" && args.p_phase === "version_creating") throw new Error("Resposta perdida");
      return result;
    });
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row).toMatchObject({ phase: "version_creating", status: "deploying" });
    await expect(resume()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Recriação automática bloqueada") });
    expect(versionPosts()).toHaveLength(0);
    expect(activationPosts()).toHaveLength(0);
  });

  it("só persiste version_creating após todos os uploads e antes do POST de versão", async () => {
    const row = setupResume();
    const hash = createCloudflareManifest(buildFixture().artifact)["/index.html"].hash;
    stubCloudflare({ buckets: [[hash], [hash]] });
    const observed: Array<{ path: string; phase: unknown }> = [];
    interceptFetch(async (url, init, next) => {
      if (init.method === "POST") observed.push({ path: new URL(url).pathname, phase: row.phase });
      return next();
    });
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(observed.filter(({ path }) => path.includes("/assets"))).toEqual([
      { path: `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/assets-upload-session`, phase: "reserved" },
      { path: `/client/v4/accounts/${ACCOUNT}/workers/assets/upload`, phase: "reserved" },
      { path: `/client/v4/accounts/${ACCOUNT}/workers/assets/upload`, phase: "reserved" },
    ]);
    expect(observed.find(({ path }) => path.endsWith("/versions"))?.phase).toBe("version_creating");
    expect(state.calls.find((call) => call.url.endsWith("/versions"))?.body).toMatchObject({ assets: { jwt: "completion-jwt" }, annotations: annotationsOf(DEPLOY) });
  });

  it.each(["/workers", "/assets-upload-session", "/assets/upload?base64=true"].flatMap((path) =>
    [429, 502, "timeout"].map((failure) => ({ path, failure }))))("retoma preparação após $failure em $path sem procurar versão inexistente", async ({ path, failure }) => {
    const row = setupResume();
    const hash = createCloudflareManifest(buildFixture().artifact)["/index.html"].hash;
    stubCloudflare({ buckets: [[hash]] });
    let fail = true;
    interceptFetch(async (url, init, next) => {
      if (url.endsWith(path) && init.method === "POST" && fail) {
        fail = false;
        if (failure === "timeout") throw new DOMException("Timeout", "TimeoutError");
        return new Response(null, { status: Number(failure) });
      }
      return next();
    });
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row).toMatchObject({ phase: "reserved", status: "deploying", provider_id: null, claim_id: null });
    expect(versionPosts()).toHaveLength(0);
    expect(activationPosts()).toHaveLength(0);
    await expect(resume()).resolves.toMatchObject({ status: "published", provider_id: VERSION });
    expect(versionPosts()).toHaveLength(1);
    expect(activationPosts()).toHaveLength(1);
    expect(state.calls.some((call) => call.method === "GET" && call.url.includes("/versions?"))).toBe(false);
  });

  it.each(["/assets-upload-session", "/assets/upload?base64=true"])("rejeição definitiva no preparo %s falha antes da intenção", async (path) => {
    const row = setupResume();
    const hash = createCloudflareManifest(buildFixture().artifact)["/index.html"].hash;
    stubCloudflare({ buckets: [[hash]] });
    interceptFetch(async (url, _init, next) => url.endsWith(path) ? new Response(null, { status: 403 }) : next());
    await expect(resume()).rejects.toMatchObject({ status: 502 });
    expect(row).toMatchObject({ phase: "reserved", status: "failed", provider_id: null, claim_id: null });
    expect(versionPosts()).toHaveLength(0);
    expect(activationPosts()).toHaveLength(0);
  });

  it.each([
    { jwt: 7, buckets: [] },
    { jwt: " ", buckets: [] },
    { jwt: "session", buckets: [null] },
    { jwt: "session", buckets: ["unknown"] },
    { jwt: "session", buckets: [["unknown"]] },
  ])("sessão de upload inválida preserva reserved para retry: %j", async (session) => {
    const row = setupResume();
    let fail = true;
    interceptFetch(async (url, _init, next) => {
      if (url.endsWith("/assets-upload-session") && fail) { fail = false; return envelope(session); }
      return next();
    });
    await expect(resume()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/upload/i) });
    expect(row).toMatchObject({ phase: "reserved", status: "deploying", provider_id: null });
    expect(versionPosts()).toHaveLength(0);
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(versionPosts()).toHaveLength(1);
  });

  it.each([{}, { jwt: 7 }, { jwt: " " }, { jwt: null }])("conclusão de upload inválida não cria intenção: %j", async (upload) => {
    const row = setupResume();
    const hash = createCloudflareManifest(buildFixture().artifact)["/index.html"].hash;
    stubCloudflare({ buckets: [[hash]] });
    let fail = true;
    interceptFetch(async (url, _init, next) => {
      if (url.includes("/assets/upload") && fail) { fail = false; return envelope(upload); }
      return next();
    });
    await expect(resume()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/upload/i) });
    expect(row).toMatchObject({ phase: "reserved", status: "deploying", provider_id: null });
    expect(versionPosts()).toHaveLength(0);
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(versionPosts()).toHaveLength(1);
  });

  it.each([{}, { id: "invalid" }, { id: null }])("resposta de versão inválida continua ambígua e reconcilia: %j", async (version) => {
    const row = setupResume();
    interceptFetch(async (url, init, next) => {
      const result = await next();
      return url.endsWith("/versions") && init.method === "POST" ? envelope(version) : result;
    });
    await expect(resume()).rejects.toMatchObject({ status: 503, message: "Versão inválida no provedor." });
    expect(row).toMatchObject({ phase: "version_creating", status: "deploying", provider_id: null });
    await expect(resume()).resolves.toMatchObject({ status: "published", provider_id: VERSION });
    expect(versionPosts()).toHaveLength(1);
  });

  it.each([
    {}, { items: [null] }, { items: [{ id: "invalid", annotations: annotationsOf(DEPLOY) }] },
  ])("lista de versões inválida não libera intenção antiga: %j", async (listed) => {
    const row = setupResume({ phase: "version_creating", error: "Cloudflare indisponível (HTTP 429)." });
    interceptFetch(async (url, _init, next) => url.includes("/versions?") ? envelope(listed) : next());
    await expect(resume()).rejects.toMatchObject({ status: 503, message: "Lista de versões inválida no provedor." });
    expect(row).toMatchObject({ phase: "version_creating", status: "deploying", provider_id: null });
    expect(versionPosts()).toHaveLength(0);
    expect(activationPosts()).toHaveLength(0);
  });

  it("429 legado em version_creating não prova ausência de POST e não autoriza recriação", async () => {
    const row = setupResume({ phase: "version_creating", error: "Cloudflare indisponível (HTTP 429)." });
    await expect(resume()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Recriação automática bloqueada") });
    expect(row.status).toBe("deploying");
    expect(state.calls.every((call) => call.method === "GET")).toBe(true);
    stubCloudflare({ versions: [{ id: VERSION, annotations: annotationsOf(DEPLOY) }] });
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(versionPosts()).toHaveLength(0);
    expect(activationPosts()).toHaveLength(1);
  });

  it("pagina versões e ignora tags de outro deployment do mesmo build", async () => {
    setupResume({ phase: "version_creating" });
    stubCloudflare({ versions: [...Array.from({ length: 100 }, () => ({ id: VERSION_OLD, annotations: annotationsOf(BUILD) })), { id: VERSION, annotations: annotationsOf(DEPLOY) }] });
    await expect(resume()).resolves.toMatchObject({ status: "published", provider_id: VERSION });
    expect(state.calls.filter((call) => call.url.includes("/versions?")).length).toBe(2);
    expect(versionPosts()).toHaveLength(0);
  });

  it("bloqueia versões duplicadas com a mesma tag", async () => {
    const row = setupResume({ phase: "version_creating" });
    stubCloudflare({ versions: [VERSION, VERSION_OLD].map((id) => ({ id, annotations: annotationsOf(DEPLOY) })) });
    await expect(resume()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Múltiplas versões") });
    expect(row.status).toBe("deploying");
    expect(activationPosts()).toHaveLength(0);
  });

  it.each(["version_ready", "activating"])("consulta ativo antes de ativar em %s e não repete POST", async (phase) => {
    setupResume({ phase, provider_id: VERSION }, VERSION);
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(activationPosts()).toHaveLength(0);
    if (phase === "activating") expect(state.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("retoma ativação aplicada cuja resposta se perdeu sem segundo POST", async () => {
    const row = setupResume({ phase: "version_ready", provider_id: VERSION });
    interceptFetch(async (url, init, next) => {
      const result = await next();
      if (url.endsWith("/deployments") && init.method === "POST") throw new DOMException("Resposta perdida", "TimeoutError");
      return result;
    });
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row).toMatchObject({ status: "deploying", phase: "activating" });
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(activationPosts()).toHaveLength(1);
  });

  it("não reenvia ativação ambígua ausente do estado ativo", async () => {
    const row = setupResume({ phase: "activating", provider_id: VERSION });
    await expect(resume()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("reenvio automático bloqueado") });
    expect(row.status).toBe("deploying");
    expect(activationPosts()).toHaveLength(0);
  });

  it.each([403, 502, 200])("não ativa se a leitura do estado ativo falha: HTTP %s", async (status) => {
    setupResume({ phase: "version_ready", provider_id: VERSION });
    interceptFetch(async (url, init, next) => url.endsWith("/deployments") && init.method === "GET" ? (status === 200 ? envelope({}) : new Response(null, { status })) : next());
    await expect(resume()).rejects.toBeDefined();
    expect(activationPosts()).toHaveLength(0);
  });

  it.each([400, 401, 403, 413, 422])("rejeição definitiva HTTP %s pré-ativação libera o deployment", async (status) => {
    const row = setupResume();
    interceptFetch(async (url, init, next) => url.endsWith("/versions") && init.method === "POST" ? new Response(null, { status }) : next());
    await expect(resume()).rejects.toMatchObject({ status: 502 });
    expect(row).toMatchObject({ status: "failed", phase: "version_creating", claim_id: null });
    expect(activationPosts()).toHaveLength(0);
  });

  it.each([408, 409, 429, 500, 502, 504])("preserva resultado ambíguo HTTP %s sem falha terminal", async (status) => {
    const row = setupResume();
    interceptFetch(async (url, init, next) => url.endsWith("/versions") && init.method === "POST" ? new Response(null, { status }) : next());
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row).toMatchObject({ status: "deploying", phase: "version_creating" });
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(activationPosts()).toHaveLength(0);
  });

  it("validação local inválida antes dos efeitos marca failed", async () => {
    const row = setupResume();
    state.rows.website_builds[0].errors = ["QA inválido"];
    await expect(resume()).rejects.toMatchObject({ status: 409 });
    expect(row.status).toBe("failed");
    expect(state.calls).toEqual([]);
  });

  it("rejeição de ativação não é tratada como falha pré-ativação", async () => {
    const row = setupResume({ phase: "version_ready", provider_id: VERSION });
    interceptFetch(async (url, init, next) => url.endsWith("/deployments") && init.method === "POST" ? new Response(null, { status: 403 }) : next());
    await expect(resume()).rejects.toMatchObject({ status: 503 });
    expect(row).toMatchObject({ status: "deploying", phase: "activating" });
  });

  it("serializa duas retomadas concorrentes pelo claim", async () => {
    setupResume();
    const results = await Promise.allSettled([resume(), resume()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(versionPosts()).toHaveLength(1);
    expect(activationPosts()).toHaveLength(1);
  });

  it("escopa claim por cliente e projeto antes dos efeitos", async () => {
    setupResume();
    await expect(resumeSiteDeployment(VERSION_OLD, PROJECT, DEPLOY)).rejects.toMatchObject({ status: 404 });
    expect(state.calls).toEqual([]);
  });

  it("renova lease durante múltiplos uploads por mais de 300s", async () => {
    vi.useFakeTimers();
    const row = setupResume();
    const hash = createCloudflareManifest(buildFixture().artifact)["/index.html"].hash;
    stubCloudflare({ buckets: Array.from({ length: 16 }, () => [hash]) });
    const started = deferred();
    interceptFetch(async (url, _init, next) => {
      if (url.includes("/assets/upload")) {
        started.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20_000));
      }
      return next();
    });
    const result = resume();
    const assertion = expect(result).resolves.toMatchObject({ status: "published" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(325_000);
    await assertion;
    expect(row.status).toBe("published");
    expect(state.rpc.mock.calls.filter((call) => call[0] === "website_renew_deployment").length).toBeGreaterThan(20);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["outro owner", "banco indisponível", "renovação pendurada"])("aborta upload no heartbeat: %s", async (failure) => {
    vi.useFakeTimers();
    stubDatabaseTimeout();
    const row = setupResume();
    const hash = createCloudflareManifest(buildFixture().artifact)["/index.html"].hash;
    stubCloudflare({ buckets: [[hash]] });
    const started = deferred();
    let uploading = false;
    let uploadSignal: AbortSignal | null | undefined;
    interceptFetch(async (url, init, next) => {
      if (!url.includes("/assets/upload")) return next();
      uploading = true;
      uploadSignal = init.signal;
      if (failure === "outro owner") row.claim_id = VERSION_OLD;
      started.resolve();
      return waitForAbort(init.signal);
    });
    let renewSignal: AbortSignal | undefined;
    interceptRpc(async (name, _args, next, signal) => {
      if (name === "website_renew_deployment" && uploading) {
        if (failure === "banco indisponível") return { data: null, error: { message: "offline" } };
        if (failure === "renovação pendurada") {
          renewSignal = signal;
          return waitForAbort(signal);
        }
      }
      return next();
    });
    const result = resume();
    const assertion = expect(result).rejects.toMatchObject({ status: failure === "outro owner" ? 409 : 503 });
    await started.promise;
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(70_001)]);
    expect(uploadSignal?.aborted).toBe(true);
    if (failure === "renovação pendurada") expect(renewSignal?.aborted).toBe(true);
    expect(versionPosts()).toHaveLength(0);
    expect(activationPosts()).toHaveLength(0);
    expect(rpcNames()).not.toContain("website_finish_deployment");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("perda de ownership antes do POST de ativação impede efeito", async () => {
    const row = setupResume({ phase: "version_ready", provider_id: VERSION });
    interceptRpc(async (name, args, next) => {
      const result = await next();
      if (name === "website_checkpoint_deployment" && args.p_phase === "activating") row.claim_id = VERSION_OLD;
      return result;
    });
    await expect(resume()).rejects.toMatchObject({ status: 409 });
    expect(activationPosts()).toHaveLength(0);
    expect(rpcNames()).not.toContain("website_finish_deployment");
  });

  it.each(["/assets-upload-session", "/assets/upload?base64=true"])("abort no preparo %s preserva reserved e retoma após expirar lease", async (path) => {
    const row = setupResume();
    const hash = createCloudflareManifest(buildFixture().artifact)["/index.html"].hash;
    stubCloudflare({ buckets: [[hash]] });
    const controller = new AbortController();
    const started = deferred();
    let fail = true;
    interceptFetch(async (url, init, next) => {
      if (!url.endsWith(path) || !fail) return next();
      fail = false;
      started.resolve();
      return waitForAbort(init.signal);
    });
    const result = resume(controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    controller.abort();
    await assertion;
    expect(row).toMatchObject({ phase: "reserved", status: "deploying" });
    expect(versionPosts()).toHaveLength(0);
    expect(rpcNames()).not.toContain("website_finish_deployment");
    row.lease_expires_at = Date.now() - 1;
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(versionPosts()).toHaveLength(1);
  });

  it.each(["upload", "versão"])("resposta de %s após cancelamento não continua a publicação", async (stage) => {
    const row = setupResume();
    const controller = new AbortController();
    const reason = new DOMException("Shutdown", "AbortError");
    let requests = 0;
    interceptFetch(async (url, init, next) => {
      const result = await next();
      if (url.endsWith(stage === "upload" ? "/assets-upload-session" : "/versions") && init.method === "POST") {
        requests = state.calls.length;
        controller.abort(reason);
      }
      return result;
    });
    await expect(resume(controller.signal)).rejects.toBe(reason);
    expect(row).toMatchObject({ phase: stage === "upload" ? "reserved" : "version_creating", status: "deploying" });
    expect(state.calls).toHaveLength(requests);
    expect(rpcNames()).not.toContain("website_finish_deployment");
    expect(activationPosts()).toHaveLength(0);
    row.lease_expires_at = Date.now() - 1;
    vi.mocked(fetch).mockClear();
    stubCloudflare({ versions: stage === "versão" ? [{ id: VERSION, annotations: annotationsOf(DEPLOY) }] : [] });
    await expect(resume()).resolves.toMatchObject({ status: "published" });
    expect(versionPosts()).toHaveLength(1);
  });

  it("perda de ownership no limite do POST de versão impede efeitos e finalização", async () => {
    const row = setupResume();
    interceptRpc(async (name, args, next) => {
      const result = await next();
      if (name === "website_checkpoint_deployment" && args.p_phase === "version_creating") row.claim_id = VERSION_OLD;
      return result;
    });
    await expect(resume()).rejects.toMatchObject({ status: 409 });
    expect(versionPosts()).toHaveLength(0);
    expect(activationPosts()).toHaveLength(0);
    expect(rpcNames()).not.toContain("website_finish_deployment");
  });
});

describe("CAS SQL de deployments", () => {
  it("aplica transições, expiração, fencing e falha terminal apenas antes de ativar", async () => {
    const sql = readFileSync("migrations/016_website_studio.sql", "utf8");
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE website_projects (
          id uuid PRIMARY KEY, client_id uuid, deleted_at timestamptz, status text,
          current_revision_id uuid, published_deployment_id uuid, published_url text,
          last_published_at timestamptz, updated_at timestamptz
        );
        CREATE TABLE website_deployments (
          id uuid PRIMARY KEY, client_id uuid, project_id uuid, status text, claim_id uuid,
          lease_expires_at timestamptz, provider_id text, provider_version_id text,
          phase text, expected_revision_id uuid, hostname text, error text, url text
        );
        CREATE TABLE website_domains (client_id uuid, project_id uuid, hostname text, status text);
        CREATE TABLE website_usage (client_id uuid, kind text, quantity bigint, settled_at timestamptz, metadata jsonb);
        CREATE FUNCTION website_assert_access(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
        INSERT INTO website_projects(id, client_id, status, current_revision_id) VALUES ('${PROJECT}', '${CLIENT}', 'draft', '${REVISION}');
        INSERT INTO website_deployments(id, client_id, project_id, status, phase, expected_revision_id, hostname)
          VALUES ('${DEPLOY}', '${CLIENT}', '${PROJECT}', 'deploying', 'reserved', '${REVISION}', 'site.example.com');
        INSERT INTO website_usage(client_id, kind, quantity, metadata) VALUES ('${CLIENT}', 'deploys', 1, '{"deployment_id":"${DEPLOY}"}'::jsonb);
      `);
      for (const name of ["claim", "renew", "checkpoint", "finish"]) {
        const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.website_${name}_deployment(`);
        expect(start).toBeGreaterThan(-1);
        const end = sql.indexOf("END $$;", start) + "END $$;".length;
        await db.exec(sql.slice(start, end));
      }
      const claim = (owner = VERSION) => db.query<{ result: unknown }>("SELECT website_claim_deployment($1,$2,$3,$4,300) AS result", [CLIENT, PROJECT, DEPLOY, owner]);
      const renewLease = (owner = VERSION, client = CLIENT) => db.query<{ result: boolean }>("SELECT website_renew_deployment($1,$2,$3,$4,300) AS result", [client, PROJECT, DEPLOY, owner]);
      const checkpoint = (phase: string, providerId: string | null, owner = VERSION) => db.query("SELECT website_checkpoint_deployment($1,$2,$3,$4,$5,$6)", [CLIENT, PROJECT, DEPLOY, owner, providerId, phase]);
      const finish = (status: string, owner = VERSION) => db.query("SELECT website_finish_deployment($1,$2,$3,$4,$5,'teste')", [CLIENT, PROJECT, DEPLOY, owner, status]);
      await claim();
      expect((await claim(VERSION_OLD)).rows[0].result).toBeNull();
      expect((await renewLease()).rows[0].result).toBe(true);
      await expect(renewLease(VERSION_OLD)).rejects.toThrow("website_lease_lost");
      await expect(renewLease(VERSION, VERSION_OLD)).rejects.toThrow("website_not_found");
      await expect(checkpoint("version_ready", VERSION)).rejects.toThrow("website_invalid_input");
      await checkpoint("version_creating", null);
      await expect(checkpoint("version_creating", null)).rejects.toThrow("website_invalid_input");
      await finish("failed");
      const refunded = await db.query<{ quantity: number }>("SELECT quantity FROM website_usage WHERE client_id = $1 AND kind = 'deploys'", [CLIENT]);
      expect(refunded.rows[0].quantity).toBe(0);
      expect((await claim()).rows[0].result).toBeNull();
      await db.exec("UPDATE website_deployments SET status = 'deploying', phase = 'reserved'");
      await claim();
      await checkpoint("version_creating", null);
      await checkpoint("version_ready", VERSION);
      await expect(checkpoint("activating", VERSION_OLD)).rejects.toThrow("website_invalid_input");
      await db.exec("UPDATE website_deployments SET lease_expires_at = clock_timestamp() - interval '1 second'");
      await expect(renewLease()).rejects.toThrow("website_lease_lost");
      await expect(checkpoint("activating", VERSION)).rejects.toThrow("website_lease_lost");
      await expect(finish("failed")).rejects.toThrow("website_lease_lost");
      await claim(VERSION_OLD);
      await expect(renewLease()).rejects.toThrow("website_lease_lost");
      await checkpoint("activating", VERSION, VERSION_OLD);
      await expect(finish("failed", VERSION_OLD)).rejects.toThrow("website_invalid_input");
      await finish("published", VERSION_OLD);
      const project = await db.query<{ published_deployment_id: string }>("SELECT published_deployment_id FROM website_projects WHERE id = $1", [PROJECT]);
      expect(project.rows[0].published_deployment_id).toBe(DEPLOY);
    } finally {
      await db.close();
    }
  }, 20_000);
});

describe("createSiteBuildProvider", () => {
  const input = () => ({ project: projectFixture(), files: getStarterFiles(), assets: [] });
  beforeEach(() => {
    vi.stubEnv("E2B_API_KEY", "offline-test");
    vi.stubEnv("E2B_SITE_TEMPLATE_ID", "offline-template");
    sandboxMock.create.mockResolvedValue({
      files: { write: sandboxMock.write, read: sandboxMock.read },
      commands: { run: sandboxMock.run }, kill: sandboxMock.kill,
    });
    sandboxMock.read.mockResolvedValue(JSON.stringify(buildFixture()));
    sandboxMock.kill.mockResolvedValue(undefined);
  });

  it("retorna unconfigured sem credenciais E2B", async () => {
    vi.stubEnv("E2B_API_KEY", undefined);
    const result = await createSiteBuildProvider().build(input());
    expect(result).toMatchObject({ success: false, status: "unconfigured", errors: [SITE_PROVIDER_NOT_CONFIGURED], qa: { failure_kind: "infrastructure", stage: "configuration" } });
    expect(sandboxMock.create).not.toHaveBeenCalled();
  });

  it("mantém isolamento e budgets de 60s total e até 45s de comando", async () => {
    const result = await createSiteBuildProvider().build(input());
    expect(result).toMatchObject({ success: true, status: "ready", qa: { passed: true } });
    expect(sandboxMock.create).toHaveBeenCalledWith("offline-template", expect.objectContaining({ timeoutMs: 60_000, allowInternetAccess: false, network: { allowPublicTraffic: false } }));
    expect(sandboxMock.run.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(45_000);
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
  });

  it("preserva diagnóstico de fonte curto, não logs integrais", async () => {
    sandboxMock.read.mockResolvedValue(JSON.stringify(buildFixture({ success: false, status: "failed", logs: "private log", errors: ["src/App.tsx(8,2): error TS2322: Type mismatch"], qa: { passed: false, errors: ["src/App.tsx(8,2): error TS2322: Type mismatch"], warnings: [], failure_kind: "source", stage: "typecheck", diagnostics: ["src/App.tsx(8,2): error TS2322: Type mismatch"] } })));
    const result = await createSiteBuildProvider().build(input());
    expect(result.qa).toMatchObject({ failure_kind: "source", stage: "typecheck", diagnostics: ["src/App.tsx(8,2): error TS2322: Type mismatch"] });
    expect(JSON.stringify(result.qa)).not.toContain("private log");
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], { ...buildFixture(), qa: { passed: "true", errors: [], warnings: [] } }, { ...buildFixture(), screenshots: {} }])("resultado inválido falha como infraestrutura: %j", async (raw) => {
    sandboxMock.read.mockResolvedValue(JSON.stringify(raw));
    expect(await createSiteBuildProvider().build(input())).toMatchObject({ success: false, status: "failed", qa: { failure_kind: "infrastructure", stage: "result" } });
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
  });

  it("erro remoto não expõe detalhes nem pede correção de fontes", async () => {
    sandboxMock.create.mockRejectedValue(new Error("credential private-secret template unavailable"));
    const result = await createSiteBuildProvider().build(input());
    expect(result.qa).toMatchObject({ failure_kind: "infrastructure", stage: "sandbox" });
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  it("aborto prévio vence ausência de credenciais", async () => {
    vi.stubEnv("E2B_API_KEY", undefined);
    const controller = new AbortController(); controller.abort();
    expect(await createSiteBuildProvider().build(input(), controller.signal)).toMatchObject({ status: "failed", qa: { failure_kind: "cancelled" } });
    expect(sandboxMock.create).not.toHaveBeenCalled();
  });

  it("aborta comando pendurado, mata sandbox e não lê resultado", async () => {
    const controller = new AbortController();
    const started = deferred();
    sandboxMock.run.mockImplementation(() => { started.resolve(); return new Promise(() => undefined); });
    const result = createSiteBuildProvider().build(input(), controller.signal);
    await started.promise; controller.abort();
    expect(await result).toMatchObject({ status: "failed", qa: { failure_kind: "cancelled", stage: "command" } });
    expect(sandboxMock.read).not.toHaveBeenCalled();
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
  });

  it("timeout total mata sandbox mesmo com SDK pendurado", async () => {
    vi.useFakeTimers();
    const started = deferred();
    sandboxMock.run.mockImplementation(() => { started.resolve(); return new Promise(() => undefined); });
    const result = createSiteBuildProvider().build(input());
    await started.promise;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await result).toMatchObject({ status: "failed", qa: { failure_kind: "timeout", stage: "command" } });
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falha ao matar sandbox impede resultado ready", async () => {
    sandboxMock.kill.mockRejectedValue(new Error("kill unavailable"));
    expect(await createSiteBuildProvider().build(input())).toMatchObject({ success: false, status: "failed", qa: { failure_kind: "infrastructure", stage: "cleanup" } });
  });

  it("cleanup pendurado permanece limitado e nunca promove QA", async () => {
    vi.useFakeTimers();
    const started = deferred();
    sandboxMock.read.mockResolvedValue("invalid json");
    sandboxMock.kill.mockImplementation(() => { started.resolve(); return new Promise(() => undefined); });
    const result = createSiteBuildProvider().build(input());
    await started.promise;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toMatchObject({ status: "failed", qa: { failure_kind: "infrastructure", stage: "cleanup" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resposta de criação após aborto ainda mata sandbox tardio", async () => {
    const controller = new AbortController(), started = deferred(), release = deferred();
    sandboxMock.create.mockImplementation(async () => { started.resolve(); await release.promise; return { kill: sandboxMock.kill }; });
    const result = createSiteBuildProvider().build(input(), controller.signal);
    await started.promise; controller.abort();
    expect(await result).toMatchObject({ qa: { failure_kind: "cancelled" } });
    release.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
    expect(sandboxMock.write).not.toHaveBeenCalled();
  });
});

// Exercises operator-owned helpers only. Never imports/runs the sandbox entrypoint or generated sources on the host.
describe("runner isolated helpers", () => {
  function helpers(extra: Record<string, unknown> = {}) {
    const source = readFileSync("sandbox/site-studio/run.mjs", "utf8");
    const start = source.indexOf("function sanitizeDiagnostic(");
    const end = source.indexOf("let browser;", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    return runInNewContext(`${source.slice(start, end)}; ({ diagnosticsFromLogs, command, remaining, ready })`, {
      Date, Math, Error, Promise, Buffer, setTimeout, clearTimeout,
      logs: "", root: "/workspace/site", errors: [], deadline: Date.now() + 40_000, stage: "typecheck", spawn: () => { throw new Error("Host spawn forbidden"); }, ...extra,
    }) as { diagnosticsFromLogs: (text: string) => string[]; command: (args: string[]) => Promise<void>; remaining: (cap?: number) => number; ready: (page: { waitForFunction: ReturnType<typeof vi.fn>; evaluate: ReturnType<typeof vi.fn> }, width: number) => Promise<void> };
  }

  it("extrai apenas fileline TS/Vite limitado e sanitiza controles, URLs, segredos e conteúdo citado", () => {
    const text = "noise private log\n\u001b[31msrc/App.tsx(12,4): error TS2322: Type 'private user input' is not assignable token=sk-private https://secret.test\u001b[0m\n/workspace/site/src/App.tsx:7:3: ERROR: Unexpected token\n" + "noise\n".repeat(10_000);
    const result = helpers().diagnosticsFromLogs(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("src/App.tsx(12,4): error TS2322");
    expect(result[1]).toContain("src/App.tsx:7:3");
    expect(result.join("\n")).not.toMatch(/private|https:|\u001b|\/workspace/);
    expect(result.join("\n").length).toBeLessThanOrEqual(2400);
  });

  it("diagnóstico ausente não vira defeito de fonte", async () => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    const h = helpers({ spawn: () => { queueMicrotask(() => child.emit("close", 1, null)); return child; } });
    await expect(h.command(["tsc"])).rejects.toMatchObject({ failure_kind: "infrastructure" });
  });

  it("saída não zero com diagnóstico TS é source", async () => {
    const child = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr, kill: () => true });
    const h = helpers({ spawn: () => { queueMicrotask(() => { stderr.emit("data", Buffer.from("src/App.tsx(1,1): error TS1005: Missing semicolon")); child.emit("close", 2, null); }); return child; } });
    await expect(h.command(["tsc"])).rejects.toMatchObject({ failure_kind: "source", stage: "typecheck" });
  });

  it("deadline compartilhado mata compilador pendurado com SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter(), kill = vi.fn();
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill });
    const result = helpers({ deadline: Date.now() + 100, spawn: () => child }).command(["tsc"]);
    const assertion = expect(result).rejects.toMatchObject({ failure_kind: "timeout", stage: "typecheck" });
    await vi.advanceTimersByTimeAsync(101); await assertion;
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deadline expirado bloqueia subprocesso", () => {
    expect(() => helpers({ deadline: Date.now() - 1 }).remaining()).toThrow();
  });

  it("Vite com localização em linha separada preserva fileline", () => {
    const diagnostics = helpers().diagnosticsFromLogs("[vite:esbuild] Transform failed with 1 error:\n/workspace/site/src/App.tsx:9:4:\nERROR: Expected closing tag\nprivate full source");
    expect(diagnostics[0]).toContain("src/App.tsx:9:4");
    expect(diagnostics[0]).not.toContain("private full source");
  });

  it("React, fontes e lazy images usam esperas limitadas antes do paint", async () => {
    const page = { waitForFunction: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn()
      .mockResolvedValueOnce(1700).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(false).mockResolvedValueOnce(undefined) };
    await helpers().ready(page, 390);
    expect(page.waitForFunction).toHaveBeenCalledTimes(6);
    for (const call of page.waitForFunction.mock.calls) expect(call[2].timeout).toBeLessThanOrEqual(3000);
    expect(page.evaluate.mock.calls.map((call) => call[1])).toEqual([undefined, 0, 800, 1600, 0, undefined, undefined]);
  });

  it("imagem quebrada é source; imagem pendente não autoriza screenshot", async () => {
    const errors: string[] = [];
    const page = { waitForFunction: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn()
      .mockResolvedValueOnce(10).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(true).mockResolvedValueOnce(undefined) };
    await helpers({ errors }).ready(page, 390);
    expect(errors).toEqual(["390px: Imagem quebrada."]);
    page.waitForFunction.mockRejectedValueOnce(Object.assign(new Error("pending"), { name: "TimeoutError" }));
    await expect(helpers().ready(page, 390)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
