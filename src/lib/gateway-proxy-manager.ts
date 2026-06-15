/**
 * CONECTOR EMBUTIDO de assinaturas — gerencia um CLIProxyAPI LOCAL pelo próprio
 * painel ("1 clique"): baixa o binário oficial do GitHub, escreve o config,
 * liga/desliga o processo e inicia o LOGIN OAuth das contas (Gemini / Claude /
 * ChatGPT) via Management API do proxy. Assim o usuário conecta as contas sem
 * sair do sistema — só a tela de login do provedor abre (isso é do OAuth).
 *
 * Server-only (fs/child_process). Roda na MESMA máquina do servidor Next — em
 * serverless (Vercel etc.) não funciona; o modo manual continua existindo.
 *
 * Management API (https://help.router-for.me/management/api):
 *   base   GET {proxy}/v0/management/...   Authorization: Bearer <secret-key>
 *   login  GET /gemini-cli-auth-url | /anthropic-auth-url | /codex-auth-url
 *          | /antigravity-auth-url  → { status:"ok", url, state }
 *   poll   GET /get-auth-status?state=... → { status: "wait"|"ok"|"error" }
 *   contas GET /auth-files → lista de credenciais salvas
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn, execFile } from "child_process";

const PROXY_PORT = 8317;
export const PROXY_BASE_URL = `http://127.0.0.1:${PROXY_PORT}`;
/** baseURL OpenAI-compatible que vira a "conexão" no gateway_endpoints. */
export const PROXY_V1_URL = `${PROXY_BASE_URL}/v1`;

const DIR = path.join(process.cwd(), ".gateway-proxy");
const BIN_DIR = path.join(DIR, "bin");
const CONFIG_PATH = path.join(DIR, "config.yaml");
const KEY_PATH = path.join(DIR, "management.key");
const PID_PATH = path.join(DIR, "proxy.pid");
const BINPATH_PATH = path.join(DIR, "bin-path.txt");
const LOG_PATH = path.join(DIR, "proxy.log");
const AUTH_DIR = path.join(DIR, "auths");

export type ProxyProvider = "gemini" | "claude" | "openai" | "antigravity";

export interface ProxyStatus {
  /** Binário baixado e config escrito por NÓS. */
  installed: boolean;
  /** Algo respondendo HTTP na porta do proxy. */
  running: boolean;
  /** Respondendo E aceitando a NOSSA management key (instalado pelo painel). */
  managementReady: boolean;
  baseUrl: string;
  v1Url: string;
  /** Contas logadas no conector (auth-files), quando managementReady. */
  accounts: { name: string; provider: string; status?: string }[];
}

// ---------------------------------------------------------------------------
// Helpers de arquivo
// ---------------------------------------------------------------------------

function readText(p: string): string | null {
  try { return fs.readFileSync(p, "utf8").trim() || null; } catch { return null; }
}

function getManagementKey(): string | null {
  return readText(KEY_PATH);
}

function getBinPath(): string | null {
  const p = readText(BINPATH_PATH);
  return p && fs.existsSync(p) ? p : null;
}

