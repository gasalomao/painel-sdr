/**
 * Camada UNIFICADA de provedores de IA — Gemini + OpenRouter + Gateway de Assinatura.
 *
 * Objetivo: TODO o sistema que antes só falava com o Gemini agora pode usar
 * qualquer modelo do OpenRouter (Claude, GPT, Llama, etc.) OU a sua CONTA/
 * ASSINATURA (ChatGPT, Claude Pro/Max, Gemini) via um proxy local — em TEMPO
 * REAL, só trocando o modelo escolhido no seletor. Sem hardcode de modelos.
 *
 * Como o "modelo" carrega o provedor (modelRef):
 *   - "gemini-2.5-flash"                       → Gemini (formato LEGADO, ainda válido)
 *   - "gemini:gemini-2.5-flash"                → Gemini (explícito, via API key AI Studio)
 *   - "openrouter:anthropic/claude-3.5-sonnet" → OpenRouter (API key)
 *   - "gateway:gpt-5.5"                         → Gateway de Assinatura (sua conta)
 *   - "gateway:claude-sonnet-4"                → Gateway de Assinatura (sua conta)
 *   - "gateway:gemini-2.5-pro"                 → Gateway de Assinatura (sua conta)
 *
 * O GATEWAY fala o MESMO protocolo do OpenRouter (OpenAI-compatible
 * /chat/completions), só muda a baseURL — então tool-calling, contagem de
 * token e preservação de contexto são exatamente os mesmos. Quem traduz pra
 * cada back-end de assinatura é o proxy (ex: CLIProxyAPI), que segura o login
 * OAuth da sua conta. Veja docs/GATEWAY_ASSINATURA.md.
 *
 * Compatibilidade: tudo que já estava salvo no banco (ex: "gemini-2.5-flash")
 * continua funcionando — sem prefixo = Gemini.
 *
 * Duas APIs públicas:
 *   1) generateText(...)  — chamada única (resumo, follow-up, organizador…).
 *   2) startAiChat(...)   — sessão de chat com FERRAMENTAS (o Agente SDR),
 *      abstraindo a diferença entre o function-calling do Gemini e o
 *      tool-calling (OpenAI-compatible) do OpenRouter.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { pickBestFlashModel } from "@/lib/gemini-model-discovery";
import { isDeadModelError } from "@/lib/gemini-call";
import { COMBO_PREFIX, resolveComboSteps } from "@/lib/ai-combos";
import {
  AUTO_FREE_PREFIX,
  areAllOpenRouterKeysFreeOnly,
  isAutoFreeModelRef,
  isCreditExhaustedOnKeyError,
  isModelLevelFatalError,
  isModelQuarantined,
  isProviderUnreachable,
  markKeyFreeOnly,
  markProviderUnreachable,
  profileFromAutoModelRef,
  rankFreeModelsFromCatalogs,
  recordModelFailure,
  recordModelSuccess,
  type AiTaskProfile,
} from "@/lib/ai-smart-free-router";

/**
 * Timeout por chamada de IA — sem isso um gateway/proxy pendurado bloqueia a
 * cadeia inteira (webhook → agent/process → tool loop) indefinidamente.
 * Configurável via env; 45s cobre modelos lentos com thinking sem travar o
 * webhook por minutos.
 */
export const AI_CALL_TIMEOUT_MS = Number(process.env.AI_CALL_TIMEOUT_MS) || 45_000;

