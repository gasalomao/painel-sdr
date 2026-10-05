import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const state = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn(), project: vi.fn(), settings: vi.fn(), chat: vi.fn(), models: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: null, supabaseAdmin: null }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: null }));
vi.mock("@/lib/sites/server", async (original) => ({ ...await original<typeof import("@/lib/sites/server")>(), requireSitesContext: state.auth, requireSitesProject: state.project }));
vi.mock("@/lib/sites/prompts", () => ({ getWebsiteSettings: state.settings }));
vi.mock("@/lib/openrouter-model-discovery", () => ({ listAvailableOpenRouterModels: state.models }));
vi.mock("@/lib/ai-provider", async (original) => ({ ...await original<typeof import("@/lib/ai-provider")>(), openRouterChatWithFailover: state.chat }));
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: state.log }));
import { POST } from "./route";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const model = { id: "test/image", supportsTools: false, outputModalities: ["image"], contextLength: 128000 };
const image = "data:image/png;base64,aGVsbG8=";
const settings = { image_generation_enabled: true, max_images_per_day: 8, max_tokens_per_month: 1_000_000, image_model: model.id, model_allowlist: [] };
function request(body: unknown = { prompt: "Padaria" }): NextRequest {
  return new NextRequest(`https://app.example.test/api/sites/${projectId}/images`, { method: "POST", headers: { "content-type": "application/json", origin: "https://app.example.test" }, body: JSON.stringify(body) });
}
const props = { params: Promise.resolve({ projectId }) };

beforeEach(() => {
  vi.resetAllMocks();
  state.auth.mockResolvedValue({ ok: true, clientId, actorId: clientId, db: { rpc: state.rpc } });
  state.project.mockResolvedValue({ id: projectId, client_id: clientId });
  state.settings.mockResolvedValue(settings);
  state.models.mockResolvedValue([model]);
  state.rpc.mockImplementation(async (_name, args) => ({ data: args.p_reservation_id, error: null }));
  state.chat.mockResolvedValue({ choices: [{ message: { images: [{ image_url: { url: image } }] } }], usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 } });
  state.log.mockResolvedValue(undefined);
});

