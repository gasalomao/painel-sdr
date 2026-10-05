import { addAiUsage, aiUsageFromError, openRouterChatWithFailover, ProviderHttpError, type AiUsage, type OpenRouterResponse } from "@/lib/ai-provider";
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

export function filterWebsiteModels(models: WebsiteModel[], settings: WebsiteSettings): WebsiteModel[] {
  const allowed = new Set<string>();
  for (const raw of settings.model_allowlist) {
    allowed.add(raw);
    allowed.add(cleanModelId(raw));
  }
  return models.filter((model) => {
    const cleanId = cleanModelId(model.id);
    return (!allowed.size || allowed.has(model.id) || allowed.has(cleanId))
      && (!model.outputModalities?.length || model.outputModalities.includes("text"));
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

export function selectWebsiteModels(models: WebsiteModel[], settings: WebsiteSettings, mode: ModelMode, selected?: string | null, vision = false): WebsiteModel[] {
  const available = filterWebsiteModels(models, settings);
  const rawTarget = selected || (mode === "economy" ? settings.economy_model : settings.quality_model);
  const cleanSelected = rawTarget ? cleanModelId(rawTarget).toLowerCase() : "";
  let target = available.find((model) => model.id === rawTarget || cleanModelId(model.id).toLowerCase() === cleanSelected || model.id.toLowerCase() === rawTarget?.toLowerCase())
    || (mode === "manual" && rawTarget ? models.find((m) => m.id === rawTarget || cleanModelId(m.id).toLowerCase() === cleanSelected) : undefined);

  // Se o usuário selecionou manualmente um modelo (ex: gateway:gemini-3.8-flash-high)
  // e ele não estava no cache da descoberta naquele milissegundo, sintetizamos o modelo
  // manual para não bloquear a chamada nem exibir erro indevido ao usuário.
  if (!target && mode === "manual" && rawTarget?.startsWith("gateway:") && (!settings.model_allowlist.length || settings.model_allowlist.some((id) => cleanModelId(id) === cleanModelId(rawTarget)))) {
    const isGateway = rawTarget.startsWith("gateway:") || (!rawTarget.includes(":") && !rawTarget.startsWith("gemini:") && !rawTarget.startsWith("nvidia:"));
    target = {
      id: rawTarget.includes(":") ? rawTarget : `gateway:${rawTarget}`,
      name: `${cleanModelId(rawTarget)} (${isGateway ? "Gateway" : "Manual"})`,
      supportsTools: true,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      contextLength: 128_000,
      pricing: { prompt: "0", completion: "0" },
      provider: rawTarget.startsWith("gemini:") ? "gemini" : rawTarget.startsWith("nvidia:") ? "nvidia" : rawTarget.startsWith("openrouter:") ? "openrouter" : "gateway",
      isFree: true,
    };
  }

  if (rawTarget && !target) throw new Error(mode === "manual" ? "Modelo manual indisponível ou sem suporte a ferramentas." : "READY — AWAITING CREDENTIALS: modelo selecionado ou configurado indisponível.");
  const freeOpenRouter = (model: WebsiteModel) => !model.id.startsWith("gemini:") && !model.id.startsWith("gateway:") && !model.id.startsWith("nvidia:") && isOpenRouterFreeModel(model);
  const freeOnly = Boolean(target && freeOpenRouter(target));
  const candidates = available.filter((model) => (!vision || model.inputModalities?.includes("image")) && (!freeOnly || freeOpenRouter(model)));

  if (target && (!vision || target.inputModalities?.includes("image")) && !candidates.some((c) => c.id === target.id)) {
    candidates.unshift(target);
  }

  if (!candidates.length) throw new Error("READY — AWAITING CREDENTIALS: nenhum modelo compatível disponível.");
  const primary = candidates.find((model) => model.id === target?.id);
  if (mode === "manual" && !vision) {
    if (!primary) throw new Error("Modelo manual indisponível ou sem suporte a ferramentas.");
    const fallbacks = candidates.filter((m) => m.id !== primary.id && (!primary.isFree || m.isFree));
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
  const count = (value?: number) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
  const promptTokens = count(response.usage?.prompt_tokens);
  const completionTokens = count(response.usage?.completion_tokens);
  return { promptTokens, completionTokens, totalTokens: Math.max(count(response.usage?.total_tokens), promptTokens + completionTokens), attempts: response.usage?.attempts };
}

export async function websiteChat(models: WebsiteModel[], body: Record<string, unknown>, signal: AbortSignal): Promise<WebsiteChatResult> {
  const attemptBudget = { remaining: 3 };
  let usage: AiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastError: unknown = new Error("Nenhum modelo compatível disponível.");
  for (const model of models.slice(0, 3)) {
    signal.throwIfAborted();
    if (!attemptBudget.remaining) break;
    try {
      const isReasoner = model.id.includes("reasoner") || model.id.includes("r1");
      const isNvidiaDeepseek = model.id.startsWith("nvidia:") && model.id.toLowerCase().includes("deepseek");
      const modelBody = { ...body };
      if (model.supportsTools === false || isReasoner || isNvidiaDeepseek) {
        delete modelBody.tools;
        delete modelBody.tool_choice;
        delete modelBody.parallel_tool_calls;
      }
      if (modelBody.reasoning && (model.id.startsWith("nvidia:") || model.id.startsWith("gemini:"))) {
        delete modelBody.reasoning;
      }

      let response: OpenRouterResponse;
      if (model.id.startsWith("gemini:")) {
        const { getAiKeys } = await import("@/lib/ai-keys");
        const keys = await getAiKeys();
        const cleanModel = model.id.replace(/^gemini:/, "");
        if (keys?.gemini) {
          const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${keys.gemini}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...modelBody, model: cleanModel, stream: false }),
            signal,
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(json?.error?.message || `Gemini HTTP ${res.status}`);
          response = json;
        } else {
          response = await openRouterChatWithFailover({ ...modelBody, model: `google/${cleanModel}`, stream: false }, { signal, maxAttempts: 1, attemptBudget });
        }
      } else if (model.id.startsWith("gateway:")) {
        const cleanModel = model.id.replace(/^gateway:/, "");
        const { resolveGatewayCreds, gatewayChatWithFailover } = await import("@/lib/ai-provider");
        const creds = await resolveGatewayCreds({}, cleanModel);
        if (!creds.baseUrl) throw new Error("Gateway de assinatura indisponível: configure uma conexão em Configurações.");
        response = await gatewayChatWithFailover(cleanModel, { ...modelBody, model: cleanModel, stream: false }, {
          baseUrl: creds.baseUrl,
          apiKey: creds.apiKey,
          endpointId: creds.endpointId,
        }, { allowEmptyContent: true });
      } else if (model.id.startsWith("nvidia:")) {
        const cleanModel = model.id.replace(/^nvidia:/, "");
        const { getAiKeys } = await import("@/lib/ai-keys");
        const keys = await getAiKeys();
        if (!keys?.nvidia) throw new Error("API Key da NVIDIA NIM não configurada em Configurações.");
        let res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${keys.nvidia}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...modelBody, model: cleanModel, stream: false }),
          signal,
        });
        let json = await res.json().catch(() => ({}));
        if (!res.ok && res.status === 400 && (modelBody.tools || modelBody.tool_choice)) {
          delete modelBody.tools;
          delete modelBody.tool_choice;
          delete modelBody.parallel_tool_calls;
          res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${keys.nvidia}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...modelBody, model: cleanModel, stream: false }),
            signal,
          });
          json = await res.json().catch(() => ({}));
        }
        if (!res.ok) throw new Error(json?.error?.message || `NVIDIA NIM HTTP ${res.status}`);
        response = json;
      } else {
        const cleanModel = model.id.replace(/^openrouter:/, "");
        response = await openRouterChatWithFailover({ ...modelBody, model: cleanModel, stream: false }, { signal, maxAttempts: 3, attemptBudget });
      }
      return { model: model.id, response, usage: addAiUsage(usage, responseUsage(response)) };
    } catch (error) {
      const failedUsage = aiUsageFromError(error);
      if (failedUsage) usage = addAiUsage(usage, failedUsage);
      if (signal.aborted || (error instanceof ProviderHttpError && error.status === 400)) throw Object.assign(error instanceof Error ? error : new Error("Chamada interrompida."), { usage });
      lastError = error;
    }
  }
  throw Object.assign(lastError instanceof Error ? lastError : new Error("OpenRouter indisponível."), { usage });
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
