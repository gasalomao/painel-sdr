"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  CalendarDays,
  Check,
  Clock,
  ExternalLink,
  Link2,
  Loader2,
  MapPin,
  Plus,
  Repeat2,
  Trash2,
  User,
  Users,
  Video,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { normalizeJid } from "@/lib/jid-utils";
import { GOOGLE_EVENT_COLORS } from "@/lib/google-calendar-colors";
import {
  DEFAULT_RECURRENCE,
  buildRecurrenceRule,
  parseRecurrenceRule,
  type RecurrenceSpec,
} from "@/lib/agenda-logic";
import type {
  Agent,
  Appointment,
  AppointmentAttendee,
  AppointmentVisibility,
  GoogleConferenceData,
} from "../types";
import styles from "../calendar.module.css";

type CustomReminder = {
  offset_minutes: number;
  message: string;
};

type DialogToast = {
  kind: "ok" | "err";
  text: string;
  link?: string | null;
};

type AppointmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Appointment | null;
  initialStart?: Date | null;
  agents: Agent[];
  onSaved: () => void;
  onToast: (toast: DialogToast) => void;
  onDelete: (id: string) => Promise<void> | void;
};

const GOOGLE_MAPS_URL = "https://www.google.com/maps/search/?api=1&query=";

function toLocalInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function toLocalDate(date: Date): string {
  return toLocalInput(date).slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getMeetLink(conference: GoogleConferenceData | null | undefined): string | null {
  return conference?.hangoutLink
    || conference?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri
    || null;
}

function readCustomReminders(metadata: Appointment["metadata"]): CustomReminder[] {
  const reminders = metadata?.custom_reminders;
  if (!Array.isArray(reminders)) return [];

  return reminders.filter((reminder): reminder is CustomReminder => {
    if (!reminder || typeof reminder !== "object") return false;
    const candidate = reminder as Partial<CustomReminder>;
    return typeof candidate.offset_minutes === "number"
      && typeof candidate.message === "string";
  });
}

function formatReminderOffset(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remaining = minutes % 60;
  const parts = [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    remaining > 0 || (days === 0 && hours === 0) ? `${remaining}min` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

export default function AppointmentDialog({
  open,
  onOpenChange,
  editing,
  initialStart,
  agents,
  onSaved,
  onToast,
  onDelete,
}: AppointmentDialogProps) {
  const [title, setTitle] = useState("");
  const [remoteJid, setRemoteJid] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [agentId, setAgentId] = useState("none");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [visibility, setVisibility] = useState<AppointmentVisibility>("default");
  const [colorId, setColorId] = useState("");
  const [attendees, setAttendees] = useState<AppointmentAttendee[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [createMeet, setCreateMeet] = useState(false);
  const [recurrence, setRecurrence] = useState<RecurrenceSpec>(DEFAULT_RECURRENCE);
  const [customReminders, setCustomReminders] = useState<CustomReminder[]>([]);
  const [useCustomReminders, setUseCustomReminders] = useState(false);
  const [syncGoogle, setSyncGoogle] = useState(true);
  const [saving, setSaving] = useState(false);
  const [serverGoogleError, setServerGoogleError] = useState<string | null>(null);
  const [googleHtmlLink, setGoogleHtmlLink] = useState<string | null>(null);
  const [meetLink, setMeetLink] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setServerGoogleError(null);
    setAttendeeInput("");

    if (editing) {
      const start = new Date(editing.start_at);
      const end = new Date(editing.end_at);
      setTitle(editing.title);
      setRemoteJid(editing.remote_jid);
      setServiceName(editing.service_name || "");
      setDescription(editing.description || "");
      setLocation(editing.location || "");
      setAgentId(editing.agent_id ? String(editing.agent_id) : "none");
      setAllDay(!!editing.all_day);
      setStartAt(editing.all_day ? toLocalDate(start) : toLocalInput(start));
      setEndAt(editing.all_day ? toLocalDate(addDays(end, -1)) : toLocalInput(end));
      setVisibility(editing.visibility || "default");
      setColorId(editing.color_id || "");
      setAttendees(editing.attendees || []);
      setCreateMeet(false);
      setRecurrence(parseRecurrenceRule(editing.recurrence) || DEFAULT_RECURRENCE);
      setSyncGoogle(!!editing.google_event_id);
      setGoogleHtmlLink(editing.html_link || null);
      setMeetLink(getMeetLink(editing.conference_data));

      const reminders = readCustomReminders(editing.metadata);
      setUseCustomReminders(reminders.length > 0);
      setCustomReminders(reminders);
      return;
    }

    const connectedAgent = agents.find((agent) => agent.google_connected) || agents[0];
    const base = initialStart ? new Date(initialStart) : new Date();
    if (!initialStart) base.setMinutes(Math.ceil(base.getMinutes() / 15) * 15, 0, 0);
    const end = new Date(base.getTime() + 60 * 60_000);

    setTitle("");
    setRemoteJid("");
    setServiceName("");
    setDescription("");
    setLocation("");
    setAgentId(connectedAgent?.id ? String(connectedAgent.id) : "none");
    setAllDay(false);
    setStartAt(toLocalInput(base));
    setEndAt(toLocalInput(end));
    setVisibility("default");
    setColorId("");
    setAttendees([]);
    setCreateMeet(false);
    setRecurrence(DEFAULT_RECURRENCE);
    setSyncGoogle(true);
    setGoogleHtmlLink(null);
    setMeetLink(null);
    setUseCustomReminders(false);
    setCustomReminders([]);
  }, [editing, agents, open, initialStart]);

  function changeAllDay(next: boolean) {
    setAllDay(next);
    if (next) {
      setStartAt((value) => value.slice(0, 10));
      setEndAt((value) => value.slice(0, 10));
      return;
    }
    setStartAt((value) => `${value}T09:00`);
    setEndAt((value) => `${value}T10:00`);
  }

  function addAttendee() {
    const email = attendeeInput.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      onToast({ kind: "err", text: "E-mail do convidado inválido." });
      return;
    }
    if (attendees.some((attendee) => attendee.email.toLowerCase() === email.toLowerCase())) {
      setAttendeeInput("");
      return;
    }
    setAttendees((current) => [...current, { email }]);
    setAttendeeInput("");
  }

  function removeAttendee(email: string) {
    setAttendees((current) => current.filter((attendee) => attendee.email !== email));
  }

  async function save() {
    if (!startAt || !endAt) {
      onToast({ kind: "err", text: "Defina início e fim do agendamento." });
      return;
    }

    const start = new Date(allDay ? `${startAt}T00:00` : startAt);
    const rawEnd = new Date(allDay ? `${endAt}T00:00` : endAt);
    const end = allDay ? addDays(rawEnd, 1) : rawEnd;
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      onToast({ kind: "err", text: "O fim deve ser depois do início." });
      return;
    }

    const titleFinal = title.trim() || "(Sem título)";
    const rawRemoteJid = remoteJid.trim();
    const normalizedRemoteJid = normalizeJid(rawRemoteJid);
    // Placeholder não normalizável (google:*, manual:*) só vale se continuar
    // igual ao valor já salvo — o servidor aceita apenas o valor existente.
    if (rawRemoteJid && !normalizedRemoteJid && rawRemoteJid !== editing?.remote_jid) {
      onToast({ kind: "err", text: "Contato do WhatsApp inválido." });
      return;
    }
    const jidNormalized = rawRemoteJid
      ? (normalizedRemoteJid ?? rawRemoteJid)
      : (editing?.remote_jid || `manual:${Date.now()}@local`);

    const validReminders = customReminders
      .filter((reminder) => Number.isFinite(reminder.offset_minutes)
        && reminder.offset_minutes > 0
        && reminder.message.trim())
      .map((reminder) => ({
        offset_minutes: reminder.offset_minutes,
        message: reminder.message.trim(),
      }));
    const metadata: Record<string, unknown> = { ...(editing?.metadata || {}) };
    if (useCustomReminders) metadata.custom_reminders = validReminders;
    else delete metadata.custom_reminders;

    const payload = {
      title: titleFinal,
      remote_jid: jidNormalized,
      service_name: serviceName.trim() || null,
      description: description.trim() || null,
      location: location.trim() || null,
      agent_id: agentId !== "none" ? Number(agentId) : null,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: allDay,
      visibility,
      color_id: colorId || null,
      attendees,
      recurrence: buildRecurrenceRule(recurrence),
      create_meet: createMeet && !meetLink,
      sync_google: syncGoogle,
      metadata,
    };

    setSaving(true);
    setServerGoogleError(null);
    try {
      const response = editing
        ? await fetch(`/api/appointments/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        : await fetch("/api/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        onToast({ kind: "err", text: data.error || "Não foi possível salvar o agendamento." });
        return;
      }

      const savedLink = data.appointment?.html_link || googleHtmlLink || null;
      const savedMeetLink = getMeetLink(data.appointment?.conference_data) || meetLink;
      setGoogleHtmlLink(savedLink);
      setMeetLink(savedMeetLink);

      if (syncGoogle && data.google_error) {
        setServerGoogleError(data.google_error);
        onToast({ kind: "err", text: `Salvo no painel, mas não foi pro Google: ${data.google_error}` });
        return;
      }

      onToast({
        kind: "ok",
        text: syncGoogle && data.appointment?.google_event_id
          ? `${editing ? "Atualizado" : "Criado"} no Google Calendar.`
          : editing ? "Agendamento atualizado." : "Agendamento criado no painel.",
        link: savedLink,
      });
      onSaved();
    } catch (error) {
      onToast({ kind: "err", text: error instanceof Error ? error.message : "Falha ao salvar." });
    } finally {
      setSaving(false);
    }
  }

  const visibleGoogleError = serverGoogleError || editing?.google_error || null;
  const mapsUrl = location.trim()
    ? `${GOOGLE_MAPS_URL}${encodeURIComponent(location.trim())}`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(styles.appointmentDialog, styles.appointmentDialogWide)}
        showCloseButton={false}
        initialFocus={titleInputRef}
      >
        <div className={styles.dialogHeader}>
          <div>
            <DialogTitle className={styles.dialogTitle}>
              {editing ? "Editar agendamento" : "Novo agendamento"}
            </DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              {editing
                ? "Atualize os detalhes e mantenha o Google Calendar consistente."
                : "Preencha o essencial. A recorrência e o Google são opcionais."}
            </DialogDescription>
          </div>
          {googleHtmlLink && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<a href={googleHtmlLink} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLink />
              Abrir no Google
            </Button>
          )}
        </div>

        <div className={styles.dialogBody}>
          <div className={styles.dialogTitleField}>
            <label htmlFor="appointment-title" className="sr-only">Título do agendamento</label>
            <Input
              id="appointment-title"
              ref={titleInputRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Adicionar título"
              className={styles.dialogTitleInput}
            />
          </div>

          <div className={styles.dialogColumns}>
            <div className={styles.dialogColumn}>
              <section className={styles.dialogSection} aria-labelledby="appointment-when-title">
                <div className={styles.sectionHeading}>
                  <Clock aria-hidden="true" />
                  <h3 id="appointment-when-title">Quando</h3>
                </div>

                <div className={styles.dateFields}>
                  <div className={styles.field}>
                    <label htmlFor="appointment-start">Início</label>
                    <Input
                      id="appointment-start"
                      type={allDay ? "date" : "datetime-local"}
                      value={allDay ? startAt.slice(0, 10) : startAt}
                      onChange={(event) => setStartAt(event.target.value)}
                      required
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="appointment-end">Fim</label>
                    <Input
                      id="appointment-end"
                      type={allDay ? "date" : "datetime-local"}
                      value={allDay ? endAt.slice(0, 10) : endAt}
                      onChange={(event) => setEndAt(event.target.value)}
                      required
                    />
                  </div>
                </div>

                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={allDay}
                    onChange={(event) => changeAllDay(event.target.checked)}
                  />
                  <span>Dia inteiro</span>
                </label>

                <div className={styles.field}>
                  <label htmlFor="appointment-recurrence">Repetição</label>
                  <Select
                    value={recurrence.frequency}
                    onValueChange={(value) => setRecurrence((current) => ({
                      ...current,
                      frequency: value as RecurrenceSpec["frequency"],
                    }))}
                  >
                    <SelectTrigger id="appointment-recurrence" className={styles.dialogSelect}>
                      <SelectValue>
                        {recurrence.frequency === "DAILY"
                          ? "Todo dia"
                          : recurrence.frequency === "WEEKLY"
                            ? "Semanalmente"
                            : recurrence.frequency === "MONTHLY"
                              ? "Mensalmente"
                              : "Não repetir"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className={styles.popover}>
                      <SelectItem value="NONE">Não repetir</SelectItem>
                      <SelectItem value="DAILY">Todo dia</SelectItem>
                      <SelectItem value="WEEKLY">Semanalmente</SelectItem>
                      <SelectItem value="MONTHLY">Mensalmente</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {recurrence.frequency !== "NONE" && (
                  <div className={styles.recurrenceFields}>
                    <div className={styles.field}>
                      <label htmlFor="appointment-interval">Repetir a cada</label>
                      <div className={styles.inlineInput}>
                        <Input
                          id="appointment-interval"
                          type="number"
                          min={1}
                          max={99}
                          value={recurrence.interval}
                          onChange={(event) => setRecurrence((current) => ({
                            ...current,
                            interval: Math.max(1, Number(event.target.value) || 1),
                          }))}
                        />
                        <span>{recurrence.frequency === "DAILY" ? "dia(s)" : recurrence.frequency === "WEEKLY" ? "semana(s)" : "mês(es)"}</span>
                      </div>
                    </div>
                    <div className={styles.field}>
                      <label htmlFor="appointment-recurrence-end">Termina em</label>
                      <Select
                        value={recurrence.end.type}
                        onValueChange={(value) => setRecurrence((current) => ({
                          ...current,
                          end: value === "count"
                            ? { type: "count", count: 10 }
                            : value === "until"
                              ? { type: "until", date: startAt.slice(0, 10) }
                              : { type: "never" },
                        }))}
                      >
                        <SelectTrigger id="appointment-recurrence-end" className={styles.dialogSelect}>
                          <SelectValue>
                            {recurrence.end.type === "count"
                              ? "Após número de repetições"
                              : recurrence.end.type === "until"
                                ? "Em uma data"
                                : "Nunca"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent className={styles.popover}>
                          <SelectItem value="never">Nunca</SelectItem>
                          <SelectItem value="count">Após número de repetições</SelectItem>
                          <SelectItem value="until">Em uma data</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {recurrence.end.type === "count" && (
                      <div className={styles.field}>
                        <label htmlFor="appointment-recurrence-count">Número de repetições</label>
                        <Input
                          id="appointment-recurrence-count"
                          type="number"
                          min={1}
                          max={999}
                          value={recurrence.end.count}
                          onChange={(event) => setRecurrence((current) => ({
                            ...current,
                            end: { type: "count", count: Math.max(1, Number(event.target.value) || 1) },
                          }))}
                        />
                      </div>
                    )}
                    {recurrence.end.type === "until" && (
                      <div className={styles.field}>
                        <label htmlFor="appointment-recurrence-until">Data final</label>
                        <Input
                          id="appointment-recurrence-until"
                          type="date"
                          value={recurrence.end.date}
                          min={startAt.slice(0, 10)}
                          onChange={(event) => setRecurrence((current) => ({
                            ...current,
                            end: { type: "until", date: event.target.value },
                          }))}
                        />
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className={styles.dialogSection} aria-labelledby="appointment-place-title">
                <div className={styles.sectionHeading}>
                  <MapPin aria-hidden="true" />
                  <h3 id="appointment-place-title">Local e Maps</h3>
                </div>
                <div className={styles.field}>
                  <label htmlFor="appointment-location">Local</label>
                  <Input
                    id="appointment-location"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="Endereço, sala ou referência"
                  />
                </div>
                {mapsUrl && (
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.inlineLink}
                  >
                    <MapPin aria-hidden="true" />
                    Abrir local no Google Maps
                    <ExternalLink aria-hidden="true" />
                  </a>
                )}
              </section>

              <section className={styles.dialogSection} aria-labelledby="appointment-guests-title">
                <div className={styles.sectionHeading}>
                  <Users aria-hidden="true" />
                  <h3 id="appointment-guests-title">Convidados</h3>
                </div>
                <div className={styles.guestInput}>
                  <label htmlFor="appointment-attendee" className="sr-only">E-mail do convidado</label>
                  <Input
                    id="appointment-attendee"
                    type="email"
                    value={attendeeInput}
                    onChange={(event) => setAttendeeInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addAttendee();
                      }
                    }}
                    placeholder="email@exemplo.com"
                    aria-describedby="appointment-attendee-hint"
                  />
                  <Button type="button" variant="outline" onClick={addAttendee}>
                    <Plus />
                    Adicionar
                  </Button>
                </div>
                <p id="appointment-attendee-hint" className={styles.fieldHint}>
                  O Google envia convite por e-mail quando sincronizado.
                </p>
                {attendees.length > 0 && (
                  <ul className={styles.guestList} aria-label="Convidados adicionados">
                    {attendees.map((attendee) => (
                      <li key={attendee.email}>
                        <span>{attendee.email}</span>
                        <button
                          type="button"
                          onClick={() => removeAttendee(attendee.email)}
                          aria-label={`Remover ${attendee.email}`}
                        >
                          <X aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={styles.dialogSection} aria-labelledby="appointment-details-title">
                <div className={styles.sectionHeading}>
                  <CalendarDays aria-hidden="true" />
                  <h3 id="appointment-details-title">Detalhes</h3>
                </div>
                <div className={styles.field}>
                  <label htmlFor="appointment-description">Descrição</label>
                  <Textarea
                    id="appointment-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                    placeholder="Contexto do agendamento"
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="appointment-service">Serviço</label>
                  <Input
                    id="appointment-service"
                    value={serviceName}
                    onChange={(event) => setServiceName(event.target.value)}
                    placeholder="Ex.: Consulta, avaliação, reunião"
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="appointment-contact">Contato do WhatsApp</label>
                  <Input
                    id="appointment-contact"
                    value={remoteJid}
                    onChange={(event) => setRemoteJid(event.target.value)}
                    placeholder="5511999998888 ou JID completo"
                    aria-describedby="appointment-contact-hint"
                  />
                  <p id="appointment-contact-hint" className={styles.fieldHint}>
                    Telefone com DDD ou JID completo.
                  </p>
                </div>
              </section>
            </div>

            <div className={styles.dialogColumn}>
              <section className={styles.dialogSection} aria-labelledby="appointment-video-title">
                <div className={styles.sectionHeading}>
                  <Video aria-hidden="true" />
                  <h3 id="appointment-video-title">Videoconferência</h3>
                </div>
                {meetLink ? (
                  <div className={styles.meetStatus}>
                    <span><Check aria-hidden="true" /> Google Meet anexado</span>
                    <a href={meetLink} target="_blank" rel="noopener noreferrer">
                      Abrir Meet
                      <ExternalLink aria-hidden="true" />
                    </a>
                  </div>
                ) : (
                  <label className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={createMeet}
                      onChange={(event) => setCreateMeet(event.target.checked)}
                    />
                    <span>Adicionar Google Meet</span>
                  </label>
                )}
              </section>

              <section className={styles.dialogSection} aria-labelledby="appointment-appearance-title">
                <div className={styles.sectionHeading}>
                  <Repeat2 aria-hidden="true" />
                  <h3 id="appointment-appearance-title">Aparência</h3>
                </div>
                <fieldset className={styles.field}>
                  <legend>Cor do evento</legend>
                  <div className={styles.colorList}>
                    {GOOGLE_EVENT_COLORS.map((color) => (
                      <button
                        key={color.id || "default"}
                        type="button"
                        onClick={() => setColorId(color.id)}
                        className={cn(styles.colorButton, colorId === color.id && styles.colorButtonSelected)}
                        style={{ backgroundColor: color.hex }}
                        aria-label={color.name}
                        aria-pressed={colorId === color.id}
                        title={color.name}
                      />
                    ))}
                  </div>
                </fieldset>
                <div className={styles.field}>
                  <label htmlFor="appointment-visibility">Visibilidade</label>
                  <Select
                    value={visibility}
                    onValueChange={(value) => setVisibility(value as AppointmentVisibility)}
                  >
                    <SelectTrigger id="appointment-visibility" className={styles.dialogSelect}>
                      <SelectValue>
                        {visibility === "public"
                          ? "Público"
                          : visibility === "private"
                            ? "Privado"
                            : visibility === "confidential"
                              ? "Confidencial"
                              : "Padrão do calendário"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className={styles.popover}>
                      <SelectItem value="default">Padrão do calendário</SelectItem>
                      <SelectItem value="public">Público</SelectItem>
                      <SelectItem value="private">Privado</SelectItem>
                      <SelectItem value="confidential">Confidencial</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </section>

              <section className={styles.dialogSection} aria-labelledby="appointment-owner-title">
                <div className={styles.sectionHeading}>
                  <User aria-hidden="true" />
                  <h3 id="appointment-owner-title">Responsável e Google</h3>
                </div>
                <div className={styles.field}>
                  <label htmlFor="appointment-agent">Agente responsável</label>
                  <Select value={agentId} onValueChange={(value) => setAgentId(value || "none")}>
                    <SelectTrigger id="appointment-agent" className={styles.dialogSelect}>
                      <SelectValue placeholder="Selecione um agente">
                  {agentId === "none"
                    ? "Nenhum"
                    : agents.find((agent) => String(agent.id) === agentId)?.name || "Agente"}
                </SelectValue>
                    </SelectTrigger>
                    <SelectContent className={styles.popover}>
                      <SelectItem value="none">Nenhum</SelectItem>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={String(agent.id)}>
                          {agent.name}
                          {agent.is_scheduler ? " · Scheduler" : ""}
                          {agent.google_connected ? " · Google conectado" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={syncGoogle}
                    onChange={(event) => setSyncGoogle(event.target.checked)}
                  />
                  <span>Sincronizar com Google Calendar</span>
                </label>
                {visibleGoogleError && (
                  <div className={styles.googleError} role="alert">
                    <AlertCircle aria-hidden="true" />
                    <div>
                      <strong>Google Calendar não sincronizou</strong>
                      <span>{visibleGoogleError}</span>
                    </div>
                  </div>
                )}
              </section>

              <section className={styles.dialogSection} aria-labelledby="appointment-reminders-title">
                <div className={styles.sectionHeading}>
                  <Bell aria-hidden="true" />
                  <h3 id="appointment-reminders-title">Lembretes</h3>
                </div>
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={useCustomReminders}
                    onChange={(event) => {
                      setUseCustomReminders(event.target.checked);
                      if (event.target.checked && customReminders.length === 0) {
                        setCustomReminders([
                          {
                            offset_minutes: 1440,
                            message: "Oi {nome}! Amanhã às {hora_agendamento} temos seu agendamento de {servico}. Confirma a presença?",
                          },
                          {
                            offset_minutes: 10,
                            message: "{nome}, em 10 min é o seu horário ({servico}). Te esperamos!",
                          },
                        ]);
                      }
                    }}
                  />
                  <span>Usar lembretes só neste agendamento</span>
                </label>

                {useCustomReminders && (
                  <div className={styles.reminderList}>
                    {customReminders.length === 0 && (
                      <p className={styles.emptyHint}>Nenhum lembrete. Este agendamento não enviará lembretes.</p>
                    )}
                    {customReminders.map((reminder, index) => (
                      <div className={styles.reminderItem} key={index}>
                        <div className={styles.reminderHeader}>
                          <div className={styles.inlineInput}>
                            <Input
                              type="number"
                              min={1}
                              max={10080}
                              value={reminder.offset_minutes}
                              onChange={(event) => setCustomReminders((current) => current.map((item, itemIndex) => (
                                itemIndex === index
                                  ? { ...item, offset_minutes: Number(event.target.value) }
                                  : item
                              )))}
                              aria-label="Minutos antes"
                            />
                            <span>min antes · {formatReminderOffset(reminder.offset_minutes)}</span>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setCustomReminders((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                            aria-label={`Remover lembrete ${index + 1}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                        <Textarea
                          value={reminder.message}
                          onChange={(event) => setCustomReminders((current) => current.map((item, itemIndex) => (
                            itemIndex === index
                              ? { ...item, message: event.target.value }
                              : item
                          )))}
                          rows={2}
                          aria-label={`Mensagem do lembrete ${index + 1}`}
                          placeholder="Use {nome}, {hora_agendamento}, {servico}, {meet_link}"
                        />
                      </div>
                    ))}
                    <div className={styles.reminderActions}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setCustomReminders((current) => [
                          ...current,
                          { offset_minutes: 60, message: "{nome}, em 1h é o seu agendamento ({servico})." },
                        ])}
                      >
                        <Plus />
                        Adicionar lembrete
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setCustomReminders((current) => [
                          ...current,
                          {
                            offset_minutes: 10,
                            message: "{nome}, em 10 min começa nossa reunião. Link: {meet_link}",
                          },
                        ])}
                      >
                        <Link2 />
                        Adicionar com Meet
                      </Button>
                    </div>
                    <p className={styles.fieldHint}>
                      Variáveis: {`{nome} {hora_agendamento} {data_agendamento} {servico} {titulo} {meet_link} {local} {telefone} {email}`}
                    </p>
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>

        <div className={styles.dialogFooter}>
          <div>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  await onDelete(editing.id);
                  onOpenChange(false);
                }}
                disabled={saving}
                className={styles.deleteButton}
              >
                <Trash2 />
                Excluir
              </Button>
            ) : null}
          </div>
          <div className={styles.footerActions}>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {editing ? "Salvar alterações" : "Criar agendamento"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
