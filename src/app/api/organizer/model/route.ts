import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/organizer/model
 *
 * Atualiza o modelo de IA usado pelo Organizador GLOBALMENTE.
 * SOMENTE admin pode chamar — o modelo é compartilhado pra todos os clientes
 * (gasto de tokens centralizado, configuração única).
 *
 * Body: { model: string }
 *
 * O modelo é validado contra /api/ai-models (modelos em tempo real do Gemini).
 */
export async function PATCH(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!ctx.isAdmin) {
    return NextResponse.json({ ok: false, error: "Apenas admin pode alterar o modelo do Organizador" }, { status: 403 });
  }
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const { model } = await req.json().catch(() => ({}));
  if (!model || typeof model !== "string") {
    return NextResponse.json({ ok: false, error: "Campo `model` obrigatório" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("ai_organizer_config")
    .update({ model: model.trim(), updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, model });
}
