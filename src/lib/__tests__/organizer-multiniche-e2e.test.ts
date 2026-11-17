// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  analyzeKanbanAgentSync,
  inferSemanticStageRank,
  inferStageRole,
  type KanbanColLite,
} from "@/lib/organizer-prompt";
import { hashChatContent, formatChatMessageLine, chunkArray } from "@/lib/organizer-hash";

interface LeadRecord {
  id: number;
  client_id: string;
  remoteJid: string;
  nome_negocio: string | null;
  status: string | null;
  justificativa_ia?: string | null;
  resumo_ia?: string | null;
  previa_status?: string | null;
  link_previa?: string | null;
  reuniao_agendada_em?: string | null;
  reuniao_horario_confirmado?: string | null;
  primeiro_contato_source?: string | null;
  primeiro_contato_at?: string | null;
  created_at?: string | null;
  last_analysis_hash?: string | null;
  last_analysis_at?: string | null;
  ia_last_analyzed_at?: string | null;
  lead_type?: string | null;
  updated_at?: string | null;
}

interface ChatRecord {
  id: number;
  client_id: string;
  remote_jid: string;
  sender_type: string;
  is_from_me: boolean;
  content: string | null;
  media_type?: string | null;
  mimetype?: string | null;
  file_name?: string | null;
  status_envio?: string | null;
  created_at: string;
}

interface HistoryRecord {
  id?: number;
  client_id: string | null;
  remote_jid: string;
  nome_negocio: string | null;
  status_antigo: string;
  status_novo: string;
  razao: string | null;
  resumo: string | null;
  batch_id: string | null;
  created_at: string;
}

interface ColumnRecord extends KanbanColLite {
  client_id: string;
  label: string;
  order_index: number;
  is_terminal: boolean;
}

interface AppointmentRecord {
  client_id: string;
  remote_jid: string;
  start_at: string;
  end_at: string;
  status: string;
  title?: string;
  service_name?: string | null;
}

interface FilterCond {
  type: "eq" | "in" | "gte" | "lte" | "lt";
  field: string;
  value: unknown;
}

const CLIENT_A = "00000000-0000-0000-0000-00000000a001";
const CLIENT_CLINIC = "00000000-0000-0000-0000-00000000c11c";
const CLIENT_NO_FOLLOWUP = "00000000-0000-0000-0000-00000000f001";

const state = vi.hoisted(() => ({
  sessionClientId: "00000000-0000-0000-0000-00000000a001",
  leads: [] as LeadRecord[],
  chats: [] as ChatRecord[],
  columns: [] as ColumnRecord[],
  history: [] as HistoryRecord[],
  appointments: [] as AppointmentRecord[],
  runs: [] as Array<{ id: number; client_id: string; status: string; started_at: string }>,
  clients: new Map<string, { organizer_enabled: boolean; organizer_prompt: string | null; organizer_last_run?: string | null }>(),
  agents: new Map<string, { id: number; client_id: string; name: string; role: string; main_prompt: string; is_active: boolean; options: Record<string, unknown> }>(),
  channelConnections: [] as Array<{ client_id: string; instance_name: string; provider_config: Record<string, unknown> }>,
  warmupConfigs: [] as Array<{ client_id: string; phone_number: string }>,
  generateTextCalls: [] as Array<{ prompt: string; system: string }>,
  generateTextMock: vi.fn(async () => ({
    text: "[]",
    provider: "gemini",
    modelUsed: "gemini-2.5-flash",
    usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
  })),
  hasInternalSecret: vi.fn(() => true),
}));

function matchesFilters(row: Record<string, unknown>, filters: FilterCond[]): boolean {
  return filters.every((f) => {
    const val = row[f.field];
    if (f.type === "eq") return val === f.value || (f.field === "id" && String(val) === String(f.value));
    if (f.type === "in") return Array.isArray(f.value) && f.value.includes(val);
    if (f.type === "gte") return String(val ?? "") >= String(f.value);
    if (f.type === "lte") return String(val ?? "") <= String(f.value);
    if (f.type === "lt") return String(val ?? "") < String(f.value);
    return true;
  });
}

