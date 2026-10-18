import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { TaskInputError, taskErrorResponse } from "@/lib/dashboard-tasks";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const raw = req.nextUrl.searchParams.get("q") ?? "";
    if (raw.length > 100) throw new TaskInputError("Busca muito longa (máximo 100 caracteres)");
    const query = raw.trim();
    if (!query) return NextResponse.json({ leads: [] });
    // Regex literal evita também o alias '*' de curingas do ILIKE no PostgREST.
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const { data, error } = await supabaseAdmin.from("leads_extraidos").select("id,nome_negocio")
      .eq("client_id", auth.clientId).regexIMatch("nome_negocio", escaped)
      .order("nome_negocio", { ascending: true }).order("id", { ascending: true }).limit(20);
    if (error) throw error;
    return NextResponse.json({ leads: (data ?? []).map((lead) => ({ id: lead.id, nome_negocio: lead.nome_negocio })) });
  } catch (error: unknown) {
    return taskErrorResponse(error);
  }
}
