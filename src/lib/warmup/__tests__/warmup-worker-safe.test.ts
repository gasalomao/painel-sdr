// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WarmupConfig } from "../warmup-types";

const mocks = vi.hoisted(() => ({
  listTenants: vi.fn(),
  ensure: vi.fn(),
  readConfigs: vi.fn(),
  readConnections: vi.fn(),
  readDaily: vi.fn(),
  writeDaily: vi.fn(),
  executeTurn: vi.fn(),
  logAction: vi.fn(),
  from: vi.fn(),
  syncGroups: vi.fn(),
  hydrate: vi.fn(),
  insertConv: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  finishMany: vi.fn(),
}));

vi.mock("../warmup-config-service", () => ({
  listWarmupTenantIds: mocks.listTenants,
  ensureWarmupConfigsForTenant: mocks.ensure,
  readTenantWarmupConfigs: mocks.readConfigs,
  readTenantConnections: mocks.readConnections,
  isConnectedStatus: (status: string) =>
    ["open", "connected"].includes(String(status || "").toLowerCase()),
  getEffectiveDailyTarget: (config: WarmupConfig) => {
    const caps: Record<string, number> = { contingency: 20, inbound: 40, outbound: 70 };
    return Math.min(config.daily_target || 10, caps[config.purpose || "outbound"] || 70);
  },
  readDailyResetState: mocks.readDaily,
  writeDailyResetState: mocks.writeDaily,
  acquireWarmupTickLock: mocks.acquireLock,
  releaseWarmupTickLock: mocks.releaseLock,
}));

vi.mock("../warmup-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../warmup-engine")>();
  return {
    ...actual,
    executeWarmupTurn: mocks.executeTurn,
    logWarmupAction: mocks.logAction,
  };
});

