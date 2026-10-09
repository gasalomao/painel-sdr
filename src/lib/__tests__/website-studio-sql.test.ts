import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { resolve } from "node:path";
import { getStarterFiles } from "../sites/starter";

type Row = Record<string, unknown>;
const migration = readFileSync(resolve("migrations/016_website_studio.sql"), "utf8");
const completionGuard = readFileSync(resolve("migrations/017_website_studio_completion_guard.sql"), "utf8");
const canonical = readFileSync(resolve("migrations/SETUP_COMPLETO.sql"), "utf8");
const files = getStarterFiles();
const build = {
  status: "ready", success: true, logs: "ok", duration_ms: 1, errors: [], warnings: [],
  artifact: { "/index.html": { mime: "text/html", content: "PGh0bWw+PC9odG1sPg==" } },
  screenshots: { desktop: "data:image/png;base64,iVBOR", mobile: "data:image/png;base64,iVBOR" },
  qa: { passed: true, errors: [], warnings: [], visual_review: "Aprovado" },
};
let db: PGlite;

async function rpc<T = Row>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const entries = Object.entries(args);
  const { rows } = await db.query<{ result: T }>(
    `SELECT public.${name}(${entries.map(([key], index) => `"${key}" => $${index + 1}`).join(", ")}) AS result`,
    entries.map(([, value]) => value !== null && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : value),
  );
  return rows[0].result;
}

async function fixture(): Promise<{ client: string; project: Row }> {
  const client = randomUUID();
  await db.query("INSERT INTO clients(id,name,email,features) VALUES ($1,'SQL Test',$2,'{\"sites\":true}')", [client, `${client}@example.test`]);
  const project = await rpc("website_create_project", { p_client_id: client, p_actor_id: client, p_project: { id: randomUUID(), name: "Site", slug: "site" }, p_files: files });
  return { client, project };
}

function scope(client: string, project: Row): Record<string, unknown> {
  return { p_client_id: client, p_project_id: project.id };
}

