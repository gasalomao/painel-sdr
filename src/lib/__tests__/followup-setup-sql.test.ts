import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

describe("migrations de follow-up (018 + 021 + 029) em Postgres real (PGlite)", () => {
  let db: PGlite;
  const canonical = readFileSync(resolve("migrations/SETUP_COMPLETO.sql"), "utf8");
  const m018 = readFileSync(resolve("migrations/018_agent_followups_FINAL.sql"), "utf8");
  const m021 = readFileSync(resolve("migrations/021_agent_followup_claims.sql"), "utf8");
  const m029 = readFileSync(resolve("migrations/029_followup_reschedule.sql"), "utf8");

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
    `);
    for (const table of [
      "clients",
      "agent_settings",
      "channel_connections",
      "contacts",
      "sessions",
      "chats_dashboard",
      "app_settings",
      "ai_control",
    ]) {
      let def = canonical.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\([\\s\\S]*?\\n\\);`))?.[0];
      if (!def) throw new Error(`Tabela canônica ausente: ${table}`);
      if (table === "chats_dashboard") {
        // Fixture PGlite (PostgreSQL 17 estrito): evita referência de outra coluna em DEFAULT
        def = def.replace(/is_from_me[^\n]+,/i, "is_from_me boolean DEFAULT false,");
      }
      await db.exec(def);
    }
    await db.exec(m018);
    await db.exec(m021);
    await db.exec(m029);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("permite enqueue -> claim -> reschedule_agent_followup para janela futura e bloqueia re-claim antes da hora", async () => {
    const clientId = randomUUID();
    await db.query("INSERT INTO clients(id, name, email) VALUES ($1, 'Teste Followup', $2)", [clientId, `${clientId}@t.local`]);
    await db.query(
      `INSERT INTO agent_settings(id, client_id, name, options, is_active)
       VALUES (1, $1, 'Agente 1', '{"follow_up":{"enabled":true,"follow_up_1h_delay_minutes":1}}'::jsonb, true)`,
      [clientId],
    );
    await db.query(
      `INSERT INTO channel_connections(client_id, agent_id, instance_name, provider) VALUES ($1, 1, 'inst-1', 'evolution')`,
      [clientId],
    );
    const { rows: contactRows } = await db.query<{ id: string }>(
      `INSERT INTO contacts(client_id, remote_jid, phone_number) VALUES ($1, '5511999990000@s.whatsapp.net', '5511999990000') RETURNING id`,
      [clientId],
    );
    const { rows: sessionRows } = await db.query<{ id: string }>(
      `INSERT INTO sessions(client_id, contact_id, instance_name, agent_id, bot_status) VALUES ($1, $2, 'inst-1', 1, 'bot_active') RETURNING id`,
      [clientId, contactRows[0].id],
    );

    const { rows: enq } = await db.query<{ enqueue_agent_followup: { id: number } }>(
      `SELECT public.enqueue_agent_followup($1::uuid, 1, $2::uuid, '5511999990000@s.whatsapp.net', 'inst-1', now() - interval '2 minutes', $3::uuid, NULL)`,
      [clientId, sessionRows[0].id, contactRows[0].id],
    );
    const rowId = enq[0].enqueue_agent_followup.id;

    const claimId = randomUUID();
    const { rows: claimed } = await db.query<{ id: number }>(
      `SELECT * FROM public.claim_agent_followup($1::uuid, 120)`,
      [claimId],
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(rowId);

    const futureIso = new Date(Date.now() + 3_600_000).toISOString();
    const { rows: resched } = await db.query<{ reschedule_agent_followup: { status: string; next_send_at: string; claim_id: string | null } }>(
      `SELECT public.reschedule_agent_followup($1::bigint, $2::uuid, 1, 1, $3::uuid, $4::timestamptz)`,
      [rowId, clientId, claimId, futureIso],
    );
    expect(resched[0].reschedule_agent_followup.status).toBe("pending");
    expect(resched[0].reschedule_agent_followup.claim_id).toBeNull();

    const { rows: claimedAgain } = await db.query(
      `SELECT * FROM public.claim_agent_followup($1::uuid, 120)`,
      [randomUUID()],
    );
    expect(claimedAgain).toHaveLength(0);
  });
});

