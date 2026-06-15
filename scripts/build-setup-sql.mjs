// Gera src/lib/setup-sql.ts a partir de SETUP_COMPLETO.sql.
// Rode: node scripts/build-setup-sql.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const sqlPath = join(root, "SETUP_COMPLETO.sql");
const outPath = join(root, "src", "lib", "setup-sql.ts");

const sql = readFileSync(sqlPath, "utf8");

// Escapa pra caber num template string (backtick) do JS.
const escaped = sql
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const content = `// GERADO AUTOMATICAMENTE a partir de SETUP_COMPLETO.sql.
// Pra atualizar: edite SETUP_COMPLETO.sql e rode \`node scripts/build-setup-sql.mjs\`.
// Não edite este arquivo manualmente.

export const SETUP_SQL = \`${escaped}\`;
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, content, "utf8");
console.log(`[build-setup-sql] gerou ${outPath} (${content.length} bytes)`);