function makeChain(table: string) {
  const filters: FilterCond[] = [];
  let op: "select" | "update" | "upsert" | "insert" = "select";
  let payload: unknown = null;
  let orderField: string | null = null;
  let orderAsc = true;
  let limitVal: number | null = null;
  let rangeBounds: [number, number] | null = null;

  const exec = (): { data: unknown; error: null } => {
    if (table === "ai_organizer_config") {
      return { data: { id: 1, model: "gemini-2.5-flash", provider: "Gemini", enabled: true }, error: null };
    }
    if (table === "clients") {
      const cidFilter = filters.find((f) => f.field === "id")?.value as string | undefined;
      const row = cidFilter ? state.clients.get(cidFilter) : undefined;
      if (op === "update" && cidFilter && row && payload && typeof payload === "object") {
        Object.assign(row, payload);
        return { data: [{ id: cidFilter }], error: null };
      }
      return { data: row ? [row] : [], error: null };
    }
    if (table === "ai_organizer_runs") {
      if (op === "insert" && payload && typeof payload === "object") {
        const rec = { id: state.runs.length + 1, ...(payload as Record<string, unknown>) } as (typeof state.runs)[number];
        state.runs.push(rec);
        return { data: rec, error: null };
      }
      if (op === "update") return { data: null, error: null };
      const rows = state.runs.filter((r) => matchesFilters(r as unknown as Record<string, unknown>, filters));
      return { data: rows, error: null };
    }
    if (table === "agent_settings") {
      const cidFilter = filters.find((f) => f.field === "client_id")?.value as string | undefined;
      const list = Array.from(state.agents.values()).filter((a) => !cidFilter || a.client_id === cidFilter);
      return { data: list, error: null };
    }
    if (table === "kanban_columns") {
      let rows = state.columns.filter((c) => matchesFilters(c as unknown as Record<string, unknown>, filters));
      rows = [...rows].sort((a, b) => (orderAsc ? a.order_index - b.order_index : b.order_index - a.order_index));
      return { data: rows, error: null };
    }
    if (table === "channel_connections") {
      const rows = state.channelConnections.filter((c) => matchesFilters(c as unknown as Record<string, unknown>, filters));
      return { data: rows, error: null };
    }
    if (table === "whatsapp_warmup_configs") {
      const rows = state.warmupConfigs.filter((w) => matchesFilters(w as unknown as Record<string, unknown>, filters));
      return { data: rows, error: null };
    }
    if (table === "appointments") {
      const rows = state.appointments.filter((a) => matchesFilters(a as unknown as Record<string, unknown>, filters));
      return { data: rows, error: null };
    }
    if (table === "chats_dashboard") {
      let rows = state.chats.filter((c) => matchesFilters(c as unknown as Record<string, unknown>, filters));
      if (orderField) {
        rows = [...rows].sort((a, b) => {
          const av = String((a as unknown as Record<string, unknown>)[orderField!] ?? "");
          const bv = String((b as unknown as Record<string, unknown>)[orderField!] ?? "");
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (rangeBounds) rows = rows.slice(rangeBounds[0], rangeBounds[1] + 1);
      else if (limitVal !== null) rows = rows.slice(0, limitVal);
      return { data: rows, error: null };
    }
    if (table === "historico_ia_leads") {
      if (op === "insert") {
        const arr = (Array.isArray(payload) ? payload : [payload]) as Array<Record<string, unknown>>;
        for (const item of arr) {
          state.history.push({
            id: state.history.length + 1,
            client_id: (item.client_id as string | null) ?? null,
            remote_jid: String(item.remote_jid || ""),
            nome_negocio: (item.nome_negocio as string | null) ?? null,
            status_antigo: String(item.status_antigo || ""),
            status_novo: String(item.status_novo || ""),
            razao: (item.razao as string | null) ?? null,
            resumo: (item.resumo as string | null) ?? null,
            batch_id: (item.batch_id as string | null) ?? null,
            created_at: String(item.created_at || new Date().toISOString()),
          });
        }
        return { data: null, error: null };
      }
      let rows = state.history.filter((h) => matchesFilters(h as unknown as Record<string, unknown>, filters));
      if (orderField) {
        rows = [...rows].sort((a, b) => {
          const av = String((a as unknown as Record<string, unknown>)[orderField!] ?? "");
          const bv = String((b as unknown as Record<string, unknown>)[orderField!] ?? "");
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      return { data: rows, error: null };
    }
    if (table === "leads_extraidos") {
      if (op === "upsert") {
        const items = (Array.isArray(payload) ? payload : [payload]) as Array<Record<string, unknown>>;
        for (const row of items) {
          const existing = state.leads.find(
            (l) => l.remoteJid === row.remoteJid && l.client_id === (row.client_id || l.client_id)
          );
          if (existing) Object.assign(existing, row);
          else state.leads.push({ id: state.leads.length + 1, ...(row as unknown as LeadRecord) });
        }
        return { data: null, error: null };
      }
      if (op === "update") {
        const matched = state.leads.filter((l) => matchesFilters(l as unknown as Record<string, unknown>, filters));
        for (const row of matched) Object.assign(row, payload as Record<string, unknown>);
        return { data: matched, error: null };
      }
      const rows = state.leads.filter((l) => matchesFilters(l as unknown as Record<string, unknown>, filters));
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  };

  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.update = (p: unknown) => { op = "update"; payload = p; return chain; };
  chain.upsert = (p: unknown) => { op = "upsert"; payload = p; return chain; };
  chain.insert = (p: unknown) => { op = "insert"; payload = p; return chain; };
  chain.eq = (field: string, value: unknown) => { filters.push({ type: "eq", field, value }); return chain; };
  chain.in = (field: string, value: unknown) => { filters.push({ type: "in", field, value }); return chain; };
  chain.gte = (field: string, value: unknown) => { filters.push({ type: "gte", field, value }); return chain; };
  chain.lte = (field: string, value: unknown) => { filters.push({ type: "lte", field, value }); return chain; };
  chain.lt = (field: string, value: unknown) => { filters.push({ type: "lt", field, value }); return chain; };
  chain.order = (field: string, opts?: { ascending?: boolean }) => {
    orderField = field;
    orderAsc = opts?.ascending !== false;
    return chain;
  };
  chain.limit = (n: number) => { limitVal = n; return chain; };
  chain.range = (from: number, to: number) => { rangeBounds = [from, to]; return chain; };
  chain.maybeSingle = async () => {
    const res = exec();
    const first = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
    return { data: first, error: null };
  };
  chain.single = async () => {
    const res = exec();
    const first = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
    return { data: first, error: null };
  };
  chain.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(exec()).then(resolve, reject);

  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (table: string) => makeChain(table) },
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => makeChain(table) },
  supabaseAdmin: { from: (table: string) => makeChain(table) },
}));
vi.mock("@/lib/internal-auth", () => ({
  INTERNAL_SECRET_HEADER: "x-internal-secret",
  getInternalSecret: () => "test-secret",
  hasInternalSecret: state.hasInternalSecret,
}));
vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(async () => ({
    ok: true,
    clientId: state.sessionClientId,
    isAdmin: true,
    impersonating: false,
    claims: {},
  })),
}));
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: vi.fn() }));
vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: vi.fn(async () => ({
    gemini: "fake-gemini",
    openrouter: "",
    openrouterKeys: [],
    nvidia: "",
    nvidiaAccounts: [],
    gatewayBaseUrl: "",
    gatewayApiKey: "",
    gatewayFallbackModel: "",
    gatewayEndpoints: [],
    defaultAiModel: "gemini-2.5-flash",
  })),
}));
vi.mock("@/lib/ai-provider", () => ({
  providerOf: () => "gemini",
  providerDisplayName: () => "Google Gemini",
  generateText: (opts: { prompt?: string; system?: string }) => {
    state.generateTextCalls.push({
      prompt: String(opts?.prompt || ""),
      system: String(opts?.system || ""),
    });
    return state.generateTextMock();
  },
}));

