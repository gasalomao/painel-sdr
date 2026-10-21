import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "../route";
import { DELETE, PATCH } from "../[id]/route";
import { GET as searchLeads } from "../leads/route";
import { requireClientId } from "@/lib/tenant";

vi.mock("@/lib/tenant", () => ({ requireClientId: vi.fn() }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: (table: string) => from(table) } }));

type Row = Record<string, unknown>;
type DbError = { code: string; message: string };
const tenant = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = "2026-10-18T12:00:00.000Z";
let rows: Record<string, Row[]>;
let queries: Query[];
let failure: { table: string; operation?: string; error: DbError } | null;
let beforeWrite: (() => void) | null;

function task(overrides: Row = {}): Row {
  return { id, client_id: tenant, text: "Retornar", due_at: now, completed_at: null, lead_id: null, created_at: now, updated_at: now, ...overrides };
}

// Local Supabase boundary fake; real constraints/RLS are tested separately in PGlite.
class Query implements PromiseLike<{ data: Row[] | Row | null; count: number | null; error: DbError | null }> {
  operation = "select";
  payload: Row = {};
  fields = "";
  head = false;
  single = false;
  bounds: [number, number] | null = null;
  maximum: number | null = null;
  filters: [string, string, unknown][] = [];
  orders: [string, boolean][] = [];
  constructor(readonly table: string) { queries.push(this); }
  select(fields: string, options?: { head?: boolean; count?: string }): this { this.fields = fields; this.head = !!options?.head; return this; }
  insert(payload: Row): this { this.operation = "insert"; this.payload = payload; return this; }
  update(payload: Row): this { this.operation = "update"; this.payload = payload; return this; }
  delete(): this { this.operation = "delete"; return this; }
  eq(key: string, value: unknown): this { this.filters.push(["eq", key, value]); return this; }
  is(key: string, value: unknown): this { this.filters.push(["is", key, value]); return this; }
  not(key: string, _operator: string, value: unknown): this { this.filters.push(["not", key, value]); return this; }
  lt(key: string, value: unknown): this { this.filters.push(["lt", key, value]); return this; }
  lte(key: string, value: unknown): this { this.filters.push(["lte", key, value]); return this; }
  gt(key: string, value: unknown): this { this.filters.push(["gt", key, value]); return this; }
  gte(key: string, value: unknown): this { this.filters.push(["gte", key, value]); return this; }
  in(key: string, value: unknown[]): this { this.filters.push(["in", key, value]); return this; }
  regexIMatch(key: string, value: string): this { this.filters.push(["imatch", key, value]); return this; }
  order(key: string, options?: { ascending?: boolean }): this { this.orders.push([key, options?.ascending !== false]); return this; }
  range(start: number, end: number): this { this.bounds = [start, end]; return this; }
  limit(maximum: number): this { this.maximum = maximum; return this; }
  maybeSingle(): this { this.single = true; return this; }
  then<TResult1 = { data: Row[] | Row | null; count: number | null; error: DbError | null }, TResult2 = never>(onfulfilled?: ((value: { data: Row[] | Row | null; count: number | null; error: DbError | null }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    const execute = () => {
      if (failure?.table === this.table && (!failure.operation || failure.operation === this.operation)) return { data: null, count: null, error: failure.error };
      if (this.operation !== "select") { beforeWrite?.(); beforeWrite = null; }
      let result = rows[this.table].filter((row) => this.filters.every(([op, key, value]) => {
        if (op === "eq" || op === "is") return row[key] === value;
        if (op === "not") return row[key] !== value;
        if (op === "in") return (value as unknown[]).includes(row[key]);
        if (op === "imatch") return new RegExp(String(value), "i").test(String(row[key]));
        const left = String(row[key]), right = String(value);
        return op === "lt" ? left < right : op === "lte" ? left <= right : op === "gt" ? left > right : left >= right;
      }));
      if (this.operation === "insert") {
        const inserted = task(this.payload);
        rows[this.table].push(inserted);
        result = [inserted];
      }
      if (this.operation === "update") result.forEach((row) => {
        const firstCompletion = row.completed_at;
        Object.assign(row, this.payload);
        // Same atomic completion guard as the independently tested SQL trigger.
        if (firstCompletion !== null && this.payload.completed_at != null) row.completed_at = firstCompletion;
        row.updated_at = new Date().toISOString();
      });
      if (this.operation === "delete") rows[this.table] = rows[this.table].filter(row => !result.includes(row));
      const count = result.length;
      result = [...result].sort((a, b) => {
        for (const [key, ascending] of this.orders) {
          const comparison = String(a[key]).localeCompare(String(b[key]));
          if (comparison) return ascending ? comparison : -comparison;
        }
        return 0;
      });
      if (this.bounds) result = result.slice(this.bounds[0], this.bounds[1] + 1);
      if (this.maximum !== null) result = result.slice(0, this.maximum);
      return { data: this.head ? null : this.single ? result[0] ?? null : result.map((row) => ({ ...row })), count, error: null };
    };
    return Promise.resolve().then(execute).then(onfulfilled, onrejected);
  }
}
function from(table: string): Query { return new Query(table); }
function request(path = "", body?: unknown, method = "POST"): NextRequest {
  return new NextRequest(`http://localhost/api/tasks${path}`, body === undefined ? undefined : { method, body: JSON.stringify(body) });
}
function patch(body: unknown, taskId = id): Promise<NextResponse> {
  return PATCH(request(`/${taskId}`, body, "PATCH"), { params: Promise.resolve({ id: taskId }) });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  rows = { dashboard_tasks: [], leads_extraidos: [] };
  queries = [];
  failure = null;
  beforeWrite = null;
  vi.mocked(requireClientId).mockResolvedValue({ ok: true, clientId: tenant, isAdmin: true, impersonating: false, claims: { clientId: tenant } as never });
});
afterEach(() => vi.useRealTimers());

describe("tasks authentication and validation", () => {
  it("requires session for every endpoint before reading the database", async () => {
    vi.mocked(requireClientId).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }) });
    for (const response of await Promise.all([GET(request()), POST(request("", {})), patch({ completed: true }), searchLeads(request("/leads?q=x"))])) expect(response.status).toBe(401);
    expect(queries).toHaveLength(0);
  });
  it("rejects malformed JSON, unknown keys, invalid ids and pagination before querying", async () => {
    const badJson = new NextRequest("http://localhost/api/tasks", { method: "POST", body: "{" });
    for (const response of await Promise.all([
      POST(badJson), POST(request("", { text: "x", due_at: now, client_id: other })),
      patch({ completed_at: now }), patch({ completed: true }, "not-a-uuid"),
      GET(request("?page=-1")), GET(request("?limit=500")), GET(request("?status=all")),
    ])) expect(response.status).toBe(400);
    expect(queries).toHaveLength(0);
  });
});

