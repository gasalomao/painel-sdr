import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { processSingleLeadPreview } from "@/lib/sites/autonomous-worker-engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/prospeccao-sites/previa
 * Body: { leadId: number, action?: "solicitar" | "executar_agora" }
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const leadId = Number(body.leadId);
  if (!leadId || !Number.isFinite(leadId)) {
    return NextResponse.json({ ok: false, error: "leadId obrigatório" }, { status: 400 });
  }

  // Busca o lead do tenant
  const { data: lead, error: findErr } = await supabaseAdmin
    .from("leads_extraidos")
    .select("*")
    .eq("id", leadId)
    .eq("client_id", ctx.clientId)
    .maybeSingle();

  if (findErr || !lead) {
    return NextResponse.json({ ok: false, error: "Lead não encontrado" }, { status: 404 });
  }

  const action = body.action || "solicitar";

  if (action === "solicitar") {
    const { error: updErr } = await supabaseAdmin
      .from("leads_extraidos")
      .update({
        previa_status: "PREVIA_SOLICITADA",
        status: "PREVIA_SOLICITADA",
        previa_solicitada_em: new Date().toISOString(),
        previa_error: null,
      })
      .eq("id", leadId)
      .eq("client_id", ctx.clientId);

    if (updErr) {
      return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      message: "Prévia enfileirada com sucesso. O worker executará o pipeline.",
      leadId,
      status: "PREVIA_SOLICITADA",
    });
  }

  if (action === "executar_agora") {
    // Execução síncrona / imediata
    try {
      const success = await processSingleLeadPreview(lead);
      const { data: updated } = await supabaseAdmin
        .from("leads_extraidos")
        .select("previa_status, link_previa, previa_qa_score, previa_error")
        .eq("id", leadId)
        .maybeSingle();

      return NextResponse.json({
        ok: success,
        leadId,
        lead: updated,
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: false, error: "Ação não suportada" }, { status: 400 });
}