describe("images route offline", () => {
  it("reserves tenant image/token quotas before exactly one paid attempt and settles usage", async () => {
    const response = await POST(request({ prompt: "Padaria", client_id: "foreign" }), props);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ images: [image], model: model.id });
    expect(state.project).toHaveBeenCalledWith(clientId, projectId);
    expect(state.rpc).toHaveBeenNthCalledWith(1, "website_reserve_images", expect.objectContaining({ p_client_id: clientId, p_project_id: projectId, p_reservation_id: expect.any(String), p_tokens: expect.any(Number) }));
    expect(state.rpc.mock.invocationCallOrder[0]).toBeLessThan(state.chat.mock.invocationCallOrder[0]);
    expect(state.chat).toHaveBeenCalledWith(expect.objectContaining({ model: model.id, max_tokens: 4096 }), expect.objectContaining({ maxAttempts: 1, attemptBudget: { remaining: 1 }, allowImages: true }));
    expect(state.rpc).toHaveBeenNthCalledWith(2, "website_settle_images", expect.objectContaining({ p_client_id: clientId, p_project_id: projectId, p_images: 1, p_complete: true, p_usage: expect.objectContaining({ totalTokens: 150 }) }));
    expect(state.log).toHaveBeenCalledWith(expect.objectContaining({ clientId, totalTokens: 150 }));
  });

  it.each([
    [{ message: "website_quota_exceeded" }, 429],
    [{ message: "website_forbidden" }, 403],
    [{ message: "website_not_found" }, 404],
    [{ message: "unknown" }, 503],
    [null, 503],
  ])("never calls a provider without confirmed admission (%s)", async (error, status) => {
    state.rpc.mockResolvedValue({ data: null, error });
    expect((await POST(request(), props)).status).toBe(status);
    expect(state.chat).not.toHaveBeenCalled();
    expect(state.log).not.toHaveBeenCalled();
  });

  it("denies unauthenticated requests before settings or quota work", async () => {
    state.auth.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) });
    expect((await POST(request(), props)).status).toBe(401);
    expect(state.project).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([null, {}, { prompt: " " }, { prompt: "x".repeat(4001) }])("rejects invalid input without consuming quota", async (body) => {
    expect((await POST(request(body), props)).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.chat).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON before consuming quota", async () => {
    expect((await POST(request({ prompt: "Padaria", extra: "x".repeat(70000) }), props)).status).toBe(413);
    expect(state.chat).not.toHaveBeenCalled();
  });

  it("does not charge disabled or unavailable models", async () => {
    state.settings.mockResolvedValueOnce({ ...settings, image_generation_enabled: false });
    expect((await POST(request(), props)).status).toBe(403);
    state.models.mockResolvedValueOnce([]);
    expect((await POST(request(), props)).status).toBe(503);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("retains uncertain charges after failure without retrying generation", async () => {
    state.chat.mockRejectedValueOnce(new Error("timeout"));
    expect((await POST(request(), props)).status).toBe(500);
    expect(state.chat).toHaveBeenCalledOnce();
    expect(state.rpc).toHaveBeenNthCalledWith(2, "website_settle_images", expect.objectContaining({ p_images: null, p_complete: false, p_usage: null }));
  });

  it("records billed failure usage but retains the uncertain reservation", async () => {
    state.chat.mockRejectedValueOnce(Object.assign(new Error("response lost"), { usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }));
    expect((await POST(request(), props)).status).toBe(500);
    expect(state.rpc).toHaveBeenNthCalledWith(2, "website_settle_images", expect.objectContaining({ p_complete: false, p_usage: expect.objectContaining({ totalTokens: 6 }) }));
    expect(state.log).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 6 }));
  });

  it.each([undefined, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, attempts: [{ provider: "openrouter", model: model.id, promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: true }] }])("retains tokens with absent or estimated usage", async (usage) => {
    state.chat.mockResolvedValueOnce({ choices: [{ message: { images: [{ image_url: { url: image } }] } }], usage });
    expect((await POST(request(), props)).status).toBe(200);
    expect(state.rpc).toHaveBeenNthCalledWith(2, "website_settle_images", expect.objectContaining({ p_images: 1, p_complete: false }));
  });

  it("does not return images or repeat a paid call after settlement failure", async () => {
    state.rpc.mockImplementationOnce(async (_name, args) => ({ data: args.p_reservation_id, error: null })).mockResolvedValueOnce({ data: null, error: { message: "ledger" } });
    const response = await POST(request(), props);
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("images");
    expect(state.chat).toHaveBeenCalledOnce();
  });

  it("keeps admission when the response exceeds the reserved image batch", async () => {
    state.chat.mockResolvedValueOnce({ choices: [{ message: { images: Array.from({ length: 5 }, () => ({ image_url: { url: image } })) } }] });
    expect((await POST(request(), props)).status).toBe(500);
    expect(state.rpc).toHaveBeenNthCalledWith(2, "website_settle_images", expect.objectContaining({ p_images: null }));
  });
});

