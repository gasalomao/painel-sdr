import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const db = supabaseAdmin;
    if (!db) {
      return NextResponse.json({ error: "DB indisponível" }, { status: 500 });
    }

    const { id } = await context.params;
    const leadId = (id || "").trim();
    if (!leadId) {
      return NextResponse.json({ error: "ID do lead é obrigatório" }, { status: 400 });
    }

    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Corpo JSON inválido" }, { status: 400 });
    }

    const rawStatus = (body as Record<string, unknown>).status;
    if (typeof rawStatus !== "string") {
      return NextResponse.json({ error: "Status inválido" }, { status: 400 });
    }
    const status = rawStatus.trim();
    if (!status || status.length > 100 || /[\r\n\t\0]/.test(status)) {
      return NextResponse.json({ error: "Status inválido" }, { status: 400 });
    }

    const { data, error } = await db
      .from("leads_extraidos")
      .update({ status })
      .eq("id", leadId)
      .eq("client_id", auth.clientId)
      .select("id, status")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }

    return NextResponse.json({ success: true, lead: data });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erro ao atualizar status do lead" },
      { status: 500 }
    );
  }
}

