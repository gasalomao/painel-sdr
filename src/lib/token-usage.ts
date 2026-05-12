/**
 * Token usage tracking — registra cada chamada de IA no banco pra a página /tokens
 * conseguir exibir consumo por feature, agente, modelo, dia, etc.
 *
 * Retorna void e nunca lança — falha de log NÃO pode quebrar a feature.
 */

import { supabaseAdmin } from "@/lib/supabase";
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
  metadata?: Record<string, any>;
}

/**
 * Custo agora vem de `lib/pricing.ts` — fonte online (LiteLLM JSON), com cache.
 * Mantemos só este wrapper sync que assume o cache já populado.
 */
function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const price = lookupPriceSync(model);
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

    // LOG DEBUG SEMPRE — ajuda a entender se o tracking está chegando aqui
    console.log(
      `[TokenUsage] source=${input.source} label=${input.sourceLabel || "?"} model=${input.model} ` +
      `prompt=${promptTokens} completion=${completionTokens} total=${totalTokens}`
    );

    if (totalTokens <= 0) {
      console.warn(`[TokenUsage] ⚠ totalTokens=0 — usageMetadata pode não ter vindo no response. Pulando insert.`);
      return;
    }
    // Garante que o cache de preços esteja populado (no-op depois da 1ª vez por 6h)
    await ensurePricing().catch(() => null);
    const cost = estimateCost(input.model, promptTokens, completionTokens);

    const { error } = await adminClient.from("ai_token_usage").insert({
      source: input.source,
      source_id: input.sourceId != null ? String(input.sourceId) : null,
      source_label: input.sourceLabel || null,
      model: input.model || "unknown",
      provider: input.provider || "Gemini",
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cost_usd: cost,
      metadata: input.metadata || {},
    });
    if (error) {
      // 42P01 = tabela ainda não existe (rodar SETUP_COMPLETO.sql)
      if ((error as any).code === "42P01") {
        console.error("[TokenUsage] ❌ TABELA ai_token_usage NÃO EXISTE NO BANCO. Vai em Configurações → Setup do Banco e roda o SQL.");
      } else {
        console.error("[TokenUsage] Falha ao gravar:", error.message, "| code=", (error as any).code);
      }
    } else {
      console.log(`[TokenUsage] ✓ Gravado no banco: ${totalTokens} tokens (~$${cost.toFixed(6)})`);
    }
  } catch (err: any) {
    console.error("[TokenUsage] erro inesperado:", err?.message);
  }
}
