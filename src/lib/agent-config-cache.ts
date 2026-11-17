/**
 * Cache TTL curto (20s) para dados estáticos do agente no hot-path de IA:
 *   - agent_settings
 *   - agent_stages (ordenadas por order_index)
 *   - metadados da agent_knowledge (títulos + flag se há catálogo/foto/estoque)
 *
 * Invalidado imediatamente pelas rotas de escrita (`/api/agent/settings`,
 * `/api/agent/knowledge/save`, `/api/agent/knowledge/reindex`, `/api/agent/reindex-kb`).
 * Em ambiente de teste (VITEST / NODE_ENV === "test") é contornado por padrão
 * para não vazar fixtures entre casos de teste, salvo opt-in explícito em testes
 * específicos do próprio cache (`forceCacheInTests: true`).
 */
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

export const AGENT_CONFIG_CACHE_TTL_MS = 20_000;

export interface AgentStaticBundle {
  agentConfig: Record<string, any> | null;
  leadStages: Array<Record<string, any>>;
  knowledgeTopics: Array<{ id: string; title: string }>;
  hasCatalogOrPhotoKb: boolean;
}

const bundleCache = new Map<string, { value: AgentStaticBundle; expiresAt: number }>();

function cacheKeyFor(agentId: number, clientId: string): string {
  return `${agentId}:${clientId}`;
}

export function detectCatalogOrPhotoKb(
  docs: Array<{ title?: string | null; content?: string | null }>,
): boolean {
  return docs.some(
    (k) =>
      (typeof k.content === "string" &&
        /(?:IMAGEM|IMAGE|MEDIA|FOTO):|###\s*PRODUTO:|Estoque(?:\s*Dispon[ií]vel)?:/i.test(k.content)) ||
      /cat[aá]logo|produto|estoque|pre[çc]o/i.test(String(k.title || "")),
  );
}

/**
 * Invalida o cache estático de um agente específico (ou de todos, sem argumento).
 */
export function invalidateAgentConfigCache(agentId?: number | null): void {
  if (agentId == null) {
    bundleCache.clear();
    return;
  }
  const prefix = `${agentId}:`;
  for (const k of [...bundleCache.keys()]) {
    if (k.startsWith(prefix)) bundleCache.delete(k);
  }
}

export function clearAgentConfigCache(): void {
  bundleCache.clear();
}

/**
 * Carrega `agent_settings`, `agent_stages` e metadados de `agent_knowledge`
 * usando cache em memória com TTL de 20s em produção.
 */
export async function getCachedAgentStaticBundle(opts: {
  agentId: number;
  clientId: string;
  preloadedAgentConfig?: Record<string, any> | null;
  forceCacheInTests?: boolean;
}): Promise<AgentStaticBundle> {
  const { agentId, clientId, preloadedAgentConfig = null, forceCacheInTests = false } = opts;
  const isTestEnv = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const cacheEnabled = !isTestEnv || forceCacheInTests;
  const key = cacheKeyFor(agentId, clientId);

  if (cacheEnabled) {
    const hit = bundleCache.get(key);
    if (hit && Date.now() < hit.expiresAt) {
      return preloadedAgentConfig
        ? { ...hit.value, agentConfig: preloadedAgentConfig }
        : hit.value;
    }
  }

  const [agentRes, stagesRes, kbRes] = await Promise.all([
    preloadedAgentConfig
      ? Promise.resolve({ data: preloadedAgentConfig })
      : supabase.from("agent_settings").select("*").eq("id", agentId).single(),
    supabase.from("agent_stages").select("*").eq("agent_id", agentId).order("order_index"),
    supabase
      .from("agent_knowledge")
      .select("id, title, content")
      .eq("agent_id", agentId)
      .or(`client_id.eq.${clientId},client_id.is.null`)
      .order("title"),
  ]);

  const kbDocsRaw: Array<{ id: string; title?: string | null; content?: string | null }> =
    (kbRes.data || []) as Array<{ id: string; title?: string | null; content?: string | null }>;
  const knowledgeTopics = kbDocsRaw
    .filter((k) => Boolean(k.title))
    .map((k) => ({ id: k.id, title: String(k.title) }));
  const hasCatalogOrPhotoKb = detectCatalogOrPhotoKb(kbDocsRaw);

  const bundle: AgentStaticBundle = {
    agentConfig: (agentRes.data as Record<string, any> | null) ?? null,
    leadStages: (stagesRes.data || []) as Array<Record<string, any>>,
    knowledgeTopics,
    hasCatalogOrPhotoKb,
  };

  const ownerMatchesTenant =
    !bundle.agentConfig?.client_id || bundle.agentConfig.client_id === clientId;

  if (cacheEnabled && bundle.agentConfig && ownerMatchesTenant) {
    bundleCache.set(key, {
      value: bundle,
      expiresAt: Date.now() + AGENT_CONFIG_CACHE_TTL_MS,
    });
  }

  return bundle;
}

