import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { aiUsageFromError, openRouterChatWithFailover, type AiUsage, type OpenRouterResponse } from "@/lib/ai-provider";
import { listAvailableOpenRouterModels } from "@/lib/openrouter-model-discovery";
import { websiteTokenBudget, websiteUsageComplete } from "@/lib/sites/agent";
import { getWebsiteSettings } from "@/lib/sites/prompts";
import { readSitesBody, requireSitesContext, requireSitesProject, SitesError, sitesErrorResponse } from "@/lib/sites/server";
import { logTokenUsage } from "@/lib/token-usage";

export const runtime = "nodejs";

export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }): Promise<NextResponse> {
  const context = await requireSitesContext(request);
  if (!context.ok) return context.response;
  try {
    const { projectId } = await props.params;
    await requireSitesProject(context.clientId, projectId);
    const settings = await getWebsiteSettings();
    if (!settings.image_generation_enabled || settings.max_images_per_day <= 0) {
      throw new SitesError(403, "Geração de imagens desabilitada.");
    }
    const { prompt } = await readSitesBody(request);
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
      throw new SitesError(400, "Prompt de imagem inválido.");
    }
    const models = await listAvailableOpenRouterModels(false, true);
    const model = models.find((item) => item.id === settings.image_model.replace(/^openrouter:/, "") && item.outputModalities?.includes("image") && (!settings.model_allowlist.length || settings.model_allowlist.some((id) => id.replace(/^openrouter:/, "") === item.id)));
    if (!model) throw new SitesError(503, "READY — AWAITING CREDENTIALS: modelo de imagem indisponível.");
    const body = { model: model.id, messages: [{ role: "user", content: prompt }], modalities: model.outputModalities?.includes("text") ? ["image", "text"] : ["image"], max_tokens: 4096, stream: false };
    const reservationId = randomUUID();
    const { data, error } = await context.db.rpc("website_reserve_images", {
      p_client_id: context.clientId, p_project_id: projectId, p_reservation_id: reservationId,
      p_tokens: websiteTokenBudget(body, model.contextLength, body.max_tokens),
    });
    if (error?.message === "website_quota_exceeded") throw new SitesError(429, "Limite de imagens ou tokens atingido.");
    if (error?.message === "website_forbidden") throw new SitesError(403, "Geração de imagens não permitida.");
    if (error?.message === "website_not_found") throw new SitesError(404, "Projeto não encontrado.");
    if (error || data !== reservationId) throw new SitesError(503, "Reserva de imagens não confirmada.");
    const settle = async (usage: AiUsage | null, images: number | null, complete: boolean): Promise<void> => {
      const { data: settled, error: settleError } = await context.db.rpc("website_settle_images", {
        p_client_id: context.clientId, p_project_id: projectId, p_reservation_id: reservationId,
        p_images: images, p_usage: usage, p_model: model.id, p_complete: complete,
      });
      if (settleError || settled !== reservationId) throw new SitesError(503, "Contabilização de imagens não confirmada.");
      if (usage) await logTokenUsage({
        source: "other", sourceLabel: "Site Studio Image", clientId: context.clientId,
        model: model.id, provider: "OpenRouter", promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
        metadata: { feature: "site-studio-image", project_id: projectId, reservation_id: reservationId, estimated: !websiteUsageComplete(usage) },
      });
    };
    let response: OpenRouterResponse;
    try {
      response = await openRouterChatWithFailover(body, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]), maxAttempts: 1, attemptBudget: { remaining: 1 }, allowImages: true });
    } catch (error) {
      await settle(aiUsageFromError(error), null, false);
      throw error;
    }
    const count = (value?: number): number => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
    const promptTokens = count(response.usage?.prompt_tokens);
    const completionTokens = count(response.usage?.completion_tokens);
    const usage: AiUsage = { promptTokens, completionTokens, totalTokens: Math.max(count(response.usage?.total_tokens), promptTokens + completionTokens), attempts: response.usage?.attempts, estimated: (response.usage as { estimated?: boolean } | undefined)?.estimated };
    const images = (response.choices?.[0]?.message?.images ?? []).map((image) => image.image_url?.url);
    const knownBatch = images.length > 0 && images.length <= 4;
    await settle(usage, knownBatch ? images.length : null, websiteUsageComplete(usage));
    if (!knownBatch || images.some((url) => typeof url !== "string" || !/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/]+=*$/.test(url) || url.length > 14_000_000)) throw new Error("Imagem retornada inválida.");
    return NextResponse.json({ images, model: model.id });
  } catch (error) {
    return sitesErrorResponse(error);
  }
}
