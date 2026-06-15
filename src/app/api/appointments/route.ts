/**
 * /api/appointments
 *
 *   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD&status=...&agent_id=...&lead_id=...
 *        → lista agendamentos do tenant no intervalo.
 *
 *   POST { agent_id?, lead_id?, remote_jid, title, start_at, end_at,
 *          service_name?, description?, calendar_id?, sync_google? }
 *        → cria agendamento (manual). Se sync_google=true e agente tem OAuth,
 *          também cria no Google Calendar e grava google_event_id.
 *
 * Multi-tenant: cliente comum vê/cria apenas no próprio client_id.
 * Admin não-impersonando vê tudo.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { createCalendarEvent, GoogleCalendarError, hasCalendarConnected } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const status = sp.get("status");
  const agentId = sp.get("agent_id");
  const leadId = sp.get("lead_id");
  const remoteJid = sp.get("remote_jid");
  const limit = Math.min(Number(sp.get("limit")) || 100, 500);

  let q = supabaseAdmin
    .from("appointments")
    .select(
      "id, client_id, agent_id, lead_id, remote_jid, instance_name, google_event_id, calendar_id, title, description, service_name, start_at, end_at, status, reminders_sent, created_by, metadata, cancelled_reason, cancelled_at, completed_at, created_at, updated_at"
    )
    .order("start_at", { ascending: true })
    .limit(limit);

  if (!auth.isAdmin) q = q.eq("client_id", auth.clientId);
  if (from) q = q.gte("start_at", new Date(from).toISOString());
  if (to) q = q.lte("start_at", new Date(to).toISOString());
  if (status) q = q.eq("status", status);
  if (agentId) q = q.eq("agent_id", Number(agentId));
  if (leadId) q = q.eq("lead_id", Number(leadId));
  if (remoteJid) q = q.eq("remote_jid", remoteJid);

  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, appointments: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const {
    agent_id,
    lead_id,
    remote_jid,
    instance_name,
    title,
    description,
    service_name,
    start_at,
    end_at,
    calendar_id,
    sync_google,
    created_by,
    metadata,
    // Campos Google Calendar (espelho)
    location,
    attendees,        // array de { email, displayName? } OU string[]
    all_day,
    visibility,
    color_id,
    recurrence,       // string[] RRULE
    create_meet,      // se true, cria Google Meet
  } = body || {};

  if (!remote_jid || !title || !start_at || !end_at) {
    return NextResponse.json(
      { ok: false, error: "remote_jid, title, start_at e end_at são obrigatórios" },
      { status: 400 }
    );
  }

  const start = new Date(start_at);
  const end = new Date(end_at);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return NextResponse.json({ ok: false, error: "Datas inválidas" }, { status: 400 });
  }
  if (end <= start) {
    return NextResponse.json({ ok: false, error: "end_at deve ser depois de start_at" }, { status: 400 });
  }

  // Ownership: se agent_id passado, valida que pertence ao client_id (a menos que admin).
  if (agent_id && !auth.isAdmin) {
    const { data: ag } = await supabaseAdmin
      .from("agent_settings")
      .select("client_id")
      .eq("id", Number(agent_id))
      .maybeSingle();
    if (ag?.client_id && ag.client_id !== auth.clientId) {
      return NextResponse.json({ ok: false, error: "Agente não pertence a este cliente" }, { status: 403 });
    }
  }
  // Idem pra lead_id.
  if (lead_id && !auth.isAdmin) {
    const { data: ld } = await supabaseAdmin
      .from("leads_extraidos")
      .select("client_id")
      .eq("id", Number(lead_id))
      .maybeSingle();
    if (ld?.client_id && ld.client_id !== auth.clientId) {
      return NextResponse.json({ ok: false, error: "Lead não pertence a este cliente" }, { status: 403 });
    }
  }

  let google_event_id: string | null = null;
  let google_error: string | null = null;
  let google_html_link: string | null = null;
  let google_conference_data: any = null;

  // Resolve QUAL agente vai criar o evento no Google. O sistema deve ser
  // espelho do Google: o agendamento manual precisa virar evento no Google
  // sempre que houver um agente conectado. Usa o agente escolhido se ele tem
  // OAuth; senão cai pra QUALQUER agente do tenant com Google conectado.
  let googleAgentId: number | null = agent_id ? Number(agent_id) : null;
  let googleAccountEmail: string | null = null;
  if (sync_google !== false) {
    let chosen = googleAgentId ? await hasCalendarConnected(googleAgentId) : { connected: false } as any;
    if (!chosen.connected) {
      const { data: tenantAgents } = await supabaseAdmin
        .from("agent_settings").select("id").eq("client_id", auth.clientId).order("id");
      for (const a of (tenantAgents || [])) {
        const c = await hasCalendarConnected(a.id);
        if (c.connected) { googleAgentId = a.id; chosen = c; break; }
      }
    }
    googleAccountEmail = chosen.connected ? (chosen.email || null) : null;
    if (!chosen.connected) {
      google_error = "Nenhum agente com Google Calendar conectado — conecte um agente em /agente para o agendamento aparecer no Google.";
      googleAgentId = googleAgentId; // mantém o escolhido pro vínculo local
    }
  }

  // Sync com Google Calendar (best-effort: se falhar, grava só local + warn).
  if (sync_google !== false && googleAgentId && !google_error) {
    try {
      const ev = await createCalendarEvent({
        agentId: googleAgentId,
        calendarId: calendar_id || "primary",
        title,
        description,
        startAt: start,
        endAt: end,
        location,
        attendees,
        allDay: !!all_day,
        visibility,
        colorId: color_id,
        recurrence,
        createMeet: !!create_meet,
      });
      google_event_id = ev.id || null;
      google_html_link = ev.htmlLink || null;
      google_conference_data = (ev as any).conferenceData || null;
    } catch (e) {
      const err = e instanceof GoogleCalendarError ? e : new Error(String(e));
      google_error = err.message;
      console.warn(`[appointments] Google sync falhou (gravando só local):`, err.message);
    }
  }

  // Normaliza attendees pro formato salvo no banco (sempre array de objetos)
  const attendeesJson = (attendees || []).map((a: any) =>
    typeof a === "string" ? { email: a } : { email: a.email, displayName: a.displayName }
  );

  const insertPayload: any = {
    client_id: auth.clientId,
    // Vincula ao agente que de fato sincronizou no Google (se houve fallback),
    // pra que PATCH/cancelar/lembrete usem o mesmo agente conectado.
    agent_id: googleAgentId ?? (agent_id ? Number(agent_id) : null),
    lead_id: lead_id ? Number(lead_id) : null,
    remote_jid: String(remote_jid),
    instance_name: instance_name || null,
    location: location || null,
    attendees: attendeesJson,
    all_day: !!all_day,
    visibility: visibility || "default",
    color_id: color_id || null,
    recurrence: recurrence || null,
    html_link: google_html_link,
    conference_data: google_conference_data,
    google_event_id,
    calendar_id: calendar_id || "primary",
    title: String(title).slice(0, 500),
    description: description || null,
    service_name: service_name || null,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    status: "confirmed",
    created_by: created_by || "manual",
    metadata: metadata || {},
  };

  // Helper: tenta o insert. Se a migration 007 não foi aplicada ainda, retry
  // sem os campos novos do Google Calendar e avisa no warning.
  const insertAppointment = async (payload: Record<string, any>) => {
    const r1 = await supabaseAdmin
      .from("appointments")
      .insert(payload)
      .select()
      .single();
    if (!r1.error) return r1;
    // Erro de schema cache do PostgREST: PGRST204 / coluna não existe.
    const msg = String(r1.error?.message || "");
    const isSchemaMiss =
      r1.error?.code === "PGRST204" ||
      /column .* of 'appointments'/i.test(msg) ||
      /Could not find the .* column/i.test(msg);
    if (!isSchemaMiss) return r1;
    const stripped = { ...payload };
    // Remove TODOS os campos da migration 007 e tenta de novo.
    for (const k of [
      "location", "attendees", "all_day", "visibility", "color_id",
      "recurrence", "html_link", "conference_data", "organizer_email",
    ]) delete stripped[k];
    console.warn(`[appointments POST] Migration 007 não aplicada — gravando sem campos Google: ${msg}`);
    return await supabaseAdmin
      .from("appointments")
      .insert(stripped)
      .select()
      .single();
  };

  const { data, error } = await insertAppointment(insertPayload);

  if (error) {
    // Constraint anti-double-booking: agent_id + start_at conflicting.
    if (error.code === "23505") {
      return NextResponse.json(
        { ok: false, error: "Este horário já está ocupado para esse agente." },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, appointment: data, google_error, google_account: googleAccountEmail });
}