/** Corre com timeout: rejeita se `p` não resolver em AI_CALL_TIMEOUT_MS. */
export function withAiTimeout<T>(p: Promise<T>, label = "IA"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: timeout após ${AI_CALL_TIMEOUT_MS}ms`)),
      AI_CALL_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export type AiProvider = "gemini" | "openrouter" | "gateway" | "combo" | "nvidia";

export interface ModelRef {
  provider: AiProvider;
  /** id "cru" pro SDK/API do provedor (sem o prefixo do provedor). */
  model: string;
}

export const OPENROUTER_PREFIX = "openrouter:";
export const GEMINI_PREFIX = "gemini:";
export const NVIDIA_PREFIX = "nvidia:";
/**
 * Gateway de ASSINATURA — proxy local OpenAI-compatible (ex: CLIProxyAPI) que
 * conversa com a sua CONTA logada (ChatGPT / Claude Pro-Max / Gemini) em vez de
 * gastar API key paga. O proxy decide a conta/back-end pelo nome do modelo.
 */
export const GATEWAY_PREFIX = "gateway:";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";

/**
 * Erro HTTP de provedor OpenAI-compatible (gateway/openrouter) que PRESERVA o
 * `status` — sem isso, antes só tínhamos uma string de mensagem e era impossível
 * distinguir "quota acabou/429" de "5xx temporário" de "credencial morta/401".
 * Esse distinção é o que viabiliza o FAILOVER entre contas: 429/quota → tenta
 * outra conta; 401/403 → marca morta e pula; 5xx/rede → só tenta outra.
 * Estende Error p/ retrocompat (quem faz catch como Error continua funcionando).
 */
export class ProviderHttpError extends Error {
  status: number;
  usage?: AiUsage;
  retryAfterMs?: number;
  /** Id da conexão/conta (quando aplicável) pra marcação de cooldown/morto. */
  endpointId?: string;
  constructor(status: number, message: string, endpointId?: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    if (endpointId) this.endpointId = endpointId;
  }
}

export class AiEmptyResponseError extends Error {
  provider: AiProvider;
  model: string;
  usage: AiUsage;
  completionTokens: number;

  constructor(provider: AiProvider, model: string, usage: AiUsage | number, cause?: unknown) {
    super(`${provider}:${model} retornou resposta vazia sem ferramentas.`);
    this.name = "AiEmptyResponseError";
    this.provider = provider;
    this.model = model;
    this.usage = typeof usage === "number"
      ? { promptTokens: 0, completionTokens: usage, totalTokens: usage }
      : usage;
    this.completionTokens = this.usage.completionTokens;
    if (cause !== undefined) Object.assign(this, { cause });
  }
}

/**
 * Decide se um erro (status) justifica FAILOVER pra outra conta conectada.
 *   - 429 / 402 / mensagem de quota → sim (esgotou o grátis hoje).
 *   - 401 / 403 → sim (credencial inválida/morta; marca e pula).
 *   - 5xx / rede (status 0) → sim (transitório; tenta outra).
 *   - 4xx outros (400 bad request…) → NÃO (erro do request, outra conta dará o
 *     mesmo erro — não adianta trocar).
 */
export function isFailoverableStatus(status: number, message?: string): boolean {
  if (status === 429 || status === 402) return true;
  if (status === 401 || status === 403) return true;
  if (status >= 500 || status === 0) return true;
  // 400 com mensagem de quota/limite (alguns proxies devolvem 400 em vez de 429).
  const m = (message || "").toLowerCase();
  if (status === 400 && /quota|rate.?limit|exhaust|insufficient|exceeded|too many requests/.test(m)) return true;
  return false;
}

/**
 * Normaliza o "modo de raciocínio" (0=Econômico, 1=Equilibrado, 2=Intenso) com
 * RETROCOMPAT do legado `thinkingBudget` (Gemini-only): se `reasoningMode` não
 * vier mas `thinkingBudget` sim, deriva dele (0→econômico, >0→equilibrado,
 * -1→intenso). Devolve sempre 0/1/2.
 */
export function resolveReasoningMode(mode?: 0 | 1 | 2 | 3 | null, thinkingBudget?: number | null): 0 | 1 | 2 | 3 {
  if (mode === 0 || mode === 1 || mode === 2 || mode === 3) return mode;
  if (thinkingBudget != null && Number.isFinite(thinkingBudget)) {
    if (thinkingBudget < 0) return 2;   // -1 dinâmico = intenso
    if (thinkingBudget > 0) return 1;   // 256 etc = equilibrado
    return 0;                           // 0 = econômico
  }
  return 0; // default: econômico (ideal pra SDR — raciocínio extra só sob demanda)
}

/**
 * Aplica o MODO DE RACIOCÍNIO no `body` da request, mapeando pro parâmetro
 * certo de cada provedor. UNIVERSAL — o mesmo seletor (Econômico/Equilibrado/
 * Intenso) funciona em qualquer modelo. Modelos sem suporte ignoram silencioso.
 *
 * Mapa (baseado na doc oficial de cada provedor, 2025/2026):
 *   - Gemini:         thinkingConfig.thinkingBudget (0 / 8192 / -1 dinâmico).
 *   - OpenAI (GPT-5): reasoning.effort ("minimal"/"medium"/"high"). Modelos não-
 *                     reasoning ignoram o campo sem erro.
 *   - Anthropic:      thinking.budget_tokens (1=interleaved, 2=high). Modelos
 *                     antigos ignoram.
 *   - DeepSeek:       não tem nível — o modelo é que muda (deepseek-reasoner).
 *                     Quem força é o roteador (não este body). Aqui só no-op.
 *
 * O mapeamento é DEFENSIVO: se um provedor rejeitar o campo (HTTP 400), o
 * startOpenAICompatibleChat já degrada pra chat puro (sem tools) e reenvia —
 * e o `applyReasoning` é chamado de novo no retry sem o campo de raciocínio.
 */
export function applyReasoning(
  body: Record<string, any>,
  mode: 0 | 1 | 2 | 3,
  provider: AiProvider,
  model: string,
): void {
  const m = (model || "").toLowerCase();
  // THINK MÁXIMO (mode 3): força max_tokens alto + temperatura otimizada em
  // qualquer provedor. Além do reasoning nativo, expande janela de saída pra
  // modelo usar toda inteligência disponível. Universal — nunca quebra provedor.
  if (mode === 3) {
    // Dobra max_tokens (ou seta 8k se vier 0/undefined) — modelo tem espaço pra
    // pensar + responder completo. ponytail: 8k cobre 99% casos; ampliar exige
    // checagem de limite por provedor.
    const cur = Number(body.max_tokens || body.max_completion_tokens || 0);
    if (cur < 8000) body.max_tokens = 8000;
    // Temperatura 0.7 = balanço criativo×preciso. Mode 3 prioriza qualidade.
    if (body.temperature == null) body.temperature = 0.7;
  }
  if (provider === "gemini") {
    // Gemini usa thinkingBudget no generationConfig (tratado à parte nas funções
    // Gemini). Aqui é no-op — o Gemini lê opts.reasoningMode direto.
    return;
  }
  // OpenAI-compatible (openrouter + gateway): ramos por família de modelo.
  if (/^(o1|o3|o4|gpt-5|gpt-4o-)/.test(m) || /openai/.test(m)) {
    body.reasoning = { effort: mode === 0 ? "minimal" : mode === 1 ? "medium" : (mode === 2 || mode === 3) ? "high" : "high" };
    return;
  }
  // Anthropic/Claude (via gateway OpenAI-compat — CLIProxyAPI traduz).
  if (/claude|anthropic/.test(m)) {
    if (mode === 0) {
      // Econômico: sem thinking explícito (Claude usa adaptive por padrão).
    } else if (mode === 3) {
      // THINK MÁXIMO: budget máximo Claude (32k tokens thinking).
      body.thinking = { type: "enabled", budget_tokens: 32000 };
    } else {
      body.thinking = { type: "enabled", budget_tokens: mode === 1 ? 4096 : 16000 };
    }
    return;
  }
  // DeepSeek / outros: sem nível de raciocínio no body. DeepSeek-reasoner é
  // acionado pelo modelRef, não por aqui. Mode 3 ainda expande max_tokens.
}

/**
 * Converte reasoningMode (0/1/2) em thinkingBudget do Gemini. Centraliza o
 * mapeamento pras funções Gemini (generateText + startGeminiChat).
 */
export function reasoningModeToThinkingBudget(mode: 0 | 1 | 2 | 3): number {
  if (mode === 3) return -1;   // THINK MÁXIMO — dinâmico + boost tokens (força máxima inteligência)
  if (mode === 2) return -1;   // intenso — dinâmico
  if (mode === 1) return 8192; // equilibrado
  return 0;                    // econômico (sem raciocínio extra)
}

/**
 * PROMPT CACHING — Anthropic/Claude via gateway.
 *
 * Claude suporta cache explícito do prefixo (system prompt) via `cache_control`.
 * Isso dá até ~90% de desconto nos tokens do systemInstruction quando ele se
 * repete entre chamadas (que é SEMPRE — a persona é a mesma por agente). O
 * CLIProxyAPI repassa o cache_control pro Anthropic ao traduzir o shape OpenAI.
 *
 * Como o sistema já mantém o systemInstruction byte-idêntico (implícit caching
 * do Gemini/OpenAI é automático), só precisamos DECLARAR o cache pro Claude.
 * Modelos não-Claude ignoram o campo extra sem erro (OpenAI-compat).
 *
 * Devolve a mensagem de system no shape Anthropic (array de blocos com
 * cache_control no último bloco do system) — só pra Claude. Outros mantêm string.
 */
export function buildSystemMessage(
  systemInstruction: string,
  provider: AiProvider,
  model: string,
): { role: "system"; content: any } {
  const m = (model || "").toLowerCase();
  // Só vale a pena pra Claude (tem cache_control explícito). OpenAI/Gemini já
  // cacheiam implicitamente o prefixo estável — não precisam declarar.
  if (provider !== "gateway" && provider !== "openrouter" && provider !== "nvidia") {
    return { role: "system", content: systemInstruction };
  }
  if (!/claude|anthropic/.test(m)) {
    return { role: "system", content: systemInstruction };
  }
  // Shape Anthropic: system como array de content blocks, último com cache_control.
  // O CLIProxyAPI espera esse formato quando o modelo é Claude.
  return {
    role: "system",
    content: [
      { type: "text", text: systemInstruction, cache_control: { type: "ephemeral" } },
    ],
  };
}

/**
 * Interpreta a string de modelo salva no banco e devolve { provider, model }.
 * Sem prefixo conhecido = Gemini (retrocompatível com tudo que já existe).
 */
export function parseModelRef(ref: string | null | undefined): ModelRef {
  const s = (ref || "").trim();
  if (!s) return { provider: "gemini", model: "" };
  if (s.toLowerCase().startsWith(AUTO_FREE_PREFIX)) {
    return { provider: "combo", model: s.toLowerCase() };
  }
  if (s.startsWith(COMBO_PREFIX)) {
    return { provider: "combo", model: s.slice(COMBO_PREFIX.length).trim() };
  }
  if (s.startsWith(GATEWAY_PREFIX)) {
    return { provider: "gateway", model: s.slice(GATEWAY_PREFIX.length).trim() };
  }
  if (s.startsWith(NVIDIA_PREFIX)) {
    return { provider: "nvidia", model: s.slice(NVIDIA_PREFIX.length).trim() };
  }
  if (s.startsWith(OPENROUTER_PREFIX)) {
    return { provider: "openrouter", model: s.slice(OPENROUTER_PREFIX.length).trim() };
  }
  if (s.startsWith(GEMINI_PREFIX)) {
    return { provider: "gemini", model: s.slice(GEMINI_PREFIX.length).trim() };
  }
  // bare → Gemini (legado). Normaliza prefixo "models/".
  const bare = s.toLowerCase().startsWith("models/") ? s.substring(7) : s;
  return { provider: "gemini", model: bare };
}

/** Monta a string de modelo pra salvar no banco a partir de provider + id cru. */
export function formatModelRef(provider: AiProvider, model: string): string {
  const m = (model || "").trim();
  if (provider === "combo") {
    if (m.toLowerCase().startsWith(AUTO_FREE_PREFIX)) return m.toLowerCase();
    return `${COMBO_PREFIX}${m}`;
  }
  if (provider === "nvidia") return `${NVIDIA_PREFIX}${m}`;
  if (provider === "openrouter") return `${OPENROUTER_PREFIX}${m}`;
  if (provider === "gateway") return `${GATEWAY_PREFIX}${m}`;
  return m; // Gemini fica "bare" pra retrocompatibilidade.
}

/** Atalho: só o provedor de um modelRef. */
export function providerOf(ref: string | null | undefined): AiProvider {
  return parseModelRef(ref).provider;
}

/**
 * Nome de exibição do provedor (pra logs, token-usage e UI). Centraliza o
 * rótulo pra que "gateway" não seja confundido com "Gemini" em lugar nenhum.
 */
export function providerDisplayName(p: AiProvider): string {
  if (p === "combo") return "Combo Virtual";
  if (p === "nvidia") return "NVIDIA NIM";
  if (p === "openrouter") return "OpenRouter";
  if (p === "gateway") return "Gateway";
  return "Gemini";
}

export interface AiUsageAttempt {
  provider: AiProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
  cachedTokens?: number;
  reasoningTokens?: number;
  cacheWriteTokens?: number;
  /** Ausente quando o provedor não reportou custo. Zero só se reportado. */
  costUsd?: number;
  /** Métricas ausentes/inválidas; não liquidar a reserva como zero comprovado. */
  usageUnknown?: boolean;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true quando o provedor não devolveu usage real (ex: DeepSeek via reverse
   *  sem métrica no SSE). Caller repasse pra metadata.estimated do logTokenUsage. */
  estimated?: boolean;
  /** Tokens de prompt atendidos por cache implícito (Gemini implicit caching /
   *  OpenAI-compat prompt_tokens_details.cached_tokens) — 75-90% mais baratos.
   *  Presente só quando o provedor reporta >0. Usado p/ medir cache hit rate. */
  cachedTokens?: number;
  attempts?: AiUsageAttempt[];
  reasoningTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  usageUnknown?: boolean;
}

function emptyUsage(): AiUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function withUsageAttempt(usage: AiUsage, provider: AiProvider, model: string): AiUsage {
  if (usage.attempts) return usage;
  return {
    ...usage,
    attempts: [{
      provider,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      ...(usage.estimated ? { estimated: true } : {}),
      ...(usage.cachedTokens ? { cachedTokens: usage.cachedTokens } : {}),
      ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      ...(usage.usageUnknown ? { usageUnknown: true } : {}),
    }],
  };
}

function normalizeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? Math.min(value, 100_000_000)
    : 0;
}

function usageTotal(reported: unknown, promptTokens: number, completionTokens: number): number {
  return Math.max(normalizeTokenCount(reported), promptTokens + completionTokens);
}

function geminiUsage(resp: any, model?: string): AiUsage {
  const meta = resp?.usageMetadata
    || resp?.response?.usageMetadata
    || resp?.candidates?.[0]?.usageMetadata
    || {};
  const promptTokens = normalizeTokenCount(meta.promptTokenCount);
  const completionTokens = normalizeTokenCount(meta.candidatesTokenCount);
  const totalTokens = usageTotal(meta.totalTokenCount, promptTokens, completionTokens);
  const cachedTokens = normalizeTokenCount(meta.cachedContentTokenCount);
  const usage = { promptTokens, completionTokens, totalTokens, ...(cachedTokens > 0 ? { cachedTokens } : {}) };
  return model ? withUsageAttempt(usage, "gemini", model) : usage;
}

// Only responses assembled by this process may carry an accumulated attempt ledger.
const accumulatedResponseUsage = new WeakMap<object, AiUsage>();

/** Normaliza métricas sem transformar ausência em gratuidade ou gasto zero confirmado. */
export function openRouterResponseUsage(json: unknown, provider?: AiProvider, model?: string): AiUsage {
  const trusted = json && typeof json === "object" ? accumulatedResponseUsage.get(json) : undefined;
  if (trusted) return provider && model ? withUsageAttempt(trusted, provider, model) : trusted;
  const record = json && typeof json === "object" ? json as OpenRouterResponse : {};
  const u = record.usage;
  const validCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const usageUnknown = u?.usageUnknown === true || !validCount(u?.prompt_tokens) || !validCount(u?.completion_tokens);
  const promptTokens = normalizeTokenCount(u?.prompt_tokens);
  const completionTokens = normalizeTokenCount(u?.completion_tokens);
  const cachedTokens = normalizeTokenCount(u?.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = normalizeTokenCount(u?.prompt_tokens_details?.cache_write_tokens);
  const reasoningTokens = normalizeTokenCount(u?.completion_tokens_details?.reasoning_tokens);
  const usage: AiUsage = {
    promptTokens, completionTokens, totalTokens: usageTotal(u?.total_tokens, promptTokens, completionTokens),
    estimated: usageUnknown || u?.estimated === true,
    ...(usageUnknown ? { usageUnknown: true } : {}),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(typeof u?.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0 ? { costUsd: u.cost } : {}),
  };
  return provider && model ? withUsageAttempt(usage, provider, model) : usage;
}

function openRouterUsage(json: unknown, provider?: AiProvider, model?: string): AiUsage {
  const usage = openRouterResponseUsage(json);
  return provider && model ? withUsageAttempt(usage, provider, model) : usage;
}

export function addAiUsage(left: AiUsage, right: AiUsage): AiUsage {
  const cachedTokens = (left.cachedTokens || 0) + (right.cachedTokens || 0);
  const reasoningTokens = (left.reasoningTokens || 0) + (right.reasoningTokens || 0);
  const cacheWriteTokens = (left.cacheWriteTokens || 0) + (right.cacheWriteTokens || 0);
  const attempts = [...(left.attempts || []), ...(right.attempts || [])].map((attempt) => ({ ...attempt }));
  const isIdentity = (usage: AiUsage) => usage.totalTokens === 0 && !usage.attempts?.length && !usage.usageUnknown && !usage.estimated && usage.costUsd === undefined;
  const costUsd = left.costUsd !== undefined && right.costUsd !== undefined ? left.costUsd + right.costUsd
    : isIdentity(left) ? right.costUsd : isIdentity(right) ? left.costUsd : undefined;
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(left.estimated || right.estimated ? { estimated: true } : {}),
    ...(left.usageUnknown || right.usageUnknown ? { usageUnknown: true } : {}),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
  };
}

function attachAiUsage(error: unknown, usage: AiUsage): Error {
  const target = error instanceof Error || error instanceof DOMException ? error : new Error(String(error));
  const current = (target as Error & { usage?: AiUsage }).usage;
  (target as Error & { usage?: AiUsage }).usage = current ? addAiUsage(usage, current) : usage;
  return target;
}

function setAiUsage(error: unknown, usage: AiUsage): Error {
  const target = error instanceof Error || error instanceof DOMException ? error : new Error(String(error));
  (target as Error & { usage?: AiUsage }).usage = usage;
  return target;
}

export function aiUsageFromError(error: unknown): AiUsage | null {
  const usage = (error as { usage?: AiUsage } | null)?.usage;
  return usage && Number.isFinite(usage.totalTokens) ? usage : null;
}

export function prependAiUsage(error: AiEmptyResponseError, priorUsage: AiUsage): AiEmptyResponseError {
  return new AiEmptyResponseError(error.provider, error.model, addAiUsage(priorUsage, error.usage), error);
}

export function prependAiErrorUsage(error: unknown, priorUsage: AiUsage): Error {
  return error instanceof AiEmptyResponseError ? prependAiUsage(error, priorUsage) : attachAiUsage(error, priorUsage);
}

function requireUsableOpenAIResponse(json: any, provider: AiProvider, model: string): any {
  const message = json?.choices?.[0]?.message || {};
  // SECURITY FIX: NUNCA vazar reasoning/thinking interno pro content final.
  // reasoning_content/reasoning/thought são PENSAMENTO INTERNO do modelo — não
  // podem ir pro usuário (expõe regras do sistema, vazamento de prompt, resposta
  // em inglês quando deveria ser português). Se o modelo só retornou thinking sem
  // content real, é resposta VAZIA (AiEmptyResponseError) — nunca substituir.
  const hasText = String(message.content || "").trim().length > 0;
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (!hasText && !hasTools) {
    throw new AiEmptyResponseError(provider, model, openRouterUsage(json, provider, model));
  }
  return json;
}

function withAccumulatedUsage(json: any, accumulated: AiUsage, provider: AiProvider, model: string): any {
  const usage = addAiUsage(accumulated, openRouterUsage(json, provider, model));
  const response = {
    ...json,
    usage: {
      ...(json?.usage || {}),
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      ...(usage.attempts ? { attempts: usage.attempts } : {}),
      ...(usage.estimated ? { estimated: true } : {}),
      ...(usage.usageUnknown ? { usageUnknown: true } : {}),
      cost: usage.costUsd,
      ...(usage.cachedTokens || usage.cacheWriteTokens ? { prompt_tokens_details: { ...(json?.usage?.prompt_tokens_details || {}), ...(usage.cachedTokens ? { cached_tokens: usage.cachedTokens } : {}), ...(usage.cacheWriteTokens ? { cache_write_tokens: usage.cacheWriteTokens } : {}) } } : {}),
      ...(usage.reasoningTokens ? { completion_tokens_details: { ...(json?.usage?.completion_tokens_details || {}), reasoning_tokens: usage.reasoningTokens } } : {}),
    },
  };
  accumulatedResponseUsage.set(response, usage);
  return response;
}

// =====================================================================
// OpenAI-compatible — chamada bruta /chat/completions.
// O MESMO protocolo serve OpenRouter E o Gateway de Assinatura (CLIProxyAPI):
// só muda a baseURL, a chave e os headers de atribuição.
// =====================================================================

function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // Atribuição (opcional, mas recomendada pela OpenRouter). Não envia dado sensível.
    "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://painel-sdr.local",
    "X-Title": "Painel SDR",
  };
}

/**
 * Normaliza a baseURL do gateway. Aceita "http://host:porta",
 * "http://host:porta/v1", com ou sem barra final. `/chat/completions` é
 * concatenado depois — então o valor final NÃO deve terminar em barra.
 */
export function normalizeGatewayBaseUrl(raw: string | null | undefined): string {
  const u = (raw || "").trim().replace(/\/+$/, "");
  return u;
}

function gatewayHeaders(apiKey: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  // Proxies tipo CLIProxyAPI aceitam uma "management key" opcional no Bearer.
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/** POST /chat/completions genérico (OpenAI-compatible). `label` só pro erro. */
async function openAICompatibleChat(
  baseUrl: string,
  body: Record<string, any>,
  headers: Record<string, string>,
  label: string,
  endpointId?: string,
  signal?: AbortSignal,
): Promise<any> {
  signal?.throwIfAborted();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(AI_CALL_TIMEOUT_MS)]) : AbortSignal.timeout(AI_CALL_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `${label} HTTP ${res.status}`;
    // Preserva o status no erro — viabiliza o FAILOVER distinguir quota/429 de
    // 5xx de credencial morta/401. (Antes virava string e se perdia.)
    const error = new ProviderHttpError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg), endpointId);
    const retryAfter = res.headers?.get?.("Retry-After");
    if (retryAfter?.trim()) {
      const seconds = Number(retryAfter);
      const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, delay);
    }
    throw attachAiUsage(error, openRouterResponseUsage(json));
  }
  return json;
}

async function openRouterChat(apiKey: string, body: Record<string, any>, keyId?: string, signal?: AbortSignal): Promise<any> {
  return openAICompatibleChat(OPENROUTER_BASE, body, openRouterHeaders(apiKey), "OpenRouter", keyId, signal);
}

export interface OpenRouterResponse {
  model?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { role?: string; content?: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; images?: Array<{ image_url: { url: string } }> } }>;
  usage?: {
    prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    attempts?: AiUsageAttempt[]; cost?: number; estimated?: boolean; usageUnknown?: boolean;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface ControlledOpenRouterOptions {
  openrouterApiKey?: string | null;
  openrouterKeys?: string[] | null;
  signal?: AbortSignal;
  maxAttempts?: number;
  attemptBudget?: { remaining: number };
  allowImages?: boolean;
  allowEmptyContent?: boolean;
}

export interface ControlledNvidiaOptions {
  nvidiaApiKey?: string | null;
  nvidiaAccounts?: import("@/lib/ai-keys").NvidiaAccount[] | null;
  signal?: AbortSignal;
  maxAttempts?: number;
  attemptBudget?: { remaining: number };
  allowEmptyContent?: boolean;
}

/**
 * FAILOVER 9Router-style entre múltiplas contas/chaves da NVIDIA NIM.
 * Tenta as contas disponíveis sequencialmente (pulando as em cooldown/mortas).
 * 429/quota/402 → marca cooldown temporário da conta e tenta a PRÓXIMA conta.
 * 401/403 → marca conta como MORTA (inválida) e tenta a PRÓXIMA conta.
 * 400 (Bad Request) → relança (erro de payload/modelo, trocar conta não resolve).
 */
export async function nvidiaChatWithFailover(
  body: Record<string, unknown>,
  opts: ControlledNvidiaOptions = {}
): Promise<any> {
  opts.signal?.throwIfAborted();
  const { markEndpointCooldown, markEndpointDead, isEndpointUnavailable, isEndpointDead, clearEndpointCooldown, canProbeEndpoint } = await import("@/lib/gateway-cooldown");

  type NvCandidate = { id: string; label: string; apiKey: string };
  const rawList: NvCandidate[] = [];

  if (Array.isArray(opts.nvidiaAccounts)) {
    for (const a of opts.nvidiaAccounts) {
      if (a?.apiKey && !rawList.some((c) => c.apiKey === a.apiKey)) {
        rawList.push({ id: a.id || `nv_${rawList.length + 1}`, label: a.label || `Conta ${rawList.length + 1}`, apiKey: a.apiKey });
      }
    }
  }
  if (opts.nvidiaApiKey && !rawList.some((c) => c.apiKey === opts.nvidiaApiKey!.trim())) {
    rawList.unshift({ id: "custom", label: "NVIDIA NIM", apiKey: opts.nvidiaApiKey.trim() });
  }

  if (!rawList.length) {
    try {
      const { getAiKeys } = await import("@/lib/ai-keys");
      const keys = await getAiKeys();
      if (keys?.nvidiaAccounts?.length) {
        for (const a of keys.nvidiaAccounts) {
          if (a?.apiKey && !rawList.some((c) => c.apiKey === a.apiKey)) {
            rawList.push({ id: a.id, label: a.label, apiKey: a.apiKey });
          }
        }
      } else if (keys?.nvidia) {
        rawList.push({ id: "primary", label: "Principal", apiKey: keys.nvidia.trim() });
      }
    } catch {
      /* segue com o que tiver */
    }
  }

  if (!rawList.length) {
    throw new Error("API Key da NVIDIA NIM não configurada.");
  }

  const candidates = await Promise.all(
    rawList.map(async (c) => {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.apiKey));
      const hashId = `nvidia:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      return {
        id: hashId,
        label: c.label || `nv_…${c.apiKey.slice(-4)}`,
        apiKey: c.apiKey,
      };
    })
  );

  let lastErr: unknown = null;
  let accumulatedUsage = emptyUsage();
  const model = String(body?.model || "");
  if (model && isModelQuarantined("nvidia", model) && opts.maxAttempts !== 1) {
    throw new ProviderHttpError(404, `Modelo nvidia:${model} indisponível temporariamente (em quarentena).`);
  }
  let attempts = 0;
  const maxAttempts = opts.maxAttempts === undefined ? Infinity : Math.max(1, Math.min(3, Math.trunc(opts.maxAttempts) || 1));

  // Mesmo motivo do OpenRouter: cooldown é estado em memória e pode estar
  // desatualizado. Se TODAS as contas estão em cooldown, sonda uma (não morta)
  // para renovar o estado e devolver o erro real em vez de mensagem genérica.
  const unavailableForModel = (c: { id: string }) => {
    const coolId = model ? `${c.id}::${model}` : c.id;
    return isEndpointUnavailable(c.id) || isEndpointUnavailable(coolId);
  };
  const budgetAllowsProbe = !opts.attemptBudget || opts.attemptBudget.remaining > 0;
  let probeKeyId: string | null = null;
  if (budgetAllowsProbe && candidates.length > 0 && candidates.every(unavailableForModel)) {
    const alive = candidates.find((c) => {
      const coolId = model ? `${c.id}::${model}` : c.id;
      return !isEndpointDead(c.id) && canProbeEndpoint(coolId) && canProbeEndpoint(c.id);
    });
    if (alive) probeKeyId = alive.id;
  }

  for (const c of candidates) {
    opts.signal?.throwIfAborted();
    if (attempts >= maxAttempts || (opts.attemptBudget && opts.attemptBudget.remaining <= 0)) break;
    const coolId = model ? `${c.id}::${model}` : c.id;
    const coolLabel = model ? `${c.label}::${model}` : c.label;
    const unavailable = isEndpointUnavailable(c.id) || isEndpointUnavailable(coolId);
    const isProbe = unavailable && probeKeyId === c.id;
    if (unavailable && !isProbe) continue;
    if (isProbe) {
      probeKeyId = null;
      console.warn(`[ai-provider:nvidia] Todas as contas em cooldown para "${model}". Probe único em ${coolLabel} para validar/renovar o estado.`);
    }
    const callStartedAt = Date.now();
    try {
      attempts++;
      if (opts.attemptBudget) opts.attemptBudget.remaining--;
      let json = await openAICompatibleChat(
        NVIDIA_BASE,
        body,
        {
          Authorization: `Bearer ${c.apiKey}`,
          "Content-Type": "application/json",
        },
        "NVIDIA NIM",
        coolId,
        opts.signal
      );

      // Resgate contra truncamento de thinking em chamadas ultra-curtas (ex.: max_tokens=5 em avaliadores)
      const msg0 = json?.choices?.[0]?.message || {};
      const emptyOut = !String(msg0.content || "").trim() && !(Array.isArray(msg0.tool_calls) && msg0.tool_calls.length > 0);
      const reasoningTruncated =
        emptyOut &&
        !opts.allowEmptyContent &&
        Number(body?.max_tokens) > 0 &&
        Number(body?.max_tokens) < 384 &&
        (Number(json?.usage?.completion_tokens_details?.reasoning_tokens) > 0 || json?.choices?.[0]?.finish_reason === "length") &&
        attempts < maxAttempts;
      if (reasoningTruncated) {
        accumulatedUsage = addAiUsage(accumulatedUsage, openRouterUsage(json, "nvidia", model));
        attempts++;
        if (opts.attemptBudget) opts.attemptBudget.remaining--;
        json = await openAICompatibleChat(
          NVIDIA_BASE,
          { ...body, max_tokens: 384, reasoning: { effort: "minimal" } },
          { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
          "NVIDIA NIM",
          coolId,
          opts.signal,
        );
      }

      const usable = opts.allowEmptyContent ? json : requireUsableOpenAIResponse(json, "nvidia", model);
      recordModelSuccess("nvidia", model, Date.now() - callStartedAt);
      // Chamada real bem-sucedida = estado negativo em memória estava errado.
      clearEndpointCooldown(c.id);
      clearEndpointCooldown(coolId);
      return withAccumulatedUsage(usable, accumulatedUsage, "nvidia", model);
    } catch (err) {
      if (opts.signal?.aborted) throw attachAiUsage(opts.signal.reason ?? err, accumulatedUsage);
      lastErr = err;
      if (err instanceof AiEmptyResponseError) {
        accumulatedUsage = addAiUsage(accumulatedUsage, err.usage);
        recordModelFailure("nvidia", model, { isEmpty: true });
        if (!isProbe) markEndpointCooldown(coolId);
        console.warn(`[ai-provider:nvidia] Conta ${coolLabel} retornou resposta vazia. Rotacionando para próxima conta NVIDIA.`);
        continue;
      }
      const failedUsage = aiUsageFromError(err) ?? openRouterResponseUsage(null);
      accumulatedUsage = addAiUsage(accumulatedUsage, withUsageAttempt(failedUsage, "nvidia", model));
      if (err instanceof ProviderHttpError) {
        if (err.status === 401 || err.status === 403) {
          markEndpointDead(c.id);
          console.warn(`[ai-provider:nvidia] Conta ${c.label} marcada MORTA (HTTP ${err.status}). Rotacionando para próxima conta NVIDIA.`);
          continue;
        }
        if (isModelLevelFatalError(err.status, err.message) && !/support tool use/i.test(err.message)) {
          recordModelFailure("nvidia", model, { status: err.status, message: err.message });
          markEndpointCooldown(coolId);
          console.warn(`[ai-provider:nvidia] Modelo "${model}" indisponível no provedor (${err.message.slice(0, 80)}). Pulando contas restantes e subindo escada.`);
          break;
        }
        if (
          err.status === 429 ||
          err.status === 402 ||
          isFailoverableStatus(err.status, err.message) ||
          /credit|quota|insufficient|rate.?limit/i.test(err.message)
        ) {
          recordModelFailure("nvidia", model, { status: err.status, message: err.message });
          if (!isProbe) markEndpointCooldown(coolId);
          console.warn(`[ai-provider:nvidia] Conta ${coolLabel} em cooldown (${err.message.slice(0, 80)}). Rotacionando para próxima conta NVIDIA.`);
          continue;
        }
        throw accumulatedUsage.attempts?.length ? setAiUsage(err, accumulatedUsage) : err;
      }
      recordModelFailure("nvidia", model, { isTimeout: true, message: (err as Error)?.message });
      console.warn(`[ai-provider:nvidia] Conta ${c.label} falhou (rede/timeout). Rotacionando:`, (err as any)?.message);
      continue;
    }
  }

  if (lastErr instanceof AiEmptyResponseError) {
    throw new AiEmptyResponseError(lastErr.provider, lastErr.model, accumulatedUsage, lastErr);
  }
  const terminalError = lastErr instanceof Error
    ? lastErr
    : new ProviderHttpError(429, "Todas as contas da NVIDIA NIM falharam ou estão em cooldown. Tente novamente mais tarde.");
  throw accumulatedUsage.attempts?.length ? setAiUsage(terminalError, accumulatedUsage) : terminalError;
}

