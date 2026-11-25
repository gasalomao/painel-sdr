import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  auth: {
    ok: true as const,
    clientId: "tenant-e2e",
    isAdmin: false,
    impersonating: false,
    claims: {
      clientId: "tenant-e2e",
      isAdmin: false,
      impersonating: false,
      sessionId: "sess-e2e",
    },
  },
  internalSecret: false,
  simulatePriorityColumnMissingOnce: false,
  agentRows: [] as Array<Record<string, unknown>>,
  automationRows: [] as Array<Record<string, unknown>>,
  leadRows: [] as Array<Record<string, unknown>>,
  campaignRows: [] as Array<Record<string, unknown>>,
  upsertedTargets: [] as Array<Record<string, unknown>>,
  updatedAgentPayloads: [] as Array<Record<string, unknown>>,
  evaluatePreviewSpy: vi.fn(),
  startAiChatSpy: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => state.auth),
}));

vi.mock("@/lib/internal-auth", () => ({
  hasInternalSecret: vi.fn(() => state.internalSecret),
}));

vi.mock("@/lib/campaign-instance-access", () => ({
  validateCampaignInstanceAccess: vi.fn(async () => ({ ok: true })),
  validateClientAgentAccess: vi.fn(async (_c: string, id: unknown) => ({ ok: true, agentId: id ?? null })),
}));

vi.mock("@/lib/enforce-model", () => ({
  enforceClientDefaultModel: vi.fn(async () => {}),
}));

vi.mock("@/lib/agent-config-cache", () => ({
  getCachedAgentStaticBundle: vi.fn(async ({ agentId }: { agentId: number }) => ({
    agentConfig: state.agentRows.find((a) => a.id === agentId) ?? null,
    leadStages: [],
    knowledgeTopics: [],
    hasCatalogOrPhotoKb: false,
  })),
  invalidateAgentConfigCache: vi.fn(),
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({ gemini: null, openrouter: "or-test-key", nvidia: null })),
}));

vi.mock("@/lib/ai-default-model", () => ({
  resolveModel: vi.fn(async (m: string) => m || "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"),
  mapModelAsync: vi.fn(async (m: string) => m),
}));

vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-provider")>();
  return { ...actual, startAiChat: state.startAiChatSpy };
});

vi.mock("@/lib/sites/agreement-detector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sites/agreement-detector")>();
  return {
    ...actual,
    evaluatePreviewAgreement: state.evaluatePreviewSpy,
  };
});

vi.mock("@/lib/token-usage", () => ({ logTokenUsage: vi.fn(async () => {}) }));
vi.mock("@/lib/channel", () => ({ sendMessage: vi.fn(), sendMedia: vi.fn() }));
vi.mock("@/lib/evolution", () => ({ getEvolutionConfig: vi.fn(async () => ({ instance: "inst-e2e" })) }));
vi.mock("@/lib/organizer-realtime", () => ({
  promoteLeadBySystemSignal: vi.fn(async () => {}),
  scheduleRealtimeLeadEvaluation: vi.fn(),
}));

