// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const state: Record<string, Row[]> = {
  whatsapp_warmup_configs: [],
  app_settings: [],
  channel_connections: [],
};
let tableError: Record<string, { code: string; message: string } | null> = {};
const upserts: Array<{ table: string; row: Row; opts?: Record<string, unknown> }> = [];
const updates: Array<{ table: string; patch: Row; filters: Array<[string, unknown]> }> = [];

vi.mock("@/lib/supabase_admin", () => {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];

    const matches = (row: Row): boolean =>
      filters.every(([column, value]) => row[column] === value);

    const builder: any = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      maybeSingle: async () => {
        const error = tableError[table] || null;
        if (error) return { data: null, error };
        return { data: (state[table] || []).find(matches) || null, error: null };
      },
      then: (resolve: any, reject: any) => {
        const error = tableError[table] || null;
        const rows = error ? null : (state[table] || []).filter(matches);
        return Promise.resolve({ data: rows, error }).then(resolve, reject);
      },
      upsert: async (row: Row, opts?: Record<string, unknown>) => {
        upserts.push({ table, row, opts });
        const list = (state[table] ||= []);
        const rows = Array.isArray(row) ? row : [row];
        for (const item of rows) {
          const index = list.findIndex(
            (existing) =>
              (item.key !== undefined && existing.key === item.key) ||
              (item.client_id !== undefined &&
                item.instance_name !== undefined &&
                existing.client_id === item.client_id &&
                existing.instance_name === item.instance_name)
          );
          if (index >= 0) {
            if (!opts?.ignoreDuplicates) Object.assign(list[index], item);
          } else {
            list.push({ ...item });
          }
        }
        return { data: null, error: null };
      },
      insert: async (row: Row) => {
        const list = (state[table] ||= []);
        if (row.key !== undefined && list.some((existing) => existing.key === row.key)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        list.push({ ...row });
        return { data: null, error: null };
      },
      delete: () => {
        const deleteFilters: Array<[string, unknown]> = [];
        const deleteBuilder: any = {
          eq: (column: string, value: unknown) => {
            deleteFilters.push([column, value]);
            return deleteBuilder;
          },
          then: (resolve: any, reject: any) => {
            const list = state[table] || [];
            state[table] = list.filter(
              (item) => !deleteFilters.every(([column, value]) => item[column] === value)
            );
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          },
        };
        return deleteBuilder;
      },
      update: (patch: Row) => {
        const updateFilters: Array<[string, unknown]> = [];
        const updateBuilder: any = {
          eq: (column: string, value: unknown) => {
            updateFilters.push([column, value]);
            return updateBuilder;
          },
          then: (resolve: any, reject: any) => {
            updates.push({ table, patch, filters: updateFilters });
            for (const item of state[table] || []) {
              if (updateFilters.every(([column, value]) => item[column] === value)) {
                Object.assign(item, patch);
              }
            }
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          },
        };
        return updateBuilder;
      },
    };

    return builder;
  };

  return { supabaseAdmin: { from } };
});

import {
  acquireWarmupTickLock,
  ensureWarmupConfigsForTenant,
  getEffectiveDailyTarget,
  readTenantWarmupConfigs,
  releaseWarmupTickLock,
  sanitizeWarmupPatch,
  saveWarmupConfig,
  setWarmupEnabledForAll,
  type TenantConnection,
} from "../warmup-config-service";
import type { WarmupConfig } from "../warmup-types";

function baseConfig(overrides: Partial<WarmupConfig> = {}): WarmupConfig {
  return {
    client_id: "tenant-1",
    instance_name: "chip-1",
    enabled: true,
    stage: 1,
    stage_auto_progress: true,
    days_active: 1,
    consecutive_successful_days: 0,
    health_score: 100,
    is_quarantined: false,
    daily_target: 10,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 180,
    max_interval_seconds: 360,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 8,
    allowed_end_hour: 21,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: true,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
    ...overrides,
  };
}

