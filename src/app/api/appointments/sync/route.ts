/**
 * /api/appointments/sync  GET ?from=&to=&agent_id=
 *
 * Lista MERGEADA do Google Calendar (tempo real via API do Google) + tabela
 * local appointments. Pra cada agente com OAuth conectado, puxa eventos do
 * calendário primary entre from/to e:
 *   - Se o google_event_id já existe em appointments local → enriquece a row
 *     local com dados frescos do Google (title, start, end, status).
 *   - Se NÃO existe local → cria um "shadow appointment" que aparece no UI
 *     marcado como created_by=google_sync (sincronizado automaticamente).
 *     A próxima call vai encontrar e atualizar — idempotente.
 *
 * Esse endpoint é chamado pela página /calendario sempre que ela carrega ou
 * o usuário aperta "Atualizar". A página em si continua chamando GET
 * /api/appointments pra exibir; este só sincroniza.
 *
 * Multi-tenant: só agentes do client_id do solicitante. Admin não-impersonando
 * sincroniza qualquer agente.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { listCalendarEvents, hasCalendarConnected, GoogleCalendarError } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") ? new Date(sp.get("from")!) : new Date();
  const to = sp.get("to") ? new Date(sp.get("to")!) : new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const agentIdFilter = sp.get("agent_id");

  // 1. Descobre agentes elegíveis pra sync (scheduler + tem credencial)
  let agentsQ = supabaseAdmin
    .from("agent_settings")
    .select("id, client_id, name, options, scheduler_config")
    .eq("is_scheduler", true);
  if (!auth.isAdmin) agentsQ = agentsQ.eq("client_id", auth.clientId);
  if (agentIdFilter) agentsQ = agentsQ.eq("id", Number(agentIdFilter));

  const { data: agents } = await agentsQ;
  if (!agents || agents.length === 0) {
    return NextResponse.json({ ok: true, synced: 0, agents: [], note: "Nenhum agente scheduler com Google conectado pra sincronizar" });
  }

  const results: Array<{ agent_id: number; agent_name: string; pulled: number; upserted: number; error?: string }> = [];
  let totalSynced = 0;

  for (const agent of agents) {
    const conn = await hasCalendarConnected(agent.id);
    if (!conn.connected) {
      results.push({ agent_id: agent.id, agent_name: agent.name, pulled: 0, upserted: 0, error: `Google não conectado (${conn.reason})` });
      continue;
    }
    const calendarId = (agent.scheduler_config as any)?.calendar_id || "primary";

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
      results.push({ agent_id: agent.id, agent_name: agent.name, pulled: 0, upserted: 0, error: err });
      continue;
    }

    let upserted = 0;
    for (const ev of events) {
      // Eventos sem hora marcada (dia inteiro) só têm `date`, não `dateTime` — ignora.
      const startISO = ev.start?.dateTime;
      const endISO = ev.end?.dateTime;
      if (!startISO || !endISO) continue;
      if (!ev.id) continue;

      // Procura row local com esse google_event_id
      const { data: existing } = await supabaseAdmin
        .from("appointments")
        .select("id, status, title, start_at, end_at")
        .eq("google_event_id", ev.id)
        .maybeSingle();

      const evStatus = ev.status === "cancelled" ? "cancelled" : "confirmed";
      const patch = {
        title: ev.summary || existing?.title || "(sem título)",
        description: ev.description || null,
        start_at: new Date(startISO).toISOString(),
        end_at: new Date(endISO).toISOString(),
        status: evStatus,
      };

      if (existing) {
        // Remarcou no Google → o horário mudou. Zera reminders_sent pra os
        // lembretes dispararem de novo no NOVO horário (puxando as variáveis
        // atualizadas do agendamento). Sem isso, mover no Google deixava o
        // lembrete mudo (worker achava que já tinha mandado).
        const timeChanged =
          new Date(existing.start_at).getTime() !== new Date(patch.start_at).getTime() ||
          new Date(existing.end_at).getTime() !== new Date(patch.end_at).getTime();
        const finalPatch: any = timeChanged ? { ...patch, reminders_sent: [] } : patch;
        // Só atualiza se mudou algo (evita escrever updated_at toa)
        if (
          existing.title !== patch.title ||
          existing.status !== patch.status ||
          timeChanged
        ) {
          await supabaseAdmin.from("appointments").update(finalPatch).eq("id", existing.id);
          upserted++;
        }
      } else {
        // Shadow row: evento veio do Google que NÃO criamos. Cria local com
        // created_by=google_sync. remote_jid fica vazio (não vem do Google).
        // Em fase 2: tentar parsear "Maria Silva — 5511..." da descrição/title.
        const attendeeEmail = ev.attendees?.[0]?.email || null;
        await supabaseAdmin.from("appointments").insert({
          client_id: agent.client_id || auth.clientId,
          agent_id: agent.id,
          remote_jid: `google:${ev.id}`, // placeholder — não dispara lembrete WhatsApp
          google_event_id: ev.id,
          calendar_id: calendarId,
          title: patch.title,
          description: patch.description,
          start_at: patch.start_at,
          end_at: patch.end_at,
          status: patch.status,
          created_by: "google_sync",
          metadata: attendeeEmail ? { attendee_email: attendeeEmail } : {},
        }).then(({ error }) => {
          if (error && error.code !== "23505") {
            console.warn(`[appointments/sync] insert google_sync falhou:`, error.message);
          }
        });
        upserted++;
      }
    }

    totalSynced += upserted;
    results.push({ agent_id: agent.id, agent_name: agent.name, pulled: events.length, upserted });
  }

  return NextResponse.json({ ok: true, synced: totalSynced, agents: results, from: from.toISOString(), to: to.toISOString() });
}
