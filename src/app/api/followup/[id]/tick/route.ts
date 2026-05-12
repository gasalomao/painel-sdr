import { NextRequest, NextResponse } from "next/server";
import { tickCampaign } from "@/lib/followup-worker";

export const dynamic = "force-dynamic";
// Tick pode demorar (vários envios com jitter) — Next route padrão aceita até ~60s
export const maxDuration = 300;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const r = await tickCampaign(id);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, processed: r.processed });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
