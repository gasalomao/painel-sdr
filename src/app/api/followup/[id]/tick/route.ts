import { NextRequest, NextResponse } from "next/server";
import { tickCampaign } from "@/lib/followup-worker";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { hasInternalSecret } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";
// Tick pode demorar (vários envios com jitter) — Next route padrão aceita até ~60s
export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // AUTH: cookie (UI) OU secret interno (scheduler/worker). Antes era público.
  if (!hasInternalSecret(req)) {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;

    if (!ctx.isAdmin) {
      const { id } = await params;
      const { data: camp } = await supabase
        .from("followup_campaigns")
        .select("client_id")
        .eq("id", id)
        .maybeSingle();
      if (!camp || camp.client_id !== ctx.clientId) {
        return NextResponse.json({ success: false, error: "Campanha não pertence à sua conta" }, { status: 403 });
      }
    }
  }

  try {
    const { id } = await params;
    const r = await tickCampaign(id);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, processed: r.processed });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
