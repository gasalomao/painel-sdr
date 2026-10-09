import { addAiUsage, aiUsageFromError, AiEmptyResponseError, gatewayChatWithFailover, openRouterChatWithFailover, openRouterResponseUsage, ProviderHttpError, resolveGatewayCreds, type AiUsage, type OpenRouterResponse } from "@/lib/ai-provider";
import { listAvailableOpenRouterModels, type OpenRouterModel } from "@/lib/openrouter-model-discovery";
import { listAvailableGeminiModels, type GeminiModel } from "@/lib/gemini-model-discovery";
import { listAvailableGatewayModels, type GatewayModel } from "@/lib/gateway-model-discovery";
import { listAvailableNvidiaModels, type NvidiaModel } from "@/lib/nvidia-model-discovery";
import type { ModelMode, WebsiteModel, WebsiteSettings } from "./types";

export type { WebsiteModel } from "./types";

/**
 * Normaliza o ID removendo prefixos de provedores conhecidos (openrouter:, gemini:, gateway:, nvidia:)
 */
export function cleanModelId(id: string): string {
  return id.replace(/^(?:openrouter|gemini|gateway|nvidia):/, "");
}

/**
 * Verifica se um modelo do OpenRouter é gratuito (:free ou preço zerado)
 */
export function isOpenRouterFreeModel(m: { id: string; pricing?: { prompt?: string; completion?: string } }): boolean {
  const prompt = Number(m.pricing?.prompt);
  const completion = Number(m.pricing?.completion);
  return typeof m.pricing?.prompt === "string" && m.pricing.prompt.trim() !== ""
    && typeof m.pricing?.completion === "string" && m.pricing.completion.trim() !== ""
    && Number.isFinite(prompt) && prompt === 0 && Number.isFinite(completion) && completion === 0;
}

const INCOMPATIBLE_MODEL_REGEX = /\b(lyria|whisper|tts|music|audio-preview|diffusion|flux|dall-e|midjourney|imagen|video|sora|runway|cogvideo|kling|guard|moderation|embed|rerank|bert)\b/i;

/**
 * Valida se o modelo é apto para atuar como agente de código do Site Studio.
 * Exclui modelos de áudio (Lyria, Whisper), geradores de imagem/vídeo,
 * embeddings/moderação e modelos sem suporte a ferramentas (tool-calling).
 */
export function isSuitableWebsiteAgentModel(model: WebsiteModel): boolean {
  const clean = cleanModelId(model.id).toLowerCase();
  const name = (model.name || "").toLowerCase();
  if (INCOMPATIBLE_MODEL_REGEX.test(clean) || INCOMPATIBLE_MODEL_REGEX.test(name)) {
    return false;
  }
  if (model.supportsTools === false) {
    return false;
  }
  if (model.outputModalities?.length && !model.outputModalities.includes("text")) {
    return false;
  }
  return true;
}

export function filterWebsiteModels(models: WebsiteModel[], settings: WebsiteSettings): WebsiteModel[] {
  const allowed = new Set<string>();
  for (const raw of settings.model_allowlist) {
    allowed.add(raw);
    allowed.add(cleanModelId(raw));
  }
  return models.filter((model) => {
    const cleanId = cleanModelId(model.id);
    return (!allowed.size || allowed.has(model.id) || allowed.has(cleanId))
      && isSuitableWebsiteAgentModel(model);
  });
}

