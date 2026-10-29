import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { listAvailableOpenRouterEmbeddingModels } from "@/lib/openrouter-model-discovery";
import { formatModelRef } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";

export const dynamic = "force-dynamic";

type EmbedModel = {
  id: string;          // valor STORABLE (bare = Gemini; "openrouter:..." = OpenRouter; "nvidia:..." = NVIDIA)
  rawId: string;
  name: string;
  provider: "gemini" | "openrouter" | "nvidia";
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

/** Modelos NVIDIA NIM de embeddings. */
async function listNvidiaEmbeddingModels(apiKey: string): Promise<EmbedModel[]> {
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    if (!res.ok || !Array.isArray(json?.data)) return [];
    return json.data
      .filter((m: any) => /embed/i.test(String(m?.id || "")))
      .map((m: any) => {
        const rawId = String(m.id);
        return {
          id: formatModelRef("nvidia", rawId),
          rawId,
          name: `${rawId} (NVIDIA NIM)`,
          provider: "nvidia" as const,
        };
      });
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const keys = await getAiKeys();
    const geminiKey = keys.gemini;
    const openrouterKey = keys.openrouter;
    const nvidiaKey = keys.nvidia;

    if (!geminiKey && !openrouterKey && !nvidiaKey) {
      return NextResponse.json({ success: false, error: "Nenhuma API Key configurada.", models: [] });
    }

    const [gemini, openrouter, nvidia] = await Promise.all([
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
      nvidiaKey ? listNvidiaEmbeddingModels(nvidiaKey) : Promise.resolve([] as EmbedModel[]),
    ]);

    return NextResponse.json({ success: true, models: [...nvidia, ...gemini, ...openrouter] });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message, models: [] }, { status: 500 });
  }
}
