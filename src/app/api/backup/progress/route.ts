import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin, backupDatabase } from "@/lib/backup-access";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  const id = req.nextUrl.searchParams.get("run_id") || "";
  const after = Number(req.nextUrl.searchParams.get("after") || 0);
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id) || !Number.isSafeInteger(after) || after < 0) return NextResponse.json({ success: false, error: "Execução/cursor inválidos." }, { status: 400 });
  const db = backupDatabase();
  const { data: run, error } = await db.from("backup_runs").select("id,status,stage,error_message,heartbeat_at").eq("id", id).eq("client_id", ctx.clientId).maybeSingle();
  if (error || !run) return NextResponse.json({ success: false, error: "Execução não encontrada." }, { status: 404 });
  const { data: events, error: logError } = await db.from("backup_events").select("id,message,level,created_at").eq("run_id", id).gt("id", after).order("id").limit(200);
  if (logError) return NextResponse.json({ success: false, error: "Progresso indisponível." }, { status: 503 });
  return NextResponse.json({ success: true, run, events }, { headers: { "Cache-Control": "no-store" } });
}
