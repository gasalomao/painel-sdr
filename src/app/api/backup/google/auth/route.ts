import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin, safeBackupError } from "@/lib/backup-access";
import { GoogleDriveClient } from "@/lib/google-drive";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  if (req.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ success: false, error: "Origem inválida." }, { status: 403 });
  try {
    const state = randomBytes(32).toString("hex");
    const response = NextResponse.json({ success: true, authUrl: new GoogleDriveClient().getAuthUrl(state) });
    response.cookies.set("backup_oauth_state", `${ctx.claims.sessionId}:${state}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 600, path: "/api/backup/google" });
    return response;
  } catch (error) { return NextResponse.json({ success: false, error: safeBackupError(error) }, { status: 500 }); }
}
