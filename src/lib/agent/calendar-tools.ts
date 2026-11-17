import { google } from "googleapis";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { getOAuthClientForAgentOptions } from "@/lib/google-calendar";
import {
  calculateFreeSlots,
  hasAgentOverlapConflict,
  isDuplicateSlot,
  parseAgendaDateTime,
  resolveDayScheduleForDate,
} from "@/lib/agenda-logic";
import { promoteLeadBySystemSignal } from "@/lib/organizer-realtime";
import { maskJid } from "@/lib/pii";
import type { CallLogEntry } from "./rag-tool";

export interface CalendarToolContext {
  callArgs: Record<string, unknown>;
  agentConfig: {
    id?: number;
    name?: string | null;
    schedules?: unknown;
    is_24h?: boolean | null;
    options?: Record<string, unknown>;
    scheduler_config?: Record<string, unknown>;
  };
  clientId: string;
  remoteJid: string;
  instanceName: string;
  sessionId: string | null;
  isTestMode: boolean;
  calendarDuration: number;
  calendarAutoCapture: {
    empresa?: boolean;
    necessidade?: boolean;
    telefone?: boolean;
  };
  necessidadeLabel: string;
  leadRow: Record<string, unknown> | null;
  callLogs: CallLogEntry[];
  onMeetingScheduled?: () => void;
}

function parseOAuthTokens(raw: unknown): { refresh_token?: string } | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as { refresh_token?: string };
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? (raw as { refresh_token?: string }) : null;
}

function normalizeDigits(v: string | null | undefined): string {
  return (v || "").replace(/\D/g, "");
}

