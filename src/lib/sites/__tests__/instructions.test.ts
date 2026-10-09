import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteProject, WebsiteSkill } from "../types";

const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  filters: [] as unknown[][],
  queue: [] as Array<{ data?: unknown; error?: unknown }>,
  inserts: [] as unknown[],
  updates: [] as unknown[],
  rpc: vi.fn(),
  dequeue: () => db.queue.shift() ?? { data: db.rows, error: null },
}));
vi.mock("../server", () => ({
  getSitesDb: () => ({
    rpc: db.rpc,
    from: () => {
      const chain = {
        select: vi.fn(() => chain),
        insert: vi.fn((value: unknown) => { db.inserts.push(value); return chain; }),
        update: vi.fn((value: unknown) => { db.updates.push(value); return chain; }),
        delete: vi.fn(() => chain),
        eq: vi.fn((...args: unknown[]) => { db.filters.push(args); return chain; }),
        is: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(db.dequeue())),
        single: vi.fn(() => Promise.resolve(db.dequeue())),
        maybeSingle: vi.fn(() => Promise.resolve(db.dequeue())),
      };
      return chain;
    },
  }),
}));
const aiKeys = vi.hoisted(() => ({ keys: { openrouterKeys: [] as string[], gatewayEndpoints: [], gemini: null, openrouter: null, gatewayBaseUrl: null, gatewayApiKey: null, gatewayFallbackModel: null, aiCombos: [] } }));
vi.mock("@/lib/ai-keys", () => ({ getAiKeys: async () => aiKeys.keys }));

import { BUILTIN_WEBSITE_SKILLS, getEffectiveSkills, validateSkillInput } from "../skills";
import { composeWebsitePrompt, DEFAULT_WEBSITE_SETTINGS, getWebsiteIntegrations, isExistingSiteProject, isSimpleWebsiteRequest, mergeWebsiteSettings, resetWebsitePrompt, restoreWebsitePrompt, saveWebsitePrompt, WEBSITE_SECURITY_PROMPT } from "../prompts";

const clientId = "11111111-1111-4111-8111-111111111111";
const actorId = "44444444-4444-4444-8444-444444444444";
const project = {
  id: "22222222-2222-4222-8222-222222222222", client_id: clientId,
  name: "Clínica", instructions: "", client_context: { city: "Recife" },
  selected_skill_ids: [], cta: { type: "phone", value: "81999999999" },
} as unknown as WebsiteProject;
const skill = (overrides: Partial<WebsiteSkill> = {}): WebsiteSkill => ({
  id: "33333333-3333-4333-8333-333333333333", client_id: clientId,
  name: "Local", slug: "local", description: "Busca local", instructions: "LOCAL_INSTRUCTION",
  category: "seo", tags: ["busca local"], priority: 50, trigger_mode: "automatic", is_enabled: true,
  is_builtin: false, version: 1, ...overrides,
});

beforeEach(() => { db.rows = []; db.filters = []; db.queue = []; db.inserts = []; db.updates = []; db.rpc.mockReset(); });

afterEach(() => { vi.unstubAllEnvs(); });

