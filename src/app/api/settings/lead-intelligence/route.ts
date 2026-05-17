/**
 * GET  /api/settings/lead-intelligence  → { model, models: [...] }
 *   Retorna o modelo configurado + lista real-time de modelos Gemini disponíveis.
 *
 * PATCH /api/settings/lead-intelligence  → { model } → salva
 *   Persiste o modelo escolhido em app_settings.lead_intelligence_model.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const KEY = "lead_intelligence_model";
const DEFAULT_MODEL = "gemini-2.5-flash";

async function listGeminiModels(): Promise<Array<{ id: string; name: string; description?: string }>> {
  // Lê API key central (mesma que /api/ai-models usa).
  const { data: cfg } = await supabaseAdmin
    .from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
  if (!cfg?.api_key) return [];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cfg.api_key}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || [])
      .filter((m: any) =>
        m.name?.includes("gemini") &&
        m.supportedGenerationMethods?.includes("generateContent"))
      .map((m: any) => ({
        id: m.name.replace("models/", ""),
        name: m.displayName || m.name,
        description: m.description,
      }));
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const [{ data: cur }, models] = await Promise.all([
      supabaseAdmin.from("app_settings").select("value").eq("key", KEY).maybeSingle(),
      listGeminiModels(),
    ]);
    return NextResponse.json({
      success: true,
      model: cur?.value || DEFAULT_MODEL,
      models,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    if (!ctx.isAdmin) {
      return NextResponse.json(
        { success: false, error: "Apenas admin pode alterar o modelo de IA." },
        { status: 403 }
      );
    }
    const body = await req.json().catch(() => ({}));
    const model = String(body.model || "").trim();
    if (!model) {
      return NextResponse.json({ success: false, error: "model vazio" }, { status: 400 });
    }
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: KEY, value: model, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return NextResponse.json({ success: true, model });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
