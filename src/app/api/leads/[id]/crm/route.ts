import { NextRequest, NextResponse } from "next/server";
import { parseISO } from "date-fns/parseISO";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { getPhotoJid } from "@/lib/whatsapp-photo-utils";
import { readPhotoCache } from "@/lib/whatsapp-photos";

export const dynamic = "force-dynamic";

/**
 * GET /api/leads/[id]/crm
 * Retorna dados detalhados do lead para a Ficha / CRM
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "ID do lead é obrigatório" }, { status: 400 });
    }

    const { data: lead, error } = await supabaseAdmin
      .from("leads_extraidos")
      .select("*")
      .eq("id", id)
      .eq("client_id", auth.clientId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!lead) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }

    // Abrir a ficha só lê cache; chamadas ao WhatsApp exigem ação explícita.
    let profilePicUrl: string | null = null;
    const jid = getPhotoJid(lead.remoteJid) ?? getPhotoJid(lead.telefone);
    if (jid) profilePicUrl = (await readPhotoCache(auth.clientId, [jid])).get(jid)?.url ?? null;

    const lembreteTexto = lead.next_follow_up
      ? (lead.business_details?.lembrete_texto ?? lead.observacoes ?? "")
      : "";

    return NextResponse.json({
      lead: {
        ...lead,
        lembrete_texto: lembreteTexto,
      },
      profilePicUrl,
      lembrete_texto: lembreteTexto,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erro interno" }, { status: 500 });
  }
}

/**
 * PATCH /api/leads/[id]/crm
 * Atualiza observações (anotações) ou data de retorno (lembrete) do lead de forma segura
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "ID do lead é obrigatório" }, { status: 400 });
    }

    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Corpo JSON inválido" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (!["observacoes", "next_follow_up", "lembrete_texto"].some((key) => key in input)) {
      return NextResponse.json({ error: "Nenhum campo válido informado" }, { status: 400 });
    }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    for (const [key, maxLength] of [["observacoes", 20000], ["lembrete_texto", 1000]] as const) {
      const value = input[key];
      if (value !== undefined && value !== null && (typeof value !== "string" || value.length > maxLength)) {
        return NextResponse.json({ error: `Campo ${key} inválido (máximo ${maxLength} caracteres)` }, { status: 400 });
      }
    }
    if ("observacoes" in input) {
      patch.observacoes = typeof input.observacoes === "string" ? input.observacoes.trim() : null;
    }
    if ("next_follow_up" in input) {
      const value = input.next_follow_up;
      if (value === null) {
        patch.next_follow_up = null;
      } else if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || !Number.isFinite(parseISO(value).getTime())) {
        return NextResponse.json({ error: "Formato de data inválido para next_follow_up" }, { status: 400 });
      } else {
        patch.next_follow_up = new Date(value).toISOString();
      }
    }

    if ("lembrete_texto" in input || ("next_follow_up" in input && input.next_follow_up !== null)) {
      const cleanLembrete = typeof input.lembrete_texto === "string" ? input.lembrete_texto.trim() : null;
      if ("lembrete_texto" in input && input.next_follow_up !== null && !cleanLembrete) {
        return NextResponse.json({ error: "Descreva o lembrete" }, { status: 400 });
      }
      const { data: currentLead, error: readError } = await supabaseAdmin
        .from("leads_extraidos")
        .select("business_details, observacoes, next_follow_up")
        .eq("id", id)
        .eq("client_id", auth.clientId)
        .maybeSingle();
      if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
      if (!currentLead) return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
      const currentBd = currentLead.business_details;
      const effectiveDue = "next_follow_up" in input ? patch.next_follow_up : currentLead.next_follow_up;
      const effectiveNotes = "observacoes" in input ? patch.observacoes : currentLead.observacoes;
      // Observações só descrevem lembretes legados que já possuem vencimento.
      const effectiveText = "lembrete_texto" in input
        ? cleanLembrete
        : (currentBd?.lembrete_texto ?? (currentLead.next_follow_up ? effectiveNotes : null));
      if (input.next_follow_up !== null && (!effectiveDue || typeof effectiveText !== "string" || !effectiveText.trim())) {
        return NextResponse.json({ error: "Descreva o lembrete e selecione o vencimento" }, { status: 400 });
      }
      if ("lembrete_texto" in input) {
        patch.business_details = {
          ...(currentBd && typeof currentBd === "object" && !Array.isArray(currentBd) ? currentBd : {}),
          lembrete_texto: cleanLembrete,
        };
      }
    }

    const { data: updated, error } = await supabaseAdmin
      .from("leads_extraidos")
      .update(patch)
      .eq("id", id)
      .eq("client_id", auth.clientId)
      .select("id, client_id, observacoes, next_follow_up, business_details, updated_at")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json({ error: "Lead não encontrado ou não autorizado" }, { status: 404 });
    }

    const lembreteTexto = updated.next_follow_up
      ? (updated.business_details?.lembrete_texto ?? updated.observacoes ?? null)
      : null;

    return NextResponse.json({
      success: true,
      lead: {
        ...updated,
        lembrete_texto: lembreteTexto,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erro interno" }, { status: 500 });
  }
}
