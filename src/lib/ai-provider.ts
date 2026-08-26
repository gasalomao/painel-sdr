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
import { getAiKeys } from "@/lib/ai-keys";

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

export type AiProvider = "gemini" | "openrouter" | "gateway" | "combo";

export interface ModelRef {
  provider: AiProvider;
  /** id "cru" pro SDK/API do provedor (sem o prefixo do provedor). */
  model: string;
}

export const OPENROUTER_PREFIX = "openrouter:";
export const GEMINI_PREFIX = "gemini:";
/**
 * Gateway de ASSINATURA — proxy local OpenAI-compatible (ex: CLIProxyAPI) que
 * conversa com a sua CONTA logada (ChatGPT / Claude Pro-Max / Gemini) em vez de
 * gastar API key paga. O proxy decide a conta/back-end pelo nome do modelo.
 */
export const GATEWAY_PREFIX = "gateway:";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

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
  /** Id da conexão/conta (quando aplicável) pra marcação de cooldown/morto. */
  endpointId?: string;
  constructor(status: number, message: string, endpointId?: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    if (endpointId) this.endpointId = endpointId;
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
  if (provider !== "gateway" && provider !== "openrouter") {
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
  if (s.startsWith(COMBO_PREFIX)) {
    return { provider: "combo", model: s.slice(COMBO_PREFIX.length).trim() };
  }
  if (s.startsWith(GATEWAY_PREFIX)) {
    return { provider: "gateway", model: s.slice(GATEWAY_PREFIX.length).trim() };
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
  if (provider === "combo") return `${COMBO_PREFIX}${m}`;
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
  if (p === "openrouter") return "OpenRouter";
  if (p === "gateway") return "Gateway";
  return "Gemini";
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true quando o provedor não devolveu usage real (ex: DeepSeek via reverse
   *  sem métrica no SSE). Caller repasse pra metadata.estimated do logTokenUsage. */
  estimated?: boolean;
}

function emptyUsage(): AiUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function geminiUsage(resp: any): AiUsage {
  const meta = resp?.usageMetadata
    || resp?.response?.usageMetadata
    || resp?.candidates?.[0]?.usageMetadata
    || {};
  const promptTokens = Number(meta.promptTokenCount || 0);
  const completionTokens = Number(meta.candidatesTokenCount || 0);
  const totalTokens = Number(meta.totalTokenCount || (promptTokens + completionTokens));
  return { promptTokens, completionTokens, totalTokens };
}

function openRouterUsage(json: any): AiUsage {
  const u = json?.usage || {};
  const promptTokens = Number(u.prompt_tokens || 0);
  const completionTokens = Number(u.completion_tokens || 0);
  const totalTokens = Number(u.total_tokens || (promptTokens + completionTokens));
  const estimated = u?.estimated === true;
  return { promptTokens, completionTokens, totalTokens, estimated };
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
): Promise<any> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `${label} HTTP ${res.status}`;
    // Preserva o status no erro — viabiliza o FAILOVER distinguir quota/429 de
    // 5xx de credencial morta/401. (Antes virava string e se perdia.)
    throw new ProviderHttpError(
      res.status,
      typeof msg === "string" ? msg : JSON.stringify(msg),
      endpointId,
    );
  }
  return json;
}

async function openRouterChat(apiKey: string, body: Record<string, any>, keyId?: string): Promise<any> {
  return openAICompatibleChat(OPENROUTER_BASE, body, openRouterHeaders(apiKey), "OpenRouter", keyId);
}

/**
 * FAILOVER 9Router-style entre múltiplas API keys do OpenRouter.
 * Tenta as chaves disponíveis sequencialmente (pulando as em cooldown/mortas).
 * 429/quota/402 → marca cooldown temporário da chave e tenta a PRÓXIMA chave.
 * 401/403 → marca chave como MORTA (inválida) e tenta a PRÓXIMA chave.
 * 400 (Bad Request) → relança (erro de payload/modelo, trocar chave não resolve).
 */