async function readyBuild(client: string, project: Row): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO website_builds
    (client_id,project_id,revision_id,status,success,artifact,screenshots,qa)
    VALUES ($1,$2,$3,'ready',true,$4,$5,$6) RETURNING id`,
  [client, project.id, project.current_revision_id, JSON.stringify(build.artifact), JSON.stringify(build.screenshots), JSON.stringify(build.qa)]);
  return rows[0].id;
}

describe("Website Studio SQL (PGLite)", () => {
  beforeAll(async () => {
    db = new PGlite();
    for (const table of ["clients", "leads_extraidos"]) {
      const definition = canonical.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\([\\s\\S]*?\\n\\);`))?.[0];
      if (!definition) throw new Error(`Tabela canônica ausente: ${table}`);
      await db.exec(definition);
    }
    await db.exec('CREATE UNIQUE INDEX ON leads_extraidos(client_id, "remoteJid");');
    await db.exec(`CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`);
    await db.exec(migration);
    await db.exec(completionGuard);
  }, 60_000);

  afterAll(async () => { await db?.close(); });

  it("expõe todas as RPCs e parâmetros usados pelo runtime", async () => {
    const { rows } = await db.query<{ proname: string; proargnames: string[] }>(`SELECT proname,proargnames FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'website_%'`);
    for (const directory of ["src/lib/sites", "src/app/api/sites"]) {
      const paths = readdirSync(directory, { recursive: true, encoding: "utf8" });
      for (const path of paths.filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))) {
        const source = readFileSync(resolve(directory, path), "utf8");
        for (const call of source.matchAll(/\.rpc\("(website_[a-z_]+)"(?:,\s*\{([\s\S]*?)\})?\)/g)) {
          const fn = rows.find((row) => row.proname === call[1]);
          expect(fn, `${path}: ${call[1]}`).toBeDefined();
          for (const parameter of (call[2] ?? "").matchAll(/\b(p_[a-z_]+|key|limit|window_seconds)\s*(?=:|,|$)/g)) {
            expect(fn?.proargnames, `${call[1]}: ${parameter[1]}`).toContain(parameter[1]);
          }
        }
      }
    }
  });

  it("reaplica a migration sem perder settings ou prompts", async () => {
    await db.exec("UPDATE website_settings SET value = value || '{\"max_sites\":12}' WHERE id = 1");
    await db.exec(migration);
    await db.exec(completionGuard);
    const { rows } = await db.query<{ value: { max_sites: number } }>("SELECT value FROM website_settings WHERE id = 1");
    expect(rows[0].value.max_sites).toBe(12);
    const { client } = await fixture();
    await db.query("INSERT INTO website_prompt_versions(prompt,version,created_by) VALUES ('Criativo',1,$1)", [client]);
    await expect(db.exec("UPDATE website_prompt_versions SET prompt = 'alterado'")).rejects.toThrow("website_immutable_snapshot");
  });

  it("admite exatamente o limite e reinicia a janela", async () => {
    const args = { key: "form:test", limit: 2, window_seconds: 600 };
    expect(await rpc("website_rate_limit", args)).toBe(true);
    expect(await rpc("website_rate_limit", args)).toBe(true);
    expect(await rpc("website_rate_limit", args)).toBe(false);
    expect(await rpc("website_rate_limit", args)).toBe(false);
    await db.exec("UPDATE website_rate_limits SET window_start = now() - interval '601 seconds'");
    expect(await rpc("website_rate_limit", args)).toBe(true);
    expect(await rpc("website_rate_limit", { ...args, limit: null })).toBe(false);
    expect(await rpc("website_rate_limit", { key: "form:omitted" })).toBe(false);
    expect(await rpc("website_rate_limit", { key: "form:one", limit: 1 })).toBe(true);
    expect(await rpc("website_rate_limit", { key: "form:one", limit: 1 })).toBe(false);
  });

  it("reivindica somente uma run e não reexecuta leases expiradas", async () => {
    const a = await fixture();
    const b = await fixture();
    const worker = randomUUID();
    const first = await rpc("website_queue_run", { ...scope(a.client, a.project), p_actor_id: a.client, p_prompt: "Primeira" });
    const second = await rpc("website_queue_run", { ...scope(b.client, b.project), p_actor_id: b.client, p_prompt: "Segunda" });
    const claimed = await rpc("website_claim_next_run", { p_worker_id: worker });
    expect(claimed.id).toBe(first.id);
    expect(claimed.attempts).toBe(1);
    await db.query("UPDATE website_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [first.id]);
    expect((await rpc("website_claim_next_run", { p_worker_id: worker })).id).toBe(second.id);
    const { rows } = await db.query<Row>("SELECT status,attempts FROM website_runs WHERE id = $1", [first.id]);
    expect(rows[0]).toEqual({ status: "failed", attempts: 1 });
    expect(await rpc("website_claim_next_run", { p_worker_id: worker })).toBeNull();
    expect(await rpc("website_worker_health")).toBe(true);
    await rpc("website_cancel_run", { ...scope(b.client, b.project), p_run_id: second.id });
  });

  it("ignora tenants desativados e rejeita vínculos entre tenants", async () => {
    const a = await fixture();
    const b = await fixture();
    await rpc("website_queue_run", { ...scope(a.client, a.project), p_actor_id: a.client, p_prompt: "Fila" });
    await db.query("UPDATE clients SET is_active = false WHERE id = $1", [a.client]);
    expect(await rpc("website_claim_next_run", { p_worker_id: randomUUID() })).toBeNull();
    await expect(rpc("website_save_revision", { ...scope(b.client, a.project), p_actor_id: b.client, p_files: files, p_message: "Inválida", p_expected_revision_id: a.project.current_revision_id })).rejects.toThrow("website_not_found");
    await expect(db.query("UPDATE website_projects SET current_revision_id = $1 WHERE id = $2", [b.project.current_revision_id, a.project.id])).rejects.toThrow(/foreign key/i);
  });

  it("completa agente e build atomicamente, com modelo usado e artefato realista", async () => {
    const { client, project } = await fixture();
    const args = scope(client, project);
    const run = await rpc("website_queue_run", { ...args, p_actor_id: client, p_prompt: "Editar" });
    const worker = randomUUID();
    await rpc("website_claim_run", { ...args, p_run_id: run.id, p_worker_id: worker });
    const completion = { ...args, p_run_id: run.id, p_worker_id: worker, p_expected_revision_id: project.current_revision_id, p_files: { ...files, "src/main.tsx": "export default 2;" }, p_summary: "Pronto", p_model_used: "provider/model" };
    await expect(rpc("website_complete_run", { ...completion, p_build: { ...build, artifact: [] } })).rejects.toThrow("website_invalid_input");
    const before = await db.query<Row>("SELECT current_revision_id FROM website_projects WHERE id = $1", [project.id]);
    expect(before.rows[0].current_revision_id).toBe(project.current_revision_id);
    const result = await rpc("website_complete_run", { ...completion, p_build: { ...build, artifact: { ...build.artifact, "/assets/main.js": { mime: "text/javascript", content: "A".repeat(9 * 1024 * 1024) } } } });
    expect(result).toMatchObject({ status: "completed", model_used: "provider/model", worker_id: null });
    const { rows } = await db.query<Row>("SELECT * FROM website_projects WHERE id = $1", [project.id]);
    expect(rows[0].current_revision_id).not.toBe(project.current_revision_id);
    await expect(rpc("website_complete_run", { ...completion, p_build: build })).rejects.toThrow("website_lease_lost");
    const buildRun = await rpc("website_queue_build", { ...args, p_actor_id: client, p_expected_revision_id: rows[0].current_revision_id });
    await rpc("website_claim_run", { ...args, p_run_id: buildRun.id, p_worker_id: worker });
    expect(await rpc("website_complete_run", { ...completion, p_run_id: buildRun.id, p_files: null, p_expected_revision_id: rows[0].current_revision_id, p_build: build })).toMatchObject({ status: "completed" });
  }, 30_000);

  describe("completion guard incremental", () => {
    async function claimed(kind: "agent" | "build" = "agent") {
      const { client, project } = await fixture(), worker = randomUUID();
      const args = scope(client, project);
      const run = kind === "agent"
        ? await rpc("website_queue_run", { ...args, p_actor_id: client, p_prompt: "Editar título" })
        : await rpc("website_queue_build", { ...args, p_actor_id: client, p_expected_revision_id: project.current_revision_id });
      await rpc("website_claim_run", { ...args, p_run_id: run.id, p_worker_id: worker });
      return { client, project, run, completion: { ...args, p_run_id: run.id, p_worker_id: worker, p_expected_revision_id: project.current_revision_id, p_files: kind === "agent" ? files : null, p_summary: "Rascunho não validado" } };
    }

    it.each([
      { ...build, status: "failed", success: false, errors: ["TS2322"], qa: { passed: false, errors: ["TS2322"], warnings: [] } },
      { ...build, success: false },
      { ...build, qa: { ...build.qa, passed: false } },
      { ...build, qa: { ...build.qa, errors: ["overflow"] } },
      { ...build, qa: { ...build.qa, passed: "true" } },
      { ...build, errors: ["build failed"] },
      { ...build, qa: {} },
      { ...build, screenshots: {} },
      { ...build, artifact: {} },
    ])("rejeita promoção antes de salvar revisão: %j", async (failedBuild) => {
      const { project, run, completion } = await claimed();
      await expect(rpc("website_complete_run", { ...completion, p_build: failedBuild })).rejects.toThrow("website_invalid_input");
      expect((await db.query<Row>("SELECT current_revision_id FROM website_projects WHERE id = $1", [project.id])).rows[0].current_revision_id).toBe(project.current_revision_id);
      expect((await db.query("SELECT id FROM website_revisions WHERE project_id = $1", [project.id])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM website_builds WHERE project_id = $1", [project.id])).rows).toHaveLength(0);
      expect((await db.query<Row>("SELECT status,worker_id FROM website_runs WHERE id = $1", [run.id])).rows[0]).toMatchObject({ worker_id: completion.p_worker_id });
    });

    it("aceita rascunho explicitamente unconfigured, não QA falso ready", async () => {
      const { project, completion } = await claimed();
      const draft = { ...build, status: "unconfigured", success: false, artifact: {}, screenshots: {}, errors: ["READY — AWAITING CREDENTIALS"], qa: { passed: false, errors: ["READY — AWAITING CREDENTIALS"], warnings: [] } };
      expect(await rpc("website_complete_run", { ...completion, p_build: draft })).toMatchObject({ status: "completed" });
      const rows = (await db.query<Row>("SELECT current_revision_id FROM website_projects WHERE id = $1", [project.id])).rows;
      expect(rows[0].current_revision_id).not.toBe(project.current_revision_id);
    });

    it("preserva relatório build-only reprovado sem promover revisão", async () => {
      const { project, completion } = await claimed("build");
      const report = { ...build, status: "failed", success: false, errors: ["infra"], qa: { passed: false, errors: ["infra"], warnings: [], failure_kind: "infrastructure", stage: "sandbox" } };
      expect(await rpc("website_complete_run", { ...completion, p_build: report })).toMatchObject({ status: "completed" });
      expect((await db.query<Row>("SELECT current_revision_id FROM website_projects WHERE id = $1", [project.id])).rows[0].current_revision_id).toBe(project.current_revision_id);
      expect((await db.query<Row>("SELECT status,qa,revision_id FROM website_builds WHERE project_id = $1", [project.id])).rows[0]).toMatchObject({ status: "failed", revision_id: project.current_revision_id, qa: report.qa });
    });

    it("mantém CAS e fencing depois da validação", async () => {
      const { completion } = await claimed();
      await expect(rpc("website_complete_run", { ...completion, p_worker_id: randomUUID(), p_build: build })).rejects.toThrow("website_lease_lost");
      await expect(rpc("website_complete_run", { ...completion, p_expected_revision_id: randomUUID(), p_build: build })).rejects.toThrow("website_lease_lost");
    });

    it("builder inclui 016 antes de 017 e replacement não é SECURITY DEFINER", async () => {
      const generator = readFileSync(resolve("scripts/build-setup-sql.mjs"), "utf8");
      expect(generator).toMatch(/"016_website_studio\.sql",\s*"017_website_studio_completion_guard\.sql"/);
      const { rows } = await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid = 'website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text)'::regprocedure");
      expect(rows[0]).toMatchObject({ prosecdef: false, proconfig: ["search_path=public, pg_temp"] });
    });
  });

  it("aplica quotas sem registrar consumo rejeitado", async () => {
    const { client } = await fixture();
    await db.exec("UPDATE website_settings SET value = value || '{\"max_images_per_day\":2}' WHERE id = 1");
    expect(await rpc("website_consume_quota", { p_client_id: client, p_metric: "images", p_amount: 2 })).toBe(2);
    await expect(rpc("website_consume_quota", { p_client_id: client, p_metric: "images", p_amount: 1 })).rejects.toThrow("website_quota_exceeded");
    const { rows } = await db.query<{ quantity: string }>("SELECT sum(quantity) AS quantity FROM website_usage WHERE client_id = $1 AND kind = 'images'", [client]);
    expect(Number(rows[0].quantity)).toBe(2);
  });

  it("liquida reservas órfãs ao cancelar, completar ou expirar runs sem devolver o estimado", async () => {
    const { client, project } = await fixture();
    const args = scope(client, project);
    const run = await rpc("website_queue_run", { ...args, p_actor_id: client, p_prompt: "Reservas" });
    const worker = randomUUID();
    await rpc("website_claim_run", { ...args, p_run_id: run.id, p_worker_id: worker });
    const res = { ...args, p_run_id: run.id, p_worker_id: worker };
    const billed = randomUUID(), held = randomUUID();
    await rpc("website_reserve_tokens", { ...res, p_reservation_id: billed, p_amount: 500 });
    await rpc("website_reserve_tokens", { ...res, p_reservation_id: held, p_amount: 300 });
    await rpc("website_settle_tokens", { ...res, p_reservation_id: billed, p_usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, p_model: "m", p_complete: true });
    await rpc("website_settle_tokens", { ...res, p_reservation_id: held, p_usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, p_model: "m", p_complete: false });
    await rpc("website_cancel_run", { ...args, p_run_id: run.id });
    const { rows } = await db.query<Row>("SELECT id, quantity, settled_at IS NOT NULL AS settled FROM website_usage WHERE client_id = $1 AND kind = 'tokens' ORDER BY quantity", [client]);
    expect(rows).toEqual([
      { id: billed, quantity: 150, settled: true },
      { id: held, quantity: 300, settled: true },
    ]);

    const expired = await rpc("website_queue_run", { ...args, p_actor_id: client, p_prompt: "Expira" });
    await rpc("website_claim_run", { ...args, p_run_id: expired.id, p_worker_id: worker });
    await rpc("website_reserve_tokens", { ...args, p_run_id: expired.id, p_worker_id: worker, p_reservation_id: randomUUID(), p_amount: 400 });
    await db.query("UPDATE website_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    await rpc("website_claim_next_run", { p_worker_id: randomUUID() });
    const after = await db.query<Row>("SELECT settled_at IS NOT NULL AS settled FROM website_usage WHERE client_id = $1 AND kind = 'tokens' AND run_id = $2", [client, expired.id]);
    expect(after.rows[0].settled).toBe(true);
  });

  it("bloqueia imagens concurrentes e por dia, liberando órfãs após quinze minutos", async () => {
    const { client, project } = await fixture();
    await db.exec("UPDATE website_settings SET value = value || '{\"max_images_per_day\":1,\"image_generation_enabled\":true}' WHERE id = 1");
    const args = scope(client, project);
    const first = randomUUID();
    expect(await rpc("website_reserve_images", { ...args, p_reservation_id: first, p_tokens: 100 })).toBe(first);
    await expect(rpc("website_reserve_images", { ...args, p_reservation_id: randomUUID(), p_tokens: 50 })).rejects.toThrow("website_quota_exceeded");
    await rpc("website_settle_images", { ...args, p_reservation_id: first, p_images: null, p_usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, p_model: "img", p_complete: true });
    const zeroed = await db.query<Row>("SELECT quantity, settled_at IS NOT NULL AS settled FROM website_usage WHERE client_id = $1 AND kind = 'images'", [client]);
    expect(zeroed.rows[0]).toEqual({ quantity: 0, settled: true });
    const second = randomUUID();
    expect(await rpc("website_reserve_images", { ...args, p_reservation_id: second, p_tokens: 100 })).toBe(second);
    await db.query("UPDATE website_usage SET created_at = now() - interval '16 minutes' WHERE id = $1", [second]);
    await rpc("website_claim_next_run", { p_worker_id: randomUUID() });
    const orphan = await db.query<Row>("SELECT quantity, settled_at IS NOT NULL AS settled FROM website_usage WHERE id = (SELECT (metadata->>'images_row')::uuid FROM website_usage WHERE id = $1)", [second]);
    expect(orphan.rows[0]).toEqual({ quantity: 1, settled: true });
    await expect(rpc("website_reserve_images", { ...args, p_reservation_id: randomUUID(), p_tokens: 10 })).rejects.toThrow("website_quota_exceeded");
  });

  it("rejeita builds do dia já esgotados ainda na fila e reembolsa deploys que falharam", async () => {
    const { client, project } = await fixture();
    const args = scope(client, project);
    await db.exec("UPDATE website_settings SET value = value || '{\"max_builds_per_day\":1}' WHERE id = 1");
    const worker = randomUUID();
    const queued = await rpc("website_queue_build", { ...args, p_actor_id: client, p_expected_revision_id: project.current_revision_id });
    await rpc("website_claim_run", { ...args, p_run_id: queued.id, p_worker_id: worker });
    await rpc("website_complete_run", { ...args, p_run_id: queued.id, p_worker_id: worker, p_expected_revision_id: project.current_revision_id, p_files: null, p_build: build, p_summary: "Build ok" });
    await rpc("website_consume_quota", { p_client_id: client, p_metric: "builds", p_amount: 1 });
    await expect(rpc("website_queue_build", { ...args, p_actor_id: client, p_expected_revision_id: project.current_revision_id })).rejects.toThrow("website_quota_exceeded");

    const buildId = await readyBuild(client, project);
    const begin = { ...args, p_build_id: buildId, p_rollback_id: null, p_expected_revision_id: project.current_revision_id, p_idempotency_key: randomUUID(), p_hostname: `${randomUUID()}.example.test` };
    const deployment = await rpc("website_begin_deployment", begin);
    const claimId = randomUUID();
    await rpc("website_claim_deployment", { ...args, p_deployment_id: deployment.id, p_claim_id: claimId });
    await rpc("website_finish_deployment", { ...args, p_deployment_id: deployment.id, p_claim_id: claimId, p_status: "failed", p_error: "provider offline" });
    const refunded = await db.query<{ total: number }>("SELECT coalesce(sum(quantity),0)::int AS total FROM website_usage WHERE client_id = $1 AND kind = 'deploys'", [client]);
    expect(refunded.rows[0].total).toBe(0);
  });

  it("reserva assets pendentes com quota e isolamento, liberando espaço após exclusão", async () => {
    const { client, project } = await fixture();
    const id = randomUUID();
    const asset = { id, client_id: client, project_id: project.id, name: "logo.png", path: `${client}/${project.id}/${id}.png`, mime: "image/png", size: 1024 * 1024, width: 100, height: 100, purpose: "logo", status: "pending" };
    await db.exec("UPDATE website_settings SET value = value || '{\"max_storage_mb\":1}' WHERE id = 1");
    const args = { ...scope(client, project), p_actor_id: client, p_asset: asset };
    expect(await rpc("website_reserve_asset", args)).toMatchObject({ id, status: "pending" });
    await expect(rpc("website_queue_run", { ...scope(client, project), p_actor_id: client, p_prompt: "Asset", p_asset_ids: [id] })).rejects.toThrow("website_not_found");
    const nextId = randomUUID();
    const next = { ...asset, id: nextId, path: `${client}/${project.id}/${nextId}.png` };
    await expect(rpc("website_reserve_asset", { ...args, p_asset: next })).rejects.toThrow("website_quota_exceeded");
    await db.query("DELETE FROM website_assets WHERE id = $1", [id]);
    expect(await rpc("website_reserve_asset", { ...args, p_asset: next })).toMatchObject({ id: nextId });
    await expect(rpc("website_reserve_asset", { ...args, p_asset: { ...next, client_id: randomUUID() } })).rejects.toThrow("website_invalid_input");
  });

  it("serializa publicação, checkpoints, retomada e rollback sem efeitos duplicados", async () => {
    const { client, project } = await fixture();
    const args = scope(client, project);
    const buildId = await readyBuild(client, project);
    const begin = { ...args, p_build_id: buildId, p_rollback_id: null, p_expected_revision_id: project.current_revision_id, p_idempotency_key: randomUUID(), p_hostname: `${project.id}.example.test` };
    const deployment = await rpc("website_begin_deployment", begin);
    expect(await rpc("website_begin_deployment", begin)).toMatchObject({ id: deployment.id });
    await expect(rpc("website_begin_deployment", { ...begin, p_hostname: "other.example.test" })).rejects.toThrow("website_idempotency_conflict");
    await expect(rpc("website_begin_deployment", { ...begin, p_idempotency_key: randomUUID() })).rejects.toThrow("website_active_deployment");
    await expect(rpc("website_queue_run", { ...args, p_actor_id: client, p_prompt: "Conflito" })).rejects.toThrow("website_active_deployment");
    const claim = { ...args, p_deployment_id: deployment.id, p_claim_id: randomUUID(), p_lease_seconds: 300 };
    expect(await rpc("website_claim_deployment", claim)).toMatchObject({ claim_id: claim.p_claim_id });
    expect(await rpc("website_claim_deployment", { ...claim, p_claim_id: randomUUID() })).toBeNull();
    const checkpoint = { ...args, p_deployment_id: deployment.id, p_claim_id: claim.p_claim_id, p_provider_id: randomUUID(), p_phase: "version_ready" };
    await expect(rpc("website_checkpoint_deployment", { ...checkpoint, p_claim_id: randomUUID() })).rejects.toThrow("website_lease_lost");
    await rpc("website_checkpoint_deployment", { ...checkpoint, p_provider_id: null, p_phase: "version_creating" });
    await rpc("website_checkpoint_deployment", checkpoint);
    await rpc("website_checkpoint_deployment", { ...checkpoint, p_phase: "activating" });
    await expect(rpc("website_checkpoint_deployment", checkpoint)).rejects.toThrow("website_invalid_input");
    const finish = { ...args, p_deployment_id: deployment.id, p_claim_id: claim.p_claim_id, p_status: "deploying", p_error: "Retomar" };
    await rpc("website_finish_deployment", finish);
    const newClaim = randomUUID();
    expect(await rpc("website_claim_deployment", { ...claim, p_claim_id: newClaim })).toMatchObject({ provider_id: checkpoint.p_provider_id, phase: "activating" });
    await expect(rpc("website_finish_deployment", { ...finish, p_status: "published" })).rejects.toThrow("website_lease_lost");
    expect(await rpc("website_finish_deployment", { ...finish, p_claim_id: newClaim, p_status: "published", p_error: null })).toMatchObject({ status: "published", url: `https://${begin.p_hostname}` });
    const { rows } = await db.query<Row>("SELECT published_deployment_id,status FROM website_projects WHERE id = $1", [project.id]);
    expect(rows[0]).toEqual({ published_deployment_id: deployment.id, status: "published" });
    expect(await rpc("website_begin_deployment", { ...begin, p_idempotency_key: randomUUID(), p_rollback_id: deployment.id })).toMatchObject({ phase: "version_ready", provider_id: checkpoint.p_provider_id, rollback_id: deployment.id });
    const usage = await db.query<{ quantity: string }>("SELECT sum(quantity) AS quantity FROM website_usage WHERE client_id = $1 AND kind = 'deploys'", [client]);
    expect(Number(usage.rows[0].quantity)).toBe(2);
  });

  it("rejeita QA inválido e conflitos de domínio sem consumir quota", async () => {
    const a = await fixture();
    const b = await fixture();
    const buildId = await readyBuild(a.client, a.project);
    const begin = { ...scope(a.client, a.project), p_build_id: buildId, p_rollback_id: null, p_expected_revision_id: a.project.current_revision_id, p_idempotency_key: randomUUID(), p_hostname: `${randomUUID()}.example.test` };
    await db.query("UPDATE website_builds SET qa = '{}' WHERE id = $1", [buildId]);
    await expect(rpc("website_begin_deployment", begin)).rejects.toThrow("website_invalid_input");
    await db.query("UPDATE website_builds SET qa = $1 WHERE id = $2", [JSON.stringify(build.qa), buildId]);
    await db.query("INSERT INTO website_domains(client_id,project_id,hostname) VALUES ($1,$2,$3)", [b.client, b.project.id, begin.p_hostname]);
    await expect(rpc("website_begin_deployment", begin)).rejects.toThrow("website_domain_conflict");
    expect((await db.query("SELECT id FROM website_usage WHERE client_id = $1 AND kind = 'deploys'", [a.client])).rows).toHaveLength(0);
    const deployment = await rpc("website_begin_deployment", { ...begin, p_hostname: `${randomUUID()}.example.test` });
    const claim = { ...scope(a.client, a.project), p_deployment_id: deployment.id, p_claim_id: randomUUID() };
    await rpc("website_claim_deployment", claim);
    await db.query("UPDATE website_deployments SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [deployment.id]);
    const replacement = randomUUID();
    expect(await rpc("website_claim_deployment", { ...claim, p_claim_id: replacement })).toMatchObject({ claim_id: replacement });
    await expect(rpc("website_checkpoint_deployment", { ...claim, p_provider_id: randomUUID(), p_phase: "version_ready" })).rejects.toThrow("website_lease_lost");
  });

  describe("descoberta de deployments recuperáveis", () => {
    type Candidate = { client_id: string; project_id: string; id: string };

    beforeEach(async () => {
      await db.exec("BEGIN; UPDATE website_deployments SET status = 'failed' WHERE status = 'deploying';");
    });
    afterEach(async () => { await db.exec("ROLLBACK"); });

    async function deployment(client: string, project: Row, id = randomUUID()): Promise<Candidate> {
      const buildId = await readyBuild(client, project);
      const { rows } = await db.query<Candidate>(`INSERT INTO website_deployments
        (id,client_id,project_id,build_id,expected_revision_id,hostname)
        VALUES ($1,$2,$3,$4,$5,'recovery.example.test') RETURNING client_id,project_id,id`,
      [id, client, project.id, buildId, project.current_revision_id]);
      return rows[0];
    }

    it.each([
      [false, null, true],
      [false, "2100-01-01", true],
      [false, "2000-01-01", true],
      [true, "2000-01-01", true],
      [true, "2100-01-01", false],
      [true, null, false],
    ])("filtra claim=%s e lease=%s: elegível=%s", async (claimed, lease, eligible) => {
      const { client, project } = await fixture();
      const candidate = await deployment(client, project);
      await db.query("UPDATE website_deployments SET claim_id = $1, lease_expires_at = $2 WHERE id = $3",
        [claimed ? randomUUID() : null, lease, candidate.id]);
      const { rows } = await db.query("SELECT * FROM website_list_recoverable_deployments()");
      expect(rows).toEqual(eligible ? [candidate] : []);
    });

    it.each([
      ["published", "cloudflare"],
      ["failed", "cloudflare"],
      ["deploying", "other"],
    ])("exclui status=%s e provider=%s", async (status, provider) => {
      const { client, project } = await fixture();
      const candidate = await deployment(client, project);
      await db.query("UPDATE website_deployments SET status = $1, provider = $2 WHERE id = $3", [status, provider, candidate.id]);
      expect((await db.query("SELECT * FROM website_list_recoverable_deployments()")).rows).toEqual([]);
    });

    it.each([
      [false, false, { sites: true }, false],
      [false, true, { sites: true }, false],
      [true, false, { sites: false }, false],
      [true, false, {}, false],
      [true, false, { sites: "true" }, false],
      [true, true, {}, true],
    ])("valida tenant ativo=%s admin=%s features=%j: elegível=%s", async (active, admin, features, eligible) => {
      const { client, project } = await fixture();
      const candidate = await deployment(client, project);
      await db.query("UPDATE clients SET is_active = $1, is_admin = $2, features = $3 WHERE id = $4",
        [active, admin, JSON.stringify(features), client]);
      expect((await db.query("SELECT * FROM website_list_recoverable_deployments()")).rows).toEqual(eligible ? [candidate] : []);
    });

    it.each([
      ["archived", null],
      ["draft", "2000-01-01"],
    ])("exclui projeto status=%s e deleted_at=%s", async (status, deletedAt) => {
      const { client, project } = await fixture();
      await db.query("UPDATE website_projects SET status = $1, deleted_at = $2 WHERE id = $3", [status, deletedAt, project.id]);
      await deployment(client, project);
      expect((await db.query("SELECT * FROM website_list_recoverable_deployments()")).rows).toEqual([]);
    });

    it("preserva o vínculo composto entre tenant e projeto", async () => {
      const a = await fixture();
      const b = await fixture();
      const candidate = await deployment(a.client, a.project);
      await db.exec("SAVEPOINT tenant_scope");
      await expect(db.query("UPDATE website_deployments SET client_id = $1 WHERE id = $2", [b.client, candidate.id])).rejects.toThrow(/foreign key/i);
      await db.exec("ROLLBACK TO SAVEPOINT tenant_scope");
      expect((await db.query("SELECT * FROM website_list_recoverable_deployments()")).rows).toEqual([candidate]);
    });

    it("pagina por id em lotes de cinco sem claims, mutações ou consumo de quota", async () => {
      const candidates: Candidate[] = [];
      for (const index of [7, 2, 5, 1, 6, 3, 4]) {
        const { client, project } = await fixture();
        candidates.push(await deployment(client, project, `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`));
      }
      candidates.sort((a, b) => a.id.localeCompare(b.id));
      await db.query("UPDATE website_deployments SET claim_id = $1, lease_expires_at = clock_timestamp() WHERE id = $2",
        [randomUUID(), candidates[1].id]);
      await rpc("website_consume_quota", { p_client_id: candidates[0].client_id, p_metric: "deploys", p_amount: 1 });
      await db.exec("UPDATE website_settings SET value = value || '{\"max_deploys_per_day\":0}' WHERE id = 1");
      const tables = ["website_deployments", "website_projects", "website_usage", "website_domains", "website_workers"];
      const before = await Promise.all(tables.map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`)));
      const first = await db.query<Candidate>("SELECT * FROM website_list_recoverable_deployments()");
      expect(first.rows).toEqual(candidates.slice(0, 5));
      const next = await db.query<Candidate>("SELECT * FROM website_list_recoverable_deployments(p_after_id => $1)", [first.rows[4].id]);
      expect(next.rows).toEqual(candidates.slice(5));
      expect((await db.query("SELECT * FROM website_list_recoverable_deployments($1)", [next.rows[1].id])).rows).toEqual([]);
      expect((await db.query("SELECT * FROM website_list_recoverable_deployments(NULL)")).rows).toEqual(first.rows);
      for (const [index, table] of tables.entries()) {
        expect((await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows, table).toEqual(before[index].rows);
      }
    });
  });

  it("persiste formulário e lead atomicamente, com deduplicação antes dos efeitos", async () => {
    const { client, project } = await fixture();
    await db.query("UPDATE website_projects SET status = 'published' WHERE id = $1", [project.id]);
    const args = { ...scope(client, project), p_idempotency_key: randomUUID(), p_payload: { name: "Contato", phone: "+55 (11) 99999-1111", email: "a@example.test", message: "Olá", consent: true } };
    const submission = await rpc("website_submit_form", args);
    expect(await rpc("website_submit_form", args)).toEqual(submission);
    const lead = await db.query<Row>("SELECT * FROM leads_extraidos WHERE id = $1", [submission.lead_id]);
    expect(lead.rows[0]).toMatchObject({ client_id: client, website_project_id: project.id, primeiro_contato_source: "website", remoteJid: "5511999991111@s.whatsapp.net" });
    await expect(rpc("website_submit_form", { ...args, p_payload: { ...args.p_payload, phone: "5511999992222" } })).rejects.toThrow("website_idempotency_conflict");
    expect((await db.query("SELECT id FROM leads_extraidos WHERE client_id = $1", [client])).rows).toHaveLength(1);
    await db.exec("CREATE FUNCTION reject_website_lead() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lead_write_failed'; END $$; CREATE TRIGGER reject_website_lead BEFORE INSERT ON leads_extraidos FOR EACH ROW EXECUTE FUNCTION reject_website_lead();");
    try {
      await expect(rpc("website_submit_form", { ...args, p_idempotency_key: randomUUID(), p_payload: { ...args.p_payload, phone: "5511999993333" } })).rejects.toThrow("lead_write_failed");
      expect((await db.query("SELECT id FROM website_form_submissions WHERE client_id = $1", [client])).rows).toHaveLength(1);
    } finally {
      await db.exec("DROP TRIGGER reject_website_lead ON leads_extraidos; DROP FUNCTION reject_website_lead();");
    }
  });

  it("nega anon/authenticated e concede somente service_role", async () => {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT SELECT ON clients TO service_role;");
    await db.exec(migration);
    await db.exec(completionGuard);
    const { rows } = await db.query<{ allowed: boolean; rls: boolean }>(`SELECT
      has_table_privilege('anon','website_projects','SELECT') OR
      has_table_privilege('authenticated','website_settings','UPDATE') OR
      has_function_privilege('anon','website_claim_next_run(uuid,integer)','EXECUTE') AS allowed,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'website_projects'::regclass) AS rls`);
    expect(rows[0]).toEqual({ allowed: false, rls: true });
    await db.exec(`GRANT USAGE ON SCHEMA storage TO anon;
      GRANT SELECT ON storage.objects TO anon;
      CREATE POLICY other_bucket_policy ON storage.objects FOR SELECT TO anon USING (true);
      INSERT INTO storage.objects(bucket_id) VALUES ('website-assets'), ('other');
      SET ROLE anon;`);
    try {
      expect((await db.query<{ bucket_id: string }>("SELECT bucket_id FROM storage.objects")).rows).toEqual([{ bucket_id: "other" }]);
      await expect(rpc("website_worker_health")).rejects.toThrow(/permission denied/i);
    } finally { await db.exec("RESET ROLE"); }
    const privileges = await db.query(`SELECT
      has_function_privilege('anon','website_list_recoverable_deployments(uuid)','EXECUTE') AS anon,
      has_function_privilege('authenticated','website_list_recoverable_deployments(uuid)','EXECUTE') AS authenticated,
      has_function_privilege('service_role','website_list_recoverable_deployments(uuid)','EXECUTE') AS service_role,
      prosecdef FROM pg_proc WHERE oid = 'website_list_recoverable_deployments(uuid)'::regprocedure`);
    expect(privileges.rows).toEqual([{ anon: false, authenticated: false, service_role: true, prosecdef: false }]);
    const completePrivileges = await db.query(`SELECT
      has_function_privilege('anon','website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text)','EXECUTE') AS anon,
      has_function_privilege('authenticated','website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text)','EXECUTE') AS authenticated,
      has_function_privilege('service_role','website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text)','EXECUTE') AS service_role`);
    expect(completePrivileges.rows).toEqual([{ anon: false, authenticated: false, service_role: true }]);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try { await expect(db.query("SELECT * FROM website_list_recoverable_deployments()")).rejects.toThrow(/permission denied/i); }
      finally { await db.exec("RESET ROLE"); }
    }
    const recoverable = await db.query("SELECT * FROM website_list_recoverable_deployments()");
    await db.exec("SET ROLE service_role");
    try {
      expect(await rpc("website_worker_health")).toBe(true);
      expect((await db.query("SELECT * FROM website_list_recoverable_deployments()")).rows).toEqual(recoverable.rows);
    } finally { await db.exec("RESET ROLE"); }
  });
});
