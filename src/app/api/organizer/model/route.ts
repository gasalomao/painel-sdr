import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { providerDisplayName, providerOf } from "@/lib/ai-provider";
import { invalidateOrganizerConfigCache } from "@/lib/organizer-config-cache";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/model { model }
 *
 * Troca o modelo de IA usado nas execuções automáticas e manuais do
 * Organizador (tabela global ai_organizer_config, id=1) e sincroniza
 * automaticamente o campo `provider`.
 * Restrito ao admin — afeta todos os clientes que usam o Organizador.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!ctx.isAdmin) {
    return NextResponse.json({ ok: false, error: "Apenas admin pode alterar o modelo" }, { status: 403 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    return NextResponse.json({ ok: false, error: "model é obrigatório" }, { status: 400 });
  }

  const provider = providerDisplayName(providerOf(model));

  const { error } = await supabaseAdmin
    .from("ai_organizer_config")
    .update({ model, provider, updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  invalidateOrganizerConfigCache();
  return NextResponse.json({ ok: true, model, provider });
}