/**
 * FAILOVER 9Router-style entre múltiplas API keys do OpenRouter.
 * Tenta as chaves disponíveis sequencialmente (pulando as em cooldown/mortas).
 * 429/quota/402 → marca cooldown temporário da chave e tenta a PRÓXIMA chave.
 * 401/403 → marca chave como MORTA (inválida) e tenta a PRÓXIMA chave.
 * Erro global do modelo (404 / unavailable for free / no endpoints) → quarentena do modelo e avança escada imediatamente.
 */
export async function openRouterChatWithFailover(
  body: Record<string, unknown>,
  opts: ControlledOpenRouterOptions = {}
): Promise<OpenRouterResponse> {
  opts.signal?.throwIfAborted();
  const { markEndpointCooldown, markEndpointDead, isEndpointUnavailable, isEndpointDead, clearEndpointCooldown, canProbeEndpoint } = await import("@/lib/gateway-cooldown");

  // Coleta lista inicial de chaves fornecidas explicitamente
  const rawList: string[] = [];
  if (Array.isArray(opts.openrouterKeys)) {
    for (const k of opts.openrouterKeys) {
      const s = (k || "").trim();
      if (s && !rawList.includes(s)) rawList.push(s);
    }
  }
  if (opts.openrouterApiKey && !rawList.includes(opts.openrouterApiKey.trim())) {
    rawList.unshift(opts.openrouterApiKey.trim());
  }

  // Se não veio nenhuma chave nos opts, busca do banco
  if (!rawList.length) {
    try {
      const { getAiKeys } = await import("@/lib/ai-keys");
      const keys = await getAiKeys();
      if (keys?.openrouterKeys?.length) {
        for (const k of keys.openrouterKeys) {
          const s = (k || "").trim();
          if (s && !rawList.includes(s)) rawList.push(s);
        }
      } else if (keys?.openrouter) {
        rawList.push(keys.openrouter.trim());
      }
    } catch {
      /* segue com o que tiver */
    }
  }

  if (!rawList.length) {
    throw new Error("OpenRouter API Key não configurada.");
  }

  const candidates = await Promise.all(rawList.map(async (key) => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const id = `openrouter:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return { key, id, label: `or_…${key.slice(-4)}` };
  }));

  let lastErr: unknown = null;
  let accumulatedUsage = emptyUsage();
  // Cooldown com escopo CHAVE+MODELO: limites free/429 da OpenRouter são
  // POR MODELO. Sem o modelo no ID, um único :free estourado colocava a
  // chave inteira em cooldown e derrubava TODOS os outros modelos.
  const model = String(body?.model || "");
  if (model && isModelQuarantined("openrouter", model) && opts.maxAttempts !== 1) {
    throw new ProviderHttpError(404, `Modelo openrouter:${model} indisponível temporariamente (em quarentena).`);
  }
  const isModelFreeSlug = model.toLowerCase().endsWith(":free");
  let attempts = 0;
  const maxAttempts = opts.maxAttempts === undefined ? Infinity : Math.max(1, Math.min(3, Math.trunc(opts.maxAttempts) || 1));
  // Todas as chaves em cooldown não significa que todas falharam: o cooldown é
  // palpite em memória e pode estar desatualizado (429 de rajada, restart de
  // outra instância, etc.). Sem probe, o caller recebia "todas as chaves
  // falharam" sem NENHUMA chamada HTTP. Forçamos UMA tentativa real na primeira
  // chave para renovar o estado e devolver o erro verdadeiro se ainda falhar.
  const unavailableForModel = (c: { id: string }) => {
    const coolId = model ? `${c.id}::${model}` : c.id;
    return isEndpointUnavailable(c.id) || isEndpointUnavailable(coolId);
  };
  const budgetAllowsProbe = !opts.attemptBudget || opts.attemptBudget.remaining > 0;
  let probeKeyId: string | null = null;
  if (budgetAllowsProbe && candidates.length > 0 && candidates.every(unavailableForModel)) {
    // Só sonda chave que não foi marcada MORTA (401/403): credencial inválida
    // não se resolve com uma nova tentativa.
    const alive = candidates.find((c) => {
      const coolId = model ? `${c.id}::${model}` : c.id;
      return !isEndpointDead(c.id) && canProbeEndpoint(coolId) && canProbeEndpoint(c.id);
    });
    if (alive) probeKeyId = alive.id;
  }
  for (const c of candidates) {
    opts.signal?.throwIfAborted();
    if (attempts >= maxAttempts || (opts.attemptBudget && opts.attemptBudget.remaining <= 0)) break;
    const coolId = model ? `${c.id}::${model}` : c.id;
    const coolLabel = model ? `${c.label}::${model}` : c.label;
    const unavailable = isEndpointUnavailable(c.id) || isEndpointUnavailable(coolId);
    const isProbe = unavailable && probeKeyId === c.id;
    if (unavailable && !isProbe) continue;
    if (isProbe) {
      probeKeyId = null;
      console.warn(`[ai-provider:openrouter] Todas as chaves em cooldown para "${model}". Probe único em ${coolLabel} para validar/renovar o estado.`);
    }
    const callStartedAt = Date.now();
    try {
      attempts++;
      if (opts.attemptBudget) opts.attemptBudget.remaining--;
      let json = await openRouterChat(c.key, body, coolId, opts.signal);
      const hasImages = opts.allowImages && Array.isArray(json?.choices?.[0]?.message?.images) && json.choices[0].message.images.length > 0;
      const allowEmpty = Boolean(opts.allowEmptyContent) || hasImages;

      // Resgate contra truncamento de thinking em chamadas curtas (ex.: max_tokens=5 no avaliador binário)
      const msg0 = json?.choices?.[0]?.message || {};
      const emptyOut = !String(msg0.content || "").trim() && !(Array.isArray(msg0.tool_calls) && msg0.tool_calls.length > 0);
      const reasoningTruncated =
        emptyOut &&
        !allowEmpty &&
        Number(body?.max_tokens) > 0 &&
        Number(body?.max_tokens) < 384 &&
        (Number(json?.usage?.completion_tokens_details?.reasoning_tokens) > 0 || json?.choices?.[0]?.finish_reason === "length") &&
        attempts < maxAttempts;
      if (reasoningTruncated) {
        accumulatedUsage = addAiUsage(accumulatedUsage, openRouterUsage(json, "openrouter", model));
        attempts++;
        if (opts.attemptBudget) opts.attemptBudget.remaining--;
        json = await openRouterChat(
          c.key,
          { ...body, max_tokens: 384, reasoning: { effort: "minimal" } },
          coolId,
          opts.signal,
        );
      }

      const usable = allowEmpty ? json : requireUsableOpenAIResponse(json, "openrouter", model);
      recordModelSuccess("openrouter", model, Date.now() - callStartedAt);
      // Chamada real bem-sucedida = estado negativo em memória estava errado.
      clearEndpointCooldown(c.id);
      clearEndpointCooldown(coolId);
      return withAccumulatedUsage(usable, accumulatedUsage, "openrouter", model);
    } catch (err) {
      if (opts.signal?.aborted) throw attachAiUsage(opts.signal.reason ?? err, accumulatedUsage);
      lastErr = err;
      if (err instanceof AiEmptyResponseError) {
        accumulatedUsage = addAiUsage(accumulatedUsage, err.usage);
        recordModelFailure("openrouter", model, { isEmpty: true });
        if (!isProbe) markEndpointCooldown(coolId);
        console.warn(`[ai-provider:openrouter] ${coolLabel} retornou resposta vazia. Rotacionando para próxima chave.`);
        continue;
      }
      const failedUsage = aiUsageFromError(err) ?? openRouterResponseUsage(null);
      accumulatedUsage = addAiUsage(accumulatedUsage, withUsageAttempt(failedUsage, "openrouter", model));
      if (err instanceof ProviderHttpError) {
        if (!isModelFreeSlug && isCreditExhaustedOnKeyError(err.status, err.message)) {
          markKeyFreeOnly(c.key);
        }
        // 403 específico do modelo :free ("only available on agentic harnesses") não mata a API key inteira!
        if ((err.status === 401 || err.status === 403) && !isModelLevelFatalError(err.status, err.message)) {
          markEndpointDead(c.id);
          console.warn(`[ai-provider:openrouter] Chave ${c.label} marcada MORTA (HTTP ${err.status}). Rotacionando para próxima chave OpenRouter.`);
          continue;
        }
        if (isModelLevelFatalError(err.status, err.message) && !/support tool use/i.test(err.message)) {
          recordModelFailure("openrouter", model, { status: err.status, message: err.message });
          markEndpointCooldown(coolId);
          console.warn(`[ai-provider:openrouter] Modelo "${model}" indisponível no provedor (${err.message.slice(0, 80)}). Pulando chaves restantes e avançando escada.`);
          break;
        }
        if (
          err.status === 429 ||
          err.status === 402 ||
          isFailoverableStatus(err.status, err.message)
        ) {
          recordModelFailure("openrouter", model, { status: err.status, message: err.message });
          if (!isProbe) markEndpointCooldown(coolId);
          console.warn(`[ai-provider:openrouter] ${coolLabel} falhou (${err.message.slice(0, 80)}). Rotacionando para próxima chave/modelo.`);
          continue;
        }
        throw accumulatedUsage.attempts?.length ? setAiUsage(err, accumulatedUsage) : err;
      }
      recordModelFailure("openrouter", model, { isTimeout: true, message: (err as Error)?.message });
      console.warn(`[ai-provider:openrouter] Chave ${c.label} falhou (rede/timeout). Rotacionando:`, (err as any)?.message);
      continue;
    }
  }

  if (lastErr instanceof AiEmptyResponseError) {
    throw new AiEmptyResponseError(lastErr.provider, lastErr.model, accumulatedUsage, lastErr);
  }
  const terminalError = lastErr instanceof Error
    ? lastErr
    : new ProviderHttpError(429, "Todas as chaves OpenRouter falharam ou estão em cooldown. Tente novamente mais tarde.");
  throw accumulatedUsage.attempts?.length ? setAiUsage(terminalError, accumulatedUsage) : terminalError;
}

async function gatewayChat(baseUrl: string, apiKey: string | null, body: Record<string, any>, endpointId?: string, signal?: AbortSignal, singleAttempt = false): Promise<any> {
  signal?.throwIfAborted();
  // Se for a rota interna do DeepSeek Web, chama o client diretamente em memória sem HTTP loopback
  if (endpointId === "ds_internal" || baseUrl.includes("deepseek-chat")) {
    // ponytail: client interno cria sessão/PoW antes do chat; só habilitar após transporte contabilizado por envio.
    if (singleAttempt) throw new Error("Gateway DeepSeek interno incompatível com uma única tentativa física.");
    const { chatComplete, messagesToPrompt } = await import("@/lib/deepseek-chat-client");
    const { pickToken } = await import("@/lib/deepseek-chat-manager");
    const active = pickToken();
    if (!active) {
      throw new ProviderHttpError(503, "Nenhuma conta DeepSeek conectada ou ativa no momento.");
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const prompt = messagesToPrompt(messages);
    const model = String(body?.model || "deepseek-chat");
    const res = await chatComplete({
      tokenId: active.id,
      token: active.token,
      fingerprint: active.fingerprint,
      model,
      prompt,
      signal,
    });
    return {
      id: `ds_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: res.content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: res.usage.promptTokens,
        completion_tokens: res.usage.completionTokens,
        total_tokens: res.usage.promptTokens + res.usage.completionTokens,
      },
    };
  }

  return openAICompatibleChat(baseUrl, body, gatewayHeaders(apiKey), "Gateway de assinatura", endpointId, signal);
}

