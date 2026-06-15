/**
 * Descoberta DINÂMICA de modelos Gemini disponíveis — sem hardcode.
 *
 * Server-side. Consulta a Google API com a API key salva em ai_organizer_config
 * e retorna a lista real do que existe NESTE MOMENTO. Cacheia 10 min.
 *
 * Usado por:
 *   - `mapModel` em ai-default-model.ts (redireciona modelo morto pro melhor vivo)
 *   - GEMINI_MODEL_CHAIN do webhook (fallback chain de transcrição)
 *   - qualquer caller server-side que precise saber o "melhor flash atual"
 *
 * Por que existe (em vez de hardcode "gemini-2.5-flash"):
 *   Google despublica modelos. Hoje 3.1 sumiu, amanhã 2.5 sai, 4.x aparece.
 *   Hardcodar = bug recorrente toda vez que eles giram a lista.
 */

import { supabase } from "@/lib/supabase";

export type GeminiModel = {
  id: string;          // ex: "gemini-2.5-flash"
  displayName: string;
  description?: string;
};

type Cache = { models: GeminiModel[]; at: number };
let CACHE: Cache | null = null;
const TTL_MS = 10 * 60 * 1000;

/**
 * Lista modelos Gemini que SUPORTAM generateContent (chat/texto/multimodal).
 * Cache 10 min. Retorna [] se API key não configurada ou Google fora.
 */
export async function listAvailableGeminiModels(force = false): Promise<GeminiModel[]> {
  if (!force && CACHE && Date.now() - CACHE.at < TTL_MS) return CACHE.models;

  try {
    const { data: cfg } = await supabase
      .from("ai_organizer_config")
      .select("api_key")
      .eq("id", 1)
      .maybeSingle();
    const apiKey = cfg?.api_key;
    if (!apiKey) return CACHE?.models || [];

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const json = await res.json();
    if (!res.ok || !Array.isArray(json?.models)) return CACHE?.models || [];

    const models: GeminiModel[] = json.models
      .filter((m: any) =>
        m.name?.includes("gemini") &&
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m: any) => ({
        id: String(m.name).replace(/^models\//, ""),
        displayName: m.displayName || m.name,
        description: m.description,
      }));

    CACHE = { models, at: Date.now() };
    return models;
  } catch (err) {
    console.warn("[gemini-discovery] Falha ao listar modelos:", (err as any)?.message);
    return CACHE?.models || [];
  }
}

/**
 * Retorna o melhor modelo "flash" disponível AGORA pra fallback barato.
 * Heurística: prefere flash-lite (mais barato) → flash → primeiro flash que achar.
 * Filtra preview/experimental quando há GA equivalente (preview some sem aviso).
 *
 * Retorna null se não conseguiu descobrir (caller decide: erra ou usa último valor).
 */
export async function pickBestFlashModel(): Promise<string | null> {
  const models = await listAvailableGeminiModels();
  if (!models.length) return null;

  const ids = models.map((m) => m.id);

  // Helpers de classificação
  const isFlashLite = (id: string) => /flash-lite/.test(id);
  const isFlash     = (id: string) => /flash/.test(id) && !isFlashLite(id);
  const isPreview   = (id: string) => /preview|exp(?:erimental)?/.test(id);

  // Versão numérica — pega "3.1" de "gemini-3.1-flash-lite", "2.5" de "gemini-2.5-flash"
  const versionOf = (id: string): number => {
    const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };

  const sortByVersionDesc = (a: string, b: string) => versionOf(b) - versionOf(a);

  // 1ª escolha: flash-lite GA (não-preview), maior versão
  const flashLiteGA = ids.filter((id) => isFlashLite(id) && !isPreview(id)).sort(sortByVersionDesc);
  if (flashLiteGA[0]) return flashLiteGA[0];

  // 2ª: flash GA
  const flashGA = ids.filter((id) => isFlash(id) && !isPreview(id)).sort(sortByVersionDesc);
  if (flashGA[0]) return flashGA[0];

  // 3ª: qualquer flash-lite (mesmo preview), maior versão
  const anyFlashLite = ids.filter(isFlashLite).sort(sortByVersionDesc);
  if (anyFlashLite[0]) return anyFlashLite[0];

  // 4ª: qualquer flash
  const anyFlash = ids.filter(isFlash).sort(sortByVersionDesc);
  if (anyFlash[0]) return anyFlash[0];

  // 5ª: primeiro disponível
  return ids[0] || null;
}

/**
 * Constrói uma cadeia de fallback (modelo principal → backups) baseada no que
 * EXISTE hoje. Usado pelo webhook de transcrição: tenta o 1º, se falhar tenta
 * o 2º, etc. Inclui preview no início (mais barato) e GA no fim (mais estável).
 */
export async function buildFallbackChain(): Promise<string[]> {
  const models = await listAvailableGeminiModels();
  if (!models.length) return [];

  const ids = models.map((m) => m.id);
  const versionOf = (id: string): number => {
    const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };
  const sortByVersionDesc = (a: string, b: string) => versionOf(b) - versionOf(a);

  const flashLite = ids.filter((id) => /flash-lite/.test(id)).sort(sortByVersionDesc);
  const flash     = ids.filter((id) => /flash/.test(id) && !/flash-lite/.test(id)).sort(sortByVersionDesc);

  // Dedup preservando ordem
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const id of [...flashLite, ...flash]) {
    if (!seen.has(id)) { seen.add(id); chain.push(id); }
  }
  return chain;
}

/** Invalida cache — usar quando admin trocar API key. */
export function invalidateGeminiModelsCache() {
  CACHE = null;
}

/**
 * Versão SÍNCRONA pra callers que não podem await. Retorna o cache atual ou
 * null. Não dispara fetch. Use quando precisar de "o melhor que sabemos agora,
 * sem bloquear" — ex: log/display.
 */
export function getCachedFlashModel(): string | null {
  if (!CACHE?.models?.length) return null;
  const ids = CACHE.models.map((m) => m.id);
  return (
    ids.find((id) => /flash-lite/.test(id) && !/preview|exp/.test(id)) ||
    ids.find((id) => /flash/.test(id) && !/preview|exp/.test(id)) ||
    ids.find((id) => /flash/.test(id)) ||
    null
  );
}
