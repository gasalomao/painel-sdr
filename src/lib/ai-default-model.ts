/**
 * Resolve o "modelo padrão" de IA em runtime — SEM hardcode.
 *
 * SaaS controla custo via modelo central. Cliente comum NUNCA escolhe modelo.
 * Hierarquia (mais específica → mais genérica):
 *
 *   1. `clients[clientId].default_ai_model` — admin setou per-tenant em
 *      /admin/clientes. Útil pra clientes "premium" usarem modelo melhor.
 *   2. `ai_organizer_config.model` — default global do sistema (fallback
 *      pra tenants sem override).
 *   3. null — admin não configurou nada. Caller decide (erro explícito ou
 *      pula chamada IA).
 *
 * Cache: 60s via organizer-config-cache (global) + lookup direto no
 * clients pra per-tenant (poderia adicionar cache se virar gargalo).
 *
 * REGRA DO SAAS: NUNCA aceitar modelo passado pelo cliente comum. Só admin
 * pode passar `optsModel` — caller é responsável por checar `isAdmin` antes.
 */

import { getOrganizerConfig } from "@/lib/organizer-config-cache";
import { supabaseAdmin } from "@/lib/supabase_admin";
import {
  listAvailableGeminiModels,
  pickBestFlashModel,
  getCachedFlashModel,
} from "@/lib/gemini-model-discovery";
import { providerOf } from "@/lib/ai-provider";

/**
 * Versão SÍNCRONA — mantida pra compatibilidade. Não consegue validar contra
 * a lista real (sem await). Só normaliza prefixo "models/" e devolve trimmed.
 * Para validação real contra o que a Google publica AGORA, use `mapModelAsync`.
 */
// Modelos OpenRouter/Gateway passam intactos — não são Gemini.
export function mapModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const provider = providerOf(trimmed);
  if (provider === "openrouter" || provider === "gateway") return trimmed;
  return trimmed.toLowerCase().startsWith("models/") ? trimmed.substring(7) : trimmed;
}

/**
 * Versão ASYNC — checa contra a lista REAL de modelos disponíveis na Google
 * AGORA. Se o modelo pedido sumiu/foi despublicado, redireciona pro melhor
 * flash atualmente disponível (descoberto via API, sem hardcode).
 *
 * Use sempre que possível. Cai pro mapModel síncrono se descoberta falhar
 * (ex: sem API key, Google offline).
 */
export async function mapModelAsync(model: string | null | undefined): Promise<string | null> {
  const normalized = mapModel(model);
  if (!normalized) return null;

  // OpenRouter/Gateway: não validamos contra a lista Gemini — devolve o ref como está.
  const provider = providerOf(normalized);
  if (provider === "openrouter" || provider === "gateway") return normalized;

  const available = await listAvailableGeminiModels();
  // Sem descoberta possível (API key vazia ou Google fora) — devolve o pedido
  // como está. O caller vai descobrir no 404, mas não temos como decidir aqui.
  if (!available.length) return normalized;

  const exists = available.some((m) => m.id === normalized);
  if (exists) return normalized;

  // Modelo pedido não existe mais — fallback dinâmico
  const best = await pickBestFlashModel();
  if (best) {
    console.warn(`[mapModelAsync] "${normalized}" não existe mais. Redirecionando pra "${best}".`);
    return best;
  }
  // Sem fallback descoberto — devolve o original, deixa o caller estourar 404
  return normalized;
}

export async function getDefaultModel(): Promise<string | null> {
  const cfg = await getOrganizerConfig();
  return mapModelAsync(cfg?.model);
}

/**
 * Resolve modelo pra um TENANT específico. Padrão SaaS-safe:
 *   1) Override do cliente (`clients.default_ai_model`) se setado pelo admin
 *   2) Default global (`ai_organizer_config.model`)
 *   3) null
 *
 * NÃO aceita override do caller — esta função é pra runtime do sistema
 * (workers, IA do agente, organizer, follow-up). Cliente comum chama isso
 * indiretamente; não pode burlar.
 */
export async function resolveModelForClient(clientId: string | null | undefined): Promise<string | null> {
  if (clientId && supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from("clients")
      .select("default_ai_model")
      .eq("id", clientId)
      .maybeSingle();
    const own = (data?.default_ai_model || "").trim();
    if (own) return mapModelAsync(own);
  }
  return getDefaultModel();
}

/**
 * Helper LEGADO: aceita override opcional do caller (`optsModel`).
 *
 * IMPORTANTE — uso restrito:
 *   • Caller só deve passar `optsModel` quando AMARRADO a uma flag isAdmin
 *     verificada no handler (ex: PATCH /api/organizer/model). Cliente comum
 *     NUNCA deve forçar modelo arbitrário — burla controle de custo.
 *   • Prefira `resolveModelForClient(clientId)` quando o contexto tem cliente.
 *     Esta função sem cliente vai sempre no default global.
 */
export async function resolveModel(
  optsModel?: string | null,
  clientId?: string | null
): Promise<string | null> {
  if (clientId && supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from("clients")
        .select("is_admin, default_ai_model")
        .eq("id", clientId)
        .maybeSingle();

      if (!error && data) {
        const isAdmin = !!data.is_admin;
        const defaultModel = (data.default_ai_model || "").trim();

        if (!isAdmin) {
          // Cliente comum: NUNCA aceita override do caller, sempre usa o modelo padrão dele ou global
          if (defaultModel) return mapModelAsync(defaultModel);
          return getDefaultModel();
        } else {
          // Admin: aceita override (optsModel) se passado, senão usa seu default ou o global
          if (optsModel && optsModel.trim()) return mapModelAsync(optsModel.trim());
          if (defaultModel) return mapModelAsync(defaultModel);
          return getDefaultModel();
        }
      }
    } catch (dbErr) {
      console.error("[resolveModel] Erro ao buscar dados do cliente no Supabase:", dbErr);
    }
  }

  // Fallback se não informado clientId ou falhar DB
  if (optsModel && optsModel.trim()) return mapModelAsync(optsModel.trim());
  return getDefaultModel();
}
