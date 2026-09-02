import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const state = vi.hoisted(() => ({
  campaign_targets: [] as Row[],
  campaigns: [] as Row[],
  campaign_logs: [] as Row[],
  webhook_logs: [] as Row[],
  auditError: null as Error | null,
  timers: [] as unknown[],
}));

function buildQuery(table: keyof typeof state & string) {
  const filters: Array<(row: Row) => boolean> = [];
  let selected: string[] | null = null;
  let single = false;
  let updateData: Row | null = null;
  let insertRows: Row[] | null = null;

  const apply = () => {
    if (table === "campaign_targets" && state.auditError) {
      return Promise.resolve({ data: null, error: state.auditError });
    }
    const rows = (state[table] as Row[]).filter((row) => filters.every((filter) => filter(row)));
    if (updateData) {
      for (const row of rows) Object.assign(row, updateData);
    }
    if (insertRows) {
      for (const row of insertRows) (state[table] as Row[]).push({ ...row });
    }
    const projected = rows.map((row) => {
      if (!selected) return row;
      return Object.fromEntries(selected.map((column) => [column, row[column]]));
    });
    return Promise.resolve({
      data: single ? projected[0] || null : projected,
      error: null,
      count: rows.length,
    });
  };

  const chain: any = {
    select(columns?: string) {
      selected = typeof columns === "string" ? columns.split(",").map((column) => column.trim()) : null;
      return chain;
    },
    update(data: Row) {
      updateData = data;
      return chain;
    },
    insert(data: Row | Row[]) {
      insertRows = Array.isArray(data) ? data : [data];
      return chain;
    },
    eq(column: string, value: any) {
      filters.push((row) => row[column] === value);
      return chain;
    },
    neq(column: string, value: any) {
      filters.push((row) => row[column] !== value);
      return chain;
    },
    in(column: string, values: any[]) {
      filters.push((row) => values.includes(row[column]));
      return chain;
    },
    order() { return chain; },
    limit() { return chain; },
    maybeSingle() { single = true; return chain; },
    single() { single = true; return chain; },
    then(resolve: any, reject?: any) {
      return apply().then(resolve, reject);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (table: string) => buildQuery(table as any) },
}));
vi.mock("@/lib/evolution", () => ({ evolution: {} }));
vi.mock("@/lib/channel", () => ({
  sendMessage: vi.fn(),
  sendMedia: vi.fn(),
  checkWhatsAppNumbersDetailed: vi.fn(),
  resolveChannel: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock("@/lib/web-search", () => ({ webSearch: vi.fn(), formatResultsForAI: vi.fn() }));
vi.mock("@/lib/token-usage", () => ({ logTokenUsage: vi.fn() }));
vi.mock("@/lib/manual-send-registry", () => ({ registerAiSend: vi.fn(), registerPendingAutomatedSend: vi.fn() }));

import { recoverRunningCampaigns } from "../campaign-worker";

beforeEach(() => {
  state.campaign_targets.length = 0;
  state.campaigns.length = 0;
  state.campaign_logs.length = 0;
  state.webhook_logs.length = 0;
  state.auditError = null;
  vi.useRealTimers();
});

describe("recoverRunningCampaigns — crash recovery", () => {
  it("pausa campanha com target processing sem reenfileirar o envio ambíguo", async () => {
    state.campaigns.push({ id: "camp-1", client_id: "client-1", name: "Campanha", status: "running" });
    state.campaign_targets.push({ id: "target-1", campaign_id: "camp-1", status: "processing" });

    const recovered = await recoverRunningCampaigns();

    expect(recovered).toBe(0);
    expect(state.campaigns[0].status).toBe("paused");
    expect(state.campaign_targets[0].status).toBe("processing");
    expect(state.campaigns[0].last_error).toContain("reenvio duplicado");
  });

  it("não reagenda quando a auditoria de processing falha", async () => {
    state.campaigns.push({ id: "camp-1", client_id: "client-1", name: "Campanha", status: "running" });
    state.campaign_targets.push({ id: "target-1", campaign_id: "camp-1", status: "processing" });
    state.auditError = new Error("db offline");

    const recovered = await recoverRunningCampaigns();

    expect(recovered).toBe(0);
    expect(state.campaigns[0].status).toBe("running");
  });
});
