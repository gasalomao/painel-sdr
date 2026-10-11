import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, BackupError, safeBackupError } from "./backup-access";
import { loadBackupConfig, backupCredentials } from "./backup-config";
import { GoogleDriveClient } from "./google-drive";
import { postgresTool, postgresEnvironment, runBackupTool, fileDigest, ensureNonempty } from "./backup-postgres";

export interface BackupRun { id: string; client_id: string; backup_type: "manual" | "automatic"; status: string; stage: string; error_message: string | null }

async function requireBackupOwner(clientId: string): Promise<void> {
  const { data, error } = await backupDatabase().from("clients").select("is_admin,is_active").eq("id", clientId).maybeSingle();
  if (error || !data?.is_admin || !data.is_active) throw new BackupError("Proprietário da configuração não é um administrador ativo. Backup bloqueado.");
}

export async function enqueueBackup(clientId: string, type: "manual" | "automatic"): Promise<string> {
  await requireBackupOwner(clientId);
  const config = await loadBackupConfig(clientId);
  if (!config?.google_drive_folder_id) throw new BackupError("Conecte Google Drive primeiro.");
  await backupCredentials(config);
  const db = backupDatabase();
  const { data, error } = await db.from("backup_runs").insert({ client_id: clientId, backup_type: type }).select("id").single();
  if (error?.code === "23505") throw new BackupError("Já existe um backup aguardando ou em execução. Aguarde o término.");
  if (error || !data) throw new BackupError("Não foi possível agendar. Verifique a migration 020_backup_security_runs.sql.");
  return data.id as string;
}

async function event(run: BackupRun, message: string, level = "info"): Promise<void> {
  const { error } = await backupDatabase().from("backup_events").insert({ run_id: run.id, message, level });
  if (error) throw new BackupError("Não foi possível persistir o progresso do backup.");
}

async function stage(run: BackupRun, worker: string, name: string, message: string): Promise<void> {
  const { data, error } = await backupDatabase().from("backup_runs").update({ stage: name, heartbeat_at: new Date().toISOString() })
    .eq("id", run.id).eq("worker_id", worker).eq("status", "running").select("id").single();
  if (error || !data) throw new BackupError("Execução perdeu sua autorização de processamento.");
  await event(run, message);
}

const RECOVERY = `BACKUP DO BANCO POSTGRESQL/SUPABASE
Este pacote contém database.dump (pg_restore), globals.sql (roles sem senhas), manifest.json (SHA-256).
Não contém Storage físico, configuração Docker/Easypanel, .env, senhas de roles nem arquivos/serviços externos.
Novas tabelas/schemas entram automaticamente no snapshot seguinte. Snapshot não equivale a perda zero.
Restaure somente em destino novo/separado e versão PostgreSQL/Supabase compatível, nunca no banco em uso.
Use o script scripts/restore-backup.mjs do projeto para validar os hashes e gerar os comandos de recuperação.
Recrie as roles ausentes de globals.sql após revisar (roles padrão Supabase já existem); mantenha ACLs/ownership.
Guarde BACKUP_TOKEN_KEY e secrets da infraestrutura fora da VPS. O histórico no banco não é necessário para baixar este pacote.
`;

