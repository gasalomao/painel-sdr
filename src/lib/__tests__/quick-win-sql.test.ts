// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
const tenant = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const sql = readFileSync("migrations/quick_win_sarah_v2.sql", "utf8");
async function fixture() {
 const db = new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE agent_settings(id integer PRIMARY KEY,client_id uuid,name text,main_prompt text,updated_at timestamptz);
 INSERT INTO agent_settings VALUES(1,'${tenant}','Sarah','old-a',now()),(2,'${other}','Sarah','old-b',now());`);
 return db;
}
describe("explicit quick win target", () => {
 it("rejects missing target before touching any prompt", async () => {
  const db = await fixture(); try {
   await expect(db.exec(sql)).rejects.toThrow("target_required"); await db.exec("ROLLBACK");
   expect((await db.query("SELECT main_prompt FROM agent_settings ORDER BY id")).rows).toEqual([{ main_prompt: "old-a" }, { main_prompt: "old-b" }]);
  } finally { await db.close(); }
 });
 it("updates exactly the requested tenant/agent and protects the backup", async () => {
  const db = await fixture(); try {
   await db.exec(`SET app.quick_win_client_id='${tenant}'; SET app.quick_win_agent_id='1';`);
   await db.exec(sql);
   expect((await db.query<{ main_prompt: string }>("SELECT main_prompt FROM agent_settings WHERE id=1")).rows[0].main_prompt).toContain("Você é a Sarah");
   expect((await db.query("SELECT main_prompt FROM agent_settings WHERE id=2")).rows[0]).toEqual({ main_prompt: "old-b" });
   expect((await db.query("SELECT client_id,agent_id,main_prompt_backup FROM agent_settings_backup")).rows).toEqual([{ client_id: tenant, agent_id: 1, main_prompt_backup: "old-a" }]);
   expect((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('anon','agent_settings_backup','SELECT') AS allowed")).rows[0].allowed).toBe(false);
  } finally { await db.close(); }
 });
 it("rejects a tenant that does not own the chosen agent", async () => {
  const db = await fixture(); try {
   await db.exec(`SET app.quick_win_client_id='${other}'; SET app.quick_win_agent_id='1';`);
   await expect(db.exec(sql)).rejects.toThrow("target_required"); await db.exec("ROLLBACK");
   expect((await db.query("SELECT main_prompt FROM agent_settings WHERE id=1")).rows[0]).toEqual({ main_prompt: "old-a" });
  } finally { await db.close(); }
 });
});
