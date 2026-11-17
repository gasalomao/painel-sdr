import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/leads/lookup?phone=...
 * GET /api/leads/lookup?mode=disparo | followup_available | followup_picker
 * BFF multi-tenant para lookup rápido e listagens seletoras sem consultar `leads_extraidos` direto no browser.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const mode = req.nextUrl.searchParams.get("mode");

  if (mode === "disparo") {
    const { data, error } = await supabaseAdmin
      .from("leads_extraidos")
      .select("id, remoteJid, nome_negocio, ramo_negocio, status, instance_name")
      .eq("client_id", auth.clientId)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) {
      console.error("[leads/lookup/disparo] Erro:", error.message);
      return NextResponse.json({ ok: false, error: "Falha ao consultar leads" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, leads: data || [] });
  }

  if (mode === "followup_available") {
    const { data, error } = await supabaseAdmin
      .from("leads_extraidos")
      .select("id, remoteJid, nome_negocio, ramo_negocio, status")
      .eq("client_id", auth.clientId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      console.error("[leads/lookup/followup_available] Erro:", error.message);
      return NextResponse.json({ ok: false, error: "Falha ao consultar leads" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, leads: data || [] });
  }

  if (mode === "followup_picker") {
    const [followupRes, otherRes] = await Promise.all([
      supabaseAdmin
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio, status, created_at")
        .eq("client_id", auth.clientId)
        .eq("status", "follow-up")
        .order("created_at", { ascending: false })
        .limit(1000),
      supabaseAdmin
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio, status, created_at")
        .eq("client_id", auth.clientId)
        .neq("status", "follow-up")
        .not("status", "in", "(fechado,sem_interesse,descartado)")
        .order("created_at", { ascending: false })
        .limit(500),
    ]);
    if (followupRes.error || otherRes.error) {
      console.error("[leads/lookup/followup_picker] Erro:", followupRes.error?.message || otherRes.error?.message);
      return NextResponse.json({ ok: false, error: "Falha ao consultar leads" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, leads: [...(followupRes.data || []), ...(otherRes.data || [])] });
  }

  const phoneClean = String(req.nextUrl.searchParams.get("phone") || "").replace(/\D/g, "");
  if (phoneClean.length < 8) {
    return NextResponse.json({ ok: true, lead: null });
  }

  const last8 = phoneClean.slice(-8);
  const maskedLast8 = `${last8.slice(0, 4)}%${last8.slice(4)}`;

  const { data: candidates, error } = await supabaseAdmin
    .from("leads_extraidos")
    .select("maps_url, lat, lng, endereco, telefone, remoteJid, nome_negocio")
    .eq("client_id", auth.clientId)
    .or(`remoteJid.ilike.%${last8}%,telefone.ilike.%${last8}%,telefone.ilike.%${maskedLast8}%`)
    .limit(25);

  if (error) {
    console.error("[leads/lookup/phone] Erro:", error.message);
    return NextResponse.json({ ok: false, error: "Falha ao consultar lead" }, { status: 500 });
  }

  const lead =
    (candidates || []).find((item) => {
      const leadPhone = item.telefone ? String(item.telefone).replace(/\D/g, "") : "";
      const leadJid = item.remoteJid ? String(item.remoteJid).replace(/\D/g, "") : "";
      return leadPhone.includes(last8) || leadJid.includes(last8);
    }) || null;

  return NextResponse.json({ ok: true, lead });
}
