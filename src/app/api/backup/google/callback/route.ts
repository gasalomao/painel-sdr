import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin, backupDatabase } from "@/lib/backup-access";
import { encryptBackupTokens } from "@/lib/backup-config";
import { GoogleDriveClient } from "@/lib/google-drive";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  const finish = (result: string): NextResponse => {
    const url = new URL("/admin/backup", process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin);
    url.searchParams.set("oauth", result);
    const response = NextResponse.redirect(url);
    response.cookies.set("backup_oauth_state", "", { maxAge: 0, httpOnly: true, path: "/api/backup/google" });
    return response;
  };
  const state = req.nextUrl.searchParams.get("state") || "";
  const expected = Buffer.from(req.cookies.get("backup_oauth_state")?.value || "");
  const actual = Buffer.from(`${ctx.claims.sessionId}:${state}`);
  if (!state || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return finish("invalid_state");
  const code = req.nextUrl.searchParams.get("code");
  if (!code || req.nextUrl.searchParams.has("error")) return finish("cancelled");
  try {
    const drive = new GoogleDriveClient();
    const tokens = await drive.getTokensFromCode(code);
    const encrypted = encryptBackupTokens(tokens);
    drive.setCredentials(tokens);
    const folder = await drive.getOrCreateFolder("Backups Painel SDR");
    const { error } = await backupDatabase().from("backup_config").upsert({ client_id: ctx.clientId, encrypted_tokens: encrypted,
      google_access_token: null, google_refresh_token: null, google_drive_folder_id: folder,
      google_token_expiry: tokens.expiryDate ? new Date(tokens.expiryDate).toISOString() : null, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
    return finish(error ? "save_failed" : "connected");
  } catch { return finish("configuration_failed"); }
}
