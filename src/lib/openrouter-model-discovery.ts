/**
 * Descoberta DINÂMICA de modelos OpenRouter — sem hardcode.
 *
 * Server-side. Consulta GET https://openrouter.ai/api/v1/models com a API key
 * salva em ai_organizer_config.openrouter_api_key e devolve a lista real do que
 * existe AGORA. Cacheia 10 min. Quando a OpenRouter adiciona um modelo novo, ele
 * aparece sozinho no seletor — igual à descoberta de modelos Gemini.
 */

import { supabase } from "@/lib/supabase";

export type OpenRouterModel = {
  id: string;            // ex: "anthropic/claude-3.5-sonnet"
  name: string;
  description?: string;
  contextLength?: number;
  /** true se o modelo suporta function/tool calling (usado pelo Agente SDR). */
  supportsTools: boolean;
  pricing?: { prompt?: string; completion?: string };
  /** Modalidades de entrada aceitas (ex: ["text","audio"]) — undefined se a API não informou. */
  inputModalities?: string[];
};

type Cache = { models: OpenRouterModel[]; at: number };
let CACHE: Cache | null = null;
const TTL_MS = 10 * 60 * 1000;

async function getKey(): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("ai_organizer_config")
      .select("openrouter_api_key")
      .eq("id", 1)
      .maybeSingle();
    const k = (data as any)?.openrouter_api_key;
    return k && String(k).trim() ? String(k).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Lista modelos OpenRouter que suportam chat (output text). Cache 10 min.
 * Retorna [] se a API key não estiver configurada ou a OpenRouter estiver fora.
 */
export async function listAvailableOpenRouterModels(force = false): Promise<OpenRouterModel[]> {
  if (!force && CACHE && Date.now() - CACHE.at < TTL_MS) return CACHE.models;

  const apiKey = await getKey();
  if (!apiKey) return CACHE?.models || [];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12000),
    });
    const json = await res.json();
    const list: any[] = Array.isArray(json?.data) ? json.data : [];
    if (!res.ok || !list.length) return CACHE?.models || [];

    const models: OpenRouterModel[] = list
      .filter((m: any) => {
        // Só modelos que produzem TEXTO (descarta image/embedding/etc).
        const out = m?.architecture?.output_modalities;
        if (Array.isArray(out) && out.length > 0) return out.includes("text");
        return true; // sem info de modalidade → assume texto
      })
      .map((m: any) => {
        const params: string[] = Array.isArray(m?.supported_parameters) ? m.supported_parameters : [];
        return {
          id: String(m.id),
          name: m.name || m.id,
          description: m.description,
          contextLength: m.context_length,
          supportsTools: params.includes("tools"),
          pricing: m.pricing ? { prompt: m.pricing.prompt, completion: m.pricing.completion } : undefined,
          inputModalities: Array.isArray(m?.architecture?.input_modalities)
            ? m.architecture.input_modalities.map(String)
            : undefined,
        };
      });

    CACHE = { models, at: Date.now() };
    return models;
  } catch (err) {
    console.warn("[openrouter-discovery] Falha ao listar modelos:", (err as any)?.message);
    return CACHE?.models || [];
  }
}

/** Invalida o cache — usar quando o admin trocar a API key. */
export function invalidateOpenRouterModelsCache() {
  CACHE = null;
  EMBED_CACHE = null;
}

// ============================================================================
// ÁUDIO — modelos multimodal que aceitam input de áudio (transcrição)
// ============================================================================

/** true se o preço do prompt é 0 (modelo :free). */
export function isFreePricing(pricing?: { prompt?: string }): boolean {
  const n = parseFloat(pricing?.prompt ?? "");
  return Number.isFinite(n) && n === 0;
}

/** true se o modelo aceita áudio como entrada (input_modalities contém "audio"). */
export function isOpenRouterAudioModel(m: OpenRouterModel): boolean {
  return Array.isArray(m.inputModalities) && m.inputModalities.includes("audio");
}

/** Ordena grátis primeiro, mantendo a ordem relativa dentro de cada grupo. */
export function sortAudioModelsFreeFirst(models: OpenRouterModel[]): OpenRouterModel[] {
  return [...models].sort((a, b) => {
    const fa = isFreePricing(a.pricing) ? 0 : 1;
    const fb = isFreePricing(b.pricing) ? 0 : 1;
    return fa - fb;
  });
}

/**
 * Lista modelos OpenRouter que ACEITAM ÁUDIO, grátis primeiro. Cache herdado
 * do listAvailableOpenRouterModels (10 min). Retorna [] se sem chave/offline.
 */
export async function listOpenRouterAudioModels(force = false): Promise<OpenRouterModel[]> {
  const all = await listAvailableOpenRouterModels(force);
  return sortAudioModelsFreeFirst(all.filter(isOpenRouterAudioModel));
}

// ============================================================================
// EMBEDDINGS — modelos de embedding do OpenRouter (pro RAG da base de conhecimento)
// ============================================================================

export type OpenRouterEmbeddingModel = {
  id: string;          // ex: "openai/text-embedding-3-small"
  name: string;
  description?: string;
};

let EMBED_CACHE: { models: OpenRouterEmbeddingModel[]; at: number } | null = null;

/**
 * Lista modelos de EMBEDDING do OpenRouter (GET /api/v1/embeddings/models).
 * Cache 10 min. Retorna [] se sem chave/offline.
 */
export async function listAvailableOpenRouterEmbeddingModels(force = false): Promise<OpenRouterEmbeddingModel[]> {
  if (!force && EMBED_CACHE && Date.now() - EMBED_CACHE.at < TTL_MS) return EMBED_CACHE.models;

  const apiKey = await getKey();
  if (!apiKey) return EMBED_CACHE?.models || [];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12000),
    });
    const json = await res.json();
    const list: any[] = Array.isArray(json?.data) ? json.data : [];
    if (!res.ok || !list.length) return EMBED_CACHE?.models || [];

    const models: OpenRouterEmbeddingModel[] = list.map((m: any) => ({
      id: String(m.id),
      name: m.name || m.id,
      description: m.description,
    }));
    EMBED_CACHE = { models, at: Date.now() };
    return models;
  } catch (err) {
    console.warn("[openrouter-discovery] Falha ao listar modelos de embedding:", (err as any)?.message);
    return EMBED_CACHE?.models || [];
  }
}