const openChip = (name: string): TenantConnection => ({
  instance_name: name,
  status: "open",
  phone_number: null,
});

beforeEach(() => {
  state.whatsapp_warmup_configs = [];
  state.app_settings = [];
  state.channel_connections = [];
  tableError = {};
  upserts.length = 0;
  updates.length = 0;
});

describe("sanitizeWarmupPatch", () => {
  it("mantém apenas campos editáveis e ignora contadores internos", () => {
    const patch = sanitizeWarmupPatch({
      enabled: true,
      stage: 3,
      purpose: "inbound",
      daily_target: 55,
      health_score: 1,
      sent_today: 999,
      days_active: 999,
      client_id: "outro-tenant",
    });

    expect(patch).toMatchObject({ enabled: true, stage: 3, purpose: "inbound", daily_target: 55 });
    expect(patch).not.toHaveProperty("health_score");
    expect(patch).not.toHaveProperty("sent_today");
    expect(patch).not.toHaveProperty("days_active");
    expect(patch).not.toHaveProperty("client_id");
  });

  it("aplica limites e corrige intervalo invertido", () => {
    const patch = sanitizeWarmupPatch({
      stage: 9,
      daily_target: 0,
      min_interval_seconds: 500,
      max_interval_seconds: 60,
      allowed_start_hour: 30,
      allowed_end_hour: 0,
    });

    expect(patch.stage).toBe(4);
    expect(patch.daily_target).toBe(1);
    expect(patch.min_interval_seconds).toBe(500);
    expect(patch.max_interval_seconds).toBe(500);
    expect(patch.allowed_start_hour).toBe(23);
    expect(patch.allowed_end_hour).toBe(1);
  });
});

describe("readTenantWarmupConfigs", () => {
  it("usa a tabela como fonte mesmo quando ela está vazia", async () => {
    state.app_settings.push({
      key: "warmup_configs_tenant-1",
      value: JSON.stringify({ "chip-antigo": baseConfig({ instance_name: "chip-antigo" }) }),
    });

    const result = await readTenantWarmupConfigs("tenant-1");

    expect(result.source).toBe("table");
    expect(result.configs).toEqual({});
  });

  it("cai para app_settings somente quando a tabela não existe", async () => {
    tableError.whatsapp_warmup_configs = { code: "42P01", message: "relation does not exist" };
    state.app_settings.push({
      key: "warmup_configs_tenant-1",
      value: JSON.stringify({ "chip-antigo": baseConfig({ instance_name: "chip-antigo" }) }),
    });

    const result = await readTenantWarmupConfigs("tenant-1");

    expect(result.source).toBe("settings");
    expect(Object.keys(result.configs)).toEqual(["chip-antigo"]);
  });

  it("falha fechado em erro transitório, sem religar cópia antiga", async () => {
    tableError.whatsapp_warmup_configs = { code: "500", message: "network error" };
    state.app_settings.push({
      key: "warmup_configs_tenant-1",
      value: JSON.stringify({ "chip-pausado": baseConfig({ instance_name: "chip-pausado", enabled: true }) }),
    });

    const result = await readTenantWarmupConfigs("tenant-1");

    expect(result.source).toBe("settings");
    expect(result.configs).toEqual({});
  });
});

