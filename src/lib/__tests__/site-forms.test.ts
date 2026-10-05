import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  enabled: true,
  rows: {} as Record<string, Record<string, unknown>[]>,
  rpc: vi.fn(),
  dbError: false,
}));

vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    if (!state.enabled) return null;
    return {
      rpc: state.rpc,
      from(table: string) {
        const filters: Record<string, unknown> = {};
        let single = false;
        type Query = {
          select: () => Query;
          eq: (key: string, value: unknown) => Query;
          is: (key: string, value: unknown) => Query;
          order: () => Query;
          limit: () => Query;
          maybeSingle: () => Query;
          then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) => Promise<unknown>;
        };
        const query: Query = {
          select: () => query,
          eq: (key, value) => { filters[key] = value; return query; },
          is: (key, value) => { filters[key] = value; return query; },
          order: () => query,
          limit: () => query,
          maybeSingle: () => { single = true; return query; },
          then(resolve, reject) {
            const rows = (state.rows[table] ?? []).filter((row) => Object.entries(filters).every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
            if (state.dbError) return Promise.resolve({ data: null, error: { message: "private detail" } }).then(resolve, reject);
            return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
          },
        };
        return query;
      },
    };
  },
}));
import { isExactWebsiteOrigin, submitWebsiteForm, validateWebsiteForm, websiteFormPreflight } from "@/lib/sites/forms";

const CLIENT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const PROJECT = "00000000-0000-0000-0000-000000000010";
const DEPLOY = "00000000-0000-0000-0000-000000000014";
const ORIGIN = "https://site.acme.workers.dev";
const KEY = "form-key-1234567890ab";

function seedRows(): void {
  state.rows = {
    clients: [{ id: CLIENT, is_active: true, is_admin: false, features: { sites: true } }],
    website_projects: [{ id: PROJECT, client_id: CLIENT, published_deployment_id: DEPLOY, status: "published", deleted_at: null }],
    website_deployments: [{ id: DEPLOY, client_id: CLIENT, project_id: PROJECT, status: "published", url: ORIGIN }],
    website_domains: [{ client_id: CLIENT, project_id: PROJECT, status: "active", hostname: "loja.cli.example.com" }],
  };
}

