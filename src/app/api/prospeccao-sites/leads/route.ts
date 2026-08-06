import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/prospeccao-sites/leads
 * Leads capturados pelo Maps SEM website — candidatos a prospecção.
 * Query params:
 *   limit   (default 50, max 200)
 *   offset  (default 0)
 *   sort    (created_at | rating | reviews) default created_at
 *   order   (asc | desc) default desc
 *   ramo    (substring filter ramo_negocio)
 *   region  (substring filter endereco)
 *   ratingMin  (float — filtra avaliacao >= N)
 *   reviewsMin (int — filtra reviews >= N)
 *   hasWebsite (only_empty | all | only_with — default only_empty)
 *   ignore_opt_out (default true — quando false, mostra até opt_out)
 */
export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const url = req.nextUrl;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);
  const sort = url.searchParams.get("sort") || "created_at";
  const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
  const ramo = (url.searchParams.get("ramo") || "").trim();
  const region = (url.searchParams.get("region") || "").trim();
  const ratingMin = parseFloat(url.searchParams.get("ratingMin") || "0") || 0;
  const reviewsMin = parseInt(url.searchParams.get("reviewsMin") || "0", 10) || 0;
  const hasWebsite = url.searchParams.get("hasWebsite") || "only_empty";
  const ignoreOptOut = url.searchParams.get("ignore_opt_out") !== "false";

  // Coluna real em leads_extraidos é `avaliacao` (numeric), não `rating`.
  // Scraper salva em avaliacao. Frontend pede sort=rating → mapear pra avaliacao.
  const sortCol =
    sort === "rating" ? "avaliacao" :
    sort === "reviews" ? "reviews" :
    "created_at";

  let q = supabaseAdmin
    .from("leads_extraidos")
    .select("id, remoteJid, nome_negocio, telefone, ramo_negocio, endereco, avaliacao, reviews, website, created_at, opt_out", { count: "exact" })
    .eq("client_id", ctx.clientId) as any;

  if (hasWebsite === "only_empty") q = q.or("website.is.null,website.eq.");
  else if (hasWebsite === "only_with") q = q.not("website", "is", null).neq("website", "");

  if (ignoreOptOut) q = q.eq("opt_out", false);
  if (ratingMin > 0) q = q.gte("avaliacao", ratingMin);
  if (reviewsMin > 0) q = q.gte("reviews", reviewsMin);
  if (ramo) q = q.ilike("ramo_negocio", `%${ramo}%`);
  if (region) q = q.ilike("endereco", `%${region}%`);

  q = q.order(sortCol, { ascending: order === "asc" }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Normaliza campo `rating` no payload (front espera `rating` + `reviews`)
  const leads = (data || []).map((l: any) => ({
    ...l,
    rating: l.avaliacao != null ? String(l.avaliacao) : null,
  }));

  return NextResponse.json({
    ok: true,
    leads,
    total: count ?? 0,
    limit,
    offset,
  });
}

/**
 * DELETE /api/prospeccao-sites/leads
 * Body: { ids: number[] }  (IDs em leads_extraidos)
 * Deleta leads do tenant atual. Não afeta outros tenants.
 */
export async function DELETE(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  let ids: number[] = [];
  try {
    const b = await req.json();
    ids = Array.isArray(b?.ids) ? b.ids.filter((n: any) => typeof n === "number" && Number.isFinite(n)) : [];
  } catch { /* ignore parse */ }
  if (!ids.length) return NextResponse.json({ ok: false, error: "ids[] obrigatório" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("leads_extraidos")
    .delete()
    .in("id", ids)
    .eq("client_id", ctx.clientId);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, deleted: ids.length });
}