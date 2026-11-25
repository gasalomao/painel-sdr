import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { checkTenantAiQuota, checkTenantRateLimit, requireFeatureAccess } from "@/lib/saas-limits";
import { getInternalSecret, INTERNAL_SECRET_HEADER } from "@/lib/internal-auth";
import { getAiKeys } from "@/lib/ai-keys";
import { providerDisplayName, providerOf } from "@/lib/ai-provider";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/run-now
 *
 * Dispara o Organizador IA AGORA, no escopo do cliente logado.
 * Reusa /api/ai-organize internamente passando o clientId vindo da sessão.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  const denied = requireFeatureAccess(ctx, "organizador");
  if (denied) return denied;

  if (!ctx.isAdmin) {
    const rl = checkTenantRateLimit(`organizer_run_now:${ctx.clientId}`, 2, 5 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Aguarde ${rl.retryAfterSec ?? 1}s antes de rodar o organizador novamente.` },
        { status: 429 },
      );
    }
    const quota = await checkTenantAiQuota(ctx.clientId, ctx.isAdmin);
    if (!quota.allowed) {
      return NextResponse.json(
        { error: quota.reason || "Limite mensal de IA do plano atingido." },
        { status: 429 },
      );
    }
  }
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const { data: cfg } = await supabaseAdmin
    .from("ai_organizer_config")
    .select("enabled, api_key, openrouter_api_key, nvidia_api_key, model, provider")
    .eq("id", 1)
    .maybeSingle();

  const aiKeys = await getAiKeys();
  const model = (cfg?.model || aiKeys.defaultAiModel || "gemini-2.5-flash").trim();
  const p = providerOf(model);
  const provider = providerDisplayName(p);

  const hasAnyKey =
    !!(
      cfg?.api_key ||
      cfg?.openrouter_api_key ||
      cfg?.nvidia_api_key ||
      aiKeys.gemini ||
      aiKeys.openrouter ||
      aiKeys.openrouterKeys?.length ||
      aiKeys.nvidia ||
      aiKeys.nvidiaAccounts?.length ||
      aiKeys.gatewayBaseUrl ||
      aiKeys.gatewayEndpoints?.length ||
      p === "combo"
    );

  if (!hasAnyKey) {
    return NextResponse.json(
      { ok: false, error: "Nenhuma credencial de IA configurada no sistema." },
      { status: 400 }
    );
  }

  const baseUrl = process.env.INTERNAL_APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  try {
    const r = await fetch(`${baseUrl}/api/ai-organize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_SECRET_HEADER]: getInternalSecret(),
      },
      body: JSON.stringify({
        apiKey: cfg?.api_key || aiKeys.gemini || "",
        model,
        provider,
        triggered_by: "manual",
        clientId: ctx.clientId,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const result = await r.json();
    if (!r.ok || result.success === false) {
      console.error("[ORGANIZER/RUN-NOW] Falha:", result?.error);
      return NextResponse.json({ ok: false, error: "Falha ao executar Organizador IA" }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      updatedCount: result.updatedCount,
      message: result.message,
      batch_id: result.batch_id,
    });
  } catch (e: unknown) {
    console.error("[ORGANIZER/RUN-NOW] Erro de rede:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Falha de comunicação ao iniciar Organizador IA" }, { status: 500 });
  }
}
