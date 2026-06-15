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
import { listAvailableOpenRouterModels } from "@/lib/openrouter-model-discovery";
import { formatModelRef } from "@/lib/ai-provider";

export const dynamic = "force-dynamic";

const KEY = "lead_intelligence_model";
// SEM DEFAULT hardcoded — se admin não escolheu modelo ainda, retorna vazio
// e a UI mostra que precisa escolher. Antes assumia gemini-2.5-flash, mas
// isso ficava preso na versão antiga quando o admin não trocava.
const DEFAULT_MODEL = "";

type ModelOpt = { id: string; rawId: string; name: string; description?: string; provider: "gemini" | "openrouter"; supportsTools: boolean };

// Lista unificada Gemini + OpenRouter (mesma fonte do /api/ai-models).
async function listAllModels(): Promise<ModelOpt[]> {
  const { data: cfg } = await supabaseAdmin
    .from("ai_organizer_config").select("api_key, openrouter_api_key").eq("id", 1).maybeSingle();
  const geminiKey = cfg?.api_key && String(cfg.api_key).trim() ? String(cfg.api_key).trim() : null;
  const openrouterKey = (cfg as any)?.openrouter_api_key && String((cfg as any).openrouter_api_key).trim()
    ? String((cfg as any).openrouter_api_key).trim() : null;

  const geminiP: Promise<ModelOpt[]> = (async () => {
    if (!geminiKey) return [];
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return [];
      const j = await r.json();
      return (j.models || [])
        .filter((m: any) =>
          m.name?.includes("gemini") &&
          m.supportedGenerationMethods?.includes("generateContent"))
        .map((m: any) => {
          const rawId = m.name.replace("models/", "");
          return { id: rawId, rawId, name: m.displayName || m.name, description: m.description, provider: "gemini" as const, supportsTools: true };
        });
    } catch { return []; }
  })();

  const orP: Promise<ModelOpt[]> = openrouterKey
    ? listAvailableOpenRouterModels().then(list => list.map((m): ModelOpt => ({
        id: formatModelRef("openrouter", m.id), rawId: m.id, name: m.name, description: m.description,
        provider: "openrouter", supportsTools: m.supportsTools,
      })))
    : Promise.resolve([]);

  const [g, o] = await Promise.all([geminiP, orP]);
  return [...g, ...o];
}

export async function GET() {
  try {
    const [{ data: cur }, models] = await Promise.all([
      supabaseAdmin.from("app_settings").select("value").eq("key", KEY).maybeSingle(),
      listAllModels(),
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