function request(body?: unknown, origin: string | null = ORIGIN, projectId: string | null = PROJECT, method = "POST"): NextRequest {
  const url = projectId ? `https://painel.test/api/sites/forms/submit?project_id=${projectId}` : "https://painel.test/api/sites/forms/submit";
  return new NextRequest(url, {
    method,
    headers: origin === null ? { "content-type": "application/json" } : { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function preflight(origin = ORIGIN, method = "POST", headers = "Content-Type", projectId = PROJECT): NextRequest {
  return new NextRequest(`https://painel.test/api/sites/forms/submit?project_id=${projectId}`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers },
  });
}

function formBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { project_id: PROJECT, idempotency_key: KEY, name: "Maria Souza", email: "Maria@Example.com ", phone: "+55 11 91234-5678", message: "Olá", consent: true, ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.SITE_FORMS_TRUSTED_IP_HEADER;
  state.enabled = true;
  state.dbError = false;
  seedRows();
  state.rpc.mockImplementation(async (name: string) =>
    name === "website_rate_limit" ? { data: true, error: null }
    : name === "website_submit_form" ? { data: { id: "sub-1" }, error: null }
    : { data: null, error: { message: "unexpected rpc" } });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
});

describe("validateWebsiteForm", () => {
  it("normaliza e exige contato válido", () => {
    const payload = validateWebsiteForm(formBody());
    expect(payload).toMatchObject({ project_id: PROJECT, idempotency_key: KEY, name: "Maria Souza", email: "maria@example.com", phone: "+55 11 91234-5678", consent: true });
  });

  it("aceita telefone como único canal de contato", () => {
    expect(validateWebsiteForm(formBody({ email: "" }))).toMatchObject({ phone: "+55 11 91234-5678", email: "" });
  });

  it.each([
    ["nome curto", { name: "M" }],
    ["sem contato", { email: "", phone: "" }],
    ["email inválido", { email: "maria example.com" }],
    ["telefone curto", { phone: "119" }],
    ["telefone com letras", { phone: "1198765432a" }],
    ["consent ausente", { consent: undefined }],
    ["chave curta", { idempotency_key: "abc" }],
    ["caractere de controle", { message: "ok\u0001" }],
    ["campo extra", { tracking: "x" }],
    ["project_id inválido", { project_id: "não-uuid" }],
  ])("rejeita %s", (_label, overrides) => {
    expect(() => validateWebsiteForm(formBody(overrides))).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe("isExactWebsiteOrigin", () => {
  it("aceita origem https publicada", () => {
    expect(isExactWebsiteOrigin(ORIGIN, [ORIGIN, "https://loja.cli.example.com"])).toBe(true);
  });

  it.each([
    ["http", "http://site.acme.workers.dev"],
    ["string nula", "null"],
    ["vazia", ""],
    ["host alheio", "https://evil.test"],
    ["com porta", "https://site.acme.workers.dev:8443"],
  ])("rejeita origem %s", (_label, origin) => {
    expect(isExactWebsiteOrigin(origin, [ORIGIN])).toBe(false);
  });

  it("tolera url inválida na lista publicada", () => {
    expect(isExactWebsiteOrigin(ORIGIN, ["::bad::", ORIGIN])).toBe(true);
  });
});

describe("submitWebsiteForm", () => {
  it("aceita envio legível e persiste com tenant resolvido no servidor", async () => {
    const response = await submitWebsiteForm(request(formBody()));
    expect(response.status).toBe(202);
    expect(state.rpc).toHaveBeenCalledWith("website_submit_form", expect.objectContaining({
      p_client_id: CLIENT, p_project_id: PROJECT, p_idempotency_key: KEY,
      p_payload: { name: "Maria Souza", email: "maria@example.com", phone: "+55 11 91234-5678", message: "Olá", consent: true },
    }));
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("honeypot preenchido aceita silenciosamente sem persistir", async () => {
    const response = await submitWebsiteForm(request(formBody({ company: "spam-bot" })));
    expect(response.status).toBe(202);
    expect(state.rpc).not.toHaveBeenCalledWith("website_submit_form", expect.anything());
    expect(state.rpc).toHaveBeenCalledWith("website_rate_limit", expect.objectContaining({ limit: 100 }));
  });

  it("rejeita sem Origin com 403 e sem header CORS", async () => {
    const response = await submitWebsiteForm(request(formBody(), null));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejeita origem não publicada", async () => {
    const response = await submitWebsiteForm(request(formBody(), "https://evil.test"));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejeita projeto não publicado", async () => {
    state.rows.website_projects[0].status = "draft";
    const response = await submitWebsiteForm(request(formBody()));
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("rejeita tenant desativado", async () => {
    state.rows.clients[0].is_active = false;
    const response = await submitWebsiteForm(request(formBody()));
    expect(response.status).toBe(404);
  });

  it("rejeita divergência entre query e corpo", async () => {
    const response = await submitWebsiteForm(request(formBody({ project_id: OTHER }), ORIGIN, PROJECT));
    expect(response.status).toBe(400);
  });

  it("rejeita quando o corpo declara outro project_id inexistente", async () => {
    const response = await submitWebsiteForm(request(formBody({ project_id: OTHER }), ORIGIN, null));
    expect(response.status).toBe(404);
  });

  it("responde 429 com Retry-After quando o limite é atingido", async () => {
    state.rpc.mockImplementation(async (name: string) =>
      name === "website_rate_limit" ? { data: false, error: null } : { data: null, error: { message: "no" } });
    const response = await submitWebsiteForm(request(formBody()));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("conflito de idempotência vira 409 orientando a manter a chave", async () => {
    state.rpc.mockImplementation(async (name: string) =>
      name === "website_rate_limit" ? { data: true, error: null }
      : { data: null, error: { code: "23505", message: "duplicate" } });
    const response = await submitWebsiteForm(request(formBody()));
    expect(response.status).toBe(409);
  });

  it("falha fechado quando o banco responde com erro", async () => {
    state.dbError = true;
    const response = await submitWebsiteForm(request(formBody()));
    expect(response.status).toBe(503);
  });
});

describe("websiteFormPreflight", () => {
  it("aprova preflight estrito de POST com Content-Type", async () => {
    const response = await websiteFormPreflight(preflight());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });

  it("rejeita preflight com métodos ou headers não declarados", async () => {
    expect((await websiteFormPreflight(preflight(ORIGIN, "DELETE"))).status).toBe(403);
    expect((await websiteFormPreflight(preflight(ORIGIN, "POST", "Content-Type, X-Evil"))).status).toBe(403);
  });

  it("rejeita preflight de origem não publicada", async () => {
    expect((await websiteFormPreflight(preflight("https://evil.test"))).status).toBe(403);
  });
});
