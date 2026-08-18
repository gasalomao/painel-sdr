import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import { requireClientId } from "@/lib/tenant";
import { sanitizeCombos, DEFAULT_AI_COMBOS, type AiCombo } from "@/lib/ai-combos";
import { invalidateAiKeysCache } from "@/lib/ai-keys";

const adminClient = supabaseAdmin || supabase;

/** GET: Retorna os combos salvos no sistema */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { data, error } = await adminClient
      .from("ai_organizer_config")
      .select("ai_combos")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      console.warn("[AI-COMBOS] Falha ao ler ai_combos:", error.message);
      return NextResponse.json({ success: true, combos: DEFAULT_AI_COMBOS });
    }

    const combos = sanitizeCombos(data?.ai_combos);
    return NextResponse.json({ success: true, combos });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Erro ao listar combos." }, { status: 500 });
  }
}

/** POST: Salva a lista completa de combos (apenas admin) */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    if (!auth.isAdmin) {
      return NextResponse.json({ success: false, error: "Apenas administradores podem configurar combos de IA." }, { status: 403 });
    }

    const body = await req.json();
    const combos = sanitizeCombos(body?.combos);

    const { error } = await adminClient
      .from("ai_organizer_config")
      .upsert({ id: 1, ai_combos: combos, updated_at: new Date().toISOString() });

    if (error) {
      console.error("[AI-COMBOS] Erro ao salvar combos:", error.message);
      const isMissingCol = /ai_combos|column .* does not exist/i.test(error.message || "");
      return NextResponse.json({
        success: false,
        error: isMissingCol
          ? "A coluna 'ai_combos' não existe no banco de dados. Execute a migration 'migrations/ADD_AI_COMBOS_COLUMN.sql' no SQL Editor do Supabase."
          : error.message,
      }, { status: 500 });
    }

    invalidateAiKeysCache();
    return NextResponse.json({ success: true, combos });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Erro ao salvar combos." }, { status: 500 });
  }
}
