/**
 * Roteador Inteligente Free-First em Tempo Real (Zero-Hardcode & Future-Proof).
 *
 * Princípios de engenharia:
 * 1. SOBERANIA DO SELETOR: nunca substitui o modelo titular escolhido pelo usuário
 *    enquanto ele estiver operando normalmente — atua como motor de falha/failover
 *    (ou quando o usuário seleciona explicitamente `auto:free` / `auto:free-fast`).
 * 2. AUTO-AVALIAÇÃO À PROVA DO FUTURO: pontua qualquer modelo gratuito descoberto
 *    em tempo real nos catálogos (OpenRouter `/api/v1/models`, NVIDIA NIM + NGC
 *    Free Endpoints e Gateway de Assinatura) usando metadados objetivos da API
 *    (`supported_parameters`, `context_length`, `max_completion_tokens`, `created`,
 *    `usageCount`, arquitetura MoE/densa) — novos modelos lançados no futuro entram
 *    automaticamente no topo sem alterar código.
 * 3. SAÚDE EM TEMPO REAL SEPARADA POR ESCOPO:
 *    - Erro fatal do MODELO (`unavailable for free`, `404`, `no endpoints found`,
 *      `not a valid model id`) coloca o MODELO em quarentena imediata (sem gastar
 *      tentativas repetidas nas outras chaves do mesmo provedor).
 *    - Telemetria EWMA em memória aprende latência real e taxa de respostas vazias,
 *      promovendo quem está mais rápido e confiável naquele minuto.
 *    - Chaves sem saldo (`Insufficient credits`) são memorizadas como `freeOnly`
 *      para nunca desperdiçar tempo tentando fallback pago nelas.
 * 4. ISOLAMENTO DO RAG: este módulo governa exclusivamente chat/geração textual;
 *    modelos de embeddings da base de conhecimento (`rag.ts`) nunca são alterados.
 */

import {
  getCachedOpenRouterModels,
  isFreePricing,
  listAvailableOpenRouterModels,
  type OpenRouterModel,
} from "@/lib/openrouter-model-discovery";
import {
  getCachedNvidiaModels,
  listAvailableNvidiaModels,
  type NvidiaModel,
} from "@/lib/nvidia-model-discovery";
import {
  getCachedGatewayModels,
  listAvailableGatewayModels,
  type GatewayModel,
} from "@/lib/gateway-model-discovery";

export const AUTO_FREE_PREFIX = "auto:";
export const AUTO_FREE_MODEL_REF = "auto:free";
export const AUTO_FREE_FAST_MODEL_REF = "auto:free-fast";

export type AiTaskProfile = "agent" | "general" | "fast";

export type FreeSourceProvider = "openrouter" | "nvidia" | "gateway";

export interface FreeCandidateInput {
  provider: FreeSourceProvider;
  rawId: string;
  name: string;
  description?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  created?: number;
  usageCount?: number;
  supportsTools: boolean;
  supportsStructuredOutputs?: boolean;
  supportsReasoning?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
}

export interface RankedFreeCandidate extends FreeCandidateInput {
  modelRef: string;
  estimatedBillions: number;
  activeBillions: number | null;
  isReasoningHeavy: boolean;
  intelligenceScore: number;
  liveHealthDelta: number;
  totalScore: number;
}

interface ModelLiveHealth {
  quarantinedUntil: number;
  quarantineReason?: string;
  cooldownUntil: number;
  ewmaLatencyMs: number | null;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  emptyResponseCount: number;
  lastUpdatedAt: number;
}

const MODEL_HEALTH = new Map<string, ModelLiveHealth>();
const FREE_ONLY_KEYS = new Map<string, number>();
const PROVIDER_UNREACHABLE = new Map<string, number>();

const DEFAULT_MODEL_QUARANTINE_MS = 45 * 60 * 1000; // 45 min para modelo removido/pago
const DEFAULT_MODEL_COOLDOWN_MS = 90 * 1000;        // 90s inicial para sobrecarga global
const MAX_MODEL_COOLDOWN_MS = 15 * 60 * 1000;       // teto 15 min
const FREE_ONLY_KEY_TTL_MS = 60 * 60 * 1000;        // 1h sem retestar pago em chave zerada
const PROVIDER_UNREACHABLE_TTL_MS = 3 * 60 * 1000;  // 3 min sem travar em DNS/rede morta

