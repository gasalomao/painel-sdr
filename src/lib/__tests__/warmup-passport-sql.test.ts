import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migration031Sql = readFileSync(
  resolve(process.cwd(), "migrations/031_warmup_passport_and_mentor.sql"),
  "utf8",
);

describe("migration 031_warmup_passport_and_mentor (PGlite)", () => {
  it("aplica em Postgres real de forma idempotente e garante constraints e RLS", async () => {
    const db = new PGlite();
    await db.exec(migration031Sql);
    await db.exec(migration031Sql);

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tableNames = tables.rows.map((r) => r.table_name);
    expect(tableNames).toContain("whatsapp_phone_passports");
    expect(tableNames).toContain("warmup_external_quarantine");
    expect(tableNames).toContain("scheduled_preview_deliveries");

    const clientId = "11111111-1111-4111-8111-111111111111";

    await db.query(
      `INSERT INTO public.whatsapp_phone_passports (
        client_id, canonical_phone, current_instance_name, career_mode, external_warmup_mode
      ) VALUES ($1, '5511999998888', 'chip_sarah_01', 'rehab', 'receive_only')`,
      [clientId],
    );

    await expect(
      db.query(
        `INSERT INTO public.whatsapp_phone_passports (
          client_id, canonical_phone, career_mode
        ) VALUES ($1, '5511999998888', 'invalid_mode')`,
        [clientId],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO public.whatsapp_phone_passports (
          client_id, canonical_phone
        ) VALUES ($1, '5511999998888')`,
        [clientId],
      ),
    ).rejects.toThrow();

    await db.query(
      `INSERT INTO public.warmup_external_quarantine (
        client_id, instance_name, canonical_sender_phone, remote_jid, source_tag, classification
      ) VALUES ($1, 'chip_sarah_01', '5521988887777', '5521988887777@s.whatsapp.net', 'mmzap', 'external_warmup_inbound')`,
      [clientId],
    );

    await db.query(
      `INSERT INTO public.scheduled_preview_deliveries (
        client_id, remote_jid, instance_name, company_name, preview_url, message_text, delivery_slot
      ) VALUES ($1, '5511977776666@s.whatsapp.net', 'chip_sarah_01', 'Clínica Luz', 'https://previa.test/luz', 'Oi! Segue o link da prévia', 'plus_3h')`,
      [clientId],
    );

    const rlsRes = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('whatsapp_phone_passports', 'warmup_external_quarantine', 'scheduled_preview_deliveries') ORDER BY relname`,
    );
    expect(rlsRes.rows).toHaveLength(3);
    expect(rlsRes.rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("aplica ALTER TABLE em tabelas existentes quando warmup_configs/campaigns/contacts existem", async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE public.whatsapp_warmup_configs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.whatsapp_warmup_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    await db.exec(migration031Sql);
    await db.exec(migration031Sql);

    const cols = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('career_mode', 'external_warmup_mode', 'origin', 'max_daily_previews', 'preview_accepted_at')`,
    );
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`).sort()).toEqual([
      "campaigns.max_daily_previews",
      "contacts.preview_accepted_at",
      "whatsapp_phone_passports.career_mode",
      "whatsapp_phone_passports.external_warmup_mode",
      "whatsapp_warmup_configs.career_mode",
      "whatsapp_warmup_configs.external_warmup_mode",
      "whatsapp_warmup_groups.origin",
    ]);
  });
});
