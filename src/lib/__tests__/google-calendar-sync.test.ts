import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lookupFilters: [] as Array<[string, unknown]>,
  updateFilters: [] as Array<[string, unknown]>,
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  existing: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => {
      const filters: Array<[string, unknown]> = [];
      let updatePayload: Record<string, unknown> | null = null;
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        }),
        maybeSingle: vi.fn(async () => {
          if (!updatePayload) state.lookupFilters.push(...filters);
          return { data: state.existing, error: null };
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          updatePayload = payload;
          return chain;
        }),
        insert: vi.fn((payload: Record<string, unknown>) => {
          state.inserts.push(payload);
          return chain;
        }),
        then: vi.fn((resolve: (value: unknown) => unknown) => {
          if (updatePayload) {
            state.updates.push(updatePayload);
            state.updateFilters.push(...filters);
          } else {
            state.lookupFilters.push(...filters);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }),
      };
      return chain;
    }),
  },
}));

vi.mock("@/lib/google-calendar", () => ({
  GoogleCalendarError: class GoogleCalendarError extends Error {},
  hasCalendarConnected: vi.fn(async () => ({ connected: true, reason: "ok" })),
  listCalendarEvents: vi.fn(async () => [{
    id: "event-1",
    status: "confirmed",
    summary: "Reunião",
    start: { dateTime: "2026-11-10T13:00:00Z" },
    end: { dateTime: "2026-11-10T14:00:00Z" },
  }]),
}));

import { syncGoogleEventsForAgent } from "../google-calendar-sync";

describe("syncGoogleEventsForAgent", () => {
  beforeEach(() => {
    state.lookupFilters = [];
    state.updateFilters = [];
    state.updates = [];
    state.inserts = [];
    state.existing = null;
  });

  it("busca evento Google somente no tenant e agente atuais", async () => {
    await syncGoogleEventsForAgent(
      { id: 42, name: "Agente", client_id: "tenant-a" },
      new Date("2026-11-10T00:00:00Z"),
      new Date("2026-11-11T00:00:00Z"),
    );

    expect(state.lookupFilters).toEqual(expect.arrayContaining([
      ["google_event_id", "event-1"],
      ["client_id", "tenant-a"],
      ["agent_id", 42],
    ]));
  });

  it("atualiza somente agendamento do tenant e agente atuais", async () => {
    state.existing = {
      id: "appointment-1",
      title: "Antigo",
      status: "confirmed",
      start_at: "2026-11-10T12:00:00Z",
      end_at: "2026-11-10T13:00:00Z",
    };

    await syncGoogleEventsForAgent(
      { id: 42, name: "Agente", client_id: "tenant-a" },
      new Date("2026-11-10T00:00:00Z"),
      new Date("2026-11-11T00:00:00Z"),
    );

    expect(state.updates).toHaveLength(1);
    expect(state.updateFilters).toEqual(expect.arrayContaining([
      ["id", "appointment-1"],
      ["client_id", "tenant-a"],
      ["agent_id", 42],
    ]));
  });
});