const DISQUALIFIED_MODEL_REGEX =
  /\b(embed|embedding|rerank|bge-|whisper|tts|stt|voicechat|guard|moderation|safety|shield|reward|clip|diffusion|sdxl|flux|imagen|audio-only|vision-only)\b/i;

const UNSTABLE_FINE_TUNE_REGEX =
  /\b(roleplay|uncensored|abliterated|nsfw|erotica|lumimaid|mythomax|venice-edition)\b/i;

const REASONING_HEAVY_REGEX =
  /(?:^|[\/\-_:])(r1|r2|qwq|qvq|reasoner|reasoning|thinking|z1|o1|o3)(?:$|[\/\-_:.])/i;

function normalizeHealthKey(provider: string, rawModel: string): string {
  return `${provider.trim().toLowerCase()}::${rawModel.trim().toLowerCase()}`;
}

export function isAutoFreeModelRef(ref: string | null | undefined): boolean {
  const clean = (ref || "").trim().toLowerCase();
  return clean === AUTO_FREE_MODEL_REF || clean === AUTO_FREE_FAST_MODEL_REF || clean.startsWith(AUTO_FREE_PREFIX);
}

export function profileFromAutoModelRef(
  ref: string | null | undefined,
  fallbackProfile: AiTaskProfile = "general",
): AiTaskProfile {
  const clean = (ref || "").trim().toLowerCase();
  if (clean === AUTO_FREE_FAST_MODEL_REF || clean.endsWith("fast")) return "fast";
  if (clean === AUTO_FREE_MODEL_REF) return fallbackProfile;
  return fallbackProfile;
}

/**
 * Extrai escala estimada de parâmetros (em bilhões) de qualquer modelo atual ou futuro.
 * Suporta arquiteturas MoE (`550b-a55b`, `235b-a22b`, `8x22b`) e densas (`70b`, `32b`),
 * além de inferência semântica de tier quando o slug não expõe números.
 */
export function extractModelParameterBillions(
  id: string,
  name?: string,
  description?: string,
): { totalBillions: number; activeBillions: number | null } {
  const primaryText = `${id} ${name || ""}`.toLowerCase();
  const fullText = `${primaryText} ${(description || "").slice(0, 240)}`.toLowerCase();

  // 1) Padrão MoE explícito: "550b-a55b", "235b-a22b", "30b-a3b"
  const moeMatch = primaryText.match(/(?:^|[^a-z0-9])(\d{1,4}(?:\.\d+)?)b[-_ ]a(\d{1,3}(?:\.\d+)?)b(?:$|[^a-z0-9])/i);
  if (moeMatch) {
    const total = parseFloat(moeMatch[1]);
    const active = parseFloat(moeMatch[2]);
    if (Number.isFinite(total) && total > 0) {
      return {
        totalBillions: total,
        activeBillions: Number.isFinite(active) && active > 0 ? active : null,
      };
    }
  }

  // 2) Padrão Mixtral-style MoE: "8x22b", "8x7b"
  const mixMatch = primaryText.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3}(?:\.\d+)?)b(?:$|[^a-z0-9])/i);
  if (mixMatch) {
    const experts = parseFloat(mixMatch[1]);
    const perExpert = parseFloat(mixMatch[2]);
    if (Number.isFinite(experts) && Number.isFinite(perExpert) && experts > 1 && perExpert > 0) {
      return {
        totalBillions: Math.round(experts * perExpert * 0.85 * 10) / 10,
        activeBillions: Math.round(perExpert * 2 * 10) / 10,
      };
    }
  }

  // 3) Padrão denso explícito no ID/nome (pega o maior valor válido para evitar confundir versão tipo "v2")
  const explicitMatches = [...primaryText.matchAll(/(?:^|[^a-z0-9])(\d{1,4}(?:\.\d+)?)b(?:$|[^a-z0-9])/gi)];
  const parsedSizes = explicitMatches
    .map((m) => parseFloat(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0.5 && n <= 2500);
  if (parsedSizes.length > 0) {
    return { totalBillions: Math.max(...parsedSizes), activeBillions: null };
  }

  // 4) Busca secundária na descrição curta ("70 billion parameters" / "70B")
  const descMatch = fullText.match(/\b(\d{1,4}(?:\.\d+)?)\s*(?:b|billion)\s*(?:param|par[aâ]metro)/i);
  if (descMatch) {
    const val = parseFloat(descMatch[1]);
    if (Number.isFinite(val) && val >= 0.5 && val <= 2500) {
      return { totalBillions: val, activeBillions: null };
    }
  }

  // 5) Inferência semântica à prova do futuro quando o provedor omite "XXb" no slug
  if (/\b(ultra|opus|behemoth|max|large|maverick|sonnet|pro|gpt-5|gpt-4o|deepseek-v[3-9]|deepseek-chat|kimi-k[2-9]|glm-[4-9])\b/i.test(primaryText)) {
    return { totalBillions: 120, activeBillions: null };
  }
  if (/\b(super|plus|medium|scout|flash|small|haiku|lightning|note|instruct|chat)\b/i.test(primaryText)) {
    return { totalBillions: 32, activeBillions: null };
  }
  if (/\b(mini|lite|nano|micro|tiny)\b/i.test(primaryText)) {
    return { totalBillions: 9, activeBillions: null };
  }

  return { totalBillions: 24, activeBillions: null };
}