describe("image quota SQL in memory", () => {
  let db: PGlite;
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const entries = Object.entries(args);
    const { rows } = await db.query<{ result: unknown }>(`SELECT public.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(",")}) AS result`, entries.map(([, value]) => value && typeof value === "object" ? JSON.stringify(value) : value));
    return rows[0].result;
  }
  async function fixture(): Promise<{ p_client_id: string; p_project_id: string; p_reservation_id: string; p_tokens: number }> {
    const client = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO clients(id,name,email,features) VALUES ($1,'Offline',$2,'{\"sites\":true}')", [client, `${client}@example.test`]);
    await db.query("INSERT INTO website_projects(id,client_id,name,slug) VALUES ($1,$2,'Offline',$3)", [project, client, `test-${project}`]);
    return { p_client_id: client, p_project_id: project, p_reservation_id: randomUUID(), p_tokens: 10000 };
  }
  beforeAll(async () => {
    db = new PGlite();
    const canonical = readFileSync(resolve("migrations/SETUP_COMPLETO.sql"), "utf8");
    for (const table of ["clients", "leads_extraidos"]) {
      const ddl = canonical.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\([\\s\\S]*?\\n\\);`))?.[0];
      if (!ddl) throw new Error("Missing canonical table");
      await db.exec(ddl);
    }
    await db.exec("CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;");
    await db.exec(readFileSync(resolve("migrations/016_website_studio.sql"), "utf8"));
  }, 60000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.exec("UPDATE website_settings SET value = value || '{\"image_generation_enabled\":true,\"max_images_per_day\":4,\"max_tokens_per_month\":1000000}' WHERE id=1");
  });

  it("admits only one concurrent batch per tenant across projects", async () => {
    const a = await fixture();
    const otherProject = randomUUID();
    await db.query("INSERT INTO website_projects(id,client_id,name,slug) VALUES ($1,$2,'Other',$3)", [otherProject, a.p_client_id, `test-${otherProject}`]);
    const b = { ...a, p_project_id: otherProject, p_reservation_id: randomUUID() };
    const first = await rpc("website_reserve_images", a);
    expect(first).toBeTypeOf("string");
    await expect(rpc("website_reserve_images", b)).rejects.toThrow("website_quota_exceeded");
    expect(first).toBeTypeOf("string");
    await expect(rpc("website_reserve_images", b)).rejects.toThrow("website_quota_exceeded");
    const usage = await db.query<{ kind: string; quantity: number }>("SELECT kind,quantity::int FROM website_usage WHERE client_id=$1 ORDER BY kind", [a.p_client_id]);
    expect(usage.rows).toEqual([{ kind: "images", quantity: 4 }, { kind: "tokens", quantity: 10000 }]);
    expect(await rpc("website_reserve_images", await fixture())).toBeTypeOf("string");
  });

  it("rolls back image admission if the monthly token quota is exhausted", async () => {
    const a = await fixture();
    await db.exec("UPDATE website_settings SET value = value || '{\"max_tokens_per_month\":9999}' WHERE id=1");
    await expect(rpc("website_reserve_images", a)).rejects.toThrow("website_quota_exceeded");
    expect((await db.query("SELECT id FROM website_usage WHERE client_id=$1", [a.p_client_id])).rows).toHaveLength(0);
  });

  it("rejects foreign projects, disabled tenants and disabled generation", async () => {
    const a = await fixture();
    const b = await fixture();
    await expect(rpc("website_reserve_images", { ...a, p_project_id: b.p_project_id })).rejects.toThrow("website_not_found");
    await db.query("UPDATE clients SET is_active=false WHERE id=$1", [a.p_client_id]);
    await expect(rpc("website_reserve_images", a)).rejects.toThrow("website_forbidden");
    await db.exec("UPDATE website_settings SET value = value || '{\"image_generation_enabled\":false}' WHERE id=1");
    await expect(rpc("website_reserve_images", b)).rejects.toThrow("website_forbidden");
  });

  it("settles known images and tokens once without cross-tenant release", async () => {
    const a = await fixture();
    await rpc("website_reserve_images", a);
    const settle = { p_client_id: a.p_client_id, p_project_id: a.p_project_id, p_reservation_id: a.p_reservation_id, p_images: 1, p_usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 }, p_model: model.id, p_complete: true };
    await expect(rpc("website_settle_images", { ...settle, p_client_id: (await fixture()).p_client_id })).rejects.toThrow("website_not_found");
    expect(await rpc("website_settle_images", settle)).toBe(a.p_reservation_id);
    expect(await rpc("website_settle_images", settle)).toBe(a.p_reservation_id);
    await expect(rpc("website_settle_images", { ...settle, p_images: 2 })).rejects.toThrow("website_idempotency_conflict");
    const usage = await db.query<{ kind: string; quantity: number }>("SELECT kind,quantity::int FROM website_usage WHERE client_id=$1 ORDER BY kind", [a.p_client_id]);
    expect(usage.rows).toEqual([{ kind: "images", quantity: 1 }, { kind: "tokens", quantity: 150 }]);
  });

  it("retains uncertain tokens across month boundaries", async () => {
    const a = await fixture();
    await rpc("website_reserve_images", a);
    await rpc("website_settle_images", { p_client_id: a.p_client_id, p_project_id: a.p_project_id, p_reservation_id: a.p_reservation_id, p_images: null, p_usage: null, p_model: model.id, p_complete: false });
    await db.query("UPDATE website_usage SET created_at=now()-interval '2 months' WHERE client_id=$1", [a.p_client_id]);
    await db.exec("UPDATE website_settings SET value = value || '{\"max_tokens_per_month\":15000}' WHERE id=1");
    await expect(rpc("website_reserve_images", { ...a, p_reservation_id: randomUUID() })).rejects.toThrow("website_quota_exceeded");
  });
});
