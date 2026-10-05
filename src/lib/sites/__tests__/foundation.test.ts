import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  enabled: true,
  rows: {} as Record<string, Record<string, unknown>[]>,
  queries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
  rpc: vi.fn(),
  auth: vi.fn(),
  dbError: false,
}));

vi.mock("@/lib/tenant", () => ({ requireClientId: state.auth }));
vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    if (!state.enabled) return null;
    return {
      rpc: state.rpc,
      from(table: string) {
        const filters: Record<string, unknown> = {};
        state.queries.push({ table, filters });
        let single = false;
        const query = {
          select: () => query,
          eq: (key: string, value: unknown) => { filters[key] = value; return query; },
          is: (key: string, value: unknown) => { filters[key] = value; return query; },
          in: (key: string, value: unknown) => { filters[key] = value; return query; },
          order: () => query,
          limit: () => query,
          range: () => query,
          ilike: () => query,
          maybeSingle: () => { single = true; return query; },
          then(resolve: (value: unknown) => unknown) {
            const rows = (state.rows[table] ?? []).filter((row) => Object.entries(filters).every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
            return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: state.dbError ? { message: "private database detail" } : null }).then(resolve);
          },
        };
        return query;
      },
    };
  },
}));
import { readSitesBody, requireSitesContext, requireSitesProject, sitesErrorResponse } from "../server";
import { createProject, getFiles, queueRun, saveRevision } from "../repository";
import { getStarterFiles } from "../starter";
import { POST as createRoute } from "@/app/api/sites/route";
import { POST as runRoute } from "@/app/api/sites/[projectId]/runs/route";

const A = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-0000-0000-000000000002";
const PROJECT = "00000000-0000-0000-0000-000000000010";
const REVISION = "00000000-0000-0000-0000-000000000011";
const ASSET = "00000000-0000-0000-0000-000000000012";

