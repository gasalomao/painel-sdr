import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin } from "@/lib/backup-access";
import { BACKUP_DIAGNOSTICS_STORAGE_ERROR, listBackupDiagnostics, runBackupDiagnostics } from "@/lib/backup-diagnostics";

export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) {
    ctx.response.headers.set("Cache-Control", "no-store");
    return ctx.response;
  }
  try {
    const diagnostics = await listBackupDiagnostics(ctx.clientId);
    return NextResponse.json({ success: true, diagnostics }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ success: false, error: BACKUP_DIAGNOSTICS_STORAGE_ERROR }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) {
    ctx.response.headers.set("Cache-Control", "no-store");
    return ctx.response;
  }
  try {
    const diagnostic = await runBackupDiagnostics(ctx.clientId);
    return NextResponse.json({ success: true, diagnostic }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ success: false, error: BACKUP_DIAGNOSTICS_STORAGE_ERROR }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
