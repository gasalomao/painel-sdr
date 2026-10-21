// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET, PATCH, POST } from "./route";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>, schemas: {} as Record<string, string[]>,
  queries: [] as { table: string; operation: string; fields: string; filters: [string, unknown][]; payload?: Row }[],
  failTable: "", failUpdate: false, auth: true, insertRace: false,
}));
vi.mock("@/lib/tenant", () => ({ requireClientId: async () => state.auth
  ? { ok: true, clientId: "tenant-a" }
  : { ok: false, response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }) } }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: (table: string) => {
  const query = { table, operation: "select", fields: "*", filters: [] as [string, unknown][], payload: undefined as Row | undefined };
  state.queries.push(query);
  let single = false;
  let range: [number, number] | undefined;
  const builder = {
    select: (fields = "*") => { query.fields = fields; return builder; },
    eq: (key: string, value: unknown) => { query.filters.push([key, value]); return builder; },
    order: () => builder,
    range: (from: number, to: number) => { range = [from, to]; return builder; },
    maybeSingle: () => { single = true; return builder; },
    single: () => { single = true; return builder; },
    update: (payload: Row) => { query.operation = "update"; query.payload = payload; return builder; },
    insert: (payload: Row) => { query.operation = "insert"; query.payload = payload; return builder; },
    then: (resolve: (value: unknown) => unknown) => {
      if (state.failTable === table || (state.failUpdate && query.operation === "update")) return Promise.resolve(resolve({ data: null, error: { message: "DB offline" } }));
      const fields = query.fields === "*" ? null : query.fields.split(",").map((field) => field.trim());
      const missing = fields?.find((field) => state.schemas[table] && !state.schemas[table].includes(field));
      if (missing) return Promise.resolve(resolve({ data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } }));
      const rows = state.tables[table] ?? [];
      let matches = rows.filter((row) => query.filters.every(([key, value]) => String(row[key]) === String(value)));
      if (query.operation === "insert") {
        const inserted = { id: 99, created_at: "2026-01-01", ...query.payload };
        rows.push(inserted);
        if (state.insertRace) return Promise.resolve(resolve({ data: null, error: { code: "23505" } }));
        matches = [inserted];
      }
      if (query.operation === "update") matches.forEach((row) => Object.assign(row, query.payload));
      if (range) matches = matches.slice(range[0], range[1] + 1);
      if (fields) matches = matches.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
      return Promise.resolve(resolve({ data: single ? matches[0] ?? null : matches, error: null }));
    },
  };
  return builder;
} } }));

