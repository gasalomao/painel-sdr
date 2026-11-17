// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, any>;

const state = vi.hoisted(() => ({
  leads: [] as Row[],
  chats: [] as Row[],
  columns: [] as Row[],
  clientRow: { organizer_enabled: true, organizer_prompt: "REGRAS CUSTOM" } as Row | null,
  channelConnections: [] as Row[],
  warmupConfigs: [] as Row[],
  historyInserts: [] as Row[][],
  leadUpserts: [] as Row[][],
  clientUpdates: [] as Row[],
  organizerUpserts: [] as Row[],
  generateTextCalls: 0,
  generateTextMock: vi.fn(),
  requireClientId: vi.fn(),
  hasInternalSecret: vi.fn(() => true),
}));

function makeDbChain(table: string) {
  let op: "select" | "insert" | "update" | "upsert" = "select";
  let payload: any;
  const filters: Array<(row: Row) => boolean> = [];

  const rowsForTable = (): Row[] => {
    if (table === "leads_extraidos") return state.leads;
    if (table === "chats_dashboard") return state.chats;
    if (table === "kanban_columns") return state.columns;
    if (table === "channel_connections") return state.channelConnections;
    if (table === "whatsapp_warmup_configs") return state.warmupConfigs;
    if (table === "clients") return state.clientRow ? [state.clientRow] : [];
    return [];
  };

  const commit = () => {
    if (op === "insert") {
      if (table === "historico_ia_leads") {
        state.historyInserts.push(Array.isArray(payload) ? payload : [payload]);
      }
      if (table === "ai_organizer_runs") {
        return { data: { id: 901 }, error: null };
      }
      return { data: null, error: null };
    }
    if (op === "upsert") {
      if (table === "leads_extraidos") {
        const list = Array.isArray(payload) ? payload : [payload];
        state.leadUpserts.push(list);
      }
      return { data: null, error: null };
    }
    if (op === "update") {
      if (table === "clients") {
        state.clientUpdates.push(payload);
      }
      return { data: null, error: null };
    }
    const matched = rowsForTable().filter((r) => filters.every((f) => f(r)));
    return { data: matched, error: null };
  };

  const chain: Record<string, any> = {
    select: () => chain,
    insert: (p: any) => {
      op = "insert";
      payload = p;
      return chain;
    },
    upsert: (p: any) => {
      op = "upsert";
      payload = p;
      return chain;
    },
    update: (p: any) => {
      op = "update";
      payload = p;
      return chain;
    },
    eq: (col: string, val: any) => {
      filters.push((r) => r[col] === val);
      return chain;
    },
    in: (col: string, vals: any[]) => {
      filters.push((r) => vals.includes(r[col]));
      return chain;
    },
    gte: () => chain,
    lte: () => chain,
    lt: () => chain,
    order: () => chain,
    limit: () => chain,
    single: async () => {
      const res = commit();
      return { data: Array.isArray(res.data) ? res.data[0] || null : res.data, error: null };
    },
    maybeSingle: async () => {
      const res = commit();
      return { data: Array.isArray(res.data) ? res.data[0] || null : res.data, error: null };
    },
    then: (resolve: (v: any) => any, reject: (e: any) => any) =>
      Promise.resolve(commit()).then(resolve, reject),
  };

  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (t: string) => makeDbChain(t) },
}));
vi.mock("@/lib/tenant", () => ({
  requireClientId: (...args: any[]) => state.requireClientId(...args),
}));
vi.mock("@/lib/internal-auth", () => ({
  hasInternalSecret: () => state.hasInternalSecret(),
  getInternalSecret: () => "test-secret",
  INTERNAL_SECRET_HEADER: "x-internal-secret",
}));
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: vi.fn() }));
vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({
    gemini: "gem-test-key",
    openrouter: "",
    openrouterKeys: [],
    nvidia: "",
    nvidiaAccounts: [],
    gatewayBaseUrl: "",
    gatewayApiKey: "",
    gatewayFallbackModel: "",
    gatewayEndpoints: [],
    aiCombos: [],
    defaultAiModel: "gemini-2.5-flash",
  })),
}));
vi.mock("@/lib/ai-provider", () => ({
  providerOf: vi.fn(() => "gemini"),
  providerDisplayName: vi.fn(() => "Google Gemini"),
  generateText: (...args: any[]) => {
    state.generateTextCalls++;
    return state.generateTextMock(...args);
  },
}));

import { promoteLeadBySystemSignal } from "@/lib/organizer-realtime";
import { promoteStalePrimeiroContato } from "@/lib/auto-promoter";
import { POST as runAiOrganize } from "@/app/api/ai-organize/route";

const CLIENT_ID = "00000000-0000-0000-0000-00000000a001";