/** Credenciais resolvidas do gateway de assinatura. */
interface GatewayCreds {
  baseUrl: string;
  apiKey: string | null;
  /** Id da CONEXÃO (conta) primária — usado pra marcação de cooldown/failover. */
  endpointId?: string;
  /** modelRef de RESERVA (API key) se o gateway falhar — garante "nunca quebra". */
  fallbackModelRef: string | null;
}

/**
 * Resolve as credenciais do gateway PARA UM MODELO. Usa o que veio em `opts`
 * (override explícito); senão, descobre a CONEXÃO (conta) específica que expõe
 * aquele `model` — é o que viabiliza ter várias contas conectadas ao mesmo tempo
 * (Gemini + Claude + ChatGPT) e rotear `gateway:<modelId>` para a certa. Cobre
 * também conta única e o legado (gateway_base_url sintetizado). Lazy import — só
 * roda no caminho gateway, mantendo o ai-provider desacoplado do banco nos
 * caminhos Gemini/OpenRouter.
 */
export async function resolveGatewayCreds(opts: {
  gatewayBaseUrl?: string | null;
  gatewayApiKey?: string | null;
  fallbackModelRef?: string | null;
  noGatewayFallback?: boolean;
}, model?: string): Promise<GatewayCreds> {
  let baseUrl = normalizeGatewayBaseUrl(opts.gatewayBaseUrl);
  let apiKey = (opts.gatewayApiKey || "").trim() || null;
  let endpointId: string | undefined;
  // noGatewayFallback: supressão EXPLÍCITA — sem isso, o refill do banco abaixo
  // ressuscitaria o fallback global dentro de cada PASSO de um combo, e a
  // cascata nunca avançaria pro próximo modelo (o passo "resolveria" sozinho).
  let fallbackModelRef = opts.noGatewayFallback ? null : ((opts.fallbackModelRef || "").trim() || null);

  // Auto-start do proxy CLIProxyAPI server-side. O proxy morre a cada reboot
  // /dev-server restart, e sem isso as chamadas de IA via gateway falham
  // silenciosamente e caem no `fallbackModelRef` (ex: deepseek-chat). O usuário
  // herdava a mensagem de erro do fallback e achava que era problema no DeepSeek
  // — mas a causa raiz era o gateway morto. Custo: ~12s só na 1ª chamada após
  // restart (startProxy espera subir); demais chamadas só fazem fetch barato.
  if (!baseUrl) {
    try {
      const { ensureProxyRunning } = await import("@/lib/gateway-proxy-manager");
      const status = await ensureProxyRunning();
      // Se o proxy tribal, nada a fazer aqui — resolveGatewayEndpointForModel
      // abaixo não vai achar baseUrl e cai no caminho de fallback API key.
      if (!status.running) {
        console.warn(`[ai-provider] Proxy gateway não está rodando (installed=${status.installed}). Vai tentar fallback.`);
      }
    } catch (e: any) {
      console.warn(`[ai-provider] ensureProxyRunning falhou: ${e?.message || e} — segue pro caminho normal.`);
    }
  }

  // Sem override explícito de baseURL: resolve a CONEXÃO específica do modelo.
  if (!baseUrl && model) {
    try {
      const { resolveGatewayEndpointForModel } = await import("@/lib/gateway-model-discovery");
      const ep = await resolveGatewayEndpointForModel(model);
      if (ep) {
        baseUrl = normalizeGatewayBaseUrl(ep.baseUrl);
        endpointId = ep.id;
        if (!apiKey) apiKey = ep.apiKey || null;
      }
    } catch {
      /* descoberta indisponível — cai no fallback do banco abaixo */
    }
  }

  // Garante o modelRef de RESERVA (e a baseURL legada, se a descoberta não achou).
  if (!baseUrl || !fallbackModelRef) {
    try {
      const { getAiKeys } = await import("@/lib/ai-keys");
      const keys = await getAiKeys();
      if (!baseUrl) {
        baseUrl = normalizeGatewayBaseUrl(keys.gatewayBaseUrl);
        if (!apiKey) apiKey = keys.gatewayApiKey || null;
      }
      if (!fallbackModelRef && !opts.noGatewayFallback) fallbackModelRef = keys.gatewayFallbackModel || null;
    } catch {
      /* sem banco acessível — segue só com o que veio em opts */
    }
  }
  return { baseUrl, apiKey, endpointId, fallbackModelRef };
}

/**
 * FAILOVER entre contas conectadas do gateway. Tenta o endpoint PRIMÁRIO (a
 * conta que serve o modelo normalmente); se ele falhar com erro "failoverable"
 * (429/quota/401/403/5xx/rede), marca cooldown/morto e itera sobre as OUTRAS
 * contas que também expõem o modelo (pulando as indisponíveis) até uma acertar.
 *
 * Comportamento quando tudo falha: relança o último erro — o caller (generateText
 * / startAiChat) então cai no `fallbackModelRef` (API key paga) ou propaga (e o
 * catch global do agente loga; a próxima msg do cliente retenta = "esperar e
 * retentar"). Ou seja: NUNCA pior que o comportamento anterior.
 *
 * Ponto ÚNICO de injeção: usado tanto por generateText quanto pela sessão
 * (startOpenAICompatibleChat via deps.post) — cobre os dois caminhos de uma vez.
 */
export async function gatewayChatWithFailover(
  model: string,
  body: Record<string, any>,
  primary: { baseUrl: string; apiKey: string | null; endpointId?: string },
  opts?: { allowEmptyContent?: boolean; signal?: AbortSignal; maxAttempts?: number },
): Promise<any> {
  opts?.signal?.throwIfAborted();
  const maxAttempts = opts?.maxAttempts === undefined ? Infinity : Math.max(1, Math.min(3, Math.trunc(opts.maxAttempts) || 1));
  const { listEndpointsForModel } = await import("@/lib/gateway-model-discovery");
  const { markEndpointCooldown, markEndpointDead, isEndpointUnavailable } = await import("@/lib/gateway-cooldown");

  // Candidatos: primário primeiro, depois as alternativas (sem repetir).
  const alts = maxAttempts === 1 ? [] : await listEndpointsForModel(model);
  const seen = new Set<string>();
  const candidates: { baseUrl: string; apiKey: string | null; endpointId?: string }[] = [];
  const pushUnique = (ep: { baseUrl: string; apiKey: string | null; endpointId?: string }) => {
    const key = ep.endpointId || ep.baseUrl;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(ep);
  };
  pushUnique(primary);
  for (const ep of alts) {
    pushUnique({ baseUrl: normalizeGatewayBaseUrl(ep.baseUrl), apiKey: ep.apiKey || null, endpointId: ep.id });
  }

  let lastErr: unknown = null;
  let accumulatedUsage = emptyUsage();
  let attempts = 0;
  for (const c of candidates) {
    opts?.signal?.throwIfAborted();
    if (attempts >= maxAttempts) break;
    // Pula endpoints sabidamente indisponíveis (cooldown/morto) ANTES de chamar.
    if (c.endpointId && isEndpointUnavailable(c.endpointId)) continue;
    try {
      attempts++;
      const json = await gatewayChat(c.baseUrl, c.apiKey, body, c.endpointId, opts?.signal, maxAttempts === 1);
      if (opts?.signal?.aborted) throw attachAiUsage(opts.signal.reason, openRouterUsage(json, "gateway", model));
      return withAccumulatedUsage(opts?.allowEmptyContent ? json : requireUsableOpenAIResponse(json, "gateway", model), accumulatedUsage, "gateway", model);
    } catch (err) {
      if (opts?.signal?.aborted) throw attachAiUsage(err, accumulatedUsage);
      lastErr = err;
      if (err instanceof AiEmptyResponseError) {
        accumulatedUsage = addAiUsage(accumulatedUsage, err.usage);
        console.warn(`[ai-provider] Conta ${c.endpointId || c.baseUrl} retornou resposta vazia. Failover pra próxima.`);
        continue;
      }
      const failedUsage = aiUsageFromError(err) ?? openRouterResponseUsage(null);
      accumulatedUsage = addAiUsage(accumulatedUsage, withUsageAttempt(failedUsage, "gateway", model));
      if (err instanceof ProviderHttpError && c.endpointId) {
        // 401/403 → credencial morta: marca p/ sempre pular até restart.
        if (err.status === 401 || err.status === 403) {
          markEndpointDead(c.endpointId);
          console.warn(`[ai-provider] Conta ${c.endpointId} marcada MORTA (HTTP ${err.status}). Failover.`);
          continue;
        }
        // 429/402/quota → cooldown temporário (volta sozinha depois).
        if (err.status === 429 || err.status === 402 || isFailoverableStatus(err.status, err.message)) {
          markEndpointCooldown(c.endpointId);
          console.warn(`[ai-provider] Conta ${c.endpointId} em cooldown (HTTP ${err.status}). Failover pra próxima.`);
          continue;
        }
        // Outro 4xx (400 bad request, etc.) → erro do request; outra conta dará
        // o mesmo. Relança (não adianta trocar).
        throw accumulatedUsage.attempts?.length ? setAiUsage(err, accumulatedUsage) : err;
      }
      // Erro de rede/timeout (não ProviderHttpError) → tenta próxima conta.
      console.warn(`[ai-provider] Conta ${c.endpointId || c.baseUrl} falhou (rede/timeout). Failover:`, (err as any)?.message);
      continue;
    }
  }
  // Esgotou todos os candidatos (ou todos em cooldown/mortos).
  if (lastErr instanceof AiEmptyResponseError) {
    throw new AiEmptyResponseError(lastErr.provider, lastErr.model, accumulatedUsage, lastErr);
  }
  const terminalError = lastErr instanceof Error
    ? lastErr
    : new Error("Todas as contas do gateway falharam ou estão em cooldown. Tente novamente mais tarde.");
  throw accumulatedUsage.attempts?.length ? setAiUsage(terminalError, accumulatedUsage) : terminalError;
}

// =====================================================================
// 1) generateText — chamada única (sem ferramentas).
// =====================================================================

