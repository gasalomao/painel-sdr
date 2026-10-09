/**
 * Token usage tracking — registra cada chamada de IA no banco pra a página /tokens
 * conseguir exibir consumo por feature, agente, modelo, dia, etc.
 *
 * Retorna void e nunca lança — falha de log NÃO pode quebrar a feature.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import { supabase } from "@/lib/supabase";
import { ensurePricing, lookupPriceSync, computeCost } from "@/lib/pricing";

const adminClient = supabaseAdmin || supabase;

export type TokenSource = "agent" | "disparo" | "followup" | "organizer" | "other";

export interface TokenUsageInput {
  source: TokenSource;
  sourceId?: string | number | null;       // ex: agent_id, campaign_id
  sourceLabel?: string | null;              // ex: "Sarah", "Campanha Out"
  model: string;
  provider?: string;                        // default "Gemini"
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  costUsd?: number | null;
  metadata?: Record<string, unknown>;
  /** Multi-tenant: cliente dono do gasto. Sem isso, /tokens do cliente fica
   *  vazio e admin vê tudo misturado. Default = Default client. */
  clientId?: string;
}

/**
 * Custo agora vem de `lib/pricing.ts` — fonte online (LiteLLM JSON), com cache.
 * Mantemos só este wrapper sync que assume o cache já populado.
 */
function estimateCost(model: string, promptTokens: number, completionTokens: number, cachedTokens = 0): number | null {
  const price = lookupPriceSync(model);
  if (!price || !Number.isFinite(price.input_per_token) || price.input_per_token < 0 || !Number.isFinite(price.output_per_token) || price.output_per_token < 0) return null;
  const cached = Number.isSafeInteger(cachedTokens) && cachedTokens > 0 ? Math.min(cachedTokens, promptTokens) : 0;
  const cachePrice = price.cache_read_per_token;
  if (cached > 0 && typeof cachePrice === "number" && Number.isFinite(cachePrice) && cachePrice >= 0) {
    return Math.round((computeCost(price, promptTokens - cached, completionTokens) + cached * cachePrice) * 1e10) / 1e10;
  }
  return computeCost(price, promptTokens, completionTokens);
}

/**
 * Extrai usage do response do Gemini SDK (@google/generative-ai).
 * Funciona com response.usageMetadata { promptTokenCount, candidatesTokenCount, totalTokenCount }
 * Também aceita o formato bruto da REST API.
 */
export function extractGeminiUsage(response: any): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const meta = response?.usageMetadata
            || response?.response?.usageMetadata
            || response?.candidates?.[0]?.usageMetadata
            || {};
  const promptTokens = Number(meta.promptTokenCount || 0);
  const completionTokens = Number(meta.candidatesTokenCount || 0);
  const totalTokens = Number(meta.totalTokenCount || (promptTokens + completionTokens));
  return { promptTokens, completionTokens, totalTokens };
}

export async function logTokenUsage(input: TokenUsageInput): Promise<void> {
  try {
    const promptTokens = Number(input.promptTokens || 0);
    const completionTokens = Number(input.completionTokens || 0);
    const totalTokens = Number(input.totalTokens || (promptTokens + completionTokens));

    if (totalTokens <= 0) {
      console.warn(`[TokenUsage] ⚠ totalTokens=0 — usageMetadata pode não ter vindo no response. Pulando insert.`);
      return;
    }
    const isReported = typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0;
    if (!isReported) await ensurePricing().catch(() => null);
    const cost = isReported ? Number(input.costUsd) : estimateCost(input.model, promptTokens, completionTokens, input.cachedTokens);
    const costStatus = isReported ? "reported" : cost === null ? "unknown" : "estimated";

    const { error } = await adminClient.from("ai_token_usage").insert({
      client_id: input.clientId || "00000000-0000-0000-0000-000000000001",
      source: input.source,
      source_id: input.sourceId != null ? String(input.sourceId) : null,
      source_label: input.sourceLabel || null,
      model: input.model || "unknown",
      provider: input.provider || "Gemini",
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cost_usd: cost,
      metadata: { ...input.metadata, cost_status: costStatus, cost_usd: cost, ...(input.cachedTokens !== undefined ? { cached_tokens: input.cachedTokens } : {}) },
    });
    if (error) {
      // 42P01 = tabela ainda não existe (rodar SETUP_COMPLETO.sql)
      if ((error as any).code === "42P01") {
        console.error("[TokenUsage] ❌ TABELA ai_token_usage NÃO EXISTE NO BANCO. Vai em Configurações → Setup do Banco e roda o SQL.");
      } else {
        console.error("[TokenUsage] Falha ao gravar:", error.message, "| code=", (error as any).code);
      }
    }
  } catch (err: any) {
    console.error("[TokenUsage] erro inesperado:", err?.message);
  }
}
