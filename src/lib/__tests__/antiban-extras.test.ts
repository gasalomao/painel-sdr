import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  configs: [] as Array<Record<string, any>>,
  campaigns: [] as Array<Record<string, any>>,
  channel_connections: [] as Array<Record<string, any>>,
  warmup_logs: [] as Array<Record<string, any>>,
  axiosCalls: [] as Array<Record<string, any>>,
}));

function queryBuilder(table: string) {
  const filters: Array<(row: Record<string, any>) => boolean> = [];
  let updateData: Record<string, any> | null = null;
  let single = false;

  const listForTable = (): Array<Record<string, any>> => {
    if (table === "whatsapp_warmup_configs") return state.configs;
    if (table === "campaigns") return state.campaigns;
    if (table === "channel_connections") return state.channel_connections;
    return state.warmup_logs;
  };

  const chain: any = {
    select() { return chain; },
    update(val: Record<string, any>) { updateData = val; return chain; },
    insert(val: Record<string, any> | Array<Record<string, any>>) {
      const arr = Array.isArray(val) ? val : [val];
      listForTable().push(...arr);
      return chain;
    },
    upsert(val: Record<string, any>) {
      listForTable().push(val);
      return chain;
    },
    eq(col: string, val: any) {
      filters.push((r) => r[col] === val);
      return chain;
    },
    maybeSingle() { single = true; return chain; },
    then(resolve: any) {
      const rows = listForTable().filter((r) => filters.every((f) => f(r)));
      if (updateData) {
        for (const r of rows) Object.assign(r, updateData);
      }
      return Promise.resolve({
        data: single ? rows[0] || null : rows,
        error: null,
        count: rows.length,
      }).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (t: string) => queryBuilder(t) },
}));

vi.mock("axios", () => ({
  default: vi.fn(async (config: any) => {
    state.axiosCalls.push({ url: config.url, method: config.method, data: config.data });
    return { data: JSON.stringify({ key: { id: "msg-1" } }), headers: {} };
  }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        in: async () => ({ data: [] }),
      }),
    }),
  }),
}));

import { handleWebhookConnectionClosed } from "@/lib/warmup/warmup-engine";
import { validateCampaignInstanceAccess } from "@/lib/campaign-instance-access";
import { isChatRowInbound, isChatRowOutbound } from "@/lib/chat-direction";
import {
  __resetAntiBanHistoryForTests,
  applyFollowupTextVariation,
  exportAntiBanHistory,
  seedAntiBanHistory,
} from "@/lib/antiban-mixer";

describe("Proteções anti-ban complementares", () => {
  beforeEach(() => {
    state.configs.length = 0;
    state.campaigns.length = 0;
    state.channel_connections.length = 0;
    state.warmup_logs.length = 0;
    state.axiosCalls.length = 0;
    __resetAntiBanHistoryForTests();
  });

  it("handleWebhookConnectionClosed aplica falha e pausa campanhas exclusivas em erro severo 401/403", async () => {
    state.configs.push({
      client_id: "c1",
      instance_name: "chip-ban",
      health_score: 50,
      error_count_today: 0,
      is_quarantined: false,
    });
    state.campaigns.push(
      { id: "camp-single", client_id: "c1", instance_name: "chip-ban", status: "running" },
      { id: "camp-pool", client_id: "c1", instance_name: "__auto_pool__", status: "running" }
    );

    const res = await handleWebhookConnectionClosed({
      clientId: "c1",
      instanceName: "chip-ban",
      statusReason: 401,
    });

    expect(res.severe).toBe(true);
    expect(res.pausedCampaigns).toBe(1);
    expect(state.configs[0].is_quarantined).toBe(true);
    expect(state.campaigns[0].status).toBe("paused");
    expect(state.campaigns[1].status).toBe("running"); // Pool multi-chip não é pausado pela queda de 1 chip
  });

  it("validateCampaignInstanceAccess valida __auto_pool__ contra conexões do tenant", async () => {
    const emptyPool = await validateCampaignInstanceAccess("c1", "__auto_pool__");
    expect(emptyPool.ok).toBe(false);
    if (!emptyPool.ok) expect(emptyPool.status).toBe(400);

    state.channel_connections.push({ client_id: "c1", instance_name: "chip-1" });
    const validPool = await validateCampaignInstanceAccess("c1", "__auto_pool__");
    expect(validPool).toEqual({ ok: true });
  });

  it("isChatRowInbound / isChatRowOutbound tratam sender_type e is_from_me consistentemente", () => {
    expect(isChatRowInbound({ sender_type: "customer" })).toBe(true);
    expect(isChatRowInbound({ is_from_me: false })).toBe(true);
    expect(isChatRowInbound({ sender_type: "ai", is_from_me: false })).toBe(false);
    expect(isChatRowOutbound({ sender_type: "ai" })).toBe(true);
    expect(isChatRowOutbound({ is_from_me: true })).toBe(true);
  });

  it("applyFollowupTextVariation e seed/export preservam estado sem quebrar o template", () => {
    const tarde = new Date("2026-05-22T17:00:00.000Z");
    const out = applyFollowupTextVariation("{{saudacao}}, Empresa! Tudo bem? Ainda por aí?", tarde, "fu-1");
    expect(out).toMatch(/^Boa tarde, Empresa! Tudo (bem|certo|joia|tranquilo|bem por aí)\? Ainda por aí\?$/);

    const hist = exportAntiBanHistory();
    expect(Object.keys(hist).length).toBeGreaterThan(0);

    __resetAntiBanHistoryForTests();
    seedAntiBanHistory(hist);
    expect(exportAntiBanHistory()).toEqual(hist);
  });

  it("evolution.sendMessage preserva @lid e respeita linkPreview:false no disparo frio", async () => {
    process.env.EVOLUTION_API_URL = "https://evo.example.com";
    process.env.EVOLUTION_API_KEY = "test-key";

    const { evolution, invalidateEvolutionCache } = await import("@/lib/evolution");
    invalidateEvolutionCache();

    await evolution.sendMessage("1234567890123@lid", "Oi empresa!", "chip-1", {
      delay: 1800,
      linkPreview: false,
    });

    const sendCall = state.axiosCalls.find((c) => String(c.url).includes("/message/sendText/chip-1"));
    expect(sendCall).toBeDefined();
    expect(sendCall?.data.number).toBe("1234567890123@lid");
    expect(sendCall?.data.linkPreview).toBe(false);
    expect(sendCall?.data.delay).toBe(1800);
  });
});