export async function listWebsiteModels(settings: WebsiteSettings, force = false): Promise<WebsiteModel[]> {
  const [openRouterModels, geminiList, gatewayList, nvidiaList] = await Promise.all([
    listAvailableOpenRouterModels(force).catch(() => [] as OpenRouterModel[]),
    listAvailableGeminiModels(force).catch(() => [] as GeminiModel[]),
    listAvailableGatewayModels(force).catch(() => [] as GatewayModel[]),
    listAvailableNvidiaModels(force).catch(() => [] as NvidiaModel[]),
  ]);

  const geminiModels: WebsiteModel[] = (geminiList ?? []).map((m) => ({
    id: `gemini:${m.id}`,
    name: `Gemini ${m.displayName || m.id} (Google AI)`,
    supportsTools: true,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    contextLength: m.id.includes("pro") ? 2_000_000 : 1_000_000,
    pricing: { prompt: "0", completion: "0" },
    provider: "gemini",
    isFree: true,
  }));

  const gatewayModels: WebsiteModel[] = (gatewayList ?? []).map((m) => ({
    id: `gateway:${m.id}`,
    name: `${m.name} (${m.endpointLabel || "Gateway"})`,
    supportsTools: m.supportsTools ?? true,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    contextLength: 128_000,
    pricing: { prompt: "0", completion: "0" },
    provider: "gateway",
    isFree: true,
  }));

  const nvidiaModels: WebsiteModel[] = (nvidiaList ?? []).map((m) => ({
    id: `nvidia:${m.id}`,
    name: `${m.name} (NVIDIA NIM)`,
    supportsTools: m.supportsTools ?? true,
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextLength: m.contextLength ?? 128_000,
    pricing: { prompt: "0", completion: "0" },
    provider: "nvidia",
    isFree: true,
  }));

  const openRouterProcessed: WebsiteModel[] = (openRouterModels ?? []).map((m) => {
    const isFree = isOpenRouterFreeModel(m);
    return {
      ...m,
      name: isFree && !m.name.toLowerCase().includes("free") ? `[Grátis] ${m.name}` : m.name,
      provider: "openrouter",
      isFree,
    };
  });

  const openRouterFree = openRouterProcessed.filter((m) => m.isFree);
  const openRouterStandard = openRouterProcessed.filter((m) => !m.isFree);

  openRouterFree.sort((a, b) => a.name.localeCompare(b.name));
  gatewayModels.sort((a, b) => a.name.localeCompare(b.name));
  nvidiaModels.sort((a, b) => a.name.localeCompare(b.name));
  geminiModels.sort((a, b) => a.name.localeCompare(b.name));
  openRouterStandard.sort((a, b) => a.name.localeCompare(b.name));

  // Ordem de precedência:
  // 1. OpenRouter Grátis (primeiros)
  // 2. Gateway de Assinatura (conectados)
  // 3. NVIDIA NIM
  // 4. Google Gemini (Google AI)
  // 5. OpenRouter Geral (demais modelos)
  const combined = [
    ...openRouterFree,
    ...gatewayModels,
    ...nvidiaModels,
    ...geminiModels,
    ...openRouterStandard,
  ];

  return filterWebsiteModels(combined, settings);
}

function modelReliabilityScore(model: WebsiteModel, primary?: WebsiteModel): number {
  let score = 0;
  const clean = cleanModelId(model.id).toLowerCase();

  // Bônus se for do mesmo provedor que o primário
  if (primary && model.provider === primary.provider) score += 40;

  // Modelos de código de primeira linha
  if (clean.includes("claude-3-5") || clean.includes("claude-3-7") || clean.includes("claude-sonnet") || clean.includes("claude-opus")) score += 100;
  else if (clean.includes("gemini-2.5") || clean.includes("gemini-2.0") || clean.includes("gemini-3")) score += 95;
  else if (clean.includes("qwen-2.5-coder") || clean.includes("qwen/qwen-2.5-coder")) score += 90;
  else if (clean.includes("llama-3.3") || clean.includes("llama-3.1-70b")) score += 85;
  else if (clean.includes("gpt-4o") || clean.includes("gpt-4.5")) score += 80;
  else if (clean.includes("deepseek-chat") || clean.includes("deepseek-v3") || clean.includes("deepseek-coder")) score += 75;
  else if (clean.includes("gemini-1.5")) score += 70;
  else if (clean.includes("llama-3")) score += 60;
  else if (clean.includes("mistral") || clean.includes("codestral")) score += 55;

  if ((model.contextLength ?? 0) >= 128_000) score += 20;
  else if ((model.contextLength ?? 0) >= 64_000) score += 10;

  return score;
}

export interface WebsiteModelPolicy { freeOnly?: boolean }

