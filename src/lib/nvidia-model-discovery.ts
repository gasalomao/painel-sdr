/**
 * Descoberta DINÂMICA de modelos NVIDIA NIM / AI Foundation Endpoints.
 *
 * Server-side. Consulta a API de modelos da NVIDIA + catálogo NGC de endpoints
 * (em paralelo) para identificar em tempo real:
 *   - Modelos ativos de chat / geração
 *   - Flag "isFreeEndpoint" (Preview gratuito no catálogo NGC)
 *   - Disponibilidade ("AVAILABLE" !== "false")
 *   - Estatísticas de invocação (popularidade)
 *
 * Cacheia 10 min.
 */

import { getAiKeys } from "@/lib/ai-keys";

export type NvidiaModel = {
  id: string; // ex: "nvidia/nemotron-3.5-lightning-30b-a3b"
  name: string;
  description?: string;
  contextLength?: number;
  supportsTools: boolean;
  ownedBy?: string;
  isFreeEndpoint?: boolean;
  available?: boolean;
  usageCount?: number;
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
 * Normaliza o nome/id do modelo para matching tolerante com o catálogo NGC:
 * lowercase, `_` -> `-`, remove prefixo de publisher (ex: `nvidia/` -> ``).
 */
export function normalizeNvidiaModelKey(idOrName: string): string {
  let s = String(idOrName || "").toLowerCase().replace(/_/g, "-").trim();
  const slash = s.indexOf("/");
  if (slash > 0) {
    const prefix = s.slice(0, slash);
    // Só remove prefixo se não parecer parte do nome da família (ex: remove "nvidia", "meta", "google", "openai")
    if (!/-\d/.test(prefix)) {
      s = s.slice(slash + 1);
    }
  }
  return s;
}

function formatDisplayName(id: string, catalogDisplayName?: string): string {
  if (catalogDisplayName && catalogDisplayName.trim()) {
    const parts = id.split("/");
    const vendor = parts.length > 1 ? parts[0] : "";
    const vendorTag = vendor ? ` (${vendor.toUpperCase()})` : "";
    return `${catalogDisplayName.trim()}${vendorTag}`;
  }
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
 * Modelos de referência (atualizados com modelos reais e modernos da NVIDIA NIM).
 */
export const FALLBACK_NVIDIA_MODELS: NvidiaModel[] = [
  { id: "nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning 30B (NVIDIA)", supportsTools: true, isFreeEndpoint: true, available: true, contextLength: 128000 },
  { id: "meta/llama-3.2-11b-vision-instruct", name: "Llama 3.2 11B Vision Instruct (META)", supportsTools: true, isFreeEndpoint: true, available: true, contextLength: 128000 },
  { id: "openai/gpt-oss-20b", name: "GPT OSS 20B (OPENAI)", supportsTools: true, isFreeEndpoint: true, available: true, contextLength: 128000 },
  { id: "deepseek-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (DEEPSEEK-AI)", supportsTools: true, isFreeEndpoint: true, available: true, contextLength: 128000 },
  { id: "google/gemma-4-31b-it", name: "Gemma 4 31B IT (GOOGLE)", supportsTools: true, isFreeEndpoint: true, available: true, contextLength: 128000 },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", name: "Nemotron 3 Nano Omni 30B Reasoning (NVIDIA)", supportsTools: true, isFreeEndpoint: true, available: true, contextLength: 128000 },
  { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct (META)", supportsTools: true, isFreeEndpoint: false, available: true, contextLength: 128000 },
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", name: "Llama 3.1 Nemotron 70B Instruct (NVIDIA)", supportsTools: true, isFreeEndpoint: false, available: true, contextLength: 128000 },
  { id: "qwen/qwen2.5-72b-instruct", name: "Qwen 2.5 72B Instruct (QWEN)", supportsTools: true, isFreeEndpoint: false, available: true, contextLength: 128000 },
  { id: "mistralai/mistral-large-2-instruct", name: "Mistral Large 2 Instruct (MISTRALAI)", supportsTools: true, isFreeEndpoint: false, available: true, contextLength: 128000 },
];

interface CatalogResource {
  name: string;
  displayName?: string;
  isFree: boolean;
  available: boolean;
  usageCount: number;
}

/**
 * Consulta o catálogo NGC público de recursos ENDPOINT para identificar Free Endpoints
 * e status de disponibilidade real.
 */
async function fetchNgcCatalogMap(): Promise<Map<string, CatalogResource>> {
  const map = new Map<string, CatalogResource>();
  try {
    const q = { page: 0, pageSize: 100 };
    const url = `https://api.ngc.nvidia.com/v2/search/catalog/resources?q=${encodeURIComponent(JSON.stringify(q))}&group-labels-by-labelset=true&resource-type=ENDPOINT`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return map;
    const json = await res.json().catch(() => ({}));
    const groups: any[] = Array.isArray(json?.results) ? json.results : [];
    for (const group of groups) {
      const list: any[] = Array.isArray(group?.resources) ? group.resources : [];
      for (const r of list) {
        const name = String(r?.name || "").trim();
        if (!name) continue;
        const labels: any[] = Array.isArray(r?.labels) ? r.labels : [];
        const nimTypeLabel = labels.find((l: any) => l.key === "nimType");
        const nimValues: string[] = Array.isArray(nimTypeLabel?.values) ? nimTypeLabel.values : [];
        const isFree = nimValues.includes("Free Endpoint");

        const attrs: any[] = Array.isArray(r?.attributes) ? r.attributes : [];
        const avAttr = attrs.find((a: any) => a.key === "AVAILABLE");
        const available = avAttr ? String(avAttr.value).toLowerCase() !== "false" : true;
        const usesAttr = attrs.find((a: any) => a.key === "lastMonthApiInvocationCount");
        const usageCount = usesAttr ? Number(usesAttr.value) || 0 : 0;

        const item: CatalogResource = {
          name,
          displayName: typeof r?.displayName === "string" ? r.displayName : undefined,
          isFree,
          available,
          usageCount,
        };

        const k1 = normalizeNvidiaModelKey(name);
        if (!map.has(k1)) map.set(k1, item);
      }
    }
  } catch (err) {
    console.warn("[nvidia-discovery] NGC Catalog indisponível:", (err as any)?.message);
  }
  return map;
}

/**
 * Lista modelos NVIDIA NIM que suportam chat e geração de texto em tempo real.
 * Cruza a API com o catálogo NGC para marcar Free Endpoint e disponibilidade.
 * Retorna [] se nenhuma API key NVIDIA estiver configurada.
 */
export async function listAvailableNvidiaModels(force = false): Promise<NvidiaModel[]> {
  if (!force && CACHE && Date.now() - CACHE.at < TTL_MS) return CACHE.models;

  const apiKey = await getKey();
  if (!apiKey) return [];

  try {
    // Busca /v1/models (autenticado) e catálogo NGC (público) em paralelo
    const [modelsRes, catalogMap] = await Promise.all([
      fetch("https://integrate.api.nvidia.com/v1/models", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(12000),
      }).catch(() => null),
      fetchNgcCatalogMap(),
    ]);

    const json = modelsRes && modelsRes.ok ? await modelsRes.json().catch(() => ({})) : null;
    const list: any[] = Array.isArray(json?.data) ? json.data : [];

    if (!list.length) {
      return CACHE?.models?.length ? CACHE.models : FALLBACK_NVIDIA_MODELS;
    }

    // Filtra modelos não-chat (embeddings, rerank, reward, whisper, etc.)
    const models: NvidiaModel[] = list
      .filter((m: any) => {
        const id = String(m?.id || "").toLowerCase();
        if (!id) return false;
        if (/embed|rerank|ranking|reward|guard|clip|whisper|stt|tts|bge-|voicechat/i.test(id)) {
          return false;
        }
        return true;
      })
      .map((m: any) => {
        const id = String(m.id);
        const norm = normalizeNvidiaModelKey(id);
        const cat = catalogMap.get(norm);
        const isFreeEndpoint = cat ? cat.isFree : false;
        const available = cat ? cat.available : true;
        const usageCount = cat ? cat.usageCount : undefined;
        const name = formatDisplayName(id, cat?.displayName);
        const supportsTools = !/reward|math|code-only|r1\b/i.test(id);

        return {
          id,
          name,
          description: isFreeEndpoint
            ? `NVIDIA NIM · Free Endpoint (${m.owned_by || "system"})`
            : `NVIDIA NIM (${m.owned_by || "system"})`,
          supportsTools,
          ownedBy: m.owned_by,
          isFreeEndpoint,
          available,
          usageCount,
          contextLength: /405b|70b|nemotron/i.test(id) ? 128000 : 32768,
        };
      })
      // Exclui modelos explicitamente marcados como indisponíveis no catálogo NGC
      .filter((m) => m.available !== false);

    // Ordena: Free Endpoints primeiro, depois por popularidade/invocações
    models.sort((a, b) => {
      if (a.isFreeEndpoint && !b.isFreeEndpoint) return -1;
      if (!a.isFreeEndpoint && b.isFreeEndpoint) return 1;
      const uA = a.usageCount || 0;
      const uB = b.usageCount || 0;
      if (uA !== uB) return uB - uA;
      return a.name.localeCompare(b.name, "pt-BR");
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
