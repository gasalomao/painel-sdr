/**
 * Lista modelos OpenRouter que aceitam ÁUDIO como entrada, GRÁTIS primeiro.
 * Usado pela aba Ajustes → Transcrição de áudio (método OpenRouter).
 */

import type { NextRequest } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { listOpenRouterAudioModels, isFreePricing } from "@/lib/openrouter-model-discovery";

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  try {
    const models = await listOpenRouterAudioModels();
    return Response.json({
      success: true,
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        free: isFreePricing(m.pricing),
      })),
    });
  } catch (err: any) {
    return Response.json(
      { success: false, error: err?.message || "Falha ao listar modelos OpenRouter." },
      { status: 500 },
    );
  }
}
