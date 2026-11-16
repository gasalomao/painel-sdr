import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = vi.hoisted(() => ({
  whatsapp_warmup_configs: [] as Row[],
  whatsapp_warmup_logs: [] as Row[],
  app_settings: [] as Row[],
}));

const mocks = vi.hoisted(() => ({
  fetchProfilePicture: vi.fn(),
  findProxy: vi.fn(),
}));

type QueryChain = {
  select: () => QueryChain;
  insert: (data: Row | Row[]) => QueryChain;
  upsert: (data: Row) => QueryChain;
  update: (patch: Row) => QueryChain;
  eq: (col: string, val: unknown) => QueryChain;
  maybeSingle: () => QueryChain;
  then: <TResult1 = { data: Row | Row[] | null; error: null }, TResult2 = never>(
    resolve?: ((value: { data: Row | Row[] | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) => Promise<TResult1 | TResult2>;
};

function buildQuery(table: string): QueryChain {
  const filters: Array<(row: Row) => boolean> = [];
  let updateData: Row | null = null;
  let single = false;

  const chain: QueryChain = {
    select() {
      return chain;
    },
    insert(data: Row | Row[]) {
      const list = (tables[table] ||= []);
      const rows = Array.isArray(data) ? data : [data];
      for (const r of rows) list.push({ ...r });
      return chain;
    },
    upsert(data: Row) {
      const list = (tables[table] ||= []);
      const idx = list.findIndex((r: Row) => data.key && r.key === data.key);
      if (idx >= 0) Object.assign(list[idx], data);
      else list.push({ ...data });
      return chain;
    },
    update(patch: Row) {
      updateData = patch;
      return chain;
    },
    eq(col: string, val: unknown) {
      filters.push((row) => row[col] === val);
      return chain;
    },
    maybeSingle() {
      single = true;
      return chain;
    },
    then(resolve, reject) {
      const list = (tables[table] || []).filter((r: Row) => filters.every((f) => f(r)));
      if (updateData) {
        for (const r of list) Object.assign(r, updateData);
      }
      return Promise.resolve({
        data: single ? list[0] || null : list,
        error: null,
      }).then(resolve, reject);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (t: string) => buildQuery(t) },
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    fetchProfilePicture: mocks.fetchProfilePicture,
    findProxy: mocks.findProxy,
  },
}));

import {
  recordWebhookDeliveryFeedback,
  resetDeliveryFeedbackForTests,
} from "../warmup-engine";
import { auditChipDay0Hygiene } from "../warmup-groups";

describe("Feedback Loop Webhook -> Disjuntor & Reauditoria Dia-0", () => {
  beforeEach(() => {
    resetDeliveryFeedbackForTests();
    tables.whatsapp_warmup_configs.length = 0;
    tables.whatsapp_warmup_logs.length = 0;
    tables.app_settings.length = 0;
    mocks.fetchProfilePicture.mockReset();
    mocks.findProxy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aciona handleInstanceFailure apenas após surto de >= 3 erros em 10 min e limpa janela ao confirmar entrega", async () => {
    const clientId = "tenant-feedback";
    tables.whatsapp_warmup_configs.push({
      client_id: clientId,
      instance_name: "chip-feedback",
      enabled: true,
      health_score: 100,
      error_count_today: 0,
      is_quarantined: false,
    });

    const t0 = 1_700_000_000_000;
    expect(
      await recordWebhookDeliveryFeedback({
        clientId,
        instanceName: "chip-feedback",
        statusText: "error",
        nowMs: t0,
      })
    ).toMatchObject({ triggered: false, recentErrors: 1 });

    expect(
      await recordWebhookDeliveryFeedback({
        clientId,
        instanceName: "chip-feedback",
        statusText: "error",
        nowMs: t0 + 30_000,
      })
    ).toMatchObject({ triggered: false, recentErrors: 2 });

    // Entrega confirmada zera o contador de surto
    expect(
      await recordWebhookDeliveryFeedback({
        clientId,
        instanceName: "chip-feedback",
        statusText: "delivered",
        nowMs: t0 + 40_000,
      })
    ).toMatchObject({ triggered: false, cleared: true, recentErrors: 0 });

    // Novo erro após entrega recomeça do 1 (não dispara disjuntor ainda)
    expect(
      await recordWebhookDeliveryFeedback({
        clientId,
        instanceName: "chip-feedback",
        statusText: "error",
        nowMs: t0 + 50_000,
      })
    ).toMatchObject({ triggered: false, recentErrors: 1 });

    // Mais 2 erros seguidos (< 10 min) -> completa 3 erros e aciona handleInstanceFailure
    await recordWebhookDeliveryFeedback({
      clientId,
      instanceName: "chip-feedback",
      statusText: "error",
      nowMs: t0 + 60_000,
    });
    const third = await recordWebhookDeliveryFeedback({
      clientId,
      instanceName: "chip-feedback",
      statusText: "error",
      nowMs: t0 + 90_000,
    });

    expect(third.triggered).toBe(true);
    expect(tables.whatsapp_warmup_configs[0].error_count_today).toBe(1);
    expect(tables.whatsapp_warmup_configs[0].health_score).toBe(80);
    expect(
      tables.whatsapp_warmup_logs.some((l) => l.receiver_instance === "circuit_breaker")
    ).toBe(true);
  });

  it("auditChipDay0Hygiene registra alerta sem foto/proxy BR e limpa ao validar corretamente", async () => {
    const clientId = "tenant-day0";
    tables.whatsapp_warmup_configs.push({
      client_id: clientId,
      instance_name: "chip-day0",
      phone_number: "5511999990000",
    });

    mocks.fetchProfilePicture.mockResolvedValueOnce(null);
    mocks.findProxy.mockResolvedValueOnce({ enabled: true, host: "1.2.3.4" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ status: "success", countryCode: "US", country: "United States" }))
    );

    const dirty = await auditChipDay0Hygiene(clientId, "chip-day0", { forceInTests: true });
    expect(dirty.ok).toBe(false);
    expect(dirty.warnings).toHaveLength(2);
    expect(tables.whatsapp_warmup_logs[0].message_text).toContain("Auditoria Dia-0 (chip-day0)");

    // Agora foto existe e proxy desativado/BR -> marca Auditoria Dia-0 OK para auto-limpar alerta
    mocks.fetchProfilePicture.mockResolvedValueOnce("https://pps.whatsapp.net/foto.jpg");
    mocks.findProxy.mockResolvedValueOnce({ enabled: false, host: null });

    const clean = await auditChipDay0Hygiene(clientId, "chip-day0", { forceInTests: true });
    expect(clean.ok).toBe(true);
    expect(clean.warnings).toEqual([]);
    expect(tables.whatsapp_warmup_logs[1].message_text).toContain("✓ Auditoria Dia-0 OK (chip-day0)");
  });
});