describe("tasks list", () => {
  it("paginates pending tasks and computes global, nonoverlapping counts with head queries", async () => {
    rows.dashboard_tasks = [
      task({ id: "01", due_at: "2026-10-18T11:59:59.999Z", lead_id: 1 }),
      task({ id: "03", due_at: now }), task({ id: "02", due_at: now, lead_id: 2 }),
      task({ id: "04", due_at: "2026-10-18T12:30:00.000Z" }),
      task({ id: "05", due_at: "2026-10-18T12:30:00.001Z" }),
      task({ id: "06", due_at: "2026-10-19T12:00:00.000Z" }),
      task({ id: "07", due_at: "2026-10-19T12:00:00.001Z" }),
      task({ id: "08", completed_at: now }), task({ client_id: other }),
    ];
    rows.leads_extraidos = [{ id: 1, client_id: tenant, nome_negocio: "Local" }, { id: 2, client_id: other, nome_negocio: "Segredo" }];
    const response = await GET(request("?page=1&limit=2"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(7);
    expect(body.tasks.map((row: Row) => row.id)).toEqual(["03", "04"]);
    expect(body.counts).toEqual({ pending: 7, overdue: 1, dueSoon: 3, upcoming: 2, completed: 1 });
    expect(queries.filter((q) => q.table === "dashboard_tasks" && q.head)).toHaveLength(5);
    expect(queries.filter((q) => q.table === "dashboard_tasks" && !q.head).every((q) => q.bounds !== null)).toBe(true);
    expect(queries.every((q) => q.filters.some(([op, key, value]) => op === "eq" && key === "client_id" && value === tenant))).toBe(true);
  });
  it("resolves names in a single scoped IN query and never joins foreign tenant leads", async () => {
    rows.dashboard_tasks = [task({ lead_id: 2 }), task({ id: "second", lead_id: 1 })];
    rows.leads_extraidos = [{ id: 1, client_id: tenant, nome_negocio: "Local" }, { id: 2, client_id: other, nome_negocio: "Segredo" }];
    const body = await (await GET(request())).json();
    expect(body.tasks.map((row: Row) => row.lead_name)).toEqual([null, "Local"]);
    expect(queries.filter((q) => q.table === "leads_extraidos")).toHaveLength(1);
    expect(queries.find((q) => q.table === "leads_extraidos")?.filters).toContainEqual(["in", "id", [2, 1]]);
    expect(queries.every((q) => !q.fields.includes("("))).toBe(true);
    expect(body.tasks[0]).not.toHaveProperty("client_id");
  });
  it("orders completed history by completion descending and id as tie-breaker", async () => {
    rows.dashboard_tasks = [task({ id: "b", completed_at: now }), task({ id: "a", completed_at: now }), task({ id: "z", completed_at: "2026-10-17T10:00:00Z" }), task()];
    const body = await (await GET(request("?status=completed&limit=2"))).json();
    expect(body.tasks.map((row: Row) => row.id)).toEqual(["a", "b"]);
    expect(body.total).toBe(3);
    const empty = await (await GET(request("?page=99"))).json();
    expect(empty.tasks).toEqual([]);
    expect(empty.counts.pending).toBe(1);
  });
});

describe("tasks mutations", () => {
  it("persists a trimmed free task in session tenant and allows several tasks per lead", async () => {
    const response = await POST(request("", { text: "  Teste  ", due_at: "2026-10-18T10:00:00-03:00" }));
    expect(response.status).toBe(201);
    expect((await response.json()).task).toMatchObject({ text: "Teste", due_at: "2026-10-18T13:00:00.000Z", lead_name: null });
    expect(rows.dashboard_tasks[0].client_id).toBe(tenant);
    rows.leads_extraidos = [{ id: 1, client_id: tenant, nome_negocio: "Local" }];
    for (let i = 0; i < 2; i++) {
      const response = await POST(request("", { text: "Lead", due_at: now, lead_id: 1 }));
      expect(response.status).toBe(201);
      expect((await response.json()).task.lead_name).toBe("Local");
    }
    expect(rows.dashboard_tasks).toHaveLength(3);
  });
  it("rejects foreign or missing leads on create and update, including admin", async () => {
    rows.dashboard_tasks = [task()];
    rows.leads_extraidos = [{ id: 2, client_id: other, nome_negocio: "Segredo" }];
    for (const lead_id of [2, 999]) {
      expect((await POST(request("", { text: "Lead", due_at: now, lead_id }))).status).toBe(404);
      expect((await patch({ lead_id })).status).toBe(404);
    }
    expect(rows.dashboard_tasks).toEqual([task()]);
    expect(queries.some((q) => q.operation === "update" || q.operation === "insert")).toBe(false);
  });
  it("edits/reopens tasks and completion is idempotent", async () => {
    rows.dashboard_tasks = [task()];
    expect((await patch({ text: "  Editada  ", due_at: "2026-11-18T09:30:00-03:00", completed: true })).status).toBe(200);
    expect(rows.dashboard_tasks[0]).toMatchObject({ text: "Editada", due_at: "2026-11-18T12:30:00.000Z", completed_at: now });
    vi.setSystemTime(new Date("2026-10-18T13:00:00.000Z"));
    const response = await patch({ completed: true, text: "Mantém conclusão" });
    expect(response.status).toBe(200);
    expect((await response.json()).task).toMatchObject({ text: "Mantém conclusão", completed_at: now });
    expect((await patch({ completed: false, lead_id: null })).status).toBe(200);
    expect(rows.dashboard_tasks[0].completed_at).toBeNull();
  });
  it("does not restore a stale completion after a concurrent reopen and recompletion", async () => {
    rows.dashboard_tasks = [task({ completed_at: "2026-10-17T10:00:00.000Z" })];
    beforeWrite = () => { rows.dashboard_tasks[0].completed_at = null; };
    const response = await patch({ completed: true });
    expect(response.status).toBe(200);
    expect((await response.json()).task.completed_at).toBe(now);
  });
  it("returns confirmed writes even if the optional lead-name lookup fails afterward", async () => {
    rows.leads_extraidos = [{ id: 1, client_id: tenant, nome_negocio: "Local" }];
    beforeWrite = () => { failure = { table: "leads_extraidos", error: { code: "08006", message: "Falha no nome do lead" } }; };
    const created = await POST(request("", { text: "Persistida", due_at: now, lead_id: 1 }));
    expect(created.status).toBe(201);
    expect((await created.json()).task).toMatchObject({ text: "Persistida", lead_id: 1 });
    expect(rows.dashboard_tasks).toHaveLength(1);
    const updated = await patch({ completed: true });
    expect(updated.status).toBe(200);
    expect((await updated.json()).task).toMatchObject({ completed_at: now, lead_name: null });
  });
  it("returns 404 when the authorized row disappears before the write", async () => {
    rows.dashboard_tasks = [task()];
    beforeWrite = () => { rows.dashboard_tasks = []; };
    expect((await patch({ completed: true })).status).toBe(404);
  });
  it("returns 404 for absent or foreign tasks and never writes another tenant", async () => {
    rows.dashboard_tasks = [task({ client_id: other })];
    expect((await patch({ text: "Invadida" })).status).toBe(404);
    expect((await patch({ completed: true })).status).toBe(404);
    expect(rows.dashboard_tasks[0].text).toBe("Retornar");
    expect(queries.filter((q) => q.table === "dashboard_tasks").every((q) => q.filters.some(([, key, value]) => key === "client_id" && value === tenant))).toBe(true);
  });
});

describe("tasks deletion", () => {
  function remove(taskId = id): Promise<NextResponse> {
    return DELETE(new NextRequest(`http://localhost/api/tasks/${taskId}`, { method: "DELETE" }), { params: Promise.resolve({ id: taskId }) });
  }

  it("requires authentication and a valid UUID before touching data", async () => {
    expect((await remove("invalid-id")).status).toBe(400);
    expect(queries).toHaveLength(0);
    vi.mocked(requireClientId).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }) });
    expect((await remove()).status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it.each([null, now])("deletes only the requested tenant task (completed_at=%s), never its lead", async completed_at => {
    rows.dashboard_tasks = [task({ completed_at, lead_id: 1 }), task({ client_id: other }), task({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })];
    rows.leads_extraidos = [{ id: 1, client_id: tenant, nome_negocio: "Preservar lead" }];
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id });
    expect(rows.dashboard_tasks).toHaveLength(2);
    expect(rows.dashboard_tasks.some(row => row.id === id && row.client_id === tenant)).toBe(false);
    expect(rows.dashboard_tasks.some(row => row.client_id === other)).toBe(true);
    expect(rows.leads_extraidos).toEqual([{ id: 1, client_id: tenant, nome_negocio: "Preservar lead" }]);
    expect(queries).toHaveLength(1);
    expect(queries[0].filters).toContainEqual(["eq", "client_id", tenant]);
    expect(queries[0].filters).toContainEqual(["eq", "id", id]);
  });

  it("returns explicit 404 for missing, foreign or concurrently removed tasks", async () => {
    for (const existing of [[], [task({ client_id: other })]]) {
      rows.dashboard_tasks = existing;
      const response = await remove();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Tarefa não encontrada" });
      expect(rows.dashboard_tasks).toEqual(existing);
    }
    rows.dashboard_tasks = [task()];
    beforeWrite = () => { rows.dashboard_tasks = []; };
    expect((await remove()).status).toBe(404);
  });

  it("preserves data and reports database failures, including missing setup", async () => {
    rows.dashboard_tasks = [task()];
    failure = { table: "dashboard_tasks", operation: "delete", error: { code: "08006", message: "Falha ao excluir" } };
    const response = await remove();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Falha ao excluir" });
    expect(rows.dashboard_tasks).toEqual([task()]);
    failure.error = { code: "42P01", message: 'relation "public.dashboard_tasks" does not exist' };
    const missing = await remove();
    expect(missing.status).toBe(503);
    expect((await missing.json()).code).toBe("TASKS_SETUP_REQUIRED");
  });
});