export function isReasoningHeavyModel(
  id: string,
  name?: string,
  supportsReasoning?: boolean,
): boolean {
  const text = `${id} ${name || ""}`.toLowerCase();
  if (REASONING_HEAVY_REGEX.test(text)) return true;
  if (/nemotron-[0-9.]+-ultra/i.test(text)) return true;
  if (supportsReasoning && /\b(ultra|reason|think)\b/i.test(text)) return true;
  return false;
}

/**
 * Calcula o Score de Inteligência (0 a 100, ou -1 se desqualificado) para um candidato gratuito.
 */
export function scoreFreeModelCandidate(
  candidate: FreeCandidateInput,
  opts?: {
    profile?: AiTaskProfile;
    requireTools?: boolean;
    requireJson?: boolean;
    nowSec?: number;
  },
): number {
  const profile = opts?.profile || "general";
  const requireTools = Boolean(opts?.requireTools);
  const requireJson = Boolean(opts?.requireJson);
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);

  const combinedId = `${candidate.rawId} ${candidate.name || ""}`;
  if (!candidate.rawId.trim() || DISQUALIFIED_MODEL_REGEX.test(combinedId)) {
    return -1;
  }

  if (
    Array.isArray(candidate.outputModalities) &&
    candidate.outputModalities.length > 0 &&
    !candidate.outputModalities.includes("text")
  ) {
    return -1;
  }

  const { totalBillions, activeBillions } = extractModelParameterBillions(
    candidate.rawId,
    candidate.name,
    candidate.description,
  );

  // Desqualifica modelos ultra-pequenos incapazes de seguir prompt complexo de SDR
  const minBillions = profile === "fast" ? 3 : 7;
  if (totalBillions < minBillions) {
    return -1;
  }

  let score = 0;

  // 1) Escala de parâmetros (0..42 pontos)
  const effectiveScale = activeBillions
    ? Math.max(activeBillions * 2.4, totalBillions * 0.75)
    : totalBillions;

  if (effectiveScale >= 200) score += 42;
  else if (effectiveScale >= 100) score += 38;
  else if (effectiveScale >= 65) score += 34;
  else if (effectiveScale >= 30) score += 28;
  else if (effectiveScale >= 20) score += 23;
  else if (effectiveScale >= 12) score += 17;
  else score += 11;

  // 2) Janela de contexto + teto de saída (0..16 pontos)
  const ctx = candidate.contextLength || 0;
  if (ctx >= 256_000) score += 12;
  else if (ctx >= 128_000) score += 10;
  else if (ctx >= 64_000) score += 7;
  else if (ctx >= 32_000) score += 5;
  else if (ctx > 0 && ctx < 16_000) score -= 8;

  const maxOut = candidate.maxCompletionTokens || 0;
  if (maxOut >= 16_384) score += 4;
  else if (maxOut >= 8_192) score += 2;

  // 3) Capacidades reais reportadas pela API (tools + JSON estruturado)
  if (candidate.supportsTools) {
    score += 14;
  } else if (requireTools) {
    score -= 35;
  }

  if (candidate.supportsStructuredOutputs) {
    score += requireJson ? 10 : 5;
  }

  // 4) Atualidade de lançamento (`created` OpenRouter) e adoção real (`usageCount` NGC) (0..12 pontos)
  if (typeof candidate.created === "number" && candidate.created > 1_650_000_000) {
    const ageDays = Math.max(0, (nowSec - candidate.created) / 86_400);
    if (ageDays <= 90) score += 10;
    else if (ageDays <= 180) score += 8;
    else if (ageDays <= 365) score += 5;
    else if (ageDays <= 540) score += 2;
  }

  if (typeof candidate.usageCount === "number" && candidate.usageCount > 0) {
    if (candidate.usageCount >= 100_000) score += 10;
    else if (candidate.usageCount >= 20_000) score += 7;
    else if (candidate.usageCount >= 2_000) score += 4;
    else score += 2;
  }

  // Gateway conectado (assinatura/conta local ativa) tem alta estabilidade e custo marginal $0
  if (candidate.provider === "gateway") {
    score += 8;
  }

  // 5) Ajuste por Perfil de Tarefa (Agente/Geral vs Avaliadores Rápidos)
  const reasoningHeavy = isReasoningHeavyModel(
    candidate.rawId,
    candidate.name,
    candidate.supportsReasoning,
  );

  if (profile === "fast") {
    if (reasoningHeavy) {
      // Modelos que gastam segundos/tokens em thinking oculto atrapalham SIM/NAO e resumos curtos
      score -= 32;
    } else if (totalBillions >= 12 && totalBillions <= 90) {
      score += 14;
    }
    if (/\b(flash|lightning|small|mini|haiku|instant|instruct|it)\b/i.test(combinedId) && !reasoningHeavy) {
      score += 8;
    }
  } else {
    // Em atendimento comercial com ferramentas, modelos puramente "R1" sem suporte a tools já perdem pontos;
    // modelos híbridos grandes ganham leve bônus de raciocínio
    if (reasoningHeavy && candidate.supportsTools) {
      score += 3;
    }
  }

  // 6) Penalidade forte para fine-tunes instáveis / roleplay / preview experimental antigo
  if (UNSTABLE_FINE_TUNE_REGEX.test(combinedId)) {
    score -= 40;
  }

  return Math.max(1, Math.min(100, Math.round(score)));
}

