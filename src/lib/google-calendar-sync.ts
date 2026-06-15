/**
 * Sync Google Calendar → tabela `appointments`.
 *
 * Helper compartilhado entre:
 *   - /api/appointments/sync (chamado pela UI quando usuário abre o /calendario
 *     ou clica em "Atualizar") — escopado a 1 cliente.
 *   - tickGoogleSync() do appointment-worker (cron server-side a cada 3 min)
 *     que varre TODOS agentes scheduler do sistema — espelho real-time
 *     independente de UI aberta.
 *
 * Idempotente:
 *   - Eventos com `google_event_id` já existente em appointments → UPDATE
 *     somente se algo mudou (title/start/end/status).
 *   - Eventos novos → INSERT com created_by='google_sync', remote_jid=
 *     "google:<event_id>" (placeholder — não dispara lembrete WhatsApp).
 *
 * Eventos dia-inteiro (sem dateTime) são ignorados — só interessam os
 * com hora marcada.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";
import { listCalendarEvents, hasCalendarConnected, GoogleCalendarError } from "@/lib/google-calendar";

export type SyncResult = {
  agent_id: number;
  agent_name: string;
  client_id: string;
  pulled: number;
  upserted: number;
  error?: string;
};

export type SyncableAgent = {
  id: number;
  name: string | null;
  client_id: string | null;
  scheduler_config?: { calendar_id?: string } | null;
};

/**
 * Sincroniza um agente específico. Garante que appointments locais reflitam
 * o estado do Google Calendar pra esse agente no intervalo [from, to].
 */
export async function syncGoogleEventsForAgent(
  agent: SyncableAgent,
  from: Date,
  to: Date,
): Promise<{ pulled: number; upserted: number; error?: string }> {
  if (!supabaseAdmin) return { pulled: 0, upserted: 0, error: "DB indisponível" };

  const conn = await hasCalendarConnected(agent.id);
  if (!conn.connected) {
    return { pulled: 0, upserted: 0, error: `Google não conectado (${conn.reason})` };
  }
  const calendarId = agent.scheduler_config?.calendar_id || "primary";

  let events: any[] = [];
  try {
    events = await listCalendarEvents({
      agentId: agent.id,
      calendarId,
      timeMin: from,
      timeMax: to,
      maxResults: 200,
    });
  } catch (e) {
    const err = e instanceof GoogleCalendarError ? e.message : String(e);
    return { pulled: 0, upserted: 0, error: err };
  }

  let upserted = 0;
  for (const ev of events) {
    if (!ev.id) continue;

    // Detecta dia-inteiro (date sem dateTime) vs com hora
    const allDay = !ev.start?.dateTime && !!ev.start?.date;
    const startISO = ev.start?.dateTime
      ? new Date(ev.start.dateTime).toISOString()
      : ev.start?.date
        ? new Date(ev.start.date + "T00:00:00Z").toISOString()
        : null;
    const endISO = ev.end?.dateTime
      ? new Date(ev.end.dateTime).toISOString()
      : ev.end?.date
        ? new Date(ev.end.date + "T00:00:00Z").toISOString()
        : null;
    if (!startISO || !endISO) continue;

    const { data: existing } = await supabaseAdmin
      .from("appointments")
      .select("id, status, title, start_at, end_at, description, location, all_day, visibility, color_id, attendees, html_link, recurrence, organizer_email")
      .eq("google_event_id", ev.id)
      .maybeSingle();

    const evStatus = ev.status === "cancelled" ? "cancelled" : "confirmed";
    const attendees = (ev.attendees || []).map((a: any) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
    }));

    const patch = {
      title: ev.summary || existing?.title || "(sem título)",
      description: ev.description || null,
      location: ev.location || null,
      start_at: startISO,
      end_at: endISO,
      status: evStatus,
      all_day: allDay,
      visibility: (ev as any).visibility || "default",
      color_id: (ev as any).colorId || null,
      attendees,
      html_link: ev.htmlLink || null,
      recurrence: (ev as any).recurrence || null,
      conference_data: (ev as any).conferenceData || null,
      organizer_email: (ev as any).organizer?.email || null,
    };

    // Helper local pra retry sem campos da migration 007 se ela ainda não rodou
    const retryWithoutNewCols = async (op: "update" | "insert", payload: Record<string, any>, existingId?: string) => {
      const stripped = { ...payload };
      for (const k of [
        "location", "attendees", "all_day", "visibility", "color_id",
        "recurrence", "html_link", "conference_data", "organizer_email",
      ]) delete stripped[k];
      if (op === "update" && existingId) {
        return supabaseAdmin!.from("appointments").update(stripped).eq("id", existingId);
      }
      return supabaseAdmin!.from("appointments").insert(stripped);
    };
    const isSchemaMiss = (err: any) =>
      err?.code === "PGRST204" ||
      /column .* of 'appointments'/i.test(String(err?.message || "")) ||
      /Could not find the .* column/i.test(String(err?.message || ""));

    if (existing) {
      const changed =
        existing.title !== patch.title ||
        existing.status !== patch.status ||
        (existing.description || null) !== patch.description ||
        (existing.location || null) !== patch.location ||
        (existing as any).all_day !== patch.all_day ||
        (existing as any).visibility !== patch.visibility ||
        (existing as any).color_id !== patch.color_id ||
        new Date(existing.start_at).getTime() !== new Date(patch.start_at).getTime() ||
        new Date(existing.end_at).getTime() !== new Date(patch.end_at).getTime() ||
        JSON.stringify(existing.attendees || []) !== JSON.stringify(patch.attendees);
      if (changed) {
        const r1 = await supabaseAdmin.from("appointments").update(patch).eq("id", existing.id);
        if (r1.error && isSchemaMiss(r1.error)) {
          await retryWithoutNewCols("update", patch, existing.id);
        }
        upserted++;
      }
    } else {
      const fullPayload = {
        client_id: agent.client_id,
        agent_id: agent.id,
        remote_jid: `google:${ev.id}`,
        google_event_id: ev.id,
        calendar_id: calendarId,
        created_by: "google_sync",
        metadata: {},
        ...patch,
      };
      const r1 = await supabaseAdmin.from("appointments").insert(fullPayload);
      let finalErr = r1.error;
      if (r1.error && isSchemaMiss(r1.error)) {
        const r2 = await retryWithoutNewCols("insert", fullPayload);
        finalErr = r2.error;
      }
      if (finalErr && finalErr.code !== "23505") {
        console.warn(`[google-sync] insert falhou pro agente ${agent.id}:`, finalErr.message);
      } else {
        upserted++;
      }
    }
  }

  return { pulled: events.length, upserted };
}