describe("tasks database failures", () => {
  it("reports missing task schema on read/write, never as empty success", async () => {
    failure = { table: "dashboard_tasks", error: { code: "42P01", message: 'relation "public.dashboard_tasks" does not exist' } };
    for (const response of await Promise.all([GET(request()), POST(request("", { text: "x", due_at: now })), patch({ completed: true })])) {
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("TASKS_SETUP_REQUIRED");
    }
  });
  it("reports write failures without claiming success", async () => {
    rows.dashboard_tasks = [task()];
    failure = { table: "dashboard_tasks", operation: "update", error: { code: "08006", message: "Falha ao gravar" } };
    const response = await patch({ completed: true });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Falha ao gravar" });
    expect(rows.dashboard_tasks[0].completed_at).toBeNull();
  });
  it("does not mask unrelated read/write errors or lead lookup failures", async () => {
    failure = { table: "dashboard_tasks", error: { code: "08006", message: "Banco indisponível" } };
    expect((await GET(request())).status).toBe(500);
    expect((await POST(request("", { text: "x", due_at: now }))).status).toBe(500);
    expect((await patch({ text: "x" })).status).toBe(500);
    rows.dashboard_tasks = [task({ lead_id: 1 })];
    failure = { table: "leads_extraidos", error: { code: "42P01", message: 'relation "leads_extraidos" does not exist' } };
    expect((await GET(request())).status).toBe(500);
    expect((await POST(request("", { text: "x", due_at: now, lead_id: 1 }))).status).toBe(500);
    expect((await searchLeads(request("/leads?q=x"))).status).toBe(500);
  });
});

