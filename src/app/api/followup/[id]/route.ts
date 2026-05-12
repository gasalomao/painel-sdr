import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: camp, error } = await supabase
    .from("followup_campaigns")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!camp) return NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 });

  const { data: targets } = await supabase
    .from("followup_targets")
    .select("*")
    .eq("followup_campaign_id", id)
    .order("created_at", { ascending: false })
    .limit(500);

  return NextResponse.json({ success: true, campaign: camp, targets: targets || [] });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const allowed = [
      "name",
      "instance_name",
      "ai_enabled",
      "ai_model",
      "ai_prompt",
      "steps",
      "min_interval_seconds",
      "max_interval_seconds",
      "allowed_start_hour",
      "allowed_end_hour",
      "auto_execute",
      "status",
    ];
    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (body[k] !== undefined) update[k] = body[k];
    }
    if (update.status && !["active", "paused", "draft"].includes(update.status)) {
      return NextResponse.json({ success: false, error: "Status inválido" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("followup_campaigns")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, campaign: data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { error } = await supabase.from("followup_campaigns").delete().eq("id", id);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