export function selectWebsiteModels(models: WebsiteModel[], settings: WebsiteSettings, mode: ModelMode, selected?: string | null, vision = false, policy: WebsiteModelPolicy = {}): WebsiteModel[] {
  const available = filterWebsiteModels(models, settings);
  const rawTarget = selected || (mode === "economy" ? settings.economy_model : settings.quality_model);
  const cleanSelected = rawTarget ? cleanModelId(rawTarget).toLowerCase() : "";
  const targetProvider = rawTarget?.match(/^(openrouter|gemini|gateway|nvidia):/)?.[1];
  const target = available.find((model) => {
    const provider = model.provider || model.id.match(/^(openrouter|gemini|gateway|nvidia):/)?.[1] || "openrouter";
    return (!targetProvider || provider === targetProvider) && (model.id === rawTarget || cleanModelId(model.id).toLowerCase() === cleanSelected || model.id.toLowerCase() === rawTarget?.toLowerCase());
  }) || (mode === "manual" && rawTarget ? available.find((m) => cleanModelId(m.id).toLowerCase() === cleanSelected) : undefined);

  if (rawTarget && !target) throw new Error(mode === "manual" ? "Modelo manual indisponível ou sem suporte a ferramentas." : "READY — AWAITING CREDENTIALS: modelo selecionado ou configurado indisponível.");
  const freeOpenRouter = (model: WebsiteModel) => (!model.provider || model.provider === "openrouter") && !/^(gemini|gateway|nvidia):/.test(model.id) && isOpenRouterFreeModel(model);
  const freeOnly = policy.freeOnly === true || Boolean(target && freeOpenRouter(target));
  if (policy.freeOnly && target && !freeOpenRouter(target)) throw new Error("Modelo selecionado indisponível na política OpenRouter gratuito.");
  const candidates = available.filter((model) => (!vision || model.inputModalities?.includes("image")) && (!freeOnly || freeOpenRouter(model)));

  if (!candidates.length) throw new Error("READY — AWAITING CREDENTIALS: nenhum modelo compatível disponível.");
  const primary = candidates.find((model) => model.id === target?.id);
  if (mode === "manual" && !vision) {
    if (!primary) throw new Error("Modelo manual indisponível ou sem suporte a ferramentas.");
    const fallbacks = candidates
      .filter((m) => m.id !== primary.id && (!primary.isFree || m.isFree || primary.provider === "gateway" || m.provider === "gateway" || m.provider === "openrouter"))
      .sort((a, b) => modelReliabilityScore(b, primary) - modelReliabilityScore(a, primary) || a.id.localeCompare(b.id));
    return [primary, ...fallbacks].slice(0, 3);
  }
  const price = (model: WebsiteModel) => {
    const value = Number(model.pricing?.completion);
    return Number.isFinite(value) && value >= 0 ? value : Infinity;
  };
  const sorted = candidates.filter((model) => model.id !== primary?.id).sort((a, b) => mode === "economy"
    ? price(a) - price(b) || a.id.localeCompare(b.id)
    : (b.contextLength ?? 0) - (a.contextLength ?? 0) || price(a) - price(b) || a.id.localeCompare(b.id));
  return [...(primary ? [primary] : []), ...sorted].slice(0, 3);
}

export interface WebsiteChatResult {
  model: string;
  response: OpenRouterResponse;
  usage: AiUsage;
}

function responseUsage(response: OpenRouterResponse): AiUsage {
  return openRouterResponseUsage(response);
}

function validateChatResponse(value: unknown, model: WebsiteModel): OpenRouterResponse {
  const response = value as OpenRouterResponse | null;
  const message = response?.choices?.[0]?.message;
  const tools = message?.tool_calls;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => {
    if (!tool || typeof tool.id !== "string" || !tool.id.trim() || tool.type !== "function" || typeof tool.function?.name !== "string" || !tool.function.name.trim() || typeof tool.function.arguments !== "string") return true;
    try {
      const args: unknown = JSON.parse(tool.function.arguments);
      return !args || typeof args !== "object" || Array.isArray(args);
    } catch { return true; }
  }))) throw Object.assign(new Error("Resposta estruturada inválida do provedor."), { usage: responseUsage(response ?? {}) });
  if (!(typeof message?.content === "string" && message.content.trim()) && !tools?.length) {
    const provider = model.provider || model.id.match(/^(openrouter|gemini|gateway|nvidia):/)?.[1] || "openrouter";
    throw new AiEmptyResponseError(provider as "openrouter" | "gemini" | "gateway" | "nvidia", model.id, responseUsage(response ?? {}));
  }
  return response!;
}