export interface GenerateTextOpts {
  /** modelRef salvo no banco (com ou sem prefixo de provedor). */
  modelRef?: string;
  /** Alias retrocompatível para modelRef */
  model?: string;
  /** Instruções de sistema (persona/regras). Opcional. */
  system?: string;
  /** Alias retrocompatível para system */
  systemPrompt?: string;
  /** Conteúdo do usuário / prompt principal. */
  prompt?: string;
  /** Alias retrocompatível para prompt */
  userPrompt?: string;
  temperature?: number | null;
  /**
   * Modo de raciocínio UNIVERSAL (0=Econômico, 1=Equilibrado, 2=Intenso).
   * Mapeia pro parâmetro certo de cada provedor (Gemini thinkingBudget, OpenAI
   * reasoning.effort, Anthropic thinking/effort, DeepSeek deepseek-reasoner).
   * Retrocompat: se `thinkingBudget` vier setado e reasoningMode não, deriva dele.
   */
  reasoningMode?: 0 | 1 | 2 | 3 | null;
  /** Só Gemini: thinking budget (0 desliga "raciocínio" cobrado como saída). */
  thinkingBudget?: number | null;
  maxOutputTokens?: number | null;
  /** Alias retrocompatível para maxOutputTokens */
  maxTokens?: number | null;
  /** Chave Gemini (se não vier, o caller deve garantir uma). */
  geminiApiKey?: string | null;
  /** Chave NVIDIA NIM única ou primária. */
  nvidiaApiKey?: string | null;
  /** Lista opcional de contas NVIDIA NIM com apelido para failover multi-conta. */
  nvidiaAccounts?: import("@/lib/ai-keys").NvidiaAccount[] | null;
  /** Chave OpenRouter única ou lista/rotação multi-key. */
  openrouterApiKey?: string | null;
  /** Lista opcional de chaves OpenRouter para rotação multi-conta (9Router-style). */
  openrouterKeys?: string[] | null;
  /** Gateway de assinatura: baseURL do proxy OpenAI-compatible. Se omitido, lê do banco. */
  gatewayBaseUrl?: string | null;
  /** Gateway de assinatura: chave/management key opcional do proxy. */
  gatewayApiKey?: string | null;
  /**
   * modelRef de RESERVA (API key) usado se o gateway falhar (proxy fora, conta
   * deslogada, quota). Garante "nunca quebra". Se omitido, lê do banco.
   */
  fallbackModelRef?: string | null;
  /**
   * SUPRIME o fallback global do gateway (inclusive o lido do banco). Usado
   * pelos PASSOS de um combo: cada passo deve PROPAGAR a falha para a cascata
   * avançar pro próximo modelo — com fallback interno, o combo nunca trocaria.
   */
  noGatewayFallback?: boolean;
  /** Força saída em JSON (Gemini: responseMimeType; OpenRouter: response_format). */
  jsonMode?: boolean;
  /** Schema estruturado pra saída JSON garantida (Gemini nativo + tradução automática p/ outros provedores). */
  geminiResponseSchema?: any;
  /** Perfil semântico da tarefa ("agent" | "general" | "fast") para ranquear o melhor modelo :free compatível. */
  taskProfile?: AiTaskProfile;
  /** Sinal opcional de cancelamento/timeout por tentativa. */
  signal?: AbortSignal;
  /** Força descoberta ao vivo de catálogo mesmo em ambiente Vitest. */
  allowLiveDiscovery?: boolean;
}

export interface GenerateTextResult {
  text: string;
  usage: AiUsage;
  provider: AiProvider;
  modelUsed: string;
  model: string;
  didFallback: boolean;
}

function isGeminiNetworkUnreachableError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || "");
  return /Error fetching from https:\/\/generativelanguage\.googleapis\.com|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(
    msg,
  );
}

function isJsonFormatUnsupportedError(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /response_format|json_object|json_schema|structured.?output|json mode/i.test(err.message || "");
}

function prepareJsonAwarePrompts(opts: {
  system?: string;
  prompt: string;
  jsonMode?: boolean;
  geminiResponseSchema?: unknown;
}): { system?: string; prompt: string; useJsonResponseFormat: boolean } {
  const hasSchema = Boolean(opts.geminiResponseSchema && typeof opts.geminiResponseSchema === "object");
  const useJsonResponseFormat = Boolean(opts.jsonMode || hasSchema);
  if (!hasSchema) {
    return { system: opts.system, prompt: opts.prompt, useJsonResponseFormat };
  }
  let schemaSnippet = "";
  try {
    schemaSnippet = JSON.stringify(opts.geminiResponseSchema).slice(0, 1800);
  } catch {
    schemaSnippet = "";
  }
  const schemaInstruction = schemaSnippet
    ? `\n\nResponda EXCLUSIVAMENTE com um JSON válido obedecendo estritamente a esta estrutura/schema (sem blocos markdown): ${schemaSnippet}`
    : `\n\nResponda EXCLUSIVAMENTE com um JSON válido puro (sem blocos markdown).`;
  return {
    system: opts.system ? `${opts.system}${schemaInstruction}` : schemaInstruction.trim(),
    prompt: opts.prompt,
    useJsonResponseFormat,
  };
}

// ─────────────────────────────────────────────────────────────────────
// ESCADA DE FALLBACK CROSS-PROVIDER ("nunca quebra" + Free-First em Tempo Real)
// ─────────────────────────────────────────────────────────────────────

/**
 * Esse erro justifica tentar OUTRO modelo/provider?
 * Erros de CONTA (quota/429/auth/rede) OU morte global do modelo (404 /
 * unavailable for free / no endpoints found) sim — outro modelo/provedor resolve.
 * Erros de REQUEST malformado do cliente (400 bad request puro) não.
 */
function isAccountLevelError(err: unknown): boolean {
  if (err instanceof AiEmptyResponseError) return true;
  if (err instanceof ProviderHttpError) {
    if (isFailoverableStatus(err.status, err.message)) return true;
    if (isModelLevelFatalError(err.status, err.message)) return true;
    const msg = String(err.message || "");
    if (/unavailable for free|not a valid model id|no endpoints found|cooldown|falharam|quarentena/i.test(msg)) return true;
    return false;
  }
  const msg = String((err as any)?.message || err);
  return /quota|exhaust|429|rate.?limit|timeout|deadline|network|ENOTFOUND|ECONNRESET|fetch failed|api key|unauthor|forbidden|unavailable|overloaded|unavailable for free|not a valid model id|no endpoints found|cooldown|falharam|quarentena|nenhum modelo gratuito/i.test(msg);
}

/** Chaves mínimas que a escada precisa pra montar os rungs. */
interface LadderKeys {
  gemini?: string | null;
  nvidia?: string | null;
  nvidiaAccounts?: import("@/lib/ai-keys").NvidiaAccount[] | null;
  openrouter?: string | null;
  openrouterKeys?: string[] | null;
  gatewayBaseUrl?: string | null;
  gatewayEndpoints?: Array<{ id: string; label: string; baseUrl: string; apiKey?: string | null }> | null;
  agentFallbackModel?: string | null;
  gatewayFallbackModel?: string | null;
}

interface BuildLadderOptions {
  profile?: AiTaskProfile;
  requireTools?: boolean;
  requireJson?: boolean;
  allowLiveDiscovery?: boolean;
}

/**
 * Monta a escada inteligente de fallback Free-First em tempo real:
 *   1. modelRef titular escolhido pelo usuário (SEMPRE respeitado primeiro)
 *   2. agentFallbackModel — reserva explícita do agente (se configurada)
 *   3. gatewayFallbackModel — reserva global de Configurações (se configurada)
 *   4. Fila Inteligente Free-First em Tempo Real (OpenRouter :free + NVIDIA Free Endpoints + Gateway conectado),
 *      pontuada por inteligência/capacidade + saúde/latência ao vivo e intercalada entre provedores
 *   5. Gemini Flash dinâmico atual (`pickBestFlashModel`) se chave Gemini ativa e acessível
 *   6. Rede de segurança estática (NVIDIA Free default / `gpt-4o-mini` somente se houver chave com crédito)
 */
async function buildLadder(
  requestedRef: string,
  keys: LadderKeys | null,
  ladderOpts?: BuildLadderOptions,
): Promise<string[]> {
  const ladder = [requestedRef];
  const modelKey = (ref: string) => {
    const parsed = parseModelRef(ref);
    return `${parsed.provider}:${parsed.model}`;
  };
  const seenModels = new Set<string>([modelKey(requestedRef)]);
  const seenProviders = new Set<string>([providerOf(requestedRef)]);

  const push = (ref: string | null | undefined, allowSameProvider = false) => {
    const r = (ref || "").trim();
    if (!r || seenModels.has(modelKey(r))) return;
    const parsed = parseModelRef(r);
    if (isModelQuarantined(parsed.provider, parsed.model)) return;
    const p = parsed.provider;
    if (!allowSameProvider && seenProviders.has(p)) return;
    seenModels.add(modelKey(r));
    seenProviders.add(p);
    ladder.push(r);
  };

  const hasOpenRouter = Boolean(keys?.openrouter || (keys?.openrouterKeys?.length || 0) > 0);
  const hasNvidia = Boolean(keys?.nvidia || (keys?.nvidiaAccounts?.length || 0) > 0);
  const hasGateway = Boolean((keys?.gatewayEndpoints?.length || 0) > 0 || keys?.gatewayBaseUrl);

  // 1. Reservas manuais explícitas do agente e da conta (exceto se forem "auto:free", que expandem no passo 2)
  if (keys?.agentFallbackModel && !isAutoFreeModelRef(keys.agentFallbackModel)) {
    push(keys.agentFallbackModel, true);
  }
  if (keys?.gatewayFallbackModel && !isAutoFreeModelRef(keys.gatewayFallbackModel)) {
    push(keys.gatewayFallbackModel, true);
  }

  // 2. Fila Inteligente Free-First em Tempo Real (novos modelos :free avaliados automaticamente)
  if (hasOpenRouter || hasNvidia || hasGateway) {
    try {
      const explicitAuto =
        isAutoFreeModelRef(keys?.agentFallbackModel) || isAutoFreeModelRef(keys?.gatewayFallbackModel);
      const effectiveProfile = isAutoFreeModelRef(keys?.agentFallbackModel)
        ? profileFromAutoModelRef(keys?.agentFallbackModel, ladderOpts?.profile || "general")
        : ladderOpts?.profile || "general";
      const dynamicFree = await rankFreeModelsFromCatalogs({
        profile: effectiveProfile,
        requireTools: ladderOpts?.requireTools,
        requireJson: ladderOpts?.requireJson,
        excludeRefs: ladder,
        maxResults: 5,
        hasOpenRouter,
        hasNvidia,
        hasGateway,
        allowLiveFetch: ladderOpts?.allowLiveDiscovery ?? explicitAuto ? true : undefined,
      });
      for (const candidate of dynamicFree) {
        push(candidate.modelRef, true);
      }
    } catch {
      /* descoberta de catálogo falhou — segue para degraus estáticos de segurança */
    }
  }

  // 3. Provedor Gemini (melhor flash do momento, se chave configurada e rede acessível)
  if (keys?.gemini && !isProviderUnreachable("gemini")) {
    let best = "gemini-2.5-flash";
    try { best = (await pickBestFlashModel()) || best; } catch { /* offline */ }
    push(best);
  }

  // 4. Rede de segurança NVIDIA Free Endpoint (caso catálogo dinâmico estivesse frio)
  if (hasNvidia && !ladder.some((r) => r !== requestedRef && providerOf(r) === "nvidia")) {
    push("nvidia:nvidia/nemotron-3.5-lightning-30b-a3b", true);
  }

  // 5. Última rede de segurança OpenRouter (somente se não sabemos que todas as chaves são 100% sem crédito)
  if (hasOpenRouter) {
    const allOrKeys = [
      ...(Array.isArray(keys?.openrouterKeys) ? keys!.openrouterKeys! : []),
      ...(keys?.openrouter ? [keys.openrouter] : []),
    ];
    if (!areAllOpenRouterKeysFreeOnly(allOrKeys)) {
      push("openrouter:openai/gpt-4o-mini", true);
    }
  }

  return ladder;
}

/** Lê as chaves pra montar a escada — preserva chaves passadas mesmo se o banco falhar. */
async function ladderKeys(opts: {
  geminiApiKey?: string | null;
  nvidiaApiKey?: string | null;
  nvidiaAccounts?: import("@/lib/ai-keys").NvidiaAccount[] | null;
  openrouterApiKey?: string | null;
  openrouterKeys?: string[] | null;
  gatewayBaseUrl?: string | null;
  fallbackModelRef?: string | null;
}): Promise<LadderKeys> {
  let keys: Awaited<ReturnType<typeof import("@/lib/ai-keys")["getAiKeys"]>> | null = null;
  try {
    const { getAiKeys } = await import("@/lib/ai-keys");
    keys = await getAiKeys();
  } catch {
    keys = null;
  }
  return {
    gemini: opts.geminiApiKey || keys?.gemini || null,
    nvidia: opts.nvidiaApiKey || keys?.nvidia || null,
    nvidiaAccounts: opts.nvidiaAccounts || keys?.nvidiaAccounts || null,
    openrouter: opts.openrouterApiKey || keys?.openrouter || null,
    openrouterKeys: opts.openrouterKeys || keys?.openrouterKeys || null,
    gatewayBaseUrl: opts.gatewayBaseUrl || keys?.gatewayBaseUrl || null,
    gatewayEndpoints: keys?.gatewayEndpoints || null,
    agentFallbackModel: opts.fallbackModelRef || null,
    gatewayFallbackModel: keys?.gatewayFallbackModel || null,
  };
}

function normalizeGenerateTextOpts(raw: GenerateTextOpts): GenerateTextOpts & { modelRef: string; prompt: string } {
  return {
    ...raw,
    modelRef: (raw.modelRef || raw.model || "gemini-2.5-flash").trim(),
    system: raw.system ?? raw.systemPrompt,
    prompt: raw.prompt ?? raw.userPrompt ?? "",
    maxOutputTokens: raw.maxOutputTokens ?? raw.maxTokens ?? null,
  };
}

async function resolveDynamicOrStaticComboSteps(
  model: string,
  opts: {
    taskProfile?: AiTaskProfile;
    requireTools?: boolean;
    requireJson?: boolean;
    openrouterApiKey?: string | null;
    openrouterKeys?: string[] | null;
    nvidiaApiKey?: string | null;
    nvidiaAccounts?: import("@/lib/ai-keys").NvidiaAccount[] | null;
    gatewayBaseUrl?: string | null;
  },
): Promise<string[]> {
  const { getAiKeys } = await import("@/lib/ai-keys");
  const keys = await getAiKeys().catch(() => null);

  if (isAutoFreeModelRef(model)) {
    const profile = profileFromAutoModelRef(
      model,
      opts.taskProfile || (opts.requireTools ? "agent" : "general"),
    );
    const hasOpenRouter = Boolean(
      opts.openrouterApiKey ||
        (opts.openrouterKeys?.length || 0) > 0 ||
        keys?.openrouter ||
        (keys?.openrouterKeys?.length || 0) > 0,
    );
    const hasNvidia = Boolean(
      opts.nvidiaApiKey ||
        (opts.nvidiaAccounts?.length || 0) > 0 ||
        keys?.nvidia ||
        (keys?.nvidiaAccounts?.length || 0) > 0,
    );
    const hasGateway = Boolean(
      opts.gatewayBaseUrl || keys?.gatewayBaseUrl || (keys?.gatewayEndpoints?.length || 0) > 0,
    );
    const ranked = await rankFreeModelsFromCatalogs({
      profile,
      requireTools: opts.requireTools,
      requireJson: opts.requireJson,
      maxResults: 5,
      hasOpenRouter,
      hasNvidia,
      hasGateway,
      allowLiveFetch: true,
    });
    if (!ranked.length) {
      throw new ProviderHttpError(
        503,
        "Nenhum modelo gratuito disponível no catálogo em tempo real no momento.",
      );
    }
    return ranked.map((c) => c.modelRef);
  }

  return resolveComboSteps(model, keys?.aiCombos || []);
}

