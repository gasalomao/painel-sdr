import { beforeEach, describe, expect, it, vi } from "vitest";

const state: Record<string, Array<Record<string, unknown>>> = {
  contacts: [],
  sessions: [],
  chats_dashboard: [],
  campaigns: [],
  campaign_targets: [],
  leads_extraidos: [],
  scheduled_preview_deliveries: [],
  followup_campaigns: [],
  followup_targets: [],
  app_settings: [],
};

const sendMessageMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, messageId: "SENT-PREV-1" })));

vi.mock("@/lib/channel", () => ({
  sendMessage: sendMessageMock,
}));

vi.mock("@/lib/manual-send-registry", () => ({
  registerPendingAutomatedSend: vi.fn(),
  registerAiSend: vi.fn(),
}));

vi.mock("@/lib/supabase_admin", () => {
  function makeBuilder(table: string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let op: "select" | "insert" | "upsert" | "update" = "select";
    let payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
    let limitNum: number | null = null;

    const execute = async () => {
      if (!state[table]) state[table] = [];
      if (op === "insert" && payload) {
        const items = (Array.isArray(payload) ? payload : [payload]).map((it, idx) => ({
          id: (it.id as string) || `${table}-${state[table].length + idx + 1}`,
          ...it,
        }));
        state[table].push(...items);
        return { data: items, error: null };
      }
      if (op === "upsert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        state[table].push(...items);
        return { data: items, error: null };
      }
      if (op === "update" && payload && !Array.isArray(payload)) {
        const matches = state[table].filter((r) => filters.every((f) => f(r)));
        for (const row of matches) Object.assign(row, payload);
        return { data: matches, error: null };
      }

      let rows = state[table].filter((r) => filters.every((f) => f(r)));
      if (limitNum !== null) rows = rows.slice(0, limitNum);
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (data: Record<string, unknown>) => {
        op = "insert";
        payload = data;
        return builder;
      },
      upsert: (data: Record<string, unknown>) => {
        op = "upsert";
        payload = data;
        return builder;
      },
      update: (data: Record<string, unknown>) => {
        op = "update";
        payload = data;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      lte: (col: string, val: string) => {
        filters.push((r) => String(r[col] || "") <= val);
        return builder;
      },
      gte: (col: string, val: string) => {
        filters.push((r) => String(r[col] || "") >= val);
        return builder;
      },
      gt: (col: string, val: string) => {
        filters.push((r) => String(r[col] || "") > val);
        return builder;
      },
      like: (col: string, pattern: string) => {
        const prefix = pattern.replace(/%$/, "");
        filters.push((r) => String(r[col] || "").startsWith(prefix));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitNum = n;
        return builder;
      },
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

  const client = { from: (table: string) => makeBuilder(table) };
  return { supabaseAdmin: client, supabase: client };
});

import { cleanCompanyNameForApproach } from "../antiban-mixer";
import { evaluateWeekendB2BGuard } from "../campaign-pool";
import {
  MENTOR_2STEP_TEMPLATE,
  MENTOR_KANBAN_PRESET,
  SARAH_MENTOR_2STEP_PROMPT,
} from "../mentor-presets";
import {
  computeNaturalDeliveryDate,
  enqueueScheduledPreviewDelivery,
  tickScheduledPreviewDeliveries,
} from "../preview-delivery-queue";
import { hasHumanRepliedSince } from "../followup-worker";
import { checkDailyPreviewCapacityBrake } from "../campaign-worker";
import { computeMentorFunnelMetrics } from "../mentor-metrics";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

describe("Método Mentor End-to-End (2-Step, Entrega Natural, X1 Manual, Freio e 4 Taxas)", () => {
  beforeEach(() => {
    for (const k of Object.keys(state)) state[k] = [];
    vi.clearAllMocks();
  });

  it("limpa nomes de empresa com cleanShortCompanyName, valida sábado 100% em sunday_only e presets do Mentor", () => {
    expect(cleanCompanyNameForApproach("CLÍNICA VIDA & SAÚDE LTDA - Av. Paulista, 1000")).toBe(
      "Clínica Vida & Saúde"
    );

    expect(MENTOR_2STEP_TEMPLATE).toContain("{{nome_empresa}}");
    expect(SARAH_MENTOR_2STEP_PROMPT).toContain("FASE 1");
    expect(MENTOR_KANBAN_PRESET.map((c) => c.status_key)).toContain("previa_aceita");

    // Sábado 2026-11-28 14:00 BRT (= 17:00 UTC)
    const sat = new Date("2026-11-28T17:00:00.000Z");
    expect(evaluateWeekendB2BGuard(true, sat).hourlyFactor).toBe(0.5);
    expect(evaluateWeekendB2BGuard("sunday_only", sat)).toMatchObject({
      allowed: true,
      hourlyFactor: 1,
      weekday: "Sat",
    });

    // Domingo 2026-11-29 14:00 BRT
    const sun = new Date("2026-11-29T17:00:00.000Z");
    expect(evaluateWeekendB2BGuard("sunday_only", sun).allowed).toBe(false);
  });

  it("agenda entrega natural de prévia, envia mantendo IA pausada (paused_manual) e detecta intervenção humana no X1", async () => {
    const baseNow = new Date("2026-11-26T15:00:00.000Z"); // 12:00 BRT
    const plus3 = computeNaturalDeliveryDate("plus_3h", baseNow);
    expect(plus3.getTime()).toBe(baseNow.getTime() + 3 * 3600_000);

    const evening = computeNaturalDeliveryDate("evening_18h", baseNow);
    expect(evening.toISOString()).toBe("2026-11-26T21:15:00.000Z"); // 18:15 BRT

    const morning = computeNaturalDeliveryDate("next_morning_09h", baseNow);
    expect(morning.toISOString()).toBe("2026-11-27T12:15:00.000Z"); // 09:15 BRT do dia seguinte

    state.contacts.push({
      id: "contact-1",
      client_id: CLIENT_ID,
      remote_jid: "5511999991111@s.whatsapp.net",
    });
    state.sessions.push({
      id: "sess-1",
      client_id: CLIENT_ID,
      contact_id: "contact-1",
      instance_name: "sarah_01",
      bot_status: "bot_active",
    });

    const enq = await enqueueScheduledPreviewDelivery({
      clientId: CLIENT_ID,
      contactId: "contact-1",
      remoteJid: "5511999991111@s.whatsapp.net",
      instanceName: "sarah_01",
      companyName: "Clínica Vida",
      previewUrl: "https://previa.exemplo.com/clinica-vida",
      deliverySlot: "now",
      now: baseNow,
    });
    expect(enq.ok).toBe(true);

    const ticked = await tickScheduledPreviewDeliveries(baseNow.getTime() + 1000);
    expect(ticked.sent).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(state.sessions[0].bot_status).toBe("paused_manual");
    expect(state.contacts[0].preview_delivered_at).toBeTruthy();
    expect(state.scheduled_preview_deliveries[0].status).toBe("sent");

    // Follow-up enxerga que humano enviou manualmente e cancela envio automático
    state.chats_dashboard.push({
      client_id: CLIENT_ID,
      remote_jid: "5511999991111@s.whatsapp.net",
      sender_type: "human",
      created_at: new Date(baseNow.getTime() + 2000).toISOString(),
    });
    const humanTookOver = await hasHumanRepliedSince(
      "5511999991111@s.whatsapp.net",
      baseNow.toISOString(),
      CLIENT_ID
    );
    expect(humanTookOver).toBe(true);
  });

  it("freio diário de prévias trava novos envios ao atingir limite e calcula as 4 taxas do Mentor por chip/nicho/A-B", async () => {
    const now = new Date();
    state.contacts.push(
      { id: "c1", client_id: CLIENT_ID, preview_accepted_at: now.toISOString() },
      { id: "c2", client_id: CLIENT_ID, preview_accepted_at: now.toISOString() }
    );
    const brake = await checkDailyPreviewCapacityBrake(CLIENT_ID, 2, now);
    expect(brake.blocked).toBe(true);
    expect(brake.todayCount).toBe(2);
    expect(brake.reason).toBe("daily_preview_capacity_reached");

    const metrics = computeMentorFunnelMetrics([
      {
        instance_name: "sarah_01",
        ramo_negocio: "Médicos",
        ab_variant: "A",
        sent: true,
        responded: true,
        preview_accepted: true,
        preview_delivered: true,
        closed_won: true,
      },
      {
        instance_name: "sarah_01",
        ramo_negocio: "Médicos",
        ab_variant: "A",
        sent: true,
        responded: true,
        preview_accepted: false,
        preview_delivered: false,
        closed_won: false,
      },
      {
        instance_name: "sarah_02",
        ramo_negocio: "Dentistas",
        ab_variant: "B",
        sent: true,
        responded: false,
        preview_accepted: false,
        preview_delivered: false,
        closed_won: false,
      },
      {
        instance_name: "sarah_02",
        ramo_negocio: "Dentistas",
        ab_variant: "B",
        sent: true,
        responded: true,
        preview_accepted: true,
        preview_delivered: false,
        closed_won: false,
      },
    ]);

    expect(metrics.overall.sent).toBe(4);
    expect(metrics.overall.taxa_resposta_1a_msg).toBe(75);
    expect(metrics.overall.taxa_aceite_previa).toBe(66.7);
    expect(metrics.overall.taxa_entrega_previa).toBe(50);
    expect(metrics.overall.taxa_fechamento).toBe(100);
    expect(metrics.by_instance).toHaveLength(2);
    expect(metrics.by_niche).toHaveLength(2);
    expect(metrics.by_ab_variant).toHaveLength(2);
  });
});
