import { NextRequest, NextResponse } from "next/server";
import { enrollLeads } from "@/lib/followup-worker";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // AUTH + OWNERSHIP: cliente A não pode enrolar leads/campanha do cliente B.
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;

  try {
    const { id } = await params;

    // Carrega campanha pra: (a) checar ownership, (b) descobrir source_status
    // que essa campanha usa como pool de leads do kanban.
    const { data: camp } = await supabase
      .from("followup_campaigns")
      .select("client_id, source_status")
      .eq("id", id)
      .maybeSingle();

    if (!camp) {
      return NextResponse.json({ success: false, error: "Campanha não encontrada" }, { status: 404 });
    }
    if (!ctx.isAdmin && camp.client_id !== ctx.clientId) {
      return NextResponse.json({ success: false, error: "Campanha não pertence à sua conta" }, { status: 403 });
    }

    const body = await req.json();
    let leadIds: number[] = Array.isArray(body.lead_ids) ? body.lead_ids : [];

    // Auto-enroll: puxa leads da COLUNA DO KANBAN que a campanha aponta.
    // Padrão "follow-up" pra campanhas antigas / sem source_status definido.
    // Permite override via body.source_status pra UI dar a opção de enrolar
    // todos de OUTRA coluna pontual sem editar a campanha.
    if (body.all_in_followup === true) {
      const sourceStatus = body.source_status || camp.source_status || "follow-up";
      let leadsQ = supabase
        .from("leads_extraidos")
        .select("id")
        .eq("status", sourceStatus)
        .limit(5000);
      if (!ctx.isAdmin) leadsQ = leadsQ.eq("client_id", ctx.clientId);
      const { data: leads } = await leadsQ;
      leadIds = leadIds.concat((leads || []).map((l: any) => l.id));
    }

    leadIds = Array.from(new Set(leadIds.filter((n) => Number.isFinite(n))));

    // Se enroll manual veio com lead_ids, valida ownership de cada um
    if (!ctx.isAdmin && leadIds.length > 0) {
      const { data: owned } = await supabase
        .from("leads_extraidos")
        .select("id")
        .eq("client_id", ctx.clientId)
        .in("id", leadIds);
      const ownedSet = new Set((owned || []).map((l: any) => l.id));
      leadIds = leadIds.filter(id => ownedSet.has(id));
    }

    const r = await enrollLeads({ campaignId: id, leadIds });
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
    return NextResponse.json({ success: true, enrolled: r.enrolled });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
