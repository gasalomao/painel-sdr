// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

describe("migration 023 — performance leads indexes & CRM backfill (PGlite)", () => {
  let db: PGlite;
  const migrationSql = () => readFileSync("migrations/023_performance_leads_indexes.sql", "utf8");

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE public.clients (
        id uuid PRIMARY KEY
      );
      CREATE TABLE public.leads_extraidos (
        id bigserial PRIMARY KEY,
        client_id uuid NOT NULL REFERENCES public.clients(id),
        "remoteJid" text,
        nome_negocio text,
        telefone text,
        ramo_negocio text,
        status text DEFAULT 'novo',
        primeiro_contato_source text,
        next_follow_up timestamptz,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.campaign_targets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id uuid NOT NULL REFERENCES public.clients(id),
        status text NOT NULL DEFAULT 'pending',
        remote_jid text NOT NULL
      );
      CREATE TABLE public.contacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id uuid NOT NULL REFERENCES public.clients(id),
        remote_jid text NOT NULL,
        lead_id bigint
      );
      CREATE TABLE public.sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id uuid NOT NULL REFERENCES public.clients(id),
        contact_id uuid REFERENCES public.contacts(id),
        last_message_at timestamptz
      );

      INSERT INTO public.clients (id) VALUES ('${TENANT_A}'), ('${TENANT_B}');
      INSERT INTO public.leads_extraidos (id, client_id, "remoteJid", nome_negocio, telefone, ramo_negocio)
      VALUES
        (10, '${TENANT_A}', '5511999990001@s.whatsapp.net', 'Padaria Alpha', '11999990001', 'Alimentação'),
        (20, '${TENANT_B}', '5511999990001@s.whatsapp.net', 'Padaria Outro Tenant', '11999990001', 'Alimentação');

      INSERT INTO public.contacts (client_id, remote_jid, lead_id)
      VALUES
        ('${TENANT_A}', '5511999990001@s.whatsapp.net', NULL),
        ('${TENANT_B}', '5511999990001@s.whatsapp.net', NULL);
    `);

    await db.exec(migrationSql());
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  it("cria todos os índices B-Tree compostos e parciais de forma idempotente", async () => {
    // Re-executar a migration não deve lançar erro
    await expect(db.exec(migrationSql())).resolves.toBeDefined();

    const { rows } = await db.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'idx_leads_extraidos_client_created_id',
          'idx_leads_extraidos_client_followup',
          'idx_leads_extraidos_client_ramo',
          'idx_leads_extraidos_client_contato_src',
          'idx_campaign_targets_client_status_jid',
          'idx_sessions_client_last_msg',
          'idx_sessions_client_contact',
          'idx_contacts_client_lead_id'
        )
      ORDER BY indexname
    `);

    expect(rows.map((r) => r.indexname)).toEqual([
      "idx_campaign_targets_client_status_jid",
      "idx_contacts_client_lead_id",
      "idx_leads_extraidos_client_contato_src",
      "idx_leads_extraidos_client_created_id",
      "idx_leads_extraidos_client_followup",
      "idx_leads_extraidos_client_ramo",
      "idx_sessions_client_contact",
      "idx_sessions_client_last_msg",
    ]);
  });

  it("preenche contacts.lead_id respeitando estritamente o isolamento por tenant", async () => {
    const { rows } = await db.query<{ client_id: string; lead_id: number }>(`
      SELECT client_id, lead_id
      FROM public.contacts
      ORDER BY client_id
    `);

    expect(rows).toEqual([
      { client_id: TENANT_A, lead_id: 10 },
      { client_id: TENANT_B, lead_id: 20 },
    ]);
  });
});

