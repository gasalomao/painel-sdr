import { describe, expect, it } from "vitest";
import { parseTaskInput, parseTaskQuery, taskErrorResponse } from "../dashboard-tasks";

describe("dashboard tasks validation", () => {
  it("trims text and stores an unambiguous UTC instant", () => {
    expect(parseTaskInput({ text: "  Retornar  ", due_at: "2026-10-18T10:30:00-03:00", lead_id: 12 }))
      .toEqual({ text: "Retornar", due_at: "2026-10-18T13:30:00.000Z", lead_id: 12 });
    expect(parseTaskInput({ completed: false, lead_id: null }, true)).toEqual({ completed: false, lead_id: null });
  });

  it.each([
    null, [], {}, { text: " ", due_at: "2026-10-18T12:00:00Z" },
    { text: "x".repeat(1001), due_at: "2026-10-18T12:00:00Z" },
    ...[null, "bad", "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-13-01T12:00:00Z", "2026-10-18T24:00:00Z", "2026-10-18T12:00:00", "2026-10-18T12:00:00+25:00"].map((due_at) => ({ text: "x", due_at })),
    ...[0, -1, 1.5, "1", 2147483648].map((lead_id) => ({ text: "x", due_at: "2026-10-18T12:00:00Z", lead_id })),
    { text: "x", due_at: "2026-10-18T12:00:00Z", client_id: "other" },
    { text: "x", due_at: "2026-10-18T12:00:00Z", completed_at: null },
    { text: "x", due_at: "2026-10-18T12:00:00Z", completed: true },
  ])("rejects invalid creation input %j", (input) => {
    expect(() => parseTaskInput(input)).toThrow();
  });

  it.each([{}, { completed: "true" }, { completed_at: null }, { client_id: "other" }, { id: "other", text: "x" }, { due_at: null }, { text: null }])("rejects invalid patches %j", (input) => {
    expect(() => parseTaskInput(input, true)).toThrow();
  });

  it("accepts leap days without normalizing impossible dates", () => {
    expect(parseTaskInput({ text: "x", due_at: "2028-02-29T12:00:00Z" }).due_at).toBe("2028-02-29T12:00:00.000Z");
  });

  it("defaults pagination and validates bounded integer ranges", () => {
    expect(parseTaskQuery(new URLSearchParams())).toEqual({ status: "pending", page: 0, limit: 10 });
    expect(parseTaskQuery(new URLSearchParams("status=completed&page=2&limit=20"))).toEqual({ status: "completed", page: 2, limit: 20 });
    for (const query of ["status=other", "page=-1", "page=1.5", "page=1e3", "limit=0", "limit=101", "page=9007199254740991&limit=100"]) {
      expect(() => parseTaskQuery(new URLSearchParams(query)), query).toThrow();
    }
  });

  it("identifies only the missing dashboard_tasks schema", async () => {
    for (const error of [
      { code: "42P01", message: 'relation "public.dashboard_tasks" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.dashboard_tasks' in the schema cache" },
    ]) {
      const response = taskErrorResponse(error);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "TASKS_SETUP_REQUIRED", error: "Execute migrations/017_dashboard_tasks.sql no SQL Editor para habilitar as tarefas." });
    }
    for (const error of [
      { code: "42P01", message: 'relation "leads_extraidos" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.dashboard_tasks_archive' in the schema cache" },
      { code: "42703", message: "dashboard_tasks column missing" },
      new Error("Banco indisponível"),
    ]) {
      const response = taskErrorResponse(error);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: error.message });
    }
  });
});
