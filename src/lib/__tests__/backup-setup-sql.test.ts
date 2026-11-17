import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

describe("migrations de backup (019 + 020 + 022) idempotentes em Postgres real (PGlite)", () => {
  let db: PGlite;
  const m019 = readFileSync(resolve("migrations/019_backup_config.sql"), "utf8");
  const m020 = readFileSync(resolve("migrations/020_backup_security_runs.sql"), "utf8");
  const m022 = readFileSync(resolve("migrations/022_backup_diagnostics.sql"), "utf8");

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
    `);
    await db.exec(m019);
    await db.exec(m020);
    await db.exec(m022);
    // Executa uma segunda vez para garantir idempotência no setup-db
    await db.exec(m019);
    await db.exec(m020);
    await db.exec(m022);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("enfileira e reivindica backup_runs com claim_backup_run mantendo histórico e diagnósticos", async () => {
    const clientId = randomUUID();
    const workerId = randomUUID();
    await db.query(
      `INSERT INTO public.backup_config (client_id, enabled, interval_hours, retention_days)
       VALUES ($1, true, 12, 14)`,
      [clientId],
    );
    const { rows: runRows } = await db.query<{ id: string }>(
      `INSERT INTO public.backup_runs (client_id, backup_type, status, stage)
       VALUES ($1, 'manual', 'queued', 'queued') RETURNING id`,
      [clientId],
    );
    const { rows: claimed } = await db.query<{ id: string; status: string; worker_id: string }>(
      `SELECT * FROM public.claim_backup_run($1::uuid)`,
      [workerId],
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(runRows[0].id);
    expect(claimed[0].status).toBe("running");
    expect(claimed[0].worker_id).toBe(workerId);

    await db.query(
      `INSERT INTO public.backup_diagnostics (client_id, status, checks)
       VALUES ($1, 'success', '[{"name":"db","ok":true}]'::jsonb)`,
      [clientId],
    );
    const { rows: diags } = await db.query<{ status: string }>(
      `SELECT status FROM public.backup_diagnostics WHERE client_id = $1`,
      [clientId],
    );
    expect(diags[0].status).toBe("success");
  });
});