async function directWebsiteChat(provider: "gemini" | "nvidia", body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const { getAiKeys } = await import("@/lib/ai-keys");
  const keys = await getAiKeys();
  const key = keys?.[provider];
  if (!key) throw new Error(`API Key ${provider === "nvidia" ? "da NVIDIA NIM" : "do Gemini"} não configurada em Configurações.`);
  signal.throwIfAborted();
  const url = provider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" : "https://integrate.api.nvidia.com/v1/chat/completions";
  const result = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const json: unknown = await result.json().catch(() => null);
  if (!result.ok) throw Object.assign(new ProviderHttpError(result.status, `${provider === "nvidia" ? "NVIDIA NIM" : "Gemini"} HTTP ${result.status}`), { usage: openRouterResponseUsage(json) });
  return json;
}

/** Uma chamada física no máximo. Reserva, fallback e retry pertencem ao caller. */
export async function websiteChatAttempt(model: WebsiteModel, body: Record<string, unknown>, signal: AbortSignal, onRetry?: (modelId: string, attempt: number, maxAttempts: number, waitSeconds: number) => void): Promise<WebsiteChatResult> {
  signal.throwIfAborted();
  if (!model || typeof model.id !== "string" || !cleanModelId(model.id).trim() || !body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages) || !body.messages.length) throw new Error("Modelo ou mensagens inválidos.");
  const prefix = model.id.match(/^(openrouter|gemini|gateway|nvidia):/)?.[1];
  if (model.provider && prefix && model.provider !== prefix) throw new Error("Provedor do modelo incompatível.");
  const provider = model.provider || prefix || "openrouter";
  const modelBody: Record<string, unknown> = { ...body, model: cleanModelId(model.id), stream: false };
  if (model.supportsTools !== true) {
    delete modelBody.tools;
    delete modelBody.tool_choice;
    delete modelBody.parallel_tool_calls;
  }
  if (provider === "gemini" || provider === "nvidia") delete modelBody.reasoning;

  const maxAttempts = 3;
  let lastError: Error = new Error("Falha desconhecida.");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal.throwIfAborted();

    try {
      let raw: unknown;
      if (provider === "gateway") {
        const creds = await resolveGatewayCreds({ noGatewayFallback: true }, cleanModelId(model.id));
        signal.throwIfAborted();
        if (!creds.baseUrl) throw new Error("Gateway de assinatura indisponível: configure uma conexão em Configurações.");
        raw = await gatewayChatWithFailover(cleanModelId(model.id), modelBody, creds, { allowEmptyContent: true, signal, maxAttempts: 1 });
      } else if (provider === "gemini" || provider === "nvidia") {
        raw = await directWebsiteChat(provider, modelBody, signal);
      } else {
        raw = await openRouterChatWithFailover(modelBody, { signal, maxAttempts: 1, allowEmptyContent: true });
      }
      const usage = openRouterResponseUsage(raw, provider as "openrouter" | "gemini" | "gateway" | "nvidia", cleanModelId(model.id));
      if (signal.aborted) throw Object.assign(signal.reason instanceof Error ? signal.reason : new Error("Chamada interrompida."), { usage });
      const response = validateChatResponse(raw, model);
      return { model: model.id, response, usage };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Provedor indisponível.");
      const reported = aiUsageFromError(error);
      const usage: AiUsage = reported ?? openRouterResponseUsage(null);
      const uncertain = !usage.attempts?.length && usage.totalTokens === 0 && usage.costUsd === undefined;
      const measured = { ...usage, ...(uncertain ? { estimated: true, usageUnknown: true } : {}) };

      // Não retry em erros 400 (bad request) ou abort
      if (signal.aborted || (error instanceof ProviderHttpError && error.status === 400)) {
        throw Object.assign(lastError, { usage: measured.attempts?.length ? measured : { ...measured, attempts: [{ ...measured, provider: provider as "openrouter" | "gemini" | "gateway" | "nvidia", model: cleanModelId(model.id) }] } });
      }

      // Se não é a última tentativa, aguardar com backoff exponencial
      if (attempt < maxAttempts) {
        const waitSeconds = Math.min(2 ** attempt, 8); // 2s, 4s, 8s
        onRetry?.(model.id, attempt + 1, maxAttempts, waitSeconds);
        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      } else {
        throw Object.assign(lastError, { usage: measured.attempts?.length ? measured : { ...measured, attempts: [{ ...measured, provider: provider as "openrouter" | "gemini" | "gateway" | "nvidia", model: cleanModelId(model.id) }] } });
      }
    }
  }

  throw lastError;
}


