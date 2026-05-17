import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/run-now
 *
 * Dispara o Organizador IA AGORA, no escopo do cliente logado.
 * Reusa /api/ai-organize internamente passando o clientId vindo da sessão
 * (não do body), então cliente não consegue rodar pra outro cliente.
 * Admin roda pro próprio escopo (ou impersonado).
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  // Lê a config central pra reaproveitar api_key/model/provider (sem expor pro browser).
  const { data: cfg } = await supabaseAdmin
    .from("ai_organizer_config")
    .select("enabled, api_key, model, provider")
    .eq("id", 1)
    .maybeSingle();
  if (!cfg) return NextResponse.json({ ok: false, error: "Organizador não configurado" }, { status: 400 });
  if (!cfg.enabled) {
    return NextResponse.json({ ok: false, error: "Organizador está DESLIGADO globalmente. Avise o admin." }, { status: 400 });
  }
  if (!cfg.api_key || !cfg.model) {
    return NextResponse.json({ ok: false, error: "API key/modelo não configurados. Avise o admin." }, { status: 400 });
  }

  const baseUrl = process.env.INTERNAL_APP_URL || new URL(req.url).origin;
  try {
    const r = await fetch(`${baseUrl}/api/ai-organize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: cfg.api_key,
        model: cfg.model,
        provider: cfg.provider,
        triggered_by: "manual",
        clientId: ctx.clientId, // ESCOPO TRAVADO no cliente da sessão
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
