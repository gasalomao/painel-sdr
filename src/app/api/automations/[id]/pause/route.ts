import { NextRequest, NextResponse } from "next/server";
import { pauseAutomation } from "@/lib/automation-worker";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  const { data: owned } = await supabaseAdmin
    .from("automations")
    .select("id")
    .eq("id", id)
    .eq("client_id", auth.clientId)
    .maybeSingle();
  if (!owned) return NextResponse.json({ ok: false, error: "Automação não encontrada" }, { status: 404 });
  const r = await pauseAutomation(id);
  return NextResponse.json(r);
}