vi.mock("../warmup-groups", () => ({
  syncGroupMembershipForChips: mocks.syncGroups,
  hydrateChipProfile: mocks.hydrate,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { tickWarmupWorker } from "../warmup-worker";

function config(overrides: Partial<WarmupConfig> = {}): WarmupConfig {
  const nowIso = new Date().toISOString();
  return {
    client_id: "tenant-1",
    instance_name: "chip-1",
    enabled: true,
    stage: 4,
    stage_auto_progress: true,
    days_active: 2,
    consecutive_successful_days: 2,
    health_score: 100,
    is_quarantined: false,
    purpose: "outbound",
    daily_target: 70,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    last_activity_at: nowIso,
    min_interval_seconds: 60,
    max_interval_seconds: 150,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 0,
    allowed_end_hour: 24,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
    profile_hydrated: true,
    ...overrides,
  };
}

let activeAllRows: Array<Record<string, string>> = [];
let dueRows: Array<Record<string, unknown>> = [];

function conversationBuilder() {
  const builder: any = {
    __columns: "",
    select: (columns?: string) => {
      builder.__columns = columns || "";
      return builder;
    },
    eq: () => builder,
    lte: () => builder,
    order: () => builder,
    limit: async () => ({ data: dueRows, error: null }),
    then: (resolve: any, reject: any) => {
      const rows =
        builder.__columns === "id, instance_a, instance_b" ? activeAllRows : [];
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
    insert: (row: Record<string, unknown>) => {
      mocks.insertConv(row);
      return {
        select: () => ({
          single: async () => ({ data: { id: "conv-new", ...row }, error: null }),
        }),
      };
    },
    update: () => ({
      eq: async () => ({ data: null, error: null }),
      in: async (_column: string, ids: string[]) => {
        mocks.finishMany(ids);
        return { data: null, error: null };
      },
    }),
  };
  return builder;
}

beforeEach(() => {
  mocks.listTenants.mockReset().mockResolvedValue(["tenant-1"]);
  mocks.ensure.mockReset().mockResolvedValue({
    created: [],
    enabledNew: [],
    source: "table",
    connections: [],
  });
  mocks.readConfigs.mockReset();
  mocks.readConnections.mockReset().mockResolvedValue([]);
  mocks.readDaily.mockReset().mockResolvedValue({});
  mocks.writeDaily.mockReset().mockResolvedValue(undefined);
  mocks.executeTurn.mockReset().mockResolvedValue({ success: true, messageText: "oi" });
  mocks.logAction.mockReset().mockResolvedValue(undefined);
  mocks.from.mockReset().mockImplementation(() => conversationBuilder());
  mocks.syncGroups.mockReset().mockResolvedValue({ joinedCount: 0, errors: [] });
  mocks.hydrate.mockReset().mockResolvedValue({ success: true });
  mocks.insertConv.mockReset();
  mocks.acquireLock.mockReset().mockResolvedValue(true);
  mocks.releaseLock.mockReset().mockResolvedValue(undefined);
  mocks.finishMany.mockReset();
  activeAllRows = [];
  dueRows = [];
});

describe("tickWarmupWorker — segurança", () => {
  it("pula o tenant quando outro processo detém o lock", async () => {
    mocks.acquireLock.mockResolvedValue(false);

    const result = await tickWarmupWorker();

    expect(result.exchangesCount).toBe(0);
    expect(mocks.readConfigs).not.toHaveBeenCalled();
    expect(mocks.executeTurn).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it("não aquece quando todas as configs estão desligadas (sem ressuscitar app_settings)", async () => {
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: { "chip-1": config({ enabled: false }) },
    });

    const result = await tickWarmupWorker();

    expect(result.exchangesCount).toBe(0);
    expect(mocks.executeTurn).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("não envia de chip desconectado", async () => {
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: { "chip-1": config() },
    });
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [{ instance_name: "chip-1", status: "close", phone_number: null }],
    });

    const result = await tickWarmupWorker();

    expect(result.exchangesCount).toBe(0);
    expect(mocks.executeTurn).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("respeita o teto da finalidade antes de criar conversa", async () => {
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        "chip-1": config({ purpose: "inbound", daily_target: 70, sent_today: 40 }),
        "chip-2": config({ instance_name: "chip-2", purpose: "inbound", daily_target: 70, sent_today: 40 }),
      },
    });
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [
        { instance_name: "chip-1", status: "open", phone_number: null },
        { instance_name: "chip-2", status: "open", phone_number: null },
      ],
    });

    const result = await tickWarmupWorker();

    expect(result.exchangesCount).toBe(0);
    expect(mocks.executeTurn).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("não cria conversa duplicada para par que já está ativo", async () => {
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        "chip-1": config(),
        "chip-2": config({ instance_name: "chip-2" }),
      },
    });
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [
        { instance_name: "chip-1", status: "open", phone_number: null },
        { instance_name: "chip-2", status: "open", phone_number: null },
      ],
    });
    activeAllRows = [{ id: "conv-old", instance_a: "chip-1", instance_b: "chip-2" }];

    const result = await tickWarmupWorker();

    expect(result.exchangesCount).toBe(0);
    expect(mocks.executeTurn).not.toHaveBeenCalled();
    expect(mocks.insertConv).not.toHaveBeenCalled();
  });

  it("encerra conversas ativas duplicadas do mesmo par", async () => {
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        "chip-1": config(),
        "chip-2": config({ instance_name: "chip-2" }),
      },
    });
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [
        { instance_name: "chip-1", status: "open", phone_number: null },
        { instance_name: "chip-2", status: "open", phone_number: null },
      ],
    });
    activeAllRows = [
      { id: "conv-keep", instance_a: "chip-1", instance_b: "chip-2" },
      { id: "conv-dup", instance_a: "chip-2", instance_b: "chip-1" },
    ];

    await tickWarmupWorker();

    expect(mocks.finishMany).toHaveBeenCalledWith(["conv-dup"]);
  });

  it("não chama o motor fora da janela de horário do chip", async () => {
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        "chip-1": config({ allowed_start_hour: 12, allowed_end_hour: 12 }),
        "chip-2": config({ instance_name: "chip-2", allowed_start_hour: 12, allowed_end_hour: 12 }),
      },
    });
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [
        { instance_name: "chip-1", status: "open", phone_number: null },
        { instance_name: "chip-2", status: "open", phone_number: null },
      ],
    });
    dueRows = [
      {
        id: "conv-1",
        client_id: "tenant-1",
        instance_a: "chip-1",
        instance_b: "chip-2",
        last_sender: "chip-1",
        turn_count: 1,
        max_turns: 6,
        status: "active",
        next_turn_at: "2026-11-12T03:00:00Z",
      },
    ];

    const result = await tickWarmupWorker();

    expect(result.exchangesCount).toBe(0);
    expect(mocks.executeTurn).not.toHaveBeenCalled();
    expect(mocks.insertConv).not.toHaveBeenCalled();
  });

  it("segue o fluxo normal com chip conectado e dentro da meta", async () => {
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        "chip-1": config({ profile_hydrated: true }),
        "chip-2": config({ instance_name: "chip-2", profile_hydrated: true }),
      },
    });
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [
        { instance_name: "chip-1", status: "open", phone_number: null },
        { instance_name: "chip-2", status: "open", phone_number: null },
      ],
    });

    const result = await tickWarmupWorker();

    expect(mocks.executeTurn).toHaveBeenCalledTimes(1);
    expect(mocks.insertConv).toHaveBeenCalledTimes(1);
    expect(result.exchangesCount).toBe(1);
  });
});
