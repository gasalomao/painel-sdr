import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { supabase } from "@/lib/supabase";

const db = () => supabaseAdmin || supabase;

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");
  const period = req.nextUrl.searchParams.get("period") || "week";
  
  const now = new Date();
  let since = new Date(now);
  if (period === "today") since.setHours(0, 0, 0, 0);
  else if (period === "week") since.setDate(since.getDate() - 7);
  else if (period === "month") since.setMonth(since.getMonth() - 1);
  const sinceISO = since.toISOString();

  if (type === "stats") {
    const [{ data: objecoes }, { data: dores }, { data: oportunidades }, { data: dados }] = await Promise.all([
      db().from("sales_insights").select("content").eq("insight_type", "objecao").gte("created_at", sinceISO),
      db().from("sales_insights").select("content").eq("insight_type", "dor").gte("created_at", sinceISO),
      db().from("sales_insights").select("content").eq("insight_type", "oportunidade").gte("created_at", sinceISO),
      db().from("sales_insights").select("content").eq("insight_type", "dado_extraido").gte("created_at", sinceISO),
    ]);
    return NextResponse.json({
      objecoes: objecoes?.length || 0,
      dores: dores?.length || 0,
      oportunidades: oportunidades?.length || 0,
      dados_extraidos: dados?.length || 0,
    });
  }

  let query = db()
    .from("sales_insights")
    .select("*")
    .gte("created_at", sinceISO)
    .order("created_at", { ascending: false })
    .limit(100);

  if (type && type !== "all") query = query.eq("insight_type", type);
  
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ insights: data || [] });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action } = body;

  if (action === "delete") {
    const { error } = await db().from("sales_insights").delete().eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Create insight manually
  const { data, error } = await db().from("sales_insights").insert({
    remote_jid: body.remote_jid,
    nome_negocio: body.nome_negocio,
    insight_type: body.insight_type,
    content: body.content,
    confidence: body.confidence || 0.8,
    extracted_from: body.extracted_from || "manual",
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ insight: data });
}