export async function executeScheduleGoogleCalendar(ctx: CalendarToolContext): Promise<Record<string, unknown>> {
  const {
    callArgs,
    agentConfig,
    clientId,
    remoteJid,
    instanceName,
    sessionId,
    isTestMode,
    calendarDuration,
    calendarAutoCapture,
    necessidadeLabel,
    leadRow,
    callLogs,
    onMeetingScheduled,
  } = ctx;

  if (isTestMode) {
    callLogs.push({ role: "system", content: "[TESTE] schedule_google_calendar suprimido" });
    return {
      simulated: true,
      scheduled: false,
      message: "Modo teste: agendamento real suprimido. Confirme que deseja marcar.",
    };
  }

  console.log("[MCP] Iniciando Agendamento no Google Calendar ->", callArgs);
  let functionResultRes: Record<string, unknown> = {
    scheduled: false,
    message: "Erro ao agendar no sistema.",
  };

  try {
    const oauthTokens = parseOAuthTokens(agentConfig.options?.google_tokens);
    if (!oauthTokens?.refresh_token) {
      throw new Error("Agente não está conectado ao Google via OAuth. Conecte sua conta do Google Calendar primeiro.");
    }

    const auth = await getOAuthClientForAgentOptions(agentConfig.id as number, agentConfig.options || {});
    const calendar = google.calendar({ version: "v3", auth });

    const rawStart = String(callArgs.start_datetime || "").trim();
    const startDt = parseAgendaDateTime(rawStart);
    if (isNaN(startDt.getTime())) {
      throw new Error(`Data/hora inválida recebida da IA: "${rawStart}"`);
    }
    const duration = Number(callArgs.duration_minutes) || calendarDuration;
    const endDt = new Date(startDt.getTime() + duration * 60000);

    const { data: dupRows } = await supabase
      .from("appointments")
      .select("id, title, start_at, created_at")
      .eq("client_id", clientId)
      .eq("remote_jid", remoteJid)
      .eq("status", "confirmed")
      .order("created_at", { ascending: false })
      .limit(10);

    const dup = isDuplicateSlot(dupRows as Array<{ start_at: string }>, startDt.getTime())
      ? (dupRows || []).find((r: { start_at: string }) => Math.abs(new Date(r.start_at).getTime() - startDt.getTime()) <= 2 * 60_000)
      : null;

    let slotConflict = false;
    if (agentConfig.id) {
      const { data: slotRows } = await supabase
        .from("appointments")
        .select("id, remote_jid, start_at, end_at")
        .eq("agent_id", agentConfig.id)
        .in("status", ["confirmed", "tentative"])
        .lt("start_at", endDt.toISOString())
        .gt("end_at", startDt.toISOString())
        .limit(20);
      slotConflict = hasAgentOverlapConflict(
        slotRows as Array<{ remote_jid?: string; start_at: string; end_at: string }>,
        startDt.getTime(),
        endDt.getTime(),
        remoteJid,
      );
    }

    const calLeadRow = (leadRow ??
      (
        await supabase
          .from("leads_extraidos")
          .select("id, nome_negocio, ramo_negocio, website, email")
          .eq("client_id", clientId)
          .eq("remoteJid", remoteJid)
          .maybeSingle()
      ).data) as Record<string, unknown> | null;

    const phoneFromJid = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
    const clientName = (callArgs.nome as string) || (calLeadRow?.nome_negocio as string) || phoneFromJid;
    const companyName = (callArgs.empresa as string) || (calLeadRow?.nome_negocio as string) || null;
    const attendeeEmail = String(callArgs.email || calLeadRow?.email || "").trim();

    const descLines = [
      `📅 AGENDAMENTO SDR — ${agentConfig.name || "Assistente IA"}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `👤 Convidado: ${callArgs.nome || clientName || "Não informado"}`,
    ];
    if (calendarAutoCapture.telefone) descLines.push(`📱 WhatsApp: ${phoneFromJid}`);
    if (attendeeEmail) descLines.push(`✉️ E-mail: ${attendeeEmail}`);
    if (companyName) {
      descLines.push(`🏢 Empresa: ${companyName}${calLeadRow?.ramo_negocio ? ` (${String(calLeadRow.ramo_negocio)})` : ""}`);
    }
    if (calendarAutoCapture.necessidade && (callArgs.necessidade || callArgs.summary)) {
      descLines.push(`🎯 ${necessidadeLabel}: ${String(callArgs.necessidade || callArgs.summary)}`);
    }
    if (calLeadRow?.website) descLines.push(`🌐 Website: ${String(calLeadRow.website)}`);

    if (dup) {
      console.log(`[Agent/Schedule] Duplicado evitado (appt ${dup.id}) — NÃO recria.`);
      functionResultRes = {
        scheduled: true,
        already_scheduled: true,
        message: `O cliente JÁ TEM um agendamento confirmado ("${dup.title}"). NÃO crie outro nem chame esta ferramenta de novo — apenas confirme com o cliente que está tudo certo, de forma natural.`,
      };
      callLogs.push({ role: "system", content: `[Google Calendar] Duplicado evitado (appt ${dup.id})` });
    } else if (slotConflict) {
      console.log(`[Agent/Schedule] Slot ${startDt.toISOString()} já ocupado por outro contato — oferecer outro horário.`);
      functionResultRes = {
        scheduled: false,
        slot_taken: true,
        message: "Esse horário acabou de ser ocupado por outro cliente. Chame check_google_calendar_availability e ofereça um horário livre DIFERENTE — não insista nesse mesmo horário.",
      };
      callLogs.push({ role: "system", content: `[Google Calendar] Slot ocupado por outro contato (${startDt.toISOString()})` });
    } else {
      let raceConflict = false;
      const baseSummary = (callArgs.summary as string) || "Reunião";
      const eventSummary =
        companyName && callArgs.nome ? `${baseSummary} — ${callArgs.nome} (${companyName})` : `${baseSummary} — ${clientName}`;

      const eventBody: Record<string, unknown> = {
        summary: eventSummary,
        start: { dateTime: startDt.toISOString(), timeZone: "America/Sao_Paulo" },
        end: { dateTime: endDt.toISOString(), timeZone: "America/Sao_Paulo" },
        description: descLines.join("\n"),
      };

      if (attendeeEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendeeEmail)) {
        eventBody.attendees = [{
          email: attendeeEmail,
          displayName: (callArgs.nome as string) || clientName || undefined,
        }];
      }

      const shouldGenerateMeet = Boolean(agentConfig.options?.calendar_generate_meet);
      if (shouldGenerateMeet) {
        eventBody.conferenceData = {
          createRequest: {
            requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        };
      }

      const instRes = await calendar.events.insert({
        calendarId: "primary",
        conferenceDataVersion: shouldGenerateMeet ? 1 : 0,
        sendUpdates: Array.isArray(eventBody.attendees) && eventBody.attendees.length > 0 ? "all" : "none",
        requestBody: eventBody,
      });

      const evId = instRes.data.id || null;
      const meetUri =
        instRes.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
        instRes.data.hangoutLink ||
        null;
      const meetLinkStr = meetUri ? ` Link do Google Meet: ${meetUri}` : "";

      try {
        const sched = (agentConfig.scheduler_config || {}) as Record<string, unknown>;
        if (sched.notify_owner && sched.owner_phone && !sched.owner_summary_enabled) {
          const ownerJid = `${String(sched.owner_phone).replace(/\D/g, "")}@s.whatsapp.net`;
          const startBR = startDt.toLocaleString("pt-BR", {
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "America/Sao_Paulo",
          });
          const ownerMsg = [
            "📅 *Novo Agendamento Confirmado via IA!*",
            "━━━━━━━━━━━━━━━━━━━━━━━━━",
            `👤 *Cliente:* ${String(callArgs.nome || clientName || "Não informado")}`,
            `📱 *WhatsApp:* ${phoneFromJid}`,
            attendeeEmail ? `✉️ *E-mail:* ${attendeeEmail}` : "",
            companyName ? `🏢 *Empresa:* ${companyName}` : "",
            `🕒 *Data/Hora:* ${startBR} (${duration} min)`,
            `🎯 *Pauta:* ${String(callArgs.necessidade || callArgs.summary || "Reunião Comercial")}`,
            meetUri ? `🎥 *Google Meet:* ${meetUri}` : "",
            `🤖 *Agente:* ${agentConfig.name || "IA"}`,
          ]
            .filter(Boolean)
            .join("\n");

          try {
            const { registerPendingAutomatedSend } = await import("@/lib/manual-send-registry");
            registerPendingAutomatedSend(instanceName, ownerJid, ownerMsg);
          } catch { /* ignore */ }
          const { sendMessage } = await import("@/lib/channel");
          const ownerRes = await sendMessage(ownerJid, ownerMsg, instanceName).catch((e: unknown) => {
            console.warn("[Agent/NotifyOwner] falhou:", e instanceof Error ? e.message : String(e));
            return null;
          });
          const ownerMsgId =
            (ownerRes as { messageId?: string; key?: { id?: string }; data?: { key?: { id?: string } } } | null)?.messageId ||
            (ownerRes as { key?: { id?: string } } | null)?.key?.id ||
            (ownerRes as { data?: { key?: { id?: string } } } | null)?.data?.key?.id;
          if (ownerMsgId) {
            try {
              const { registerAiSend } = await import("@/lib/manual-send-registry");
              registerAiSend(ownerMsgId);
            } catch { /* ignore */ }
          }
        }
      } catch (notifyErr: unknown) {
        console.warn("[Agent/NotifyOwner] erro inesperado:", notifyErr instanceof Error ? notifyErr.message : String(notifyErr));
      }

      try {
        if (evId) {
          const insertPayload: Record<string, unknown> = {
            client_id: clientId,
            agent_id: agentConfig.id || null,
            lead_id: calLeadRow?.id || null,
            remote_jid: remoteJid,
            instance_name: instanceName,
            google_event_id: evId,
            calendar_id: "primary",
            title: String(eventBody.summary || "Reunião"),
            description: eventBody.description || null,
            service_name: (callArgs.necessidade as string) || (callArgs.summary as string) || null,
            start_at: startDt.toISOString(),
            end_at: endDt.toISOString(),
            status: "confirmed",
            created_by: "ia",
            html_link: instRes.data.htmlLink || null,
            conference_data: instRes.data.conferenceData || null,
            location: instRes.data.location || meetUri || null,
            attendees: attendeeEmail ? [{ email: attendeeEmail, displayName: (callArgs.nome as string) || clientName }] : [],
            organizer_email: instRes.data.organizer?.email || null,
            metadata: {
              attendee_name: (callArgs.nome as string) || null,
              attendee_email: attendeeEmail || null,
              meet_link: meetUri,
            },
          };

          let { error: apptInsErr } = await supabase.from("appointments").insert(insertPayload);
          if (apptInsErr) {
            const msg = String(apptInsErr.message || "");
            const code = (apptInsErr as { code?: string }).code;
            const isSchemaMiss =
              code === "PGRST204" ||
              code === "42703" ||
              /does not exist/i.test(msg) ||
              /column .* of 'appointments'/i.test(msg) ||
              /Could not find the .* column/i.test(msg);

            if (isSchemaMiss) {
              const fallbackPayload = { ...insertPayload };
              delete fallbackPayload.html_link;
              delete fallbackPayload.conference_data;
              delete fallbackPayload.location;
              delete fallbackPayload.attendees;
              delete fallbackPayload.organizer_email;
              ({ error: apptInsErr } = await supabase.from("appointments").insert(fallbackPayload));
            }
          }

          if (apptInsErr) {
            if ((apptInsErr as { code?: string }).code === "23505") {
              raceConflict = true;
              await calendar.events
                .delete({ calendarId: "primary", eventId: evId, sendUpdates: "all" })
                .catch((delErr: unknown) =>
                  console.warn("[Agent/Schedule] rollback Google falhou:", delErr instanceof Error ? delErr.message : String(delErr)),
                );
              console.warn(`[Agent/Schedule] Corrida de slot ${startDt.toISOString()} — evento Google desfeito.`);
            } else {
              console.warn("[Agent/Schedule] Falha persistindo em appointments (não-fatal):", apptInsErr.message);
            }
          } else {
            try {
              const { data: oldAppts } = await supabase
                .from("appointments")
                .select("id, google_event_id")
                .eq("client_id", clientId)
                .eq("remote_jid", remoteJid)
                .eq("status", "confirmed")
                .gt("start_at", new Date().toISOString())
                .neq("google_event_id", evId);
              for (const old of (oldAppts || []) as Array<{ id: string; google_event_id?: string | null }>) {
                if (old.google_event_id) {
                  await calendar.events.delete({ calendarId: "primary", eventId: old.google_event_id, sendUpdates: "all" }).catch(() => {});
                }
                await supabase
                  .from("appointments")
                  .update({
                    status: "cancelled",
                    cancelled_at: new Date().toISOString(),
                    cancelled_reason: "Remarcado pelo cliente (novo horário)",
                    google_event_id: null,
                  })
                  .eq("id", old.id);
              }
              if ((oldAppts || []).length > 0) {
                console.log(`[Agent/Schedule] Remarcação: ${oldAppts!.length} agendamento(s) antigo(s) cancelado(s) pro contato ${maskJid(remoteJid)}.`);
              }
            } catch (reErr: unknown) {
              console.warn("[Agent/Schedule] cancelamento de agendamento antigo (remarcação) falhou:", reErr instanceof Error ? reErr.message : String(reErr));
            }
          }
        }
      } catch (apptErr: unknown) {
        console.warn("[Agent/Schedule] Falha persistindo em appointments (não-fatal):", apptErr instanceof Error ? apptErr.message : String(apptErr));
      }

      if (raceConflict) {
        functionResultRes = {
          scheduled: false,
          slot_taken: true,
          message: "Esse horário acabou de ser ocupado por outro cliente. Chame check_google_calendar_availability e ofereça um horário livre DIFERENTE — não confirme esse.",
        };
      } else {
        onMeetingScheduled?.();
        await promoteLeadBySystemSignal({
          clientId,
          remoteJid,
          signal: "calendar_scheduled",
          reason: `Agendamento confirmado no Google Calendar: "${String(callArgs.summary || "")}" (${String(callArgs.start_datetime || "")}).`,
          summary: (callArgs.necessidade as string) || `Reunião agendada para ${String(callArgs.start_datetime || "")}.`,
        }).catch(() => {});

        try {
          let summaryKind: "agendamento" | "reagendamento" = "agendamento";
          const { data: recentCancel } = await supabase
            .from("appointments")
            .select("id")
            .eq("client_id", clientId)
            .eq("remote_jid", remoteJid)
            .eq("status", "cancelled")
            .gte("cancelled_at", new Date(Date.now() - 10 * 60_000).toISOString())
            .limit(1)
            .maybeSingle();
          if (recentCancel) summaryKind = "reagendamento";
          const { sendOwnerAppointmentSummary } = await import("@/lib/owner-summary");
          await sendOwnerAppointmentSummary({
            kind: summaryKind,
            agentConfig,
            clientId,
            remoteJid,
            instanceName,
            appointment: {
              title: String(eventBody.summary || "Reunião"),
              service_name: (callArgs.necessidade as string) || (callArgs.summary as string) || null,
              start_at: startDt.toISOString(),
            },
          });
        } catch (sumErr: unknown) {
          console.warn("[Agent/Schedule] resumo p/ dono falhou (não-fatal):", sumErr instanceof Error ? sumErr.message : String(sumErr));
        }

        try {
          const schedPause = (agentConfig.scheduler_config || {}) as Record<string, unknown>;
          const pauseMin = Number(schedPause.pause_after_schedule_minutes);
          if (!isTestMode && sessionId && Number.isFinite(pauseMin) && pauseMin > 0) {
            const { snoozeSession } = await import("@/lib/bot-status");
            await snoozeSession(sessionId, pauseMin, "system").catch((e: unknown) =>
              console.warn("[Agent/Schedule] pausa pós-agendamento falhou (não-fatal):", e instanceof Error ? e.message : String(e)),
            );
            supabase
              .from("webhook_logs")
              .insert({
                instance_name: instanceName,
                client_id: clientId,
                event: "AGENT_SCHEDULE_PAUSE",
                payload: { remote_jid: maskJid(remoteJid), session_id: sessionId, pause_minutes: pauseMin },
                created_at: new Date().toISOString(),
              })
              .then(() => {}, () => {});
            console.log(`[Agent/Schedule] IA pausada por ${pauseMin}min p/ ${maskJid(remoteJid)} (pós-agendamento).`);
          }
        } catch { /* não-fatal */ }

        const startBRFormatted = startDt.toLocaleDateString("pt-BR", {
          weekday: "long",
          day: "2-digit",
          month: "long",
          timeZone: "America/Sao_Paulo",
        });
        const timeBRFormatted = startDt.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Sao_Paulo",
        });

        const meetUrl = meetUri || (meetLinkStr ? meetLinkStr.match(/https?:\/\/\S+/)?.[0] || "" : "");
        const meetDirective = meetUrl
          ? ` Link do Google Meet gerado: ${meetUrl}. OBRIGATÓRIO: inclua este link na sua mensagem de confirmação para o cliente.`
          : "";
        const emailDirective = attendeeEmail
          ? ` Convite oficial do Google Calendar enviado para o e-mail: ${attendeeEmail}.`
          : "";

        functionResultRes = {
          scheduled: true,
          event_id: evId,
          meet_link: meetUrl || null,
          start_datetime: callArgs.start_datetime,
          date_formatted: startBRFormatted,
          time_formatted: timeBRFormatted,
          message: `Agendamento CONFIRMADO com sucesso para ${startBRFormatted} às ${timeBRFormatted}.${meetDirective}${emailDirective} Confirme com o cliente com simpatia e informe os detalhes.`,
        };
      }
    }
  } catch (mcpErr: unknown) {
    console.error("[MCP Error]:", mcpErr);
    const errMsg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
    functionResultRes = {
      scheduled: false,
      message: `Falha na integração: ${errMsg}. Peça desculpas ao cliente e avise que o sistema está indisponível.`,
    };
  }

  callLogs.push({
    role: "system",
    content: `[Google Calendar] O Agente tentou agendar: "${String(callArgs.summary || "")}" | Status: ${functionResultRes.scheduled ? "Sucesso" : "Falha"}`,
  });
  return functionResultRes;
}

export async function executeCheckGoogleCalendarAvailability(ctx: {
  callArgs: Record<string, unknown>;
  agentConfig: { id?: number; schedules?: unknown; is_24h?: boolean | null; options?: Record<string, unknown> };
  calendarDuration: number;
  callLogs: CallLogEntry[];
}): Promise<Record<string, unknown>> {
  const { callArgs, agentConfig, calendarDuration, callLogs } = ctx;
  console.log("[MCP] Checando disponibilidade no Google Calendar ->", callArgs);
  let functionResultRes: Record<string, unknown> = { available: false, message: "Erro ao consultar agenda." };

  try {
    const oauthTokens = parseOAuthTokens(agentConfig.options?.google_tokens);
    if (!oauthTokens?.refresh_token) throw new Error("Agente não autenticado no Google.");
    const auth = await getOAuthClientForAgentOptions(agentConfig.id as number, agentConfig.options || {});
    const calendar = google.calendar({ version: "v3", auth });

    const rawDate = String(callArgs.date || "").trim();
    const targetDate = rawDate.slice(0, 10);
    const daySchedule = resolveDayScheduleForDate(
      targetDate,
      agentConfig.schedules,
      Boolean(agentConfig.is_24h),
    );

    if (daySchedule.closed) {
      functionResultRes = {
        available: false,
        free_slots: [],
        message: `Na data ${targetDate}${daySchedule.weekdayName ? ` (${daySchedule.weekdayName})` : ""}, não há expediente de atendimento configurado. Pergunte se o cliente prefere outro dia útil.`,
      };
    } else {
      const timeMin = new Date(`${targetDate}T${daySchedule.startTime}:00-03:00`).toISOString();
      const timeMax = new Date(`${targetDate}T${daySchedule.endTime}:00-03:00`).toISOString();

      const freeBusyRes = await calendar.freebusy.query({
        requestBody: { timeMin, timeMax, items: [{ id: "primary" }] },
      });
      const googleBusy = freeBusyRes.data.calendars?.["primary"]?.busy || [];

      const { data: dbAppointments } = await supabase
        .from("appointments")
        .select("start_at, end_at")
        .eq("agent_id", agentConfig.id)
        .in("status", ["confirmed", "tentative"])
        .gte("start_at", `${targetDate}T00:00:00-03:00`)
        .lte("start_at", `${targetDate}T23:59:59-03:00`);

      const allBusy = [
        ...googleBusy.map((b) => ({ start: b.start || "", end: b.end || "" })),
        ...((dbAppointments || []) as Array<{ start_at: string; end_at: string }>).map((a) => ({
          start: a.start_at,
          end: a.end_at,
        })),
      ];

      const freeSlots = calculateFreeSlots({
        targetDate,
        busyRanges: allBusy,
        durationMinutes: calendarDuration,
        startTime: daySchedule.startTime,
        endTime: daySchedule.endTime,
        stepMinutes: 30,
        nowDate: new Date(),
        minBufferMinutes: 30,
      });

      if (freeSlots.length > 0) {
        const suggested = freeSlots.slice(0, 8).join(", ");
        functionResultRes = {
          available: true,
          free_slots: freeSlots,
          message: `Na data ${targetDate}, os seguintes horários estão LIVRES para reunião de ${calendarDuration} min: ${suggested}. Sugira 2 opções destes horários livres ao cliente com simpatia.`,
        };
      } else {
        functionResultRes = {
          available: false,
          free_slots: [],
          message: `Na data ${targetDate}, a agenda está sem horários livres no expediente (${daySchedule.startTime} às ${daySchedule.endTime}). Pergunte se o cliente prefere outro dia (como no dia seguinte ou na semana seguinte).`,
        };
      }
    }
  } catch (mcpErr: unknown) {
    console.error("[MCP FreeBusy Error]:", mcpErr);
    const errMsg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
    functionResultRes = { available: false, message: `Falha na consulta de tempo: ${errMsg}` };
  }

  callLogs.push({
    role: "system",
    content: `[Google Calendar] Disponibilidade consultada para ${String(callArgs.date || "")} | Status: ${functionResultRes.available ? "OK" : "Falha"}`,
  });
  return functionResultRes;
}

export async function executeListGoogleCalendarEvents(ctx: {
  callArgs: Record<string, unknown>;
  agentConfig: { id?: number; options?: Record<string, unknown> };
  clientId: string;
  remoteJid: string;
  callLogs: CallLogEntry[];
}): Promise<Record<string, unknown>> {
  const { callArgs, agentConfig, clientId, remoteJid, callLogs } = ctx;
  console.log("[MCP] Listando eventos do Google Calendar ->", callArgs);
  let functionResultRes: Record<string, unknown> = {
    found: false,
    events: [],
    message: "Erro ao listar eventos.",
  };

  try {
    const oauthTokens = parseOAuthTokens(agentConfig.options?.google_tokens);
    if (!oauthTokens?.refresh_token) throw new Error("Agente não autenticado no Google.");
    const auth = await getOAuthClientForAgentOptions(agentConfig.id as number, agentConfig.options || {});
    const calendar = google.calendar({ version: "v3", auth });

    const dFrom = callArgs.date_from as string;
    const dTo = (callArgs.date_to as string) || dFrom;
    const timeMin = new Date(`${dFrom}T00:00:00-03:00`).toISOString();
    const timeMax = new Date(`${dTo}T23:59:59-03:00`).toISOString();

    const contactDigits = normalizeDigits(remoteJid);
    const { data: contactAppts } = await supabase
      .from("appointments")
      .select("google_event_id, remote_jid")
      .eq("client_id", clientId)
      .in("status", ["confirmed", "tentative"])
      .gte("start_at", timeMin)
      .lte("start_at", timeMax)
      .not("google_event_id", "is", null);

    const ownedEventIds = new Set(
      ((contactAppts || []) as Array<{ google_event_id?: string | null; remote_jid?: string | null }>)
        .filter((a) => a.google_event_id && normalizeDigits(a.remote_jid) === contactDigits)
        .map((a) => String(a.google_event_id)),
    );

    if (ownedEventIds.size === 0) {
      functionResultRes = {
        found: false,
        events: [],
        message: `Nenhum evento deste contato encontrado entre ${dFrom} e ${dTo}. Avise o cliente que não há reunião marcada nesse período.`,
      };
    } else {
      const list = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 30,
      });

      const events = (list.data.items || [])
        .filter((e) => e?.id && ownedEventIds.has(String(e.id)))
        .map((e) => ({
          id: e.id,
          summary: e.summary || "(sem título)",
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
        }));

      functionResultRes =
        events.length > 0
          ? { found: true, events, message: `${events.length} evento(s) encontrado(s) entre ${dFrom} e ${dTo}.` }
          : {
              found: false,
              events: [],
              message: `Nenhum evento deste contato encontrado entre ${dFrom} e ${dTo}. Avise o cliente que não tem reunião nesse período.`,
            };
    }
  } catch (mcpErr: unknown) {
    console.error("[MCP List Error]:", mcpErr);
    const errMsg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
    functionResultRes = { found: false, events: [], message: `Falha ao listar agenda: ${errMsg}` };
  }

  const eventsList = Array.isArray(functionResultRes.events) ? functionResultRes.events : [];
  callLogs.push({
    role: "system",
    content: `[Google Calendar] List ${String(callArgs.date_from || "")}..${String(callArgs.date_to || callArgs.date_from || "")} | ${eventsList.length} evento(s)`,
  });
  return functionResultRes;
}

export async function executeCancelGoogleCalendarEvent(ctx: {
  callArgs: Record<string, unknown>;
  agentConfig: { id?: number; name?: string | null; options?: Record<string, unknown>; scheduler_config?: Record<string, unknown> };
  clientId: string;
  remoteJid: string;
  instanceName: string;
  callLogs: CallLogEntry[];
}): Promise<Record<string, unknown>> {
  const { callArgs, agentConfig, clientId, remoteJid, instanceName, callLogs } = ctx;
  console.log("[MCP] Cancelando evento do Google Calendar ->", callArgs);
  let functionResultRes: Record<string, unknown> = {
    cancelled: false,
    message: "Erro ao cancelar evento.",
  };

  try {
    const oauthTokens = parseOAuthTokens(agentConfig.options?.google_tokens);
    if (!oauthTokens?.refresh_token) throw new Error("Agente não autenticado no Google.");
    const auth = await getOAuthClientForAgentOptions(agentConfig.id as number, agentConfig.options || {});
    const calendar = google.calendar({ version: "v3", auth });

    const eventId = String(callArgs.event_id || "").trim();
    if (!eventId) throw new Error("event_id vazio. Chame list_google_calendar_events primeiro.");

    const { data: apptRow, error: apptLookupErr } = await supabase
      .from("appointments")
      .select("id, remote_jid, title, service_name, start_at")
      .eq("client_id", clientId)
      .eq("google_event_id", eventId)
      .maybeSingle();
    if (apptLookupErr) throw new Error("Falha ao validar ownership do evento.");

    const wrongTenant = !apptRow;
    const wrongContact = !wrongTenant && normalizeDigits((apptRow as { remote_jid?: string }).remote_jid) !== normalizeDigits(remoteJid);
    if (wrongTenant || wrongContact) {
      functionResultRes = {
        cancelled: false,
        message: wrongTenant
          ? "Evento não pertence a esta conversa/agenda local. Peça ao cliente pra confirmar a data e chame list_google_calendar_events de novo."
          : "Esse evento pertence a outro contato. Só posso cancelar compromissos desta conversa.",
      };
      callLogs.push({
        role: "system",
        content: `[Google Calendar] Cancel ${eventId} | Recusado: ${wrongTenant ? "sem appointment do contato" : "outro contato"}`,
      });
    } else {
      await calendar.events.delete({
        calendarId: "primary",
        eventId,
        sendUpdates: "all",
      });

      type CancelledApptRow = { title?: string | null; service_name?: string | null; start_at?: string | null };
      let cancelledAppt: CancelledApptRow | null = null;
      try {
        const { data: cancelledRows } = await supabase
          .from("appointments")
          .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
            cancelled_reason: (callArgs.reason as string) || "Cancelado pela IA via WhatsApp",
            google_event_id: null,
          })
          .eq("client_id", clientId)
          .eq("id", (apptRow as { id: string }).id)
          .select("title, service_name, start_at");
        cancelledAppt = (cancelledRows?.[0] as CancelledApptRow | undefined) ?? null;
      } catch (apptErr: unknown) {
        console.warn("[Agent/Cancel] Falha atualizando appointments:", apptErr instanceof Error ? apptErr.message : String(apptErr));
      }

      try {
        const { sendOwnerAppointmentSummary } = await import("@/lib/owner-summary");
        await sendOwnerAppointmentSummary({
          kind: "cancelamento",
          agentConfig,
          clientId,
          remoteJid,
          instanceName,
          appointment: {
            title: cancelledAppt?.title || null,
            service_name: cancelledAppt?.service_name || null,
            start_at: cancelledAppt?.start_at || null,
          },
        });
      } catch (sumErr: unknown) {
        console.warn("[Agent/Cancel] resumo p/ dono falhou (não-fatal):", sumErr instanceof Error ? sumErr.message : String(sumErr));
      }

      functionResultRes = {
        cancelled: true,
        message: `Evento ${eventId} cancelado com sucesso. Avise o cliente que a reunião foi desmarcada${callArgs.reason ? ` (motivo: ${String(callArgs.reason)})` : ""}.`,
      };
    }
  } catch (mcpErr: unknown) {
    console.error("[MCP Cancel Error]:", mcpErr);
    const errMsg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
    const msg = /not found|resource.*not.*exist/i.test(errMsg)
      ? "Esse evento não foi encontrado. Peça ao cliente pra confirmar a data e chame list_google_calendar_events de novo."
      : `Falha ao cancelar: ${errMsg}`;
    functionResultRes = { cancelled: false, message: msg };
  }

  callLogs.push({
    role: "system",
    content: `[Google Calendar] Cancel ${String(callArgs.event_id || "")} | Status: ${functionResultRes.cancelled ? "Sucesso" : "Falha"}`,
  });
  return functionResultRes;
}

