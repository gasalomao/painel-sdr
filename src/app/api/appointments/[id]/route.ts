/**
 * /api/appointments/[id]
 *
 *   GET    → detalhe
 *   PATCH  { title?, start_at?, end_at?, status?, service_name?, description?, sync_google? }
 *          → atualiza (reagendamento, conclusão, cancelamento)
 *   DELETE → cancela (status='cancelled') + remove no Google se sincronizado
 *
 * Multi-tenant: cliente comum só mexe nos do próprio client_id.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import {
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  GoogleCalendarError,
} from "@/lib/google-calendar";
import { startChanged, hasAgentOverlapConflict } from "@/lib/agenda-logic";

export const dynamic = "force-dynamic";

async function loadOwned(id: string, clientId: string, isAdmin: boolean) {
  let q = supabaseAdmin!
    .from("appointments")
    .select("*")
    .eq("id", id);
  if (!isAdmin) q = q.eq("client_id", clientId);
  const { data } = await q.maybeSingle();
  return data;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const { id } = await ctx.params;
  const appt = await loadOwned(id, auth.clientId, auth.isAdmin);
  if (!appt) return NextResponse.json({ ok: false, error: "Agendamento não encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true, appointment: appt });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const { id } = await ctx.params;
  const existing = await loadOwned(id, auth.clientId, auth.isAdmin);
  if (!existing) return NextResponse.json({ ok: false, error: "Agendamento não encontrado" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, any> = {};

  if (typeof body.title === "string") patch.title = body.title.slice(0, 500);
  if (typeof body.description === "string") patch.description = body.description;
  if (typeof body.service_name === "string") patch.service_name = body.service_name;
  if (body.start_at) patch.start_at = new Date(body.start_at).toISOString();
  if (body.end_at) patch.end_at = new Date(body.end_at).toISOString();
  if (body.metadata && typeof body.metadata === "object") patch.metadata = body.metadata;

  // Campos Google Calendar (espelho)
  if (typeof body.location === "string" || body.location === null) patch.location = body.location;
  if (typeof body.all_day === "boolean") patch.all_day = body.all_day;
  if (typeof body.visibility === "string") {
    const allowedVis = ["default", "public", "private", "confidential"];
    if (allowedVis.includes(body.visibility)) patch.visibility = body.visibility;
  }
  if (typeof body.color_id === "string" || body.color_id === null) patch.color_id = body.color_id;
  if (Array.isArray(body.attendees)) {
    patch.attendees = body.attendees.map((a: any) =>
      typeof a === "string" ? { email: a } : { email: a.email, displayName: a.displayName }
    );
  }
  if (Array.isArray(body.recurrence)) patch.recurrence = body.recurrence;

  if (body.status && typeof body.status === "string") {
    const allowed = ["confirmed", "tentative", "cancelled", "completed", "no_show"];
    if (!allowed.includes(body.status)) {
      return NextResponse.json({ ok: false, error: "status inválido" }, { status: 400 });
    }
    patch.status = body.status;
    if (body.status === "cancelled") {
      patch.cancelled_at = new Date().toISOString();
      if (body.cancelled_reason) patch.cancelled_reason = body.cancelled_reason;
    } else if (body.status === "completed") {
      patch.completed_at = new Date().toISOString();
    }
  }

  // REMARCAÇÃO: se o horário mudou, zera reminders_sent pra os lembretes
  // dispararem de novo com base no NOVO horário (senão o worker acha que já
  // mandou e fica mudo). Vale pra arrastar no calendário e editar a data.
  if (patch.start_at && startChanged(existing.start_at, patch.start_at)) {
    patch.reminders_sent = [];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nada pra atualizar" }, { status: 400 });
  }

  // DISPONIBILIDADE na remarcação: se o horário mudou e o agendamento segue
  // ativo, garante que o novo intervalo NÃO se sobrepõe a outro agendamento
  // do mesmo agente (outro contato). Checa ANTES de mexer no Google pra não
  // mover lá e rejeitar aqui. O índice único cobre só horário idêntico; aqui
  // pegamos sobreposição parcial.
  const newStatus = patch.status ?? existing.status;
  const isActiveAfter = newStatus === "confirmed" || newStatus === "tentative";
  if ((patch.start_at || patch.end_at) && isActiveAfter && existing.agent_id) {
    const nStart = patch.start_at ?? existing.start_at;
    const nEnd = patch.end_at ?? existing.end_at;
    const { data: busy } = await supabaseAdmin
      .from("appointments")
      .select("id, remote_jid, start_at, end_at")
      .eq("agent_id", existing.agent_id)
      .in("status", ["confirmed", "tentative"])
      .neq("id", id)
      .lt("start_at", new Date(nEnd).toISOString())
      .gt("end_at", new Date(nStart).toISOString())
      .limit(20);
    if (hasAgentOverlapConflict(busy as any, new Date(nStart).getTime(), new Date(nEnd).getTime(), existing.remote_jid)) {
      return NextResponse.json({ ok: false, error: "Esse horário conflita com outro agendamento do mesmo agente." }, { status: 409 });
    }
  }

  // Sync com Google (best-effort) — propaga TODOS os campos atualizados.
  // Captura o erro pra devolver ao front (antes era silencioso).
  let googleError: string | null = null;
  if (existing.agent_id && body.sync_google !== false) {
    try {
      if (patch.status === "cancelled") {
        if (existing.google_event_id) {
          await cancelCalendarEvent(existing.agent_id, existing.google_event_id, existing.calendar_id);
          patch.google_event_id = null;
        }
      } else if (existing.google_event_id) {
        // Já existe no Google → atualiza (mover data, cor, título, etc).
        const hasGoogleField =
          patch.start_at || patch.end_at || patch.title !== undefined ||
          patch.description !== undefined || patch.location !== undefined ||
          patch.all_day !== undefined || patch.visibility !== undefined ||
          patch.color_id !== undefined || patch.attendees !== undefined ||
          patch.recurrence !== undefined;
        if (hasGoogleField) {
          await updateCalendarEvent({
            agentId: existing.agent_id,
            eventId: existing.google_event_id,
            calendarId: existing.calendar_id,
            title: patch.title,
            description: patch.description,
            startAt: patch.start_at,
            endAt: patch.end_at,
            location: patch.location,
            allDay: patch.all_day,
            visibility: patch.visibility,
            colorId: patch.color_id,
            attendees: patch.attendees,
            recurrence: patch.recurrence,
          });
        }
      } else {
        // NÃO existe no Google ainda (criado local-only, ex: agente conectado
        // depois) → cria agora e guarda o google_event_id. Garante "sempre
        // sincronizar": editar um evento órfão o empurra pro Google.
        const ev = await createCalendarEvent({
          agentId: existing.agent_id,
          calendarId: existing.calendar_id || "primary",
          title: patch.title ?? existing.title,
          description: patch.description ?? existing.description,
          startAt: patch.start_at ?? existing.start_at,
          endAt: patch.end_at ?? existing.end_at,
          location: patch.location ?? existing.location,
          allDay: patch.all_day ?? existing.all_day,
          visibility: patch.visibility ?? existing.visibility,
          colorId: patch.color_id ?? existing.color_id,
          attendees: patch.attendees ?? existing.attendees,
          recurrence: patch.recurrence ?? existing.recurrence,
        });
        patch.google_event_id = ev.id || null;
        if ((ev as any).htmlLink) patch.html_link = (ev as any).htmlLink;
      }
    } catch (e) {
      const err = e instanceof GoogleCalendarError ? e : new Error(String(e));
      googleError = err.message;
      console.warn(`[appointments PATCH] Google sync falhou:`, err.message);
    }
  }

  // Helper: tenta o update. Se migration 007 não rodou, retry sem campos novos.
  const updateAppointment = async (payload: Record<string, any>) => {
    const r1 = await supabaseAdmin
      .from("appointments")
      .update(payload)
      .eq("id", id)
      .select()
      .single();
    if (!r1.error) return r1;
    const msg = String(r1.error?.message || "");
    const isSchemaMiss =
      r1.error?.code === "PGRST204" ||
      /column .* of 'appointments'/i.test(msg) ||
      /Could not find the .* column/i.test(msg);
    if (!isSchemaMiss) return r1;
    const stripped = { ...payload };
    for (const k of [
      "location", "attendees", "all_day", "visibility", "color_id",
      "recurrence", "html_link", "conference_data", "organizer_email",
    ]) delete stripped[k];
    console.warn(`[appointments PATCH] Migration 007 não aplicada — atualizando sem campos Google`);
    return await supabaseAdmin
      .from("appointments")
      .update(stripped)
      .eq("id", id)
      .select()
      .single();
  };

  const { data, error } = await updateAppointment(patch);

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ ok: false, error: "Horário conflita com outro agendamento desse agente." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, appointment: data, google_error: googleError });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const { id } = await ctx.params;
  const existing = await loadOwned(id, auth.clientId, auth.isAdmin);
  if (!existing) return NextResponse.json({ ok: false, error: "Agendamento não encontrado" }, { status: 404 });

  // Dois modos:
  //   default          → SOFT delete (status=cancelled, mantém row pra histórico)
  //                      + cancela evento no Google
  //   ?hard=true       → HARD delete (remove row do banco permanentemente)
  //                      Pra agendamentos JÁ cancelados que poluem a lista.
  //                      Se ainda tem google_event_id (raro), cancela no Google também.
  const hard = req.nextUrl.searchParams.get("hard") === "true";

  // SEMPRE tenta cancelar no Google (best-effort). Só pula se já tá null.
  let googleOk = true;
  let googleError: string | null = null;
  if (existing.google_event_id && existing.agent_id) {
    try {
      await cancelCalendarEvent(existing.agent_id, existing.google_event_id, existing.calendar_id);
    } catch (e) {
      googleOk = false;
      googleError = (e as Error).message;
      console.warn(`[appointments DELETE] Google cancel falhou:`, googleError);
    }
  }

  if (hard) {
    // HARD: remove a row de vez. Antes, conferia se status já era cancelled
    // (segurança extra contra apagar appointment confirmado por engano).
    if (existing.status !== "cancelled" && existing.status !== "no_show" && existing.status !== "completed") {
      return NextResponse.json(
        { ok: false, error: "Só agendamentos cancelados/concluídos podem ser apagados permanentemente. Cancele primeiro." },
        { status: 409 }
      );
    }
    const { error } = await supabaseAdmin.from("appointments").delete().eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, mode: "hard_deleted", google: googleOk, google_error: googleError });
  }

  // SOFT delete (default)
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      google_event_id: null,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, mode: "cancelled", appointment: data, google: googleOk, google_error: googleError });
}
