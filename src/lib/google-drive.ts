import { google, type drive_v3 } from "googleapis";
import { createReadStream } from "node:fs";
import { BackupError } from "./backup-access";

export interface GoogleDriveConfig { accessToken: string; refreshToken: string; expiryDate?: number }

export class GoogleDriveClient {
  private readonly oauth;
  private readonly drive;

  constructor(config?: GoogleDriveConfig) {
    this.oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || `${process.env.NEXT_PUBLIC_APP_URL}/api/backup/google/callback`);
    if (config) this.setCredentials(config);
    this.drive = google.drive({ version: "v3", auth: this.oauth });
  }

  getAuthUrl(state: string): string {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new BackupError("Credenciais OAuth do Google não configuradas.");
    return this.oauth.generateAuthUrl({ access_type: "offline", scope: ["https://www.googleapis.com/auth/drive.file"], prompt: "consent", state });
  }

  async getTokensFromCode(code: string): Promise<GoogleDriveConfig> {
    const { tokens } = await this.oauth.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token) throw new BackupError("Google não forneceu autorização offline. Reconecte a conta.");
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiryDate: tokens.expiry_date ?? undefined };
  }

  setCredentials(config: GoogleDriveConfig): void {
    this.oauth.setCredentials({ access_token: config.accessToken, refresh_token: config.refreshToken, expiry_date: config.expiryDate });
  }

  async getOrCreateFolder(name: string, parentId?: string): Promise<string> {
    const escape = (value: string): string => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `mimeType='application/vnd.google-apps.folder' and name='${escape(name)}' and trashed=false` + (parentId ? ` and '${escape(parentId)}' in parents` : " and 'root' in parents");
    const listed = await this.drive.files.list({ q, fields: "files(id)", pageSize: 100 });
    const existing = listed.data.files?.[0]?.id;
    if (existing) return existing;
    const result = await this.drive.files.create({ requestBody: { name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) }, fields: "id" });
    if (!result.data.id) throw new BackupError("Google Drive não confirmou a criação da pasta.");
    return result.data.id;
  }

  async getBackupFolderStructure(root: string, date = new Date()): Promise<string> {
    const year = await this.getOrCreateFolder(String(date.getUTCFullYear()), root);
    const month = await this.getOrCreateFolder(String(date.getUTCMonth() + 1).padStart(2, "0"), year);
    return this.getOrCreateFolder(String(date.getUTCDate()).padStart(2, "0"), month);
  }

  async uploadFile(name: string, path: string, folderId: string, properties: Record<string, string>): Promise<drive_v3.Schema$File> {
    const result = await this.drive.files.create({ requestBody: { name, parents: [folderId], appProperties: properties },
      media: { mimeType: "application/gzip", body: createReadStream(path) }, fields: "id,size,md5Checksum,appProperties,parents" });
    if (!result.data.id || !result.data.md5Checksum) throw new BackupError("Drive não confirmou integridade do arquivo enviado.");
    return result.data;
  }

  async listBackups(root: string): Promise<drive_v3.Schema$File[]> {
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const result = await this.drive.files.list({ q: "trashed=false and appProperties has { key='backupSystem' and value='salomao-db-v1' }",
        fields: "nextPageToken,files(id,name,size,createdTime,appProperties,md5Checksum,parents)", pageSize: 100, pageToken });
      files.push(...(result.data.files || []).filter(file => file.appProperties?.root === root));
      pageToken = result.data.nextPageToken || undefined;
    } while (pageToken);
    return files;
  }

  async deleteBackup(id: string, root: string): Promise<void> {
    const result = await this.drive.files.get({ fileId: id, fields: "id,appProperties,parents" });
    if (result.data.appProperties?.root !== root || result.data.appProperties?.backupSystem !== "salomao-db-v1") throw new BackupError("Arquivo não pertence ao conjunto de backups autorizado.");
    let parent = result.data.parents?.[0];
    for (let depth = 0; parent && parent !== root && depth < 10; depth++) {
      const folder = await this.drive.files.get({ fileId: parent, fields: "parents,trashed" });
      if (folder.data.trashed) throw new BackupError("Pasta de backup movida para lixeira. Exclusão cancelada.");
      parent = folder.data.parents?.[0];
    }
    if (parent !== root) throw new BackupError("Backup foi movido para fora da pasta configurada. Exclusão cancelada.");
    await this.drive.files.delete({ fileId: id });
  }
}
