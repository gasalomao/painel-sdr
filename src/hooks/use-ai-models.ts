"use client";

/**
 * Hook React pra carregar a lista de modelos Gemini EM TEMPO REAL via /api/ai-models.
 *
 * Decisão de design: NÃO ter lista hardcoded em lugar nenhum. Quando a Google
 * lança um modelo novo (ex: gemini-3-flash) ele aparece automaticamente sem
 * deploy. O default exibido é sempre o primeiro da lista vinda da API.
 *
 * Uso:
 *   const { models, loading, error } = useAiModels();
 *   <select value={...} onChange={...}>
 *     {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
 *   </select>
 */

import { useEffect, useState } from "react";

export type AiModel = {
  id: string;            // valor salvo (ex: "gemini-2.5-flash", "openrouter:...", "gateway:gpt-5")
  rawId?: string;        // id puro do provedor (exibição)
  name: string;
  description?: string;
  provider?: "gemini" | "openrouter" | "gateway";
  supportsTools?: boolean;
};

let CACHE: { models: AiModel[]; at: number } | null = null;
const TTL = 5 * 60 * 1000; // 5 min

export function useAiModels() {
  const [models, setModels] = useState<AiModel[]>(CACHE?.models || []);
  const [loading, setLoading] = useState(!CACHE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (CACHE && Date.now() - CACHE.at < TTL) {
        setModels(CACHE.models);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const r = await fetch("/api/ai-models", { cache: "no-store" });
        const j = await r.json();
        if (j?.success && Array.isArray(j.models)) {
          CACHE = { models: j.models, at: Date.now() };
          if (!cancelled) setModels(j.models);
        } else {
          if (!cancelled) setError(j?.error || "Lista vazia");
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Falha ao carregar modelos");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return { models, loading, error };
}

/** Reset do cache — usar após admin trocar API key e querer recarregar. */
export function invalidateAiModelsCache() {
  CACHE = null;
}
