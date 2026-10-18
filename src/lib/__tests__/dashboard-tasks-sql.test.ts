// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tenant = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
const migration = () => readFileSync("migrations/017_dashboard_tasks.sql", "utf8");
async function insert(text = "Retornar", leadId: number | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>("INSERT INTO dashboard_tasks(client_id,text,due_at,lead_id) VALUES ($1,$2,'2026-10-18T12:00:00Z',$3) RETURNING id", [tenant, text, leadId]);
  return rows[0].id;
}

describe("dashboard tasks SQL (PGlite local)", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE clients(id uuid PRIMARY KEY);
      CREATE TABLE leads_extraidos(id bigint PRIMARY KEY,client_id uuid REFERENCES clients(id),nome_negocio text);
      INSERT INTO clients VALUES ('${tenant}'),('${other}');
      INSERT INTO leads_extraidos VALUES (1,'${tenant}','Local'),(2,'${other}','Estrangeiro');`);
    await db.exec(migration());
  }, 60000);
  afterAll(async () => { await db?.close(); });

  it("is reentrant without changing legacy data or existing tasks", async () => {
    const id = await insert("Original", 1);
    await db.exec(migration());
    expect((await db.query("SELECT text,lead_id FROM dashboard_tasks WHERE id=$1", [id])).rows).toEqual([{ text: "Original", lead_id: 1 }]);
    expect((await db.query("SELECT id,nome_negocio FROM leads_extraidos ORDER BY id")).rows).toEqual([{ id: 1, nome_negocio: "Local" }, { id: 2, nome_negocio: "Estrangeiro" }]);
  });

  it("enforces required fields, text limits, timestamp types and valid tenant/lead references", async () => {
    for (const text of ["", " ", "\t\n", "x".repeat(1001)]) await expect(insert(text)).rejects.toThrow();
    await expect(insert("x".repeat(1000))).resolves.toMatch(/^[\da-f-]{36}$/);
    await expect(db.exec(`INSERT INTO dashboard_tasks(client_id,text,due_at) VALUES ('${tenant}',NULL,now())`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO dashboard_tasks(client_id,text) VALUES ('${tenant}','Sem data')`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO dashboard_tasks(client_id,text,due_at) VALUES ('${tenant}','Data impossível','2026-02-30')`)).rejects.toThrow();
    await expect(db.exec("INSERT INTO dashboard_tasks(client_id,text,due_at) VALUES ('99999999-9999-4999-8999-999999999999','Sem cliente',now())")).rejects.toThrow();
    await expect(insert("Estrangeiro", 2)).rejects.toThrow("dashboard_tasks_lead_tenant");
    await expect(insert("Ausente", 999)).rejects.toThrow();
    const id = await insert("Editável", 1);
    await expect(db.query("UPDATE dashboard_tasks SET lead_id=2 WHERE id=$1", [id])).rejects.toThrow("dashboard_tasks_lead_tenant");
    await expect(db.query("UPDATE dashboard_tasks SET client_id=$2 WHERE id=$1", [id, other])).rejects.toThrow("dashboard_tasks_lead_tenant");
  });

  it("rejects moving a linked lead to another tenant but allows unlinked transfers", async () => {
    await db.exec(`INSERT INTO leads_extraidos VALUES (10,'${tenant}','Vinculado'),(11,'${tenant}','Livre')`);
    const id = await insert("Preservar escopo", 10);
    await expect(db.query("UPDATE leads_extraidos SET client_id=$1 WHERE id=10", [other])).rejects.toThrow("dashboard_tasks_lead_tenant");
    expect((await db.query("SELECT client_id FROM leads_extraidos WHERE id=10")).rows).toEqual([{ client_id: tenant }]);
    await expect(db.query("UPDATE dashboard_tasks SET completed_at=now() WHERE id=$1", [id])).resolves.toBeDefined();
    await expect(db.query("UPDATE leads_extraidos SET client_id=$1 WHERE id=11", [other])).resolves.toBeDefined();
  });

  it("uses defaults, updates timestamp and makes completion idempotent atomically", async () => {
    const id = await insert("Concluir");
    const initial = (await db.query<{ created_at: Date; updated_at: Date; completed_at: Date | null }>("SELECT created_at,updated_at,completed_at FROM dashboard_tasks WHERE id=$1", [id])).rows[0];
    expect(initial.created_at).toBeInstanceOf(Date);
    expect(initial.completed_at).toBeNull();
    await db.query("UPDATE dashboard_tasks SET completed_at='2026-10-18T12:00:00Z',updated_at='2000-01-01' WHERE id=$1", [id]);
    await db.query("UPDATE dashboard_tasks SET completed_at='2026-10-19T12:00:00Z',text='Editada' WHERE id=$1", [id]);
    let current = (await db.query<{ completed_at: Date | null; updated_at: Date; text: string }>("SELECT completed_at,updated_at,text FROM dashboard_tasks WHERE id=$1", [id])).rows[0];
    expect(current.completed_at?.toISOString()).toBe("2026-10-18T12:00:00.000Z");
    expect(current.updated_at.getTime()).toBeGreaterThanOrEqual(initial.updated_at.getTime());
    expect(current.text).toBe("Editada");
    await db.query("UPDATE dashboard_tasks SET completed_at=NULL WHERE id=$1", [id]);
    current = (await db.query("SELECT completed_at,updated_at,text FROM dashboard_tasks WHERE id=$1", [id])).rows[0] as typeof current;
    expect(current.completed_at).toBeNull();
    await db.query("UPDATE dashboard_tasks SET completed_at='2026-10-20T12:00:00Z' WHERE id=$1", [id]);
    expect((await db.query<{ completed_at: Date }>("SELECT completed_at FROM dashboard_tasks WHERE id=$1", [id])).rows[0].completed_at.toISOString()).toBe("2026-10-20T12:00:00.000Z");
  });

  it("matches literal lead searches with PostgreSQL regex semantics", async () => {
    for (const value of ["100%_\\Local", "* [matriz].", "(Loja)+?", "Café"]) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const { rows } = await db.query<{ literal: boolean; unrelated: boolean }>("SELECT $1::text ~* $2 AS literal, 'Outra loja' ~* $2 AS unrelated", [value, escaped]);
      expect(rows[0]).toEqual({ literal: true, unrelated: false });
    }
  });

  it("has the two scoped partial ordering indexes", async () => {
    const { rows } = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename='dashboard_tasks'");
    expect(rows.some(({ indexdef }) => /\(client_id, due_at, id\).*WHERE \(completed_at IS NULL\)/.test(indexdef))).toBe(true);
    expect(rows.some(({ indexdef }) => /\(client_id, completed_at DESC, id\).*WHERE \(completed_at IS NOT NULL\)/.test(indexdef))).toBe(true);
  });

  it("denies direct anonymous/authenticated access and RLS fails closed even with accidental grants", async () => {
    expect((await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid='dashboard_tasks'::regclass")).rows[0].relrowsecurity).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await db.query<{ allowed: boolean }>("SELECT has_table_privilege($1,'dashboard_tasks',$2) AS allowed", [role, privilege])).rows[0].allowed).toBe(false);
      }
      await db.exec(`SET ROLE ${role}`);
      await expect(db.query("SELECT * FROM dashboard_tasks")).rejects.toThrow("permission denied");
      await db.exec("RESET ROLE");
      await db.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON dashboard_tasks TO ${role}; SET ROLE ${role}`);
      expect((await db.query("SELECT * FROM dashboard_tasks")).rows).toEqual([]);
      await expect(db.query("INSERT INTO dashboard_tasks(client_id,text,due_at) VALUES ($1,'Forbidden',now())", [tenant])).rejects.toThrow();
      await db.exec(`RESET ROLE; REVOKE ALL ON dashboard_tasks FROM ${role}`);
    }
    await db.exec("SET ROLE service_role");
    expect((await db.query("SELECT * FROM dashboard_tasks LIMIT 1")).rows).toHaveLength(1);
    await db.exec("RESET ROLE");
    expect((await db.query<{ policies: number }>("SELECT count(*)::int AS policies FROM pg_policies WHERE tablename='dashboard_tasks'")).rows[0].policies).toBe(0);
  });

  it("can be applied when optional Supabase roles do not exist", async () => {
    const local = new PGlite();
    try {
      await local.exec("CREATE TABLE clients(id uuid PRIMARY KEY); CREATE TABLE leads_extraidos(id bigint PRIMARY KEY,client_id uuid);");
      await expect(local.exec(migration())).resolves.toBeDefined();
      await expect(local.exec(migration())).resolves.toBeDefined();
    } finally { await local.close(); }
  });

  it("sets deleted lead links to null and cascades deleted tenants, without requiring global setup", async () => {
    await db.exec(`INSERT INTO leads_extraidos VALUES (3,'${tenant}','Apagar')`);
    const id = await insert("Manter tarefa", 3);
    await db.exec("DELETE FROM leads_extraidos WHERE id=3");
    expect((await db.query("SELECT lead_id FROM dashboard_tasks WHERE id=$1", [id])).rows).toEqual([{ lead_id: null }]);
    await db.exec(`INSERT INTO dashboard_tasks(client_id,text,due_at) VALUES ('${other}','Outro',now()); DELETE FROM leads_extraidos WHERE client_id='${other}'; DELETE FROM clients WHERE id='${other}';`);
    expect((await db.query("SELECT id FROM dashboard_tasks WHERE client_id=$1", [other])).rows).toEqual([]);
  });
});