export function isInstalled(): boolean {
  return !!(getBinPath() && getManagementKey() && fs.existsSync(CONFIG_PATH));
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** true se ALGO responde HTTP na porta (mesmo 404). ECONNREFUSED → false. */
async function isPortResponding(): Promise<boolean> {
  try {
    await fetch(`${PROXY_BASE_URL}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    // fetch lança em erro de REDE; status HTTP qualquer não lança.
    return false;
  }
}

async function mgmtFetch(pathname: string, timeoutMs = 8000): Promise<Response> {
  const key = getManagementKey();
  if (!key) throw new Error("Conector não instalado pelo painel (sem management key).");
  return fetch(`${PROXY_BASE_URL}/v0/management/${pathname}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function getProxyStatus(): Promise<ProxyStatus> {
  const installed = isInstalled();
  const running = await isPortResponding();
  let managementReady = false;
  let accounts: ProxyStatus["accounts"] = [];
  if (running && getManagementKey()) {
    try {
      const res = await mgmtFetch("auth-files", 4000);
      managementReady = res.ok;
      if (res.ok) accounts = await parseAccounts(res);
    } catch { /* porta aberta mas management indisponível */ }
  }
  return { installed, running, managementReady, baseUrl: PROXY_BASE_URL, v1Url: PROXY_V1_URL, accounts };
}

async function parseAccounts(res: Response): Promise<ProxyStatus["accounts"]> {
  const json: any = await res.json().catch(() => null);
  const arr: any[] = Array.isArray(json) ? json
    : Array.isArray(json?.files) ? json.files
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.auth_files) ? json.auth_files : [];
  return arr.map((f: any) => ({
    name: String(f?.name ?? f?.file ?? ""),
    provider: String(f?.provider ?? f?.type ?? "").toLowerCase(),
    status: f?.status ? String(f.status) : undefined,
  })).filter((f) => f.name);
}

// ---------------------------------------------------------------------------
// Instalação (download do release oficial + config)
// ---------------------------------------------------------------------------

/** Nome do asset do release pro SO/arch deste servidor. */
function assetSuffix(): { suffix: string; ext: "zip" | "tar.gz" } {
  const arch = process.arch === "arm64" ? "aarch64" : "amd64";
  if (process.platform === "win32") return { suffix: `windows_${arch}.zip`, ext: "zip" };
  if (process.platform === "darwin") return { suffix: `darwin_${arch}.tar.gz`, ext: "tar.gz" };
  return { suffix: `linux_${arch}.tar.gz`, ext: "tar.gz" };
}

async function fetchLatestAsset(): Promise<{ name: string; url: string; version: string }> {
  const res = await fetch("https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest", {
    headers: { "User-Agent": "painel-sdr", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status} ao buscar o release do conector.`);
  const json: any = await res.json();
  const { suffix } = assetSuffix();
  const asset = (json?.assets || []).find(
    (a: any) => typeof a?.name === "string" && a.name.endsWith(suffix) && !a.name.includes("no-plugin")
  ) || (json?.assets || []).find(
    (a: any) => typeof a?.name === "string" && a.name.endsWith(suffix)
  );
  if (!asset?.browser_download_url) {
    throw new Error(`Release do conector não tem binário pra esta plataforma (${suffix}).`);
  }
  return { name: asset.name, url: asset.browser_download_url, version: String(json?.tag_name || "") };
}

function extractArchive(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (archivePath.endsWith(".zip")) {
      // PowerShell lida com caminho com espaço via aspas simples escapadas.
      const script = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (err) =>
        err ? reject(new Error(`Falha ao extrair zip: ${err.message}`)) : resolve()
      );
    } else {
      execFile("tar", ["-xzf", archivePath, "-C", destDir], (err) =>
        err ? reject(new Error(`Falha ao extrair tar.gz: ${err.message}`)) : resolve()
      );
    }
  });
}

/** Acha o executável dentro da pasta extraída (nomes variam por versão). */
function findBinary(dir: string): string | null {
  const candidates: { p: string; size: number; score: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      const isExe = process.platform === "win32"
        ? e.name.toLowerCase().endsWith(".exe")
        : !e.name.includes(".") || e.name.endsWith(".bin");
      if (!isExe) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch { /* ignora */ }
      const score = /cli-?proxy-?api/i.test(e.name) ? 2 : 1;
      candidates.push({ p, size, score });
    }
  };
  walk(dir, 0);
  candidates.sort((a, b) => b.score - a.score || b.size - a.size);
  return candidates[0]?.p || null;
}

function writeConfig(managementKey: string) {
  // Caminho com barras normais — em YAML, backslash dentro de aspas é escape.
  const authDir = AUTH_DIR.replace(/\\/g, "/");
  const yaml = [
    `port: ${PROXY_PORT}`,
    `auth-dir: "${authDir}"`,
    // Sem api-keys: o endpoint /v1 local fica aberto (uso na própria máquina).
    `api-keys: []`,
    `remote-management:`,
    `  allow-remote: false`,
    `  secret-key: "${managementKey}"`,
    ``,
  ].join("\n");
  fs.writeFileSync(CONFIG_PATH, yaml, "utf8");
}

/**
 * Baixa o release oficial, extrai, escreve config + management key. Idempotente:
 * reinstalar reaproveita a key existente (as contas logadas em auths/ ficam).
 */
export async function installProxy(): Promise<{ version: string; binPath: string }> {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const asset = await fetchLatestAsset();
  const archivePath = path.join(DIR, asset.name);
  const res = await fetch(asset.url, {
    headers: { "User-Agent": "painel-sdr" },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Download do conector falhou (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(archivePath, buf);

  await extractArchive(archivePath, BIN_DIR);
  try { fs.unlinkSync(archivePath); } catch { /* não-fatal */ }

  const binPath = findBinary(BIN_DIR);
  if (!binPath) throw new Error("Binário do conector não encontrado após extrair o release.");
  if (process.platform !== "win32") {
    try { fs.chmodSync(binPath, 0o755); } catch { /* não-fatal */ }
  }
  fs.writeFileSync(BINPATH_PATH, binPath, "utf8");

  // Reusa a key se já existia (o proxy grava o hash bcrypt no config ao subir,
  // mas a comparação é contra o plaintext que mandamos no header).
  let key = getManagementKey();
  if (!key) {
    key = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(KEY_PATH, key, "utf8");
  }
  writeConfig(key);
  return { version: asset.version, binPath };
}

// ---------------------------------------------------------------------------
// Processo (ligar / desligar)
// ---------------------------------------------------------------------------

export async function startProxy(): Promise<ProxyStatus> {
  if (await isPortResponding()) return getProxyStatus(); // já tem algo na porta

  const binPath = getBinPath();
  if (!binPath) throw new Error("Conector não instalado. Clique em Instalar primeiro.");

  const logFd = fs.openSync(LOG_PATH, "a");
  const child = spawn(binPath, ["--config", CONFIG_PATH], {
    cwd: DIR,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  if (child.pid) fs.writeFileSync(PID_PATH, String(child.pid), "utf8");

  // Espera subir (até ~12s).
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isPortResponding()) break;
  }
  const st = await getProxyStatus();
  if (!st.running) {
    const tail = (readText(LOG_PATH) || "").split(/\r?\n/).slice(-8).join("\n");
    throw new Error(`Conector não subiu. Últimas linhas do log:\n${tail || "(log vazio)"}`);
  }
  return st;
}

export async function stopProxy(): Promise<ProxyStatus> {
  const pid = Number(readText(PID_PATH) || 0);
  if (pid > 0) {
    await new Promise<void>((resolve) => {
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
      } else {
        try { process.kill(pid); } catch { /* já morto */ }
        resolve();
      }
    });
    try { fs.unlinkSync(PID_PATH); } catch { /* não-fatal */ }
  }
  // Dá um instante pro SO liberar a porta antes de checar.
  await new Promise((r) => setTimeout(r, 800));
  return getProxyStatus();
}

// ---------------------------------------------------------------------------
// Login OAuth das contas (via Management API)
// ---------------------------------------------------------------------------

const LOGIN_ENDPOINT: Record<ProxyProvider, string> = {
  gemini: "gemini-cli-auth-url",
  claude: "anthropic-auth-url",
  openai: "codex-auth-url",
  // Antigravity = uma conta Google que libera vários modelos de graça
  // (Gemini 3 Pro, Claude, GPT, Grok). Mesmo fluxo OAuth dos demais.
  antigravity: "antigravity-auth-url",
};

/** Inicia o OAuth e devolve a URL pro usuário abrir + state pra acompanhar. */
export async function startLogin(provider: ProxyProvider): Promise<{ url: string; state: string }> {
  const ep = LOGIN_ENDPOINT[provider];
  if (!ep) throw new Error(`Provedor desconhecido: ${provider}`);
  const res = await mgmtFetch(ep, 20000);
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.url) {
    throw new Error(json?.error || json?.message || `Conector respondeu ${res.status} ao iniciar o login.`);
  }
  return { url: String(json.url), state: String(json.state || "") };
}

/** Consulta o andamento do login: "wait" | "ok" | "error". */
export async function getLoginStatus(state: string): Promise<{ status: string; error?: string }> {
  const res = await mgmtFetch(`get-auth-status?state=${encodeURIComponent(state)}`, 10000);
  const json: any = await res.json().catch(() => ({}));
  return { status: String(json?.status || (res.ok ? "wait" : "error")), error: json?.error ? String(json.error) : undefined };
}

/**
 * Conclui um login OAuth quando o NAVEGADOR do usuário não alcança o listener
 * do proxy. O provedor sempre redireciona pra http://localhost:PORTA/...
 * (Codex 1455, Gemini 8085, Claude 54545) — "localhost" da máquina DO PAINEL.
 * Se o painel roda numa VPS/Docker, a aba do usuário dá ERR_CONNECTION_REFUSED
 * e o código de autorização fica preso na URL. O usuário cola essa URL no
 * painel e esta função a reproduz server-side contra 127.0.0.1, onde o
 * listener realmente está — entregando o código e concluindo o login.
 */
export async function completeLoginCallback(redirectUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(String(redirectUrl).trim());
  } catch {
    throw new Error('URL inválida. Cole a URL INTEIRA da aba do login (começa com "http://localhost:...").');
  }
  const isLocalHost = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname.toLowerCase());
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const looksLikeOauthCallback = u.pathname.toLowerCase().includes("callback") && u.searchParams.has("code");
  if (!isLocalHost || !looksLikeOauthCallback || !Number.isFinite(port) || port < 1024 || port > 65535) {
    throw new Error(
      "Essa não parece a URL de callback do login (esperado algo como http://localhost:1455/auth/callback?code=...&state=...)."
    );
  }
  const target = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
  let res: Response;
  try {
    res = await fetch(target, { signal: AbortSignal.timeout(20000), redirect: "manual" });
  } catch {
    throw new Error(
      'O conector não está mais esperando esse login (o link expira rápido). Clique em "Conectar conta" de novo, faça o login e cole a nova URL logo em seguida.'
    );
  }
  if (res.status >= 400) {
    const body = await res.text().catch(() => "");
    throw new Error(`O conector recusou o callback (HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ""}). Tente o login de novo.`);
  }
}
