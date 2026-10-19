import { backupDatabase, BackupError } from "./backup-access";
import { loadBackupConfig } from "./backup-config";
import { postgresEnvironment, postgresTool, runBackupTool } from "./backup-postgres";

export type BackupDiagnosticCheck = {
  name: string;
  status: "success" | "failed" | "warning";
  message: string;
};

export type BackupDiagnosticReport = {
  id: string;
  status: "running" | "success" | "failed" | "warning";
  checks: BackupDiagnosticCheck[];
  created_at: string;
  completed_at: string | null;
};

export const BACKUP_DIAGNOSTICS_STORAGE_ERROR = "Não foi possível registrar ou consultar os testes. Verifique a migration 022_backup_diagnostics.sql e as permissões de service_role; nenhum novo teste pode ser confirmado sem histórico.";
const REPORT_COLUMNS = "id,status,checks,created_at,completed_at";
const POSTGRES_TOOLS = ["pg_dump", "pg_dumpall", "pg_restore", "psql"] as const;
type PostgresTool = typeof POSTGRES_TOOLS[number];
type Version = { text: string; series: number };

function toolVersion(name: PostgresTool | "tar", output: string): Version | null {
  // Só números reconhecidos; jamais devolver stdout, caminhos ou rótulos da distribuição.
  const match = name === "tar"
    ? /^(?:tar \(GNU tar\)|bsdtar|tar \(bsdtar\)) (\d{1,2}(?:\.\d{1,3}){1,2})(?=\s|$)/.exec(output.trim())
    : new RegExp(`^${name} \\(PostgreSQL\\) (\\d{1,2}(?:\\.\\d{1,3}){0,2})(?=\\s|$)`).exec(output.trim());
  if (!match) return null;
  const parts = match[1].split(".").map(Number);
  if (!parts[0] || (parts[0] < 10 && name !== "tar" && parts.length < 2)) return null;
  return { text: match[1], series: parts[0] * 10000 + (parts[0] < 10 ? (parts[1] || 0) * 100 : 0) };
}

function serverVersion(output: string): Version | null {
  const value = output.trim();
  if (!/^\d{5,6}$/.test(value)) return null;
  const num = Number(value);
  const major = Math.floor(num / 10000);
  if (major < 9) return null;
  const minor = Math.floor(num % 10000 / 100);
  return major >= 10
    ? { text: `${major}.${num % 10000}`, series: major * 10000 }
    : { text: `${major}.${minor}.${num % 100}`, series: major * 10000 + minor * 100 };
}

function validWebUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

