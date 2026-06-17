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
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, execFile } from "child_process";

const PROXY_PORT = 8317;
export const PROXY_BASE_URL = `http://127.0.0.1:${PROXY_PORT}`;
/** baseURL OpenAI-compatible que vira a "conexão" no gateway_endpoints. */
export const PROXY_V1_URL = `${PROXY_BASE_URL}/v1`;

/**
 * Diretório onde o conector vive (binário, config, key, logins). Escolhido em
 * ordem de preferência, caindo pra um lugar GRAVÁVEL:
 *   1. GATEWAY_PROXY_DIR (env) — pra apontar um volume persistente no deploy.
 *   2. {cwd}/.gateway-proxy   — padrão; persiste se a pasta for gravável
 *      (no Docker exige chown pro usuário não-root — ver Dockerfile).
 *   3. {tmp}/painel-gateway-proxy — último recurso SEMPRE gravável (mas some
 *      no restart). Evita o erro EACCES quando /app pertence ao root.
 */
function dirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBaseDir(): string {
  const candidates = [
    process.env.GATEWAY_PROXY_DIR,
    path.join(process.cwd(), ".gateway-proxy"),
    path.join(os.tmpdir(), "painel-gateway-proxy"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (dirWritable(c)) return c;
  }
  return path.join(process.cwd(), ".gateway-proxy"); // deixa estourar com erro claro depois
}

const DIR = resolveBaseDir();
const BIN_DIR = path.join(DIR, "bin");
const CONFIG_PATH = path.join(DIR, "config.yaml");
const KEY_PATH = path.join(DIR, "management.key");
const PID_PATH = path.join(DIR, "proxy.pid");
const BINPATH_PATH = path.join(DIR, "bin-path.txt");
const LOG_PATH = path.join(DIR, "proxy.log");
const AUTH_DIR = path.join(DIR, "auths");
// Sidecar irmão do auths/ — guarda APELIDO + provider canônico + createdAt.
// Fica FORA do auth-dir do proxy de propósito: o proxy não escaneia esta pasta,
// então não há risco do JSON de metadado ser confundido com uma credencial.
const AUTH_META_DIR = path.join(DIR, "auth-meta");
// "Estacionamento" pra contas pausadas — fica fora do auth-dir, então o proxy
// para de usá-las na rotação SEM perder o login. Retomar = mover de volta.
const AUTH_PAUSED_DIR = path.join(DIR, "auths-paused");

export type ProxyProvider = "gemini" | "claude" | "openai" | "antigravity";

/**
 * Conta logada no conector. `name` é o NOME DO ARQUIVO em auths/ (chave única —
 * o que a Management API devolve), `provider` é o rótulo canônico que a UI usa
 * pra agrupar/colorir ("gemini"|"claude"|"openai"|"antigravity"|...), `email` é
 * extraído do nome do arquivo quando dá (pra UI mostrar algo amigável), e
 * `label` é o APELIDO que o usuário pôs (vindo do sidecar de metadados — pode
 * ser vazio).
 */
export interface ProxyAccount {
  name: string;
  provider: string;
  email?: string;
  label?: string;
  createdAt?: string;
  status?: string;
  /** true = arquivo movido pra auths-paused/; o proxy não a usa. */
  paused?: boolean;
}

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
  accounts: ProxyAccount[];
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

async function mgmtPost(pathname: string, body: unknown, timeoutMs = 20000): Promise<Response> {
  const key = getManagementKey();
  if (!key) throw new Error("Conector não instalado pelo painel (sem management key).");
  return fetch(`${PROXY_BASE_URL}/v0/management/${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  // Contas pausadas vivem fora do auth-dir, então a Management API NÃO as vê.
  // Listamos diretamente do FS pra UI mostrar e oferecer "Retomar".
  accounts = [...accounts, ...listPausedAccounts()];
  return { installed, running, managementReady, baseUrl: PROXY_BASE_URL, v1Url: PROXY_V1_URL, accounts };
}

/**
 * Mapeia o `provider` cru (do auth-file ou inferido pelo nome) pro rótulo
 * canônico que a UI conhece. Mantém compatibilidade com proxies que devolvem
 * tipos diferentes ("anthropic" vs "claude", "codex" vs "openai", etc).
 */
function canonicalProvider(raw: string, fileName: string): string {
  const s = (raw || "").toLowerCase();
  const f = (fileName || "").toLowerCase();
  if (/antigravity/.test(s) || /antigravity/.test(f)) return "antigravity";
  if (/claude|anthropic/.test(s) || /claude|anthropic/.test(f)) return "claude";
  if (/gem|google|gcp/.test(s) || /gem|google/.test(f)) return "gemini";
  if (/codex|openai|gpt|chatgpt/.test(s) || /codex|openai|gpt/.test(f)) return "openai";
  return s || "other";
}

/** Extrai um email do nome do arquivo, se houver (formato comum: `<provider>-<email>-<suffix>.json`). */
function extractEmail(fileName: string): string | undefined {
  const m = (fileName || "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m?.[0];
}

async function parseAccounts(res: Response): Promise<ProxyAccount[]> {
  const json: any = await res.json().catch(() => null);
  const arr: any[] = Array.isArray(json) ? json
    : Array.isArray(json?.files) ? json.files
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.auth_files) ? json.auth_files : [];
  return arr
    .map((f: any) => {
      const name = String(f?.name ?? f?.file ?? "");
      const rawProvider = String(f?.provider ?? f?.type ?? "");
      const provider = canonicalProvider(rawProvider, name);
      const meta = readAccountMeta(name);
      return {
        name,
        provider,
        email: extractEmail(name),
        label: meta?.label,
        createdAt: meta?.createdAt,
        status: f?.status ? String(f.status) : undefined,
      } satisfies ProxyAccount;
    })
    .filter((f) => f.name);
}

// ---------------------------------------------------------------------------
// Metadados das contas (apelido, criado-em) — sidecar fora do auth-dir
// ---------------------------------------------------------------------------

interface AccountMeta {
  label?: string;
  createdAt?: string;
}

/**
 * Sanitiza o nome de arquivo recebido da UI/Management API ANTES de virar
 * caminho — bloqueia path traversal (`..`, `/`, `\\`) e qualquer separador. Usa
 * só o basename. Retorna `null` se sobrar algo suspeito.
 */
function safeAuthName(raw: string): string | null {
  const s = String(raw || "");
  if (!s) return null;
  const base = path.basename(s);
  if (!base || base.includes("..") || base.includes("/") || base.includes("\\")) return null;
  if (!/^[\w.@+\-]+$/.test(base)) return null;
  return base;
}

function metaPath(name: string): string | null {
  const safe = safeAuthName(name);
  if (!safe) return null;
  return path.join(AUTH_META_DIR, `${safe}.json`);
}

function readAccountMeta(name: string): AccountMeta | null {
  const p = metaPath(name);
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    return {
      label: typeof j?.label === "string" ? j.label : undefined,
      createdAt: typeof j?.createdAt === "string" ? j.createdAt : undefined,
    };
  } catch {
    return null;
  }
}

function writeAccountMeta(name: string, patch: AccountMeta): void {
  const p = metaPath(name);
  if (!p) throw new Error("Nome de conta inválido.");
  fs.mkdirSync(AUTH_META_DIR, { recursive: true });
  const current = readAccountMeta(name) || {};
  const next: AccountMeta = {
    label: patch.label !== undefined ? patch.label : current.label,
    createdAt: current.createdAt || patch.createdAt || new Date().toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
}

function deleteAccountMeta(name: string): void {
  const p = metaPath(name);
  if (!p) return;
  try { fs.unlinkSync(p); } catch { /* não-fatal */ }
}

/**
 * Define/atualiza o APELIDO de uma conta logada. Valida que o auth file existe
 * antes de gravar metadado órfão.
 */
export function renameAccount(name: string, label: string): void {
  const safe = safeAuthName(name);
  if (!safe) throw new Error("Nome de conta inválido.");
  const authFile = path.join(AUTH_DIR, safe);
  if (!fs.existsSync(authFile)) throw new Error("Conta não encontrada no conector.");
  const trimmed = String(label || "").slice(0, 60).trim();
  writeAccountMeta(safe, { label: trimmed });
}

/**
 * Remove uma conta logada — apaga o arquivo OAuth em auths/ e o sidecar de
 * metadado. O proxy detecta a remoção no próximo reload do diretório. Caso o
 * proxy esteja em uso, o pior cenário é que a próxima request use outra conta
 * logada do mesmo provedor (a rotação interna).
 */
export function deleteAccount(name: string): void {
  const safe = safeAuthName(name);
  if (!safe) throw new Error("Nome de conta inválido.");
  // Remove esteja ela ATIVA (auths/) ou PAUSADA (auths-paused/).
  const activeFile = path.join(AUTH_DIR, safe);
  const pausedFile = path.join(AUTH_PAUSED_DIR, safe);
  let removed = false;
  if (fs.existsSync(activeFile)) { fs.unlinkSync(activeFile); removed = true; }
  if (fs.existsSync(pausedFile)) { fs.unlinkSync(pausedFile); removed = true; }
  if (!removed) throw new Error("Conta não encontrada no conector.");
  deleteAccountMeta(safe);
}

/**
 * "Estaciona" uma conta — move o arquivo OAuth pra `auths-paused/`. O proxy
 * deixa de rotacionar pra ela na próxima varredura, mas o login fica salvo.
 * Pra retomar, basta chamar `resumeAccount`. Útil quando a conta começou a dar
 * 429 e o usuário quer "descansar" sem perder o login.
 */
export function pauseAccount(name: string): void {
  const safe = safeAuthName(name);
  if (!safe) throw new Error("Nome de conta inválido.");
  const src = path.join(AUTH_DIR, safe);
  if (!fs.existsSync(src)) throw new Error("Conta não está ativa (já pausada ou inexistente).");
  fs.mkdirSync(AUTH_PAUSED_DIR, { recursive: true });
  const dst = path.join(AUTH_PAUSED_DIR, safe);
  fs.renameSync(src, dst);
}

/** Move a conta pausada de volta pra rotação. */
export function resumeAccount(name: string): void {
  const safe = safeAuthName(name);
  if (!safe) throw new Error("Nome de conta inválido.");
  const src = path.join(AUTH_PAUSED_DIR, safe);
  if (!fs.existsSync(src)) throw new Error("Conta pausada não encontrada.");
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const dst = path.join(AUTH_DIR, safe);
  if (fs.existsSync(dst)) throw new Error("Já existe uma conta ativa com o mesmo nome.");
  fs.renameSync(src, dst);
}

/**
 * Lista as contas atualmente em `auths-paused/` (que a Management API NÃO vê).
 * Faz o mesmo enriquecimento de `parseAccounts` (provider canônico + meta +
 * email do nome) e marca `paused: true`. Tolerante a pasta inexistente.
 */
function listPausedAccounts(): ProxyAccount[] {
  let entries: string[] = [];
  try { entries = fs.readdirSync(AUTH_PAUSED_DIR); } catch { return []; }
  return entries
    .filter((n) => /\.json$/i.test(n))
    .map((name) => {
      const provider = canonicalProvider("", name);
      const meta = readAccountMeta(name);
      return {
        name,
        provider,
        email: extractEmail(name),
        label: meta?.label,
        createdAt: meta?.createdAt,
        paused: true,
      } satisfies ProxyAccount;
    });
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

/**
 * Nome do provedor no corpo do POST /oauth-callback (difere do nosso rótulo
 * interno). Espelha o WebUI oficial: gemini-cli vira "gemini".
 */
const CALLBACK_PROVIDER: Record<ProxyProvider, string> = {
  gemini: "gemini",
  claude: "anthropic",
  openai: "codex",
  antigravity: "antigravity",
};

/**
 * Inicia o OAuth e devolve a URL pro usuário abrir + state pra acompanhar.
 * `is_webui=true` faz o proxy montar o forwarder de callback do modo UI — é o
 * que o WebUI oficial usa e o que mantém o login concluível via /oauth-callback.
 */
export async function startLogin(provider: ProxyProvider): Promise<{ url: string; state: string }> {
  const ep = LOGIN_ENDPOINT[provider];
  if (!ep) throw new Error(`Provedor desconhecido: ${provider}`);
  const res = await mgmtFetch(`${ep}?is_webui=true`, 20000);
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
 * do proxy. O provedor redireciona pra http://localhost:PORTA/... (Codex 1455,
 * Gemini 8085, Claude 54545) — "localhost" da máquina DO PAINEL. Numa VPS/Docker
 * a aba do usuário dá ERR_CONNECTION_REFUSED e o código fica preso na URL.
 *
 * Caminho ROBUSTO (igual ao WebUI oficial): entrega a URL inteira ao endpoint
 * estável `POST /v0/management/oauth-callback` (porta de gerenciamento 8317),
 * que extrai code+state e finaliza o login. NÃO depende do ouvinte efêmero da
 * porta do OAuth, que expira rápido. Fallback (proxy antigo sem esse endpoint):
 * reproduz a URL direto no 127.0.0.1:PORTA.
 */
export async function completeLoginCallback(redirectUrl: string, provider?: ProxyProvider): Promise<void> {
  const url = String(redirectUrl).trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('URL inválida. Cole a URL INTEIRA da aba do login (começa com "http://localhost:...").');
  }
  const isLocalHost = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname.toLowerCase());
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const looksLikeOauthCallback = u.pathname.toLowerCase().includes("callback") && u.searchParams.has("code");
  if (!isLocalHost || !looksLikeOauthCallback || !Number.isFinite(port) || port < 1024 || port > 65535) {
    throw new Error(
      "Essa não parece a URL de callback do login (esperado algo como http://localhost:8085/oauth2callback?state=...&code=...)."
    );
  }

  // 1) Caminho robusto: POST /oauth-callback na management API (estável).
  const cbProvider = provider ? CALLBACK_PROVIDER[provider] : undefined;
  let postErr: string | null = null;
  if (cbProvider) {
    try {
      const res = await mgmtPost("oauth-callback", { provider: cbProvider, redirect_url: url });
      if (res.ok) return; // login concluído
      const txt = (await res.text().catch(() => "")).slice(0, 200);
      // 404/405 = proxy não tem o endpoint → tenta o fallback abaixo.
      if (res.status !== 404 && res.status !== 405) {
        throw new Error(`O conector recusou o login (HTTP ${res.status}${txt ? ` — ${txt}` : ""}).`);
      }
      postErr = `HTTP ${res.status}`;
    } catch (e: any) {
      // erro de rede/timeout no POST → tenta o fallback efêmero.
      postErr = e?.message || String(e);
    }
  }

  // 2) Fallback: reproduz a URL no ouvinte efêmero do servidor (127.0.0.1:PORTA).
  const target = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(20000), redirect: "manual" });
    if (res.status >= 400) {
      const body = (await res.text().catch(() => "")).slice(0, 160);
      throw new Error(`O conector recusou o callback (HTTP ${res.status}${body ? ` — ${body}` : ""}).`);
    }
  } catch (e: any) {
    throw new Error(
      'Não consegui concluir o login (o conector pode ter expirado o pedido' +
        (postErr ? `; oauth-callback: ${postErr}` : "") +
        '). Clique em "Conectar conta" de novo, faça o login e copie a URL logo em seguida.'
    );
  }
}