const SARAH_COLUMNS = [
  { client_id: CLIENT_ID, status_key: "novo", label: "Novos Leads", order_index: 0, is_terminal: false },
  { client_id: CLIENT_ID, status_key: "primeiro_contato", label: "1º Contato", order_index: 1, is_terminal: false },
  { client_id: CLIENT_ID, status_key: "em_qualificacao", label: "Em Qualificação", order_index: 2, is_terminal: false },
  { client_id: CLIENT_ID, status_key: "previa_solicitada", label: "Prévia Solicitada", order_index: 3, is_terminal: false },
  { client_id: CLIENT_ID, status_key: "em_negociacao", label: "Prévia Enviada / Negociação", order_index: 4, is_terminal: false },
  { client_id: CLIENT_ID, status_key: "agendado", label: "Reunião / Call Agendada", order_index: 5, is_terminal: false },
  { client_id: CLIENT_ID, status_key: "follow-up", label: "Follow-up", order_index: 6, is_terminal: false },
  { client_id: CLIENT_ID, status_key: "fechado", label: "Fechado (Ganho)", order_index: 7, is_terminal: true },
  { client_id: CLIENT_ID, status_key: "sem_interesse", label: "Sem Interesse", order_index: 8, is_terminal: true },
  { client_id: CLIENT_ID, status_key: "descartado", label: "Descartado", order_index: 9, is_terminal: true },
];

