import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));

import { readCaptureIds, readRejectedCaptureIds, updateAutomationCapture, type AutomationCaptureRow } from "@/lib/automation-capture";

type Filters = Array<[string, unknown]>;
let row: AutomationCaptureRow;
let writes: Array<{ patch: Partial<AutomationCaptureRow>; filters: Filters }>;
let readError: string | null;
let writeError: string | null;
let conflicts: number;
let onConflict: (() => void) | null;

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "object" && actual !== null && typeof expected === "string") return JSON.stringify(actual) === expected;
  return actual === expected;
}

beforeEach(() => {
  row = { id: "auto-a", client_id: "client-a", status: "running", phase: "scraping", scrape_filters: { _capturedLeadIds: [1], _captureAttemptId: "attempt-a" }, scraped_count: 1, campaign_id: null, followup_campaign_id: null, started_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" };
  writes = []; readError = null; writeError = null; conflicts = 0; onConflict = null;
  mocks.from.mockImplementation((table: string) => {
    expect(table).toBe("automations");
    const filters: Filters = [];
    let patch: Partial<AutomationCaptureRow> | null = null;
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      update: (value: Partial<AutomationCaptureRow>) => { patch = value; return query; },
      maybeSingle: async () => {
        if (!patch && readError) return { data: null, error: { message: readError } };
        if (patch && writeError) return { data: null, error: { message: writeError } };
        if (patch) {
          writes.push({ patch, filters: [...filters] });
          if (conflicts-- > 0) { onConflict?.(); return { data: null, error: null }; }
        }
        if (!filters.every(([key, value]) => valueMatches(row[key], value))) return { data: null, error: null };
        if (patch) row = { ...row, ...patch };
        return { data: structuredClone(row), error: null };
      },
    };
    return query;
  });
});

describe("capture membership", () => {
  it("accepts only unique positive safe integer IDs", () => {
    expect(readCaptureIds({ _capturedLeadIds: [1, 1, 2, 0, -1, 2.5, "3", null, Number.MAX_SAFE_INTEGER + 1] })).toEqual([1, 2]);
    expect(readCaptureIds(null)).toEqual([]);
    expect(readCaptureIds({})).toEqual([]);
    expect(readRejectedCaptureIds({ _rejectedLeadIds: [2, 2, 4] })).toEqual([2, 4]);
  });
});

describe("updateAutomationCapture", () => {
  it("updates only the tenant-owned current snapshot", async () => {
    const result = await updateAutomationCapture("client-a", "auto-a", current => ({
      scrape_filters: { ...current.scrape_filters, _capturedLeadIds: [...readCaptureIds(current.scrape_filters), 2] }, scraped_count: 2,
    }));
    expect(result?.scraped_count).toBe(2);
    expect(writes[0].filters).toEqual(expect.arrayContaining([["client_id", "client-a"], ["id", "auto-a"], ["status", "running"], ["phase", "scraping"], ["scrape_filters", JSON.stringify({ _capturedLeadIds: [1], _captureAttemptId: "attempt-a" })]]));
  });

  it("re-reads after a conflict so concurrent capture IDs are not lost", async () => {
    conflicts = 1;
    onConflict = () => { row.scrape_filters = { ...row.scrape_filters, _capturedLeadIds: [1, 3] }; row.scraped_count = 2; };
    await updateAutomationCapture("client-a", "auto-a", current => {
      const ids = [...readCaptureIds(current.scrape_filters), 2];
      return { scrape_filters: { ...current.scrape_filters, _capturedLeadIds: ids }, scraped_count: ids.length };
    });
    expect(readCaptureIds(row.scrape_filters)).toEqual([1, 3, 2]);
    expect(row.scraped_count).toBe(3);
    expect(writes).toHaveLength(2);
  });

  it("does not overwrite a pause or new attempt after losing its claim", async () => {
    conflicts = 1;
    onConflict = () => { row.status = "paused"; row.scrape_filters = { ...row.scrape_filters, _captureAttemptId: null }; };
    const result = await updateAutomationCapture("client-a", "auto-a", current => current.status === "running" && current.scrape_filters._captureAttemptId === "attempt-a"
      ? { scraped_count: 2 } : null);
    expect(result).toBeNull();
    expect(row.status).toBe("paused");
    expect(row.scraped_count).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it("never reads or writes another tenant's row", async () => {
    const mutate = vi.fn(() => ({ scraped_count: 2 }));
    expect(await updateAutomationCapture("client-b", "auto-a", mutate)).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it.each(["read", "write"])("fails closed on %s errors", async mode => {
    if (mode === "read") readError = "offline"; else writeError = "offline";
    await expect(updateAutomationCapture("client-a", "auto-a", () => ({ scraped_count: 2 }))).rejects.toThrow("offline");
    expect(row.scraped_count).toBe(1);
  });

  it("does not overwrite a campaign claim even when updated_at has a millisecond collision", async () => {
    let raced = false;
    const original = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => {
      const query = original(table);
      const update = query.update;
      query.update = (patch: Partial<AutomationCaptureRow>) => {
        if (!raced) { raced = true; row.campaign_id = "campaign-first"; }
        return update(patch);
      };
      return query;
    });
    const result = await updateAutomationCapture("client-a", "auto-a", current => current.campaign_id ? null : { campaign_id: "campaign-second" });
    expect(result).toBeNull();
    expect(row.campaign_id).toBe("campaign-first");
  });

  it("bounds conflicting retries instead of spinning indefinitely", async () => {
    conflicts = 10;
    await expect(updateAutomationCapture("client-a", "auto-a", () => ({ scraped_count: 2 }))).rejects.toThrow(/concorr|atualiz/i);
    expect(writes.length).toBeLessThanOrEqual(5);
  });

  it("rejects missing tenant before touching persistence", async () => {
    await expect(updateAutomationCapture("", "auto-a", () => ({ scraped_count: 2 }))).rejects.toThrow(/cliente/i);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
