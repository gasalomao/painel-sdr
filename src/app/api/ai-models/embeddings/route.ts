import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import { requireClientId } from "@/lib/tenant";
import { listAvailableOpenRouterEmbeddingModels } from "@/lib/openrouter-model-discovery";
import { formatModelRef } from "@/lib/ai-provider";

export const dynamic = "force-dynamic";

const adminClient = supabaseAdmin || supabase;

type EmbedModel = {
  id: string;          // valor STORABLE (bare = Gemini; "openrouter:..." = OpenRouter)
  rawId: string;
  name: string;
  provider: "gemini" | "openrouter";
};

/** Modelos Gemini que suportam embedContent (embeddings). */
async function listGeminiEmbeddingModels(apiKey: string): Promise<EmbedModel[]> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(12000),
    });
    const json = await res.json();
    if (!res.ok || !Array.isArray(json?.models)) return [];
    return json.models
      .filter((m: any) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("embedContent"))
      .map((m: any) => {
        const rawId = String(m.name).replace("models/", "");
        return { id: rawId, rawId, name: m.displayName || rawId, provider: "gemini" as const };
      });
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { data: cfg } = await adminClient
      .from("ai_organizer_config")
      .select("api_key, openrouter_api_key")
      .eq("id", 1)
      .maybeSingle();
    const geminiKey = cfg?.api_key && String(cfg.api_key).trim() ? String(cfg.api_key).trim() : null;
    const openrouterKey = (cfg as any)?.openrouter_api_key && String((cfg as any).openrouter_api_key).trim()
      ? String((cfg as any).openrouter_api_key).trim() : null;

    if (!geminiKey && !openrouterKey) {
      return NextResponse.json({ success: false, error: "Nenhuma API Key configurada.", models: [] });
    }

    const [gemini, openrouter] = await Promise.all([
      geminiKey ? listGeminiEmbeddingModels(geminiKey) : Promise.resolve([] as EmbedModel[]),
      openrouterKey
        ? listAvailableOpenRouterEmbeddingModels().then((list) =>
            list.map((m): EmbedModel => ({
              id: formatModelRef("openrouter", m.id),
              rawId: m.id,
              name: m.name,
              provider: "openrouter",
            }))
          )
        : Promise.resolve([] as EmbedModel[]),
    ]);

    return NextResponse.json({ success: true, models: [...gemini, ...openrouter] });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message, models: [] }, { status: 500 });
  }
}