describe("CRM, Realtime & Camada 0 Hardening", () => {
  beforeEach(() => {
    state.leads = [];
    state.chats = [];
    state.columns = [...SARAH_COLUMNS];
    state.clientRow = { organizer_enabled: true, organizer_prompt: "REGRAS CUSTOM DA SARAH" };
    state.channelConnections = [];
    state.warmupConfigs = [];
    state.historyInserts = [];
    state.leadUpserts = [];
    state.clientUpdates = [];
    state.generateTextCalls = 0;
    state.generateTextMock.mockReset();
    state.hasInternalSecret.mockReturnValue(true);
  });

  it("promoteLeadBySystemSignal não move para 'agendado' por falso positivo de texto no custom_goal_reached nem sobrescreve 'previa_solicitada'", async () => {
    const jid = "5511941991995@s.whatsapp.net";
    state.leads = [
      {
        id: 10,
        client_id: CLIENT_ID,
        remoteJid: jid,
        nome_negocio: "Conceito V.",
        status: "primeiro_contato",
        previa_status: null,
        reuniao_agendada_em: null,
      },
    ];

    const res1 = await promoteLeadBySystemSignal({
      clientId: CLIENT_ID,
      remoteJid: jid,
      signal: "custom_goal_reached",
      reason: 'Objetivo alcançado: "Pausar após espera da prévia ou agendamento na Fase 2".',
    });
    expect(res1.moved).toBe(true);
    expect(res1.newStatus).toBe("em_qualificacao");
    expect(res1.newStatus).not.toBe("agendado");

    // Se já estiver em previa_solicitada, custom_goal_reached NÃO sobrescreve!
    state.leads[0].status = "previa_solicitada";
    const res2 = await promoteLeadBySystemSignal({
      clientId: CLIENT_ID,
      remoteJid: jid,
      signal: "custom_goal_reached",
      reason: 'Objetivo alcançado: "Pausar após espera da prévia ou agendamento na Fase 2".',
    });
    expect(res2).toEqual({ moved: false, newStatus: "previa_solicitada" });

    // calendar_scheduled explícito move normalmente para 'agendado'
    const res3 = await promoteLeadBySystemSignal({
      clientId: CLIENT_ID,
      remoteJid: jid,
      signal: "calendar_scheduled",
      reason: "Reunião confirmada para amanhã às 15h.",
    });
    expect(res3).toEqual({ moved: true, newStatus: "agendado" });
  });

  it("POST /api/ai-organize preserva status e nome_negocio em batch upsert e resolve Camada 0 (auto-resposta, link Vercel e previa_status) com 0 tokens", async () => {
    const now = new Date().toISOString();
    const jidAutoReply = "5511990000001@s.whatsapp.net";
    const jidVercelLink = "5511990000002@s.whatsapp.net";
    const jidPreviaSolicitada = "5511990000003@s.whatsapp.net";
    const jidUnchanged = "5511990000004@s.whatsapp.net";
    const jidOwnChip = "5511961607625@s.whatsapp.net";

    state.warmupConfigs = [{ client_id: CLIENT_ID, phone_number: "5511961607625" }];
    state.leads = [
      {
        client_id: CLIENT_ID,
        remoteJid: jidAutoReply,
        nome_negocio: "Clínica Alpha",
        status: "novo",
        last_analysis_hash: null,
        lead_type: "novo",
      },
      {
        client_id: CLIENT_ID,
        remoteJid: jidVercelLink,
        nome_negocio: "Advocacia Beta",
        status: "previa_solicitada",
        last_analysis_hash: null,
        lead_type: "qualificado",
      },
      {
        client_id: CLIENT_ID,
        remoteJid: jidPreviaSolicitada,
        nome_negocio: "Vidraçaria Gama",
        status: "em_qualificacao",
        previa_status: "PREVIA_SOLICITADA",
        last_analysis_hash: null,
        lead_type: "qualificado",
      },
      {
        client_id: CLIENT_ID,
        remoteJid: jidUnchanged,
        nome_negocio: "Studio Delta (Preservado)",
        status: "em_qualificacao",
        last_analysis_hash: null,
        lead_type: "qualificado",
      },
    ];

    state.chats = [
      { id: 1, client_id: CLIENT_ID, remote_jid: jidAutoReply, sender_type: "ai", is_from_me: true, content: "Bom dia! Tudo bem?", created_at: now },
      { id: 2, client_id: CLIENT_ID, remote_jid: jidAutoReply, sender_type: "customer", is_from_me: false, content: "Agradecemos o seu contato. Nosso horário de atendimento é de 9h às 18h.", created_at: now },
      { id: 3, client_id: CLIENT_ID, remote_jid: jidVercelLink, sender_type: "customer", is_from_me: false, content: "Pode mandar sim", created_at: now },
      { id: 4, client_id: CLIENT_ID, remote_jid: jidVercelLink, sender_type: "ai", is_from_me: true, content: "Veja seu site aqui: https://advocacia-beta.vercel.app", created_at: now },
      { id: 5, client_id: CLIENT_ID, remote_jid: jidPreviaSolicitada, sender_type: "customer", is_from_me: false, content: "Quero ver", created_at: now },
      { id: 6, client_id: CLIENT_ID, remote_jid: jidUnchanged, sender_type: "customer", is_from_me: false, content: "Olá, tudo bem?", created_at: now },
      { id: 7, client_id: CLIENT_ID, remote_jid: jidOwnChip, sender_type: "customer", is_from_me: false, content: "Oi Sara de novo aquecendo chip", created_at: now },
    ];

    // Apenas jidUnchanged precisa ir para a IA! Resposta deliberadamente sem razao/resumo para testar fallback descritivo
    state.generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify([{ jid: jidUnchanged, status: "em_qualificacao" }]),
      modelUsed: "gemini-2.5-flash",
      provider: "gemini",
      usage: { promptTokens: 50, completionTokens: 15, totalTokens: 65 },
    });

    const req = new NextRequest("http://localhost/api/ai-organize", {
      method: "POST",
      body: JSON.stringify({ clientId: CLIENT_ID, triggered_by: "auto" }),
    });
    const res = await runAiOrganize(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // Só 1 chamada IA (para jidUnchanged); chip próprio filtrado; outros 3 resolvidos na Camada 0
    expect(state.generateTextCalls).toBe(1);

    const flatUpserts = state.leadUpserts.flat();
    expect(flatUpserts.find((u) => u.remoteJid === jidOwnChip)).toBeUndefined();
    expect(flatUpserts.find((u) => u.remoteJid === jidAutoReply)).toMatchObject({ status: "primeiro_contato", nome_negocio: "Clínica Alpha" });
    expect(flatUpserts.find((u) => u.remoteJid === jidVercelLink)).toMatchObject({ status: "em_negociacao", nome_negocio: "Advocacia Beta" });
    expect(flatUpserts.find((u) => u.remoteJid === jidPreviaSolicitada)).toMatchObject({ status: "previa_solicitada", nome_negocio: "Vidraçaria Gama" });

    // CRÍTICO: jidUnchanged (que NÃO mudou de status) PRECISA manter status e nome_negocio não-nulos e ganhar justificativa/resumo!
    const unchangedRow = flatUpserts.find((u) => u.remoteJid === jidUnchanged);
    expect(unchangedRow).toBeDefined();
    expect(unchangedRow?.status).toBe("em_qualificacao");
    expect(unchangedRow?.nome_negocio).toBe("Studio Delta (Preservado)");
    expect(unchangedRow?.justificativa_ia).not.toBe("Avaliado pelo Organizador IA.");
    expect(unchangedRow?.resumo_ia).toBeTruthy();
  });

  it("POST /api/ai-organize grava organizer_last_run mesmo quando retorno é noop para evitar loop de 5 minutos", async () => {
    const req = new NextRequest("http://localhost/api/ai-organize", {
      method: "POST",
      body: JSON.stringify({ clientId: CLIENT_ID, triggered_by: "auto" }),
    });
    const res = await runAiOrganize(req);
    expect(res.status).toBe(200);
    expect(state.generateTextCalls).toBe(0);
    expect(state.clientUpdates.some((u) => typeof u.organizer_last_run === "string")).toBe(true);
  });

  it("promoteStalePrimeiroContato grava client_id ao registrar historico_ia_leads", async () => {
    state.leads = [
      {
        id: 55,
        client_id: CLIENT_ID,
        remoteJid: "5511999998888@s.whatsapp.net",
        nome_negocio: "Advocacia Teste",
        status: "primeiro_contato",
        primeiro_contato_source: "disparo",
        primeiro_contato_at: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
      },
    ];

    const promoted = await promoteStalePrimeiroContato();
    expect(promoted).toBe(1);
    expect(state.historyInserts[0]?.[0]).toMatchObject({
      client_id: CLIENT_ID,
      status_antigo: "primeiro_contato",
      status_novo: "follow-up",
    });
  });
});
