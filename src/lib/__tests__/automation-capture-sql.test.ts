// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: mocks.from } }));
import { readCaptureIds, updateAutomationCapture, type AutomationCaptureRow } from "@/lib/automation-capture";

let db: PGlite;
const client = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const auto = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let beforeWrite: (() => Promise<void>) | null = null;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE automations(id uuid PRIMARY KEY, client_id uuid NOT NULL, status text, phase text,
    scrape_filters jsonb, scraped_count int, campaign_id uuid, followup_campaign_id uuid, started_at timestamptz, updated_at timestamptz);`);
}, 60000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  beforeWrite = null;
  await db.exec("DELETE FROM automations");
  await db.query("INSERT INTO automations VALUES ($1,$2,'running','scraping',$3,13,NULL,NULL,now(),now())", [auto, client, JSON.stringify({ _capturedLeadIds: Array.from({ length: 13 }, (_, i) => i + 1), _captureAttemptId: "a" })]);
  mocks.from.mockImplementation((table: string) => {
    expect(table).toBe("automations");
    const filters: Array<[string, unknown, boolean]> = [];
    let patch: Record<string, unknown> | null = null;
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value, false]); return query; },
      is: (key: string, value: unknown) => { filters.push([key, value, true]); return query; },
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      maybeSingle: async () => {
        if (patch && beforeWrite) { const effect = beforeWrite; beforeWrite = null; await effect(); }
        const params: unknown[] = [];
        const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
        const encode = (key: string, value: unknown) => key === "scrape_filters" && typeof value === "object" ? JSON.stringify(value) : value;
        const set = patch ? Object.entries(patch).map(([key, value]) => `"${key}"=${bind(encode(key, value))}`).join(",") : "";
        const where = filters.map(([key, value, is]) => is ? `"${key}" IS NULL` : `"${key}"=${bind(encode(key, value))}`).join(" AND ");
        const sql = patch ? `UPDATE automations SET ${set} WHERE ${where} RETURNING *` : `SELECT * FROM automations WHERE ${where}`;
        const { rows } = await db.query(sql, params);
        // Supabase returns ISO text for timestamptz, not PGlite Date instances.
        return { data: rows[0] ? JSON.parse(JSON.stringify(rows[0])) : null, error: null };
      },
    };
    return query;
  });
});

describe("capture checkpoint with real local PostgreSQL", () => {
  it("preserves a concurrently committed fourteenth capture using JSONB compare-and-set", async () => {
    beforeWrite = async () => { await db.query("UPDATE automations SET scrape_filters=jsonb_set(scrape_filters,'{_capturedLeadIds}', $1::jsonb),scraped_count=14,updated_at=now() WHERE id=$2", [JSON.stringify(Array.from({ length: 14 }, (_, i) => i + 1)), auto]); };
    const result = await updateAutomationCapture(client, auto, current => {
      const ids = [...readCaptureIds(current.scrape_filters), 15];
      return { scrape_filters: { ...current.scrape_filters, _capturedLeadIds: ids }, scraped_count: ids.length };
    });
    expect(result?.scraped_count).toBe(15);
    expect(readCaptureIds(result?.scrape_filters)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it("cannot undo an acknowledged pause with an old completion callback", async () => {
    beforeWrite = async () => { await db.query("UPDATE automations SET status='paused',scrape_filters=jsonb_set(scrape_filters,'{_captureAttemptId}','null'),updated_at=now() WHERE id=$1", [auto]); };
    expect(await updateAutomationCapture(client, auto, current => current.status === "running" && current.scrape_filters._captureAttemptId === "a" ? { phase: "dispatching" } : null)).toBeNull();
    const { rows } = await db.query<AutomationCaptureRow>("SELECT * FROM automations WHERE id=$1", [auto]);
    expect(rows[0].status).toBe("paused");
    expect(rows[0].phase).toBe("scraping");
    expect(rows[0].scraped_count).toBe(13);
  });

  it("preserves a campaign claim when timestamps collide", async () => {
    const first = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const second = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    beforeWrite = async () => { await db.query("UPDATE automations SET campaign_id=$1 WHERE id=$2", [first, auto]); };
    expect(await updateAutomationCapture(client, auto, current => current.campaign_id ? null : { campaign_id: second })).toBeNull();
    expect((await db.query<{ campaign_id: string }>("SELECT campaign_id FROM automations WHERE id=$1", [auto])).rows[0].campaign_id).toBe(first);
  });

  it("does not expose or change the same automation through a different tenant", async () => {
    const mutate = vi.fn(() => ({ scraped_count: 0 }));
    expect(await updateAutomationCapture(other, auto, mutate)).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    expect((await db.query<{ scraped_count: number }>("SELECT scraped_count FROM automations WHERE id=$1", [auto])).rows[0].scraped_count).toBe(13);
  });
});
