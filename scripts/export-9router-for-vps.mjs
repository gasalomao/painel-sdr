#!/usr/bin/env node
/**
 * Exporta as configurações do 9Router local para um pacote pronto para deploy
 * no EasyPanel (VPS).
 *
 * O que é exportado:
 *   - db/data.sqlite   → provedores, conexões, combos e API keys
 *   - jwt-secret       → segredo das sessões do dashboard
 *   - machine-id       → salt usado para criptografar credenciais OAuth
 *   - auth/cli-secret  → segredo interno do CLI
 *
 * Telemetria (usageHistory / usageDaily / requestDetails) é descartada para
 * reduzir o tamanho do pacote — não afeta a configuração.
 *
 * Uso:
 *   node scripts/export-9router-for-vps.mjs
 *   node scripts/export-9router-for-vps.mjs --out "D:\backup\9router"
 *   npm run 9router:export -- --skip-zip
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ============================================================================
// Argumentos
// ============================================================================
const argv = process.argv.slice(2);

function readArg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const wantZip = !argv.includes("--skip-zip") && !argv.includes("--no-zip");
const outDir =
  readArg("--out") ??
  path.join(
    process.platform === "win32" ? process.env.USERPROFILE || os.homedir() : os.homedir(),
    "Desktop",
    "9router-vps-export"
  );

// ============================================================================
// Localiza a instalação local do 9Router
// ============================================================================
function resolveNineRouterHome() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

const routerHome = resolveNineRouterHome();
const sourceDb = path.join(routerHome, "db", "data.sqlite");

const banner = (text) => {
  console.log("");
  console.log("=".repeat(70));
  console.log(text);
  console.log("=".repeat(70));
};

banner("📦 9Router → Pacote de deploy para VPS (EasyPanel)");

if (!fs.existsSync(sourceDb)) {
  console.error(`\n❌ Banco não encontrado em: ${sourceDb}`);
  console.error("   Defina DATA_DIR caso o 9Router use outro diretório.\n");
  process.exit(1);
}

console.log(`\nOrigem : ${routerHome}`);
console.log(`Destino: ${outDir}`);

// ============================================================================
// better-sqlite3 vem do runtime do próprio 9Router
// ============================================================================
function loadBetterSqlite() {
  const candidates = [
    path.join(routerHome, "runtime", "node_modules", "better-sqlite3"),
    "better-sqlite3",
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // tenta o próximo
    }
  }
  return null;
}

const Database = loadBetterSqlite();

// ============================================================================
// Monta a estrutura de saída
// ============================================================================
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "data", "db"), { recursive: true });
fs.mkdirSync(path.join(outDir, "data", "auth"), { recursive: true });

const targetDb = path.join(outDir, "data", "db", "data.sqlite");

// ============================================================================
// Copia o banco (VACUUM INTO = cópia consistente mesmo com o 9Router aberto)
// ============================================================================
console.log("\n⏳ Copiando data.sqlite...");
const sourceSize = fs.statSync(sourceDb).size;

if (Database) {
  const staging = path.join(os.tmpdir(), `9router-export-${Date.now()}.sqlite`);
  try {
    const db = new Database(sourceDb);
    db.exec(`VACUUM INTO '${staging.replace(/'/g, "''")}'`);
    db.close();

    const clean = new Database(staging);
    for (const table of ["usageHistory", "usageDaily", "requestDetails"]) {
      try {
        clean.prepare(`DELETE FROM "${table}"`).run();
      } catch {
        // tabela pode não existir em versões antigas
      }
    }
    clean.pragma("journal_mode = WAL");
    clean.exec("VACUUM");
    clean.pragma("wal_checkpoint(TRUNCATE)");
    clean.pragma("journal_mode = DELETE");
    clean.close();

    fs.copyFileSync(staging, targetDb);
  } finally {
    fs.rmSync(staging, { force: true });
  }
} else {
  console.warn("⚠️  better-sqlite3 não encontrado — cópia simples do arquivo.");
  console.warn("   Feche o 9Router antes de rodar de novo para garantir consistência.");
  fs.copyFileSync(sourceDb, targetDb);
}

// ============================================================================
// Copia os segredos
// ============================================================================
console.log("🔑 Copiando segredos (jwt-secret, machine-id, cli-secret)...");

const secrets = [
  ["jwt-secret", path.join(routerHome, "jwt-secret"), path.join(outDir, "data", "jwt-secret")],
  ["machine-id", path.join(routerHome, "machine-id"), path.join(outDir, "data", "machine-id")],
  [
    "auth/cli-secret",
    path.join(routerHome, "auth", "cli-secret"),
    path.join(outDir, "data", "auth", "cli-secret"),
  ],
];

const missingSecrets = [];
for (const [label, from, to] of secrets) {
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
    console.log(`   ✓ ${label}`);
  } else {
    missingSecrets.push(label);
    console.log(`   – ${label} (não existe no host, será gerado no primeiro boot)`);
  }
}

// ============================================================================
// Resumo do conteúdo exportado (prova de que o clone veio completo)
// ============================================================================
let summary = null;
if (Database) {
  const db = new Database(targetDb, { readonly: true });
  try {
    const count = (table) => {
      try {
        return db.prepare(`SELECT count(*) AS c FROM "${table}"`).get().c;
      } catch {
        return null;
      }
    };

    summary = {
      providers: count("providerConnections"),
      combos: count("combos"),
      apiKeys: count("apiKeys"),
      settings: count("settings"),
      providerList: db
        .prepare("SELECT provider, name FROM providerConnections ORDER BY provider")
        .all(),
      comboList: db.prepare("SELECT name, models FROM combos ORDER BY name").all(),
      keyList: db.prepare("SELECT name, key FROM apiKeys ORDER BY name").all(),
    };
  } finally {
    db.close();
  }
}

// ============================================================================
// Arquivo de ambiente do serviço 9Router
// ============================================================================
fs.writeFileSync(
  path.join(outDir, "9router.env"),
  [
    "# Cole estas variáveis no serviço 9router do EasyPanel (aba Environment)",
    "DATA_DIR=/app/data",
    "PORT=20128",
    "HOSTNAME=0.0.0.0",
    "NODE_ENV=production",
    "",
  ].join("\n"),
  "utf-8"
);

// ============================================================================
// Config do OpenCode já apontando para o 9Router da VPS
// ============================================================================
const repoConfigPath = path.join(process.cwd(), ".opencode", "opencode.json");
const vpsConfig = fs.existsSync(repoConfigPath)
  ? JSON.parse(fs.readFileSync(repoConfigPath, "utf-8"))
  : { provider: {} };

if (vpsConfig.provider?.["9router"]?.options) {
  vpsConfig.provider["9router"].options.baseURL = "{env:ROUTER_BASE_URL}";
  vpsConfig.provider["9router"].options.apiKey = "{env:ROUTER_API_KEY}";
}

fs.mkdirSync(path.join(outDir, "opencode"), { recursive: true });
fs.writeFileSync(
  path.join(outDir, "opencode", "opencode.json"),
  JSON.stringify(vpsConfig, null, 2),
  "utf-8"
);

// ============================================================================
// LEIA-ME com o resumo
// ============================================================================
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(targetDb)).digest("hex");
const finalSize = fs.statSync(targetDb).size;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const lines = [
  "9Router — pacote de deploy para EasyPanel",
  `Gerado em: ${new Date().toLocaleString("pt-BR")}`,
  `Origem: ${routerHome}`,
  "",
  "CONTEÚDO",
  "  data/db/data.sqlite  → provedores, conexões, combos e API keys",
  "  data/jwt-secret      → segredo das sessões do dashboard",
  "  data/machine-id      → salt de criptografia das credenciais OAuth",
  "  data/auth/cli-secret → segredo interno do CLI",
  "  9router.env          → variáveis do serviço 9router no EasyPanel",
  "  opencode/opencode.json → config do OpenCode apontando para o 9Router da VPS",
  "",
  `Banco: ${mb(sourceSize)} → ${mb(finalSize)} (telemetria removida)`,
  `SHA-256: ${sha256}`,
  "",
];

if (summary) {
  lines.push("RESUMO DO CLONE");
  lines.push(`  Provedores conectados: ${summary.providers}`);
  lines.push(`  Combos: ${summary.combos}`);
  lines.push(`  API keys: ${summary.apiKeys}`);
  lines.push("");
  lines.push("  Combos:");
  for (const combo of summary.comboList) {
    lines.push(`    - ${combo.name}: ${combo.models}`);
  }
  lines.push("");
  lines.push("  API keys:");
  for (const key of summary.keyList) {
    lines.push(`    - ${key.name}: ${key.key}`);
  }
  lines.push("");
}

lines.push(
  "IMPORTANTE",
  "  - Este pacote contém segredos. Não commite, não envie por canais públicos.",
  "  - Suba os arquivos para o volume do serviço 9router (mount em /app/data).",
  "  - Guia completo: docs/9ROUTER_VPS_DEPLOY.md",
  ""
);

fs.writeFileSync(path.join(outDir, "LEIA-ME.txt"), lines.join("\n"), "utf-8");

// ============================================================================
// Zip
// ============================================================================
let zipPath = null;
if (wantZip) {
  console.log("\n🗜️  Compactando...");
  const JSZip = require("jszip");
  const zip = new JSZip();
  const base = "9router-vps";

  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else zip.file(rel, fs.readFileSync(full));
    }
  };
  walk(outDir, base);

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  zipPath = `${outDir}.zip`;
  fs.writeFileSync(zipPath, buffer);
}

// ============================================================================
// Saída final
// ============================================================================
console.log("");
console.log("─".repeat(70));
console.log(`✅ Pacote pronto: ${outDir}`);
console.log(`   Banco: ${mb(sourceSize)} → ${mb(finalSize)}`);
if (summary) {
  console.log(`   ${summary.providers} provedores • ${summary.combos} combos • ${summary.apiKeys} API keys`);
}
if (missingSecrets.length) {
  console.log(`   ⚠️  Segredos ausentes no host: ${missingSecrets.join(", ")}`);
}
if (zipPath) console.log(`   ZIP: ${zipPath}`);
console.log("─".repeat(70));
console.log("Próximo passo: docs/9ROUTER_VPS_DEPLOY.md");
console.log("");
