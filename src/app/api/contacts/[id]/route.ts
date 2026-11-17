import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/contacts/[id]
 * Atualiza anotações e/ou tags de um contato estritamente pertencente ao tenant.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
  }

  const { id } = await context.params;
  const contactId = String(id || "").trim();
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "id do contato obrigatório" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    notes?: unknown;
    tags?: unknown;
  };

  const patch: Record<string, unknown> = {};
  if (typeof body.notes === "string") {
    patch.notes = body.notes;
  }
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nenhum campo válido para atualizar" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .update(patch)
    .eq("id", contactId)
    .eq("client_id", auth.clientId)
    .select("id, notes, tags")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "Contato não encontrado" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, contact: data });
}