describe("website instructions", () => {
  it.each([
    ["site-template", "", true],
    ["", "legacy-template", false],
    ["   ", "legacy-template", false],
  ])("checks the site-specific E2B template (%s, %s)", async (siteTemplate, legacyTemplate, configured) => {
    vi.stubEnv("E2B_API_KEY", "offline-fixture");
    vi.stubEnv("E2B_SITE_TEMPLATE_ID", siteTemplate);
    vi.stubEnv("E2B_TEMPLATE_ID", legacyTemplate);
    db.rpc.mockResolvedValue({ data: false, error: null });
    expect((await getWebsiteIntegrations()).e2b).toEqual({ configured, settingsUrl: "/configuracoes" });
  });

  it("exposes exactly 1 builtin with stable builtin:slug ids, versions and full instruction structure", () => {
    expect(BUILTIN_WEBSITE_SKILLS).toHaveLength(1);
    expect(new Set(BUILTIN_WEBSITE_SKILLS.map((item) => item.id)).size).toBe(1);
    for (const builtin of BUILTIN_WEBSITE_SKILLS) {
      expect(builtin.id).toBe(`builtin:${builtin.slug}`);
      expect(builtin.is_builtin).toBe(true);
      expect(builtin.version).toBe(3);
      expect(builtin.is_enabled).toBe(true);
      expect(builtin.description.trim().length).toBeGreaterThan(20);
      expect(/Processo[\s\S]*Checks[\s\S]*Anti-patterns[\s\S]*DoD/.test(builtin.instructions)).toBe(true);
    }
    expect(BUILTIN_WEBSITE_SKILLS.map((item) => item.slug)).toEqual(["impeccable-design"]);
    expect(BUILTIN_WEBSITE_SKILLS.find((item) => item.slug === "impeccable-design")!.instructions).toContain("AI-SLOP");
  });

  it("overrides builtin instructions privately without mutating builtin security fields", async () => {
    const builtin = BUILTIN_WEBSITE_SKILLS.find((item) => item.slug === "impeccable-design")!;
    db.rows = [skill({ ...builtin, id: "33333333-3333-4333-8333-333333333333", client_id: clientId, instructions: "PRIVATE", version: 4, priority: 1, trigger_mode: "manual", is_enabled: false })];
    const skills = await getEffectiveSkills(clientId);
    const effective = skills.find((item) => item.id === builtin.id)!;
    expect(effective.instructions).toBe("PRIVATE");
    expect(effective.version).toBe(4);
    expect(effective.priority).toBe(builtin.priority);
    expect(effective.trigger_mode).toBe(builtin.trigger_mode);
    expect(effective.is_enabled).toBe(false);
    expect(effective.is_builtin).toBe(true);
    expect(BUILTIN_WEBSITE_SKILLS.find((item) => item.slug === "impeccable-design")!.instructions).not.toBe("PRIVATE");
    expect(db.filters).toContainEqual(["client_id", clientId]);
  });

  it("never composes foreign tenant skills and respects enabled/manual/automatic modes", () => {
    const skills = [skill(), skill({ id: "disabled", is_enabled: false, instructions: "DISABLED" }), skill({ id: "foreign", client_id: "other", trigger_mode: "always", instructions: "FOREIGN" }), skill({ id: "manual", trigger_mode: "manual", instructions: "MANUAL" })];
    const prompt = composeWebsitePrompt(project, skills, "CREATIVE", "Melhore a busca local.");
    expect(prompt).toContain("LOCAL_INSTRUCTION");
    expect(prompt).not.toContain("DISABLED");
    expect(prompt).not.toContain("FOREIGN");
    expect(prompt).not.toContain("MANUAL");
    expect(composeWebsitePrompt({ ...project, selected_skill_ids: ["manual"] }, skills, "", "Olá")).toContain("MANUAL");
    expect(composeWebsitePrompt(project, [skill()], "", "localidade")).not.toContain("LOCAL_INSTRUCTION");
  });

  it("composes the global creative direction and always-on anti-ai guidance without leaking fake proofs", () => {
    const prompt = composeWebsitePrompt(project, BUILTIN_WEBSITE_SKILLS as unknown as WebsiteSkill[], "CRIATIVO GLOBAL", "Crie a home.");
    expect(prompt.startsWith(WEBSITE_SECURITY_PROMPT)).toBe(true);
    expect(prompt).toContain("CRIATIVO GLOBAL");
    expect(prompt).toContain("builtin:impeccable-design");
  });

  it("keeps immutable security and the current request inside a bounded deterministic prompt", () => {
    const skills = Array.from({ length: 500 }, (_, i) => skill({ id: `${i}`, trigger_mode: "always", instructions: `SKILL_${i} ` + "x".repeat(12000) }));
    const prompt = composeWebsitePrompt({ ...project, instructions: "y".repeat(40000) }, skills, "c".repeat(40000), "CURRENT_REQUEST " + "u".repeat(40000));
    expect(prompt.length).toBeLessThanOrEqual(24000);
    expect(prompt.startsWith(WEBSITE_SECURITY_PROMPT)).toBe(true);
    expect(prompt).not.toContain("CURRENT_REQUEST");
    expect(prompt).toBe(composeWebsitePrompt({ ...project, instructions: "y".repeat(40000) }, skills, "c".repeat(40000), "CURRENT_REQUEST " + "u".repeat(40000)));
  });

  it("rejects mass assignment and invalid skill fields", () => {
    expect(() => validateSkillInput({ client_id: "foreign" }, true)).toThrow();
    expect(() => validateSkillInput({ priority: Infinity }, true)).toThrow();
    expect(() => validateSkillInput({ instructions: "x".repeat(12001) }, true)).toThrow();
    expect(() => validateSkillInput({ slug: "Slug Inválido" }, true)).toThrow();
    expect(validateSkillInput({ is_enabled: false }, true)).toEqual({ is_enabled: false });
  });

  it("merges only known valid settings and never returns secrets", () => {
    const settings = mergeWebsiteSettings({ max_sites: 12, api_key: "secret", max_storage_mb: -1, creative_prompt: "Creative" });
    expect(settings).toEqual({ ...DEFAULT_WEBSITE_SETTINGS, max_sites: 12, creative_prompt: "Creative" });
    expect(settings).not.toHaveProperty("api_key");
  });

  it("saves, restores and resets the global prompt as append-only versions", async () => {
    const oldVersion = { id: "55555555-5555-4555-8555-555555555555", client_id: null, prompt: "ANTIGO", version: 1, created_at: "2026-01-01T00:00:00Z", created_by: actorId };
    db.rows = [oldVersion];
    db.queue.push({ data: [oldVersion], error: null });
    db.queue.push({ data: { id: "66666666-6666-4666-8666-666666666666", client_id: null, prompt: "ANTIGO", version: 2, created_at: "2026-01-03T00:00:00Z", created_by: actorId }, error: null });
    const restored = await restoreWebsitePrompt(oldVersion.id, actorId);
    expect(restored).toMatchObject({ prompt: "ANTIGO", version: 2 });
    expect(db.inserts.at(-1)).toMatchObject({ client_id: null, prompt: "ANTIGO", version: 2, created_by: actorId });
    db.queue.push({ data: [oldVersion], error: null });
    db.queue.push({ data: { id: "77777777-7777-4777-8777-777777777777", client_id: null, prompt: DEFAULT_WEBSITE_SETTINGS.creative_prompt, version: 2, created_at: "2026-01-04T00:00:00Z", created_by: actorId }, error: null });
    expect(await resetWebsitePrompt(actorId)).toMatchObject({ prompt: DEFAULT_WEBSITE_SETTINGS.creative_prompt });
    db.queue.push({ data: [oldVersion], error: null });
    await expect(restoreWebsitePrompt("99999999-9999-4999-8999-999999999999", actorId)).rejects.toThrow();
    await expect(saveWebsitePrompt("", actorId)).rejects.toThrow();
    await expect(saveWebsitePrompt("x".repeat(12001), actorId)).rejects.toThrow();
  });

  it("reports integrations from real AI keys and worker heartbeat, never from env alone", async () => {
    process.env.OPENROUTER_API_KEY = "env-only";
    process.env.SITES_WORKER_ENABLED = "true";
    delete process.env.E2B_API_KEY;
    delete process.env.CLOUDFLARE_API_TOKEN;
    db.rpc.mockResolvedValue({ data: false, error: null });
    expect((await getWebsiteIntegrations()).worker.configured).toBe(false);
    expect((await getWebsiteIntegrations()).openrouter.configured).toBe(false);
    db.rpc.mockResolvedValue({ data: true, error: null });
    aiKeys.keys = { ...aiKeys.keys, openrouterKeys: ["db-key"] };
    const integrations = await getWebsiteIntegrations();
    expect(integrations.worker.configured).toBe(true);
    expect(integrations.openrouter.configured).toBe(true);
    expect(integrations.e2b.configured).toBe(false);
    expect(integrations.cloudflare.configured).toBe(false);
    db.rpc.mockRejectedValue({ message: "rpc ausente" });
    expect((await getWebsiteIntegrations()).worker.configured).toBe(false);
    aiKeys.keys = { ...aiKeys.keys, openrouterKeys: [] };
  });

  it.each(["Continue criando o site verde", "Continue e troque a cor", "Redesign usando azul", "Crie uma página verde", "Quero nova identidade verde", "verde", "corrija o bug no pagamento"])("never classifies creation, continuation or ambiguous intent as surgical: %s", (message) => {
    expect(isSimpleWebsiteRequest(message)).toBe(false);
  });

  it("does not preload whole source or duplicate request for surgical edits", () => {
    const files = { "src/App.tsx": "export default function App() { return <main>UNRELATED_FULL_SOURCE</main>; }", "src/styles.css": "/* UNRELATED_CSS */\n".repeat(10000) };
    const prompt = composeWebsitePrompt(project, BUILTIN_WEBSITE_SKILLS, "CREATIVE", "Troque o telefone para 81999999998", files);
    expect(prompt).not.toContain("UNRELATED_FULL_SOURCE");
    expect(prompt).not.toContain("UNRELATED_CSS");
    expect(prompt).not.toContain("Troque o telefone para 81999999998");
    expect(prompt).toContain("ARQUIVOS VIRTUAIS");
    expect(prompt).toContain("read_design_reference");
    expect(prompt.length).toBeLessThan(20000);
  });

  it("accurately classifies simple surgical requests vs complex full-site generations", () => {
    expect(isSimpleWebsiteRequest("mude a cor para verde")).toBe(true);
    expect(isSimpleWebsiteRequest("Recrie o site completo usando verde")).toBe(false);
    expect(isSimpleWebsiteRequest("troque a cor do botão para verde")).toBe(true);
    expect(isSimpleWebsiteRequest("mudar para verde")).toBe(true);
    expect(isSimpleWebsiteRequest("troque o telefone para (11) 98765-4321")).toBe(true);
    expect(isSimpleWebsiteRequest("altere o título do hero para Casa da Fazenda")).toBe(true);
    expect(isSimpleWebsiteRequest("coloque o whatsapp no topo")).toBe(true);
    expect(isSimpleWebsiteRequest("aumente a fonte do título")).toBe(true);
    expect(isSimpleWebsiteRequest("corrija o erro de ortografia no footer")).toBe(true);

    expect(isSimpleWebsiteRequest("Crie um site institucional completo com catálogo de 20 produtos, integração de pagamento Stripe, área de membros com login, dashboard analítico e sistema de envio de newsletters")).toBe(false);
  });

  it("accurately detects existing site vs ungenerated starter site", () => {
    expect(isExistingSiteProject(undefined)).toBe(false);
    expect(isExistingSiteProject({})).toBe(false);
    expect(isExistingSiteProject({
      "src/App.tsx": 'export default function App() {\n  return <main><h1>Criando design autoral sob medida com a diretriz Impeccable Design...</h1></main>;\n}',
    })).toBe(false);

    expect(isExistingSiteProject({
      "src/App.tsx": 'import { useState } from "react";\n' + "export default function App() {\n  return <><header><h1>Casa do Agricultor</h1></header><main><section><h2>Rações e Ferramentas</h2><p>Tradição no campo desde 1994 com atendimento especializado no balcão e entrega rápida em toda a região rural.</p></section></main><footer><p>Contato: (27) 99970-0577</p></footer></>;\n}\n".repeat(4),
      "src/styles.css": ":root { --brand-primary: #1d5037; }",
    })).toBe(true);
  });

  it("generates an optimized surgical prompt for simple edits on existing sites", () => {
    const existingFiles = {
      "src/App.tsx": "export default function App() {\n  return <><header><h1>Casa do Agricultor</h1></header><main><section><h2>Rações e Ferramentas</h2><p>Tradição no campo.</p></section></main><footer><p>(27) 99970-0577</p></footer></>;\n}\n".repeat(4),
      "src/styles.css": ":root {\n  --brand-primary: #1d5037;\n  --bg-canvas: #faf7f2;\n}\n.hero { padding: 4rem; }\n",
      "index.html": "<!doctype html><html><head><title>Casa do Agricultor</title></head><body><div id='root'></div></body></html>",
    };

    const initialPrompt = composeWebsitePrompt(project, BUILTIN_WEBSITE_SKILLS as unknown as WebsiteSkill[], "CRIATIVO", "Crie o site completo");
    const editPrompt = composeWebsitePrompt(project, BUILTIN_WEBSITE_SKILLS as unknown as WebsiteSkill[], "CRIATIVO", "mude a cor para verde", existingFiles);

    expect(initialPrompt.length).toBeGreaterThan(0);
    expect(editPrompt.startsWith(WEBSITE_SECURITY_PROMPT)).toBe(true);
    expect(editPrompt).toContain("REFINAMENTO / PRESERVAÇÃO");
    expect(editPrompt).toContain("MODO DE EDIÇÃO CIRÚRGICA ATIVO");
    expect(editPrompt).toContain("USE OBRIGATORIAMENTE a ferramenta 'patch'");
    expect(editPrompt).toContain("--brand-primary: #1d5037");
    // index.html não é incluído para pedidos de cor em sites existentes (economiza tokens)
    expect(editPrompt).not.toContain("<!doctype html>");
  });
});


