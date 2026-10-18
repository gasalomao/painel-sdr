import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  isInstanceOwnedByClient: vi.fn(),
  enforceClientDefaultModel: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  owner: { client_id: "tenant-A" } as { client_id: string } | null,
  filters: {} as Record<string, unknown>,
  filterReadError: null as { message: string } | null,
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
  isInstanceOwnedByClient: mocks.isInstanceOwnedByClient,
}));
vi.mock("@/lib/enforce-model", () => ({ enforceClientDefaultModel: mocks.enforceClientDefaultModel }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));

import { POST } from "@/app/api/automations/route";
import { PATCH } from "@/app/api/automations/[id]/route";

const context = { params: Promise.resolve({ id: "automation-A" }) };

function request(body: unknown, method = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/automations/automation-A", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function create(body: Record<string, unknown>) {
  return POST(request({ name: "Teste", instance_name: "whatsapp-A", ...body }));
}

describe("minReviews nas APIs de automações", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owner = { client_id: "tenant-A" };
    mocks.filters = {};
    mocks.filterReadError = null;
    mocks.requireClientId.mockResolvedValue({ ok: true, clientId: "tenant-A", isAdmin: false });
    mocks.isInstanceOwnedByClient.mockResolvedValue(true);
    mocks.enforceClientDefaultModel.mockResolvedValue(undefined);
    mocks.from.mockImplementation(() => {
      let selection = "";
      const result = Promise.resolve({ error: null });
      const query = {
        select: vi.fn((columns = "*") => { selection = columns; return query; }),
        eq: mocks.eq.mockImplementation(() => query),
        maybeSingle: vi.fn(async () => ({
          data: selection === "client_id" ? mocks.owner : mocks.filterReadError ? null : { scrape_filters: mocks.filters },
          error: selection === "client_id" ? null : mocks.filterReadError,
        })),
        insert: mocks.insert.mockImplementation(() => query),
        update: mocks.update.mockImplementation(() => query),
        single: vi.fn(async () => ({ data: { id: "automation-A" }, error: null })),
        then: result.then.bind(result),
      };
      return query;
    });
  });

  it.each([0, 25, 2147483647])("POST persiste minReviews=%s e conserva configuração desconhecida", async (minReviews) => {
    const scrape_filters = { minReviews, _source: "prospeccao-sites", future: { enabled: true } };
    const response = await create({ scrape_filters, client_id: "tenant-injetado" });

    expect(response.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ client_id: "tenant-A", scrape_filters }));
    expect(mocks.isInstanceOwnedByClient).toHaveBeenCalledWith("whatsapp-A", "tenant-A");
  });

  it("POST legado continua válido sem mínimo", async () => {
    const response = await create({ scrape_filters: { filterEmpty: true } });

    expect(response.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      scrape_filters: expect.objectContaining({ filterEmpty: true }),
    }));
  });

  it.each([-1, 1.5, 2147483648, "25", "", null, true, [], {}].map(minReviews => ({ minReviews })))("POST e PATCH rejeitam minReviews inválido: $minReviews", async ({ minReviews }) => {
    const body = { scrape_filters: { minReviews } };
    const post = await create(body);
    const patch = await PATCH(request(body, "PATCH"), context);

    expect(post.status).toBe(400);
    expect(patch.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([null, [], "minReviews", 3].map(scrape_filters => ({ scrape_filters })))("rejeita scrape_filters malformado: $scrape_filters", async ({ scrape_filters }) => {
    const post = await create({ scrape_filters });
    const patch = await PATCH(request({ scrape_filters }, "PATCH"), context);

    expect(post.status).toBe(400);
    expect(patch.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("PATCH altera o mínimo preservando marcadores e campos desconhecidos existentes", async () => {
    mocks.filters = {
      minReviews: 25,
      filterEmpty: true,
      future: { enabled: true },
      _source: "prospeccao-sites",
      _baselineMaxId: 400,
      _scrapeStartedAt: "2026-10-18T09:00:00Z",
    };
    const response = await PATCH(request({ scrape_filters: { minReviews: 50, _baselineMaxId: 1 } }, "PATCH"), context);

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      scrape_filters: { ...mocks.filters, minReviews: 50 },
    }));
    expect(mocks.eq).toHaveBeenCalledWith("client_id", "tenant-A");
  });

  it("não sobrescreve filtros se a leitura dos marcadores falhar", async () => {
    mocks.filterReadError = { message: "Falha de leitura" };
    const response = await PATCH(request({ scrape_filters: { minReviews: 50 } }, "PATCH"), context);

    expect(response.status).toBe(500);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("PATCH legado sem minReviews preserva o mínimo existente", async () => {
    mocks.filters = { minReviews: 25, _baselineMaxId: 400 };
    const response = await PATCH(request({ scrape_filters: { filterEmpty: false } }, "PATCH"), context);

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      scrape_filters: { ...mocks.filters, filterEmpty: false },
    }));
  });

  it("PATCH sem scrape_filters não altera filtros", async () => {
    const response = await PATCH(request({ name: "Novo nome" }, "PATCH"), context);

    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0]).not.toHaveProperty("scrape_filters");
  });

  it("não permite PATCH de outro tenant", async () => {
    mocks.owner = null;
    const response = await PATCH(request({ scrape_filters: { minReviews: 10 } }, "PATCH"), context);

    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.eq).toHaveBeenCalledWith("client_id", "tenant-A");
  });

  it("não permite POST com instância de outro tenant", async () => {
    mocks.isInstanceOwnedByClient.mockResolvedValue(false);
    const response = await create({ scrape_filters: { minReviews: 10 } });

    expect(response.status).toBe(403);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])("POST conserva filterWithInstagram=%s junto de minReviews e marcadores", async (filterWithInstagram) => {
    const scrape_filters = {
      ...(filterWithInstagram === undefined ? {} : { filterWithInstagram }),
      minReviews: 100, filterWithWebsite: true, _source: "prospeccao-sites", future: { enabled: true },
    };
    const response = await create({ scrape_filters });

    expect(response.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ client_id: "tenant-A", scrape_filters }));
  });

  it("POST sem scrape_filters mantém configuração legada", async () => {
    const response = await create({});

    expect(response.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ scrape_filters: {} }));
  });

  it.each([null, 0, 1, "true", "false", "", [], {}].map(filterWithInstagram => ({ filterWithInstagram })))
    ("POST e PATCH rejeitam filterWithInstagram inválido: $filterWithInstagram", async ({ filterWithInstagram }) => {
      const body = { scrape_filters: { filterWithInstagram } };
      const post = await create(body);
      const patch = await PATCH(request(body, "PATCH"), context);

      expect(post.status).toBe(400);
      expect(patch.status).toBe(400);
      expect(await post.json()).toEqual({ success: false, error: "filterWithInstagram deve ser um booleano." });
      expect(await patch.json()).toEqual({ success: false, error: "filterWithInstagram deve ser um booleano." });
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    });

  it.each([false, true])("PATCH define filterWithInstagram=%s sem perder mínimo e marcadores", async filterWithInstagram => {
    mocks.filters = {
      filterWithInstagram: !filterWithInstagram, minReviews: 100, filterEmpty: true,
      future: { enabled: true }, _source: "prospeccao-sites", _baselineMaxId: 400,
      _scrapeStartedAt: "2026-10-18T09:00:00Z", _lastProgressAt: "2026-10-18T09:05:00Z",
    };
    const response = await PATCH(request({ scrape_filters: {
      filterWithInstagram, _baselineMaxId: 1, _source: "alterado", _lastProgressAt: "alterado",
    } }, "PATCH"), context);

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      scrape_filters: { ...mocks.filters, filterWithInstagram },
    }));
    expect(mocks.eq).toHaveBeenCalledWith("client_id", "tenant-A");
  });

  it.each([{}, { minReviews: 50, filterEmpty: false }])("PATCH omitindo Instagram preserva valor existente (%j)", async scrape_filters => {
    mocks.filters = { filterWithInstagram: true, minReviews: 100, _source: "prospeccao-sites", _baselineMaxId: 400 };
    const response = await PATCH(request({ scrape_filters }, "PATCH"), context);

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      scrape_filters: { ...mocks.filters, ...scrape_filters },
    }));
  });

  it("mantém autenticação antes de validar os filtros", async () => {
    mocks.requireClientId.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) });

    expect((await create({ scrape_filters: { minReviews: -1 } })).status).toBe(401);
    expect((await PATCH(request({ scrape_filters: { minReviews: -1 } }, "PATCH"), context)).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