async function openRouterChatWithFailover(
  body: Record<string, any>,
  opts: { openrouterApiKey?: string | null; openrouterKeys?: string[] | null }
): Promise<any> {
  const { markEndpointCooldown, markEndpointDead, isEndpointUnavailable } = await import("@/lib/gateway-cooldown");

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

  const candidates = rawList.map((key) => {
    // ID determinístico pro cooldown. NÃO usa prefixo da chave (vazaria
    // material da key nos logs) — só chars fixos + sufixo curto p/ leitura.
    const id = `or_sk-or-v1…${key.slice(-4)}`;
    return { key, id };
  });

  let lastErr: unknown = null;
  // Cooldown com escopo CHAVE+MODELO: limites free/429 da OpenRouter são
  // POR MODELO. Sem o modelo no ID, um único :free estourado colocava a
  // chave inteira em cooldown e derrubava TODOS os outros modelos.
  const model = String(body?.model || "");
  for (const c of candidates) {
    const coolId = model ? `${c.id}::${model}` : c.id;
    if (isEndpointUnavailable(coolId)) continue;
    try {
      return await openRouterChat(c.key, body, coolId);
    } catch (err) {
      lastErr = err;
      if (err instanceof ProviderHttpError) {
        if (err.status === 401 || err.status === 403) {
          // Credencial inválida vale pro modelo TODOS — marca a chave crua.
          markEndpointDead(c.id);
          console.warn(`[ai-provider:openrouter] Chave ${c.id} marcada MORTA (HTTP ${err.status}). Rotacionando para próxima chave OpenRouter.`);
          continue;
        }
        if (err.status === 429 || err.status === 402 || isFailoverableStatus(err.status, err.message)) {
          markEndpointCooldown(coolId);
          console.warn(`[ai-provider:openrouter] ${coolId} em cooldown (HTTP ${err.status}). Rotacionando para próxima chave/modelo.`);
          continue;
        }
        throw err;
      }
      console.warn(`[ai-provider:openrouter] Chave ${c.id} falhou (rede/timeout). Rotacionando:`, (err as any)?.message);
      continue;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Todas as chaves OpenRouter falharam ou estão em cooldown. Tente novamente mais tarde.");
}

async function gatewayChat(baseUrl: string, apiKey: string | null, body: Record<string, any>, endpointId?: string): Promise<any> {
  // Se for a rota interna do DeepSeek Web, chama o client diretamente em memória sem HTTP loopback
  if (endpointId === "ds_internal" || baseUrl.includes("deepseek-chat")) {
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

  return openAICompatibleChat(baseUrl, body, gatewayHeaders(apiKey), "Gateway de assinatura", endpointId);
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
async function resolveGatewayCreds(opts: {
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
async function gatewayChatWithFailover(
  model: string,
  body: Record<string, any>,
  primary: { baseUrl: string; apiKey: string | null; endpointId?: string },
): Promise<any> {
  const { listEndpointsForModel } = await import("@/lib/gateway-model-discovery");
  const { markEndpointCooldown, markEndpointDead, isEndpointUnavailable } = await import("@/lib/gateway-cooldown");

  // Candidatos: primário primeiro, depois as alternativas (sem repetir).
  const alts = await listEndpointsForModel(model);
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
  for (const c of candidates) {
    // Pula endpoints sabidamente indisponíveis (cooldown/morto) ANTES de chamar.
    if (c.endpointId && isEndpointUnavailable(c.endpointId)) continue;
    try {
      return await gatewayChat(c.baseUrl, c.apiKey, body, c.endpointId);
    } catch (err) {
      lastErr = err;
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
        throw err;
      }
      // Erro de rede/timeout (não ProviderHttpError) → tenta próxima conta.
      console.warn(`[ai-provider] Conta ${c.endpointId || c.baseUrl} falhou (rede/timeout). Failover:`, (err as any)?.message);
      continue;
    }
  }
  // Esgotou todos os candidatos (ou todos em cooldown/mortos).
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Todas as contas do gateway falharam ou estão em cooldown. Tente novamente mais tarde.");
}

// =====================================================================
// 1) generateText — chamada única (sem ferramentas).
// =====================================================================

export interface GenerateTextOpts {
  /** modelRef salvo no banco (com ou sem prefixo de provedor). */
  modelRef: string;
  /** Instruções de sistema (persona/regras). Opcional. */
  system?: string;
  /** Conteúdo do usuário / prompt principal. */
  prompt: string;
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
  /** Chave Gemini (se não vier, o caller deve garantir uma). */
  geminiApiKey?: string | null;
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
  /** Só Gemini: schema estruturado pra saída JSON garantida (responseSchema). */
  geminiResponseSchema?: any;
}

export interface GenerateTextResult {
  text: string;
  usage: AiUsage;
  provider: AiProvider;
  modelUsed: string;
  didFallback: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// ESCADA DE FALLBACK CROSS-PROVIDER ("nunca quebra")
// A rotação de CONTAS já existe dentro de cada provider (chaves OpenRouter,
// contas do gateway, cascata de combos). O que faltava era a travessia:
// Gemini com quota estourada não caía pra OpenRouter; generateText no
// OpenRouter não caía pro Gemini. A escada cobre isso num lugar só —
// generateText e startAiChat ganham de graça.
// ─────────────────────────────────────────────────────────────────────

/**
 * Esse erro justifica tentar OUTRO provider? Erros de CONTA (quota/429/auth/
 * rede) sim — outra conta resolve. Erros de REQUEST (400 bad request puro,
 * 404 modelo morto) não — qualquer provider daria o mesmo erro (e modelo
 * morto já tem retry interno próprio).
 */
function isAccountLevelError(err: unknown): boolean {
  if (err instanceof ProviderHttpError) return isFailoverableStatus(err.status, err.message);
  const msg = String((err as any)?.message || err);
  return /quota|exhaust|429|rate.?limit|timeout|deadline|network|ENOTFOUND|ECONNRESET|fetch failed|api key|unauthor|forbidden|unavailable|overloaded/i.test(msg);
}

/** Chaves mínimas que a escada precisa pra montar os rungs. */
interface LadderKeys {
  gemini?: string | null;
  openrouter?: string | null;
  openrouterKeys?: string[] | null;
  gatewayFallbackModel?: string | null;
}

/**
 * Monta a escada de fallback cross-provider, dedup POR PROVIDER (a rotação
 * interna já cobre "outra conta do mesmo provider"):
 *   1. modelRef pedido
 *   2. gatewayFallbackModel — RESERVA ESCOLHIDA PELO USUÁRIO em
 *      Configurações ("Modelo de reserva"). É aqui que o usuário decide pra
 *      onde cair primeiro.
 *   3. melhor flash ATUAL descoberto na hora (pickBestFlashModel — consulta
 *      a lista real da Google; nunca fica ultrapassado como um id fixo)
 *   4. openrouter:openai/gpt-4o-mini (último rung, pago porém frações de
 *      centavo; só é alcançado quando TUDO acima morreu. ponytail: se
 *      preferir sem custo, remova este rung.)
 */
async function buildLadder(requestedRef: string, keys: LadderKeys | null): Promise<string[]> {
  const ladder = [requestedRef];
  const seen = new Set<string>([providerOf(requestedRef)]);
  const push = (ref: string | null | undefined) => {
    const r = (ref || "").trim();
    if (!r) return;
    const p = providerOf(r);
    if (seen.has(p)) return;
    seen.add(p);
    ladder.push(r);
  };
  push(keys?.gatewayFallbackModel);
  if (keys?.gemini) {
    // Descoberta dinâmica: o melhor flash DISPONÍVEL AGORA (ex.: gemini-3.x
    // quando existir) — não um id hardcoded que envelhece.
    let best = "gemini-2.5-flash"; // piso se a descoberta falhar (modelo velho mas vivo)
    try { best = (await pickBestFlashModel()) || best; } catch { /* offline: usa o piso */ }
    push(best);
  }
  if (keys?.openrouter || (keys?.openrouterKeys?.length || 0) > 0) push("openrouter:openai/gpt-4o-mini");
  return ladder;
}

/** Lê as chaves pra montar a escada — best-effort (DB fora = escada vazia). */
async function ladderKeys(opts: { geminiApiKey?: string | null; openrouterApiKey?: string | null; openrouterKeys?: string[] | null }): Promise<LadderKeys | null> {
  try {
    const { getAiKeys } = await import("@/lib/ai-keys");
    const keys = await getAiKeys();
    return {
      gemini: opts.geminiApiKey || keys?.gemini || null,
      openrouter: opts.openrouterApiKey || keys?.openrouter || null,
      openrouterKeys: opts.openrouterKeys || keys?.openrouterKeys || null,
      gatewayFallbackModel: keys?.gatewayFallbackModel || null,
    };
  } catch {
    return null;
  }
}

async function generateTextSingle(opts: GenerateTextOpts): Promise<GenerateTextResult> {
  const { provider, model } = parseModelRef(opts.modelRef);

  if (provider === "combo") {
    const { getAiKeys } = await import("@/lib/ai-keys");
    const keys = await getAiKeys();
    const steps = resolveComboSteps(model, keys?.aiCombos);
    if (!steps.length) {
      throw new Error(`Combo de IA "${model}" não possui modelos ativos configurados.`);
    }

    let lastErr: unknown = null;
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
          didFallback: i > 0,
        };
      } catch (err) {
        lastErr = err;
        console.warn(`[ai-provider:combo] Passo ${i + 1}/${steps.length} (${stepRef}) falhou (${(err as any)?.message}). Avançando para o próximo modelo do combo.`);
      }
    }

    // Se todos os passos do combo falharam, tenta o fallback global (opts ou banco).
    const comboGlobalFallback = (opts.fallbackModelRef || "").trim() || keys?.gatewayFallbackModel || null;
    if (comboGlobalFallback && comboGlobalFallback !== opts.modelRef) {
      console.warn(`[ai-provider:combo] Todos os modelos do combo "${model}" falharam. Acionando fallback global: "${comboGlobalFallback}".`);
      const res = await generateText({ ...opts, modelRef: comboGlobalFallback, fallbackModelRef: null });
      return { ...res, didFallback: true };
    }

    throw lastErr instanceof Error ? lastErr : new Error(`Todos os ${steps.length} modelos do combo "${model}" falharam.`);
  }

  if (provider === "openrouter") {
    const messages: any[] = [];
    if (opts.system) messages.push(buildSystemMessage(opts.system, provider, model));
    messages.push({ role: "user", content: opts.prompt });
    const body: Record<string, any> = { model, messages };
    if (opts.temperature != null && Number.isFinite(opts.temperature)) body.temperature = opts.temperature;
    body.max_tokens = opts.maxOutputTokens != null ? opts.maxOutputTokens : 4096;
    if (opts.jsonMode) body.response_format = { type: "json_object" };
    applyReasoning(body, resolveReasoningMode(opts.reasoningMode, opts.thinkingBudget), provider, model);
    const json = await openRouterChatWithFailover(body, {
      openrouterApiKey: opts.openrouterApiKey,
      openrouterKeys: opts.openrouterKeys,
    });
    const text = String(json?.choices?.[0]?.message?.content || "").trim();
    return { text, usage: openRouterUsage(json), provider, modelUsed: model, didFallback: false };
  }

  if (provider === "gateway") {
    const creds = await resolveGatewayCreds(opts, model);
    if (!creds.baseUrl) {
      // Sem proxy configurado: se houver reserva, usa ela; senão erro claro.
      if (creds.fallbackModelRef && creds.fallbackModelRef !== opts.modelRef) {
        const r = await generateText({ ...opts, modelRef: creds.fallbackModelRef, gatewayBaseUrl: null, fallbackModelRef: null });
        return { ...r, didFallback: true };
      }
      throw new Error("Gateway de assinatura não configurado. Defina a URL do proxy em Configurações.");
    }
    const messages: any[] = [];
    if (opts.system) messages.push(buildSystemMessage(opts.system, provider, model));
    messages.push({ role: "user", content: opts.prompt });
    const body: Record<string, any> = { model, messages };
    if (opts.temperature != null && Number.isFinite(opts.temperature)) body.temperature = opts.temperature;
    if (opts.maxOutputTokens != null) body.max_tokens = opts.maxOutputTokens;
    if (opts.jsonMode) body.response_format = { type: "json_object" };
    applyReasoning(body, resolveReasoningMode(opts.reasoningMode, opts.thinkingBudget), provider, model);
    try {
      const json = await gatewayChatWithFailover(model, body, { baseUrl: creds.baseUrl, apiKey: creds.apiKey, endpointId: creds.endpointId });
      const text = String(json?.choices?.[0]?.message?.content || "").trim();
      return { text, usage: openRouterUsage(json), provider, modelUsed: model, didFallback: false };
    } catch (err) {
      // "Nunca quebra": gateway caiu/deslogou → cai pro modelo de reserva (API key).
      if (creds.fallbackModelRef && creds.fallbackModelRef !== opts.modelRef) {
        console.warn(`[ai-provider] Gateway falhou (${(err as any)?.message}). Caindo pro fallback "${creds.fallbackModelRef}".`);
        const r = await generateText({ ...opts, modelRef: creds.fallbackModelRef, gatewayBaseUrl: null, fallbackModelRef: null });
        return { ...r, didFallback: true };
      }
      throw err;
    }
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
  if (opts.maxOutputTokens != null) generationConfig.maxOutputTokens = opts.maxOutputTokens;
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
    const res = await run(model);
    return {
      text: res.response.text().trim(),
      usage: geminiUsage(res),
      provider,
      modelUsed: model,
      didFallback: false,
    };
  } catch (err) {
    if (!isDeadModelError(err)) throw err;
    const fallback = await pickBestFlashModel();
    if (!fallback || fallback === model) throw err;
    console.warn(`[ai-provider] Gemini "${model}" morto. Retentando com "${fallback}".`);
    const res = await run(fallback);
    return {
      text: res.response.text().trim(),
      usage: geminiUsage(res),
      provider,
      modelUsed: fallback,
      didFallback: true,
    };
  }
}

/**
 * generateText PÚBLICO — escada cross-provider em volta do single:
 * falha de CONTA no provider pedido (quota/429/auth/rede) tenta os rungs
 * de OUTROS providers configurados. Só lança de verdade quando NENHUMA
 * conta/provider consegue atender — exatamente o contrato do disparo:
 * "IA reescrevendo" não pode cair no template cru por 1 chave morta.
 */
export async function generateText(opts: GenerateTextOpts): Promise<GenerateTextResult> {
  if (opts.noGatewayFallback) return generateTextSingle(opts);
  try {
    return await generateTextSingle(opts);
  } catch (err) {
    if (!isAccountLevelError(err)) throw err;
    const keys = await ladderKeys(opts);
    const ladder = await buildLadder(opts.modelRef, keys);
    for (const rung of ladder.slice(1)) {
      try {
        console.warn(`[ai-provider] "${opts.modelRef}" falhou (${String((err as any)?.message || err).slice(0, 120)}). Fallback cross-provider → "${rung}".`);
        const res = await generateTextSingle({
          ...opts,
          modelRef: rung,
          noGatewayFallback: true,
          geminiApiKey: keys?.gemini || null,
          openrouterApiKey: keys?.openrouter || null,
          openrouterKeys: keys?.openrouterKeys || null,
        });
        return { ...res, didFallback: true };
      } catch (rungErr) {
        if (!isAccountLevelError(rungErr)) throw rungErr;
        // rung morreu com erro de conta também → tenta o próximo
      }
    }
    throw err; // esgotou a escada inteira — aí sim falha de verdade
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
}

/**
 * startAiChat PÚBLICO — escada cross-provider em volta do single. Sessões
 * falham no 1º turno (não na criação), então a migração acontece ali:
 * se o turno inicial morrer com erro de CONTA, monta sessão no próximo
 * rung de outro provider e refaz o turno. Migra UMA vez — depois do 1º
 * turno bem-sucedido nunca troca (não perde contexto no meio da conversa).
 * Só lança quando NENHUMA conta/provider consegue atender.
 */
export async function startAiChat(opts: StartAiChatOpts): Promise<AiChatSession> {
  const inner = await startAiChatSingle(opts);
  if (opts.noGatewayFallback) return inner;

  let migrated: AiChatSession | null = null;
  let successfulTurns = 0;

  return {
    provider: inner.provider,
    modelUsed: () => (migrated ? migrated.modelUsed() : inner.modelUsed()),
    async sendUser(text: string) {
      if (migrated) return migrated.sendUser(text);
      try {
        const r = await inner.sendUser(text);
        successfulTurns++;
        return r;
      } catch (err) {
        if (successfulTurns > 0 || !isAccountLevelError(err)) throw err;
        const keys = await ladderKeys(opts);
        const ladder = await buildLadder(opts.modelRef, keys);
        for (const rung of ladder.slice(1)) {
          try {
            console.warn(`[ai-provider] Sessão "${opts.modelRef}" falhou no 1º turno (${String((err as any)?.message || err).slice(0, 120)}). Migrando pro fallback cross-provider "${rung}".`);
            const s = await startAiChatSingle({
              ...opts,
              modelRef: rung,
              noGatewayFallback: true,
              geminiApiKey: opts.geminiApiKey || keys?.gemini || null,
              openrouterApiKey: opts.openrouterApiKey || keys?.openrouter || null,
              openrouterKeys: opts.openrouterKeys || keys?.openrouterKeys || null,
            });
            const r = await s.sendUser(text);
            migrated = s;
            successfulTurns++;
            return r;
          } catch {
            // rung morreu também → tenta o próximo da escada
          }
        }
        throw err; // esgotou a escada inteira
      }
    },
    async sendToolResults(results: AiToolResult[]) {
      if (migrated) return migrated.sendToolResults(results);
      return inner.sendToolResults(results);
    },
  };
}

async function startAiChatSingle(opts: StartAiChatOpts): Promise<AiChatSession> {
  const { provider, model } = parseModelRef(opts.modelRef);

  if (provider === "combo") {
    const { getAiKeys } = await import("@/lib/ai-keys");
    const keys = await getAiKeys();
    const steps = resolveComboSteps(model, keys?.aiCombos);
    if (!steps.length) {
      throw new Error(`Combo de IA "${model}" não possui modelos ativos configurados.`);
    }

    let currentIndex = 0;
    let activeSession: AiChatSession | null = null;
    let turnsCount = 0;

    async function initSessionAtIndex(index: number): Promise<AiChatSession> {
      if (index >= steps.length) {
        const comboGlobalFallback = (opts.fallbackModelRef || "").trim() || keys?.gatewayFallbackModel || null;
        if (comboGlobalFallback && comboGlobalFallback !== opts.modelRef) {
          console.warn(`[ai-provider:combo] Todos os modelos do combo "${model}" falharam na inicialização. Acionando fallback global: "${comboGlobalFallback}".`);
          return startAiChat({ ...opts, modelRef: comboGlobalFallback, fallbackModelRef: null });
        }
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
        return session;
      } catch (err) {
        console.warn(`[ai-provider:combo] Falha ao iniciar modelo ${index + 1}/${steps.length} (${targetRef}): ${(err as any)?.message}. Tentando próximo modelo do combo.`);
        return initSessionAtIndex(index + 1);
      }
    }

    activeSession = await initSessionAtIndex(0);

    return {
      provider: "combo",
      modelUsed: () => activeSession ? activeSession.modelUsed() : steps[currentIndex] || model,
      async sendUser(text: string) {
        if (!activeSession) {
          activeSession = await initSessionAtIndex(currentIndex);
        }
        try {
          const res = await activeSession.sendUser(text);
          turnsCount++;
          return res;
        } catch (err) {
          // Se falhou no primeiro turno, tenta o próximo modelo do combo
          if (turnsCount === 0 && currentIndex + 1 < steps.length) {
            currentIndex++;
            console.warn(`[ai-provider:combo] Turno inicial falhou no modelo ${steps[currentIndex - 1]} (${(err as any)?.message}). Cascata para ${steps[currentIndex]}.`);
            activeSession = await initSessionAtIndex(currentIndex);
            return activeSession.sendUser(text);
          }
          throw err;
        }
      },
      async sendToolResults(results: AiToolResult[]) {
        if (!activeSession) {
          throw new Error("Sessão do combo não inicializada.");
        }
        return activeSession.sendToolResults(results);
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
        }),
      makeFallback: opts.geminiApiKey ? async () => {
        // Usa a reserva ESCOLHIDA pelo usuário se configurada; senão o melhor flash descoberto
        let target = opts.fallbackModelRef || (await ladderKeys(opts))?.gatewayFallbackModel || null;
        if (!target) {
          try { target = (await pickBestFlashModel()) || "gemini-2.5-flash"; }
          catch { target = "gemini-2.5-flash"; }
        }
        console.warn(`[ai-provider] OpenRouter falhou em todas as chaves. Fazendo fallback de último caso para "${target}".`);
        return startAiChat({ ...opts, modelRef: target });
      } : undefined
    });
  }

  if (provider === "gateway") {
    const creds = await resolveGatewayCreds(opts, model);
    const fb = creds.fallbackModelRef && creds.fallbackModelRef !== opts.modelRef ? creds.fallbackModelRef : null;
    if (!creds.baseUrl) {
      // Sem proxy: usa a reserva direto, ou erro claro.
      if (fb) return startAiChat({ ...opts, modelRef: fb, gatewayBaseUrl: null, fallbackModelRef: null });
      throw new Error("Gateway de assinatura não configurado. Defina a URL do proxy em Configurações.");
    }
    return startOpenAICompatibleChat(opts, model, {
      provider: "gateway",
      post: (body) => gatewayChatWithFailover(model, body, { baseUrl: creds.baseUrl, apiKey: creds.apiKey, endpointId: creds.endpointId }),
      // "Nunca quebra": se a 1ª mensagem falhar, migra a sessão pro fallback (API key).
      makeFallback: fb ? () => startAiChat({ ...opts, modelRef: fb, gatewayBaseUrl: null, fallbackModelRef: null }) : undefined,
    });
  }

  return startGeminiChat(opts, model);
}

// ---------- Gemini session ----------

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
    return { text, toolCalls: calls, usage: geminiUsage(result) };
  }

  return {
    provider: "gemini",
    modelUsed: () => usedModel,
    async sendUser(text: string) {
      // 1ª tentativa com fallback automático de modelo morto (404 generateContent).
      try {
        chat = buildChat(usedModel);
        const r = await withAiTimeout(chat.sendMessage([{ text }]), `Gemini ${usedModel}`);
        return parse(r);
      } catch (err) {
        if (!isDeadModelError(err)) throw err;
        const fb = await pickBestFlashModel();
        if (!fb || fb === usedModel) throw err;
        console.warn(`[ai-provider] Gemini "${usedModel}" morto. Trocando p/ "${fb}".`);
        usedModel = fb;
        chat = buildChat(usedModel);
        const r = await withAiTimeout(chat.sendMessage([{ text }]), `Gemini ${fb}`);
        return parse(r);
      }
    },
    async sendToolResults(results: AiToolResult[]) {
      const parts = results.map((r) => ({
        functionResponse: { name: r.name, response: r.response },
      }));
      const r = await withAiTimeout(chat.sendMessage(parts), `Gemini ${usedModel} tool`);
      return parse(r);
    },
  };
}

