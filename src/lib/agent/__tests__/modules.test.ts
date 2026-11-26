// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildAgentFunctionDeclarations } from "../tool-declarations";
import {
  collectValidImageUrls,
  sanitizeHallucinatedImages,
  splitChunkSegmentsWithCaptions,
} from "../image-whitelist";

describe("src/lib/agent/tool-declarations & image-whitelist", () => {
  it("monta somente as tools habilitadas e omite estoque/calendário quando desativados", () => {
    const tools = buildAgentFunctionDeclarations({
      knowledgeTopics: [{ title: "Preços" }],
      hasCatalogOrPhotoKb: false,
      sitePreviewAutoDetect: false,
      hasPreviaOrLink: false,
      webSearchEnabled: false,
      calendarEnabled: false,
      calendarDuration: 30,
      calendarOptionalFields: {},
      calendarAutoCapture: {},
      necessidadeLabel: "Necessidade",
      customTools: [],
      activeStage: null,
    });
    expect(tools.map((t) => t.name)).toEqual(["search_knowledge_base"]);

    const fullTools = buildAgentFunctionDeclarations({
      knowledgeTopics: [{ title: "Catálogo" }],
      hasCatalogOrPhotoKb: true,
      sitePreviewAutoDetect: true,
      hasPreviaOrLink: false,
      webSearchEnabled: true,
      calendarEnabled: true,
      calendarDuration: 45,
      calendarOptionalFields: { nome: true, email: true },
      calendarAutoCapture: { empresa: true, necessidade: true },
      necessidadeLabel: "Objetivo",
      customTools: [{ name: "cep_lookup", description: "Consulta CEP" }],
      activeStage: { captured_variables: [{ name: "cidade", description: "Cidade" }] },
    });
    expect(fullTools.map((t) => t.name)).toEqual([
      "search_knowledge_base",
      "update_product_stock",
      "solicitar_previa_site",
      "agendar_reuniao_fechamento",
      "web_search",
      "web_fetch",
      "schedule_google_calendar",
      "check_google_calendar_availability",
      "list_google_calendar_events",
      "cancel_google_calendar_event",
      "cep_lookup",
      "save_variables",
      "complete_current_stage",
    ]);
  });

  it("filtra imagens fora da whitelist e transforma texto anterior curto em legenda da foto", () => {
    const valid = new Set<string>();
    collectValidImageUrls("Foto oficial [IMAGEM: https://cdn.teste/produto.jpg]", valid);
    expect(valid.has("https://cdn.teste/produto.jpg")).toBe(true);

    const sanitized = sanitizeHallucinatedImages(
      "Confira [IMAGEM: https://cdn.teste/produto.jpg]\n![fake](https://evil.teste/fake.png)",
      valid,
    );
    expect(sanitized).toBe("Confira [IMAGEM: https://cdn.teste/produto.jpg]");

    const { segments, hasImages } = splitChunkSegmentsWithCaptions(
      "iPhone 15 — R$ 4.500 [IMAGEM: https://cdn.teste/produto.jpg]",
    );
    expect(hasImages).toBe(true);
    expect(segments[0]).toMatchObject({ kind: "text", consumed: true });
    expect(segments[1]).toEqual({
      kind: "image",
      url: "https://cdn.teste/produto.jpg",
      caption: "iPhone 15 — R$ 4.500",
    });
  });

  it("delivery.ts faz auto-migração única de instância em erro 404 sem duplicar envios", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase_admin", () => ({
      supabaseAdmin: {
        from: (table: string) => {
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            in: () => chain,
            limit: async () => ({
              data: table === "channel_connections" ? [{ instance_name: "inst-backup" }] : [],
              error: null,
            }),
            insert: () => ({ then: (r: (v: unknown) => void) => Promise.resolve({ error: null }).then(r) }),
            update: () => chain,
            then: (r: (v: unknown) => void) => Promise.resolve({ error: null }).then(r),
          };
          return chain;
        },
      },
    }));
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "404 instance does not exist" })
      .mockResolvedValueOnce({ ok: true, messageId: "ok-migrated" });
    const { createWhatsAppDeliveryHelpers } = await import("../delivery");
    const helpers = createWhatsAppDeliveryHelpers({
      channelMod: {
        sendMessage,
        sendMedia: vi.fn(),
      },
      remoteJid: "5511999990000@s.whatsapp.net",
      clientId: "tenant-1",
      initialInstanceName: "inst-dead",
      sessionId: "sess-1",
      isTestMode: false,
      typingDelaySeconds: 1,
      customerInboundCount: 2,
      sentMediaRecently: new Map(),
    });

    const msgId = await helpers.sendAndPersistText("Olá!");
    expect(msgId).toBe("ok-migrated");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][2]).toBe("inst-backup");
    expect(helpers.getState().instanceName).toBe("inst-backup");
    expect(helpers.getState().anySendError).toBeNull();
  });

  it("prompt-builder mantém promptMaster byte-idêntico entre leads distintos e isola variáveis em turnContextBlock", async () => {
    const { buildAgentPromptBundle } = await import("../prompt-builder");
    const common = {
      agentConfig: { name: "Sarah", role: "SDR", personality: "Direta", tone: "Consultivo" },
      processedMainPrompt: "Apresente o plano {{plano}}.",
      knowledgeTopics: [{ title: "Catálogo" }, { title: "Garantia" }],
      manuallyInsertedKbTitles: new Set(["Garantia"]),
      hasCatalogOrPhotoKb: true,
      calendarEnabled: true,
      calendarDuration: 30,
      calendarOptionalFields: { email: true },
      funilInstrucao: "Qualificação inicial",
      capturedVariablesPrompt: "- cidade",
    };

    const leadA = buildAgentPromptBundle({
      ...common,
      leadContextBlock: "Empresa: Clínica Alpha",
      promptVariablesLines: ["plano: Pro"],
    });
    const leadB = buildAgentPromptBundle({
      ...common,
      leadContextBlock: "Empresa: Clínica Beta",
      promptVariablesLines: ["plano: Enterprise"],
    });

    expect(leadA.promptMaster).toBe(leadB.promptMaster);
    expect(leadA.promptMaster).toContain("Base de conhecimento (tópicos): Catálogo.");
    expect(leadA.promptMaster).toContain("[IMAGEM:");
    expect(leadA.turnContextBlock).toContain("Clínica Alpha");
    expect(leadB.turnContextBlock).toContain("Clínica Beta");
    expect(leadB.turnContextBlock).toContain("plano: Enterprise");

    const noFunnel = buildAgentPromptBundle({
      ...common,
      funilInstrucao: "",
      capturedVariablesPrompt: "",
      leadContextBlock: "Empresa: Clínica Gama",
      promptVariablesLines: [],
    });
    expect(noFunnel.turnContextBlock).not.toContain("<current_funnel_stage>");
    expect(noFunnel.turnContextBlock).not.toContain("<data_collection_goals>");
  });

  it("appendSitePreviewContextLines injeta apenas fatos de estado sem sobrescrever roteiro nem pular o Passo 5.1", async () => {
    const { appendSitePreviewContextLines } = await import("../site-preview-context");

    const phase1Lines: string[] = [];
    appendSitePreviewContextLines(
      phase1Lines,
      { nome_negocio: "Piu Piu Ar condicionado Franco da Rocha", previa_status: null },
      { options: {} },
      true,
    );
    const phase1Text = phase1Lines.join("\n");
    expect(phase1Text).toContain("AINDA NÃO SOLICITADA");
    expect(phase1Text).toContain("solicitar_previa_site");
    expect(phase1Text).not.toContain("Msg 8.1");
    expect(phase1Text).not.toContain("Msg 8.2");
    expect(phase1Text).not.toContain("a gente já te chama aqui com o link");

    const phase2Lines: string[] = [];
    appendSitePreviewContextLines(
      phase2Lines,
      {
        nome_negocio: "Piu Piu Ar condicionado Franco da Rocha",
        previa_status: "PREVIA_PRONTA",
        link_previa: "https://piupiu.vercel.app",
      },
      { options: { site_preview_confirm_before_link: false } },
      true,
    );
    const phase2Text = phase2Lines.join("\n");
    expect(phase2Text).toContain("https://piupiu.vercel.app");
    expect(phase2Text).toContain("PRIORIDADE DE ROTEIRO");
    expect(phase2Text).not.toContain("2 a 5 min");
    expect(phase2Text).not.toContain("Proibido falar domínio");
  });
});

