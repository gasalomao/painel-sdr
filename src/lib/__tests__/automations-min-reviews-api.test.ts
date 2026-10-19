import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { isDeepStrictEqual } from "node:util";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  isInstanceOwnedByClient: vi.fn(),
  enforceClientDefaultModel: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  owner: { client_id: "tenant-A" } as { client_id: string } | null,
  filters: {} as Record<string, unknown> | null,
  automation: {} as Record<string, unknown>,
  beforeWrite: null as (() => void) | null,
  filterReadError: null as { message: string } | null,
  writeError: null as { message: string } | null,
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
  isInstanceOwnedByClient: mocks.isInstanceOwnedByClient,
}));
vi.mock("@/lib/enforce-model", () => ({ enforceClientDefaultModel: mocks.enforceClientDefaultModel }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));

import { GET as LIST, POST } from "@/app/api/automations/route";
import { GET, PATCH } from "@/app/api/automations/[id]/route";

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
    mocks.automation = {
      id: "automation-A", status: "draft", scraped_count: 0,
      updated_at: "2026-10-19T10:00:00.001Z", name: "Teste", dispatch_template: "Olá",
      dispatch_personalize: false, dispatch_min_interval: 60, dispatch_media_url: null,
      followup_steps: [{ day_offset: 2, template: "Retorno" }],
      niches: ["Dentistas"], regions: ["Vitória/ES"], scrape_max_leads: 200,
    };
    mocks.beforeWrite = null;
    mocks.filterReadError = null;
    mocks.writeError = null;
    mocks.requireClientId.mockResolvedValue({ ok: true, clientId: "tenant-A", isAdmin: false });
    mocks.isInstanceOwnedByClient.mockResolvedValue(true);
    mocks.enforceClientDefaultModel.mockResolvedValue(undefined);
    mocks.from.mockImplementation(() => {
      let selection = "";
      let patch: Record<string, unknown> | null = null;
      const predicates: Array<[string, unknown]> = [];
      const current = () => ({ ...mocks.automation, ...mocks.owner, scrape_filters: mocks.filters });
      const execute = async () => {
        if (patch) {
          mocks.beforeWrite?.();
          if (mocks.writeError) return { data: null, error: mocks.writeError };
        } else if (mocks.filterReadError && selection !== "client_id") {
          return { data: null, error: mocks.filterReadError };
        }
        const row = current();
        const matches = mocks.owner && predicates.every(([key, value]) => {
          const actual = row[key as keyof typeof row] ?? null;
          const expected = typeof actual === "object" && actual !== null && typeof value === "string" ? JSON.parse(value) : value;
          return isDeepStrictEqual(actual, expected);
        });
        if (!matches) return { data: null, error: null };
        if (patch) {
          if ("scrape_filters" in patch) mocks.filters = patch.scrape_filters as Record<string, unknown> | null;
          Object.assign(mocks.automation, patch);
        }
        return { data: structuredClone(current()), error: null };
      };
      const query = {
        select: vi.fn((columns = "*") => { selection = columns; return query; }),
        eq: (key: string, value: unknown) => { mocks.eq(key, value); predicates.push([key, value]); return query; },
        is: (key: string, value: unknown) => { predicates.push([key, value]); return query; },
        order: () => query,
        filter: () => query,
        maybeSingle: execute,
        insert: (value: Record<string, unknown>) => { mocks.insert(value); return query; },
        update: (value: Record<string, unknown>) => { mocks.update(value); patch = value; return query; },
        single: vi.fn(async () => ({ data: { id: "automation-A" }, error: null })),
        then: <T>(resolve: (value: Awaited<ReturnType<typeof execute>>) => T) => execute().then(resolve),
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
    const response = await PATCH(request({ scrape_filters: { minReviews: 50 } }, "PATCH"), context);

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
    const response = await PATCH(request({ scrape_filters: { filterWithInstagram } }, "PATCH"), context);

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

  it.each([null, [], true, "configuração"].map(body => ({ body })))("POST e PATCH rejeitam corpo malformado: $body", async ({ body }) => {
    expect((await POST(request(body))).status).toBe(400);
    expect((await PATCH(request(body, "PATCH"), context)).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 5001, 10001, "20", "", null, true, [], {}].map(scrape_max_leads => ({ scrape_max_leads })))
    ("POST e PATCH rejeitam meta inválida: $scrape_max_leads", async ({ scrape_max_leads }) => {
      expect((await create({ scrape_max_leads })).status).toBe(400);
      expect((await PATCH(request({ scrape_max_leads }, "PATCH"), context)).status).toBe(400);
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    });

  it.each([1, 200, 5000])("POST e PATCH aceitam meta inteira no limite da UI: %s", async scrape_max_leads => {
    expect((await create({ scrape_max_leads })).status).toBe(200);
    expect((await PATCH(request({ scrape_max_leads }, "PATCH"), context)).status).toBe(200);
    expect(mocks.automation.scrape_max_leads).toBe(scrape_max_leads);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ scrape_max_leads }));
  });

  it.each([
    { _capturedLeadIds: [1, 2] }, { _captureSessionId: "injetado" },
    { _captureAttemptId: "injetado" }, { _baselineMaxId: 1 },
    { _lastProgressAt: "injetado" }, { _futureRuntime: null },
    { _source: "sites" }, { _source: "outro" }, { _source: null },
  ])("POST e PATCH rejeitam marcadores reservados: %j", async scrape_filters => {
    expect((await create({ scrape_filters })).status).toBe(400);
    expect((await PATCH(request({ scrape_filters }, "PATCH"), context)).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("PATCH aceita a origem real da UI sem sobrescrever outros marcadores", async () => {
    mocks.filters = { _source: "prospeccao-sites", _futureRuntime: { cursor: 4 }, minReviews: 10 };
    const response = await PATCH(request({ scrape_filters: { _source: "prospeccao-sites", minReviews: 20 } }, "PATCH"), context);

    expect(response.status).toBe(200);
    expect(mocks.filters).toEqual({ _source: "prospeccao-sites", _futureRuntime: { cursor: 4 }, minReviews: 20 });
  });

  it.each([{ name: "Novo nome" }, { dispatch_template: "Nova mensagem" }, { scrape_filters: { minReviews: 10 } }])
    ("PATCH bloqueia configuração de automação em execução: %j", async body => {
      mocks.automation.status = "running";
      expect((await PATCH(request(body, "PATCH"), context)).status).toBe(409);
      expect(mocks.update).not.toHaveBeenCalled();
    });

  it.each(["paused", "error", "done"])("PATCH bloqueia nova audiência após progresso em %s", async status => {
    mocks.automation.status = status;
    mocks.automation.scraped_count = 13;
    for (const body of [
      { niches: ["Padarias"] }, { regions: ["Serra/ES"] }, { scrape_max_leads: 100 },
      { scrape_filters: { minReviews: 25 } }, { scrape_filters: { filterWithWebsite: true } },
      { scrape_filters: { future: { enabled: true } } },
    ]) {
      expect((await PATCH(request(body, "PATCH"), context)).status).toBe(409);
    }
    expect(mocks.automation.scraped_count).toBe(13);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("PATCH bloqueia configuração desde a criação da sessão, mesmo sem leads", async () => {
    mocks.filters = { _captureSessionId: "sessao-A" };
    expect((await PATCH(request({ regions: ["Serra/ES"] }, "PATCH"), context)).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("PATCH permite editar disparo e reenviar configuração idêntica de uma captura pausada", async () => {
    mocks.automation.status = "paused";
    mocks.automation.scraped_count = 13;
    mocks.filters = { _captureSessionId: "sessao-A", _capturedLeadIds: [1, 2], _source: "prospeccao-sites", minReviews: 25, future: { a: 1, b: 2 } };
    const body = {
      name: "Novo nome", dispatch_template: "Nova mensagem", niches: ["Dentistas"],
      regions: ["Vitória/ES"], scrape_max_leads: 200,
      scrape_filters: { minReviews: 25, _source: "prospeccao-sites", future: { b: 2, a: 1 } },
    };
    expect((await PATCH(request(body, "PATCH"), context)).status).toBe(200);
    expect(mocks.automation.dispatch_template).toBe("Nova mensagem");
    expect(mocks.filters?._captureSessionId).toBe("sessao-A");
    expect(mocks.filters?._capturedLeadIds).toEqual([1, 2]);
    expect(mocks.automation.scraped_count).toBe(13);
  });

  it.each(["status", "filters", "count"])("PATCH retorna conflito sem perder alteração concorrente de %s", async changed => {
    mocks.filters = { minReviews: 25, _baselineMaxId: 400 };
    mocks.beforeWrite = () => {
      if (changed === "status") mocks.automation.status = "running";
      if (changed === "filters") mocks.filters = { ...mocks.filters, _capturedLeadIds: [99] };
      if (changed === "count") mocks.automation.scraped_count = 1;
    };
    const response = await PATCH(request({ scrape_filters: { minReviews: 50 } }, "PATCH"), context);

    expect(response.status).toBe(409);
    expect(mocks.filters?.minReviews).toBe(25);
    if (changed === "status") expect(mocks.automation.status).toBe("running");
    if (changed === "filters") expect(mocks.filters?._capturedLeadIds).toEqual([99]);
    if (changed === "count") expect(mocks.automation.scraped_count).toBe(1);
  });

  it.each([
    { field: "scrape_max_leads", concurrent: 40, requested: 30 },
    { field: "niches", concurrent: ["Padarias"], requested: ["Farmácias"] },
    { field: "regions", concurrent: ["Serra/ES"], requested: ["Vila Velha/ES"] },
    { field: "dispatch_template", concurrent: "Mensagem concorrente", requested: "Nova mensagem" },
    { field: "dispatch_min_interval", concurrent: 120, requested: 90 },
    { field: "dispatch_personalize", concurrent: true, requested: false },
    { field: "dispatch_media_url", concurrent: "https://example.test/concorrente.png", requested: null },
    { field: "followup_steps", concurrent: [{ day_offset: 3, template: "Concorrente" }], requested: [{ day_offset: 4, template: "Novo" }] },
  ])("PATCH não sobrescreve $field concorrente mesmo com updated_at idêntico", async ({ field, concurrent, requested }) => {
    const updatedAt = mocks.automation.updated_at;
    mocks.beforeWrite = () => { mocks.automation[field] = concurrent; };

    expect((await PATCH(request({ [field]: requested }, "PATCH"), context)).status).toBe(409);
    expect(mocks.automation[field]).toEqual(concurrent);
    expect(mocks.automation.updated_at).toBe(updatedAt);
  });

  it("PATCH mantém conflito para filtros públicos concorrentes", async () => {
    mocks.filters = { minReviews: 10 };
    mocks.beforeWrite = () => { mocks.filters = { minReviews: 40 }; };

    expect((await PATCH(request({ scrape_filters: { minReviews: 30 } }, "PATCH"), context)).status).toBe(409);
    expect(mocks.filters).toEqual({ minReviews: 40 });
  });

  it("PATCH usa updated_at como proteção adicional para edição concorrente", async () => {
    mocks.beforeWrite = () => { mocks.automation.updated_at = "2026-10-19T10:00:00.002Z"; };

    expect((await PATCH(request({ name: "Novo nome" }, "PATCH"), context)).status).toBe(409);
    expect(mocks.automation.name).toBe("Teste");
    expect(mocks.automation.updated_at).toBe("2026-10-19T10:00:00.002Z");
  });

  it.each([
    { field: "dispatch_media_url", requested: "https://example.test/novo.png" },
    { field: "followup_steps", requested: [{ day_offset: 4, template: "Novo" }] },
    { field: "niches", requested: ["Farmácias"] },
  ])("PATCH grava $field sem conflito quando o snapshot segue atual", async ({ field, requested }) => {
    expect((await PATCH(request({ [field]: requested }, "PATCH"), context)).status).toBe(200);
    expect(mocks.automation[field]).toEqual(requested);
  });

  it("PATCH suporta scrape_filters nulo legado sem perder a edição", async () => {
    mocks.filters = null;
    expect((await PATCH(request({ scrape_filters: { minReviews: 10 } }, "PATCH"), context)).status).toBe(200);
    expect(mocks.filters).toEqual({ minReviews: 10 });
  });

  it("PATCH não reporta sucesso se a escrita falhar", async () => {
    mocks.writeError = { message: "Falha de escrita" };
    expect((await PATCH(request({ name: "Novo nome" }, "PATCH"), context)).status).toBe(500);
    expect(mocks.automation.name).toBe("Teste");
  });

  it("PATCH verifica a instância do proprietário mesmo para admin", async () => {
    mocks.requireClientId.mockResolvedValue({ ok: true, clientId: "admin", isAdmin: true });
    mocks.owner = { client_id: "tenant-B" };
    mocks.isInstanceOwnedByClient.mockResolvedValue(false);

    expect((await PATCH(request({ instance_name: "whatsapp-C" }, "PATCH"), context)).status).toBe(403);
    expect(mocks.isInstanceOwnedByClient).toHaveBeenCalledWith("whatsapp-C", "tenant-B");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("GET legado expõe marcadores sem validar nem modificar a captura", async () => {
    mocks.automation.status = "running";
    mocks.filters = { _source: "origem-legada", _captureSessionId: "sessao-A", _capturedLeadIds: [1] };
    const req = new NextRequest("http://localhost/api/automations?source=prospeccao-sites");
    const response = await GET(req, context);

    expect(response.status).toBe(200);
    expect((await response.json()).automation.scrape_filters).toEqual(mocks.filters);
    expect((await LIST(req)).status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("GET não permite ler outra empresa", async () => {
    mocks.owner = { client_id: "tenant-B" };
    expect((await GET(new NextRequest("http://localhost/api/automations/automation-A"), context)).status).toBe(404);
  });

  it("mantém autenticação antes de validar os filtros", async () => {
    mocks.requireClientId.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) });

    expect((await create({ scrape_filters: { minReviews: -1 } })).status).toBe(401);
    expect((await PATCH(request({ scrape_filters: { minReviews: -1 } }, "PATCH"), context)).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