import { POST as runAiOrganize } from "@/app/api/ai-organize/route";
import { PATCH as patchLeadStatus } from "@/app/api/leads/[id]/status/route";
import { GET as getAudit, POST as postAudit } from "@/app/api/organizer/audit/route";
import { promoteStalePrimeiroContato } from "@/lib/auto-promoter";
import { flushPendingRealtimeEvaluations, scheduleRealtimeLeadEvaluation } from "@/lib/organizer-realtime";

describe("CRM Auto-Adaptável Multi-Nicho — Suíte E2E à Prova de Falhas", () => {
  beforeEach(() => {
    state.sessionClientId = CLIENT_A;
    state.leads = [];
    state.chats = [];
    state.columns = [];
    state.history = [];
    state.appointments = [];
    state.runs = [];
    state.clients = new Map([
      [CLIENT_A, { organizer_enabled: true, organizer_prompt: null }],
      [CLIENT_CLINIC, { organizer_enabled: true, organizer_prompt: null }],
      [CLIENT_NO_FOLLOWUP, { organizer_enabled: true, organizer_prompt: null }],
    ]);
    state.agents = new Map();
    state.channelConnections = [];
    state.warmupConfigs = [];
    state.generateTextCalls = [];
    state.generateTextMock.mockReset();
    state.hasInternalSecret.mockReturnValue(true);
  });

  it("reconhece papéis semânticos e sincronia Agente × Kanban em 6 nichos distintos", () => {
    const clinicCols: KanbanColLite[] = [
      { status_key: "novo", label: "Novo Paciente", order_index: 0, is_terminal: false },
      { status_key: "contato_inicial", label: "1º Contato", order_index: 1, is_terminal: false },
      { status_key: "em_triagem", label: "Em Triagem", order_index: 2, is_terminal: false },
      { status_key: "orcamento_enviado", label: "Orçamento Enviado", order_index: 3, is_terminal: false },
      { status_key: "consulta_agendada", label: "Consulta Agendada", order_index: 4, is_terminal: false },
      { status_key: "reativacao", label: "Follow-up", order_index: 5, is_terminal: false },
      { status_key: "atendido", label: "Atendido", order_index: 6, is_terminal: true },
      { status_key: "sem_interesse", label: "Sem Interesse", order_index: 7, is_terminal: true },
    ];
    expect(inferStageRole(clinicCols[0])).toBe("entry");
    expect(inferStageRole(clinicCols[1])).toBe("contacted");
    expect(inferStageRole(clinicCols[2])).toBe("engaging");
    expect(inferStageRole(clinicCols[3])).toBe("proposal");
    expect(inferStageRole(clinicCols[4])).toBe("scheduled");
    expect(inferStageRole(clinicCols[5])).toBe("followup");
    expect(inferStageRole(clinicCols[6])).toBe("won");
    expect(inferStageRole(clinicCols[7])).toBe("lost");

    expect(inferSemanticStageRank(clinicCols[4], 4, 8)).toBeGreaterThan(
      inferSemanticStageRank(clinicCols[2], 2, 8)
    );

    const realEstateNoCalendarSync = analyzeKanbanAgentSync({
      columns: [
        { status_key: "novo", label: "Entrada", order_index: 0 },
        { status_key: "proposta", label: "Proposta", order_index: 1 },
      ],
      organizerPrompt: "Classifique em novo.",
      agentPrompt: "Agende visita presencial no imóvel via Google Meet / Calendário.",
      agentOptions: { google_calendar_enabled: true },
    });
    expect(realEstateNoCalendarSync.inSync).toBe(false);
    expect(realEstateNoCalendarSync.warnings.some((w) => w.code === "MISSING_SCHEDULED_COL")).toBe(true);
    expect(realEstateNoCalendarSync.missingKeysInPrompt).toContain("proposta");
  });

  it("auto-promoter adapta coluna de follow-up por cliente e não cria status órfão quando cliente não tem follow-up", async () => {
    const staleDate = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    state.columns = [
      { client_id: CLIENT_CLINIC, status_key: "novo", label: "Novo", order_index: 0, is_terminal: false },
      { client_id: CLIENT_CLINIC, status_key: "contato_inicial", label: "Contato Inicial", order_index: 1, is_terminal: false },
      { client_id: CLIENT_CLINIC, status_key: "reativacao", label: "Nutrição / Follow-up", order_index: 2, is_terminal: false },
      { client_id: CLIENT_NO_FOLLOWUP, status_key: "novo", label: "Novo", order_index: 0, is_terminal: false },
      { client_id: CLIENT_NO_FOLLOWUP, status_key: "primeiro_contato", label: "1º Contato", order_index: 1, is_terminal: false },
      { client_id: CLIENT_NO_FOLLOWUP, status_key: "fechado", label: "Fechado", order_index: 2, is_terminal: true },
    ];
    state.leads = [
      {
        id: 101,
        client_id: CLIENT_CLINIC,
        remoteJid: "5511900000101@s.whatsapp.net",
        nome_negocio: "Paciente Odonto",
        status: "contato_inicial",
        primeiro_contato_source: "disparo",
        primeiro_contato_at: staleDate,
      },
      {
        id: 102,
        client_id: CLIENT_NO_FOLLOWUP,
        remoteJid: "5511900000102@s.whatsapp.net",
        nome_negocio: "Lead Sem FollowUp",
        status: "primeiro_contato",
        primeiro_contato_source: "disparo",
        primeiro_contato_at: staleDate,
      },
    ];

    const promoted = await promoteStalePrimeiroContato();
    expect(promoted).toBe(1);
    expect(state.leads.find((l) => l.id === 101)?.status).toBe("reativacao");
    expect(state.leads.find((l) => l.id === 102)?.status).toBe("primeiro_contato");
  });

  it("respeita movimentação manual no Kanban (PATCH /api/leads/[id]/status) até chegar nova mensagem do cliente", async () => {
    const tMsg = new Date(Date.now() - 120_000).toISOString();
    const jid = "5511988881111@s.whatsapp.net";
    state.columns = [
      { client_id: CLIENT_A, status_key: "novo", label: "Novo", order_index: 0, is_terminal: false },
      { client_id: CLIENT_A, status_key: "em_qualificacao", label: "Em Qualificação", order_index: 1, is_terminal: false },
      { client_id: CLIENT_A, status_key: "follow-up", label: "Follow-up", order_index: 2, is_terminal: false },
      { client_id: CLIENT_A, status_key: "fechado", label: "Fechado", order_index: 3, is_terminal: true },
    ];
    state.leads = [
      {
        id: 201,
        client_id: CLIENT_A,
        remoteJid: jid,
        nome_negocio: "Clínica Alpha",
        status: "em_qualificacao",
      },
    ];
    state.chats = [
      { id: 1, client_id: CLIENT_A, remote_jid: jid, sender_type: "ai", is_from_me: true, content: "Olá!", created_at: tMsg },
      { id: 2, client_id: CLIENT_A, remote_jid: jid, sender_type: "customer", is_from_me: false, content: "Me chama mês que vem.", created_at: tMsg },
    ];

    const patchRes = await patchLeadStatus(
      new NextRequest("http://localhost/api/leads/201/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "follow-up" }),
      }),
      { params: Promise.resolve({ id: "201" }) }
    );
    expect(patchRes.status).toBe(200);
    expect(state.leads[0].status).toBe("follow-up");
    expect(state.history.some((h) => h.batch_id?.startsWith("manual-"))).toBe(true);

    // Organizador roda sem nova mensagem: IA NÃO é chamada e card permanece em "follow-up"
    state.generateTextMock.mockResolvedValue({
      text: JSON.stringify([{ jid, status: "em_qualificacao", razao: "Voltando", resumo: "Tentou voltar", lead_type: "qualificado" }]),
      provider: "gemini",
      modelUsed: "gemini-2.5-flash",
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    });

    await runAiOrganize(
      new NextRequest("http://internal/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": "test-secret" },
        body: JSON.stringify({ clientId: CLIENT_A, targetJids: [jid], triggered_by: "auto" }),
      })
    );
    expect(state.generateTextCalls).toHaveLength(0);
    expect(state.leads[0].status).toBe("follow-up");

    // Cliente envia nova mensagem DEPOIS do movimento manual -> agora IA reavalia e avança para "fechado"
    const tReply = new Date(Date.now() + 60_000).toISOString();
    state.chats.push({
      id: 3,
      client_id: CLIENT_A,
      remote_jid: jid,
      sender_type: "customer",
      is_from_me: false,
      content: "Fechei o plano hoje, segue comprovante!",
      created_at: tReply,
    });
    state.generateTextMock.mockResolvedValue({
      text: JSON.stringify([{ jid, status: "fechado", razao: "R3: fechou plano.", resumo: "Cliente fechou e confirmou.", lead_type: "cliente_ativo" }]),
      provider: "gemini",
      modelUsed: "gemini-2.5-flash",
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    });

    await runAiOrganize(
      new NextRequest("http://internal/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": "test-secret" },
        body: JSON.stringify({ clientId: CLIENT_A, targetJids: [jid], triggered_by: "realtime" }),
      })
    );
    expect(state.generateTextCalls).toHaveLength(1);
    expect(state.leads[0].status).toBe("fechado");
  });

  it("impõe anti-regressão, anti-bouncing em código, memória anterior (>14 msgs), marcador de mídia, cache e agenda multi-nicho", async () => {
    const now = new Date();
    const futureStart = new Date(now.getTime() + 86_400_000).toISOString();
    const futureEnd = new Date(now.getTime() + 90_000_000).toISOString();

    const jidRegress = "5511911110001@s.whatsapp.net";
    const jidFollowAdvance = "5511911110002@s.whatsapp.net";
    const jidApptClinic = "5511911110003@s.whatsapp.net";
    const jidBounce = "5511911110004@s.whatsapp.net";

    state.columns = [
      { client_id: CLIENT_A, status_key: "novo", label: "Novo", order_index: 0, is_terminal: false },
      { client_id: CLIENT_A, status_key: "primeiro_contato", label: "1º Contato", order_index: 1, is_terminal: false },
      { client_id: CLIENT_A, status_key: "em_qualificacao", label: "Em Qualificação", order_index: 2, is_terminal: false },
      { client_id: CLIENT_A, status_key: "em_negociacao", label: "Proposta / Negociação", order_index: 3, is_terminal: false },
      { client_id: CLIENT_A, status_key: "agendado", label: "Consulta Agendada", order_index: 4, is_terminal: false },
      { client_id: CLIENT_A, status_key: "follow-up", label: "Follow-up", order_index: 5, is_terminal: false },
      { client_id: CLIENT_A, status_key: "fechado", label: "Fechado", order_index: 6, is_terminal: true },
    ];

    state.leads = [
      {
        id: 301,
        client_id: CLIENT_A,
        remoteJid: jidRegress,
        nome_negocio: "Imóvel Paulista",
        status: "em_negociacao",
        resumo_ia: "Recebeu proposta de apartamento de R$ 650 mil.",
      },
      {
        id: 302,
        client_id: CLIENT_A,
        remoteJid: jidFollowAdvance,
        nome_negocio: "Salão Bella",
        status: "follow-up",
      },
      {
        id: 303,
        client_id: CLIENT_A,
        remoteJid: jidApptClinic,
        nome_negocio: "Paciente Marcos",
        status: "em_qualificacao",
      },
      {
        id: 304,
        client_id: CLIENT_A,
        remoteJid: jidBounce,
        nome_negocio: "Advocacia Lima",
        status: "em_qualificacao",
      },
    ];

    state.history = [
      {
        client_id: CLIENT_A,
        remote_jid: jidBounce,
        nome_negocio: "Advocacia Lima",
        status_antigo: "follow-up",
        status_novo: "em_qualificacao",
        razao: "Movido há 2h",
        resumo: "Retomou contato",
        batch_id: "batch-prev",
        created_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      },
    ];

    state.appointments = [
      {
        client_id: CLIENT_A,
        remote_jid: jidApptClinic,
        start_at: futureStart,
        end_at: futureEnd,
        status: "confirmed",
        title: "Avaliação Odontológica",
      },
    ];

    // 16 mensagens em jidRegress + 1 imagem sem texto para validar RESUMO ANTERIOR e [MÍDIA: ...]
    for (let m = 0; m < 15; m++) {
      state.chats.push({
        id: 100 + m,
        client_id: CLIENT_A,
        remote_jid: jidRegress,
        sender_type: m % 2 === 0 ? "ai" : "customer",
        is_from_me: m % 2 === 0,
        content: `Troca de mensagem ${m + 1}`,
        created_at: new Date(now.getTime() - (20 - m) * 60_000).toISOString(),
      });
    }
    state.chats.push({
      id: 116,
      client_id: CLIENT_A,
      remote_jid: jidRegress,
      sender_type: "customer",
      is_from_me: false,
      content: null,
      media_type: "image",
      file_name: "documento_ficha.jpg",
      created_at: now.toISOString(),
    });
    state.chats.push(
      { id: 120, client_id: CLIENT_A, remote_jid: jidFollowAdvance, sender_type: "customer", is_from_me: false, content: "Pode agendar amanhã!", created_at: now.toISOString() },
      { id: 121, client_id: CLIENT_A, remote_jid: jidApptClinic, sender_type: "customer", is_from_me: false, content: "Fechado, estarei lá!", created_at: now.toISOString() },
      { id: 122, client_id: CLIENT_A, remote_jid: jidBounce, sender_type: "customer", is_from_me: false, content: "Ok", created_at: now.toISOString() }
    );

    // LLM tenta regredir jidRegress e oscilar jidBounce para "follow-up", mas avança jidFollowAdvance -> "agendado"
    state.generateTextMock.mockResolvedValue({
      text: JSON.stringify([
        { jid: jidRegress, status: "em_qualificacao", razao: "Mandou imagem", resumo: "Enviou foto" },
        { jid: jidFollowAdvance, status: "agendado", razao: "R4: agendado amanhã", resumo: "Confirmou horário." },
        { jid: jidBounce, status: "follow-up", razao: "Oscilação curta", resumo: "Respondeu ok." },
      ]),
      provider: "gemini",
      modelUsed: "gemini-2.5-flash",
      usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
    });

    const res1 = await runAiOrganize(
      new NextRequest("http://internal/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": "test-secret" },
        body: JSON.stringify({ clientId: CLIENT_A, triggered_by: "manual" }),
      })
    );
    expect(res1.status).toBe(200);

    // 1) Agendamento confirmado promovido em Camada 0 (jidApptClinic NÃO entrou no lote da LLM!)
    expect(state.leads.find((l) => l.remoteJid === jidApptClinic)?.status).toBe("agendado");
    expect(state.generateTextCalls).toHaveLength(1);
    expect(state.generateTextCalls[0].prompt).not.toContain(jidApptClinic);

    // 2) Prompt contém memória anterior (>14 msgs), marcador de mídia e anti-bouncing
    expect(state.generateTextCalls[0].prompt).toContain("RESUMO ANTERIOR");
    expect(state.generateTextCalls[0].prompt).toContain("[MÍDIA: image (documento_ficha.jpg)]");
    expect(state.generateTextCalls[0].prompt).toContain("ANTI-BOUNCING");

    // 3) Trava em código manteve "em_negociacao" e evitou bounce 24h, mas permitiu "follow-up" -> "agendado"
    expect(state.leads.find((l) => l.remoteJid === jidRegress)?.status).toBe("em_negociacao");
    expect(state.leads.find((l) => l.remoteJid === jidFollowAdvance)?.status).toBe("agendado");
    expect(state.leads.find((l) => l.remoteJid === jidBounce)?.status).toBe("em_qualificacao");

    // 4) Hash pós-movimento bate na segunda chamada (0 tokens gastos no re-run idêntico!)
    const prevCalls = state.generateTextCalls.length;
    await runAiOrganize(
      new NextRequest("http://internal/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": "test-secret" },
        body: JSON.stringify({ clientId: CLIENT_A, triggered_by: "auto" }),
      })
    );
    expect(state.generateTextCalls.length).toBe(prevCalls);
  });

  it("auditoria automatizada /api/organizer/audit detecta e auto-repara inconsistências do CRM sem gastar tokens", async () => {
    const now = new Date();
    const futureStart = new Date(now.getTime() + 86_400_000).toISOString();
    const futureEnd = new Date(now.getTime() + 90_000_000).toISOString();

    state.columns = [
      { client_id: CLIENT_A, status_key: "novo", label: "Novo", order_index: 0, is_terminal: false },
      { client_id: CLIENT_A, status_key: "em_qualificacao", label: "Em Qualificação", order_index: 1, is_terminal: false },
      { client_id: CLIENT_A, status_key: "previa_solicitada", label: "Prévia Solicitada", order_index: 2, is_terminal: false },
      { client_id: CLIENT_A, status_key: "em_negociacao", label: "Em Negociação", order_index: 3, is_terminal: false },
      { client_id: CLIENT_A, status_key: "agendado", label: "Agendado", order_index: 4, is_terminal: false },
      { client_id: CLIENT_A, status_key: "descartado", label: "Descartado", order_index: 5, is_terminal: true },
    ];
    state.channelConnections = [
      { client_id: CLIENT_A, instance_name: "chip-01", provider_config: { owner_phone: "5511961607625" } },
    ];
    state.leads = [
      { id: 1, client_id: CLIENT_A, remoteJid: "5511961607625@s.whatsapp.net", nome_negocio: "Chip Próprio", status: "agendado", previa_status: "REUNIAO_AGENDADA" },
      { id: 2, client_id: CLIENT_A, remoteJid: "5511900000002@s.whatsapp.net", nome_negocio: null, status: null, justificativa_ia: "Avaliado pelo Organizador IA." },
      { id: 3, client_id: CLIENT_A, remoteJid: "5511900000003@s.whatsapp.net", nome_negocio: "Sem WhatsApp", status: "invalid_number" },
      { id: 4, client_id: CLIENT_A, remoteJid: "5511900000004@s.whatsapp.net", nome_negocio: "Com Prévia Pronta", status: "em_qualificacao", previa_status: "PREVIA_PRONTA", link_previa: "https://site.vercel.app" },
      { id: 5, client_id: CLIENT_A, remoteJid: "5511900000005@s.whatsapp.net", nome_negocio: "Com Agenda", status: "em_qualificacao" },
    ];
    state.appointments = [
      { client_id: CLIENT_A, remote_jid: "5511900000005@s.whatsapp.net", start_at: futureStart, end_at: futureEnd, status: "confirmed" },
    ];
    state.chats = [
      { id: 50, client_id: CLIENT_A, remote_jid: "5511900000002@s.whatsapp.net", sender_type: "customer", is_from_me: false, content: "Bom dia!", created_at: now.toISOString() },
    ];

    const getRes = await getAudit(new NextRequest("http://localhost/api/organizer/audit"));
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.report.healthy).toBe(false);
    expect(getJson.report.metrics.ownChipsAsLeadsCount).toBe(1);
    expect(getJson.report.metrics.nullStatusCount).toBe(1);
    expect(getJson.report.metrics.invalidNumberOutOfDiscardCount).toBe(1);
    expect(getJson.report.metrics.previewMisalignedCount).toBe(1);
    expect(getJson.report.metrics.appointmentMisalignedCount).toBe(1);

    const fixRes = await postAudit(
      new NextRequest("http://localhost/api/organizer/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoFix: true }),
      })
    );
    const fixJson = await fixRes.json();
    expect(fixJson.ok).toBe(true);
    expect(fixJson.fixedCount).toBe(5);
    expect(fixJson.report.issuesCount).toBe(0);
    expect(state.leads.find((l) => l.id === 1)?.status).toBe("descartado");
    expect(state.leads.find((l) => l.id === 1)?.previa_status).toBeNull();
    expect(state.leads.find((l) => l.id === 2)?.status).toBe("novo");
    expect(state.leads.find((l) => l.id === 2)?.nome_negocio).toBe("Lead (5511900000002)");
    expect(state.leads.find((l) => l.id === 3)?.status).toBe("descartado");
    expect(state.leads.find((l) => l.id === 4)?.status).toBe("em_negociacao");
    expect(state.leads.find((l) => l.id === 5)?.status).toBe("agendado");
    expect(state.generateTextCalls).toHaveLength(0);
  });

  it("bloqueia disparo concorrente duplicado (running lock) e despacha avaliações em flush gracioso", async () => {
    const jid = "5511955551234@s.whatsapp.net";
    state.columns = [{ client_id: CLIENT_A, status_key: "novo", label: "Novo", order_index: 0, is_terminal: false }];
    state.runs = [
      { id: 99, client_id: CLIENT_A, status: "running", started_at: new Date().toISOString() },
    ];

    const lockedRes = await runAiOrganize(
      new NextRequest("http://internal/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": "test-secret" },
        body: JSON.stringify({ clientId: CLIENT_A, triggered_by: "auto" }),
      })
    );
    const lockedJson = await lockedRes.json();
    expect(lockedJson.alreadyRunning).toBe(true);
    expect(state.generateTextCalls).toHaveLength(0);

    // Realtime coalescing & flush gracioso
    state.runs = [];
    state.chats = [
      { id: 1, client_id: CLIENT_A, remote_jid: jid, sender_type: "ai", is_from_me: true, content: "Olá!", created_at: new Date().toISOString() },
    ];
    scheduleRealtimeLeadEvaluation(CLIENT_A, jid, 60_000);
    const flushed = await flushPendingRealtimeEvaluations();
    expect(flushed).toBeGreaterThanOrEqual(1);
    expect(formatChatMessageLine({ sender_type: "customer", media_type: "audio", file_name: "voz.ogg" })?.line).toContain("[MÍDIA: audio (voz.ogg)]");
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(hashChatContent(["a"], "novo")).not.toBe(hashChatContent(["a"], "agendado"));
  });
});