describe("task lead search", () => {
  it("bounds the tenant-only search to 20 and escapes wildcard characters", async () => {
    rows.leads_extraidos = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, client_id: tenant, nome_negocio: "100%_\\Local" }));
    rows.leads_extraidos.push({ id: 99, client_id: other, nome_negocio: "100%_\\Segredo" });
    const response = await searchLeads(request(`/leads?q=${encodeURIComponent("100%_\\")}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.leads).toHaveLength(20);
    expect(body.leads[0]).toEqual({ id: 1, nome_negocio: "100%_\\Local" });
    expect(queries[0].maximum).toBe(20);
    expect(queries[0].filters).toContainEqual(["imatch", "nome_negocio", "100%_\\\\"]);
    expect(queries[0].filters).toContainEqual(["eq", "client_id", tenant]);
  });
  it("treats the PostgREST star alias and regex punctuation as literal search text", async () => {
    rows.leads_extraidos = [
      { id: 1, client_id: tenant, nome_negocio: "Loja * [matriz]." },
      { id: 2, client_id: tenant, nome_negocio: "Outra loja" },
    ];
    expect(await (await searchLeads(request(`/leads?q=${encodeURIComponent("* [matriz].")}`))).json()).toEqual({ leads: [{ id: 1, nome_negocio: "Loja * [matriz]." }] });
  });
  it("does not query blank input and rejects overlong search", async () => {
    expect(await (await searchLeads(request("/leads?q=%20"))).json()).toEqual({ leads: [] });
    expect((await searchLeads(request(`/leads?q=${"x".repeat(101)}`))).status).toBe(400);
    expect(queries).toHaveLength(0);
  });
});
