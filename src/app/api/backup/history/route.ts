import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin, backupDatabase, safeBackupError } from "@/lib/backup-access";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  const limit = Number(req.nextUrl.searchParams.get("limit") || 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return NextResponse.json({ success: false, error: "Limite inválido." }, { status: 400 });
  try {
    const { data, error } = await backupDatabase().from("backup_history")
      .select("id,drive_file_id,drive_file_name,file_size_bytes,backup_type,status,started_at,completed_at,created_at")
      .eq("client_id", ctx.clientId).order("created_at", { ascending: false }).limit(limit);
    if (error) return NextResponse.json({ success: false, error: "Não foi possível consultar histórico." }, { status: 500 });
    return NextResponse.json({ success: true, backups: data || [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ success: false, error: safeBackupError(error) }, { status: 500 }); }
}
