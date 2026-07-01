/**
 * Descoberta DINÂMICA de modelos do GATEWAY DE ASSINATURA — sem hardcode.
 *
 * Server-side. O gateway é um proxy LOCAL OpenAI-compatible (ex: CLIProxyAPI)
 * que fala com a sua CONTA logada (ChatGPT / Claude Pro-Max / Gemini) em vez de
 * gastar API key paga. Consulta GET {baseUrl}/models (mesmo formato da OpenAI).
 *
 * MULTI-CONTA: agora pode haver VÁRIAS conexões ao mesmo tempo (ex: uma conta
 * Gemini + uma Claude + uma ChatGPT). Consultamos TODAS as conexões salvas em
 * ai_organizer_config.gateway_endpoints, juntamos os modelos e marcamos cada um
 * com a conexão de origem — assim na hora de chamar sabemos para qual proxy/conta
 * rotear. Cacheia 10 min; quando você loga numa conta nova, os modelos dela
 * aparecem sozinhos no seletor.
 *
 * Espelha src/lib/openrouter-model-discovery.ts (mesmo protocolo).
 */

import { getAiKeys, type GatewayEndpoint } from "@/lib/ai-keys";
import { normalizeGatewayBaseUrl } from "@/lib/ai-provider";

export type GatewayModel = {
  id: string;            // ex: "gpt-5", "claude-sonnet-4", "gemini-2.5-pro"
  name: string;
  /** Dono do modelo (m.owned_by): "openai" | "anthropic" | "google" | ... — pra agrupar/exibir. */
  ownedBy?: string;
  /**
   * true se o modelo suporta tool/function calling. O endpoint OpenAI /models
   * normalmente NÃO informa isso, então assumimos true (os modelos de
   * assinatura grandes suportam) — e o runtime degrada sozinho se algum recusar.
   */
  supportsTools: boolean;
  /** Id da CONEXÃO (conta) que expõe este modelo — usado pra rotear a chamada. */
  endpointId: string;
  /** Rótulo amigável da conexão (ex: "Claude Pro", "Gemini conta pessoal"). */
  endpointLabel: string;
};

type Cache = { models: GatewayModel[]; at: number };
let CACHE: Cache | null = null;
const TTL_MS = 10 * 60 * 1000;

/**
 * Mapa modelId → conexão de origem, preenchido durante a descoberta. É o que
 * permite rotear `gateway:<modelId>` para a conta certa em tempo de chamada,
 * sem precisar codificar o endpoint no modelRef (mantém parseModelRef simples).
 * Mantém APENAS o PRIMEIRO endpoint (first-seen wins) — retrocompat.
 */
const MODEL_ENDPOINT = new Map<string, GatewayEndpoint>();
/**
 * Mapa modelId → TODAS as conexões que expõem aquele modelo. Preenchido junto
 * com MODEL_ENDPOINT. É o que viabiliza o FAILOVER entre contas: quando a conta
 * primária falha (429/quota/401), o roteador itera aqui pra achar outra conta
 * que sirva o mesmo modelo. Ordem = ordem das conexões no banco.
 */
const MODEL_ENDPOINTS = new Map<string, GatewayEndpoint[]>();

/** Conexões configuradas (já com fallback legado aplicado), URL normalizada. */
export async function getEndpoints(): Promise<GatewayEndpoint[]> {
  try {
    const keys = await getAiKeys();
    return (keys.gatewayEndpoints || [])
      .map((e) => ({ ...e, baseUrl: normalizeGatewayBaseUrl(e.baseUrl) || "" }))
      .filter((e) => e.baseUrl.length > 0);
  } catch {
    return [];
  }
}

