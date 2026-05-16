import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Ownership check pra evitar IDOR: cliente A passa id da campanha de follow-up
 * do cliente B e edita/lê/apaga. Admin (não-impersonando) tem visão global.
 */
async function ownsFollowup(req: NextRequest, id: string) {
  const tenant = await requireClientId(req);
  if (!tenant.ok) return { ok: false as const, res: tenant.response };
  if (tenant.isAdmin) return { ok: true as const, isAdmin: true, clientId: tenant.clientId };
  const { data } = await supabase.from("followup_campaigns").select("client_id").eq("id", id).maybeSingle();
  if (!data) return { ok: false as const, res: NextResponse.json({ success: false, error: "Não encontrada" }, { status: 404 }) };
  if (data.client_id !== tenant.clientId) {
    return { ok: false as const, res: NextResponse.json({ success: false, error: "Sem permissão" }, { status: 403 }) };
  }
  return { ok: true as const, isAdmin: false, clientId: tenant.clientId };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsFollowup(req, id);
  if (!own.ok) return own.res;

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
    const own = await ownsFollowup(req, id);
    if (!own.ok) return own.res;

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

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const own = await ownsFollowup(req, id);
  if (!own.ok) return own.res;
  const { error } = await supabase.from("followup_campaigns").delete().eq("id", id);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
