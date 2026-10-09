import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_PREFIX, loadRunCheckpoint, saveRunCheckpoint } from "../run-checkpoint";
import { getStarterFiles } from "../starter";
import type { WebsiteRun } from "../types";

const run = { id: "00000000-0000-4000-8000-000000000001", client_id: "00000000-0000-4000-8000-000000000002", project_id: "00000000-0000-4000-8000-000000000003", base_revision_id: "00000000-0000-4000-8000-000000000004", kind: "agent" } as WebsiteRun;
const previousRun = { ...run, id: "00000000-0000-4000-8000-000000000005" };
const snapshot = (name: string) => ({ files: { ...getStarterFiles(), "src/recovered.ts": `export const name = '${name}';` }, request: name, assetIds: [], budgetConsumed: { requests: 2, tools: 3, outputTokens: 10, totalTokens: 100 } });

function database() {
  type Row = Record<string, unknown>;
  let rows: Row[] = [];
  let queryError: { message: string } | null = null;
  let chunkError = false;
  let serial = 0;
  const db = { from: () => {
    const filters: Array<(row: Row) => boolean> = [];
    const orders: Array<{ key: string; ascending: boolean }> = [];
    let maximum = Infinity;
    let single = false;
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
      like: (key: string, value: string) => { filters.push(row => String(row[key]).startsWith(value.slice(0, -1))); return query; },
      order: (key: string, options: { ascending: boolean }) => { orders.push({ key, ...options }); return query; },
      limit: (count: number) => { maximum = count; return query; },
      maybeSingle: () => { single = true; return query; },
      insert: async (value: Row | Row[]) => {
        rows = [...rows, ...(Array.isArray(value) ? value : [value]).map(row => ({ ...row, id: String(++serial).padStart(8, "0"), created_at: "2026-10-08T00:00:00Z" }))];
        return { data: null, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => {
        const selected = rows.filter(row => filters.every(filter => filter(row))).sort((a, b) => {
          for (const { key, ascending } of orders) {
            const compared = String(a[key]).localeCompare(String(b[key]));
            if (compared) return ascending ? compared : -compared;
          }
          return 0;
        }).slice(0, maximum);
        return Promise.resolve({ data: single ? selected[0] ?? null : selected, error: queryError ?? (chunkError && selected.some(row => !String(row.content).includes("commit:")) ? { message: "PRIVATE_CHUNK_FAILURE" } : null) }).then(resolve);
      },
    };
    return query;
  } } as unknown as SupabaseClient;
  const replacePayload = (patch: Record<string, unknown>) => {
    const chunk = rows.filter(row => /:0\]/.test(String(row.content))).at(-1)!;
    const content = String(chunk.content);
    const end = content.indexOf("]");
    rows = rows.map(row => row === chunk ? { ...row, content: content.slice(0, end + 1) + JSON.stringify({ ...JSON.parse(content.slice(end + 1)), ...patch }) } : row);
  };
  const corruptLatest = (kind: "marker" | "missing" | "payload" | "duplicate" | "index" | "foreign") => {
    const marker = rows.filter(row => String(row.content).startsWith(CHECKPOINT_PREFIX + "commit:")).at(-1)!;
    const commit = JSON.parse(String(marker.content).split("]")[1]) as { id: string; count: number };
    const chunk = rows.find(row => String(row.content).startsWith(CHECKPOINT_PREFIX + commit.id + ":0]"))!;
    if (kind === "marker") rows = rows.map(row => row === marker ? { ...row, content: CHECKPOINT_PREFIX + "commit:" + run.base_revision_id + "]{" } : row);
    if (kind === "missing") rows = rows.filter(row => row !== chunk);
    if (kind === "payload") rows = rows.map(row => row === chunk ? { ...row, content: String(row.content).replace('"requests":2', '"requests":-1') } : row);
    if (kind === "duplicate") rows = [...rows, { ...chunk, id: "duplicate" }];
    if (kind === "index") rows = rows.map(row => row === chunk ? { ...row, content: String(row.content).replace(":0]", ":00]") } : row);
    if (kind === "foreign") rows = rows.map(row => row === chunk ? { ...row, run_id: run.id } : row);
  };
  return { db, corruptLatest, replacePayload, reverseRows: () => { rows = [...rows].reverse(); }, failChunks: () => { chunkError = true; }, failReads: () => { queryError = { message: "PRIVATE_DATABASE_FAILURE" }; } };
}

