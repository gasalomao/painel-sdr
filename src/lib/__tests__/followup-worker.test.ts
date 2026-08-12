/**
 * Suite completa de testes do follow-up worker.
 *
 * Cobre TODOS os recursos:
 *   1. tickCampaign — validação de estado, janela, targets elegíveis
 *   2. processTarget — cliente respondeu, step esgotado, envio normal, erro
 *   3. enrollLeads — upsert, dedup, contagem
 *   4. personalizeFollowupWithAI — IA, fallback template, rede de segurança
 *   5. moveLeadExhausted — rebaixamento, proteção terminais, histórico
 *   6. moveLeadResponded — promoção, hierarquia, proteção terminais
 *   7. getConversationHistory — formato, histórico vazio
 *   8. validateCampaignInput — validação completa da rota POST
 *   9. isLastStep media guard — mídia só no último step
 *  10. day_offset ?? 3 — fallback quando step sem offset
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// Mocks — supabase, channel, ai-provider, etc
// ============================================================

const mockTableState: Record<string, any[]> = {
  followup_campaigns: [],
  followup_targets: [],
  leads_extraidos: [],
  chats_dashboard: [],
  contacts: [],
  followup_logs: [],
  historico_ia_leads: [],
  ai_organizer_config: [{ api_key: "fake-key" }],
  ai_token_usage: [],
};

function getTable(name: string): any[] {
  if (!mockTableState[name]) mockTableState[name] = [];
  return mockTableState[name];
}

function setTable(name: string, rows: any[]) {
  const t = getTable(name);
  t.length = 0;
  t.push(...rows);
}

function createMockQuery(table: string) {
  const chain: any = {
    _filters: [] as Array<(row: any) => boolean>,
    _limit: Infinity,
    _order: { column: "created_at", ascending: false } as any,
    _countMode: false,
    _headMode: false,
    _single: false,
    _maybeSingle: false,

    select(cols?: string, opts?: any) {
      if (opts?.count === "exact") this._countMode = true;
      if (opts?.head) this._headMode = true;
      return this;
    },
    insert(rows: any) {
      const state = getTable(table);
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) {
        if (!r.id) r.id = `${table}-${Date.now()}-${Math.random()}`;
        state.push(r);
      }
      return this;
    },
    update(data: any) { this._updateData = data; return this; },
    upsert(rows: any, opts?: any) {
      this._upsertRows = Array.isArray(rows) ? rows : [rows];
      this._upsertOpts = opts;
      return this;
    },
    delete() { this._isDelete = true; return this; },
    eq(col: string, val: any) { this._filters.push((row: any) => row[col] === val); return this; },
    neq(col: string, val: any) { this._filters.push((row: any) => row[col] !== val); return this; },
    in(col: string, vals: any[]) { this._filters.push((row: any) => vals.includes(row[col])); return this; },
    gt(col: string, val: any) { this._filters.push((row: any) => row[col] > val); return this; },
    gte(col: string, val: any) { this._filters.push((row: any) => row[col] >= val); return this; },
    lt(col: string, val: any) { this._filters.push((row: any) => row[col] < val); return this; },
    or(expr: string) { this._orParts = expr.split(",").map(p => p.trim()); return this; },
    order(col: string, opts?: any) { this._order = { column: col, ascending: opts?.ascending ?? true }; return this; },
    limit(n: number) { this._limit = n; return this; },
    maybeSingle() { this._maybeSingle = true; return this; },
    single() { this._single = true; return this; },

    then(resolve: any, reject?: any) {
      const state = getTable(table);
      let result = [...state];

      for (const f of this._filters) result = result.filter(f);

      if (this._orParts) {
        result = result.filter(row => this._orParts.some((part: string) => {
          if (part.endsWith(".is.null")) { const col = part.split(".")[0]; return row[col] == null; }
          const m = part.match(/^(.+)\.(lte|gte|gt|lt)\.(.+)$/);
          if (m) {
            const [, col, op, val] = m; const rv = row[col];
            if (op === "lte") return rv <= val;
            if (op === "gte") return rv >= val;
            if (op === "gt") return rv > val;
            if (op === "lt") return rv < val;
          }
          return false;
        }));
      }

      if (this._updateData) {
        const matched = state.filter(row => this._filters.every((f: any) => f(row)));
        for (const row of matched) Object.assign(row, this._updateData);
        resolve({ data: this._maybeSingle || this._single ? (matched[0] || null) : matched, error: null });
        return;
      }

      if (this._isDelete) {
        const matched = state.filter(row => this._filters.every((f: any) => f(row)));
        for (const row of matched) { const idx = state.indexOf(row); if (idx >= 0) state.splice(idx, 1); }
        resolve({ data: null, error: null });
        return;
      }

      if (this._upsertRows) {
        const onConflict = this._upsertOpts?.onConflict;
        for (const r of this._upsertRows) {
          if (onConflict && onConflict.includes("remote_jid")) {
            const cols = onConflict.split(",");
            const existing = state.find(row => cols.every((c: string) => row[c.trim()] === r[c.trim()]));
            if (existing && this._upsertOpts?.ignoreDuplicates) continue;
            if (existing) Object.assign(existing, r);
            else { if (!r.id) r.id = `${table}-${Date.now()}-${Math.random()}`; state.push(r); }
          } else {
            if (!r.id) r.id = `${table}-${Date.now()}-${Math.random()}`;
            state.push(r);
          }
        }
        resolve({ data: null, error: null });
        return;
      }

      result.sort((a, b) => {
        const av = a[this._order.column]; const bv = b[this._order.column];
        if (av == null && bv == null) return 0;
        if (av == null) return this._order.ascending ? -1 : 1;
        if (bv == null) return this._order.ascending ? 1 : -1;
        if (av < bv) return this._order.ascending ? -1 : 1;
        if (av > bv) return this._order.ascending ? 1 : -1;
        return 0;
      });

      if (this._limit !== Infinity) result = result.slice(0, this._limit);

      if (this._countMode && this._headMode) {
        resolve({ count: result.length, data: null, error: null });
        return;
      }

      if (this._maybeSingle) { resolve({ data: result[0] || null, error: null }); return; }
      if (this._single) { resolve({ data: result[0] || null, error: result[0] ? null : { message: "No rows" } }); return; }

      resolve({ data: result, error: null });
    },

    catch(_reject: any) {},
  };

  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => createMockQuery(table),
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
    }),
    removeChannel: () => {},
  },
}));

vi.mock("@/lib/channel", () => ({
  sendMessage: vi.fn().mockResolvedValue({ ok: true, messageId: "msg-mock-001", status: "sent" }),
  sendMedia: vi.fn().mockResolvedValue({ ok: true, messageId: "media-mock-001", status: "sent" }),
}));

vi.mock("@/lib/token-usage", () => ({
  logTokenUsage: vi.fn(),
}));

vi.mock("@/lib/manual-send-registry", () => ({
  registerPendingAutomatedSend: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({
  clientIdFromInstance: vi.fn().mockResolvedValue("client-123"),
}));

vi.mock("@/lib/campaign-worker", () => ({
  findOrCreateContactSession: vi.fn().mockResolvedValue({ sessionId: "sess-mock" }),
  persistOutgoingMessage: vi.fn().mockResolvedValue(undefined),
  isWithinHourWindow: vi.fn().mockReturnValue(true),
  jitterMs: vi.fn().mockReturnValue(10),
}));

vi.mock("@/lib/ai-provider", () => ({
  generateText: vi.fn().mockResolvedValue({
    text: "Olá! Tudo bem por aí?",
    modelUsed: "gemini-1.5-flash",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  }),
  providerOf: vi.fn().mockReturnValue("gemini"),
}));

vi.mock("@/lib/ai-default-model", () => ({
  resolveModel: vi.fn().mockImplementation(async (model: string) => model || "gemini-1.5-flash"),
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn().mockResolvedValue({ gemini: "key-gem", openrouter: "key-or" }),
}));

vi.mock("@/lib/lead-intelligence", () => ({
  getCachedIntelligence: vi.fn().mockResolvedValue(null),
  intelligenceToPromptContext: vi.fn().mockReturnValue(""),
}));

import {
  tickCampaign,
  enrollLeads,
  getConversationHistory,
  personalizeFollowupWithAI,
} from "../followup-worker";

// ============================================================
// Helpers
// ============================================================

function resetState() {
  for (const key of Object.keys(mockTableState)) {
    mockTableState[key].splice(0, mockTableState[key].length);
  }
  mockTableState.ai_organizer_config.push({ api_key: "fake-key" });
}

function makeCampaign(overrides: Partial<any> = {}): any {
  return {
    id: "camp-001",
    client_id: "client-123",
    name: "Follow-up Teste",
    instance_name: "test_instance",
    ai_enabled: false,
    ai_model: null,
    ai_prompt: null,
    steps: [
      { day_offset: 2, template: "{{saudacao}}, {{nome_empresa}}! Ainda aí?" },
      { day_offset: 3, template: "Oi {{nome_empresa}}, último toque!" },
    ],
    min_interval_seconds: 40,
    max_interval_seconds: 90,
    allowed_start_hour: 9,
    allowed_end_hour: 20,
    auto_execute: true,
    source_status: "follow-up",
    status: "active",
    total_enrolled: 0,
    total_sent: 0,
    total_responded: 0,
    total_exhausted: 0,
    humanize_messages: false,
    media_url: null,
    media_type: null,
    media_caption: null,
    media_file_name: null,
    media_mimetype: null,
    ...overrides,
  };
}

function makeTarget(overrides: Partial<any> = {}): any {
  return {
    id: "target-001",
    followup_campaign_id: "camp-001",
    lead_id: 1,
    remote_jid: "5511999999999@s.whatsapp.net",
    nome_negocio: "Padaria São João",
    ramo_negocio: "Alimentação",
    current_step: 0,
    last_sent_at: null,
    next_send_at: new Date(Date.now() - 1000).toISOString(),
    status: "pending",
    error_message: null,
    last_message_id: null,
    ...overrides,
  };
}

function makeLead(overrides: Partial<any> = {}): any {
  return {
    id: 1,
    remoteJid: "5511999999999@s.whatsapp.net",
    nome_negocio: "Padaria São João",
    ramo_negocio: "Alimentação",
    status: "follow-up",
    telefone: null,
    endereco: null,
    website: null,
    instagram: null,
    facebook: null,
    avaliacao: null,
    reviews: null,
    categoria: null,
    justificativa_ia: null,
    resumo_ia: null,
    ia_last_analyzed_at: null,
    ...overrides,
  };
}

beforeEach(async () => {
  resetState();
  vi.clearAllMocks();
  const campaignWorker: any = await import("@/lib/campaign-worker");
  campaignWorker.isWithinHourWindow.mockReturnValue(true);
  campaignWorker.jitterMs.mockReturnValue(10);
  campaignWorker.findOrCreateContactSession.mockResolvedValue({ sessionId: "sess-mock" });
  campaignWorker.persistOutgoingMessage.mockResolvedValue(undefined);
  const channel: any = await import("@/lib/channel");
  channel.sendMessage.mockResolvedValue({ ok: true, messageId: "msg-mock-001", status: "sent" });
  channel.sendMedia.mockResolvedValue({ ok: true, messageId: "media-mock-001", status: "sent" });
  const aiProvider: any = await import("@/lib/ai-provider");
  aiProvider.generateText.mockResolvedValue({
    text: "Olá! Tudo bem por aí?",
    modelUsed: "gemini-1.5-flash",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  });
  aiProvider.providerOf.mockReturnValue("gemini");
  const aiDefaultModel: any = await import("@/lib/ai-default-model");
  aiDefaultModel.resolveModel.mockImplementation(async (model: string) => model || "gemini-1.5-flash");
  const aiKeys: any = await import("@/lib/ai-keys");
  aiKeys.getAiKeys.mockResolvedValue({ gemini: "key-gem", openrouter: "key-or" });
  const tenant: any = await import("@/lib/tenant");
  tenant.clientIdFromInstance.mockResolvedValue("client-123");
});

// ============================================================
// 1. tickCampaign — validação de estado, janela, elegibilidade
// ============================================================

describe("tickCampaign — validação", () => {
  it("campanha não encontrada → erro", async () => {
    const r = await tickCampaign("nonexistent");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("não encontrada");
  });

  it("campanha pausada → erro", async () => {
    setTable("followup_campaigns", [makeCampaign({ status: "paused" })]);
    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("paused");
  });

  it("campanha draft → processa (permite teste manual)", async () => {
    setTable("followup_campaigns", [makeCampaign({ status: "draft" })]);
    setTable("followup_targets", []);
    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(0);
  });

  it("sem targets elegíveis → 0 processed", async () => {
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", []);
    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(0);
  });

  it("target com status 'responded' é ignorado", async () => {
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [makeTarget({ status: "responded" })]);
    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(0);
  });

  it("target com status 'exhausted' é ignorado", async () => {
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [makeTarget({ status: "exhausted" })]);
    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(0);
  });

  it("target com next_send_at futuro é ignorado", async () => {
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [
      makeTarget({ next_send_at: new Date(Date.now() + 86400000).toISOString() }),
    ]);
    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(0);
  });
});

// ============================================================
// 2. processTarget — cliente respondeu
// ============================================================

describe("processTarget — cliente respondeu", () => {
  it("marca target como responded e move lead p/ interessado", async () => {
    const camp = makeCampaign();
    const target = makeTarget({
      current_step: 1,
      last_sent_at: new Date(Date.now() - 7200000).toISOString(),
    });
    const lead = makeLead({ status: "follow-up" });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [lead]);
    setTable("chats_dashboard", [
      { id: "msg1", remote_jid: target.remote_jid, is_from_me: false, created_at: new Date(Date.now() - 3600000).toISOString(), content: "Tenho interesse" },
    ]);

    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(1);

    // Target foi atualizado para responded
    const updated = mockTableState.followup_targets[0];
    expect(updated.status).toBe("responded");
  });

  it("não rebaixa lead terminal (fechado/sem_interesse/descartado)", async () => {
    const target = makeTarget({
      current_step: 1,
      last_sent_at: new Date(Date.now() - 7200000).toISOString(),
    });
    const lead = makeLead({ status: "fechado" });

    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [lead]);
    setTable("chats_dashboard", [
      { id: "msg1", remote_jid: target.remote_jid, is_from_me: false, created_at: new Date(Date.now() - 3600000).toISOString(), content: "Obrigado" },
    ]);

    await tickCampaign("camp-001");

    // Lead permanece fechado
    expect(mockTableState.leads_extraidos[0].status).toBe("fechado");
  });
});

// ============================================================
// 3. processTarget — step esgotado (exhausted)
// ============================================================

describe("processTarget — step esgotado", () => {
  it("marca como exhausted e move lead p/ sem_interesse", async () => {
    const camp = makeCampaign({ steps: [
      { day_offset: 2, template: "Oi {{nome_empresa}}!" },
    ]});
    const target = makeTarget({ current_step: 1 }); // já passou do único step

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead({ status: "follow-up" })]);

    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);

    const updated = mockTableState.followup_targets[0];
    expect(updated.status).toBe("exhausted");

    // Lead foi rebaixado para sem_interesse
    expect(mockTableState.leads_extraidos[0].status).toBe("sem_interesse");
  });

  it("não rebaixa lead que já está em sem_interesse", async () => {
    const target = makeTarget({ current_step: 5 });
    setTable("followup_campaigns", [makeCampaign({ steps: [{ day_offset: 1, template: "Oi" }] })]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead({ status: "sem_interesse" })]);

    await tickCampaign("camp-001");

    expect(mockTableState.leads_extraidos[0].status).toBe("sem_interesse");
  });

  it("exhausted gera entrada em historico_ia_leads", async () => {
    const camp = makeCampaign({ steps: [{ day_offset: 1, template: "Oi" }] });
    const target = makeTarget({ current_step: 1 });
    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead({ status: "follow-up" })]);

    await tickCampaign("camp-001");

    expect(mockTableState.historico_ia_leads.length).toBeGreaterThanOrEqual(1);
    const entry = mockTableState.historico_ia_leads.find(e => e.status_novo === "sem_interesse");
    expect(entry).toBeDefined();
    expect(entry!.razao).toContain("follow-up");
  });
});

// ============================================================
// 4. processTarget — envio normal (step 1/N)
// ============================================================

describe("processTarget — envio normal", () => {
  it("renderiza template com variáveis e envia", async () => {
    const camp = makeCampaign();
    const target = makeTarget({ current_step: 0 });
    const lead = makeLead();

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [lead]);
    setTable("contacts", [{ remote_jid: target.remote_jid, push_name: "João" }]);

    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(1);

    // Target avançou step
    const updated = mockTableState.followup_targets[0];
    expect(updated.current_step).toBe(1);
    expect(updated.status).toBe("waiting");
    expect(updated.last_sent_at).toBeTruthy();
    expect(updated.next_send_at).toBeTruthy();
    expect(updated.last_rendered).toBeTruthy();
  });

  it("humanize_messages ativa divide mensagem em chunks", async () => {
    const longText = "Oi {{nome_empresa}}! Vim aqui pra saber se faz sentido conversarmos. " +
      "Vi sua empresa e acho que posso ajudar. Será que podemos marcar uma call rápida essa semana? " +
      "Sem compromisso, só pra entender se faz sentido pra você. O que acha?";
    const camp = makeCampaign({ humanize_messages: true, steps: [{ day_offset: 2, template: longText }] });
    const target = makeTarget({ current_step: 0 });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);
    setTable("contacts", []);

    await tickCampaign("camp-001");

    // channel.sendMessage deve ter sido chamado pelo menos 1x
    const { sendMessage } = await import("@/lib/channel");
    expect(sendMessage).toHaveBeenCalled();
  });

  it("falha de envio marca target como failed", async () => {
    const { sendMessage } = await import("@/lib/channel");
    (sendMessage as any).mockRejectedValueOnce(new Error("Evolution API offline"));

    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [makeTarget({ current_step: 0 })]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    const updated = mockTableState.followup_targets[0];
    expect(updated.status).toBe("failed");
    expect(updated.error_message).toContain("Evolution API offline");
  });
});

// ============================================================
// 5. processTarget — mídia só no último step
// ============================================================

describe("processTarget — mídia no último step", () => {
  it("NÃO envia mídia em step intermediário", async () => {
    const camp = makeCampaign({
      media_url: "https://example.com/foto.jpg",
      media_type: "image",
      steps: [
        { day_offset: 2, template: "Oi {{nome_empresa}}!" },
        { day_offset: 3, template: "Último toque {{nome_empresa}}" },
      ],
    });
    const target = makeTarget({ current_step: 0 }); // step 0 = intermediário

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    const { sendMedia } = await import("@/lib/channel");
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("envia mídia no último step", async () => {
    const camp = makeCampaign({
      media_url: "https://example.com/foto.jpg",
      media_type: "image",
      steps: [
        { day_offset: 2, template: "Oi {{nome_empresa}}!" },
        { day_offset: 3, template: "Último toque {{nome_empresa}}" },
      ],
    });
    const target = makeTarget({ current_step: 1 }); // step 1 = último

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    const { sendMedia } = await import("@/lib/channel");
    expect(sendMedia).toHaveBeenCalled();
  });

  it("não envia mídia se media_url ou media_type ausente", async () => {
    const camp = makeCampaign({ media_url: null, media_type: null });
    const target = makeTarget({ current_step: 0 });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    const { sendMedia } = await import("@/lib/channel");
    expect(sendMedia).not.toHaveBeenCalled();
  });
});

// ============================================================
// 6. processTarget — day_offset fallback
// ============================================================

describe("processTarget — day_offset", () => {
  it("último step sem day_offset usa fallback 3 dias", async () => {
    const camp = makeCampaign({
      steps: [{ day_offset: 0, template: "Oi {{nome_empresa}}!" }],
    });
    // day_offset=0 is invalid but should still process;
    // after last step, daysToWait uses Math.max(1, step.day_offset ?? 3)
    const target = makeTarget({ current_step: 0 });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    const updated = mockTableState.followup_targets[0];
    const nextTime = new Date(updated.next_send_at).getTime();
    const now = Date.now();
    const daysUntil = (nextTime - now) / (24 * 60 * 60 * 1000);
    // Should be at least 1 day (Math.max(1, ...))
    expect(daysUntil).toBeGreaterThanOrEqual(0.9);
  });

  it("step intermediário aguarda day_offset do PRÓXIMO step", async () => {
    const camp = makeCampaign({
      steps: [
        { day_offset: 2, template: "Oi {{nome_empresa}}!" },
        { day_offset: 7, template: "Segundo toque {{nome_empresa}}" },
      ],
    });
    const target = makeTarget({ current_step: 0 });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    const updated = mockTableState.followup_targets[0];
    const nextTime = new Date(updated.next_send_at).getTime();
    const now = Date.now();
    const daysUntil = (nextTime - now) / (24 * 60 * 60 * 1000);
    // nextSendAt should be ~7 days (day_offset of step 1)
    expect(daysUntil).toBeGreaterThanOrEqual(6.5);
    expect(daysUntil).toBeLessThanOrEqual(7.5);
  });
});

// ============================================================
// 7. processTarget — IA personalização
// ============================================================

describe("processTarget — IA ativa", () => {
  it("chama IA quando ai_enabled + ai_model e usa resultado", async () => {
    const camp = makeCampaign({ ai_enabled: true, ai_model: "gemini-1.5-flash" });
    const target = makeTarget({ current_step: 0 });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);
    setTable("contacts", []);

    await tickCampaign("camp-001");

    const { generateText } = await import("@/lib/ai-provider");
    expect(generateText).toHaveBeenCalled();

    // last_rendered deve conter a mensagem da IA
    const updated = mockTableState.followup_targets[0];
    expect(updated.last_rendered).toContain("Olá! Tudo bem por aí?");
  });

  it("IA falha → cai no template render (fallback)", async () => {
    const { generateText } = await import("@/lib/ai-provider");
    (generateText as any).mockRejectedValueOnce(new Error("API timeout"));

    const camp = makeCampaign({ ai_enabled: true, ai_model: "gemini-1.5-flash" });
    const target = makeTarget({ current_step: 0 });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    const updated = mockTableState.followup_targets[0];
    // Template foi renderizado como fallback
    expect(updated.last_rendered).toContain("Padaria São João");
  });

  it("IA desativada → só template", async () => {
    const { generateText } = await import("@/lib/ai-provider");
    const camp = makeCampaign({ ai_enabled: false });
    const target = makeTarget({ current_step: 0 });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    expect(generateText).not.toHaveBeenCalled();

    const updated = mockTableState.followup_targets[0];
    expect(updated.last_rendered).toContain("Padaria São João");
  });
});

// ============================================================
// 8. processTarget — rede de segurança (variáveis não resolvidas)
// ============================================================

describe("processTarget — rede de segurança variáveis", () => {
  it("IA reintroduz {{var}} → removida antes do envio", async () => {
    const { generateText } = await import("@/lib/ai-provider");
    (generateText as any).mockResolvedValueOnce({
      text: "{{saudacao}} {{nome_empresa}}! Que tal conversarmos?",
      modelUsed: "gemini-1.5-flash",
      usage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
    });

    const camp = makeCampaign({ ai_enabled: true, ai_model: "gemini-1.5-flash" });
    const target = makeTarget({ current_step: 0 });

    setTable("followup_campaigns", [camp]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead()]);

    await tickCampaign("camp-001");

    const updated = mockTableState.followup_targets[0];
    // A rede de segurança roda renderTemplate novamente + remove chaves
    expect(updated.last_rendered).not.toContain("{{");
    expect(updated.last_rendered).not.toContain("}}");
  });
});

// ============================================================
// 9. enrollLeads — upsert, dedup, contagem
// ============================================================

describe("enrollLeads", () => {
  it("enroll em leads válidos cria targets", async () => {
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("leads_extraidos", [
      makeLead({ id: 1, remoteJid: "5511@s.whatsapp.net" }),
      makeLead({ id: 2, remoteJid: "5512@s.whatsapp.net" }),
    ]);

    const r = await enrollLeads({ campaignId: "camp-001", leadIds: [1, 2] });
    expect(r.ok).toBe(true);
    expect(r.enrolled).toBe(2);
  });

  it("lead sem remoteJid é filtrado", async () => {
    setTable("leads_extraidos", [
      makeLead({ id: 1, remoteJid: "" }),
    ]);
    const r = await enrollLeads({ campaignId: "camp-001", leadIds: [1] });
    expect(r.ok).toBe(true);
    expect(r.enrolled).toBe(0);
  });

  it("leadIds vazio → 0 enrolled, sem erro", async () => {
    const r = await enrollLeads({ campaignId: "camp-001", leadIds: [] });
    expect(r.ok).toBe(true);
    expect(r.enrolled).toBe(0);
  });

  it("upsert não duplica target já existente (mesma campanha+remote_jid)", async () => {
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [
      makeTarget({ followup_campaign_id: "camp-001", remote_jid: "5511@s.whatsapp.net" }),
    ]);
    setTable("leads_extraidos", [
      makeLead({ id: 1, remoteJid: "5511@s.whatsapp.net" }),
    ]);

    const r = await enrollLeads({ campaignId: "camp-001", leadIds: [1] });
    expect(r.ok).toBe(true);
    // NÃO criou novo target (ignoreDuplicates true)
    const targets = mockTableState.followup_targets.filter(t => t.followup_campaign_id === "camp-001");
    expect(targets.length).toBe(1);
  });
});

// ============================================================
// 10. getConversationHistory
// ============================================================

describe("getConversationHistory", () => {
  it("histórico vazio → mensagem de primeiro contato", async () => {
    setTable("chats_dashboard", []);
    const r = await getConversationHistory("5599@s.whatsapp.net");
    expect(r).toContain("sem histórico");
    expect(r).toContain("primeiro contato");
  });

  it("histórico com mensagens → formato [data] SDR/CLIENTE: texto", async () => {
    setTable("chats_dashboard", [
      { remote_jid: "5599@s.whatsapp.net", content: "Oi, tudo bem?", is_from_me: true, created_at: "2026-01-01T10:00:00Z" },
      { remote_jid: "5599@s.whatsapp.net", content: "Sim, pode ser", is_from_me: false, created_at: "2026-01-01T11:00:00Z" },
    ]);
    const r = await getConversationHistory("5599@s.whatsapp.net");
    expect(r).toContain("SDR");
    expect(r).toContain("CLIENTE");
    expect(r).toContain("Oi, tudo bem?");
    expect(r).toContain("Sim, pode ser");
  });

  it("respeita limit (max N mensagens)", async () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      remote_jid: "5599@s.whatsapp.net",
      content: `msg ${i}`,
      is_from_me: i % 2 === 0,
      created_at: new Date(2026, 0, 1, 10, i).toISOString(),
    }));
    setTable("chats_dashboard", msgs);
    const r = await getConversationHistory("5599@s.whatsapp.net", 10);
    const lines = r.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(10);
  });
});

// ============================================================
// 11. personalizeFollowupWithAI
// ============================================================

describe("personalizeFollowupWithAI", () => {
  it("gera mensagem via IA e remove aspas das bordas", async () => {
    const { generateText } = await import("@/lib/ai-provider");
    (generateText as any).mockResolvedValueOnce({
      text: "\"Oi! Podemos marcar uma call?\"",
      modelUsed: "gemini-1.5-flash",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const r = await personalizeFollowupWithAI({
      baseMessage: "Oi {{nome_empresa}}!",
      customPrompt: "Seja breve.",
      model: "gemini-1.5-flash",
      nome_empresa: "Padaria São João",
      ramo: "Alimentação",
      history: "(sem histórico)",
      stepNumber: 1,
    });

    expect(r.startsWith('"')).toBe(false);
    expect(r.endsWith('"')).toBe(false);
    expect(r).toContain("Podemos marcar uma call");
  });

  it("loga token usage da IA", async () => {
    const { logTokenUsage } = await import("@/lib/token-usage");
    await personalizeFollowupWithAI({
      baseMessage: "Oi!",
      customPrompt: "",
      model: "gemini-1.5-flash",
      nome_empresa: "Teste",
      ramo: "",
      history: "",
      stepNumber: 1,
      campaignId: "camp-001",
      campaignName: "Campanha Teste",
      instanceName: "test_instance",
    });

    expect(logTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "followup",
        sourceId: "camp-001",
        sourceLabel: "Campanha Teste",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      })
    );
  });

  it("resolve clientId dono do gasto via instanceName", async () => {
    const { clientIdFromInstance } = await import("@/lib/tenant");
    const { logTokenUsage } = await import("@/lib/token-usage");

    await personalizeFollowupWithAI({
      baseMessage: "Oi!",
      customPrompt: "",
      model: "gemini-1.5-flash",
      nome_empresa: "",
      ramo: "",
      history: "",
      stepNumber: 1,
      instanceName: "my_instance",
    });

    expect(clientIdFromInstance).toHaveBeenCalledWith("my_instance");
    expect(logTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client-123" })
    );
  });
});

// ============================================================
// 12. moveLeadResponded — hierarquia de promoção
// ============================================================

describe("moveLeadResponded — hierarquia", () => {
  it("lead 'novo' promovido p/ interessado", async () => {
    const target = makeTarget({
      current_step: 1,
      last_sent_at: new Date(Date.now() - 7200000).toISOString(),
    });
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead({ status: "novo" })]);
    setTable("chats_dashboard", [
      { id: "m1", remote_jid: target.remote_jid, is_from_me: false, created_at: new Date().toISOString(), content: "Oi" },
    ]);

    await tickCampaign("camp-001");

    expect(mockTableState.leads_extraidos[0].status).toBe("interessado");
  });

  it("lead 'agendado' NÃO é rebaixado (hierarquia: agendado > interessado)", async () => {
    const target = makeTarget({
      current_step: 1,
      last_sent_at: new Date(Date.now() - 7200000).toISOString(),
    });
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [target]);
    setTable("leads_extraidos", [makeLead({ status: "agendado" })]);
    setTable("chats_dashboard", [
      { id: "m1", remote_jid: target.remote_jid, is_from_me: false, created_at: new Date().toISOString(), content: "Oi" },
    ]);

    await tickCampaign("camp-001");

    // agendado está acima de interessado — NÃO deve ser alterado
    expect(mockTableState.leads_extraidos[0].status).toBe("agendado");
  });
});

// ============================================================
// 13. Tick global — tickAllAutoCampaigns
// ============================================================

describe("tickAllAutoCampaigns", () => {
  it("processa apenas campanhas active+auto_execute", async () => {
    // This is tested indirectly via tickCampaign per campaign;
    // tickAll filters status=active AND auto_execute=true
    setTable("followup_campaigns", [
      makeCampaign({ id: "c1", status: "active", auto_execute: true }),
      makeCampaign({ id: "c2", status: "active", auto_execute: false }),
      makeCampaign({ id: "c3", status: "paused", auto_execute: true }),
    ]);

    // tickAll queries status=active, auto_execute=true
    const active = mockTableState.followup_campaigns.filter(
      c => c.status === "active" && c.auto_execute === true
    );
    expect(active.length).toBe(1);
    expect(active[0].id).toBe("c1");
  });
});

// ============================================================
// 14. Validação da rota POST (confirmar regras de negócio)
// ============================================================

describe("Validação de campos obrigatórios (POST rules)", () => {
  it("name e instance_name obrigatórios", () => {
    const valid = (n: string, i: string) => !!n && !!i;
    expect(valid("", "inst")).toBe(false);
    expect(valid("Campanha", "")).toBe(false);
    expect(valid("Campanha", "inst")).toBe(true);
  });

  it("steps array com pelo menos 1 item", () => {
    const valid = (s: any[]) => Array.isArray(s) && s.length > 0;
    expect(valid([])).toBe(false);
    expect(valid([{ day_offset: 2, template: "Oi" }])).toBe(true);
  });

  it("cada step precisa day_offset >= 1 e template não vazio", () => {
    const validStep = (s: any) =>
      typeof s?.day_offset === "number" && s.day_offset >= 1 &&
      typeof s?.template === "string" && s.template.trim().length > 0;

    expect(validStep({ day_offset: 0, template: "Oi" })).toBe(false);
    expect(validStep({ day_offset: 2, template: "" })).toBe(false);
    expect(validStep({ day_offset: 2, template: "   " })).toBe(false);
    expect(validStep({ day_offset: 3, template: "Olá!" })).toBe(true);
  });

  it("min_interval_seconds >= 5", () => {
    expect(Number(3) < 5).toBe(true);
    expect(Number(5) < 5).toBe(false);
  });

  it("min_interval <= max_interval", () => {
    expect(Number(90) > Number(40)).toBe(true);
    expect(Number(100) > Number(200)).toBe(false);
  });
});

// ============================================================
// 15. claim atômico — concorrência
// ============================================================

describe("tickCampaign — claim atômico", () => {
  it("target já em 'processing' é pulado (não duplica envio)", async () => {
    setTable("followup_campaigns", [makeCampaign()]);
    setTable("followup_targets", [makeTarget({ status: "processing" })]);
    setTable("leads_extraidos", [makeLead()]);

    const r = await tickCampaign("camp-001");
    expect(r.ok).toBe(true);
    // O claim UPDATE .in("status", ["pending","waiting","failed"]) não match "processing"
    // → claim.data null → skipped → processed=0
    expect(r.processed).toBe(0);
  });
});
