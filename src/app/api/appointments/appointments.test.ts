// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  auth: vi.fn(),
  from: vi.fn(),
  hasCalendarConnected: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  cancelCalendarEvent: vi.fn(),
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  updateFilters: [] as Array<Array<[string, unknown]>>,
  failNextAppointmentUpdate: false,
  failNextAppointmentInsert: false,
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: state.auth,
  isInstanceOwnedByClient: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: state.from } }));
vi.mock("@/lib/google-calendar", () => ({
  GoogleCalendarError: class GoogleCalendarError extends Error {},
  createCalendarEvent: state.createCalendarEvent,
  updateCalendarEvent: state.updateCalendarEvent,
  cancelCalendarEvent: state.cancelCalendarEvent,
  hasCalendarConnected: state.hasCalendarConnected,
}));

import { POST } from "./route";
import { PATCH } from "./[id]/route";

const tenant = "11111111-1111-4111-8111-111111111111";
const appointmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const startAt = "2026-11-10T13:00:00.000Z";
const endAt = "2026-11-10T14:00:00.000Z";

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string } | null;

class Query implements PromiseLike<{ data: Row | Row[] | null; error: DbError }> {
  operation = "select";
  payload: Row = {};
  filters: Array<[string, unknown]> = [];
  singleResult = false;

  constructor(readonly table: string) {}

  select(): this { return this; }
  single(): this { this.singleResult = true; return this; }
  insert(payload: Row): this { this.operation = "insert"; this.payload = payload; return this; }
  update(payload: Row): this { this.operation = "update"; this.payload = payload; return this; }
  eq(key: string, value: unknown): this { this.filters.push([key, value]); return this; }
  lt(): this { return this; }
  gt(): this { return this; }
  in(): this { return this; }
  limit(): this { return this; }
  order(): this { return this; }
  maybeSingle(): this { this.singleResult = true; return this; }

  then<TResult1 = { data: Row | Row[] | null; error: DbError }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row | Row[] | null; error: DbError }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const value = this.execute();
    return Promise.resolve(value).then(onfulfilled, onrejected);
  }

  private execute(): { data: Row | Row[] | null; error: DbError } {
    const rows = state.rows[this.table] || [];
    const filtered = rows.filter((row) => this.filters.every(([key, expected]) => row[key] === expected));

    if (this.operation === "insert") {
      if (this.table === "appointments" && state.failNextAppointmentInsert) {
        state.failNextAppointmentInsert = false;
        return {
          data: null,
          error: { code: "42703", message: "column appointments.google_error does not exist" },
        };
      }
      const row = { id: appointmentId, ...this.payload };
      state.rows[this.table].push(row);
      return { data: this.singleResult ? row : [row], error: null };
    }

    if (this.operation === "update") {
      state.updateFilters.push([...this.filters]);
      if (this.table === "appointments" && state.failNextAppointmentUpdate) {
        state.failNextAppointmentUpdate = false;
        return {
          data: null,
          error: { code: "PGRST204", message: "Could not find the 'location' column" },
        };
      }
      filtered.forEach((row) => Object.assign(row, this.payload));
      return { data: this.singleResult ? (filtered[0] ?? null) : filtered, error: null };
    }

    return { data: this.singleResult ? (filtered[0] ?? null) : filtered, error: null };
  }
}

