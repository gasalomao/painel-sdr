/**
 * Descoberta DINÂMICA de modelos OpenRouter — sem hardcode.
 *
 * Server-side. Consulta GET https://openrouter.ai/api/v1/models com a API key
 * salva em ai_organizer_config.openrouter_api_key e devolve a lista real do que
 * existe AGORA. Cacheia 10 min. Quando a OpenRouter adiciona um modelo novo, ele
 * aparece sozinho no seletor — igual à descoberta de modelos Gemini.
 */

import { getAiKeys } from "@/lib/ai-keys";

export type OpenRouterModel = {
  id: string;            // ex: "anthropic/claude-3.5-sonnet"
  name: string;
  description?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  created?: number;
  isModerated?: boolean;
  /** true se o modelo suporta function/tool calling (usado pelo Agente SDR). */
  supportsTools: boolean;
  /** true se o modelo declara suporte a response_format / structured_outputs. */
  supportsStructuredOutputs?: boolean;
  /** true se o modelo declara suporte a parâmetros de reasoning/thinking. */
  supportsReasoning?: boolean;
  /** true quando prompt e completion custam US$ 0,00. */
  isFree?: boolean;
  pricing?: { prompt?: string; completion?: string };
  /** Modalidades de entrada aceitas (ex: ["text","audio"]) — undefined se a API não informou. */
  inputModalities?: string[];
  outputModalities?: string[];
};

type Cache = { models: OpenRouterModel[]; at: number };
let CACHE: Cache | null = null;
let IN_FLIGHT_REFRESH: Promise<OpenRouterModel[] | null> | null = null;
const TTL_MS = 10 * 60 * 1000;
const STALE_REFRESH_MS = 8 * 60 * 1000;

async function hashKeyId(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `openrouter:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function getKey(): Promise<string | null> {
  try {
    const keys = await getAiKeys();
    const candidates = [
      ...(Array.isArray(keys.openrouterKeys) ? keys.openrouterKeys : []),
      ...(keys.openrouter ? [keys.openrouter] : []),
    ]
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    let checkDead: ((id: string) => boolean) | null = null;
    try {
      const mod = await import("@/lib/gateway-cooldown");
      if ("isEndpointDead" in mod && typeof mod.isEndpointDead === "function") {
        checkDead = mod.isEndpointDead;
      }
    } catch {
      checkDead = null;
    }

    for (const candidate of candidates) {
      const id = await hashKeyId(candidate).catch(() => "");
      if (!id || !checkDead || !checkDead(id)) return candidate;
    }
    return candidates[0] || null;
  } catch {
    return null;
  }
}

export function isCompletelyFreePricing(pricing?: { prompt?: string; completion?: string }, modelId?: string): boolean {
  const promptCost = parseFloat(pricing?.prompt ?? "");
  if (!Number.isFinite(promptCost) || promptCost !== 0) {
    return Boolean(modelId && modelId.toLowerCase().endsWith(":free") && pricing?.prompt === undefined);
  }
  if (pricing?.completion === undefined || pricing?.completion === null || pricing?.completion === "") {
    return true;
  }
  const completionCost = parseFloat(pricing.completion);
  return Number.isFinite(completionCost) && completionCost === 0;
}

async function fetchOpenRouterModelsCatalog(timeoutMs = 12000): Promise<OpenRouterModel[] | null> {
  const apiKey = await getKey();
  if (!apiKey) return null;

  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  const list: unknown[] = Array.isArray(json?.data) ? json.data : [];
  if (!res.ok || !list.length) return null;

  const models: OpenRouterModel[] = list.map((raw: unknown) => {
    const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
    const params: string[] = Array.isArray(m?.supported_parameters) ? m.supported_parameters.map(String) : [];
    const id = String(m.id || "");
    const pricing = m.pricing ? { prompt: m.pricing.prompt, completion: m.pricing.completion } : undefined;
    return {
      id,
      name: m.name || id,
      description: typeof m.description === "string" ? m.description : undefined,
      contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
      maxCompletionTokens:
        typeof m?.top_provider?.max_completion_tokens === "number"
          ? m.top_provider.max_completion_tokens
          : undefined,
      created: typeof m.created === "number" ? m.created : undefined,
      isModerated: typeof m?.top_provider?.is_moderated === "boolean" ? m.top_provider.is_moderated : undefined,
      supportsTools: params.includes("tools") || params.includes("tool_choice"),
      supportsStructuredOutputs: params.includes("structured_outputs") || params.includes("response_format"),
      supportsReasoning: params.includes("reasoning") || params.includes("include_reasoning"),
      isFree: isCompletelyFreePricing(pricing, id),
      pricing,
      inputModalities: Array.isArray(m?.architecture?.input_modalities)
        ? m.architecture.input_modalities.map(String)
        : undefined,
      outputModalities: Array.isArray(m?.architecture?.output_modalities)
        ? m.architecture.output_modalities.map(String)
        : undefined,
    };
  });

  CACHE = { models, at: Date.now() };
  return models;
}

/**
 * Leitura síncrona (zero rede) do cache atual de modelos OpenRouter.
 */
export function getCachedOpenRouterModels(includeImageOutput = false): OpenRouterModel[] {
  const models = CACHE?.models || [];
  return includeImageOutput
    ? models
    : models.filter((m) => !m.outputModalities?.length || m.outputModalities.includes("text"));
}

/** Permite popular o cache em testes determinísticos sem depender de rede. */
export function seedOpenRouterModelsCache(models: OpenRouterModel[]): void {
  CACHE = { models: [...models], at: Date.now() };
}

/**
 * Lista modelos OpenRouter que suportam chat (output text). Cache 10 min com
 * stale-while-revalidate em background após 8 min.
 * Retorna [] se a API key não estiver configurada ou a OpenRouter estiver fora.
 */
export async function listAvailableOpenRouterModels(
  force = false,
  includeImageOutput = false,
  timeoutMs = 12000,
): Promise<OpenRouterModel[]> {
  const filterModels = (models: OpenRouterModel[]) =>
    includeImageOutput
      ? models
      : models.filter((m) => !m.outputModalities?.length || m.outputModalities.includes("text"));

  const age = CACHE ? Date.now() - CACHE.at : Infinity;
  if (!force && CACHE && age < TTL_MS) {
    if (age >= STALE_REFRESH_MS && !IN_FLIGHT_REFRESH) {
      IN_FLIGHT_REFRESH = fetchOpenRouterModelsCatalog(timeoutMs)
        .then((m) => m || CACHE?.models || [])
        .catch(() => CACHE?.models || [])
        .finally(() => {
          IN_FLIGHT_REFRESH = null;
        });
    }
    return filterModels(CACHE.models);
  }

  try {
    if (!IN_FLIGHT_REFRESH || force) {
      IN_FLIGHT_REFRESH = fetchOpenRouterModelsCatalog(timeoutMs).finally(() => {
        IN_FLIGHT_REFRESH = null;
      });
    }
    const fresh = await IN_FLIGHT_REFRESH;
    if (!fresh) return filterModels(CACHE?.models || []);
    return filterModels(fresh);
  } catch (err) {
    console.warn("[openrouter-discovery] Falha ao listar modelos:", (err as Error)?.message);
    return filterModels(CACHE?.models || []);
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