it("removes Impeccable instructions when disabled without disabling other selected skills", () => {
  const builtin = BUILTIN_WEBSITE_SKILLS[0];
  const custom = skill({ id: "other", trigger_mode: "always", instructions: "CUSTOM_BRAND_RULE" });
  const prompt = composeWebsitePrompt(project, [{ ...builtin, is_enabled: false }, custom], "OPERATOR", "Crie a página");
  expect(prompt).not.toContain("IMPECCABLE ATIVO");
  expect(prompt).not.toContain("REFERÊNCIA OFICIAL INTEGRAL");
  expect(prompt).toContain("CUSTOM_BRAND_RULE");
  expect(prompt).not.toContain("Header fixo/sticky com efeito glassmorphism");
});

it("preserves confirmed brief, operator prompt and every new-site foundation without slicing", () => {
  const prompt = composeWebsitePrompt({ ...project, name: "Luthier Horizonte", client_context: { name: "Luthier Horizonte", services: "Restauração de violinos", city: "Vitória", notes: "Logo azul obrigatória" }, instructions: "Sem FAQ. Exibir peças reais." }, BUILTIN_WEBSITE_SKILLS, "DIREÇÃO_OPERADOR", "PEDIDO_INTEGRAL");
  expect(prompt).toContain("Restauração de violinos");
  expect(prompt).toContain("Logo azul obrigatória");
  expect(prompt).toContain("Sem FAQ. Exibir peças reais.");
  expect(prompt).toContain("DIREÇÃO_OPERADOR");
  expect(prompt).not.toContain("PEDIDO_INTEGRAL");
  expect(prompt).toContain("FIM DA REFERÊNCIA optimize");
  expect(prompt.length).toBeLessThanOrEqual(240000);
});

it("rebases legacy toggle copies instead of restoring obsolete niche templates", async () => {
  const builtin = BUILTIN_WEBSITE_SKILLS[0];
  db.rows = [skill({ ...builtin, id: actorId, client_id: clientId, instructions: "DIRETRIZ MESTRA IMPECCABLE DESIGN (pbakaus/impeccable — DESIGN DE ALTO VALOR): Paleta de Cores Autoral por Nicho", is_enabled: true })];
  const effective = (await getEffectiveSkills(clientId)).find((entry) => entry.id === builtin.id)!;
  expect(effective.instructions).toBe(builtin.instructions);
  expect(effective.is_enabled).toBe(true);
});
