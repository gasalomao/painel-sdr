import { NextRequest, NextResponse } from "next/server";
import { requireBackupAdmin } from "@/lib/backup-access";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireBackupAdmin(req);
  if (!ctx.ok) return ctx.response;
  return NextResponse.json({ success: false, error: "Restauração sobre o banco em uso foi bloqueada para evitar perda de dados. Baixe o pacote e valide a recuperação em um Supabase separado." }, { status: 409 });
}
