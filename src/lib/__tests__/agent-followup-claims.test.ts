// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
const tenant = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", owner = "33333333-3333-4333-8333-333333333333", replacement = "44444444-4444-4444-8444-444444444444", attempt = "55555555-5555-4555-8555-555555555555";
let db: PGlite;
const config = { enabled: true, ...Object.fromEntries(["1h", "4h", "24h", "48h"].flatMap(step => [[`follow_up_${step}_enabled`, true], [`follow_up_${step}_delay_minutes`, 1], [`follow_up_${step}_template`, "fixture"]])) };
const migration = readFileSync("migrations/021_agent_followup_claims.sql", "utf8");
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE agent_settings(id integer PRIMARY KEY,client_id uuid,is_active boolean,options jsonb);
    CREATE TABLE channel_connections(client_id uuid,agent_id integer,instance_name text);
    CREATE TABLE chats_dashboard(id bigserial PRIMARY KEY,client_id uuid,remote_jid text,instance_name text,message_id text,content text,sender_type text,is_from_me boolean,message_type text,created_at timestamptz DEFAULT now(),UNIQUE(client_id,message_id));
    CREATE TABLE ai_control(remote_jid text PRIMARY KEY,is_paused boolean,paused_until timestamptz);
    CREATE TABLE contacts(id uuid PRIMARY KEY,client_id uuid,remote_jid text);
    CREATE TABLE sessions(id uuid PRIMARY KEY,client_id uuid,contact_id uuid,agent_id integer,instance_name text,bot_status text,resume_at timestamptz);
    CREATE TABLE app_settings(key text PRIMARY KEY,value text);
    INSERT INTO contacts VALUES('${replacement}','${tenant}','5511999990000@s.whatsapp.net');
    INSERT INTO sessions VALUES('${attempt}','${tenant}','${replacement}',1,'fixture','bot_active',null);
    INSERT INTO channel_connections VALUES ('${tenant}',1,'fixture');`);
  await db.query("INSERT INTO agent_settings VALUES(1,$1,true,$2)", [tenant, JSON.stringify({ follow_up: config })]);
  await db.exec(readFileSync("migrations/018_agent_followups_FINAL.sql", "utf8"));
  await db.exec(migration);
});
afterEach(async () => db.close());
const enqueue = () => db.query<{ result: { id: number } }>("SELECT enqueue_agent_followup($1,1,$2,'5511999990000@s.whatsapp.net','fixture',now()-interval '2 minutes') AS result", [tenant, attempt]);
const claim = (token = owner) => db.query<{ id: number }>("SELECT * FROM claim_agent_followup($1,120)", [token]);
const prepare = (id: number, token = owner, client = tenant, step = 1) => db.query<{ result: { action: string } }>("SELECT prepare_agent_followup($1,$2,1,$3,$4,$5,'fixture') AS result", [id, client, step, token, attempt]);
const finish = (id: number, token = owner, client = tenant, step = 1) => db.query<{ result: { current_step: number; status: string } }>("SELECT finish_agent_followup($1,$2,1,$3,$4,$5,'provider-fixture') AS result", [id, client, step, token, attempt]);
describe("persistent agent followup fencing", () => {
  it("deduplicates enqueue and gives only one claim to competing calls", async () => {
    const results = await Promise.all([enqueue(), enqueue()]);
    expect(results[0].rows[0].result.id).toBe(results[1].rows[0].result.id);
    const claims = await Promise.all([claim(), claim(replacement)]);
    expect(claims.flatMap(result => result.rows)).toHaveLength(1);
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
  });
  it("fences expired preparation and never reacquires a sending intention", async () => {
    await enqueue(); const id = (await claim()).rows[0].id;
    await db.exec("UPDATE agent_followups SET lease_expires_at=now()-interval '1 second'");
    expect((await claim(replacement)).rows).toHaveLength(1);
    await expect(prepare(id)).rejects.toThrow("claim_lost");
    expect((await prepare(id, replacement)).rows[0].result.action).toBe("send");
    await db.exec("UPDATE agent_followups SET lease_expires_at=now()-interval '1 second'");
    expect((await claim()).rows).toHaveLength(0);
    await expect(prepare(id, replacement)).rejects.toThrow("claim_lost");
  });
  it("finalizes an expired original intention once and rejects foreign tokens", async () => {
    await enqueue(); const id = (await claim()).rows[0].id; await prepare(id);
    await db.exec("UPDATE agent_followups SET lease_expires_at=now()-interval '1 second'");
    await expect(finish(id, replacement)).rejects.toThrow("claim_lost");
    await expect(finish(id, owner, other)).rejects.toThrow("claim_lost");
    expect((await finish(id)).rows[0].result).toMatchObject({ current_step: 2, status: "pending" });
    expect((await finish(id)).rows[0].result.current_step).toBe(2);
    expect((await db.query<{ total: number }>("SELECT count(*)::int AS total FROM chats_dashboard")).rows[0].total).toBe(1);
    expect((await db.query("SELECT content,sender_type,is_from_me,instance_name FROM chats_dashboard")).rows[0]).toEqual({ content: "fixture", sender_type: "ai", is_from_me: true, instance_name: "fixture" });
  });
  it("cancels when a contact replied and ignores another tenant reply", async () => {
    await enqueue(); const id = (await claim()).rows[0].id;
    await db.query("INSERT INTO chats_dashboard(client_id,remote_jid,instance_name,content,is_from_me) VALUES($1,'5511999990000@s.whatsapp.net','fixture','reply',false)", [tenant]);
    expect((await prepare(id)).rows[0].result.action).toBe("cancelled");
    await db.exec("DELETE FROM chats_dashboard");
    await enqueue(); const next = (await claim()).rows[0].id;
    await db.query("INSERT INTO chats_dashboard(client_id,remote_jid,instance_name,is_from_me) VALUES($1,'5511999990000@s.whatsapp.net','fixture',false)", [other]);
    expect((await prepare(next)).rows[0].result.action).toBe("send");
  });
  it("skips disabled steps and blocks ambiguous replay", async () => {
    await db.query("UPDATE agent_settings SET options=$1", [JSON.stringify({ follow_up: { ...config, follow_up_1h_enabled: false } })]);
    await enqueue(); const id = (await claim()).rows[0].id;
    expect((await prepare(id)).rows[0].result.action).toBe("skipped");
    await db.exec("UPDATE agent_followups SET next_send_at=now(),current_step=4");
    await claim(); await prepare(id, owner, tenant, 4);
    await db.query("SELECT release_agent_followup($1,$2,1,4,$3,'ambiguous','private-secret')", [id, tenant, owner]);
    expect((await claim(replacement)).rows).toHaveLength(0);
    await expect(db.query("SELECT release_agent_followup($1,$2,1,4,$3,'pending','')", [id, tenant, owner])).rejects.toThrow("replay_blocked");
    expect((await finish(id, owner, tenant, 4)).rows[0].result.status).toBe("completed");
  });
  it.each(["session-paused", "global-paused", "missing-session", "removed-channel"])("cancels preparation for %s", async reason => {
    await enqueue(); const id = (await claim()).rows[0].id;
    if (reason === "session-paused") await db.exec("UPDATE sessions SET bot_status='bot_paused'");
    if (reason === "global-paused") await db.exec("INSERT INTO app_settings VALUES('global_ai_paused_until:fixture','forever')");
    if (reason === "missing-session") await db.exec("DELETE FROM sessions");
    if (reason === "removed-channel") await db.exec("DELETE FROM channel_connections");
    expect((await prepare(id)).rows[0].result.action).toBe("cancelled");
  });
  it("keeps responses received before delayed finalization in the sequence cutoff", async () => {
    await enqueue(); const id = (await claim()).rows[0].id; await prepare(id);
    await db.query("INSERT INTO chats_dashboard(client_id,remote_jid,instance_name,is_from_me) VALUES($1,'5511999990000@s.whatsapp.net','fixture',false)", [tenant]);
    await finish(id);
    await db.exec("UPDATE agent_followups SET next_send_at=now()"); await claim();
    expect((await prepare(id, owner, tenant, 2)).rows[0].result.action).toBe("cancelled");
  });
  it("migration is repeatable and RPCs remain private", async () => {
    await enqueue(); await db.exec(migration);
    expect((await db.query("SELECT * FROM agent_followups")).rows).toHaveLength(1);
    const privilege = await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','claim_agent_followup(uuid,integer)','EXECUTE') AS allowed");
    expect(privilege.rows[0].allowed).toBe(false);
  });
});