describe("ensureWarmupConfigsForTenant", () => {
  it("cadastra chip conectado sem sobrescrever config existente pausada", async () => {
    state.whatsapp_warmup_configs.push(
      baseConfig({ instance_name: "chip-pausado", enabled: false })
    );

    const result = await ensureWarmupConfigsForTenant("tenant-1", {
      connections: [openChip("chip-pausado"), openChip("chip-novo")],
    });

    expect(result.created).toEqual(["chip-novo"]);
    expect(result.enabledNew).toEqual(["chip-novo"]);

    const paused = state.whatsapp_warmup_configs.find((c) => c.instance_name === "chip-pausado");
    expect(paused?.enabled).toBe(false);

    const created = state.whatsapp_warmup_configs.find((c) => c.instance_name === "chip-novo");
    expect(created).toMatchObject({
      enabled: true,
      stage: 1,
      purpose: "contingency",
      client_id: "tenant-1",
    });
  });

  it("não cadastra chip desconectado", async () => {
    const result = await ensureWarmupConfigsForTenant("tenant-1", {
      connections: [
        { instance_name: "chip-off", status: "close", phone_number: null },
        { instance_name: "chip-connecting", status: "connecting", phone_number: null },
      ],
    });

    expect(result.created).toEqual([]);
    expect(state.whatsapp_warmup_configs).toHaveLength(0);
  });

  it("respeita a flag global de aquecimento automático desligada", async () => {
    state.app_settings.push({
      key: "warmup_global_tenant-1",
      value: JSON.stringify({ auto_warmup_new_chips: false }),
    });

    const result = await ensureWarmupConfigsForTenant("tenant-1", {
      connections: [openChip("chip-novo")],
    });

    expect(result.created).toEqual(["chip-novo"]);
    expect(result.enabledNew).toEqual([]);
    expect(state.whatsapp_warmup_configs[0].enabled).toBe(false);
  });

  it("aproveita telefone do provider_config na criação", async () => {
    await ensureWarmupConfigsForTenant("tenant-1", {
      connections: [{ instance_name: "chip-tel", status: "open", phone_number: "5511999990000" }],
    });

    expect(state.whatsapp_warmup_configs[0].phone_number).toBe("5511999990000");
  });
});

describe("getEffectiveDailyTarget", () => {
  it("limita a meta pelo teto da finalidade", () => {
    expect(getEffectiveDailyTarget(baseConfig({ stage: 4, daily_target: 70, purpose: "outbound" }))).toBe(70);
    expect(getEffectiveDailyTarget(baseConfig({ stage: 4, daily_target: 70, purpose: "inbound" }))).toBe(40);
    expect(getEffectiveDailyTarget(baseConfig({ stage: 4, daily_target: 70, purpose: "contingency" }))).toBe(20);
  });
});

describe("saveWarmupConfig", () => {
  it("grava apenas campos permitidos", async () => {
    const result = await saveWarmupConfig("tenant-1", "chip-1", {
      enabled: true,
      stage: 2,
      health_score: 1,
      sent_today: 500,
      client_id: "invasor",
    });

    expect(result.ok).toBe(true);
    const payload = upserts.find((entry) => entry.table === "whatsapp_warmup_configs")?.row;
    expect(payload).toMatchObject({ client_id: "tenant-1", instance_name: "chip-1", enabled: true, stage: 2 });
    expect(payload).not.toHaveProperty("health_score");
    expect(payload).not.toHaveProperty("sent_today");
  });
});

describe("setWarmupEnabledForAll", () => {
  it("inclui chip recém-conectado ao ativar todos", async () => {
    await ensureWarmupConfigsForTenant("tenant-1", {
      connections: [openChip("chip-1"), openChip("chip-2")],
    });

    const result = await setWarmupEnabledForAll("tenant-1", true);

    expect(result.source).toBe("table");
    expect(result.updated).toBe(2);
    expect(state.whatsapp_warmup_configs.every((c) => c.enabled === true)).toBe(true);
  });
});

describe("lock de tick por tenant", () => {
  it("impede dois processos de processarem o mesmo tenant ao mesmo tempo", async () => {
    expect(await acquireWarmupTickLock("tenant-1", "processo-a")).toBe(true);
    expect(await acquireWarmupTickLock("tenant-1", "processo-b")).toBe(false);

    await releaseWarmupTickLock("tenant-1", "processo-b");
    expect(await acquireWarmupTickLock("tenant-1", "processo-b")).toBe(false);

    await releaseWarmupTickLock("tenant-1", "processo-a");
    expect(await acquireWarmupTickLock("tenant-1", "processo-b")).toBe(true);
  });
});
