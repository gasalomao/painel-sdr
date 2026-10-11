import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin, backupDatabase, safeBackupError } from "@/lib/backup-access";
import { loadBackupConfig, publicBackupConfig } from "@/lib/backup-config";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  try {
    const config = await loadBackupConfig(ctx.clientId);
    const { data, error } = await backupDatabase().from("backup_runs").select("id,status,stage,error_message").eq("client_id", ctx.clientId).in("status", ["queued", "running"]).limit(1);
    if (error) return NextResponse.json({ success: false, error: "Atualização do backup pendente: migration 020_backup_security_runs.sql." }, { status: 503 });
    return NextResponse.json({ success: true, config: publicBackupConfig(config), activeRun: data?.[0] || null, workerEnabled: process.env.BACKUP_WORKER_ENABLED === "true" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ success: false, error: safeBackupError(error) }, { status: 500 }); }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  try {
    const body = await req.json() as { enabled?: unknown; interval_hours?: unknown; retention_days?: unknown };
    const { enabled, interval_hours, retention_days } = body;
    if (typeof enabled !== "boolean" || typeof interval_hours !== "number" || !Number.isInteger(interval_hours) || interval_hours < 1 || interval_hours > 8760 || typeof retention_days !== "number" || !Number.isInteger(retention_days) || retention_days < 1 || retention_days > 3650) {
      return NextResponse.json({ success: false, error: "Informe intervalo de 1–8760 horas e retenção de 1–3650 dias." }, { status: 400 });
    }
    if (enabled && process.env.BACKUP_WORKER_ENABLED !== "true") return NextResponse.json({ success: false, error: "Habilite BACKUP_WORKER_ENABLED=true no servidor antes de ativar a agenda." }, { status: 409 });
    const current = await loadBackupConfig(ctx.clientId);
    if (enabled && !publicBackupConfig(current).connected) return NextResponse.json({ success: false, error: "Conecte Google Drive primeiro." }, { status: 409 });
    const { error } = await backupDatabase().from("backup_config").upsert({ client_id: ctx.clientId, enabled, interval_hours, retention_days,
      next_backup_at: enabled ? new Date(Date.now() + interval_hours * 3600000).toISOString() : null, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
    if (error) return NextResponse.json({ success: false, error: "Não foi possível salvar a configuração de backup." }, { status: 500 });
    return NextResponse.json({ success: true, config: publicBackupConfig(await loadBackupConfig(ctx.clientId)) });
  } catch (error) { return NextResponse.json({ success: false, error: safeBackupError(error) }, { status: 500 }); }
}