const legacyColumnFields = ["id", "client_id", "status_key", "label", "color", "order_index", "is_system", "created_at", "updated_at"];
const contactId = "11111111-1111-4111-8111-111111111111";
const req = (method = "GET", body?: unknown, query = `contactId=${contactId}`) => new NextRequest(`http://localhost/api/contacts/crm?${query}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
});
const lead = (id = 7, client_id = "tenant-a") => ({ id, client_id, nome_negocio: "Vidraçaria Geral", telefone: "(11) 8765-4321", remoteJid: null, status: "proposta", created_at: "2026-01-01" });

beforeEach(() => {
  state.auth = true; state.failTable = ""; state.failUpdate = false; state.insertRace = false; state.queries = [];
  state.schemas = { kanban_columns: [...legacyColumnFields, "is_terminal"] };
  state.tables = {
    contacts: [{ id: contactId, client_id: "tenant-a", lead_id: 999, remote_jid: "5511987654321@s.whatsapp.net", phone_number: "5511987654321", nome_negocio: "Vidraçaria Geral" }],
    leads_extraidos: [lead(), lead(8, "tenant-b")],
    kanban_columns: [{ client_id: "tenant-a", status_key: "proposta", label: "Proposta personalizada" }, { client_id: "tenant-a", status_key: "novo", label: "Entrada" }],
  };
});

describe("/api/contacts/crm", () => {
  it.each(["GET", "POST", "PATCH"] as const)("%s funciona com funil legado sem is_terminal e mantém o tenant", async (method) => {
    state.schemas.kanban_columns = legacyColumnFields;
    state.tables.kanban_columns.push({ client_id: "tenant-b", status_key: "estrangeiro", label: "Outro funil" });
    if (method === "GET") state.tables.contacts[0].lead_id = 7;
    if (method === "POST") state.tables.leads_extraidos = [lead(8, "tenant-b")];

    const res = method === "GET" ? await GET(req()) : method === "POST"
      ? await POST(req("POST", { contactId })) : await PATCH(req("PATCH", { leadId: 7, status: "novo" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    if (method !== "PATCH") expect(body.columns).toEqual([
      { status_key: "proposta", label: "Proposta personalizada", is_terminal: false },
      { status_key: "novo", label: "Entrada", is_terminal: false },
    ]);
    if (method === "GET") {
      expect(body).toMatchObject({ state: "found", lead: { id: 7, status: "proposta" } });
      expect(state.queries.every((q) => q.operation === "select")).toBe(true);
    } else if (method === "POST") {
      expect(body).toMatchObject({ created: true, lead: { id: 99, status: "proposta" } });
      expect(state.tables.contacts[0].lead_id).toBe(99);
    } else expect(body).toMatchObject({ lead: { id: 7, status: "novo" } });
    expect(state.tables.leads_extraidos.find((row) => row.client_id === "tenant-b")?.status).toBe("proposta");
    expect(state.queries.find((q) => q.table === "kanban_columns")?.fields).toBe("*");
    expect(state.queries.every((q) => q.operation === "insert" ? q.payload?.client_id === "tenant-a"
      : q.filters.some(([key, value]) => key === "client_id" && value === "tenant-a"))).toBe(true);
  });
  it.each(["GET", "POST"] as const)("%s projeta só os campos públicos e considera terminal apenas true no funil moderno", async (method) => {
    state.tables.kanban_columns = [
      { id: "column-1", client_id: "tenant-a", status_key: "proposta", label: "Proposta personalizada", is_terminal: true, color: "#123456", order_index: 0, is_system: true },
      { id: "column-2", client_id: "tenant-a", status_key: "novo", label: "Entrada", is_terminal: false, order_index: 1 },
      { id: "column-3", client_id: "tenant-a", status_key: "agendado", label: "Agendado", is_terminal: null, order_index: 2 },
      { id: "column-4", client_id: "tenant-a", status_key: "fechado", label: "Fechado", is_terminal: "true", order_index: 3 },
      { id: "column-5", client_id: "tenant-b", status_key: "estrangeiro", label: "Outro funil", is_terminal: true },
    ];
    const res = method === "GET" ? await GET(req()) : await POST(req("POST", { contactId }));
    expect(res.status).toBe(200);
    expect((await res.json()).columns).toEqual([
      { status_key: "proposta", label: "Proposta personalizada", is_terminal: true },
      { status_key: "novo", label: "Entrada", is_terminal: false },
      { status_key: "agendado", label: "Agendado", is_terminal: false },
      { status_key: "fechado", label: "Fechado", is_terminal: false },
    ]);
  });
  it("recupera lead_id órfão pelo telefone e etapa real, sem escrever no GET", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "found", lead: { id: 7, status: "proposta" }, columns: [{ label: "Proposta personalizada" }, { label: "Entrada" }] });
    expect(state.queries.every((q) => q.filters.some(([k, v]) => k === "client_id" && v === "tenant-a"))).toBe(true);
    expect(state.queries.some((q) => q.operation !== "select")).toBe(false);
  });
  it("não confia em lead_id/telefone enviados quando há contato persistido", async () => {
    const res = await GET(req("GET", undefined, `contactId=${contactId}&leadId=8&phone=5521999991111`));
    expect(await res.json()).toMatchObject({ lead: { id: 7 } });
    state.tables.contacts[0].client_id = "tenant-b";
    expect((await GET(req())).status).toBe(404);
  });
  it("retorna falha, não missing, se consulta falhar", async () => {
    state.failTable = "leads_extraidos";
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty("state", "missing");
  });
  it("usa defaults só quando colunas estão vazias e preserva etapa fora delas", async () => {
    state.tables.kanban_columns = [];
    const body = await (await GET(req())).json();
    expect(body.lead.status).toBe("proposta");
    expect(body.columns.map((c: Row) => c.status_key)).toEqual(["novo", "primeiro_contato", "interessado", "follow-up", "agendado", "fechado", "sem_interesse", "descartado"]);
  });
  it("relê estado atual em cada GET", async () => {
    await GET(req());
    state.tables.leads_extraidos[0].status = "novo";
    expect(await (await GET(req())).json()).toMatchObject({ lead: { status: "novo" } });
  });
  it("revalida antes de criar e vincula existente escopando escrita de contato", async () => {
    const res = await POST(req("POST", { contactId }));
    expect(await res.json()).toMatchObject({ state: "found", created: false, lead: { id: 7 } });
    expect(state.tables.leads_extraidos).toHaveLength(2);
    expect(state.tables.contacts[0].lead_id).toBe(7);
    expect(state.queries.filter((q) => q.operation === "update").every((q) => q.filters.some(([k, v]) => k === "client_id" && v === "tenant-a"))).toBe(true);
  });
  it("bloqueia criação e vínculo ambíguos", async () => {
    state.tables.leads_extraidos.push(lead(9));
    const res = await POST(req("POST", { contactId }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: "ambiguous" });
    expect(state.queries.some((q) => q.operation !== "select")).toBe(false);
  });
  it("cria só depois de ausência comprovada e recupera corrida de unique sem reinserir", async () => {
    state.tables.leads_extraidos = [];
    state.insertRace = true;
    const res = await POST(req("POST", { contactId }));
    expect(await res.json()).toMatchObject({ state: "found", created: false, lead: { id: 99 } });
    expect(state.queries.filter((q) => q.operation === "insert")).toHaveLength(1);
    expect(state.tables.contacts[0].lead_id).toBe(99);
  });
  it("preserva JID e telefone reais ao criar e devolve o mesmo lead nas próximas tentativas", async () => {
    state.tables.leads_extraidos = [];
    const res = await POST(req("POST", { contactId }));
    expect(await res.json()).toMatchObject({ state: "found", created: true, lead: { id: 99, client_id: "tenant-a", remoteJid: "5511987654321@s.whatsapp.net", telefone: "5511987654321" } });
    expect(await (await POST(req("POST", { contactId }))).json()).toMatchObject({ state: "found", created: false, lead: { id: 99 } });
    expect(state.queries.filter((q) => q.operation === "insert")).toHaveLength(1);
  });
  it.each([
    { phone: "+55 (11) 98765-4321" },
    { remote_jid: "5511987654321:2@c.us", phone: "551187654321" },
    { remoteJid: "5511987654321@s.whatsapp.net" },
  ])("mantém nono dígito de transporte para contato transitório: %j", async (identity) => {
    state.tables.leads_extraidos = [];
    const res = await POST(req("POST", identity));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true, lead: { remoteJid: "5511987654321@s.whatsapp.net", telefone: "5511987654321" } });
  });
  it("não converte LID nem seus dígitos copiados em telefone ao criar", async () => {
    state.tables.leads_extraidos = [];
    Object.assign(state.tables.contacts[0], { remote_jid: "5511987654321@lid", phone_number: "5511987654321" });
    const res = await POST(req("POST", { contactId }));
    expect(res.status).toBe(400);
    expect(state.queries.some((q) => q.operation !== "select")).toBe(false);
  });
  it("usa telefone real distinto quando contato tem apenas JID LID", async () => {
    state.tables.leads_extraidos = [];
    Object.assign(state.tables.contacts[0], { remote_jid: "123456789012345@lid", phone_number: "+55 (11) 98765-4321" });
    const res = await POST(req("POST", { contactId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true, lead: { remoteJid: "5511987654321@s.whatsapp.net", telefone: "5511987654321" } });
  });
  it("não cria lead se falhar a revalidação e trata falha de vínculo sem reinserir", async () => {
    state.failTable = "leads_extraidos";
    expect((await POST(req("POST", { contactId }))).status).toBe(500);
    expect(state.queries.some((q) => q.operation === "insert")).toBe(false);
    state.failTable = "";
    state.failUpdate = true;
    expect((await POST(req("POST", { contactId }))).status).toBe(500);
    expect(state.queries.some((q) => q.operation === "update")).toBe(true);
    expect(state.queries.some((q) => q.operation === "insert")).toBe(false);
    state.failUpdate = false;
    expect(await (await POST(req("POST", { contactId }))).json()).toMatchObject({ state: "found", created: false });
  });
  it("retorna erro de colunas sem supor defaults em falha de leitura", async () => {
    state.failTable = "kanban_columns";
    expect((await GET(req())).status).toBe(500);
    expect((await POST(req("POST", { contactId }))).status).toBe(500);
    expect((await PATCH(req("PATCH", { leadId: 7, status: "novo" }))).status).toBe(500);
    expect(state.queries.some((q) => q.operation !== "select")).toBe(false);
  });
  it("PATCH valida etapa permitida e nunca altera lead estrangeiro", async () => {
    expect((await PATCH(req("PATCH", { leadId: 8, status: "novo" }))).status).toBe(404);
    expect(state.tables.leads_extraidos[1].status).toBe("proposta");
    expect((await PATCH(req("PATCH", { leadId: 7, status: "injetado" }))).status).toBe(400);
    expect(await (await PATCH(req("PATCH", { leadId: 7, status: "novo" }))).json()).toMatchObject({ lead: { status: "novo" } });
    expect(state.queries.filter((q) => q.operation === "update").every((q) => q.filters.some(([k, v]) => k === "client_id" && v === "tenant-a"))).toBe(true);
  });
  it("valida entrada e autenticação antes de acessar dados", async () => {
    expect((await GET(req("GET", undefined, "contactId=invalido"))).status).toBe(400);
    expect((await POST(req("POST", { phone: "lixo" }, ""))).status).toBe(400);
    state.auth = false;
    expect((await GET(req())).status).toBe(401);
    expect((await POST(req("POST", { contactId }))).status).toBe(401);
    expect((await PATCH(req("PATCH", { leadId: 7, status: "novo" }))).status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });
});
