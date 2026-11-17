import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { formatChatMessageLine, hashChatContent } from "@/lib/organizer-hash";

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

    const { data: existing, error: findErr } = await db
      .from("leads_extraidos")
      .select('id, status, "remoteJid", nome_negocio')
      .eq("id", leadId)
      .eq("client_id", auth.clientId)
      .maybeSingle();

    if (findErr) {
      return NextResponse.json({ error: findErr.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }

    const remoteJid = (existing as { remoteJid?: string | null }).remoteJid;
    const oldStatus = (existing as { status?: string | null }).status || "novo";
    const nomeNegocio = (existing as { nome_negocio?: string | null }).nome_negocio || null;

    const nowIso = new Date().toISOString();
    const { data, error } = await db
      .from("leads_extraidos")
      .update({
        status,
        updated_at: nowIso,
        last_analysis_at: nowIso,
      })
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

    // Trava manual (0 tokens): sincroniza hash + histórico [MANUAL] para a IA não desfazer o arraste humano sem nova mensagem do cliente
    if (remoteJid && oldStatus !== status) {
      try {
        const { data: recentMsgs } = await db
          .from("chats_dashboard")
          .select("sender_type, is_from_me, content, media_type, file_name, created_at")
          .eq("remote_jid", remoteJid)
          .eq("client_id", auth.clientId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true });

        const formattedLines = ((recentMsgs || []) as Array<Record<string, unknown>>)
          .map((m) => formatChatMessageLine(m as Parameters<typeof formatChatMessageLine>[0])?.line)
          .filter((l): l is string => Boolean(l));

        const manualHash = hashChatContent(formattedLines.slice(-15), status);
        await db
          .from("leads_extraidos")
          .update({ last_analysis_hash: manualHash })
          .eq("id", leadId)
          .eq("client_id", auth.clientId);

        await db.from("historico_ia_leads").insert({
          client_id: auth.clientId,
          remote_jid: remoteJid,
          nome_negocio: nomeNegocio,
          status_antigo: oldStatus,
          status_novo: status,
          razao: `[MANUAL] Movido manualmente pelo operador no Kanban (${oldStatus} -> ${status}).`,
          resumo: null,
          batch_id: `manual-${Date.now()}`,
        });
      } catch {
        // Melhor esforço: não bloqueia movimentação manual no Kanban
      }
    }

    return NextResponse.json({
      success: true,
      lead: {
        id: (data as { id: string | number }).id,
        status: (data as { status: string }).status,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erro ao atualizar status do lead" },
      { status: 500 }
    );
  }
}

