// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

describe("migration 024 — enterprise security hardening (PGlite)", () => {
  let db: PGlite;
  const migrationSql = () => readFileSync("migrations/024_enterprise_security_hardening.sql", "utf8");

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOINHERIT;
      CREATE ROLE authenticated NOINHERIT;
      CREATE ROLE service_role BYPASSRLS;

      CREATE TABLE public.clients (
        id uuid PRIMARY KEY,
        email text,
        password_hash text
      );
      CREATE TABLE public.auth_sessions (
        id uuid PRIMARY KEY,
        client_id uuid,
        token_hash text
      );
      CREATE TABLE public.ai_organizer_config (
        id integer PRIMARY KEY DEFAULT 1,
        api_key text,
        openrouter_api_key text,
        app_url text
      );
      CREATE TABLE public.ai_control (
        remote_jid text PRIMARY KEY,
        is_paused boolean DEFAULT false
      );
      CREATE TABLE public.webhook_logs (
        id bigserial PRIMARY KEY,
        client_id uuid NOT NULL,
        event text
      );
      CREATE TABLE public.leads_extraidos (
        id bigserial PRIMARY KEY,
        client_id uuid,
        nome_negocio text
      );

      INSERT INTO public.clients (id, email, password_hash)
      VALUES ('${TENANT_A}', 'admin@empresa.com', 'hash_secreto'),
             ('${TENANT_B}', 'outro@empresa.com', 'hash_secreto_2');

      INSERT INTO public.ai_organizer_config (id, api_key, openrouter_api_key, app_url)
      VALUES (1, 'AIzaSySecretKey', 'sk-or-secret', 'https://painel.host');

      INSERT INTO public.webhook_logs (client_id, event)
      VALUES ('${TENANT_A}', 'messages.upsert');

      INSERT INTO public.leads_extraidos (id, client_id, nome_negocio)
      VALUES (1, '${TENANT_A}', 'Cliente Seguro');
    `);

    await db.exec(migrationSql());
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  it("ativa RLS em 100% das tabelas do schema public e é idempotente", async () => {
    await expect(db.exec(migrationSql())).resolves.toBeDefined();

    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.relrowsecurity === true)).toBe(true);
  });

  it("bloqueia leitura e escrita de anon em tabelas de segredos (clients, auth_sessions, ai_organizer_config, ai_control)", async () => {
    await db.exec("SET ROLE anon;");
    try {
      await expect(db.query("SELECT * FROM public.clients")).rejects.toThrow();
      await expect(db.query("SELECT * FROM public.auth_sessions")).rejects.toThrow();
      await expect(db.query("SELECT * FROM public.ai_organizer_config")).rejects.toThrow();
      await expect(db.query("SELECT * FROM public.ai_control")).rejects.toThrow();
    } finally {
      await db.exec("RESET ROLE;");
    }
  });

  it("permite SELECT em webhook_logs para anon mas bloqueia DELETE/INSERT/UPDATE", async () => {
    await db.exec("SET ROLE anon;");
    try {
      const { rows } = await db.query("SELECT event FROM public.webhook_logs");
      expect(rows).toEqual([{ event: "messages.upsert" }]);
      await expect(db.query("DELETE FROM public.webhook_logs")).rejects.toThrow();
    } finally {
      await db.exec("RESET ROLE;");
    }
  });

  it("permite operações normais em leads_extraidos mas bloqueia transferência de client_id entre tenants e TRUNCATE", async () => {
    await db.exec("SET ROLE anon;");
    try {
      const { rows } = await db.query("SELECT nome_negocio FROM public.leads_extraidos WHERE id = 1");
      expect(rows).toEqual([{ nome_negocio: "Cliente Seguro" }]);

      // Tentativa de sequestrar lead para outro tenant deve falhar pelo trigger
      await expect(
        db.query(`UPDATE public.leads_extraidos SET client_id = '${TENANT_B}' WHERE id = 1`)
      ).rejects.toThrow(/transferência de client_id/);

      // Tentativa de inserir lead órfão sem client_id deve falhar pela policy RLS
      await expect(
        db.query("INSERT INTO public.leads_extraidos (id, client_id, nome_negocio) VALUES (99, NULL, 'Orfao')")
      ).rejects.toThrow();

      // Tentativa de TRUNCATE deve falhar
      await expect(db.query("TRUNCATE public.leads_extraidos")).rejects.toThrow();
    } finally {
      await db.exec("RESET ROLE;");
    }
  });
});

