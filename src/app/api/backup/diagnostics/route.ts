import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin, safeBackupError, BackupError } from "@/lib/backup-access";
import { postgresTool, postgresEnvironment, runBackupTool } from "@/lib/backup-postgres";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  try {
    const tools = await Promise.all(["pg_dump", "pg_dumpall", "pg_restore", "psql"].map(async name => {
      const tool = await postgresTool(name as "pg_dump" | "pg_dumpall" | "pg_restore" | "psql");
      return { name, version: (await runBackupTool(tool, ["--version"], process.env)).trim() };
    }));
    if (!process.env.DATABASE_URL) throw new BackupError("DATABASE_URL remoto não configurado.");
    const env = postgresEnvironment(process.env.DATABASE_URL);
    const version = (await runBackupTool(await postgresTool("psql"), ["-X", "-w", "-At", "-v", "ON_ERROR_STOP=1", "-c", "SHOW server_version_num"], env)).trim();
    return NextResponse.json({ success: true, tools, serverVersion: version,
      message: "Ferramentas e conexão confirmadas. Isso ainda não comprova backup/upload ou recuperação." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ success: false, error: safeBackupError(error) }, { status: 503 }); }
}
