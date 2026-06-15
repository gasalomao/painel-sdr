/**
 * /api/calendario/send-followup  POST
 *
 * Manda follow-up WhatsApp adhoc relacionado a um agendamento.
 *
 * Body:
 *   - appointment_id (obrigatório) — o agendamento que disparou o follow-up
 *   - message        (obrigatório) — texto com variáveis {nome}, {hora_agendamento}, etc
 *   - instance_name? — se informado, usa essa; senão, usa a do appointment
 *
 * Renderiza variáveis usando dados do lead vinculado + appointment, depois
 * envia via channel.sendMessage. Idempotente do ponto de vista de log
 * (não duplica histórico mesmo se chamado 2x rapidamente — ms diff).
 *
 * Multi-tenant: appointment precisa pertencer ao client_id do solicitante
 * (ou admin não-impersonando).
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import * as channel from "@/lib/channel";
import { renderTemplate } from "@/lib/template-vars";
import { findOrCreateContactSession, persistOutgoingMessage } from "@/lib/campaign-worker";
import { registerPendingAutomatedSend } from "@/lib/manual-send-registry";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const { appointment_id, message, instance_name } = body || {};
  if (!appointment_id || !message) {
    return NextResponse.json({ ok: false, error: "appointment_id e message obrigatórios" }, { status: 400 });
  }

  // 1. Carrega appointment + valida ownership
  let q = supabaseAdmin
    .from("appointments")
    .select("id, client_id, agent_id, lead_id, remote_jid, instance_name, title, service_name, start_at, end_at, status, location, conference_data, html_link")
    .eq("id", appointment_id);
  if (!auth.isAdmin) q = q.eq("client_id", auth.clientId);
  const { data: appt } = await q.maybeSingle();
  if (!appt) return NextResponse.json({ ok: false, error: "Agendamento não encontrado" }, { status: 404 });
  if (appt.remote_jid?.startsWith("google:")) {
    return NextResponse.json({ ok: false, error: "Esse agendamento veio do Google sem lead vinculado — não dá pra mandar follow-up" }, { status: 400 });
  }

  // 2. Carrega lead pra contexto de variáveis (inclui email/observacoes se a
  //    migration 008 já estiver aplicada; senão a query simplesmente devolve
  //    null nesses campos).
  let leadCtx: any = {};
  if (appt.lead_id) {
    const { data: lead } = await supabaseAdmin
      .from("leads_extraidos")
      .select("nome_negocio, ramo_negocio, endereco, website, telefone, avaliacao, reviews, status, email, observacoes, instagram, facebook, \"remoteJid\"")
      .eq("id", appt.lead_id)
      .maybeSingle();
    if (lead) leadCtx = lead;
  }
  // Fallback pra contacts.push_name
  if (!leadCtx.nome_negocio) {
    const { data: ct } = await supabaseAdmin
      .from("contacts")
      .select("push_name")
      .eq("remote_jid", appt.remote_jid)
      .maybeSingle();
    if (ct?.push_name) leadCtx.push_name = ct.push_name;
  }

  // 3. Resolve a instância pra envio
  const targetInstance = instance_name || appt.instance_name;
  if (!targetInstance) {
    return NextResponse.json({ ok: false, error: "Sem instância configurada — passe instance_name no body" }, { status: 400 });
  }
  // Ownership da instância
  if (!auth.isAdmin) {
    const { data: chConn } = await supabaseAdmin
      .from("channel_connections")
      .select("client_id")
      .eq("instance_name", targetInstance)
      .maybeSingle();
    if (chConn?.client_id && chConn.client_id !== auth.clientId) {
      return NextResponse.json({ ok: false, error: "Instância não pertence a este cliente" }, { status: 403 });
    }
  }

  // 4. Variáveis específicas do agendamento (além das padrão do lead)
  const tz = "America/Sao_Paulo";
  const meetLink = (appt as any).conference_data?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri
    || (appt as any).conference_data?.hangoutLink
    || "";
  const apptVars: Record<string, any> = {
    hora_agendamento: new Date(appt.start_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: tz }),
    data_agendamento: new Date(appt.start_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz }),
    servico: appt.service_name || appt.title || "seu atendimento",
    titulo: appt.title,
    meet_link: meetLink,
    local: (appt as any).location || "",
    google_link: (appt as any).html_link || "",
  };

  // 5. Renderiza template + manda
  const rendered = renderTemplate(message, {
    remoteJid: appt.remote_jid,
    nome_negocio: leadCtx.nome_negocio,
    ramo_negocio: leadCtx.ramo_negocio,
    push_name: leadCtx.push_name,
    telefone: leadCtx.telefone,
    email: leadCtx.email,
    endereco: leadCtx.endereco,
    website: leadCtx.website,
    avaliacao: leadCtx.avaliacao,
    reviews: leadCtx.reviews,
    status: leadCtx.status,
    observacoes: leadCtx.observacoes,
    instagram: leadCtx.instagram,
    facebook: leadCtx.facebook,
    variables: apptVars, // {hora_agendamento}, {meet_link}, etc.
  });

  try {
    // Registra o envio pendente antes de disparar o sendMessage para evitar race conditions com o webhook echo
    registerPendingAutomatedSend(targetInstance, appt.remote_jid, rendered);

    const result = await channel.sendMessage(appt.remote_jid, rendered, targetInstance);

    // Persiste no histórico (sessions/messages/chats_dashboard) pra que o
    // follow-up apareça no /chat e a IA tenha o contexto. Best-effort: a
    // mensagem já saiu no WhatsApp, então falha aqui não invalida o envio.
    try {
      const msgId =
        (result as any)?.key?.id ||
        (result as any)?.data?.key?.id ||
        `appt-followup-${appt.id}-${Date.now()}`;
      const sess = await findOrCreateContactSession(
        appt.remote_jid,
        targetInstance,
        leadCtx.nome_negocio || leadCtx.push_name || null,
      );
      await persistOutgoingMessage({
        sessionId: sess?.sessionId || null,
        remoteJid: appt.remote_jid,
        instanceName: targetInstance,
        msgId,
        text: rendered,
      });
    } catch (persistErr: any) {
      console.warn("[send-followup] enviado mas falhou ao salvar no histórico:", persistErr?.message);
    }

    return NextResponse.json({
      ok: true,
      rendered,
      result,
      sent_to: appt.remote_jid,
      via: targetInstance,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