async function collectChecks(clientId: string): Promise<BackupDiagnosticCheck[]> {
  const checks: BackupDiagnosticCheck[] = [];
  const versions: Partial<Record<PostgresTool | "tar", Version>> = {};
  const paths: Partial<Record<PostgresTool | "tar", string>> = {};
  const toolChecks = await Promise.all([...POSTGRES_TOOLS, "tar" as const].map(async name => {
    try {
      const command = name === "tar" ? "tar" : await postgresTool(name);
      paths[name] = command;
      const version = toolVersion(name, await runBackupTool(command, ["--version"], process.env, undefined, 5_000));
      if (!version) return { name, status: "failed" as const, message: "Não foi possível reconhecer a versão da ferramenta." };
      versions[name] = version;
      return { name, status: "success" as const, message: `Versão ${version.text}.` };
    } catch {
      return { name, status: "failed" as const, message: name === "tar"
        ? "Ferramenta tar indisponível ou excedeu 5 segundos. Verifique sua instalação no servidor."
        : "Ferramenta PostgreSQL indisponível ou excedeu 5 segundos. Verifique a instalação e POSTGRES_BIN_DIR no servidor." };
    }
  }));
  checks.push(...toolChecks);

  let env: NodeJS.ProcessEnv | null = null;
  try {
    if (process.env.DATABASE_URL) env = postgresEnvironment(process.env.DATABASE_URL);
  } catch { /* URL inválida: a orientação abaixo nunca incorpora seu conteúdo. */ }
  checks.push({ name: "DATABASE_URL", status: env ? "success" : "failed", message: env
    ? "DATABASE_URL tem formato PostgreSQL válido; isso não confirma que o banco é o alvo correto."
    : "Configure DATABASE_URL com protocolo PostgreSQL, host, banco, usuário, senha e sslmode válido; não use a URL HTTPS do Supabase." });

  let server: Version | null = null;
  if (env && paths.psql) {
    try {
      // Read-only e sem .psqlrc. Prazo do servidor e do processo limitam consultas presas.
      const output = await runBackupTool(paths.psql, ["-X", "-w", "-At", "-v", "ON_ERROR_STOP=1", "-c", "SHOW server_version_num"], {
        ...env, PGOPTIONS: "-c statement_timeout=15000 -c default_transaction_read_only=on",
      }, undefined, 20_000);
      server = serverVersion(output);
      checks.push({ name: "server_version", status: server ? "success" : "failed", message: server
        ? `Servidor PostgreSQL versão ${server.text}; consulta somente leitura concluída.`
        : "O servidor não retornou uma versão PostgreSQL reconhecida." });
    } catch {
      checks.push({ name: "server_version", status: "failed", message: "Conexão PostgreSQL falhou ou excedeu 20 segundos. Revise DATABASE_URL, rede, autenticação e TLS do banco remoto." });
    }
  } else {
    checks.push({ name: "server_version", status: "warning", message: "Consulta não executada: corrija DATABASE_URL e a ferramenta psql antes de repetir." });
  }

  const dump = versions.pg_dump;
  const restore = versions.pg_restore;
  for (const name of ["pg_dump", "pg_dumpall"] as const) {
    const version = versions[name];
    checks.push({ name: `${name}_compatibility`, status: !version || !server ? "warning" : version.series >= server.series ? "success" : "failed", message: !version || !server
      ? `Compatibilidade ${name}/servidor não verificada: versões indisponíveis.`
      : version.series >= server.series ? `A versão do ${name} não é anterior à série do servidor.`
        : `${name} mais antigo que o servidor. Instale uma série PostgreSQL compatível antes de exportar.` });
  }
  checks.push({ name: "pg_restore_compatibility", status: !restore || !dump ? "warning" : restore.series >= dump.series ? "success" : "failed", message: !restore || !dump
    ? "Compatibilidade pg_restore/pg_dump não verificada: versões indisponíveis."
    : restore.series >= dump.series ? "A versão do pg_restore não é anterior à série do pg_dump."
      : "pg_restore mais antigo que pg_dump. Alinhe as ferramentas antes de restaurar." });

  const oauth = Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim())
    && validWebUrl(process.env.GOOGLE_REDIRECT_URI || process.env.NEXT_PUBLIC_APP_URL);
  checks.push({ name: "GOOGLE_OAUTH", status: oauth ? "success" : "failed", message: oauth
    ? "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e redirecionamento presentes. OAuth do Drive no painel é independente do OAuth do EasyPanel; autorização não foi testada no Google."
    : "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI (ou NEXT_PUBLIC_APP_URL válida). OAuth do Drive no painel é independente do OAuth do EasyPanel." });
  checks.push({ name: "BACKUP_TOKEN_KEY", status: /^[a-f\d]{64}$/i.test(process.env.BACKUP_TOKEN_KEY || "") ? "success" : "failed", message: /^[a-f\d]{64}$/i.test(process.env.BACKUP_TOKEN_KEY || "")
    ? "BACKUP_TOKEN_KEY tem 64 caracteres hexadecimais; tokens não foram descriptografados."
    : "Configure BACKUP_TOKEN_KEY com 64 caracteres hexadecimais e guarde uma cópia fora da VPS." });
  checks.push({ name: "BACKUP_WORKER_ENABLED", status: process.env.BACKUP_WORKER_ENABLED === "true" ? "success" : "warning", message: process.env.BACKUP_WORKER_ENABLED === "true"
    ? "BACKUP_WORKER_ENABLED habilitado na configuração; atividade do worker não foi confirmada."
    : "BACKUP_WORKER_ENABLED desativado. Backups em fila não serão processados; este teste não ativa o worker." });
  try {
    const config = await loadBackupConfig(clientId);
    const connected = Boolean(config?.encrypted_tokens || (config?.google_access_token && config?.google_refresh_token));
    checks.push({ name: "GOOGLE_DRIVE", status: connected ? "success" : "warning", message: connected
      ? "Autorização do Drive encontrada apenas no registro local; sem descriptografar tokens ou acessar o Google. Validade e upload não testados."
      : "Nenhuma autorização local do Google Drive. Conecte o Drive no painel; conectar o Google ao EasyPanel não conecta este backup." });
  } catch {
    checks.push({ name: "GOOGLE_DRIVE", status: "failed", message: "Não foi possível consultar a autorização local. Verifique a configuração e a migration 020_backup_security_runs.sql." });
  }
  checks.push({ name: "scope", status: "success", message: "Este diagnóstico não comprova o banco-alvo correto, backup, upload nem recuperação válida. A recuperação exige teste separado em ambiente isolado." });
  return checks;
}

export async function runBackupDiagnostics(clientId: string): Promise<BackupDiagnosticReport> {
  let initial: BackupDiagnosticReport;
  try {
    const { data, error } = await backupDatabase().from("backup_diagnostics")
      .insert({ client_id: clientId, status: "running", checks: [] }).select(REPORT_COLUMNS).single();
    if (error || !data) throw new Error("persistence");
    initial = data as BackupDiagnosticReport;
  } catch { throw new BackupError(BACKUP_DIAGNOSTICS_STORAGE_ERROR); }

  let checks: BackupDiagnosticCheck[];
  try { checks = await collectChecks(clientId); }
  catch { checks = [{ name: "diagnostics", status: "failed", message: "Diagnóstico interrompido por falha interna; nenhum backup foi criado. Repita após revisar a configuração do servidor." }]; }
  const status = checks.some(check => check.status === "failed") ? "failed"
    : checks.some(check => check.status === "warning") ? "warning" : "success";
  const diagnostic: BackupDiagnosticReport = {
    id: initial.id, created_at: initial.created_at, status, checks, completed_at: new Date().toISOString(),
  };
  try {
    const { data, error } = await backupDatabase().from("backup_diagnostics")
      .update({ status, checks, completed_at: diagnostic.completed_at })
      .eq("id", initial.id).eq("client_id", clientId).select(REPORT_COLUMNS).single();
    if (error || !data) throw new Error("persistence");
  } catch { throw new BackupError(BACKUP_DIAGNOSTICS_STORAGE_ERROR); }
  return diagnostic;
}

export async function listBackupDiagnostics(clientId: string): Promise<BackupDiagnosticReport[]> {
  try {
    const { data, error } = await backupDatabase().from("backup_diagnostics")
      .select(REPORT_COLUMNS).eq("client_id", clientId).order("created_at", { ascending: false }).limit(20);
    if (error) throw new Error("persistence");
    return (data || []) as BackupDiagnosticReport[];
  } catch { throw new BackupError(BACKUP_DIAGNOSTICS_STORAGE_ERROR); }
}
