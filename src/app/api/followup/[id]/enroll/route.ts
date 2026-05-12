import { NextRequest, NextResponse } from "next/server";
import { enrollLeads } from "@/lib/followup-worker";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    let leadIds: number[] = Array.isArray(body.lead_ids) ? body.lead_ids : [];

    // Modo "auto-enroll": pega todos os leads que estão em follow-up no CRM
    if (body.all_in_followup === true) {
      const { data: leads } = await supabase
        .from("leads_extraidos")
        .select("id")
        .eq("status", "follow-up")
        .limit(5000);
      leadIds = leadIds.concat((leads || []).map((l: any) => l.id));
    }

    leadIds = Array.from(new Set(leadIds.filter((n) => Number.isFinite(n))));
    const r = await enrollLeads({ campaignId: id, leadIds });
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
    return NextResponse.json({ success: true, enrolled: r.enrolled });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
