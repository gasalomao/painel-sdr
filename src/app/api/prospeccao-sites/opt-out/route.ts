import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { requireFeatureAccess } from "@/lib/saas-limits";
import { getBrazilPhoneVariants } from "@/lib/jid-utils";

export const dynamic = "force-dynamic";

/**
 * POST /api/prospeccao-sites/opt-out
 * body: { remote_jid: string } | { lead_ids: number[] }
 * Marca lead como opt_out — worker pula envio futuro.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  const denied = requireFeatureAccess(ctx, "prospeccao_sites");
  if (denied) return denied;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));

  let query = supabaseAdmin
    .from("leads_extraidos")
    .update({ opt_out: true })
    .eq("client_id", ctx.clientId);

  if (Array.isArray(body.lead_ids) && body.lead_ids.length) {
    const numericIds = body.lead_ids
      .map((id: unknown) => Number(id))
      .filter((n: number) => Number.isInteger(n) && n > 0);
    if (numericIds.length === 0) {
      return NextResponse.json({ ok: false, error: "lead_ids inválidos" }, { status: 400 });
    }
    query = query.in("id", numericIds);
  } else if (body.remote_jid) {
    const rawJid = String(body.remote_jid).trim();
    const variants = new Set<string>([rawJid]);
    if (!rawJid.includes("@g.us") && !rawJid.includes("@lid")) {
      for (const digits of getBrazilPhoneVariants(rawJid)) {
        if (digits.length >= 10) {
          variants.add(digits);
          variants.add(`${digits}@s.whatsapp.net`);
        }
      }
    }
    query = query.in("remoteJid", Array.from(variants));
  } else {
    return NextResponse.json({ ok: false, error: "Informe remote_jid ou lead_ids" }, { status: 400 });
  }

  const { data, error } = await query.select("id");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, updated: data?.length ?? 0 });
}