vi.mock("@/lib/supabase_admin", () => {
  const from = vi.fn((table: string) => {
    const eqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let action: "select" | "update" | "insert" | "upsert" | "delete" = "select";
    let writePayload: unknown = null;

    const filterRows = (rows: Array<Record<string, unknown>>) =>
      rows.filter((r) => {
        for (const [k, v] of eqFilters) {
          if (v === null) {
            if (r[k] != null) return false;
          } else if (typeof v === "object") {
            if (JSON.stringify(r[k]) !== JSON.stringify(v)) return false;
          } else if (typeof r[k] === "object" && r[k] !== null && typeof v === "string") {
            if (JSON.stringify(r[k]) !== v) return false;
          } else if (r[k] !== v) {
            return false;
          }
        }
        for (const [k, vals] of inFilters) {
          if (!vals.includes(r[k])) return false;
        }
        return true;
      });

    const execute = () => {
      if (table === "agent_settings") {
        if (action === "select") return { data: filterRows(state.agentRows), error: null };
        if (action === "update" && writePayload && typeof writePayload === "object") {
          const patch = writePayload as Record<string, unknown>;
          state.updatedAgentPayloads.push(patch);
          const matched = filterRows(state.agentRows);
          if (!matched.length) return { data: [], error: null };
          const next = { ...matched[0], ...patch };
          state.agentRows = state.agentRows.map((r) => (r.id === next.id ? next : r));
          return { data: [next], error: null };
        }
      }
      if (table === "automations") {
        if (action === "insert" && writePayload && typeof writePayload === "object") {
          const row = { id: "auto-1", ...(writePayload as Record<string, unknown>) };
          state.automationRows.push(row);
          return { data: [row], error: null };
        }
        if (action === "select") return { data: filterRows(state.automationRows), error: null };
        if (action === "update" && writePayload && typeof writePayload === "object") {
          const matched = filterRows(state.automationRows);
          if (!matched.length) return { data: [], error: null };
          const next = { ...matched[0], ...(writePayload as Record<string, unknown>) };
          state.automationRows = state.automationRows.map((r) => (r.id === next.id ? next : r));
          return { data: [next], error: null };
        }
      }
      if (table === "leads_extraidos") {
        return { data: filterRows(state.leadRows), error: null };
      }
      if (table === "campaigns") {
        if (action === "insert" && writePayload && typeof writePayload === "object") {
          const row = { id: `camp-${state.campaignRows.length + 1}`, ...(writePayload as Record<string, unknown>) };
          state.campaignRows.push(row);
          return { data: [row], error: null };
        }
        if (action === "update") return { data: filterRows(state.campaignRows), error: null };
        if (action === "delete") return { data: [], error: null };
      }
      if (table === "campaign_targets") {
        const rows = Array.isArray(writePayload) ? (writePayload as Array<Record<string, unknown>>) : [];
        if (
          state.simulatePriorityColumnMissingOnce &&
          rows.some((r) => Object.prototype.hasOwnProperty.call(r, "priority"))
        ) {
          state.simulatePriorityColumnMissingOnce = false;
          return { data: null, error: { code: "PGRST204", message: "Could not find the 'priority' column" } };
        }
        state.upsertedTargets.push(...rows);
        return { data: rows, error: null };
      }
      if (table === "channel_connections") {
        return { data: [{ instance_name: "inst-e2e", agent_id: 2, client_id: "tenant-e2e" }], error: null };
      }
      return { data: [], error: null };
    };

    const builder: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "gte", "gt", "lt", "neq", "ilike", "or", "filter", "not"]) {
      builder[m] = vi.fn(() => builder);
    }
    builder.eq = vi.fn((col: string, val: unknown) => {
      eqFilters.push([col, val]);
      return builder;
    });
    builder.is = vi.fn((col: string, val: unknown) => {
      eqFilters.push([col, val]);
      return builder;
    });
    builder.in = vi.fn((col: string, vals: unknown[]) => {
      inFilters.push([col, vals]);
      return builder;
    });
    builder.insert = vi.fn((payload: unknown) => {
      action = "insert";
      writePayload = payload;
      return builder;
    });
    builder.update = vi.fn((payload: unknown) => {
      action = "update";
      writePayload = payload;
      return builder;
    });
    builder.upsert = vi.fn((payload: unknown) => {
      action = "upsert";
      writePayload = payload;
      return builder;
    });
    builder.delete = vi.fn(() => {
      action = "delete";
      return builder;
    });
    builder.single = vi.fn(async () => {
      const res = execute();
      return { data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data, error: res.error };
    });
    builder.maybeSingle = vi.fn(async () => {
      const res = execute();
      return { data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data, error: res.error };
    });
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(execute()).then(resolve, reject);
    return builder;
  });

  return { supabaseAdmin: { from } };
});

import { PATCH as settingsPatch } from "../../app/api/agent/settings/route";
import { POST as automationsPost } from "../../app/api/automations/route";
import { PATCH as automationPatch } from "../../app/api/automations/[id]/route";
import { POST as campaignsPost } from "../../app/api/campaigns/route";
import { POST as prospecCampaignsPost } from "../../app/api/prospeccao-sites/campaigns/route";
import { POST as agentProcessPost } from "../../app/api/agent/process/route";
import { auditLeadWebsite, clearEnrichmentCachesForTest, enrichCapturedLead } from "../scraper-lead-enrichment";

