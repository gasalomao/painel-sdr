// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
describe("agent followup SQL safety", () => {
  it.each(["018_agent_followups_FINAL.sql", "018_agent_followups_multi_tenant.sql"])("preserves rows on repeated migration and denies public access: %s", async name => {
    const db = new PGlite();
    try {
      await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      const sql = readFileSync(`migrations/${name}`, "utf8");
      await db.exec(sql);
      await db.exec("INSERT INTO agent_followups(client_id,agent_id,remote_jid,next_send_at) VALUES ('tenant-a',1,'fixture',now());");
      await db.exec(sql);
      expect((await db.query<{ total: number }>("SELECT count(*)::int AS total FROM agent_followups")).rows[0].total).toBe(1);
      expect((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('anon','agent_followups','SELECT') AS allowed")).rows[0].allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('authenticated','agent_followups','INSERT') AS allowed")).rows[0].allowed).toBe(false);
      const policies = await db.query<{ roles: string[] }>("SELECT roles FROM pg_policies WHERE tablename='agent_followups'");
      expect(policies.rows).toEqual([{ roles: ["service_role"] }]);
      expect(sql).not.toMatch(/DROP TABLE/i);
    } finally { await db.close(); }
  }, 20_000);
});