/**
 * Sync em batch — usado pelo worker server-side. Varre TODOS agentes scheduler
 * do sistema (todos os tenants). Cliente comum NÃO chama isso — só o cron.
 *
 * Janela default: agora → +30 dias (suficiente pra UI ver upcoming).
 */
export async function tickGoogleSyncAll(opts?: {
  windowAheadDays?: number;
  agentLimit?: number;
}): Promise<{ agents: SyncResult[]; totalSynced: number }> {
  if (!supabaseAdmin) return { agents: [], totalSynced: 0 };

  const windowDays = opts?.windowAheadDays ?? 30;
  const from = new Date();
  const to = new Date(Date.now() + windowDays * 24 * 3600 * 1000);

  // Pega todos agentes scheduler ATIVOS. Sem filtro de client_id (worker
  // server-side roda no nível do sistema). Cada agente carrega o próprio
  // client_id pra escrever em appointments.client_id correto.
  let q = supabaseAdmin
    .from("agent_settings")
    .select("id, name, client_id, scheduler_config, is_active")
    .eq("is_scheduler", true)
    .eq("is_active", true);
  if (opts?.agentLimit) q = q.limit(opts.agentLimit);

  const { data: agents } = await q;
  if (!agents || agents.length === 0) return { agents: [], totalSynced: 0 };

  const results: SyncResult[] = [];
  let totalSynced = 0;

  for (const a of agents as any[]) {
    const out = await syncGoogleEventsForAgent(
      {
        id: a.id,
        name: a.name,
        client_id: a.client_id,
        scheduler_config: a.scheduler_config,
      },
      from,
      to,
    );
    results.push({
      agent_id: a.id,
      agent_name: a.name || `agent-${a.id}`,
      client_id: a.client_id,
      pulled: out.pulled,
      upserted: out.upserted,
      error: out.error,
    });
    totalSynced += out.upserted;
  }

  return { agents: results, totalSynced };
}
