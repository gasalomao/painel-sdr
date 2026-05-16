import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/organizer/global-toggle
 *
 * Liga/desliga o Organizador IA GLOBALMENTE (ai_organizer_config.enabled).
 * SOMENTE admin pode chamar — afeta TODOS os clientes do sistema.
 * Body: { enabled: boolean }
 */
export async function PATCH(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!ctx.isAdmin) {
    return NextResponse.json({ ok: false, error: "Apenas admin pode ligar/desligar globalmente" }, { status: 403 });
  }
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const { enabled } = await req.json().catch(() => ({}));
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "Campo `enabled` (boolean) obrigatório" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("ai_organizer_config")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, enabled });
}
