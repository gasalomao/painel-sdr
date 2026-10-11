import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin, safeBackupError } from "@/lib/backup-access";
import { enqueueBackup } from "@/lib/backup-service";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  if (process.env.BACKUP_WORKER_ENABLED !== "true") return NextResponse.json({ success: false, error: "Worker desativado. Configure BACKUP_WORKER_ENABLED=true no servidor." }, { status: 503 });
  try {
    const runId = await enqueueBackup(ctx.clientId, "manual");
    return NextResponse.json({ success: true, runId }, { status: 202 });
  } catch (error) { return NextResponse.json({ success: false, error: safeBackupError(error) }, { status: 409 }); }
}
