import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migration026Sql = readFileSync(
  resolve(process.cwd(), "migrations/026_whatsapp_warmup.sql"),
  "utf8"
);
const migration031Sql = readFileSync(
  resolve(process.cwd(), "migrations/031_warmup_passport_and_mentor.sql"),
  "utf8"
);
const migration032Sql = readFileSync(
  resolve(process.cwd(), "migrations/032_mmzap_browser_governor.sql"),
  "utf8"
);

describe("migration 032_mmzap_browser_governor (PGlite)", () => {
  it("aplica em Postgres real de forma idempotente com defaults e constraint CHECK", async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS 'SELECT ''service_role''::text';
      CREATE TABLE IF NOT EXISTS public.clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    await db.exec(migration026Sql);
    await db.exec(migration031Sql);
    await db.exec(migration032Sql);
    await db.exec(migration032Sql);

    const clientId = "11111111-1111-4111-8111-111111111111";

    await db.query(
      `INSERT INTO public.whatsapp_warmup_configs (client_id, instance_name)
       VALUES ($1, 'chip_mmzap_01')`,
      [clientId]
    );

    const inserted = await db.query<{
      external_mmzap_sent_today: number;
      external_mmzap_sent_total: number;
      mmzap_browser_enabled: boolean;
      mmzap_browser_status: string;
      mmzap_minutes_today: number;
      mmzap_shifts_today: number;
    }>(
      `SELECT external_mmzap_sent_today, external_mmzap_sent_total, mmzap_browser_enabled,
              mmzap_browser_status, mmzap_minutes_today, mmzap_shifts_today
       FROM public.whatsapp_warmup_configs
       WHERE client_id = $1 AND instance_name = 'chip_mmzap_01'`,
      [clientId]
    );

    expect(inserted.rows[0]).toEqual({
      external_mmzap_sent_today: 0,
      external_mmzap_sent_total: 0,
      mmzap_browser_enabled: false,
      mmzap_browser_status: "unpaired",
      mmzap_minutes_today: 0,
      mmzap_shifts_today: 0,
    });

    await expect(
      db.query(
        `UPDATE public.whatsapp_warmup_configs
         SET mmzap_browser_status = 'invalid_state'
         WHERE client_id = $1 AND instance_name = 'chip_mmzap_01'`,
        [clientId]
      )
    ).rejects.toThrow();

    await db.query(
      `INSERT INTO public.whatsapp_phone_passports (
        client_id, canonical_phone, external_mmzap_sent_today, external_mmzap_sent_total
      ) VALUES ($1, '5511988887777', 3, 19)`,
      [clientId]
    );

    const passportRes = await db.query<{
      external_mmzap_sent_today: number;
      external_mmzap_sent_total: number;
    }>(
      `SELECT external_mmzap_sent_today, external_mmzap_sent_total
       FROM public.whatsapp_phone_passports
       WHERE client_id = $1 AND canonical_phone = '5511988887777'`,
      [clientId]
    );
    expect(passportRes.rows[0]).toEqual({
      external_mmzap_sent_today: 3,
      external_mmzap_sent_total: 19,
    });
  });
});