async function generateTextSingle(rawOpts: GenerateTextOpts): Promise<GenerateTextResult> {
  const opts = normalizeGenerateTextOpts(rawOpts);
  const { provider, model } = parseModelRef(opts.modelRef);

  if (provider === "combo") {
    const steps = await resolveDynamicOrStaticComboSteps(model, {
      taskProfile: opts.taskProfile,
      requireTools: false,
      requireJson: Boolean(opts.jsonMode || opts.geminiResponseSchema),
      openrouterApiKey: opts.openrouterApiKey,
      openrouterKeys: opts.openrouterKeys,
      nvidiaApiKey: opts.nvidiaApiKey,
      nvidiaAccounts: opts.nvidiaAccounts,
      gatewayBaseUrl: opts.gatewayBaseUrl,
    });
    if (!steps.length) {
      throw new Error(`Combo de IA "${model}" não possui modelos ativos configurados.`);
    }

    let lastErr: unknown = null;
    let accumulatedUsage = emptyUsage();
    for (let i = 0; i < steps.length; i++) {
      const stepRef = steps[i];
      try {
        const result = await generateText({
          ...opts,
          modelRef: stepRef,
          fallbackModelRef: null, // Deixa a cascata ser controlada pelo próprio combo
          noGatewayFallback: true, // Impede o refill do banco de "resolver" o passo sozinho
        });
        return {
          ...result,
          usage: addAiUsage(accumulatedUsage, result.usage),
          didFallback: i > 0,
        };
      } catch (err) {
        lastErr = err;
        const usage = aiUsageFromError(err);
        if (usage) accumulatedUsage = addAiUsage(accumulatedUsage, usage);
        console.warn(`[ai-provider:combo] Passo ${i + 1}/${steps.length} (${stepRef}) falhou (${(err as any)?.message}). Avançando para o próximo modelo do combo.`);
      }
    }

    if (lastErr instanceof AiEmptyResponseError) {
      throw new AiEmptyResponseError(lastErr.provider, lastErr.model, accumulatedUsage, lastErr);
    }
    const terminalError = lastErr instanceof Error ? lastErr : new Error(`Todos os ${steps.length} modelos do combo "${model}" falharam.`);
    throw accumulatedUsage.totalTokens > 0 ? setAiUsage(terminalError, accumulatedUsage) : terminalError;
  }

  if (provider === "openrouter") {
    const prepared = prepareJsonAwarePrompts({
      system: opts.system,
      prompt: opts.prompt,
      jsonMode: opts.jsonMode,
      geminiResponseSchema: opts.geminiResponseSchema,
    });
    const messages: any[] = [];
    if (prepared.system) messages.push(buildSystemMessage(prepared.system, provider, model));
    messages.push({ role: "user", content: prepared.prompt });
    const body: Record<string, any> = { model, messages };
    if (opts.temperature != null && Number.isFinite(opts.temperature)) body.temperature = opts.temperature;
    body.max_tokens = opts.maxOutputTokens != null ? opts.maxOutputTokens : 4096;
    if (prepared.useJsonResponseFormat) body.response_format = { type: "json_object" };
    applyReasoning(body, resolveReasoningMode(opts.reasoningMode, opts.thinkingBudget), provider, model);

    let json: OpenRouterResponse;
    try {
      json = await openRouterChatWithFailover(body, {
        openrouterApiKey: opts.openrouterApiKey,
        openrouterKeys: opts.openrouterKeys,
        signal: opts.signal,
      });
    } catch (err) {
      // Degradação automática se o modelo :free recusar response_format json_object com HTTP 400
      if (prepared.useJsonResponseFormat && isJsonFormatUnsupportedError(err)) {
        const fallbackBody = { ...body };
        delete fallbackBody.response_format;
        fallbackBody.messages = [
          ...messages.slice(0, -1),
          {
            role: "user",
            content: `${prepared.prompt}\n\nIMPORTANTE: Responda EXCLUSIVAMENTE com um JSON válido puro, sem markdown (\`\`\`) e sem texto adicional.`,
          },
        ];
        json = await openRouterChatWithFailover(fallbackBody, {
          openrouterApiKey: opts.openrouterApiKey,
          openrouterKeys: opts.openrouterKeys,
          signal: opts.signal,
        });
      } else {
        throw err;
      }
    }
    const text = String(json?.choices?.[0]?.message?.content || "").trim();
    return { text, usage: openRouterUsage(json, provider, model), provider, modelUsed: model, model, didFallback: false };
  }

  if (provider === "gateway") {
    const creds = await resolveGatewayCreds(opts, model);
    if (!creds.baseUrl) {
      throw new ProviderHttpError(0, "Gateway de assinatura indisponível: defina a URL do proxy em Configurações.");
    }
    const prepared = prepareJsonAwarePrompts({
      system: opts.system,
      prompt: opts.prompt,
      jsonMode: opts.jsonMode,
      geminiResponseSchema: opts.geminiResponseSchema,
    });
    const messages: any[] = [];
    if (prepared.system) messages.push(buildSystemMessage(prepared.system, provider, model));
    messages.push({ role: "user", content: prepared.prompt });
    const body: Record<string, any> = { model, messages };
    if (opts.temperature != null && Number.isFinite(opts.temperature)) body.temperature = opts.temperature;
    if (opts.maxOutputTokens != null) body.max_tokens = opts.maxOutputTokens;
    if (prepared.useJsonResponseFormat) body.response_format = { type: "json_object" };
    applyReasoning(body, resolveReasoningMode(opts.reasoningMode, opts.thinkingBudget), provider, model);

    let json: any;
    try {
      json = await gatewayChatWithFailover(
        model,
        body,
        { baseUrl: creds.baseUrl, apiKey: creds.apiKey, endpointId: creds.endpointId },
        { signal: opts.signal },
      );
    } catch (err) {
      if (prepared.useJsonResponseFormat && isJsonFormatUnsupportedError(err)) {
        const fallbackBody = { ...body };
        delete fallbackBody.response_format;
        fallbackBody.messages = [
          ...messages.slice(0, -1),
          {
            role: "user",
            content: `${prepared.prompt}\n\nIMPORTANTE: Responda EXCLUSIVAMENTE com um JSON válido puro, sem markdown (\`\`\`) e sem texto adicional.`,
          },
        ];
        json = await gatewayChatWithFailover(
          model,
          fallbackBody,
          { baseUrl: creds.baseUrl, apiKey: creds.apiKey, endpointId: creds.endpointId },
          { signal: opts.signal },
        );
      } else {
        throw err;
      }
    }
    const text = String(json?.choices?.[0]?.message?.content || "").trim();
    return { text, usage: openRouterUsage(json, provider, model), provider, modelUsed: model, model, didFallback: false };
  }

  if (provider === "nvidia") {
    const prepared = prepareJsonAwarePrompts({
      system: opts.system,
      prompt: opts.prompt,
      jsonMode: opts.jsonMode,
      geminiResponseSchema: opts.geminiResponseSchema,
    });
    const messages: any[] = [];
    if (prepared.system) messages.push(buildSystemMessage(prepared.system, provider, model));
    messages.push({ role: "user", content: prepared.prompt });
    const body: Record<string, any> = { model, messages };
    if (opts.temperature != null && Number.isFinite(opts.temperature)) body.temperature = opts.temperature;
    body.max_tokens = opts.maxOutputTokens != null ? opts.maxOutputTokens : 4096;
    if (prepared.useJsonResponseFormat) body.response_format = { type: "json_object" };
    applyReasoning(body, resolveReasoningMode(opts.reasoningMode, opts.thinkingBudget), provider, model);

    let json: any;
    try {
      json = await nvidiaChatWithFailover(body, {
        nvidiaApiKey: opts.nvidiaApiKey,
        nvidiaAccounts: opts.nvidiaAccounts,
        signal: opts.signal,
      });
    } catch (err) {
      if (prepared.useJsonResponseFormat && isJsonFormatUnsupportedError(err)) {
        const fallbackBody = { ...body };
        delete fallbackBody.response_format;
        fallbackBody.messages = [
          ...messages.slice(0, -1),
          {
            role: "user",
            content: `${prepared.prompt}\n\nIMPORTANTE: Responda EXCLUSIVAMENTE com um JSON válido puro, sem markdown (\`\`\`) e sem texto adicional.`,
          },
        ];
        json = await nvidiaChatWithFailover(fallbackBody, {
          nvidiaApiKey: opts.nvidiaApiKey,
          nvidiaAccounts: opts.nvidiaAccounts,
          signal: opts.signal,
        });
      } else {
        throw err;
      }
    }
    const text = String(json?.choices?.[0]?.message?.content || "").trim();
    return { text, usage: openRouterUsage(json, provider, model), provider, modelUsed: model, model, didFallback: false };
  }

  // Gemini
  if (!opts.geminiApiKey) throw new Error("API Key Gemini não configurada.");
  const genAI = new GoogleGenerativeAI(opts.geminiApiKey);
  const generationConfig: any = {};
  // Modo de raciocínio universal: reasoningMode vence; retrocompat thinkingBudget.
  const rMode = resolveReasoningMode(opts.reasoningMode, opts.thinkingBudget);
  // Econômico (0) SÓ seta thinkingBudget se o usuário escolheu explicitamente
  // (mode 0 ou thinkingBudget===0). Default sem nada = Gemini decide sozinho.
  if (opts.reasoningMode != null || opts.thinkingBudget != null) {
    generationConfig.thinkingConfig = { thinkingBudget: reasoningModeToThinkingBudget(rMode) };
  }
  if (opts.temperature != null && Number.isFinite(opts.temperature)) generationConfig.temperature = opts.temperature;
  if (opts.maxOutputTokens != null && Number.isFinite(opts.maxOutputTokens) && opts.maxOutputTokens > 0) {
    generationConfig.maxOutputTokens = Math.floor(opts.maxOutputTokens);
  }
  if (opts.jsonMode || opts.geminiResponseSchema) {
    generationConfig.responseMimeType = "application/json";
    if (opts.geminiResponseSchema) generationConfig.responseSchema = opts.geminiResponseSchema;
  }

  const buildPrompt = () => {
    // Gemini não tem "system role" no generateContent simples — prefixamos.
    return opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
  };

  const run = async (modelId: string) => {
    const mdl = genAI.getGenerativeModel({ model: modelId, generationConfig });
    return withAiTimeout(mdl.generateContent(buildPrompt()), `Gemini ${modelId}`);
  };

  try {
    const t0 = Date.now();
    const res = await run(model);
    const text = res.response.text().trim();
    const usage = geminiUsage(res, model);
    if (!text) throw new AiEmptyResponseError("gemini", model, usage);
    recordModelSuccess("gemini", model, Date.now() - t0);
    return {
      text,
      usage,
      provider,
      modelUsed: model,
      model,
      didFallback: false,
    };
  } catch (err) {
    if (isGeminiNetworkUnreachableError(err)) {
      markProviderUnreachable("gemini");
      throw err;
    }
    if (!isDeadModelError(err)) throw err;
    const fallback = await pickBestFlashModel();
    if (!fallback || fallback === model) throw err;
    console.warn(`[ai-provider] Gemini "${model}" morto. Retentando com "${fallback}".`);
    const t1 = Date.now();
    const res = await run(fallback);
    const text = res.response.text().trim();
    const usage = geminiUsage(res, fallback);
    if (!text) throw new AiEmptyResponseError("gemini", fallback, usage);
    recordModelSuccess("gemini", fallback, Date.now() - t1);
    return {
      text,
      usage,
      provider,
      modelUsed: fallback,
      model: fallback,
      didFallback: true,
    };
  }
}

/**
 * generateText PÚBLICO — escada Free-First cross-provider em volta do single:
 * falha de CONTA/MODELO no provider pedido tenta primeiro os melhores modelos
 * gratuitos vivos descobertos em tempo real, depois demais provedores configurados.
 */
export async function generateText(rawOpts: GenerateTextOpts): Promise<GenerateTextResult> {
  const opts = normalizeGenerateTextOpts(rawOpts);
  if (opts.noGatewayFallback) return generateTextSingle(opts);
  try {
    return await generateTextSingle(opts);
  } catch (err) {
    let lastErr: unknown = err;
    let accumulatedUsage = aiUsageFromError(err) || emptyUsage();
    if (!isAccountLevelError(err)) throw err;
    const effectiveProfile: AiTaskProfile =
      opts.taskProfile ||
      (opts.maxOutputTokens != null && opts.maxOutputTokens <= 150 ? "fast" : "general");
    const keys = await ladderKeys(opts);
    const ladder = await buildLadder(opts.modelRef, keys, {
      profile: effectiveProfile,
      requireTools: false,
      requireJson: Boolean(opts.jsonMode || opts.geminiResponseSchema),
      allowLiveDiscovery: opts.allowLiveDiscovery,
    });
    const rungTimeoutMs = effectiveProfile === "fast" ? 9_000 : 16_000;
    for (const rung of ladder.slice(1)) {
      const rungSignal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(rungTimeoutMs)])
        : AbortSignal.timeout(rungTimeoutMs);
      try {
        console.warn(`[ai-provider] "${opts.modelRef}" falhou (${String((err as any)?.message || err).slice(0, 120)}). Fallback inteligente → "${rung}".`);
        const res = await generateTextSingle({
          ...opts,
          modelRef: rung,
          noGatewayFallback: true,
          signal: rungSignal,
          geminiApiKey: opts.geminiApiKey || keys?.gemini || null,
          nvidiaApiKey: opts.nvidiaApiKey || keys?.nvidia || null,
          nvidiaAccounts: opts.nvidiaAccounts || keys?.nvidiaAccounts || null,
          openrouterApiKey: opts.openrouterApiKey || keys?.openrouter || null,
          openrouterKeys: opts.openrouterKeys || keys?.openrouterKeys || null,
        });
        return { ...res, usage: addAiUsage(accumulatedUsage, res.usage), didFallback: true };
      } catch (rungErr) {
        lastErr = rungErr;
        const usage = aiUsageFromError(rungErr);
        if (usage) accumulatedUsage = addAiUsage(accumulatedUsage, usage);
        console.warn(`[ai-provider] Degrau "${rung}" falhou (${String((rungErr as any)?.message || rungErr).slice(0, 80)}). Tentando próximo da escada.`);
      }
    }
    if (lastErr instanceof AiEmptyResponseError) {
      throw new AiEmptyResponseError(lastErr.provider, lastErr.model, accumulatedUsage, lastErr);
    }
    throw accumulatedUsage.totalTokens > 0 ? setAiUsage(lastErr, accumulatedUsage) : lastErr;
  }
}

