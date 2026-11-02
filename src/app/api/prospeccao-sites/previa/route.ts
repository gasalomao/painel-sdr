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

  if (body.action === "enfileirar_automacao" || body.action === "enfileirar_todos") {
    let targetAutoId = body.automationId;
    let autoRow: any = null;

    if (targetAutoId) {
      const { data: auto } = await supabaseAdmin
        .from("automations")
        .select("*")
        .eq("id", targetAutoId)
        .maybeSingle();
      autoRow = auto;
    } else {
      // Pega a automação em execução ou a mais recente
      const { data: activeAuto } = await supabaseAdmin
        .from("automations")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      autoRow = activeAuto;
      targetAutoId = activeAuto?.id;
    }

    const effectiveClientId = autoRow?.client_id || ctx.clientId || "00000000-0000-0000-0000-00000000a001";
    let leadIdsToEnqueue: number[] = [];

    // 1. Tenta pegar os IDs capturados pela automação em a.scrape_filters._capturedLeadIds
    const capturedIds = Array.isArray(autoRow?.scrape_filters?._capturedLeadIds)
      ? (autoRow.scrape_filters._capturedLeadIds as number[]).filter((id: any) => Number.isInteger(id))
      : [];

    if (capturedIds.length > 0) {
      const { data: matchingLeads } = await supabaseAdmin
        .from("leads_extraidos")
        .select("id, previa_status")
        .in("id", capturedIds)
        .or("previa_status.is.null,previa_status.eq.PREVIA_FALHOU,previa_status.eq.novo");
      leadIdsToEnqueue = (matchingLeads || []).map((l: any) => l.id);
    }

    // 2. Se não encontrou por _capturedLeadIds, busca por business_details._automationCapture
    if (leadIdsToEnqueue.length === 0 && targetAutoId) {
      const { data: capLeads } = await supabaseAdmin
        .from("leads_extraidos")
        .select("id")
        .eq("business_details->_automationCapture->>automationId", targetAutoId)
        .or("previa_status.is.null,previa_status.eq.PREVIA_FALHOU,previa_status.eq.novo")
        .limit(50);
      leadIdsToEnqueue = (capLeads || []).map((l: any) => l.id);
    }

    // 3. Fallback: busca leads que não têm website ou têm website vazio
    if (leadIdsToEnqueue.length === 0) {
      const { data: tenantLeads } = await supabaseAdmin
        .from("leads_extraidos")
        .select("id")
        .in("client_id", [effectiveClientId, ctx.clientId, "00000000-0000-0000-0000-00000000a001", "00000000-0000-0000-0000-000000000001"])
        .or("website.is.null,website.eq.")
        .or("previa_status.is.null,previa_status.eq.PREVIA_FALHOU,previa_status.eq.novo")
        .limit(30);
      leadIdsToEnqueue = (tenantLeads || []).map((l: any) => l.id);
    }

    if (leadIdsToEnqueue.length > 0) {
      await supabaseAdmin
        .from("leads_extraidos")
        .update({
          previa_status: "PREVIA_SOLICITADA",
          status: "PREVIA_SOLICITADA",
          previa_solicitada_em: new Date().toISOString(),
          previa_error: null,
        })
        .in("id", leadIdsToEnqueue);

      if (targetAutoId) {
        await supabaseAdmin.from("automation_logs").insert({
          automation_id: targetAutoId,
          client_id: effectiveClientId,
          kind: "previa",
          level: "info",
          message: `[Site IA] 🚀 ${leadIdsToEnqueue.length} lead(s) da automação enfileirados para geração autônoma de sites (OpenCode + Impeccable + Vercel + QA).`,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      count: leadIdsToEnqueue.length,
      automationId: targetAutoId,
      automationName: autoRow?.name || null,
      message: `${leadIdsToEnqueue.length} lead(s) ${autoRow ? `da automação "${autoRow.name}"` : ""} enfileirados para geração autônoma de sites.`,
    });
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
