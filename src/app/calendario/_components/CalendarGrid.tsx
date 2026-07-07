"use client";

import { useMemo, useCallback } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import { format as dfFormat, parse as dfParse, startOfWeek as dfStartOfWeek, getDay as dfGetDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";
import "../calendar-theme.css";
import { colorForAppointment } from "@/lib/google-calendar-colors";

// Localizer date-fns em pt-BR (semana começa domingo, como o Google BR).
const rbcLocalizer = dateFnsLocalizer({
  format: dfFormat,
  parse: dfParse,
  startOfWeek: (date: Date) => dfStartOfWeek(date, { weekStartsOn: 0 }),
  getDay: dfGetDay,
  locales: { "pt-BR": ptBR },
});
const DnDCalendar = withDragAndDrop(Calendar as any);

type Appointment = {
  id: string;
  client_id: string;
  agent_id: number | null;
  lead_id: number | null;
  remote_jid: string;
  instance_name: string | null;
  google_event_id: string | null;
  title: string;
  description: string | null;
  service_name: string | null;
  start_at: string;
  end_at: string;
  status: "confirmed" | "tentative" | "cancelled" | "completed" | "no_show";
  created_by: "ia" | "manual" | "google_sync";
  cancelled_reason: string | null;
  location?: string | null;
  attendees?: { email: string; displayName?: string; responseStatus?: string }[] | null;
  all_day?: boolean;
  visibility?: "default" | "public" | "private" | "confidential";
  color_id?: string | null;
  html_link?: string | null;
  recurrence?: string[] | null;
  conference_data?: any;
  organizer_email?: string | null;
  metadata?: Record<string, any> | null;
};

const RBC_MESSAGES = {
  date: "Data", time: "Hora", event: "Evento", allDay: "Dia todo",
  week: "Semana", work_week: "Semana útil", day: "Dia", month: "Mês",
  previous: "Anterior", next: "Próximo", yesterday: "Ontem", tomorrow: "Amanhã",
  today: "Hoje", agenda: "Agenda", noEventsInRange: "Nenhum agendamento neste período.",
  showMore: (n: number) => `+${n} mais`,
};

type ViewMode = "day" | "week" | "month" | "agenda";

export default function CalendarGrid({
  appointments,
  anchor,
  view,
  onNavigate,
  onView,
  onSelectSlot,
  onSelectEvent,
  onEventDropOrResize,
}: {
  appointments: Appointment[];
  anchor: Date;
  view: ViewMode;
  onNavigate: (d: Date) => void;
  onView: (v: ViewMode) => void;
  onSelectSlot: (slot: any) => void;
  onSelectEvent: (event: any) => void;
  onEventDropOrResize: (data: { event: any; start: Date | string; end: Date | string }) => void;
}) {
  const rbcEvents = useMemo(
    () =>
      appointments.map((a) => ({
        id: a.id,
        title: a.title,
        start: new Date(a.start_at),
        end: new Date(a.end_at),
        allDay: !!a.all_day,
        resource: a,
      })),
    [appointments]
  );

  const eventPropGetter = useCallback(
    (event: any) => {
      const a = event.resource as Appointment;
      const past = new Date(a.end_at).getTime() < Date.now();
      return {
        style: {
          backgroundColor: colorForAppointment(a),
          color: "#fff",
          opacity: a.status === "cancelled" ? 0.4 : past ? 0.7 : 1,
          textDecoration: a.status === "cancelled" ? "line-through" : "none",
        },
      };
    },
    []
  );

  const handleEventDrop = useCallback(
    (data: { event: any; start: Date | string; end: Date | string }) => {
      onEventDropOrResize(data);
    },
    [onEventDropOrResize]
  );

  const handleEventResize = useCallback(
    (data: { event: any; start: Date | string; end: Date | string }) => {
      onEventDropOrResize(data);
    },
    [onEventDropOrResize]
  );

  return (
    <div
      className="calendar-dark rounded-2xl border border-white/10 bg-secondary/20 p-1 sm:p-2"
      style={{ height: "calc(100vh - 240px)", minHeight: 520 }}
    >
      <DnDCalendar
        localizer={rbcLocalizer}
        culture="pt-BR"
        messages={RBC_MESSAGES}
        events={rbcEvents}
        date={anchor}
        onNavigate={onNavigate}
        view={view as any}
        onView={onView as any}
        views={["month", "week", "day"]}
        toolbar={false}
        popup
        selectable
        startAccessor="start"
        endAccessor="end"
        step={30}
        timeslots={2}
        scrollToTime={new Date(1970, 0, 1, 7, 0, 0)}
        eventPropGetter={eventPropGetter}
        onSelectEvent={onSelectEvent}
        onSelectSlot={onSelectSlot}
        onEventDrop={handleEventDrop}
        onEventResize={handleEventResize}
        draggableAccessor={(e: any) => e.resource?.status !== "cancelled"}
        resizableAccessor={(e: any) => e.resource?.status !== "cancelled"}
        style={{ height: "100%" }}
      />
    </div>
  );
}