// ---------- OpenAI-compatible session (OpenRouter + Gateway de Assinatura) ----------

interface OACChatDeps {
  /** Identidade do provedor pra rotular a sessão (modelUsed/erros). */
  provider: "openrouter" | "gateway";
  /** POST /chat/completions já com baseURL+headers do provedor. */
  post: (body: Record<string, any>) => Promise<any>;
  /**
   * (Só gateway) Fábrica de sessão de RESERVA. Se a 1ª mensagem falhar (proxy
   * fora / conta deslogada), a sessão migra transparente pro fallback (API
   * key) — garante "nunca quebra".
   */
  makeFallback?: () => Promise<AiChatSession>;
}

function startOpenAICompatibleChat(opts: StartAiChatOpts, model: string, deps: OACChatDeps): AiChatSession {
  const providerLabel = deps.provider === "gateway" ? "Gateway de assinatura" : "OpenRouter";

  const tools = opts.tools.length > 0
    ? opts.tools.map((d) => ({
        type: "function",
        function: {
          name: d.name,
          description: d.description || "",
          parameters: d.parameters || { type: "object", properties: {} },
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

  // Estado do fallback de sessão (só gateway). Migra UMA vez, na 1ª mensagem.
  let fallbackSession: AiChatSession | null = null;
  let migrated = false;
  let successfulTurns = 0;

  async function call(): Promise<AiTurnResult> {
    const body: Record<string, any> = { model, messages };
    if (tools && !toolsDisabled) { body.tools = tools; body.tool_choice = "auto"; }
    if (temp !== undefined) body.temperature = temp;
    if (opts.maxOutputTokens != null) {
      body.max_tokens = opts.maxOutputTokens;
    } else if (deps.provider === "openrouter") {
      body.max_tokens = 4096;
    }
    applyReasoning(body, rMode, deps.provider, model);

    let json: any;
    try {
      json = await deps.post(body);
    } catch (err: any) {
      const emsg = String(err?.message || err);
      // Erro relacionado a ferramentas → tenta de novo sem ferramentas.
      if (tools && !toolsDisabled && /tool|function|not support/i.test(emsg)) {
        console.warn(`[ai-provider] Modelo ${providerLabel} "${model}" recusou ferramentas (${emsg}). Reenviando sem tools.`);
        toolsDisabled = true;
        const body2: Record<string, any> = { model, messages };
        if (temp !== undefined) body2.temperature = temp;
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
    return { text: String(msg.content || "").trim(), toolCalls, usage: openRouterUsage(json) };
  }

  return {
    provider: deps.provider,
    modelUsed: () => (migrated && fallbackSession ? fallbackSession.modelUsed() : model),
    async sendUser(text: string) {
      if (migrated && fallbackSession) return fallbackSession.sendUser(text);
      messages.push({ role: "user", content: text });
      try {
        const r = await call();
        successfulTurns++;
        return r;
      } catch (err) {
        // Só migra na PRIMEIRA mensagem (sem turnos bem-sucedidos ainda) — não
        // troca de modelo no meio da conversa pra não perder contexto.
        if (deps.makeFallback && successfulTurns === 0) {
          console.warn(`[ai-provider] Sessão ${providerLabel} falhou na 1ª msg (${(err as any)?.message}). Migrando pro fallback.`);
          fallbackSession = await deps.makeFallback();
          migrated = true;
          return fallbackSession.sendUser(text);
        }
        throw err;
      }
    },
    async sendToolResults(results: AiToolResult[]) {
      if (migrated && fallbackSession) return fallbackSession.sendToolResults(results);
      for (const r of results) {
        messages.push({
          role: "tool",
          tool_call_id: r.id,
          content: typeof r.response === "string" ? r.response : JSON.stringify(r.response),
        });
      }
      return call();
    },
  };
}