/** Consulta /models de UMA conexão. Nunca lança — devolve [] se o proxy falhar. */
async function fetchEndpointModels(ep: GatewayEndpoint): Promise<GatewayModel[]> {
  try {
    const headers: Record<string, string> = {};
    if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
    const res = await fetch(`${ep.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    const json = await res.json();
    // OpenAI-compatible: { object:"list", data:[{ id, object:"model", owned_by }] }.
    const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    if (!res.ok || !list.length) return [];
    return list
      .map((m: any): GatewayModel => {
        const id = String(m.id ?? m.name ?? "").trim();
        return {
          id,
          name: m.display_name || m.name || id,
          ownedBy: m.owned_by ? String(m.owned_by) : undefined,
          supportsTools: true,
          endpointId: ep.id,
          endpointLabel: ep.label,
        };
      })
      .filter((m) => m.id.length > 0);
  } catch (err) {
    console.warn(`[gateway-discovery] Falha ao listar modelos da conexão "${ep.label}":`, (err as any)?.message);
    return [];
  }
}

/**
 * Lista modelos expostos por TODAS as conexões de gateway. Cache 10 min.
 * Retorna [] se nenhuma conexão estiver configurada ou todos os proxies fora.
 * Se o mesmo modelId aparecer em duas contas, a PRIMEIRA conexão (ordem da
 * lista) ganha o roteamento — evita ambiguidade.
 */
export async function listAvailableGatewayModels(force = false): Promise<GatewayModel[]> {
  if (!force && CACHE && Date.now() - CACHE.at < TTL_MS) return CACHE.models;

  const endpoints = await getEndpoints();
  if (!endpoints.length) {
    CACHE = { models: [], at: Date.now() };
    MODEL_ENDPOINT.clear();
    return [];
  }

  // Todas as conexões em paralelo; uma fora não derruba as outras.
  const settled = await Promise.allSettled(endpoints.map((ep) => fetchEndpointModels(ep)));

  // Se TUDO falhou, mantém o cache anterior (não apaga modelos por uma queda
  // temporária do proxy) — só zera se realmente não havia cache.
  const allFailed = settled.every((s) => s.status === "fulfilled" && s.value.length === 0);
  if (allFailed && CACHE?.models.length) return CACHE.models;

  const epById = new Map(endpoints.map((e) => [e.id, e]));
  const merged: GatewayModel[] = [];
  const seen = new Set<string>();
  MODEL_ENDPOINT.clear();
  MODEL_ENDPOINTS.clear();
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== "fulfilled") continue;
    for (const m of r.value) {
      const ep = epById.get(m.endpointId);
      if (!ep) continue;
      // Plural: acumula TODAS as conexões que expõem este modelo (ordem do banco).
      const arr = MODEL_ENDPOINTS.get(m.id) || [];
      if (!arr.some((x) => x.id === ep.id)) arr.push(ep);
      MODEL_ENDPOINTS.set(m.id, arr);
      if (seen.has(m.id)) continue; // primeira conexão a expor o id vence (singular)
      seen.add(m.id);
      merged.push(m);
      MODEL_ENDPOINT.set(m.id, ep);
    }
  }

  CACHE = { models: merged, at: Date.now() };
  return merged;
}

/**
 * Resolve a CONEXÃO (conta/proxy) que deve atender um `gateway:<modelId>`.
 * Consulta o mapa quente; se o modelo não estiver mapeado (cache frio ou conta
 * recém-adicionada), força uma descoberta. Como rede de segurança ("nunca
 * quebra"), se ainda assim não achar mas houver conexões configuradas, usa a
 * primeira — melhor tentar do que falhar de cara.
 */
export async function resolveGatewayEndpointForModel(modelId: string): Promise<GatewayEndpoint | null> {
  const id = (modelId || "").trim();
  if (!id) return null;

  const endpoints = await getEndpoints();
  if (endpoints.length === 0) return null;
  // Conta única (ou legado): sem ambiguidade — não precisa descobrir /models.
  // Mantém o caminho leve, igual ao comportamento antigo de uma conexão só.
  if (endpoints.length === 1) return endpoints[0];

  // 2+ contas: precisa saber qual delas expõe este modelo.
  if (!MODEL_ENDPOINT.size) await listAvailableGatewayModels(false);
  let ep = MODEL_ENDPOINT.get(id);
  if (ep) return ep;

  // Não achou — pode ser conta recém-adicionada; tenta uma descoberta forçada.
  await listAvailableGatewayModels(true);
  ep = MODEL_ENDPOINT.get(id);
  if (ep) return ep;

  // Rede de segurança: usa a primeira conexão configurada.
  return endpoints[0];
}

/** Invalida o cache — usar quando o admin trocar/adicionar/remover conexões. */
export function invalidateGatewayModelsCache() {
  CACHE = null;
  MODEL_ENDPOINT.clear();
  MODEL_ENDPOINTS.clear();
}

/**
 * Lista TODAS as conexões (contas) que expõem um `modelId` — base do FAILOVER.
 * Quando a conta primária falha (429/quota/401), o roteador itera nesta lista
 * (pulando as em cooldown/mortas) pra achar outra conta que sirva o mesmo
 * modelo e dar seguimento ao atendimento sem o usuário perceber.
 *
 * Ordem = ordem das conexões no banco (estável). Garante que a descoberta
 * rodou (cache quente); se o modelo não estiver mapeado (ex.: conta nova),
 * devolve TODAS as conexões como candidatos genéricos — preferimos tentar do
 * que falhar. O roteador filtra cooldown depois.
 */
export async function listEndpointsForModel(modelId: string): Promise<GatewayEndpoint[]> {
  const id = (modelId || "").trim();
  if (!id) return [];
  // Garante cache quente (não força — se frio e vazio, segue pro fallback).
  if (!MODEL_ENDPOINTS.size) await listAvailableGatewayModels(false);
  const list = MODEL_ENDPOINTS.get(id);
  if (list && list.length) return list;
  // Modelo não mapeado (ex.: conta recém-adicionada, cache desatualizado):
  // força descoberta e checa de novo.
  await listAvailableGatewayModels(true);
  const forced = MODEL_ENDPOINTS.get(id);
  if (forced && forced.length) return forced;
  // Rede de segurança: todas as conexões configuradas (o roteador decide).
  return getEndpoints();
}
