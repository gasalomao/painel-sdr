#!/usr/bin/env node
/**
 * Confere se as migrations 004 e 005 foram aplicadas no Supabase.
 * Lê NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY do .env.local.
 *
 * Uso: node scripts/check-migrations.mjs
 *
 * Saída: lista o que está faltando. Não modifica nada.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const file = resolve(process.cwd(), ".env.local");
  const txt = readFileSync(file, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^"|"$/g, "");
  }
}

try { loadEnv(); } catch (e) {
  console.error("❌ Não consegui ler .env.local:", e.message);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("❌ Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY no .env.local");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

async function checkColumn(table, col) {
  const { error } = await sb.from(table).select(col).limit(1);
  return !error || !/column.*does not exist/i.test(error.message);
}

async function checkIndex(name) {
  const { data, error } = await sb.rpc("pg_get_indexes", {}).then(
    () => ({ data: null, error: { message: "rpc not exposed" } }),
    () => ({ data: null, error: { message: "rpc not exposed" } })
  );
  return { name, applied: null, note: "indexes só conferem rodando manualmente — consulte pg_indexes" };
}

const checks = [];

// Migration 004 — colunas em public.clients
for (const col of ["organizer_execution_hour", "organizer_last_run"]) {
  const ok = await checkColumn("clients", col);
  checks.push({ migration: "004", item: `clients.${col}`, ok });
}

// Migration 005 — indexes: não dá pra checar via REST sem RPC custom.
checks.push({
  migration: "005",
  item: "idx_chats_dashboard_client_created + outros",
  ok: null,
  note: "Rodar manualmente: SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_%';",
});

console.log("\n=== STATUS DAS MIGRATIONS ===\n");
for (const c of checks) {
  const sym = c.ok === true ? "✅" : c.ok === false ? "❌ FALTA" : "⚠️ verificar";
  console.log(`${sym}  [${c.migration}] ${c.item}${c.note ? "  — " + c.note : ""}`);
}

const missing = checks.filter(c => c.ok === false);
if (missing.length === 0) {
  console.log("\nTudo aparenta aplicado (exceto índices que precisam check manual).");
  process.exit(0);
}
console.log("\nFaltando aplicar:");
for (const m of missing) {
  console.log(`  - ${m.migration}_*.sql (item: ${m.item})`);
}
console.log("\nRode no SQL Editor do Supabase os arquivos em migrations/ que faltam.");