describe("V2.5 End-to-End API, Security (SSRF/Tenant) e Latência de Avaliadores", () => {
  beforeEach(() => {
    clearEnrichmentCachesForTest();
    state.auth = {
      ok: true,
      clientId: "tenant-e2e",
      isAdmin: false,
      impersonating: false,
      claims: {
        clientId: "tenant-e2e",
        isAdmin: false,
        impersonating: false,
        sessionId: "sess-e2e",
        features: {
          automacao: true,
          prospeccao_sites: true,
          disparo: true,
        },
      } as typeof state.auth.claims,
    };
    state.internalSecret = false;
    state.simulatePriorityColumnMissingOnce = false;
    state.agentRows = [
      {
        id: 2,
        client_id: "tenant-e2e",
        name: "Sarah SDR",
        is_active: true,
        target_model: "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
        main_prompt: "Você é a Sarah.",
        options: {
          google_tokens: { refresh_token: "secret-oauth-token" },
          sdr_enrichment_dossier_enabled: false,
          site_preview_auto_detect: true,
        },
      },
    ];
    state.automationRows = [];
    state.leadRows = [
      {
        id: 10,
        client_id: "tenant-e2e",
        remoteJid: "5511900000010@s.whatsapp.net",
        nome_negocio: "Clínica Recepção Score 60",
        ramo_negocio: "Estética",
        opt_out: false,
        avaliacao: "4.5",
        reviews: "20",
        business_details: {
          enrichment: { qualificationScore: 60, whatsappChannelType: "recepcao_comercial" },
        },
      },
      {
        id: 11,
        client_id: "tenant-e2e",
        remoteJid: "5511900000011@s.whatsapp.net",
        nome_negocio: "Clínica Sócio Direto Score 60",
        ramo_negocio: "Estética",
        opt_out: false,
        avaliacao: "4.9",
        reviews: "90",
        business_details: {
          enrichment: {
            qualificationScore: 60,
            whatsappChannelType: "socio_direto",
            hasPaidTrafficTag: true,
            managementTools: ["Doctoralia"],
          },
        },
      },
      {
        id: 12,
        client_id: "tenant-e2e",
        remoteJid: "5511900000012@s.whatsapp.net",
        nome_negocio: "Clínica Top Score 85",
        ramo_negocio: "Estética",
        opt_out: false,
        avaliacao: "5.0",
        reviews: "150",
        business_details: {
          enrichment: { qualificationScore: 85, whatsappChannelType: "socio_direto" },
        },
      },
    ];
    state.campaignRows = [];
    state.upsertedTargets = [];
    state.updatedAgentPayloads = [];
    state.evaluatePreviewSpy.mockReset();
    state.startAiChatSpy.mockReset();
  });

  it("PATCH /api/agent/settings salva e preserva sdr_enrichment_dossier_enabled mantendo google_tokens intacto", async () => {
    state.auth.isAdmin = true;
    const reqEnable = new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: 2,
        section: "identity",
        name: "Sarah SDR",
        options: { sdr_enrichment_dossier_enabled: true },
      }),
    });
    const resEnable = await settingsPatch(reqEnable);
    expect(resEnable.status).toBe(200);
    const savedOpts = state.updatedAgentPayloads[0]?.options as Record<string, unknown>;
    expect(savedOpts.sdr_enrichment_dossier_enabled).toBe(true);
    expect(savedOpts.google_tokens).toEqual({ refresh_token: "secret-oauth-token" });

    // Partial update omitting sdr_enrichment_dossier_enabled MUST preserve true
    const reqPartial = new NextRequest("http://localhost/api/agent/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: 2,
        section: "identity",
        name: "Sarah SDR",
        options: { humanize_messages: true },
      }),
    });
    const resPartial = await settingsPatch(reqPartial);
    expect(resPartial.status).toBe(200);
    const savedOpts2 = state.updatedAgentPayloads[1]?.options as Record<string, unknown>;
    expect(savedOpts2.sdr_enrichment_dossier_enabled).toBe(true);
  });

  it("POST /api/automations e PATCH /api/automations/[id] aceitam boolean prioritize_by_score e rejeitam valor inválido com 400", async () => {
    const badReq = new NextRequest("http://localhost/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Auto Inválida",
        instance_name: "inst-e2e",
        scrape_filters: { prioritize_by_score: "sim" },
      }),
    });
    const badRes = await automationsPost(badReq);
    expect(badRes.status).toBe(400);

    const okReq = new NextRequest("http://localhost/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Auto Score",
        instance_name: "inst-e2e",
        niches: ["Estética"],
        regions: ["São Paulo"],
        scrape_filters: { prioritize_by_score: false },
      }),
    });
    const okRes = await automationsPost(okReq);
    expect(okRes.status).toBe(200);

    const patchReq = new NextRequest("http://localhost/api/automations/auto-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scrape_filters: { prioritize_by_score: true },
      }),
    });
    const patchRes = await automationPatch(patchReq, { params: Promise.resolve({ id: "auto-1" }) });
    expect(patchRes.status).toBe(200);
    expect((state.automationRows[0].scrape_filters as Record<string, unknown>).prioritize_by_score).toBe(true);
  });

  it("POST /api/prospeccao-sites/campaigns e POST /api/campaigns ordenam fila por Score ICP e suportam fallback PGRST204", async () => {
    const resProspec = await prospecCampaignsPost(
      new NextRequest("http://localhost/api/prospeccao-sites/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Camp Sites Score",
          instance_name: "inst-e2e",
          message_template: "{{abertura_inteligente}}",
          lead_ids: [10, 11, 12],
          order_by: "qualification",
          order_dir: "desc",
        }),
      }),
    );
    expect(resProspec.status).toBe(200);
    expect(state.upsertedTargets.map((t) => t.remote_jid)).toEqual([
      "5511900000012@s.whatsapp.net", // Score 85 -> 853
      "5511900000011@s.whatsapp.net", // Score 60 + socio_direto + Ads + tools -> 605
      "5511900000010@s.whatsapp.net", // Score 60 + recepcao -> 600
    ]);

    state.upsertedTargets = [];
    state.simulatePriorityColumnMissingOnce = true;
    const resDisparo = await campaignsPost(
      new NextRequest("http://localhost/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Camp Disparo PGRST204 Fallback",
          instance_name: "inst-e2e",
          message_template: "Oi!",
          lead_ids: [10, 11, 12],
          prioritize_by_score: true,
        }),
      }),
    );
    expect(resDisparo.status).toBe(200);
    // Ordem preservada mesmo após remover `priority` no retry PGRST204
    expect(state.upsertedTargets.map((t) => t.remote_jid)).toEqual([
      "5511900000012@s.whatsapp.net",
      "5511900000011@s.whatsapp.net",
      "5511900000010@s.whatsapp.net",
    ]);
  });

  it("bloqueia SSRF em subpáginas /contato e links internos privados em Linktree V2.5", async () => {
    const calledUrls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calledUrls.push(url);
      if (url.includes("linktr.ee/ssrfcheck")) {
        return new Response(
          `<html><body>
            <a href="http://127.0.0.1:8080/admin">Local</a>
            <a href="http://169.254.169.254/latest/meta-data/">IMDS</a>
            <a href="http://localhost:3000/secret">Localhost</a>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.startsWith("https://sitepublico.com.br")) {
        return new Response(
          `<html><body>
            <a href="https://sitepublico.com.br/contato"></a>
            <a href="http://127.0.0.1/contato">Local</a>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    });

    const bioOut = await enrichCapturedLead({
      name: "Clínica SSRF Safe",
      phone: "11999990000",
      website: "https://linktr.ee/ssrfcheck",
      options: { auditSiteHealth: true, enrichCnpj: false, prioritizePartnerPhone: false, validateWhatsApp: false },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(bioOut.siteAudit.discoveredRealWebsite).toBeUndefined();
    expect(calledUrls.some((u) => /127\.0\.0\.1|localhost|169\.254\.169\.254/i.test(u))).toBe(false);

    await auditLeadWebsite("https://sitepublico.com.br", mockFetch as unknown as typeof fetch);
    expect(calledUrls.some((u) => /127\.0\.0\.1|localhost|169\.254\.169\.254/i.test(u))).toBe(false);
  });

  it("pula evaluatePreviewAgreement no Turno 1 de recepção/saudação e dispara quando há contexto de prévia", async () => {
    state.startAiChatSpy.mockResolvedValue({
      provider: "openrouter",
      modelUsed: () => "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
      sendUser: vi.fn(async () => ({
        text: "Oi! Consigo falar com a responsável?",
        toolCalls: [],
        usage: { promptTokens: 50, completionTokens: 12, totalTokens: 62 },
      })),
      sendToolResults: vi.fn(),
    });
    state.evaluatePreviewSpy.mockResolvedValue({
      agreed: true,
      confidence: "high",
      reason: "Cliente aceitou prévia",
      evaluatorMethod: "llm",
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
    });

    // Turno 1 recepção: nenhuma menção a prévia/site no histórico nem na fala -> avaliador NÃO é chamado
    const res1 = await agentProcessPost(
      new NextRequest("http://localhost/api/agent/process", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-agent-id": "2" },
        body: JSON.stringify({
          instanceName: "inst-e2e",
          remoteJid: "5511999991111@s.whatsapp.net",
          text: "Bom dia, aqui é da recepção, quem gostaria?",
          isTestMode: true,
          testHistory: [{ role: "assistant", content: "Bom dia! Tudo bem?" }],
        }),
      }),
    );
    expect(res1.status).toBe(200);
    expect(state.evaluatePreviewSpy).not.toHaveBeenCalled();

    // Turno 2 pós-oferta: avaliador É chamado e promove previa_status para PREVIA_SOLICITADA
    const res2 = await agentProcessPost(
      new NextRequest("http://localhost/api/agent/process", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-agent-id": "2" },
        body: JSON.stringify({
          instanceName: "inst-e2e",
          remoteJid: "5511999991111@s.whatsapp.net",
          text: "Pode mandar sim!",
          isTestMode: true,
          testHistory: [
            { role: "agent", content: "Posso preparar uma prévia sem custo do seu site?" },
          ],
        }),
      }),
    );
    const json2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(state.evaluatePreviewSpy).toHaveBeenCalledTimes(1);
    expect(json2.testStateUpdate?.previa_status).toBe("PREVIA_SOLICITADA");
  });
});