// =====================================================================
// 2) startAiChat — sessão de chat com FERRAMENTAS (o Agente SDR).
//
// Abstrai a diferença entre:
//   • Gemini: chat.sendMessage([{text}]) → response.functionCalls() →
//             chat.sendMessage([{functionResponse:{name,response}}])
//   • OpenRouter: messages[] OpenAI-style → message.tool_calls →
//             {role:"tool", tool_call_id, content}
// =====================================================================

/** Declaração de ferramenta neutra (mesmo shape do functionDeclarations do Gemini). */
export interface AiFunctionDecl {
  name: string;
  description?: string;
  /** JSON Schema: { type:"object", properties:{...}, required:[...] }. */
  parameters?: any;
}

export interface AiToolCall {
  name: string;
  args: Record<string, any>;
  /** id necessário pro OpenRouter casar a resposta da tool. Gemini ignora. */
  id?: string;
}

export interface AiToolResult {
  name: string;
  id?: string;
  response: any;
}

export interface AiTurnResult {
  text: string;
  toolCalls: AiToolCall[];
  usage: AiUsage;
}

function requireUsableTurn(turn: AiTurnResult, provider: AiProvider, model: string): AiTurnResult {
  if (!turn.text.trim() && turn.toolCalls.length === 0) {
    throw new AiEmptyResponseError(provider, model, turn.usage);
  }
  return turn;
}

export interface AiChatSession {
  provider: AiProvider;
  /** Modelo realmente usado (pode mudar se houve fallback no Gemini). */
  modelUsed(): string;
  /** Envia a mensagem do usuário e retorna o turno (texto + tool calls). */
  sendUser(text: string): Promise<AiTurnResult>;
  /** Devolve os resultados das ferramentas e retorna o próximo turno. */
  sendToolResults(results: AiToolResult[]): Promise<AiTurnResult>;
}

export interface StartAiChatOpts {
  modelRef: string;
  systemInstruction: string;
  /** Histórico em formato neutro (mais antigo primeiro). */
  history: Array<{ role: "user" | "model"; text: string }>;
  tools: AiFunctionDecl[];
  temperature?: number | null;
  maxOutputTokens?: number | null;
  /** Modo de raciocínio UNIVERSAL (0=Econômico, 1=Equilibrado, 2=Intenso). */
  reasoningMode?: 0 | 1 | 2 | 3 | null;
  thinkingBudget?: number | null;
  geminiApiKey?: string | null;
  /** Chave NVIDIA NIM única ou primária. */
  nvidiaApiKey?: string | null;
  /** Lista opcional de contas NVIDIA NIM com apelido para failover multi-conta. */
  nvidiaAccounts?: import("@/lib/ai-keys").NvidiaAccount[] | null;
  openrouterApiKey?: string | null;
  /** Lista opcional de chaves OpenRouter para rotação multi-conta (9Router-style). */
  openrouterKeys?: string[] | null;
  /** Gateway de assinatura: baseURL do proxy OpenAI-compatible. Se omitido, lê do banco. */
  gatewayBaseUrl?: string | null;
  /** Gateway de assinatura: chave/management key opcional do proxy. */
  gatewayApiKey?: string | null;
  /** modelRef de RESERVA (API key) se o gateway falhar na 1ª mensagem. Se omitido, lê do banco. */
  fallbackModelRef?: string | null;
  /** Igual ao generateText: suprime o fallback global (usado pelos passos de combo). */
  noGatewayFallback?: boolean;
  /** Perfil semântico da tarefa ("agent" | "general" | "fast"). */
  taskProfile?: AiTaskProfile;
  /** Sinal opcional de cancelamento/timeout por tentativa. */
  signal?: AbortSignal;
  /** Força descoberta ao vivo de catálogo mesmo em ambiente Vitest. */
  allowLiveDiscovery?: boolean;
}

/**
 * startAiChat PÚBLICO — escada Free-First cross-provider em volta do single.
 * Sessões falham no 1º turno (não na criação), então a migração acontece ali:
 * se o turno inicial morrer com erro de CONTA ou MODELO indisponível, monta
 * sessão no próximo melhor rung gratuito/configurado e refaz o turno.
 * Em `sendToolResults`, se o modelo cair após rodar ferramentas, migra levando
 * os resultados já obtidos sem repetir as chamadas das ferramentas.
 */
export async function startAiChat(opts: StartAiChatOpts): Promise<AiChatSession> {
  const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0;
  const ladderConfig: BuildLadderOptions = {
    profile: opts.taskProfile || (hasTools ? "agent" : "general"),
    requireTools: hasTools,
    requireJson: false,
    allowLiveDiscovery: opts.allowLiveDiscovery,
  };
  let inner: AiChatSession;
  let initialRungIndex = 0;
  let resolvedKeys: LadderKeys | null = null;
  let resolvedLadder: string[] | null = null;
  try {
    inner = await startAiChatSingle(opts);
  } catch (err) {
    if (opts.noGatewayFallback || !isAccountLevelError(err)) throw err;
    resolvedKeys = await ladderKeys(opts);
    resolvedLadder = await buildLadder(opts.modelRef, resolvedKeys, ladderConfig);
    let lastErr: unknown = err;
    let initialized: AiChatSession | null = null;
    for (let index = 1; index < resolvedLadder.length; index++) {
      const rung = resolvedLadder[index];
      try {
        initialized = await startAiChatSingle({
          ...opts,
          modelRef: rung,
          noGatewayFallback: true,
          geminiApiKey: opts.geminiApiKey || resolvedKeys?.gemini || null,
          nvidiaApiKey: opts.nvidiaApiKey || resolvedKeys?.nvidia || null,
          nvidiaAccounts: opts.nvidiaAccounts || resolvedKeys?.nvidiaAccounts || null,
          openrouterApiKey: opts.openrouterApiKey || resolvedKeys?.openrouter || null,
          openrouterKeys: opts.openrouterKeys || resolvedKeys?.openrouterKeys || null,
        });
        initialRungIndex = index;
        break;
      } catch (rungErr) {
        lastErr = rungErr;
      }
    }
    if (!initialized) throw lastErr;
    inner = initialized;
  }
  if (opts.noGatewayFallback) return inner;

  let migrated: AiChatSession | null = null;
  let successfulTurns = 0;
  let lastUserText = "";
  const rungTimeoutMs = 16_000;

  return {
    get provider() { return migrated ? migrated.provider : inner.provider; },
    modelUsed: () => (migrated ? migrated.modelUsed() : inner.modelUsed()),
    async sendUser(text: string) {
      lastUserText = text;
      if (migrated) return migrated.sendUser(text);
      let accumulatedUsage = emptyUsage();
      try {
        const r = await inner.sendUser(text);
        successfulTurns++;
        return r;
      } catch (err) {
        let lastErr: unknown = err;
        const initialUsage = aiUsageFromError(err);
        if (initialUsage) accumulatedUsage = addAiUsage(accumulatedUsage, initialUsage);
        if (successfulTurns > 0 || !isAccountLevelError(err)) throw err;
        const keys = resolvedKeys || await ladderKeys(opts);
        const ladder = resolvedLadder || await buildLadder(opts.modelRef, keys, ladderConfig);
        for (const rung of ladder.slice(initialRungIndex + 1)) {
          const rungSignal = opts.signal
            ? AbortSignal.any([opts.signal, AbortSignal.timeout(rungTimeoutMs)])
            : AbortSignal.timeout(rungTimeoutMs);
          try {
            console.warn(`[ai-provider] Sessão "${opts.modelRef}" falhou no 1º turno (${String((err as any)?.message || err).slice(0, 120)}). Migrando pro fallback inteligente "${rung}".`);
            const s = await startAiChatSingle({
              ...opts,
              modelRef: rung,
              noGatewayFallback: true,
              signal: rungSignal,
              geminiApiKey: opts.geminiApiKey || keys?.gemini || null,
              nvidiaApiKey: opts.nvidiaApiKey || keys?.nvidia || null,
              nvidiaAccounts: opts.nvidiaAccounts || keys?.nvidiaAccounts || null,
              openrouterApiKey: opts.openrouterApiKey || keys?.openrouter || null,
              openrouterKeys: opts.openrouterKeys || keys?.openrouterKeys || null,
            });
            const r = await s.sendUser(text);
            migrated = s;
            successfulTurns++;
            return { ...r, usage: addAiUsage(accumulatedUsage, r.usage) };
          } catch (rungErr) {
            lastErr = rungErr;
            const usage = aiUsageFromError(rungErr);
            if (usage) accumulatedUsage = addAiUsage(accumulatedUsage, usage);
            console.warn(`[ai-provider] Degrau de sessão "${rung}" falhou (${String((rungErr as any)?.message || rungErr).slice(0, 80)}). Tentando próximo.`);
          }
        }
        if (lastErr instanceof AiEmptyResponseError) {
          throw new AiEmptyResponseError(lastErr.provider, lastErr.model, accumulatedUsage, lastErr);
        }
        throw accumulatedUsage.totalTokens > 0 ? setAiUsage(lastErr, accumulatedUsage) : lastErr;
      }
    },
    async sendToolResults(results: AiToolResult[]) {
      const target = migrated || inner;
      try {
        return await target.sendToolResults(results);
      } catch (err) {
        if (!isAccountLevelError(err) || !lastUserText) throw err;
        let accumulatedUsage = emptyUsage();
        const initialUsage = aiUsageFromError(err);
        if (initialUsage) accumulatedUsage = addAiUsage(accumulatedUsage, initialUsage);
        let lastErr: unknown = err;
        const keys = resolvedKeys || await ladderKeys(opts);
        const ladder = resolvedLadder || await buildLadder(opts.modelRef, keys, ladderConfig);
        const toolContextBlock = results
          .map((tr) => `[Resultado da ferramenta "${tr.name}"]:\n${typeof tr.response === "string" ? tr.response : JSON.stringify(tr.response)}`)
          .join("\n\n");
        const replayMessage = `${lastUserText}\n\n=== RESULTADOS DAS FERRAMENTAS JÁ EXECUTADAS NESTE TURNO (USE ESTES DADOS PARA RESPONDER AO CLIENTE SEM REPETIR A MESMA CHAMADA) ===\n${toolContextBlock}`;

        for (const rung of ladder.slice(initialRungIndex + 1)) {
          const rungSignal = opts.signal
            ? AbortSignal.any([opts.signal, AbortSignal.timeout(rungTimeoutMs)])
            : AbortSignal.timeout(rungTimeoutMs);
          try {
            console.warn(`[ai-provider] sendToolResults falhou em "${target.modelUsed()}" (${String((err as any)?.message || err).slice(0, 100)}). Migrando c/ resultados p/ "${rung}".`);
            const s = await startAiChatSingle({
              ...opts,
              modelRef: rung,
              noGatewayFallback: true,
              signal: rungSignal,
              geminiApiKey: opts.geminiApiKey || keys?.gemini || null,
              nvidiaApiKey: opts.nvidiaApiKey || keys?.nvidia || null,
              nvidiaAccounts: opts.nvidiaAccounts || keys?.nvidiaAccounts || null,
              openrouterApiKey: opts.openrouterApiKey || keys?.openrouter || null,
              openrouterKeys: opts.openrouterKeys || keys?.openrouterKeys || null,
            });
            const r = await s.sendUser(replayMessage);
            migrated = s;
            return { ...r, usage: addAiUsage(accumulatedUsage, r.usage) };
          } catch (rungErr) {
            lastErr = rungErr;
            const usage = aiUsageFromError(rungErr);
            if (usage) accumulatedUsage = addAiUsage(accumulatedUsage, usage);
          }
        }
        throw accumulatedUsage.totalTokens > 0 ? setAiUsage(lastErr, accumulatedUsage) : lastErr;
      }
    },
  };
}