function request(path: string, body: unknown, method = "PATCH"): NextRequest {
  return new NextRequest(`http://localhost/api/appointments${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.auth.mockResolvedValue({ ok: true, clientId: tenant, isAdmin: false, impersonating: false, claims: {} });
  state.hasCalendarConnected.mockResolvedValue({ connected: false, reason: "no_tokens" });
  state.updateCalendarEvent.mockResolvedValue({ id: "google-1", htmlLink: "https://calendar.google.com/event?eid=google-1" });
  state.updateFilters = [];
  state.failNextAppointmentUpdate = false;
  state.rows = {
    appointments: [{
      id: appointmentId,
      client_id: tenant,
      agent_id: 7,
      remote_jid: "5511999999999@s.whatsapp.net",
      google_event_id: "google-1",
      calendar_id: "primary",
      title: "Consulta",
      description: null,
      location: null,
      service_name: null,
      start_at: startAt,
      end_at: endAt,
      status: "confirmed",
      attendees: [],
      all_day: false,
      visibility: "default",
      color_id: null,
      recurrence: null,
      conference_data: null,
      metadata: {},
    }],
    agent_settings: [{ id: 7, client_id: tenant }],
  };
  state.from.mockImplementation((table: string) => new Query(table));
});

describe("agendamentos e Google Calendar", () => {
  it("POST persiste google_error quando nenhum agente tem Google conectado", async () => {
    const response = await POST(request("", {
      agent_id: 7,
      remote_jid: "5511999999999@s.whatsapp.net",
      title: "Consulta",
      start_at: startAt,
      end_at: endAt,
      sync_google: true,
    }, "POST"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.google_error).toContain("Nenhum agente com Google Calendar conectado");
    const inserted = state.rows.appointments[state.rows.appointments.length - 1];
    expect(inserted.google_error).toBe(body.google_error);
  });

  it("PATCH persiste contato WhatsApp editado", async () => {
    const response = await PATCH(
      request(`/${appointmentId}`, {
        remote_jid: "5511888888888@s.whatsapp.net",
        sync_google: false,
      }),
      { params: Promise.resolve({ id: appointmentId }) },
    );

    expect(response.status).toBe(200);
    expect(state.rows.appointments[0].remote_jid).toBe("5511888888888@s.whatsapp.net");
  });

  it("PATCH rejeita contato WhatsApp inválido", async () => {
    const response = await PATCH(
      request(`/${appointmentId}`, { remote_jid: "não é telefone" }),
      { params: Promise.resolve({ id: appointmentId }) },
    );

    expect(response.status).toBe(400);
    expect(state.rows.appointments[0].remote_jid).toBe("5511999999999@s.whatsapp.net");
  });

  it("PATCH mantém placeholder Google de evento importado", async () => {
    state.rows.appointments[0].remote_jid = "google:event-1";
    state.rows.appointments[0].google_event_id = "event-1";

    const response = await PATCH(
      request(`/${appointmentId}`, {
        remote_jid: "google:event-1",
        sync_google: false,
      }),
      { params: Promise.resolve({ id: appointmentId }) },
    );

    expect(response.status).toBe(200);
    expect(state.rows.appointments[0].remote_jid).toBe("google:event-1");
  });

  it("PATCH mantém escopo do tenant no retry sem colunas Google", async () => {
    state.failNextAppointmentUpdate = true;

    const response = await PATCH(
      request(`/${appointmentId}`, {
        location: "Rua Teste",
        sync_google: false,
      }),
      { params: Promise.resolve({ id: appointmentId }) },
    );

    expect(response.status).toBe(200);
    expect(state.updateFilters).toHaveLength(2);
    expect(state.updateFilters[1]).toEqual(expect.arrayContaining([
      ["id", appointmentId],
      ["client_id", state.rows.appointments[0].client_id],
    ]));
  });

  it("PATCH rejeita agent_id de outro tenant", async () => {
    state.rows.agent_settings = [];

    const response = await PATCH(
      request(`/${appointmentId}`, { agent_id: 99 }),
      { params: Promise.resolve({ id: appointmentId }) },
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("Agente não pertence");
    expect(state.rows.appointments[0].agent_id).toBe(7);
  });

  it("PATCH troca agente recriando evento no novo Google em vez de atualizar o evento antigo", async () => {
    state.rows.agent_settings = [
      { id: 7, client_id: tenant },
      { id: 8, client_id: tenant },
    ];
    state.createCalendarEvent.mockResolvedValue({
      id: "google-2",
      htmlLink: "https://calendar.google.com/event?eid=google-2",
    });

    const response = await PATCH(
      request(`/${appointmentId}`, { agent_id: 8 }),
      { params: Promise.resolve({ id: appointmentId }) },
    );

    expect(response.status).toBe(200);
    expect(state.updateCalendarEvent).not.toHaveBeenCalled();
    expect(state.createCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 8,
      title: "Consulta",
      startAt: startAt,
      endAt: endAt,
    }));
    expect(state.rows.appointments[0]).toMatchObject({
      agent_id: 8,
      google_event_id: "google-2",
      html_link: "https://calendar.google.com/event?eid=google-2",
    });
  });

  it("PATCH troca agente sem deixar vínculo Google antigo quando criação falha", async () => {
    state.rows.agent_settings = [
      { id: 7, client_id: tenant },
      { id: 8, client_id: tenant },
    ];
    state.createCalendarEvent.mockRejectedValue(new Error("API indisponível"));

    const response = await PATCH(
      request(`/${appointmentId}`, { agent_id: 8 }),
      { params: Promise.resolve({ id: appointmentId }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.google_error).toContain("API indisponível");
    expect(state.rows.appointments[0]).toMatchObject({
      agent_id: 8,
      google_event_id: null,
      html_link: null,
    });
    expect(state.rows.appointments[0].google_error).toContain("API indisponível");
  });

  it("PATCH persiste google_error quando atualização Google falha", async () => {
    state.updateCalendarEvent.mockRejectedValue(new Error("API indisponível"));

    const response = await PATCH(
      request(`/${appointmentId}`, { title: "Novo título" }),
      { params: Promise.resolve({ id: appointmentId }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.google_error).toContain("API indisponível");
    expect(state.rows.appointments[0].google_error).toContain("API indisponível");
  });

  it("POST recupera graciosamente quando appointments.google_error não existe no banco, preservando metadata e campos Google", async () => {
    state.failNextAppointmentInsert = true;
    state.hasCalendarConnected.mockResolvedValue({ connected: true, email: "agente@teste.com" });
    state.createCalendarEvent.mockResolvedValue({
      id: "google-meet-123",
      htmlLink: "https://calendar.google.com/event?eid=meet-123",
      conferenceData: {
        entryPoints: [{ uri: "https://meet.google.com/abc-def-ghi" }],
      },
    });

    const response = await POST(
      request("", {
        remote_jid: "5511999999999@s.whatsapp.net",
        title: "Reunião Google Meet",
        start_at: startAt,
        end_at: endAt,
        agent_id: 7,
        create_meet: true,
        sync_google: true,
      }, "POST"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.appointment).toBeDefined();
    // Confirma que o agendamento foi salvo sem a coluna ausente, mas com os outros campos intactos
    const inserted = state.rows.appointments.at(-1);
    expect(inserted?.title).toBe("Reunião Google Meet");
    expect(inserted?.google_event_id).toBe("google-meet-123");
    expect(inserted?.conference_data).toEqual({
      entryPoints: [{ uri: "https://meet.google.com/abc-def-ghi" }],
    });
  });

  it("POST cria evento no Google com Google Meet e retorna links para a UI", async () => {
    state.hasCalendarConnected.mockResolvedValue({ connected: true, email: "agente@teste.com" });
    state.createCalendarEvent.mockResolvedValue({
      id: "google-meet-999",
      htmlLink: "https://calendar.google.com/event?eid=meet-999",
      conferenceData: {
        entryPoints: [{ uri: "https://meet.google.com/xyz-uvw-rst", entryPointType: "video" }],
        conferenceId: "xyz-uvw-rst",
      },
    });

    const response = await POST(
      request("", {
        remote_jid: "5511999999999@s.whatsapp.net",
        title: "Demo Produto com Meet",
        start_at: startAt,
        end_at: endAt,
        agent_id: 7,
        create_meet: true,
        sync_google: true,
      }, "POST"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.appointment.html_link).toBe("https://calendar.google.com/event?eid=meet-999");
    expect(body.appointment.conference_data).toBeDefined();
    expect(state.createCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({
      createMeet: true,
      title: "Demo Produto com Meet",
    }));
  });
});
