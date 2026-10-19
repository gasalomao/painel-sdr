import { spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BackupError } from "./backup-access";

export type BackupLog = (message: string) => Promise<void>;

export async function postgresTool(name: "pg_dump" | "pg_dumpall" | "pg_restore" | "psql"): Promise<string> {
  const configured = process.env.POSTGRES_BIN_DIR;
  if (configured) return join(configured, process.platform === "win32" ? `${name}.exe` : name);
  if (process.platform !== "win32") return name;
  const root = join(process.env.ProgramFiles || "C:\\Program Files", "PostgreSQL");
  try {
    const versions = (await readdir(root)).filter(v => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
    for (const version of versions) {
      const path = join(root, version, "bin", `${name}.exe`);
      if (existsSync(path)) return path;
    }
  } catch {
    throw new BackupError("Ferramentas PostgreSQL não encontradas. Configure POSTGRES_BIN_DIR no servidor.");
  }
  throw new BackupError("Ferramentas PostgreSQL não encontradas. Configure POSTGRES_BIN_DIR no servidor.");
}

export function postgresEnvironment(urlString: string): NodeJS.ProcessEnv {
  const url = new URL(urlString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1)) {
    throw new BackupError("DATABASE_URL precisa de host, banco, usuário e senha do PostgreSQL remoto.");
  }
  const sslmode = url.searchParams.get("sslmode") || "prefer";
  if (!["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)) throw new BackupError("sslmode PostgreSQL inválido.");
  return {
    ...process.env,
    PGHOST: url.hostname, PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: "15",
    PGSSLMODE: sslmode,
  };
}

export async function runBackupTool(command: string, args: string[], env: NodeJS.ProcessEnv, log?: BackupLog, timeoutMs = 3_600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorText = "";
    let stopped = false;
    let events = Promise.resolve();
    const timeoutMessage = timeoutMs === 3_600_000
      ? "Exportação excedeu o prazo de uma hora; nenhum backup foi confirmado."
      : "Ferramenta de diagnóstico excedeu o prazo de execução.";
    const timeout = setTimeout(() => {
      stopped = true;
      if (timeoutMs === 3_600_000) child.kill();
      else {
        child.kill("SIGKILL");
        reject(new BackupError(timeoutMessage));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2_000_000); });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      errorText = (errorText + text).slice(-10_000);
      // Mensagem genérica de atividade; nunca persistir conteúdo SQL, URI ou senhas do processo.
      if (log && /dumping contents of table|reading schemas/.test(text)) {
        events = events.then(() => log("PostgreSQL exportando os objetos e dados do snapshot."));
      }
    });
    child.on("error", () => { clearTimeout(timeout); reject(new BackupError("Não foi possível executar a ferramenta PostgreSQL. Verifique POSTGRES_BIN_DIR.")); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (stopped) return reject(new BackupError(timeoutMessage));
      if (code !== 0) {
        const reason = /password authentication failed/.test(errorText) ? "Senha do PostgreSQL remoto rejeitada (não é a senha do painel)."
          : /could not translate host name|could not connect|connection.*failed|Connection refused|timeout expired/.test(errorText) ? "PostgreSQL remoto inacessível. Confirme a rede privada, host e porta; domínio HTTPS do Supabase não garante acesso ao banco."
          : /server version mismatch/.test(errorText) ? "Cliente pg_dump mais antigo que o servidor PostgreSQL."
          : /permission denied|must be superuser/.test(errorText) ? "Usuário PostgreSQL sem permissão para exportar o banco completo."
          : "Ferramenta PostgreSQL falhou; nenhum backup íntegro foi confirmado.";
        return reject(new BackupError(reason));
      }
      events.then(() => resolve(output), reject);
    });
  });
}

export async function fileDigest(path: string, algorithm: "sha256" | "md5" = "sha256"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function ensureNonempty(path: string): Promise<number> {
  const size = (await stat(path)).size;
  if (!size) throw new BackupError("Arquivo exportado vazio. Upload cancelado.");
  return size;
}