async function startAiChatSingle(opts: StartAiChatOpts): Promise<AiChatSession> {
  const { provider, model } = parseModelRef(opts.modelRef);

  if (provider === "combo") {
    const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0;
    const steps = await resolveDynamicOrStaticComboSteps(model, {
      taskProfile: opts.taskProfile || (hasTools ? "agent" : "general"),
      requireTools: hasTools,
      requireJson: false,
      openrouterApiKey: opts.openrouterApiKey,
      openrouterKeys: opts.openrouterKeys,
      nvidiaApiKey: opts.nvidiaApiKey,
      nvidiaAccounts: opts.nvidiaAccounts,
      gatewayBaseUrl: opts.gatewayBaseUrl,
    });
    if (!steps.length) {
      throw new Error(`Combo de IA "${model}" não possui modelos ativos configurados.`);
    }

    let currentIndex = 0;
    let activeSession: AiChatSession | null = null;
    let turnsCount = 0;

    async function initSessionAtIndex(index: number): Promise<{ session: AiChatSession; index: number }> {
      if (index >= steps.length) {
        throw new Error(`Todos os ${steps.length} modelos do combo "${model}" falharam.`);
      }

      const targetRef = steps[index];
      try {
        const session = await startAiChat({
          ...opts,
          modelRef: targetRef,
          fallbackModelRef: null,
          noGatewayFallback: true, // Sem makeFallback global: falha propaga p/ cascata
        });
        return { session, index };
      } catch (err) {
        console.warn(`[ai-provider:combo] Falha ao iniciar modelo ${index + 1}/${steps.length} (${targetRef}): ${(err as any)?.message}. Tentando próximo modelo do combo.`);
        return initSessionAtIndex(index + 1);
      }
    }

    const initialized = await initSessionAtIndex(0);
    activeSession = initialized.session;
    currentIndex = initialized.index;
    let comboLastUserText = "";

    return {
      get provider() { return activeSession ? activeSession.provider : "combo"; },
      modelUsed: () => activeSession ? activeSession.modelUsed() : steps[currentIndex] || model,
      async sendUser(text: string) {
        comboLastUserText = text;
        let accumulatedUsage = emptyUsage();
        while (true) {
          if (!activeSession) {
            const initialized = await initSessionAtIndex(currentIndex);
            activeSession = initialized.session;
            currentIndex = initialized.index;
          }
          try {
            const res = await activeSession.sendUser(text);
            turnsCount++;
            return { ...res, usage: addAiUsage(accumulatedUsage, res.usage) };
          } catch (err) {
            const usage = aiUsageFromError(err);
            if (usage) accumulatedUsage = addAiUsage(accumulatedUsage, usage);
            if (turnsCount > 0 || currentIndex + 1 >= steps.length) {
              if (err instanceof AiEmptyResponseError) {
                throw new AiEmptyResponseError(err.provider, err.model, accumulatedUsage, err);
              }
              throw accumulatedUsage.totalTokens > 0 ? setAiUsage(err, accumulatedUsage) : err;
            }
            const failedModel = steps[currentIndex];
            currentIndex++;
            console.warn(`[ai-provider:combo] Turno inicial falhou no modelo ${failedModel} (${(err as any)?.message}). Cascata para ${steps[currentIndex]}.`);
            const initialized = await initSessionAtIndex(currentIndex);
            activeSession = initialized.session;
            currentIndex = initialized.index;
          }
        }
      },
      async sendToolResults(results: AiToolResult[]) {
        if (!activeSession) {
          throw new Error("Sessão do combo não inicializada.");
        }
        try {
          return await activeSession.sendToolResults(results);
        } catch (err) {
          if (currentIndex + 1 >= steps.length || !comboLastUserText) throw err;
          let accumulatedUsage = emptyUsage();
          const usage = aiUsageFromError(err);
          if (usage) accumulatedUsage = addAiUsage(accumulatedUsage, usage);
          const toolContextBlock = results
            .map((tr) => `[Resultado da ferramenta "${tr.name}"]:\n${typeof tr.response === "string" ? tr.response : JSON.stringify(tr.response)}`)
            .join("\n\n");
          const replayMessage = `${comboLastUserText}\n\n=== RESULTADOS DAS FERRAMENTAS JÁ EXECUTADAS NESTE TURNO (USE ESTES DADOS PARA RESPONDER AO CLIENTE SEM REPETIR A MESMA CHAMADA) ===\n${toolContextBlock}`;

          let lastErr: unknown = err;
          while (currentIndex + 1 < steps.length) {
            currentIndex++;
            try {
              const nextInit = await initSessionAtIndex(currentIndex);
              activeSession = nextInit.session;
              currentIndex = nextInit.index;
              const res = await activeSession.sendUser(replayMessage);
              return { ...res, usage: addAiUsage(accumulatedUsage, res.usage) };
            } catch (nextErr) {
              lastErr = nextErr;
              const u = aiUsageFromError(nextErr);
              if (u) accumulatedUsage = addAiUsage(accumulatedUsage, u);
            }
          }
          throw accumulatedUsage.totalTokens > 0 ? setAiUsage(lastErr, accumulatedUsage) : lastErr;
        }
      },
    };
  }

  if (provider === "openrouter") {
    return startOpenAICompatibleChat(opts, model, {
      provider: "openrouter",
      post: (body) =>
        openRouterChatWithFailover(body, {
          openrouterApiKey: opts.openrouterApiKey,
          openrouterKeys: opts.openrouterKeys,
          signal: opts.signal,
        }),
    });
  }

  if (provider === "gateway") {
    const creds = await resolveGatewayCreds(opts, model);
    if (!creds.baseUrl) {
      throw new ProviderHttpError(0, "Gateway de assinatura não configurado. Defina a URL do proxy em Configurações.");
    }
    return startOpenAICompatibleChat(opts, model, {
      provider: "gateway",
      post: (body) =>
        gatewayChatWithFailover(
          model,
          body,
          { baseUrl: creds.baseUrl, apiKey: creds.apiKey, endpointId: creds.endpointId },
          { signal: opts.signal },
        ),
    });
  }

  if (provider === "nvidia") {
    return startOpenAICompatibleChat(opts, model, {
      provider: "nvidia",
      post: (body) =>
        nvidiaChatWithFailover(body, {
          nvidiaApiKey: opts.nvidiaApiKey,
          nvidiaAccounts: opts.nvidiaAccounts,
          signal: opts.signal,
        }),
    });
  }

  return startGeminiChat(opts, model);
}

// ---------- Gemini session ----------

export function isTransientRateOrServiceError(err: unknown): boolean {
  if (err instanceof ProviderHttpError) {
    return err.status === 429 || err.status === 503;
  }
  const msg = String((err as { message?: unknown })?.message || err || "").toLowerCase();
  const status = Number((err as { status?: unknown })?.status || 0);
  if (status === 429 || status === 503) return true;
  return /\b429\b|too many requests|resource.?exhausted|rate.?limit|service unavailable|\b503\b/.test(msg);
}

async function withShortTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientRateOrServiceError(err)) throw err;
    const isTestEnv = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
    if (!isTestEnv) {
      const hintMs = err instanceof ProviderHttpError && err.retryAfterMs ? err.retryAfterMs : 0;
      const waitMs = Math.min(2500, Math.max(800, hintMs || 900 + Math.floor(Math.random() * 400)));
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return await fn();
  }
}

function startGeminiChat(opts: StartAiChatOpts, requestedModel: string): AiChatSession {
  if (!opts.geminiApiKey) throw new Error("API Key Gemini não configurada.");
  const genAI = new GoogleGenerativeAI(opts.geminiApiKey);

  const generationConfig: any = {};
  // Modo de raciocínio universal: reasoningMode vence; retrocompat thinkingBudget.
  if (opts.reasoningMode != null || opts.thinkingBudget != null) {
    const rMode = resolveReasoningMode(opts.reasoningMode, opts.thinkingBudget);
    generationConfig.thinkingConfig = { thinkingBudget: reasoningModeToThinkingBudget(rMode) };
  }
  if (opts.temperature != null && Number.isFinite(opts.temperature)) generationConfig.temperature = opts.temperature;
  if (opts.maxOutputTokens != null && Number.isFinite(opts.maxOutputTokens) && opts.maxOutputTokens > 0) {
    generationConfig.maxOutputTokens = Math.floor(opts.maxOutputTokens);
  }

  const toolsConfig = opts.tools.length > 0 ? [{ functionDeclarations: opts.tools }] : undefined;
  const history = opts.history.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

  let usedModel = requestedModel;
  let chat: any = null;

  function buildChat(modelId: string) {
    const mdl = genAI.getGenerativeModel({
      model: modelId,
      tools: toolsConfig as any,
      systemInstruction: opts.systemInstruction,
      generationConfig,
    });
    return mdl.startChat({ history });
  }

  function parse(result: any): AiTurnResult {
    const calls = (result?.response?.functionCalls?.() || []).map((c: any) => ({
      name: c.name,
      args: (c.args || {}) as Record<string, any>,
    }));
    let text = "";
    try { text = result.response.text().trim(); } catch { text = ""; }
    return requireUsableTurn({ text, toolCalls: calls, usage: geminiUsage(result, usedModel) }, "gemini", usedModel);
  }

  return {
    provider: "gemini",
    modelUsed: () => usedModel,
    async sendUser(text: string) {
      // 1ª tentativa com retry curto para 429/503 transitório + fallback de modelo morto (404).
      const t0 = Date.now();
      try {
        const res = await withShortTransientRetry(async () => {
          chat = buildChat(usedModel);
          const r = await withAiTimeout(chat.sendMessage([{ text }]), `Gemini ${usedModel}`);
          return parse(r);
        });
        recordModelSuccess("gemini", usedModel, Date.now() - t0);
        return res;
      } catch (err) {
        if (isGeminiNetworkUnreachableError(err)) {
          markProviderUnreachable("gemini");
          throw err;
        }
        if (!isDeadModelError(err)) throw err;
        const fb = await pickBestFlashModel();
        if (!fb || fb === usedModel) throw err;
        console.warn(`[ai-provider] Gemini "${usedModel}" morto. Trocando p/ "${fb}".`);
        usedModel = fb;
        chat = buildChat(usedModel);
        const t1 = Date.now();
        const r = await withAiTimeout(chat.sendMessage([{ text }]), `Gemini ${fb}`);
        const parsed = parse(r);
        recordModelSuccess("gemini", fb, Date.now() - t1);
        return parsed;
      }
    },
    async sendToolResults(results: AiToolResult[]) {
      const parts = results.map((r) => ({
        functionResponse: { name: r.name, response: r.response },
      }));
      const r = await withShortTransientRetry(() =>
        withAiTimeout(chat.sendMessage(parts), `Gemini ${usedModel} tool`),
      );
      return parse(r);
    },
  };
}

// ---------- OpenAI-compatible session (OpenRouter + Gateway de Assinatura) ----------

interface OACChatDeps {
  /** Identidade do provedor pra rotular a sessão (modelUsed/erros). */
  provider: "openrouter" | "gateway" | "nvidia";
  /** POST /chat/completions já com baseURL+headers do provedor. */
  post: (body: Record<string, any>) => Promise<any>;
}

/**
 * Normaliza recursivamente um schema de parâmetros do formato Gemini (`SchemaType.OBJECT` = `"OBJECT"`,
 * `SchemaType.STRING` = `"STRING"`, `SchemaType.NUMBER` = `"NUMBER"`) para o padrão JSON Schema
 * esperado por endpoints OpenAI-compatible (Gateway/OpenCode, OpenRouter, NVIDIA NIM, DeepSeek).
 * Evita que provedores estritos devolvam HTTP 400 e desativem todas as tools do agente.
 */
export function normalizeOpenAiToolSchema(schema: Record<string, any> | null | undefined): Record<string, any> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const out: Record<string, any> = { ...schema };
  if (typeof out.type === "string") {
    out.type = out.type.toLowerCase();
  } else if (!out.type) {
    out.type = "object";
  }
  if (out.type === "object") {
    const rawProps = out.properties && typeof out.properties === "object" ? out.properties : {};
    const normProps: Record<string, any> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      normProps[k] = v && typeof v === "object" ? normalizeOpenAiToolSchema(v as Record<string, any>) : v;
    }
    out.properties = normProps;
  }
  if (out.items && typeof out.items === "object") {
    out.items = normalizeOpenAiToolSchema(out.items as Record<string, any>);
  }
  return out;
}

function startOpenAICompatibleChat(opts: StartAiChatOpts, model: string, deps: OACChatDeps): AiChatSession {
  const providerLabel = deps.provider === "gateway" ? "Gateway de assinatura" : deps.provider === "nvidia" ? "NVIDIA NIM" : "OpenRouter";

  const tools = opts.tools.length > 0
    ? opts.tools.map((d) => ({
        type: "function",
        function: {
          name: d.name,
          description: d.description || "",
          parameters: normalizeOpenAiToolSchema(d.parameters),
        },
      }))
    : undefined;

  const messages: any[] = [buildSystemMessage(opts.systemInstruction, deps.provider, model)];
  for (const m of opts.history) {
    messages.push({ role: m.role === "model" ? "assistant" : "user", content: m.text });
  }

  // Se o modelo escolhido NÃO suportar ferramentas, o provedor devolve erro.
  // Em vez de quebrar a resposta ao cliente, degradamos pra chat puro (sem
  // tools) e seguimos. Assim "nunca quebra" — no pior caso o agente responde
  // sem usar ferramentas (e o seletor já avisa o admin pra escolher um modelo
  // com suporte a ferramentas se quiser agenda/KB).
  let toolsDisabled = false;
  const temp = (opts.temperature != null && Number.isFinite(opts.temperature)) ? opts.temperature : undefined;
  // Modo de raciocínio universal (resolve 1x; mesmo valor em todos os turnos
  // do loop de tools — incl. o retry sem tools). Mapeado por applyReasoning.
  const rMode = resolveReasoningMode(opts.reasoningMode, opts.thinkingBudget);

  async function call(): Promise<AiTurnResult> {
    const body: Record<string, any> = { model, messages };
    if (tools && !toolsDisabled) { body.tools = tools; body.tool_choice = "auto"; }
    if (temp !== undefined) body.temperature = temp;
    if (opts.maxOutputTokens != null) {
      body.max_tokens = opts.maxOutputTokens;
    } else if (deps.provider === "openrouter" || deps.provider === "nvidia") {
      body.max_tokens = 4096;
    }
    applyReasoning(body, rMode, deps.provider, model);

    let json: any;
    try {
      json = await withShortTransientRetry(() => deps.post(body));
    } catch (err: any) {
      const emsg = String(err?.message || err);
      const isToolError = /tool|function/i.test(emsg);
      const isReasoningError = /reason|thinking/i.test(emsg);
      // Erro relacionado a reasoning/thinking sem erro de ferramenta → retenta COM tools e SEM applyReasoning.
      if (isReasoningError && !isToolError && rMode > 0) {
        console.warn(`[ai-provider] Modelo ${providerLabel} "${model}" recusou parâmetro de raciocínio (${emsg}). Reenviando sem reasoning.`);
        const bodyNoReason: Record<string, any> = { model, messages };
        if (tools && !toolsDisabled) { bodyNoReason.tools = tools; bodyNoReason.tool_choice = "auto"; }
        if (temp !== undefined) bodyNoReason.temperature = temp;
        if (body.max_tokens !== undefined) bodyNoReason.max_tokens = body.max_tokens;
        json = await deps.post(bodyNoReason);
      } else if (tools && !toolsDisabled && /tool|function|not support/i.test(emsg)) {
        // Erro relacionado a ferramentas → tenta de novo sem ferramentas (preservando max_tokens).
        console.warn(`[ai-provider] Modelo ${providerLabel} "${model}" recusou ferramentas (${emsg}). Reenviando sem tools.`);
        toolsDisabled = true;
        const body2: Record<string, any> = { model, messages };
        if (temp !== undefined) body2.temperature = temp;
        if (body.max_tokens !== undefined) body2.max_tokens = body.max_tokens;
        applyReasoning(body2, rMode, deps.provider, model);
        json = await deps.post(body2);
      } else {
        throw err;
      }
    }
    const msg = json?.choices?.[0]?.message || {};
    // Guarda a mensagem do assistente (com tool_calls) — necessária antes das
    // mensagens role:"tool" no próximo request.
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });
    const toolCalls: AiToolCall[] = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc: any) => {
          let args: Record<string, any> = {};
          try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
          catch { args = {}; }
          return { name: tc.function?.name, args, id: tc.id };
        })
      : [];
    return requireUsableTurn(
      { text: String(msg.content || "").trim(), toolCalls, usage: openRouterUsage(json, deps.provider, model) },
      deps.provider,
      model,
    );
  }

  return {
    provider: deps.provider,
    modelUsed: () => model,
    async sendUser(text: string) {
      const userMessageIndex = messages.length;
      messages.push({ role: "user", content: text });
      try {
        return await call();
      } catch (err) {
        messages.splice(userMessageIndex);
        throw err;
      }
    },
    async sendToolResults(results: AiToolResult[]) {
      const toolMessageIndex = messages.length;
      for (const r of results) {
        messages.push({
          role: "tool",
          tool_call_id: r.id,
          content: typeof r.response === "string" ? r.response : JSON.stringify(r.response),
        });
      }
      try {
        return await call();
      } catch (err) {
        messages.splice(toolMessageIndex);
        throw err;
      }
    },
  };
}
