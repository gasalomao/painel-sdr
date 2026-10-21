// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET } from "./route";

type Contact = { id: number; client_id: string; tags?: unknown };
type Query = {
  table: string;
  columns?: string;
  filters: [string, unknown][];
  order?: [string, { ascending: boolean }];
  range?: [number, number];
};
const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ requireClientId: mocks.auth }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));

let contacts: Contact[];
let queries: Query[];
let failAt: number | null;
let failure: "returned" | "thrown" | "missing";
const req = (query = "") => new NextRequest(`http://localhost/api/contacts/tags${query}`, {
  headers: { "x-client-id": "tenant-b" },
});

beforeEach(() => {
  contacts = [];
  queries = [];
  failAt = null;
  failure = "returned";
  mocks.auth.mockResolvedValue({ ok: true, clientId: "tenant-a" });
  mocks.from.mockImplementation((table: string) => {
    const query: Query = { table, filters: [] };
    queries.push(query);
    const builder = {
      select: (columns: string) => { query.columns = columns; return builder; },
      eq: (key: string, value: unknown) => { query.filters.push([key, value]); return builder; },
      order: (key: string, options: { ascending: boolean }) => { query.order = [key, options]; return builder; },
      range: async (from: number, to: number) => {
        query.range = [from, to];
        if (from === failAt) {
          if (failure === "thrown") throw new Error("Detalhes internos do banco");
          return { data: null, error: failure === "returned" ? { message: "Detalhes internos do banco" } : null };
        }
        const rows = contacts.filter((row) => query.filters.every(([key, value]) => row[key as keyof Contact] === value));
        if (query.order?.[0] === "id") rows.sort((a, b) => query.order?.[1].ascending ? a.id - b.id : b.id - a.id);
        return { data: rows.slice(from, to + 1), error: null };
      },
    };
    return builder;
  });
});

describe("GET /api/contacts/tags", () => {
  it.each([401, 403])("encaminha autenticação %i sem acessar contatos", async (status) => {
    const response = NextResponse.json({ error: "Sessão inválida" }, { status });
    mocks.auth.mockResolvedValue({ ok: false, response });
    const request = req();
    expect(await GET(request)).toBe(response);
    expect(mocks.auth).toHaveBeenCalledWith(request);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("usa apenas a empresa autenticada, ignorando tenant de query e header", async () => {
    contacts = [
      { id: 2, client_id: "tenant-b", tags: ["Segredo de outra empresa"] },
      { id: 1, client_id: "tenant-a", tags: ["Cliente"] },
    ];
    const before = structuredClone(contacts);
    const response = await GET(req("?client_id=tenant-b&clientId=tenant-b&tenant=tenant-b"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: ["Cliente"] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(queries).toEqual([{
      table: "contacts", columns: "id,tags", filters: [["client_id", "tenant-a"]],
      order: ["id", { ascending: true }], range: [0, 499],
    }]);
    expect(contacts).toEqual(before);
  });

  it("apara, deduplica e ordena em pt-BR sem incluir tags malformadas", async () => {
    contacts = [
      { id: 1, client_id: "tenant-a", tags: [" zebra ", "Árvore", "ação", "beta", "", " \t\n", null, 12, false, {}, []] },
      { id: 2, client_id: "tenant-a", tags: ["ação", " beta ", "zebra"] },
      { id: 3, client_id: "tenant-a", tags: null },
      { id: 4, client_id: "tenant-a", tags: "não é array" },
      { id: 5, client_id: "tenant-a", tags: { tag: "ignorar" } },
      { id: 6, client_id: "tenant-a" },
      { id: 7, client_id: "tenant-a", tags: [] },
    ];
    const before = structuredClone(contacts);
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: ["ação", "Árvore", "beta", "zebra"] });
    expect(contacts).toEqual(before);
  });

  it("retorna catálogo vazio quando a empresa não tem contatos", async () => {
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: [] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("percorre mais de 500 contatos em páginas inclusivas, ordenadas e isoladas", async () => {
    contacts = Array.from({ length: 1001 }, (_, id) => ({ id, client_id: "tenant-a", tags: [`Tag ${id}`] })).reverse();
    contacts.push({ id: 1002, client_id: "tenant-b", tags: ["Segredo"] });
    const response = await GET(req());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.tags).toHaveLength(1001);
    expect(body.tags).toContain("Tag 499");
    expect(body.tags).toContain("Tag 500");
    expect(body.tags).toContain("Tag 1000");
    expect(body.tags).not.toContain("Segredo");
    expect(queries.map((query) => query.range)).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(queries.every((query) => query.table === "contacts" && query.columns === "id,tags"
      && query.filters.length === 1 && query.filters[0][0] === "client_id" && query.filters[0][1] === "tenant-a"
      && query.order?.[0] === "id" && query.order[1].ascending)).toBe(true);
  });

  it("consulta a próxima página vazia quando há exatamente 500 contatos", async () => {
    contacts = Array.from({ length: 500 }, (_, id) => ({ id, client_id: "tenant-a", tags: ["Cliente"] }));
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: ["Cliente"] });
    expect(queries.map((query) => query.range)).toEqual([[0, 499], [500, 999]]);
  });

  it.each([
    [0, "returned"], [500, "returned"], [0, "thrown"], [500, "thrown"], [0, "missing"], [500, "missing"],
  ] as const)("retorna 500 genérico sem tags parciais se página %i falhar (%s)", async (offset, mode) => {
    contacts = Array.from({ length: 501 }, (_, id) => ({ id, client_id: "tenant-a", tags: ["Parcial"] }));
    failAt = offset;
    failure = mode;
    const response = await GET(req());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Não foi possível consultar as tags." });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(queries).toHaveLength(offset === 0 ? 1 : 2);
  });
});
