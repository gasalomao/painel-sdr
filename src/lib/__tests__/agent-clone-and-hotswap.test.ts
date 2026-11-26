import { beforeEach, describe, expect, it, vi } from "vitest";

const state: Record<string, Array<Record<string, unknown>>> = {
  agent_settings: [],
  agent_knowledge: [],
  agent_stages: [],
  channel_connections: [],
  campaigns: [],
  followup_campaigns: [],
  automations: [],
  whatsapp_warmup_configs: [],
};

vi.mock("@/lib/saas-limits", () => ({
  assertTenantCanCreateAgent: vi.fn(async () => null),
  assertTenantCanCreateInstance: vi.fn(async () => null),
  getTenantSaasLimits: vi.fn(async () => ({})),
}));

vi.mock("@/lib/agent-config-cache", () => ({
  invalidateAgentConfigCache: vi.fn(),
}));

vi.mock("@/lib/supabase_admin", () => {
  function makeBuilder(table: string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
    let onConflictCols: string[] = [];

    const execute = async () => {
      if (!state[table]) state[table] = [];
      if (op === "insert" && payload) {
        const items = (Array.isArray(payload) ? payload : [payload]).map((it, idx) => ({
          id:
            it.id ??
            (table === "agent_settings"
              ? state[table].length + idx + 100
              : `${table}-${state[table].length + idx + 1}`),
          ...it,
        }));
        state[table].push(...items);
        return { data: items, error: null };
      }
      if (op === "upsert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const it of items) {
          const idx = state[table].findIndex(
            (r) => onConflictCols.length > 0 && onConflictCols.every((c) => r[c] === it[c])
          );
          if (idx >= 0) {
            state[table][idx] = { ...state[table][idx], ...it };
          } else {
            state[table].push({
              id: `${table}-${state[table].length + 1}`,
              ...it,
            });
          }
        }
        return { data: items, error: null };
      }
      if (op === "update" && payload && !Array.isArray(payload)) {
        const matches = state[table].filter((r) => filters.every((f) => f(r)));
        for (const row of matches) Object.assign(row, payload);
        return { data: matches, error: null };
      }
      if (op === "delete") {
        const removed = state[table].filter((r) => filters.every((f) => f(r)));
        state[table] = state[table].filter((r) => !filters.every((f) => f(r)));
        return { data: removed, error: null };
      }

      const rows = state[table].filter((r) => filters.every((f) => f(r)));
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (data: Record<string, unknown> | Array<Record<string, unknown>>) => {
        op = "insert";
        payload = data;
        return builder;
      },
      upsert: (data: Record<string, unknown>, opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = data;
        onConflictCols = String(opts?.onConflict || "").split(",").map((s) => s.trim()).filter(Boolean);
        return builder;
      },
      update: (data: Record<string, unknown>) => {
        op = "update";
        payload = data;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      neq: (col: string, val: unknown) => {
        filters.push((r) => r[col] !== val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      or: () => builder,
      order: () => builder,
      maybeSingle: async () => {
        const r = await execute();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = await execute();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) => execute().then(res, rej),
    };
    return builder;
  }

  return {
    supabaseAdmin: {
      from: (table: string) => makeBuilder(table),
    },
  };
});

import { cloneAgentForClient } from "../agent-clone";
import { hotswapBannedInstance } from "../whatsapp-hotswap";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

describe("Clonagem Universal de Agente + Hotswap de Chip Banido", () => {
  beforeEach(() => {
    for (const k of Object.keys(state)) state[k] = [];
  });

  it("clona QUALQUER agente preservando prompt, conhecimento, etapas, e vincula outro número sem remover o antigo", async () => {
    state.agent_settings.push({
      id: 10,
      client_id: CLIENT_ID,
      name: "Sarah Médicos",
      main_prompt: "Prompt completo Método Mentor Fase 1",
      role: "SDR",
      personality: "Amigável",
      tone: "Consultivo",
      target_model: "auto:free",
      options: {
        split_messages: true,
        google_tokens: { refresh_token: "secret-rt" },
        custom_goal: "previa",
      },
    });
    state.agent_knowledge.push({
      id: "kb-1",
      agent_id: 10,
      client_id: CLIENT_ID,
      title: "Portfolio",
      content: "Sites médicos sob medida",
    });
    state.agent_stages.push({
      id: "st-1",
      agent_id: 10,
      client_id: CLIENT_ID,
      title: "Ofertar prévia",
      goal_prompt: "Ofertar sem compromisso",
      order_index: 1,
    });
    state.channel_connections.push(
      { instance_name: "sarah_num_1", agent_id: 10, client_id: CLIENT_ID, status: "open" },
      { instance_name: "sarah_num_2", agent_id: null, client_id: CLIENT_ID, status: "open" }
    );

    const res = await cloneAgentForClient({
      clientId: CLIENT_ID,
      sourceAgentId: 10,
      newName: "Sarah Médicos SP #2",
      targetInstanceName: "sarah_num_2",
      cloneCalendarConfig: false,
    });

    expect(res.ok).toBe(true);
    expect(res.clonedKnowledgeCount).toBe(1);
    expect(res.clonedStagesCount).toBe(1);
    expect(res.boundInstance).toBe("sarah_num_2");
    expect(state.agent_settings).toHaveLength(2);

    const cloned = state.agent_settings[1];
    expect(cloned.name).toBe("Sarah Médicos SP #2");
    expect(cloned.main_prompt).toBe("Prompt completo Método Mentor Fase 1");
    expect((cloned.options as Record<string, unknown>).split_messages).toBe(true);
    expect((cloned.options as Record<string, unknown>).google_tokens).toBeUndefined();

    // Número original permanece intacto no agente 10 e número novo vinculado ao clone
    expect(state.channel_connections[0].agent_id).toBe(10);
    expect(state.channel_connections[1].agent_id).toBe(cloned.id);
  });

  it("executa hotswap completo de chip banido migrando agente, campanhas, follow-ups e automações", async () => {
    state.channel_connections.push(
      { instance_name: "chip_banido", agent_id: 22, client_id: CLIENT_ID, status: "close" },
      { instance_name: "chip_estepe", agent_id: null, client_id: CLIENT_ID, status: "open" },
      { instance_name: "chip_rehab", agent_id: null, client_id: CLIENT_ID, status: "open" }
    );
    state.whatsapp_warmup_configs.push(
      { client_id: CLIENT_ID, instance_name: "chip_estepe", is_quarantined: false, career_mode: "maturing" },
      { client_id: CLIENT_ID, instance_name: "chip_rehab", is_quarantined: false, career_mode: "rehab" }
    );
    state.campaigns.push(
      { id: "camp-1", client_id: CLIENT_ID, instance_name: "chip_banido", status: "paused" },
      { id: "camp-done", client_id: CLIENT_ID, instance_name: "chip_banido", status: "completed" }
    );
    state.followup_campaigns.push({ id: "fu-1", client_id: CLIENT_ID, instance_name: "chip_banido" });
    state.automations.push({ id: "auto-1", client_id: CLIENT_ID, instance_name: "chip_banido" });

    // Bloqueia hotswap para chip em reabilitação pós-ban
    const blockedSwap = await hotswapBannedInstance({
      clientId: CLIENT_ID,
      oldInstanceName: "chip_banido",
      newInstanceName: "chip_rehab",
    });
    expect(blockedSwap.ok).toBe(false);
    expect(blockedSwap.status).toBe(409);

    // Hotswap limpo para chip estepe saudável
    const swap = await hotswapBannedInstance({
      clientId: CLIENT_ID,
      oldInstanceName: "chip_banido",
      newInstanceName: "chip_estepe",
    });
    expect(swap.ok).toBe(true);
    expect(swap.migratedAgentIds).toEqual([22]);
    expect(swap.migratedCampaigns).toBe(1);
    expect(swap.migratedFollowups).toBe(1);
    expect(swap.migratedAutomations).toBe(1);

    expect(state.channel_connections[0].agent_id).toBeNull();
    expect(state.channel_connections[1].agent_id).toBe(22);
    expect(state.campaigns[0].instance_name).toBe("chip_estepe");
    expect(state.campaigns[1].instance_name).toBe("chip_banido"); // concluída não muda histórico
  });
});
