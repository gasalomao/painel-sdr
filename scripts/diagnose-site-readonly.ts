import { createRequire } from "node:module";
const require = createRequire(`${process.cwd()}/package.json`);
require("dotenv").config({ path: ".env.local", quiet: true });

function requiredUuid(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new Error("Informe --client e --project com UUIDs confirmados.");
  return value;
}

export function sanitizeSiteDiagnostic(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "";
  const codes = text.match(/\b(?:TS\d{3,5}|HTTP [1-5]\d{2}|website_[a-z_]{1,60}|ECONNRESET|ETIMEDOUT)\b/g) ?? [];
  const knownLocations = text.match(/\b(?:src\/(?:App|main)\.tsx|src\/(?:styles|tokens)\.css|index\.html)(?::\d{1,6}(?::\d{1,6})?|\(\d{1,6},\d{1,6}\))?/g) ?? [];
  return [...new Set([...codes, ...knownLocations])].slice(0, 10).join(" ") || "[detalhe omitido]";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const clientId = requiredUuid(args[args.indexOf("--client") + 1]);
  const projectId = requiredUuid(args[args.indexOf("--project") + 1]);
  if (!args.includes("--client") || !args.includes("--project")) throw new Error("IDs explícitos são obrigatórios. Nenhum projeto padrão será usado.");
  const { supabaseAdmin: db } = await import("../src/lib/supabase");
  if (!db) throw new Error("Cliente administrativo Supabase não configurado.");
  const signal = AbortSignal.timeout(30_000);
  const project = await db.from("website_projects").select("id,name,current_revision_id,status,updated_at")
    .eq("client_id", clientId).eq("id", projectId).is("deleted_at", null).abortSignal(signal).maybeSingle();
  if (project.error || !project.data) throw new Error("Não foi possível confirmar o projeto no tenant informado.");
  const [runs, builds, usage] = await Promise.all([
    db.from("website_runs").select("id,kind,status,model_id,model_used,base_revision_id,error,attempts,created_at,updated_at")
      .eq("client_id", clientId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(10).abortSignal(signal),
    db.from("website_builds").select("id,revision_id,status,success,errors,qa,duration_ms,created_at")
      .eq("client_id", clientId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(10).abortSignal(signal),
    db.from("website_usage").select("run_id,kind,model,provider,quantity,input_tokens,output_tokens,reserved_tokens,settled_at,metadata")
      .eq("client_id", clientId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(100).abortSignal(signal),
  ]);
  if (runs.error || builds.error || usage.error) throw new Error("Falha ao consultar registros de diagnóstico; nenhum dado foi alterado.");
  const output = {
    readOnly: true,
    project: { id: project.data.id, current_revision_id: project.data.current_revision_id, status: project.data.status, updated_at: project.data.updated_at },
    runs: (runs.data ?? []).map((run) => ({ ...run, error: sanitizeSiteDiagnostic(run.error) })),
    builds: (builds.data ?? []).map((build) => ({
      id: build.id, revision_id: build.revision_id, status: build.status, success: build.success,
      duration_ms: build.duration_ms, created_at: build.created_at,
      errors: (Array.isArray(build.errors) ? build.errors : []).slice(0, 5).map(sanitizeSiteDiagnostic),
      qa_passed: build.qa?.passed === true,
      qa_errors: (Array.isArray(build.qa?.errors) ? build.qa.errors : []).slice(0, 5).map(sanitizeSiteDiagnostic),
    })),
    usage: (usage.data ?? []).map((row) => ({
      run_id: row.run_id, kind: row.kind, model: row.model, provider: row.provider, quantity: row.quantity,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens, reserved_tokens: row.reserved_tokens,
      settled_at: row.settled_at, estimated: row.metadata?.usage?.estimated ?? null,
      cached_tokens: row.metadata?.usage?.cachedTokens ?? null, cost_usd: row.metadata?.usage?.costUsd ?? null,
    })),
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/diagnose-site-readonly.ts")) {
  main().catch(() => { process.stderr.write("Diagnóstico não concluído. Confira IDs/acesso/configuração; nenhum dado foi alterado.\n"); process.exitCode = 1; });
}