function request(method = "GET", body?: unknown, origin = "https://studio.test"): NextRequest {
  return new NextRequest("https://studio.test/api/sites", {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  state.enabled = true;
  state.dbError = false;
  state.queries = [];
  state.rows = {
    clients: [{ id: A, is_active: true, is_admin: false, features: { sites: true } }],
    website_projects: [{ id: PROJECT, client_id: A, current_revision_id: REVISION, deleted_at: null }],
    website_revisions: [{ id: REVISION, client_id: A, project_id: PROJECT, files: { "src/App.tsx": "safe" } }],
  };
  state.auth.mockResolvedValue({ ok: true, clientId: A, isAdmin: false, impersonating: false, claims: { actorId: A } });
  state.rpc.mockResolvedValue({ data: { id: REVISION }, error: null });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
});

describe("Sites foundation", () => {
  it("fails closed without a service role client", async () => {
    state.enabled = false;
    const context = await requireSitesContext(request());
    expect(context.ok).toBe(false);
    if (!context.ok) expect(context.response.status).toBe(503);
    expect(state.auth).not.toHaveBeenCalled();
  });

  it.each([
    { is_active: false, is_admin: true, features: { sites: true } },
    { is_active: true, is_admin: false, features: {} },
    { is_active: true, is_admin: false, features: { sites: "true" } },
  ])("checks current account state rather than stale claims %j", async (row) => {
    state.rows.clients = [{ id: A, ...row }];
    state.auth.mockResolvedValue({ ok: true, clientId: A, isAdmin: true, impersonating: false, claims: { actorId: A } });
    const context = await requireSitesContext(request());
    expect(context.ok).toBe(false);
    if (!context.ok) expect(context.response.status).toBe(403);
  });

  it("permits an active current admin without granting access to other tenants", async () => {
    state.rows.clients = [{ id: A, is_active: true, is_admin: true, features: {} }];
    expect(await requireSitesContext(request())).toMatchObject({ ok: true, clientId: A, isAdmin: true });
    await expect(requireSitesProject(B, PROJECT)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects revoked impersonation actors", async () => {
    state.auth.mockResolvedValue({ ok: true, clientId: A, impersonating: true, claims: { actorId: B } });
    state.rows.clients.push({ id: B, is_active: false, is_admin: true });
    expect(await requireSitesContext(request())).toMatchObject({ ok: false });
  });

  it.each(["https://evil.test", "null", ""])("rejects mutation origin %s", async (origin) => {
    const response = await createRoute(request("POST", { name: "Site" }, origin));
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("does not trust browser client_id", async () => {
    const response = await createRoute(request("POST", { name: "Site", client_id: B }));
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejects oversized chunked bodies and malformed JSON", async () => {
    await expect(readSitesBody(request("POST", { text: "x".repeat(200) }), 100)).rejects.toMatchObject({ status: 413 });
    const malformed = new NextRequest("https://studio.test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    await expect(readSitesBody(malformed)).rejects.toMatchObject({ status: 400 });
  });

  it("scopes immutable snapshot reads to both tenant and project", async () => {
    expect(await getFiles(A, PROJECT)).toEqual({ "src/App.tsx": "safe" });
    await expect(getFiles(B, PROJECT)).rejects.toMatchObject({ status: 404 });
    expect(state.queries.find((query) => query.table === "website_revisions")?.filters).toEqual({ client_id: A, project_id: PROJECT, id: REVISION });
  });

  it("does not use soft deleted projects", async () => {
    state.rows.website_projects[0].deleted_at = new Date().toISOString();
    await expect(getFiles(A, PROJECT)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects foreign leads before creating anything", async () => {
    state.rows.leads_extraidos = [{ id: 42, client_id: B, nome_negocio: "Private" }];
    await expect(createProject(A, { name: "Site", lead_id: 42 }, A)).rejects.toMatchObject({ status: 404 });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("copies only explicitly confirmed context, never a full lead", async () => {
    state.rows.leads_extraidos = [{ id: 42, client_id: A, nome_negocio: "Private", resumo_ia: "secret" }];
    await createProject(A, { name: "Site", lead_id: 42, client_context: { name: "Confirmed" } }, A);
    expect(state.rpc).toHaveBeenCalledWith("website_create_project", expect.objectContaining({ p_client_id: A, p_project: expect.objectContaining({ client_context: { name: "Confirmed" } }) }));
    await expect(createProject(A, { name: "Site", client_context: { resumo_ia: "secret" } }, A)).rejects.toMatchObject({ status: 400 });
  });

  it("persists model_mode and model_id when creating a project", async () => {
    await createProject(A, { name: "Site com Modelo", model_mode: "manual", model_id: "anthropic/claude-3.5-sonnet" }, A);
    expect(state.rpc).toHaveBeenCalledWith("website_create_project", expect.objectContaining({
      p_client_id: A,
      p_project: expect.objectContaining({
        model_mode: "manual",
        model_id: "anthropic/claude-3.5-sonnet",
      }),
    }));
  });

  it("saves a snapshot through one CAS transaction", async () => {
    const nextFiles = { ...getStarterFiles(), "src/App.tsx": "export default function App() { return <div>next</div>; }" };
    await saveRevision(A, PROJECT, nextFiles, "Edit", A, REVISION);
    expect(state.rpc).toHaveBeenCalledWith("website_save_revision", expect.objectContaining({
      p_client_id: A, p_project_id: PROJECT, p_expected_revision_id: REVISION,
      p_files: nextFiles, p_actor_id: A,
    }));
    state.rpc.mockResolvedValue({ data: null, error: { message: "website_revision_conflict" } });
    await expect(saveRevision(A, PROJECT, nextFiles, "Edit", A, REVISION)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects invalid IDs and paths before writes", async () => {
    await expect(requireSitesProject(A, "bad")).rejects.toMatchObject({ status: 400 });
    await expect(saveRevision(A, PROJECT, { "../secret": "bad" }, "Edit", A, REVISION)).rejects.toMatchObject({ status: 400 });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejects an asset from another project", async () => {
    state.rows.website_assets = [{ id: ASSET, client_id: A, project_id: B }];
    await expect(queueRun(A, PROJECT, { prompt: "Edit", asset_ids: [ASSET] }, A)).rejects.toMatchObject({ status: 404 });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("queues prompt and user message atomically without invoking AI", async () => {
    state.rpc.mockResolvedValue({ data: { id: REVISION, status: "queued" }, error: null });
    const response = await runRoute(request("POST", { prompt: "Edit" }), { params: Promise.resolve({ projectId: PROJECT }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ runs: [{ status: "queued" }] });
    expect(state.rpc).toHaveBeenCalledWith("website_queue_run", expect.objectContaining({ p_client_id: A, p_project_id: PROJECT, p_prompt: "Edit" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps quota and active run conflicts to safe errors", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "website_quota_exceeded" } });
    await expect(queueRun(A, PROJECT, { prompt: "Edit" }, A)).rejects.toMatchObject({ status: 429 });
    state.rpc.mockResolvedValue({ data: null, error: { message: "website_active_run" } });
    await expect(queueRun(A, PROJECT, { prompt: "Edit" }, A)).rejects.toMatchObject({ status: 409 });
    expect(await sitesErrorResponse(new Error("secret")).json()).toEqual({ error: "Não foi possível concluir a operação." });
  });
});
