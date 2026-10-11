// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn() }));
vi.mock("../backup-access", async (original) => {
  const actual = await original<typeof import("../backup-access")>();
  return { ...actual, backupDatabase: () => ({ from: () => ({ update: state.update, select: state.select }) }) };
});
vi.mock("@/lib/tenant", () => ({ requireClientId: vi.fn() }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: null }));
import { backupCredentials, encryptBackupTokens, loadBackupConfig, publicBackupConfig, type BackupConfigRow } from "../backup-config";
const row: BackupConfigRow = { id: 1, client_id: "test", enabled: true, interval_hours: 24, retention_days: 7, encrypted_tokens: null, google_access_token: "test-access", google_refresh_token: "test-refresh", google_token_expiry: "2026-10-11T00:00:00Z", google_drive_folder_id: null, last_backup_at: null, last_backup_status: null, last_backup_error: null, next_backup_at: null };
beforeEach(() => {
  vi.stubEnv("BACKUP_TOKEN_KEY", "ab".repeat(32));
  state.update.mockReturnValue({ eq: state.eq });
  state.select.mockReturnValue({ eq: () => ({ maybeSingle: state.single }) });
  state.eq.mockResolvedValue({ error: null });
  state.single.mockResolvedValue({ data: row, error: null });
});
afterEach(() => vi.unstubAllEnvs());
describe("backup token protection", () => {
  it("encrypts with distinct nonces and round trips authenticated tokens", async () => {
    const tokens = { accessToken: "test-access", refreshToken: "test-refresh", expiryDate: 123 };
    const encrypted = encryptBackupTokens(tokens);
    expect(encrypted).not.toContain(tokens.accessToken);
    expect(encryptBackupTokens(tokens)).not.toBe(encrypted);
    expect(await backupCredentials({ ...row, encrypted_tokens: encrypted })).toEqual(tokens);
  });
  it.each([undefined, "short", "z".repeat(64)])("rejects invalid encryption key %s", (key) => {
    vi.stubEnv("BACKUP_TOKEN_KEY", key);
    expect(() => encryptBackupTokens({ accessToken: "a", refreshToken: "b" })).toThrow("BACKUP_TOKEN_KEY");
  });
  it("rejects tampering, malformed ciphertext and invalid token shape", async () => {
    const encrypted = encryptBackupTokens({ accessToken: "a", refreshToken: "b" });
    const parts = encrypted.split(".");
    const tag = Buffer.from(parts[1], "base64"); tag[0] ^= 1;
    await expect(backupCredentials({ ...row, encrypted_tokens: [parts[0], tag.toString("base64"), parts[2]].join(".") })).rejects.toThrow();
    await expect(backupCredentials({ ...row, encrypted_tokens: "bad" })).rejects.toThrow("inválida");
    await expect(backupCredentials({ ...row, encrypted_tokens: encryptBackupTokens({ accessToken: 1, refreshToken: "b" } as never) })).rejects.toThrow("inválida");
  });
  it("migrates legacy tokens and clears plaintext only after confirmed persistence", async () => {
    expect(await backupCredentials(row)).toEqual({ accessToken: "test-access", refreshToken: "test-refresh", expiryDate: Date.parse(row.google_token_expiry!) });
    expect(state.update).toHaveBeenCalledWith({ encrypted_tokens: expect.any(String), google_access_token: null, google_refresh_token: null });
    expect(state.eq).toHaveBeenCalledWith("id", row.id);
    expect(row.google_access_token).toBe("test-access");
    state.eq.mockResolvedValue({ error: { message: "offline" } });
    await expect(backupCredentials({ ...row, google_token_expiry: null })).rejects.toThrow("proteger");
  });
  it("requires both legacy tokens", async () => {
    await expect(backupCredentials({ ...row, google_access_token: null })).rejects.toThrow("Conecte");
    await expect(backupCredentials({ ...row, google_refresh_token: null })).rejects.toThrow("Conecte");
  });
  it("loads configuration and propagates database failure", async () => {
    expect(await loadBackupConfig("test")).toEqual(row);
    state.single.mockResolvedValue({ data: null, error: null });
    expect(await loadBackupConfig("test")).toBeNull();
    state.single.mockResolvedValue({ data: null, error: { message: "private" } });
    await expect(loadBackupConfig("test")).rejects.toThrow("migration");
  });
  it("publishes only safe fields with defaults and redacts legacy error text", () => {
    expect(publicBackupConfig(null)).toMatchObject({ enabled: false, interval_hours: 24, retention_days: 7, connected: false, last_backup_error: null });
    const exposed = publicBackupConfig({ ...row, last_backup_status: "failed", last_backup_error: "private-secret", google_drive_folder_id: "folder", last_backup_at: "today", next_backup_at: "tomorrow" });
    expect(exposed).toMatchObject({ connected: true, google_drive_folder_id: "folder", last_backup_at: "today", next_backup_at: "tomorrow" });
    expect(JSON.stringify(exposed)).not.toMatch(/private-secret|test-access|test-refresh/);
    expect(publicBackupConfig({ ...row, google_access_token: null, encrypted_tokens: "cipher" }).connected).toBe(true);
    expect(publicBackupConfig({ ...row, google_refresh_token: null }).connected).toBe(false);
  });
});