// ============================================================================
// TELEMETRIA AO VIVO & QUARENTENA SEPARADA POR MODELO / CHAVE / PROVEDOR
// ============================================================================

/**
 * Identifica erros globais do MODELO (onde testar o mesmo modelo em outra chave
 * do mesmo provedor só queimaria latência à toa).
 */
export function isModelLevelFatalError(status: number, message?: string): boolean {
  const msg = (message || "").toLowerCase();
  if (status === 404) return true;
  if (
    /unavailable for free|not a valid model id|no endpoints found|no available providers|model .* not found|model .* deprecated|decommissioned|only available on agentic harnesses|does not exist/i.test(
      msg,
    )
  ) {
    // Preserva os testes que usam HTTP 400 genérico "invalid model" / "invalid payload" como erro de request do cliente
    if (status === 400 && /^\s*invalid (model|payload|request)/i.test(msg)) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Identifica erro de falta de saldo/créditos para modelos pagos numa chave específica
 * (essa chave continua servindo modelos `:free`, mas não deve ser usada em fallback pago).
 */
export function isCreditExhaustedOnKeyError(status: number, message?: string): boolean {
  const msg = (message || "").toLowerCase();
  if (status === 402 && /insufficient credits|never purchased credits|add more credits|requires more credits/i.test(msg)) {
    return true;
  }
  if (/never purchased credits|settings\/credits|insufficient credits/i.test(msg)) {
    return true;
  }
  return false;
}

function getOrCreateHealth(provider: string, rawModel: string): ModelLiveHealth {
  const key = normalizeHealthKey(provider, rawModel);
  let entry = MODEL_HEALTH.get(key);
  if (!entry) {
    entry = {
      quarantinedUntil: 0,
      cooldownUntil: 0,
      ewmaLatencyMs: null,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      emptyResponseCount: 0,
      lastUpdatedAt: Date.now(),
    };
    MODEL_HEALTH.set(key, entry);
  }
  return entry;
}

export function markModelQuarantined(
  provider: string,
  rawModel: string,
  reason?: string,
  ttlMs = DEFAULT_MODEL_QUARANTINE_MS,
): void {
  if (!provider || !rawModel) return;
  const h = getOrCreateHealth(provider, rawModel);
  h.quarantinedUntil = Math.max(h.quarantinedUntil, Date.now() + ttlMs);
  h.quarantineReason = reason;
  h.lastUpdatedAt = Date.now();
}

export function markModelTemporaryCooldown(
  provider: string,
  rawModel: string,
  ttlMs = DEFAULT_MODEL_COOLDOWN_MS,
): void {
  if (!provider || !rawModel) return;
  const now = Date.now();
  const h = getOrCreateHealth(provider, rawModel);
  if (h.cooldownUntil > now) {
    h.cooldownUntil = Math.min(now + MAX_MODEL_COOLDOWN_MS, now + (h.cooldownUntil - now) * 2 + ttlMs);
  } else {
    h.cooldownUntil = now + ttlMs;
  }
  h.lastUpdatedAt = now;
}

export function isModelUnavailable(provider: string, rawModel: string): boolean {
  if (!provider || !rawModel) return false;
  const h = MODEL_HEALTH.get(normalizeHealthKey(provider, rawModel));
  if (!h) return false;
  const now = Date.now();
  return h.quarantinedUntil > now || h.cooldownUntil > now;
}

export function isModelQuarantined(provider: string, rawModel: string): boolean {
  if (!provider || !rawModel) return false;
  const h = MODEL_HEALTH.get(normalizeHealthKey(provider, rawModel));
  return Boolean(h && h.quarantinedUntil > Date.now());
}

export function recordModelSuccess(provider: string, rawModel: string, latencyMs: number): void {
  if (!provider || !rawModel) return;
  const h = getOrCreateHealth(provider, rawModel);
  const cleanLatency = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 1500;
  h.ewmaLatencyMs =
    h.ewmaLatencyMs === null
      ? cleanLatency
      : Math.round(h.ewmaLatencyMs * 0.65 + cleanLatency * 0.35);
  h.successCount += 1;
  h.consecutiveFailures = 0;
  h.cooldownUntil = 0;
  h.lastUpdatedAt = Date.now();
}

export function recordModelFailure(
  provider: string,
  rawModel: string,
  opts?: { isEmpty?: boolean; isTimeout?: boolean; status?: number; message?: string },
): void {
  if (!provider || !rawModel) return;
  const h = getOrCreateHealth(provider, rawModel);
  h.failureCount += 1;
  h.consecutiveFailures += 1;
  if (opts?.isEmpty) h.emptyResponseCount += 1;
  h.lastUpdatedAt = Date.now();

  if (opts?.status !== undefined && isModelLevelFatalError(opts.status, opts.message)) {
    markModelQuarantined(provider, rawModel, opts.message);
    return;
  }

  // Se o modelo deu 2+ falhas/respostas vazias seguidas, esfria o modelo inteiro para subir o próximo :free
  if (h.consecutiveFailures >= 2 || (opts?.isTimeout && h.consecutiveFailures >= 1)) {
    markModelTemporaryCooldown(provider, rawModel);
  }
}

export function computeLiveHealthDelta(
  provider: string,
  rawModel: string,
  profile: AiTaskProfile = "general",
): number {
  const h = MODEL_HEALTH.get(normalizeHealthKey(provider, rawModel));
  if (!h) return 0;

  let delta = 0;
  if (h.successCount > 0) {
    delta += Math.min(8, h.successCount * 2);
  }
  if (h.ewmaLatencyMs !== null) {
    const fastWeight = profile === "fast" ? 1.5 : 1;
    if (h.ewmaLatencyMs <= 2000) delta += Math.round(12 * fastWeight);
    else if (h.ewmaLatencyMs <= 4500) delta += Math.round(6 * fastWeight);
    else if (h.ewmaLatencyMs >= 18000) delta -= Math.round(12 * fastWeight);
    else if (h.ewmaLatencyMs >= 10000) delta -= Math.round(6 * fastWeight);
  }
  if (h.consecutiveFailures > 0) {
    delta -= h.consecutiveFailures * 16;
  }
  if (h.emptyResponseCount > 0) {
    delta -= Math.min(20, h.emptyResponseCount * 6);
  }
  return delta;
}

export function markKeyFreeOnly(rawKey: string, ttlMs = FREE_ONLY_KEY_TTL_MS): void {
  const k = (rawKey || "").trim();
  if (!k) return;
  FREE_ONLY_KEYS.set(k, Date.now() + ttlMs);
}

export function isKeyFreeOnly(rawKey: string): boolean {
  const k = (rawKey || "").trim();
  if (!k) return false;
  const until = FREE_ONLY_KEYS.get(k);
  if (!until) return false;
  if (Date.now() >= until) {
    FREE_ONLY_KEYS.delete(k);
    return false;
  }
  return true;
}

export function areAllOpenRouterKeysFreeOnly(keys: Array<string | null | undefined>): boolean {
  const clean = keys.map((k) => String(k || "").trim()).filter(Boolean);
  if (clean.length === 0) return false;
  return clean.every((k) => isKeyFreeOnly(k));
}

export function markProviderUnreachable(provider: string, ttlMs = PROVIDER_UNREACHABLE_TTL_MS): void {
  const p = (provider || "").trim().toLowerCase();
  if (!p) return;
  PROVIDER_UNREACHABLE.set(p, Date.now() + ttlMs);
}

export function isProviderUnreachable(provider: string): boolean {
  const p = (provider || "").trim().toLowerCase();
  if (!p) return false;
  const until = PROVIDER_UNREACHABLE.get(p);
  if (!until) return false;
  if (Date.now() >= until) {
    PROVIDER_UNREACHABLE.delete(p);
    return false;
  }
  return true;
}

export function resetSmartRouterHealth(): void {
  MODEL_HEALTH.clear();
  FREE_ONLY_KEYS.clear();
  PROVIDER_UNREACHABLE.clear();
}

const RESET_HOOKS_SYM = Symbol.for("painel_sdr.ai_cooldown_reset_hooks");
const gHooks = globalThis as Record<symbol, unknown>;
if (!(gHooks[RESET_HOOKS_SYM] instanceof Set)) {
  gHooks[RESET_HOOKS_SYM] = new Set<() => void>();
}
(gHooks[RESET_HOOKS_SYM] as Set<() => void>).add(resetSmartRouterHealth);

// ============================================================================
// DESCOBERTA UNIFICADA & RANKING INTERCALADO MULTI-PROVEDOR
// ============================================================================

function openRouterToFreeCandidate(m: OpenRouterModel): FreeCandidateInput | null {
  const free = m.isFree ?? isFreePricing(m.pricing);
  if (!free) return null;
  return {
    provider: "openrouter",
    rawId: m.id,
    name: m.name,
    description: m.description,
    contextLength: m.contextLength,
    maxCompletionTokens: m.maxCompletionTokens,
    created: m.created,
    supportsTools: m.supportsTools,
    supportsStructuredOutputs: m.supportsStructuredOutputs,
    supportsReasoning: m.supportsReasoning,
    inputModalities: m.inputModalities,
    outputModalities: m.outputModalities,
  };
}

function nvidiaToFreeCandidate(m: NvidiaModel): FreeCandidateInput | null {
  if (!m.isFreeEndpoint || m.available === false) return null;
  return {
    provider: "nvidia",
    rawId: m.id,
    name: m.name,
    description: m.description,
    contextLength: m.contextLength,
    usageCount: m.usageCount,
    supportsTools: m.supportsTools,
  };
}

function gatewayToFreeCandidate(m: GatewayModel): FreeCandidateInput {
  return {
    provider: "gateway",
    rawId: m.id,
    name: m.name,
    supportsTools: m.supportsTools,
    contextLength: 128_000,
  };
}

function formatCandidateRef(provider: FreeSourceProvider, rawId: string): string {
  return `${provider}:${rawId}`;
}

/**
 * Intercala provedores competitivos nos primeiros degraus para que um rate-limit
 * global ou instabilidade em um provedor atravesse imediatamente para outro.
 */
function interleaveByProvider(sorted: RankedFreeCandidate[], maxResults: number): RankedFreeCandidate[] {
  if (sorted.length <= 1) return sorted.slice(0, maxResults);

  const buckets = new Map<FreeSourceProvider, RankedFreeCandidate[]>();
  for (const item of sorted) {
    const arr = buckets.get(item.provider) || [];
    arr.push(item);
    buckets.set(item.provider, arr);
  }

  // Se só há 1 provedor disponível, mantém ranking estrito de score
  if (buckets.size <= 1) {
    return sorted.slice(0, maxResults);
  }

  const out: RankedFreeCandidate[] = [];
  const usedRefs = new Set<string>();

  // 1º degrau: melhor absoluto geral
  const first = sorted[0];
  out.push(first);
  usedRefs.add(first.modelRef);

  // 2º degrau: melhor candidato competitivo de OUTRO provedor (se score razoável >= 35)
  for (const [prov, list] of buckets.entries()) {
    if (prov === first.provider || list.length === 0) continue;
    const bestAlt = list[0];
    if (bestAlt.totalScore >= 35 && !usedRefs.has(bestAlt.modelRef)) {
      out.push(bestAlt);
      usedRefs.add(bestAlt.modelRef);
      break;
    }
  }

  // Demais degraus: segue score total limitando no máx 3 por provedor antes de abrir espaço
  const perProviderCount = new Map<FreeSourceProvider, number>();
  for (const item of out) {
    perProviderCount.set(item.provider, (perProviderCount.get(item.provider) || 0) + 1);
  }

  for (const item of sorted) {
    if (out.length >= maxResults) break;
    if (usedRefs.has(item.modelRef)) continue;
    const count = perProviderCount.get(item.provider) || 0;
    if (count >= 3 && buckets.size > 1) continue;
    out.push(item);
    usedRefs.add(item.modelRef);
    perProviderCount.set(item.provider, count + 1);
  }

  // Completa até maxResults se ainda houver vagas
  if (out.length < maxResults) {
    for (const item of sorted) {
      if (out.length >= maxResults) break;
      if (usedRefs.has(item.modelRef)) continue;
      out.push(item);
      usedRefs.add(item.modelRef);
    }
  }

  return out;
}

export interface RankFreeModelsOptions {
  profile?: AiTaskProfile;
  requireTools?: boolean;
  requireJson?: boolean;
  excludeRefs?: string[];
  maxResults?: number;
  hasOpenRouter?: boolean;
  hasNvidia?: boolean;
  hasGateway?: boolean;
  /**
   * Em produção é true por padrão (consulta catálogo com cache de 10 min e timeout curto).
   * Em Vitest unitário genérico fica restrito ao cache já populado, exceto quando `allowLiveFetch: true`
   * ou ao resolver `auto:free` explícito — evitando chamadas `/models` inesperadas em mocks de `/chat/completions`.
   */
  allowLiveFetch?: boolean;
}

export async function rankFreeModelsFromCatalogs(
  opts: RankFreeModelsOptions = {},
): Promise<RankedFreeCandidate[]> {
  const profile = opts.profile || "general";
  const maxResults = Math.max(1, Math.min(12, opts.maxResults ?? 5));
  const isVitest = process.env.VITEST === "true";
  const shouldFetchLive = opts.allowLiveFetch ?? !isVitest;

  const allowOr = opts.hasOpenRouter !== false && !isProviderUnreachable("openrouter");
  const allowNv = opts.hasNvidia !== false && !isProviderUnreachable("nvidia");
  const allowGw = Boolean(opts.hasGateway) && !isProviderUnreachable("gateway");

  let orModels: OpenRouterModel[] = allowOr ? getCachedOpenRouterModels() : [];
  let nvModels: NvidiaModel[] = allowNv ? getCachedNvidiaModels() : [];
  let gwModels: GatewayModel[] = allowGw ? getCachedGatewayModels() : [];

  if (shouldFetchLive) {
    const tasks: Promise<void>[] = [];
    if (allowOr && orModels.length === 0) {
      tasks.push(
        listAvailableOpenRouterModels(false, false, 4000)
          .then((res) => {
            orModels = res;
          })
          .catch(() => {}),
      );
    }
    if (allowNv && nvModels.length === 0) {
      tasks.push(
        listAvailableNvidiaModels(false, 4000)
          .then((res) => {
            nvModels = res;
          })
          .catch(() => {}),
      );
    }
    if (allowGw && gwModels.length === 0) {
      tasks.push(
        listAvailableGatewayModels(false)
          .then((res) => {
            gwModels = res;
          })
          .catch(() => {}),
      );
    }
    if (tasks.length > 0) {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 4200);
          t.unref?.();
        }),
      ]);
    }
  }

  const excluded = new Set(
    (opts.excludeRefs || []).map((r) => r.trim().toLowerCase()).filter(Boolean),
  );

  const rawCandidates: FreeCandidateInput[] = [];
  if (allowOr) {
    for (const m of orModels) {
      const c = openRouterToFreeCandidate(m);
      if (c) rawCandidates.push(c);
    }
  }
  if (allowNv) {
    for (const m of nvModels) {
      const c = nvidiaToFreeCandidate(m);
      if (c) rawCandidates.push(c);
    }
  }
  if (allowGw) {
    for (const m of gwModels) {
      rawCandidates.push(gatewayToFreeCandidate(m));
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const scored: RankedFreeCandidate[] = [];

  for (const c of rawCandidates) {
    const modelRef = formatCandidateRef(c.provider, c.rawId);
    if (excluded.has(modelRef.toLowerCase()) || excluded.has(c.rawId.toLowerCase())) {
      continue;
    }
    if (isModelUnavailable(c.provider, c.rawId)) {
      continue;
    }

    const intelligenceScore = scoreFreeModelCandidate(c, {
      profile,
      requireTools: opts.requireTools,
      requireJson: opts.requireJson,
      nowSec,
    });
    if (intelligenceScore < 0) continue;

    const liveHealthDelta = computeLiveHealthDelta(c.provider, c.rawId, profile);
    const totalScore = Math.max(1, intelligenceScore + liveHealthDelta);
    const { totalBillions, activeBillions } = extractModelParameterBillions(
      c.rawId,
      c.name,
      c.description,
    );

    scored.push({
      ...c,
      modelRef,
      estimatedBillions: totalBillions,
      activeBillions,
      isReasoningHeavy: isReasoningHeavyModel(c.rawId, c.name, c.supportsReasoning),
      intelligenceScore,
      liveHealthDelta,
      totalScore,
    });
  }

  scored.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (b.intelligenceScore !== a.intelligenceScore) return b.intelligenceScore - a.intelligenceScore;
    return b.estimatedBillions - a.estimatedBillions;
  });

  return interleaveByProvider(scored, maxResults);
}

/**
 * Retorna o #1 melhor `modelRef` gratuito saudável no catálogo ao vivo agora.
 */
export async function pickBestFreeModelRef(opts: RankFreeModelsOptions = {}): Promise<string | null> {
  const ranked = await rankFreeModelsFromCatalogs({ ...opts, maxResults: 1 });
  return ranked[0]?.modelRef || null;
}