/** Wrapper legado com fallback explícito, limitado a três chamadas físicas. */
export async function websiteChat(
  models: WebsiteModel[],
  body: Record<string, unknown>,
  signal: AbortSignal,
  onRetry?: (modelId: string, attempt: number, maxAttempts: number, waitSeconds: number) => void
): Promise<WebsiteChatResult> {
  let usage: AiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastError: Error = new Error("Nenhum modelo compatível disponível.");

  // Primeiro: tenta até 3x no modelo primário com retry
  const primaryModel = models[0];
  if (primaryModel) {
    signal.throwIfAborted();
    try {
      const result = await attemptWithRetry(
        primaryModel,
        body,
        signal,
        3,
        (attempt, waitSeconds) => {
          onRetry?.(primaryModel.id, attempt, 3, waitSeconds);
        }
      );
      return { ...result, usage: addAiUsage(usage, result.usage) };
    } catch (error) {
      const failedUsage = aiUsageFromError(error);
      if (failedUsage) usage = addAiUsage(usage, failedUsage);
      lastError = error instanceof Error ? error : new Error("Provedor indisponível.");
      if (signal.aborted || (error instanceof ProviderHttpError && error.status === 400)) {
        throw Object.assign(lastError, { usage });
      }
    }
  }

  // Segundo: fallback para outros modelos (1 tentativa cada)
  for (const model of models.slice(1, 3)) {
    signal.throwIfAborted();
    try {
      const result = await websiteChatAttempt(model, body, signal);
      return { ...result, usage: addAiUsage(usage, result.usage) };
    } catch (error) {
      const failedUsage = aiUsageFromError(error);
      if (failedUsage) usage = addAiUsage(usage, failedUsage);
      lastError = error instanceof Error ? error : new Error("Provedor indisponível.");
      if (signal.aborted || (error instanceof ProviderHttpError && error.status === 400)) throw Object.assign(lastError, { usage });
    }
  }
  throw Object.assign(lastError, { usage });
}

export interface ImageGenerationProvider {
  generate(input: { prompt: string; settings: WebsiteSettings }, signal: AbortSignal): Promise<{ images: string[]; model: string; usage: AiUsage }>;
}

export function createImageGenerationProvider(recordUsage: (usage: AiUsage, model: string) => Promise<void>): ImageGenerationProvider {
  return {
    async generate({ prompt, settings }, signal) {
      signal.throwIfAborted();
      if (!settings.image_generation_enabled || settings.max_images_per_day <= 0) throw new Error("Geração de imagens desabilitada.");
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) throw new Error("Prompt de imagem inválido.");
      const models = await listAvailableOpenRouterModels(false, true);
      const model = models.find((item) => item.id === settings.image_model.replace(/^openrouter:/, "") && item.outputModalities?.includes("image") && (!settings.model_allowlist.length || settings.model_allowlist.some((id) => id.replace(/^openrouter:/, "") === item.id)));
      if (!model) throw new Error("READY — AWAITING CREDENTIALS: modelo de imagem indisponível.");
      let response: OpenRouterResponse;
      try {
        response = await openRouterChatWithFailover({ model: model.id, messages: [{ role: "user", content: prompt }], modalities: model.outputModalities?.includes("text") ? ["image", "text"] : ["image"], max_tokens: 4096, stream: false }, { signal, maxAttempts: 3, allowImages: true });
      } catch (error) {
        const usage = aiUsageFromError(error);
        if (usage) await recordUsage(usage, model.id);
        throw error;
      }
      const usage = responseUsage(response);
      await recordUsage(usage, model.id);
      signal.throwIfAborted();
      const images = (response.choices?.[0]?.message?.images ?? []).map((image) => image.image_url.url);
      if (!images.length || images.length > 4 || images.some((url) => !/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/]+=*$/.test(url) || url.length > 14_000_000)) throw new Error("Imagem retornada inválida.");
      return { images, model: model.id, usage };
    },
  };
}
