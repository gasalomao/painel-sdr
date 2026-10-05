/**
 * Descoberta DINÂMICA de modelos NVIDIA NIM / AI Foundation Endpoints.
 *
 * Server-side. Consulta GET https://integrate.api.nvidia.com/v1/models com a API key
 * salva em ai_organizer_config.nvidia_api_key e devolve a lista real do que
 * existe. Cacheia 10 min.
 */

import { getAiKeys } from "@/lib/ai-keys";

export type NvidiaModel = {
  id: string;            // ex: "meta/llama-3.1-70b-instruct", "nvidia/nemotron-4-340b-instruct"
  name: string;
  description?: string;
  contextLength?: number;
  supportsTools: boolean;
  ownedBy?: string;
};

type Cache = { models: NvidiaModel[]; at: number };
let CACHE: Cache | null = null;
const TTL_MS = 10 * 60 * 1000;

async function getKey(): Promise<string | null> {
  try {
    const keys = await getAiKeys();
    return keys.nvidia && String(keys.nvidia).trim() ? String(keys.nvidia).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Formata um nome amigável a partir do id do modelo da NVIDIA (ex: "meta/llama-3.1-70b-instruct").
 */
function formatDisplayName(id: string): string {
  const parts = id.split("/");
  const vendor = parts.length > 1 ? parts[0] : "";
  const modelName = parts.length > 1 ? parts.slice(1).join("/") : id;

  const prettyModel = modelName
    .replace(/-/g, " ")
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/Nemotron/i, "Nemotron")
    .replace(/Llama/i, "Llama")
    .replace(/Instruct/i, "Instruct");

  const vendorTag = vendor ? ` (${vendor.toUpperCase()})` : "";
  return `${prettyModel}${vendorTag}`;
}

/**
 * Modelos padrão de referência caso a API da NVIDIA esteja temporariamente indisponível.
 */
const FALLBACK_NVIDIA_MODELS: NvidiaModel[] = [
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", name: "Llama 3.1 Nemotron 70B Instruct (NVIDIA)", supportsTools: true, contextLength: 128000 },
  { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct (META)", supportsTools: true, contextLength: 128000 },
  { id: "meta/llama-3.1-70b-instruct", name: "Llama 3.1 70B Instruct (META)", supportsTools: true, contextLength: 128000 },
  { id: "meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B Instruct (META)", supportsTools: true, contextLength: 128000 },
  { id: "meta/llama-3.1-405b-instruct", name: "Llama 3.1 405B Instruct (META)", supportsTools: true, contextLength: 128000 },
  { id: "nvidia/nemotron-4-340b-instruct", name: "Nemotron 4 340B Instruct (NVIDIA)", supportsTools: true, contextLength: 4096 },
  { id: "mistralai/mixtral-8x22b-instruct-v0.1", name: "Mixtral 8x22B Instruct (MISTRALAI)", supportsTools: true, contextLength: 65536 },
  { id: "mistralai/mistral-large-2-instruct", name: "Mistral Large 2 Instruct (MISTRALAI)", supportsTools: true, contextLength: 128000 },
  { id: "qwen/qwen2.5-72b-instruct", name: "Qwen 2.5 72B Instruct (QWEN)", supportsTools: true, contextLength: 128000 },
  { id: "deepseek-ai/deepseek-r1", name: "DeepSeek R1 (DEEPSEEK-AI)", supportsTools: false, contextLength: 64000 },
];

/**
 * Lista modelos NVIDIA NIM que suportam chat e geração de texto. Cache 10 min.
 * Retorna [] se a API key não estiver configurada.
 */
export async function listAvailableNvidiaModels(force = false): Promise<NvidiaModel[]> {
  if (!force && CACHE && Date.now() - CACHE.at < TTL_MS) return CACHE.models;

  const apiKey = await getKey();
  if (!apiKey) return [];

  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(12000),
    });

    const json = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(json?.data) ? json.data : [];

    if (!res.ok || !list.length) {
      // Se tiver erro ou lista vazia mas chave configurada, usa lista de referência
      return CACHE?.models?.length ? CACHE.models : FALLBACK_NVIDIA_MODELS;
    }

    // Filtra modelos não-chat (embeddings, rerank, reward, whisper, etc.)
    const models: NvidiaModel[] = list
      .filter((m: any) => {
        const id = String(m?.id || "").toLowerCase();
        if (!id) return false;
        // Exclui modelos de embedding, rerank, guardrails, visão pura não-chat ou áudio
        if (/embed|rerank|ranking|reward|guard|clip|whisper|stt|tts|bge-/i.test(id)) {
          return false;
        }
        return true;
      })
      .map((m: any) => {
        const id = String(m.id);
        const name = formatDisplayName(id);
        // Quase todos os modelos modernos de instruct em NIM suportam tools
        const supportsTools = !/reward|math|code-only|r1\b/i.test(id);
        return {
          id,
          name,
          description: `Modelo NVIDIA NIM (${m.owned_by || "system"})`,
          supportsTools,
          ownedBy: m.owned_by,
          contextLength: /405b|70b|nemotron/i.test(id) ? 128000 : 32768,
        };
      });

    const finalModels = models.length > 0 ? models : FALLBACK_NVIDIA_MODELS;
    CACHE = { models: finalModels, at: Date.now() };
    return finalModels;
  } catch (err) {
    console.warn("[nvidia-discovery] Falha ao listar modelos:", (err as any)?.message);
    return CACHE?.models?.length ? CACHE.models : FALLBACK_NVIDIA_MODELS;
  }
}

/** Invalida o cache — usar quando o admin trocar a API key. */
export function invalidateNvidiaModelsCache() {
  CACHE = null;
}
