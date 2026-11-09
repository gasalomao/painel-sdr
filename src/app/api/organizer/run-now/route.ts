import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
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

  // Se o config global estava com enabled=false ou provider dessincronizado, corrige
  if (cfg && (!cfg.enabled || cfg.provider !== provider)) {
    await supabaseAdmin
      .from("ai_organizer_config")
      .update({ enabled: true, provider, model, updated_at: new Date().toISOString() })
      .eq("id", 1);
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
    });
    const result = await r.json();
    if (!r.ok || result.success === false) {
      return NextResponse.json({ ok: false, error: result.error || "Falha ao executar" }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      updatedCount: result.updatedCount,
      message: result.message,
      batch_id: result.batch_id,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Falha de rede no disparo" }, { status: 500 });
  }
}