describe("bounded checkpoint recovery", () => {
  it("selects newest commit with timestamp ties independently of insertion order", async () => {
    const store = database();
    await saveRunCheckpoint(store.db, previousRun, snapshot("older"));
    await saveRunCheckpoint(store.db, previousRun, snapshot("newer"));
    store.reverseRows();
    expect((await loadRunCheckpoint(store.db, run))?.request).toBe("newer");
  });

  it.each(["marker", "missing", "payload", "duplicate", "index", "foreign"] as const)("recovers prior complete files with explicit warning after %s corruption in another run", async (kind) => {
    const store = database();
    await saveRunCheckpoint(store.db, previousRun, snapshot("older"));
    await saveRunCheckpoint(store.db, previousRun, snapshot("newer"));
    store.corruptLatest(kind);
    const recovered = await loadRunCheckpoint(store.db, run);
    expect(recovered?.files).toEqual(snapshot("older").files);
    expect(recovered?.request).toBe("older");
    expect(recovered?.budgetConsumed).toBeUndefined();
    expect(recovered?.progress).toMatchObject({ stage: "blocked", diagnostics: expect.arrayContaining([expect.stringContaining("Checkpoint mais recente")]), nextAction: expect.stringContaining("snapshot anterior") });
  });

  it.each(["marker", "missing", "payload"] as const)("never rolls back current-run consumption after %s corruption", async (kind) => {
    const store = database();
    await saveRunCheckpoint(store.db, previousRun, snapshot("older"));
    await saveRunCheckpoint(store.db, run, snapshot("current"));
    store.corruptLatest(kind);
    await expect(loadRunCheckpoint(store.db, run)).rejects.toThrow();
  });

  it("never replaces current-run accounting with a newer checkpoint from another run", async () => {
    const store = database();
    await saveRunCheckpoint(store.db, run, snapshot("current"));
    await saveRunCheckpoint(store.db, previousRun, snapshot("other newer"));
    const recovered = await loadRunCheckpoint(store.db, run);
    expect(recovered?.request).toBe("current");
    expect(recovered?.budgetConsumed).toEqual(snapshot("current").budgetConsumed);
  });

  it("does not cross runs for browser reads, including recovery candidates", async () => {
    const store = database();
    await saveRunCheckpoint(store.db, previousRun, snapshot("older"));
    await saveRunCheckpoint(store.db, run, snapshot("current"));
    store.corruptLatest("missing");
    await expect(loadRunCheckpoint(store.db, run, true)).rejects.toThrow();
    expect(await loadRunCheckpoint(store.db, { ...run, id: run.project_id }, true)).toBeUndefined();
  });

  it("stops after five markers and throws instead of pretending no checkpoint exists", async () => {
    const store = database();
    await saveRunCheckpoint(store.db, previousRun, snapshot("too old"));
    for (let index = 0; index < 5; index++) {
      await saveRunCheckpoint(store.db, previousRun, snapshot(String(index)));
      store.corruptLatest("missing");
    }
    await expect(loadRunCheckpoint(store.db, run)).rejects.toThrow("Checkpoint");
  });

  it("recovers the fifth candidate but never crosses tenant, project or base revision", async () => {
    const store = database();
    await saveRunCheckpoint(store.db, previousRun, snapshot("fifth"));
    for (let index = 0; index < 4; index++) {
      await saveRunCheckpoint(store.db, previousRun, snapshot(String(index)));
      store.corruptLatest("missing");
    }
    expect((await loadRunCheckpoint(store.db, run))?.request).toBe("fifth");
    for (const field of ["client_id", "project_id", "base_revision_id"] as const) expect(await loadRunCheckpoint(store.db, { ...run, [field]: run.id })).toBeUndefined();
  });

  it.each([{ notes: {} }, { notes: null }, { designDirection: false }, { designDirection: 0 }, { designDirection: "" }, { designDirection: null }])("rejects invalid recovered metadata %#", async (patch) => {
    const store = database();
    await saveRunCheckpoint(store.db, run, snapshot("current"));
    store.replacePayload(patch);
    await expect(loadRunCheckpoint(store.db, run)).rejects.toThrow();
  });

  it("propagates chunk-query errors without trying an older candidate", async () => {
    const store = database();
    await saveRunCheckpoint(store.db, previousRun, snapshot("older"));
    await saveRunCheckpoint(store.db, previousRun, snapshot("newer"));
    store.failChunks();
    await expect(loadRunCheckpoint(store.db, run)).rejects.toThrow();
  });

  it("propagates database errors instead of recovering silently", async () => {
    const store = database();
    await saveRunCheckpoint(store.db, previousRun, snapshot("older"));
    store.failReads();
    await expect(loadRunCheckpoint(store.db, run)).rejects.toThrow();
  });
});