export async function executeBackupRun(run: BackupRun, worker: string): Promise<void> {
  let directory: string | undefined;
  let heartbeatError = false;
  const db = backupDatabase();
  const heartbeat = setInterval(() => {
    void db.from("backup_runs").update({ heartbeat_at: new Date().toISOString() }).eq("id", run.id).eq("worker_id", worker).eq("status", "running")
      .then(({ error }) => { if (error) heartbeatError = true; });
  }, 15_000);
  try {
    await requireBackupOwner(run.client_id);
    const config = await loadBackupConfig(run.client_id);
    if (!config?.google_drive_folder_id) throw new BackupError("Pasta Google Drive não configurada.");
    const drive = new GoogleDriveClient(await backupCredentials(config));
    if (!process.env.DATABASE_URL) throw new BackupError("DATABASE_URL do PostgreSQL remoto não configurada.");
    const env = postgresEnvironment(process.env.DATABASE_URL);
    await stage(run, worker, "preflight", "Verificando ferramentas e conexão com PostgreSQL remoto.");
    const dumpTool = await postgresTool("pg_dump");
    const globalsTool = await postgresTool("pg_dumpall");
    const restoreTool = await postgresTool("pg_restore");
    const psql = await postgresTool("psql");
    const version = (await runBackupTool(dumpTool, ["--version"], env)).trim();
    const server = (await runBackupTool(psql, ["-X", "-w", "-At", "-v", "ON_ERROR_STOP=1", "-c", "SHOW server_version_num"], env)).trim();
    const clientMajor = Number(version.match(/(\d+)\./)?.[1]);
    const serverMajor = Math.floor(Number(server) / 10000);
    if (!serverMajor || !clientMajor || clientMajor < serverMajor) throw new BackupError("Cliente pg_dump incompatível com a versão do servidor.");
    directory = await mkdtemp(join(tmpdir(), "salomao-backup-"));
    const databaseFile = join(directory, "database.dump");
    const globalsFile = join(directory, "globals.sql");
    await stage(run, worker, "dump", "Exportando todos os schemas, tabelas, dados, permissões e funções do snapshot.");
    await runBackupTool(dumpTool, ["-w", "--format=custom", "--verbose", "--file", databaseFile], env, message => event(run, message));
    await ensureNonempty(databaseFile);
    await stage(run, worker, "roles", "Exportando roles e configurações globais, sem senhas de usuários.");
    await runBackupTool(globalsTool, ["-w", "--globals-only", "--no-role-passwords", "--file", globalsFile], env);
    await ensureNonempty(globalsFile);
    await stage(run, worker, "verify", "Validando estrutura do arquivo e calculando checksums SHA-256.");
    const inventory = await runBackupTool(restoreTool, ["--list", databaseFile], env);
    if (!inventory.includes("TABLE")) throw new BackupError("Exportação sem tabelas. Upload cancelado.");
    const manifest = {
      format: "salomao-db-v1", id: run.id, createdAt: new Date().toISOString(), postgresServerMajor: serverMajor, dumpClient: version,
      includes: ["all database schemas", "data", "functions", "triggers", "RLS", "ownership", "ACL", "roles without passwords"],
      excludes: ["Storage files", "VPS volumes", "environment secrets", "role passwords", "external services"],
      files: { "database.dump": await fileDigest(databaseFile), "globals.sql": await fileDigest(globalsFile) },
      restorationTested: false,
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await writeFile(join(directory, "RECUPERACAO.txt"), RECOVERY, { mode: 0o600 });
    const name = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${run.id}.tar.gz`;
    const archive = join(directory, name);
    await runBackupTool("tar", ["-czf", archive, "-C", directory, "database.dump", "globals.sql", "manifest.json", "RECUPERACAO.txt"], process.env);
    const size = await ensureNonempty(archive);
    const md5 = await fileDigest(archive, "md5");
    await stage(run, worker, "folder", "Preparando pastas ano/mês/dia no Google Drive.");
    const folder = await drive.getBackupFolderStructure(config.google_drive_folder_id);
    await stage(run, worker, "upload", `Enviando pacote íntegro (${size} bytes) para Google Drive.`);
    const uploaded = await drive.uploadFile(name, archive, folder, { backupSystem: "salomao-db-v1", root: config.google_drive_folder_id, runId: run.id, sha256: await fileDigest(archive) });
    if (Number(uploaded.size) !== size || uploaded.md5Checksum !== md5) throw new BackupError("Checksum/tamanho no Drive diferente do pacote local; backup não confirmado.");
    if (heartbeatError) throw new BackupError("Conexão com histórico perdida durante o backup. Pacote pode existir no Drive; exclusão automática não executada.");
    await stage(run, worker, "uploaded", "Upload confirmado por checksum. Restauração em banco separado ainda não testada.");
    const now = new Date();
    const { error: historyError } = await db.from("backup_history").insert({ client_id: run.client_id, run_id: run.id, drive_file_id: uploaded.id,
      drive_file_name: name, file_size_bytes: size, backup_type: run.backup_type, status: "success", started_at: manifest.createdAt, completed_at: now.toISOString() });
    if (historyError) throw new BackupError("Pacote enviado, mas histórico não foi salvo. Retenção não executada.");
    const { error: configError } = await db.from("backup_config").update({ last_backup_at: now.toISOString(), last_backup_size_bytes: size,
      last_backup_status: "success", last_backup_error: null, next_backup_at: new Date(now.getTime() + config.interval_hours * 3600000).toISOString() }).eq("id", config.id);
    if (configError) throw new BackupError("Pacote enviado, mas agenda não foi atualizada. Retenção não executada.");
    // Retenção só após cópia nova validada, apenas artefatos próprios; nunca a última cópia.
    await stage(run, worker, "retention", "Verificando retenção de cópias antigas do próprio sistema.");
    const cutoff = now.getTime() - config.retention_days * 86400000;
    const files = await drive.listBackups(config.google_drive_folder_id);
    for (const file of files) {
      if (!file.id || file.id === uploaded.id || !file.createdTime || Date.parse(file.createdTime) >= cutoff || !file.md5Checksum || !file.appProperties?.sha256) continue;
      try {
        await drive.deleteBackup(file.id, config.google_drive_folder_id);
        const { error } = await db.from("backup_history").update({ status: "deleted" }).eq("client_id", run.client_id).eq("drive_file_id", file.id);
        if (error) throw new BackupError("Cópia excluída, mas histórico da retenção não atualizado.");
        await event(run, "Cópia vencida do sistema removida; nova cópia preservada.");
      } catch (error) { await event(run, safeBackupError(error), "warning"); }
    }
    await event(run, "Backup salvo e conferido no Drive. Não equivale a recuperação da VPS inteira nem a restauração já comprovada.");
    const { error } = await db.from("backup_runs").update({ status: "success", stage: "completed", completed_at: new Date().toISOString() }).eq("id", run.id).eq("worker_id", worker);
    if (error) throw new BackupError("Não foi possível registrar término da execução.");
  } catch (error) {
    const message = safeBackupError(error);
    await db.from("backup_events").insert({ run_id: run.id, message, level: "error" });
    await db.from("backup_runs").update({ status: "failed", stage: "failed", error_message: message, completed_at: new Date().toISOString() }).eq("id", run.id).eq("worker_id", worker);
    await db.from("backup_config").update({ last_backup_status: "failed", last_backup_error: message, next_backup_at: new Date(Date.now() + 3600000).toISOString() }).eq("client_id", run.client_id);
    console.error("[BACKUP]", message);
  } finally {
    clearInterval(heartbeat);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function processNextBackup(): Promise<void> {
  const worker = randomUUID();
  const { data, error } = await backupDatabase().rpc("claim_backup_run", { p_worker: worker });
  if (error) throw new BackupError("Worker não conseguiu obter execução. Verifique migration 020_backup_security_runs.sql.");
  const run = (data as BackupRun[] | null)?.[0];
  if (run) await executeBackupRun(run, worker);
}
