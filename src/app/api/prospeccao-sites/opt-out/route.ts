import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * POST /api/prospeccao-sites/opt-out
 * body: { remote_jid: string } | { lead_ids: number[] }
 * Marca lead como opt_out — worker pula envio futuro.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));

  let filter: Record<string, any> = { client_id: ctx.clientId };
  if (Array.isArray(body.lead_ids) && body.lead_ids.length) {
    filter = { ...filter, id: body.lead_ids };
  } else if (body.remote_jid) {
    filter = { ...filter, remoteJid: String(body.remote_jid) };
  } else {
    return NextResponse.json({ ok: false, error: "Informe remote_jid ou lead_ids" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("leads_extraidos")
    .update({ opt_out: true })
    .match(filter)
    .select("id");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, updated: data?.length ?? 0 });
}