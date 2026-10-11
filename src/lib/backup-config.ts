import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { backupDatabase, BackupError } from "./backup-access";
import type { GoogleDriveConfig } from "./google-drive";

export interface BackupConfigRow {
  id: number; client_id: string; enabled: boolean; interval_hours: number; retention_days: number;
  encrypted_tokens: string | null; google_access_token: string | null; google_refresh_token: string | null;
  google_token_expiry: string | null; google_drive_folder_id: string | null;
  last_backup_at: string | null; last_backup_status: string | null; last_backup_error: string | null; next_backup_at: string | null;
}

function encryptionKey(): Buffer {
  const value = process.env.BACKUP_TOKEN_KEY;
  if (!value || !/^[a-f\d]{64}$/i.test(value)) throw new BackupError("Configure BACKUP_TOKEN_KEY com 64 caracteres hexadecimais no servidor e guarde uma cópia fora da VPS.");
  return Buffer.from(value, "hex");
}

export function encryptBackupTokens(tokens: GoogleDriveConfig): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), body].map(part => part.toString("base64")).join(".");
}

export async function backupCredentials(config: BackupConfigRow): Promise<GoogleDriveConfig> {
  if (!config.encrypted_tokens) {
    if (!config.google_access_token || !config.google_refresh_token) throw new BackupError("Conecte o Google Drive antes de criar backups.");
    const tokens = { accessToken: config.google_access_token, refreshToken: config.google_refresh_token, expiryDate: config.google_token_expiry ? Date.parse(config.google_token_expiry) : undefined };
    const { error } = await backupDatabase().from("backup_config").update({ encrypted_tokens: encryptBackupTokens(tokens), google_access_token: null, google_refresh_token: null }).eq("id", config.id);
    if (error) throw new BackupError("Não foi possível proteger a autorização do Google Drive.");
    return tokens;
  }
  const [nonce, tag, body] = config.encrypted_tokens.split(".").map(part => Buffer.from(part, "base64"));
  if (!nonce || !tag || !body) throw new BackupError("Autorização armazenada inválida. Reconecte Google Drive.");
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAuthTag(tag);
  const tokens = JSON.parse(Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8")) as GoogleDriveConfig;
  if (typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string") throw new BackupError("Autorização armazenada inválida.");
  return tokens;
}

export async function loadBackupConfig(clientId: string): Promise<BackupConfigRow | null> {
  const { data, error } = await backupDatabase().from("backup_config").select("*").eq("client_id", clientId).maybeSingle();
  if (error) throw new BackupError("Não foi possível ler a configuração. Verifique a migration 020_backup_security_runs.sql.");
  return data as BackupConfigRow | null;
}

export function publicBackupConfig(row: BackupConfigRow | null) {
  return {
    enabled: row?.enabled ?? false, interval_hours: row?.interval_hours ?? 24, retention_days: row?.retention_days ?? 7,
    connected: Boolean(row?.encrypted_tokens || (row?.google_access_token && row?.google_refresh_token)),
    google_drive_folder_id: row?.google_drive_folder_id ?? null, last_backup_at: row?.last_backup_at ?? null,
    last_backup_status: row?.last_backup_status ?? null,
    // Mensagens legadas incluíam senhas. Somente erros novos/genéricos são exibidos.
    last_backup_error: row?.last_backup_status === "failed" ? "Último backup falhou. Consulte os eventos da execução ou teste a conexão." : null,
    next_backup_at: row?.next_backup_at ?? null,
  };
}
