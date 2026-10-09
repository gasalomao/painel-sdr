// Gera src/lib/setup-sql.ts a partir de migrations/SETUP_COMPLETO.sql.
// Rode: node scripts/build-setup-sql.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const sqlPath = join(root, "migrations", "SETUP_COMPLETO.sql");
const outPath = join(root, "src", "lib", "setup-sql.ts");

if (!existsSync(sqlPath)) {
  console.error("[build-setup-sql] migrations/SETUP_COMPLETO.sql não encontrado — geração abortada.");
  process.exit(1);
}

const APPENDED_MIGRATIONS = ["016_website_studio.sql", "017_website_studio_completion_guard.sql", "018_enable_impeccable_skill.sql"];

let sql = readFileSync(sqlPath, "utf8");
for (const migration of APPENDED_MIGRATIONS) {
  const migrationPath = join(root, "migrations", migration);
  if (!existsSync(migrationPath)) {
    console.error(`[build-setup-sql] migrations/${migration} não encontrado — geração abortada.`);
    process.exit(1);
  }
  const incremental = readFileSync(migrationPath, "utf8").trim();
  if (!sql.includes(incremental)) sql += `\n\n${incremental}\n`;
}

// Escapa pra caber num template string (backtick) do JS.
const escaped = sql
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const content = `// GERADO AUTOMATICAMENTE a partir de migrations/SETUP_COMPLETO.sql.
// Pra atualizar: edite migrations/SETUP_COMPLETO.sql e rode \`node scripts/build-setup-sql.mjs\`.
// Não edite este arquivo manualmente.

export const SETUP_SQL = \`${escaped}\`;
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, content, "utf8");
console.log(`[build-setup-sql] gerou ${outPath} (${content.length} bytes)`);
