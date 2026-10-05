import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return {
      rpc: state.rpc,
      from(table: string) {
        const filters: Record<string, unknown> = {};
        let single = false;
        type Query = {
          select: () => Query;
          eq: (key: string, value: unknown) => Query;
          is: (key: string, value: unknown) => Query;
          maybeSingle: () => Query;
          then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) => Promise<unknown>;
        };
        const query: Query = {
          select: () => query,
          eq: (key, value) => { filters[key] = value; return query; },
          is: (key, value) => { filters[key] = value; return query; },
          maybeSingle: () => { single = true; return query; },
          then(resolve, reject) {
            const rows = (state.rows[table] ?? []).filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
            return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
          },
        };
        return query;
      },
    };
  },
}));
import { getStarterFiles } from "../starter";
import { submitWebsiteForm } from "../forms";
import { validateWebsiteContent } from "../validation";
import type { WebsiteFiles, WebsiteProject } from "../types";

const CLIENT = "00000000-0000-0000-0000-000000000001";
const PROJECT = "00000000-0000-0000-0000-000000000010";
const DEPLOY = "00000000-0000-0000-0000-000000000014";
const ORIGIN = "https://site.acme.workers.dev";
const PANEL = "https://painel.example.test";
const SAMPLE: Record<string, string> = { name: "Maria Souza", email: "maria@example.com", message: "Olá, quero um orçamento.", consent: "true" };

function websiteProject(): WebsiteProject {
  const now = new Date().toISOString();
  return {
    id: PROJECT, client_id: CLIENT, name: "Aço & Cia", slug: "aco-cia", lead_id: null,
    client_context: { name: "Aço & Cia", description: "Estruturas metálicas sob medida." },
    instructions: "", model_mode: "auto", model_id: null, selected_skill_ids: [],
    cta: { type: "form", value: "" }, status: "draft", current_revision_id: null,
    published_deployment_id: null, published_url: null, last_published_at: null,
    created_at: now, updated_at: now, deleted_at: null,
  };
}

function contentOf(files: WebsiteFiles): { formEndpoint: string; projectId: string } {
  return JSON.parse(files["src/content.json"]) as { formEndpoint: string; projectId: string };
}

function formSource(files: WebsiteFiles): string {
  const source = files["src/components/ContactForm.tsx"];
  expect(source, "starter deve gerar src/components/ContactForm.tsx").toBeDefined();
  return source!;
}

function starterKey(files: WebsiteFiles, cryptoGlobal?: { randomUUID: () => string }): string {
  const declaration = formSource(files).match(/function newIdempotencyKey\(\): string \{[\s\S]*?\n\}/)?.[0];
  expect(declaration, "starter deve declarar newIdempotencyKey(): string no form publicado").toBeDefined();
  return runInNewContext(`(${declaration!.replace("(): string", "()")})()`, cryptoGlobal ? { crypto: cryptoGlobal } : {});
}

function starterPayload(files: WebsiteFiles): Record<string, unknown> {
  const source = formSource(files);
  const fields = Object.fromEntries([...source.matchAll(/ name="([a-z]+)"/g)].map((match) => [match[1], SAMPLE[match[1]]]));
  expect(Object.keys(fields).length).toBeGreaterThan(0);
  return { ...fields, ...(source.includes("idempotency_key") ? { idempotency_key: starterKey(files) } : {}) };
}

function formRequest(endpoint: string, payload: Record<string, unknown>): NextRequest {
  return new NextRequest(endpoint, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.SITE_FORMS_TRUSTED_IP_HEADER;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", PANEL);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
  state.rows = {
    clients: [{ id: CLIENT, is_active: true, is_admin: false, features: { sites: true } }],
    website_projects: [{ id: PROJECT, client_id: CLIENT, published_deployment_id: DEPLOY, status: "published", deleted_at: null }],
    website_deployments: [{ id: DEPLOY, client_id: CLIENT, project_id: PROJECT, status: "published", url: ORIGIN }],
    website_domains: [],
  };
  state.rpc.mockImplementation(async (name: string) =>
    name === "website_rate_limit" ? { data: true, error: null }
    : name === "website_submit_form" ? { data: { id: "sub-1" }, error: null }
    : { data: null, error: { message: "unexpected rpc" } });
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("starter do Site Studio — contrato do formulário publicado", () => {
  it("gera endpoint público de submit com o project_id do projeto", () => {
    const files = getStarterFiles(websiteProject());
    expect(contentOf(files).formEndpoint).toBe(`${PANEL}/api/sites/forms/submit?project_id=${PROJECT}`);
    expect(files["src/App.tsx"]).toContain('<ContactForm endpoint={content.formEndpoint} />');
    expect(formSource(files)).toContain("disabled={busy || !endpoint}");
  });

  it("normaliza URL pública com barra final e espaços", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", ` ${PANEL}/ `);
    expect(contentOf(getStarterFiles(websiteProject())).formEndpoint).toBe(`${PANEL}/api/sites/forms/submit?project_id=${PROJECT}`);
  });

  it("mantém o endpoint vazio (botão travado) quando não há URL pública do painel", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(contentOf(getStarterFiles(websiteProject())).formEndpoint).toBe("");
  });

  it("não gera endpoint sem projeto", () => {
    expect(contentOf(getStarterFiles()).formEndpoint).toBe("");
  });

  it("starter com endpoint preenchido continua válido para o build", () => {
    expect(validateWebsiteContent(getStarterFiles(websiteProject())).passed).toBe(true);
  });

  it("POST com o payload exato montado pelo formulário do starter é aceito (202)", async () => {
    const files = getStarterFiles(websiteProject());
    const endpoint = contentOf(files).formEndpoint;
    expect(endpoint).toContain(`project_id=${PROJECT}`);
    const response = await submitWebsiteForm(formRequest(endpoint, starterPayload(files)));
    expect(response.status).toBe(202);
    expect(state.rpc).toHaveBeenCalledWith("website_submit_form", expect.objectContaining({ p_client_id: CLIENT, p_project_id: PROJECT }));
  });

  it("POST sem idempotency_key (payload antigo do starter) segue rejeitado com 400", async () => {
    const files = getStarterFiles(websiteProject());
    const payload = starterPayload(files);
    delete payload.idempotency_key;
    const response = await submitWebsiteForm(formRequest(contentOf(files).formEndpoint, payload));
    expect(response.status).toBe(400);
  });

  it("usa crypto.randomUUID quando o navegador expõe", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(starterKey(getStarterFiles(websiteProject()), { randomUUID: () => uuid })).toBe(uuid);
  });

  it("fallback sem crypto.randomUUID gera chave aceita pelo servidor", () => {
    expect(starterKey(getStarterFiles(websiteProject()))).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("preserva a chave entre tentativas e renova apenas após sucesso", () => {
    const source = formSource(getStarterFiles(websiteProject()));
    const commit = source.indexOf("setKey(idempotencyKey)");
    const request = source.indexOf("await fetch");
    const clear = source.indexOf('setKey("")');
    expect(commit).toBeGreaterThan(-1);
    expect(commit).toBeLessThan(request);
    expect(clear).toBeGreaterThan(request);
    expect(source).toContain('form.reset();\n      setKey("");');
    const failure = source.match(/catch \{([^}]*)\}/)?.[1] ?? "";
    expect(failure).not.toContain("setKey");
  });
});
