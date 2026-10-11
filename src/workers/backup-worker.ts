import { backupDatabase, BackupError, safeBackupError } from "@/lib/backup-access";
import { enqueueBackup, processNextBackup } from "@/lib/backup-service";

let isRunning = false;

export async function runBackupWorker(): Promise<void> {
  if (isRunning || process.env.BACKUP_WORKER_ENABLED !== "true") return;
  isRunning = true;
  try {
    const db = backupDatabase();
    const { data: active, error: activeError } = await db.from("backup_runs").select("id,status").in("status", ["queued", "running"]).limit(1);
    if (activeError) throw new BackupError("Tabelas de execução indisponíveis; aplique migration 020 com aprovação.");
    if (!active?.length) {
      const { data, error } = await db.from("backup_config").select("client_id,last_backup_at,next_backup_at,interval_hours").eq("enabled", true);
      if (error) throw new BackupError("Não foi possível consultar a agenda de backup.");
      for (const config of data || []) {
        const due = config.next_backup_at ? Date.parse(config.next_backup_at) : config.last_backup_at ? Date.parse(config.last_backup_at) + config.interval_hours * 3600000 : 0;
        if (due <= Date.now()) { await enqueueBackup(config.client_id, "automatic"); break; }
      }
    }
    await processNextBackup();
  } catch (error) { console.error("[BACKUP WORKER]", safeBackupError(error)); }
  finally { isRunning = false; }
}
