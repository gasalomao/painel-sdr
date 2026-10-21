"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { supabase } from "@/lib/supabase";
import type { ContactCrmData, ContactCrmLead } from "@/lib/inbox/contact-crm";
import type { Contact } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Briefcase,
  Bot,
  Calendar,
  Clock,
  Bell,
  Trash2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import styles from "./inbox.module.css";

interface ReminderItem {
  offset_minutes: number;
  message: string;
}

interface AppointmentItem {
  id: string;
  client_id: string;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  reminders_sent?: string[];
  metadata?: {
    custom_reminders?: ReminderItem[];
    attendee_name?: string;
  } | null;
}

function formatOffsetLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min antes`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? "dia" : "dias"} antes`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hora" : "horas"} antes`;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${rem}min antes`;
}

function getDefaultReminderMessage(minutes: number): string {
  if (minutes === 10) {
    return "Oi {nome}! Nossa reunião começa em 10 minutos. Te aguardo!";
  }
  if (minutes === 30) {
    return "Oi {nome}! Lembrando que nossa reunião começa em 30 minutos.";
  }
  if (minutes === 60) {
    return "Oi {nome}! Passando para lembrar da nossa reunião hoje às {hora_agendamento}.";
  }
  if (minutes === 120) {
    return "Oi {nome}! Lembrando da nossa reunião hoje às {hora_agendamento}.";
  }
  if (minutes >= 1440) {
    return "Oi {nome}! Lembrete: amanhã às {hora_agendamento} temos nossa reunião agendada. Confirma sua presença?";
  }
  return "Oi {nome}! Lembrete da nossa reunião agendada para às {hora_agendamento}.";
}

function getInitialDateTime(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
}

function formatMeetingDateBR(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleString("pt-BR", {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

interface ContactSidebarProps {
  contact: Contact | null;
  clientId: string | null;
  aiAgents?: { id: number | string; name: string }[];
  onContactUpdate?: (updatedContact: Contact) => void;
  /** ID da sessão ativa (conversation.session_id). Quando fornecido,
   * busca/atualiza o agent_id DIRETO por id — evita ambiguidade quando
   * o contato tem múltiplas sessões (várias instâncias conectadas). */
  sessionId?: string;
  /** Instância ativa associada à conversa/conexão para envio WhatsApp. */
  instanceName?: string | null;
}

export function ContactSidebar(props: ContactSidebarProps): React.JSX.Element {
  const { contact, clientId } = props;
  return <ContactSidebarContent key={JSON.stringify([clientId, contact?.id, contact?.phone, contact?.remote_jid])} {...props} />;
}

function ContactSidebarContent({ contact, clientId, aiAgents = [], onContactUpdate, sessionId, instanceName }: ContactSidebarProps): React.JSX.Element {
  const mounted = useRef(false);
  const latestContact = useRef(contact);
  useEffect(() => { latestContact.current = contact; }, [contact]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [copied, setCopied] = useState(false);
  // Tags, fotos, anotações e sessão não alteram a identidade do CRM.
  const contactId = contact?.id;
  const contactPhone = contact?.phone;
  const contactJid = contact?.remote_jid;
  const persistedContactId = contactId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId) ? contactId : null;
  const crmSelection = JSON.stringify([clientId, contactId, contactPhone, contactJid]);
  const [crm, setCrm] = useState<(ContactCrmData & { selection: string }) | null>(null);
  const [crmError, setCrmError] = useState<string | null>(null);
  const [crmLoading, setCrmLoading] = useState(true);
  const [crmRetry, setCrmRetry] = useState(0);
  const [updatingLead, setUpdatingLead] = useState(false);
  const crmRequest = useRef(0);
  const leadMutation = useRef(false);
  const currentCrm = crm?.selection === crmSelection ? crm : null;
  const lead = currentCrm?.lead ?? null;
  const kanbanColumns = currentCrm?.columns ?? [];

  // Estado do Agente de IA e Instância atribuídos à sessão
  const [assignedAgentId, setAssignedAgentId] = useState<string>("");
  const [sessionInstanceName, setSessionInstanceName] = useState<string | null>(null);
  const [updatingAgent, setUpdatingAgent] = useState(false);

  // Estados de Agendamento de Reunião & Lembretes Automáticos (WhatsApp)
  const [appointments, setAppointments] = useState<AppointmentItem[]>([]);
  const [loadingAppointments, setLoadingAppointments] = useState(false);
  const [isSchedulingOpen, setIsSchedulingOpen] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState(() => getInitialDateTime());
  const [meetingDuration] = useState(60);
  const [reminders, setReminders] = useState<ReminderItem[]>([
    { offset_minutes: 60, message: "Oi {nome}! Passando para lembrar da nossa reunião hoje às {hora_agendamento}." },
    { offset_minutes: 10, message: "Oi {nome}! Nossa reunião começa em 10 minutos. Te aguardo!" },
  ]);
  const [showCustomOffset, setShowCustomOffset] = useState(false);
  const [customMinutes, setCustomMinutes] = useState(15);
  const [savingAppointment, setSavingAppointment] = useState(false);
  const [cancellingAppointmentId, setCancellingAppointmentId] = useState<string | null>(null);

  // Estados para anotações (campo notes na tabela contacts)
  const contactNotes = (contact as (Contact & { notes?: string }) | null)?.notes || "";
  const syncedNotes = useRef(contactNotes);
  const [noteText, setNoteText] = useState(contactNotes);
  const [savingNote, setSavingNote] = useState(false);
  const noteMutation = useRef(false);

  // Estado para gerenciar novas tags
  const [newTag, setNewTag] = useState("");
  const [addingTag, setAddingTag] = useState(false);
  const tagMutation = useRef(false);
  const [tagCatalog, setTagCatalog] = useState<string[]>([]);
  const [tagCatalogError, setTagCatalogError] = useState(false);
  const [tagCatalogLoading, setTagCatalogLoading] = useState(true);
  const [tagRetry, setTagRetry] = useState(0);
  const [tagSuggestionsOpen, setTagSuggestionsOpen] = useState(false);
  const tagPopup = useRef<HTMLDivElement>(null);
  const { contains: matchesTag } = Autocomplete.useFilter({ locale: "pt-BR", sensitivity: "base" });
  const availableTags = tagCatalog.filter((name) => !contact?.tags?.some((tag) => tag.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR")));

  useEffect(() => {
    if (!clientId) return;
    const controller = new AbortController();
    let active = true;
    setTagCatalogLoading(true);
    setTagCatalogError(false);
    void (async () => {
      try {
        const response = await fetch("/api/contacts/tags", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Catálogo indisponível");
        const data: { tags?: unknown } = await response.json();
        if (!Array.isArray(data.tags) || !data.tags.every((tag): tag is string => typeof tag === "string")) throw new Error("Catálogo inválido");
        if (active) setTagCatalog(data.tags);
      } catch {
        if (active) setTagCatalogError(true);
      } finally {
        if (active) setTagCatalogLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [clientId, tagRetry]);

  // Sincroniza a nota persistida sem descartar edições locais ainda não salvas.
  useEffect(() => {
    const previous = syncedNotes.current;
    syncedNotes.current = contactNotes;
    setNoteText((draft) => draft === previous ? contactNotes : draft);
  }, [contactNotes]);

  useEffect(() => {
    if (!contactId || !clientId) return;
    let active = true;
    void (async () => {
      try {
        let query = supabase.from("sessions").select("agent_id, instance_name").eq("client_id", clientId);
        query = sessionId ? query.eq("id", sessionId) : query.eq("contact_id", contactId)
          .order("last_message_at", { ascending: false, nullsFirst: false }).limit(1);
        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        if (active) {
          setAssignedAgentId(data?.agent_id ? String(data.agent_id) : "");
          if (data?.instance_name) setSessionInstanceName(data.instance_name);
        }
      } catch {
        if (active) {
          setAssignedAgentId("");
          setSessionInstanceName(null);
        }
      }
    })();
    return () => { active = false; };
  }, [contactId, clientId, sessionId]);

  // Atualiza título e data padrão quando o contato mudar
  useEffect(() => {
    if (contact) {
      const name = contact.name || contact.phone || "Lead";
      setMeetingTitle(`Reunião com ${name}`);
      setMeetingDate(getInitialDateTime());
      setReminders([
        { offset_minutes: 60, message: "Oi {nome}! Passando para lembrar da nossa reunião hoje às {hora_agendamento}." },
        { offset_minutes: 10, message: "Oi {nome}! Nossa reunião começa em 10 minutos. Te aguardo!" },
      ]);
    }
  }, [contact?.id, contact?.phone, contact?.name]);

  const leadIdRef = useRef(lead?.id);
  useEffect(() => { leadIdRef.current = lead?.id; }, [lead?.id]);

  // Consulta agendamentos confirmados do contato
  const fetchAppointments = useCallback(async () => {
    if (!clientId || (!contactJid && !contactPhone && !leadIdRef.current)) {
      setAppointments([]);
      return;
    }
    const jid = contactJid || (contactPhone ? (contactPhone.includes("@") ? contactPhone : `${contactPhone.replace(/\D/g, "")}@s.whatsapp.net`) : "");
    const params = new URLSearchParams();
    if (jid) params.set("remote_jid", jid);
    if (leadIdRef.current) params.set("lead_id", String(leadIdRef.current));
    params.set("status", "confirmed");

    try {
      setLoadingAppointments(true);
      const res = await fetch(`/api/appointments?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.appointments)) {
        setAppointments(data.appointments);
      }
    } catch {
      // Falhas secundárias de rede não bloqueiam o painel
    } finally {
      setLoadingAppointments(false);
    }
  }, [clientId, contactJid, contactPhone]);

  useEffect(() => {
    void fetchAppointments();
  }, [fetchAppointments]);

  // Próxima reunião confirmada
  const activeMeeting = appointments.find((a) => {
    if (a.status !== "confirmed") return false;
    const t = new Date(a.start_at).getTime();
    return Number.isFinite(t) && t > Date.now() - 30 * 60 * 1000;
  });

  const handleAddPresetReminder = (offsetMinutes: number) => {
    if (reminders.some((r) => r.offset_minutes === offsetMinutes)) return;
    const newRem: ReminderItem = {
      offset_minutes: offsetMinutes,
      message: getDefaultReminderMessage(offsetMinutes),
    };
    setReminders((prev) => [...prev, newRem].sort((a, b) => b.offset_minutes - a.offset_minutes));
  };

  const handleRemoveReminder = (idx: number) => {
    setReminders((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUpdateReminderMessage = (idx: number, message: string) => {
    setReminders((prev) => prev.map((r, i) => (i === idx ? { ...r, message } : r)));
  };

  const handleScheduleMeeting = async () => {
    if (!contact || !clientId) return;
    if (!meetingDate) {
      toast.error("Informe a data e horário da reunião.");
      return;
    }
    const start = new Date(meetingDate);
    if (isNaN(start.getTime()) || start.getTime() < Date.now() - 5 * 60 * 1000) {
      toast.error("Selecione um horário futuro para a reunião.");
      return;
    }
    const end = new Date(start.getTime() + meetingDuration * 60 * 1000);

    const jid = contact.remote_jid || (contact.phone ? (contact.phone.includes("@") ? contact.phone : `${contact.phone.replace(/\D/g, "")}@s.whatsapp.net`) : "");
    if (!jid) {
      toast.error("Contato sem número de WhatsApp identificado.");
      return;
    }

    const activeInstance = instanceName || sessionInstanceName || "sdr";

    const validReminders = reminders
      .filter((r) => Number.isFinite(r.offset_minutes) && r.offset_minutes > 0 && r.message?.trim())
      .map((r) => ({ offset_minutes: r.offset_minutes, message: r.message.trim() }));

    const resolvedTitle = meetingTitle.trim() || `Reunião com ${contact.name || contact.phone || "Lead"}`;

    const payload = {
      title: resolvedTitle,
      remote_jid: jid,
      instance_name: activeInstance,
      agent_id: assignedAgentId ? Number(assignedAgentId) : (aiAgents[0]?.id ? Number(aiAgents[0].id) : null),
      lead_id: lead?.id ?? null,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      service_name: resolvedTitle,
      metadata: {
        custom_reminders: validReminders,
        attendee_name: contact.name || contact.phone || "Lead",
      },
      sync_google: true,
    };

    setSavingAppointment(true);
    try {
      const res = await fetch("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Não foi possível agendar a reunião.");
      }
      toast.success(
        validReminders.length > 0
          ? `Reunião agendada! ${validReminders.length} aviso(s) automático(s) ativado(s).`
          : "Reunião agendada com sucesso!"
      );
      setIsSchedulingOpen(false);
      await fetchAppointments();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro ao agendar reunião.";
      toast.error(message);
    } finally {
      setSavingAppointment(false);
    }
  };

  const handleCancelMeeting = async (appointmentId: string) => {
    setCancellingAppointmentId(appointmentId);
    try {
      const res = await fetch(`/api/appointments/${appointmentId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Erro ao cancelar reunião");
      }
      toast.success("Reunião cancelada!");
      await fetchAppointments();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Não foi possível cancelar a reunião.";
      toast.error(message);
    } finally {
      setCancellingAppointmentId(null);
    }
  };

  useEffect(() => {
    const request = ++crmRequest.current;
    const controller = new AbortController();
    setCrmLoading(true);
    setCrmError(null);
    setUpdatingLead(false);
    leadMutation.current = false;
    if (clientId && (contactId || contactPhone || contactJid)) {
      const params = new URLSearchParams();
      if (persistedContactId) params.set("contactId", persistedContactId);
      else {
        params.set("phone", contactPhone || "");
        params.set("remote_jid", contactJid || "");
      }
      void (async () => {
        try {
          const response = await fetch(`/api/contacts/crm?${params}`, { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("Consulta indisponível");
          const data: ContactCrmData = await response.json();
          if (request === crmRequest.current) setCrm({ ...data, selection: crmSelection });
        } catch {
          if (request === crmRequest.current) setCrmError("Não foi possível consultar o CRM. Tente novamente.");
        } finally {
          if (request === crmRequest.current) setCrmLoading(false);
        }
      })();
    }
    return () => { controller.abort(); crmRequest.current = request + 1; };
  }, [contactId, persistedContactId, contactPhone, contactJid, clientId, crmSelection, crmRetry]);

  // Copiar telefone do contato
  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  // Atualizar o Agente de IA responsável por este atendimento
  const handleChangeAiAgent = useCallback(async (newAgentId: string) => {
    if (!contact || !clientId) return;
    setUpdatingAgent(true);

    try {
      const agentIdNum = newAgentId ? Number(newAgentId) : null;

      // 1. Atualiza na tabela sessions:
      //    - Se sessionId fornecido: update exato por id (sessão ativa).
      //    - Senão: update por contact_id (legado, cobre todas as sessões).
      //    Antes só havia o caminho contact_id, que bagunçava sessão errada
      //    quando o contato tinha múltiplos connects (instância velha + nova).
      let updatePromise;
      if (sessionId) {
        updatePromise = supabase
          .from("sessions")
          .update({ agent_id: agentIdNum })
          .eq("id", sessionId);
      } else {
        updatePromise = supabase
          .from("sessions")
          .update({ agent_id: agentIdNum })
          .eq("contact_id", contact.id);
      }
      const { error: sessionErr } = await updatePromise;

      if (sessionErr) throw sessionErr;

      setAssignedAgentId(newAgentId);
      toast.success(newAgentId ? "Agente de IA atribuído à conversa!" : "Atendimento sem Agente de IA atribuído.");
    } catch (err: any) {
      toast.error("Erro ao alterar Agente de IA: " + err.message);
    } finally {
      setUpdatingAgent(false);
    }
  }, [contact, clientId, sessionId]);

  // Salvar anotação direto em contacts.notes
  const handleSaveNote = async (): Promise<void> => {
    const current = latestContact.current;
    if (!current || !clientId || noteMutation.current) return;
    const savedNote = noteText.trim();
    noteMutation.current = true;
    setSavingNote(true);
    try {
      const { data, error } = await supabase.from("contacts").update({ notes: savedNote })
        .eq("id", current.id).eq("client_id", clientId).select("id").maybeSingle();
      if (error || !data) throw new Error("Contato não atualizado");
      if (!mounted.current) return;
      const updated = { ...latestContact.current!, notes: savedNote };
      latestContact.current = updated;
      syncedNotes.current = savedNote;
      setNoteText((draft) => draft === noteText ? savedNote : draft);
      onContactUpdate?.(updated);
      toast.success("Anotações salvas com sucesso!");
    } catch {
      if (mounted.current) toast.error("Não foi possível salvar as anotações.");
    } finally {
      noteMutation.current = false;
      if (mounted.current) setSavingNote(false);
    }
  };

  // A API revalida a identidade no tenant antes de criar ou vincular.
  const handleCreateLead = useCallback(async () => {
    if (!contact || !clientId || currentCrm?.state !== "missing" || crmLoading || leadMutation.current) return;
    const request = crmRequest.current;
    leadMutation.current = true;
    setUpdatingLead(true);
    try {
      const response = await fetch("/api/contacts/crm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(persistedContactId ? { contactId: persistedContactId } : { phone: contact.phone, remote_jid: contact.remote_jid, name: contact.name }),
      });
      const data: ContactCrmData = await response.json();
      if (request !== crmRequest.current) return;
      if (data.state === "ambiguous" || data.state === "unresolved") {
        setCrm({ ...data, selection: crmSelection });
        return;
      }
      if (!response.ok || !data.lead) throw new Error("Criação indisponível");
      setCrm({ ...data, selection: crmSelection });
      toast.success(data.created ? "Oportunidade criada no Kanban!" : "Lead existente vinculado ao contato.");
      const updatedContact: Contact & { lead_id: number } = { ...latestContact.current!, lead_id: data.lead.id };
      latestContact.current = updatedContact;
      onContactUpdate?.(updatedContact);
    } catch {
      if (request === crmRequest.current) setCrmError("Não foi possível confirmar o lead no CRM. Consulte novamente antes de criar.");
    } finally {
      if (request === crmRequest.current) {
        leadMutation.current = false;
        setUpdatingLead(false);
      }
    }
  }, [contact, persistedContactId, clientId, currentCrm, crmLoading, crmSelection, onContactUpdate]);

  const handleUpdateLeadStage = useCallback(async (newStage: string) => {
    if (!lead || !clientId || crmLoading || leadMutation.current) return;
    const request = crmRequest.current;
    leadMutation.current = true;
    setUpdatingLead(true);
    try {
      const response = await fetch("/api/contacts/crm", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: lead.id, status: newStage }),
      });
      if (!response.ok) throw new Error("Atualização indisponível");
      const data: { lead: ContactCrmLead } = await response.json();
      if (request !== crmRequest.current) return;
      setCrm((previous) => previous?.selection === crmSelection ? { ...previous, lead: data.lead } : previous);
      toast.success("Estágio do Kanban atualizado!");
    } catch {
      if (request === crmRequest.current) toast.error("Não foi possível atualizar o estágio do Kanban.");
    } finally {
      if (request === crmRequest.current) {
        leadMutation.current = false;
        setUpdatingLead(false);
      }
    }
  }, [lead, clientId, crmLoading, crmSelection]);

  const handleTagChange = async (value: string, remove = false): Promise<void> => {
    const current = latestContact.current;
    if (!current || !clientId || tagMutation.current || !value.trim()) return;
    const typedTag = value.trim();
    const tagName = tagCatalog.find((name) => name.toLocaleLowerCase("pt-BR") === typedTag.toLocaleLowerCase("pt-BR")) || typedTag;
    const currentTags = current.tags?.map((tag) => tag.name) || [];
    if (!remove && currentTags.some((name) => name.toLocaleLowerCase("pt-BR") === tagName.toLocaleLowerCase("pt-BR"))) {
      toast.error("Esta tag já está associada ao contato.");
      return;
    }
    const updatedTags = remove ? currentTags.filter((name) => name !== value) : [...currentTags, tagName];
    tagMutation.current = true;
    setTagSuggestionsOpen(false);
    setAddingTag(true);
    try {
      const { data, error } = await supabase.from("contacts").update({ tags: updatedTags })
        .eq("id", current.id).eq("client_id", clientId).select("id").maybeSingle();
      if (error || !data) throw new Error("Contato não atualizado");
      if (!mounted.current) return;
      const updated = {
        ...latestContact.current!,
        tags: updatedTags.map((name) => current.tags?.find((tag) => tag.name === name) || {
          id: name, name, color: "#3b82f6", user_id: clientId, created_at: new Date().toISOString(),
        }),
      };
      latestContact.current = updated;
      onContactUpdate?.(updated);
      if (!remove) {
        setNewTag("");
        setTagCatalog((previous) => [...new Set([...previous, tagName])].sort((a, b) => a.localeCompare(b, "pt-BR")));
      }
      toast.success(remove ? "Tag removida!" : "Tag adicionada!");
    } catch {
      if (mounted.current) toast.error(remove ? "Não foi possível remover a tag." : "Não foi possível adicionar a tag.");
    } finally {
      tagMutation.current = false;
      if (mounted.current) setAddingTag(false);
    }
  };

  if (!contact) {
    return (
      <div className="flex h-full w-72 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">Selecione uma conversa para ver os detalhes</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div id="chat-contact-details" className={`${styles.contact} flex h-full flex-col border-l border-border bg-card shrink-0`}>
      <div className="border-b border-border px-4 py-4">
        <h2 className="text-sm font-semibold text-foreground">Detalhes do contato</h2>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={`${styles.contactBody} space-y-5`}>
          {/* Informações Básicas */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground relative">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 max-w-full break-words text-base font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1 justify-center">
                <Briefcase className="h-3 w-3" />
                {contact.company}
              </p>
            )}
          </div>

          {/* Dados de Contato */}
          <div className="space-y-1.5">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted cursor-pointer"
              title="Clique para copiar telefone"
            >
              <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 text-left font-mono truncate">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary shrink-0" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          <hr className="border-border/60" />

          {/* Seção de Atribuição de Agente de IA */}
          <div>
            <div className={styles.contactHeading}>
              <Bot className="h-3.5 w-3.5 text-primary" />
              Agente de IA Atribuído
            </div>
            
            <div className="mt-2.5">
              <select
                aria-label="Agente de IA atribuído"
                value={assignedAgentId}
                disabled={updatingAgent}
                onChange={(e) => handleChangeAiAgent(e.target.value)}
                className="w-full text-xs bg-muted border border-border/80 rounded-md p-2 text-foreground focus:outline-none focus:border-primary/50 cursor-pointer font-medium"
              >
                <option value="">Nenhum agente (Usar padrão da conexão)</option>
                {aiAgents.map((ag) => (
                  <option key={ag.id} value={String(ag.id)}>
                    {ag.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <hr className="border-border/60" />

          {/* Seção do Kanban (Leads CRM) */}
          <div>
            <div className={styles.contactHeading}>
              <DollarSign className="h-3.5 w-3.5" />
              Oportunidade CRM (Kanban)
            </div>
            
            <div className="mt-3" aria-live="polite" aria-busy={crmLoading}>
              {crmLoading ? (
                <p className="text-xs text-muted-foreground" role="status">Consultando CRM...</p>
              ) : crmError ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground" role="alert">{crmError}</p>
                  <Button size="sm" onClick={() => setCrmRetry((value) => value + 1)}>Tentar novamente</Button>
                </div>
              ) : lead ? (
                <div className="rounded-lg bg-muted p-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      {lead.nome_negocio || "Lead Sem Nome"}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Criado em: {lead.created_at ? new Date(lead.created_at).toLocaleDateString("pt-BR") : "Não informado"}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="chat-lead-stage" className="text-xs font-medium text-muted-foreground block">
                      Estágio no Funil
                    </label>
                    <select
                      id="chat-lead-stage"
                      value={lead.status ?? ""}
                      disabled={updatingLead || crmLoading}
                      onChange={(e) => handleUpdateLeadStage(e.target.value)}
                      className="w-full text-xs bg-card border border-border/80 rounded-md p-1.5 text-foreground focus:outline-none focus:border-primary/50"
                    >
                      {!kanbanColumns.some((col) => col.status_key === lead.status) && (
                        <option value={lead.status ?? ""}>{lead.status || "Sem etapa definida"}</option>
                      )}
                      {kanbanColumns.map((col) => (
                        <option key={col.status_key} value={col.status_key}>
                          {col.label} {col.is_terminal ? "🔒" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : currentCrm?.state === "ambiguous" ? (
                <p className="text-xs text-muted-foreground" role="status">Mais de um lead corresponde a este contato. Confira os cadastros no Kanban antes de vincular.</p>
              ) : currentCrm?.state !== "missing" ? (
                <p className="text-xs text-muted-foreground" role="status">Não foi possível identificar este contato no CRM com segurança.</p>
              ) : (
                <div className="text-center py-2">
                  <p className="text-xs text-muted-foreground mb-2">Este contato não está cadastrado como Lead.</p>
                  <Button
                    size="sm"
                    className="w-full text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/95 cursor-pointer"
                    onClick={handleCreateLead}
                    disabled={updatingLead || kanbanColumns.length === 0}
                  >
                    Criar Lead no Kanban
                  </Button>
                </div>
              )}
            </div>
          </div>

          <hr className="border-border/60" />

          {/* Seção de Reunião & Lembretes Automáticos */}
          <div>
            <div className={styles.contactHeading}>
              <Calendar className="h-3.5 w-3.5 text-primary" />
              Reunião & Lembretes
            </div>

            <div className="mt-3 space-y-2.5">
              {loadingAppointments && appointments.length === 0 ? (
                <p className="text-xs text-muted-foreground" role="status">
                  Consultando agendamentos...
                </p>
              ) : activeMeeting && !isSchedulingOpen ? (
                /* Card de Reunião Confirmada */
                <div className="rounded-lg bg-emerald-500/[0.04] border border-emerald-500/20 p-3 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
                          <Check className="h-2.5 w-2.5" />
                          Reunião Confirmada
                        </span>
                      </div>
                      <p className="text-xs font-semibold text-foreground mt-1.5 break-words">
                        {activeMeeting.title}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-foreground/90 font-medium bg-muted/60 rounded-md px-2.5 py-1.5 border border-border/60">
                    <Clock className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span>{formatMeetingDateBR(activeMeeting.start_at)}</span>
                  </div>

                  {/* Lembretes Configurados */}
                  <div className="space-y-1">
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Bell className="h-2.5 w-2.5 text-primary" />
                      Avisos automáticos (WhatsApp):
                    </span>
                    {activeMeeting.metadata?.custom_reminders && activeMeeting.metadata.custom_reminders.length > 0 ? (
                      <div className="space-y-1">
                        {activeMeeting.metadata.custom_reminders.map((rem, idx) => {
                          const sent = activeMeeting.reminders_sent?.includes(`${rem.offset_minutes}min`);
                          return (
                            <div
                              key={idx}
                              className="flex items-center justify-between text-[11px] rounded bg-muted/40 px-2 py-1 border border-border/40"
                            >
                              <span className="text-muted-foreground">
                                {formatOffsetLabel(rem.offset_minutes)}
                              </span>
                              {sent ? (
                                <span className="text-[10px] font-medium text-emerald-400 flex items-center gap-0.5">
                                  <Check className="h-2.5 w-2.5" /> Enviado
                                </span>
                              ) : (
                                <span className="text-[10px] text-amber-400/90 flex items-center gap-0.5">
                                  <Clock className="h-2.5 w-2.5" /> Agendado
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[10px] text-muted-foreground italic">
                        Sem avisos automáticos customizados.
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-compact="true"
                      className="flex-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 border-red-500/20 cursor-pointer"
                      onClick={() => handleCancelMeeting(activeMeeting.id)}
                      disabled={cancellingAppointmentId === activeMeeting.id}
                    >
                      {cancellingAppointmentId === activeMeeting.id ? "Cancelando..." : "Cancelar Reunião"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-compact="true"
                      className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                      onClick={() => setIsSchedulingOpen(true)}
                    >
                      + Nova
                    </Button>
                  </div>
                </div>
              ) : !isSchedulingOpen ? (
                /* Botão para abrir o formulário quando não há reunião */
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full text-xs font-medium border-border/80 hover:bg-muted cursor-pointer flex items-center justify-center gap-1.5"
                  onClick={() => setIsSchedulingOpen(true)}
                >
                  <Calendar className="h-3.5 w-3.5 text-primary" />
                  Agendar Reunião com Lead
                </Button>
              ) : (
                /* Formulário de Agendamento */
                <div className="rounded-lg bg-muted/40 border border-border/80 p-3 space-y-3">
                  <div>
                    <label htmlFor="meeting-title-input" className="text-[11px] font-medium text-muted-foreground block mb-1">
                      Assunto / Título
                    </label>
                    <input
                      id="meeting-title-input"
                      type="text"
                      value={meetingTitle}
                      onChange={(e) => setMeetingTitle(e.target.value)}
                      placeholder="Ex: Reunião de Apresentação"
                      className="w-full text-xs bg-card border border-border/80 rounded-md px-2.5 py-1.5 text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary/50"
                    />
                  </div>

                  <div>
                    <label htmlFor="meeting-datetime-input" className="text-[11px] font-medium text-muted-foreground block mb-1">
                      Data e Horário
                    </label>
                    <input
                      id="meeting-datetime-input"
                      type="datetime-local"
                      value={meetingDate}
                      onChange={(e) => setMeetingDate(e.target.value)}
                      min={new Date().toISOString().slice(0, 16)}
                      className="w-full text-xs bg-card border border-border/80 rounded-md px-2.5 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                    />
                  </div>

                  {/* Lembretes WhatsApp */}
                  <div className="space-y-2 pt-1 border-t border-border/50">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                        <Bell className="h-3 w-3 text-primary" />
                        Avisos WhatsApp Automáticos
                      </span>
                      <span className="text-[10px] text-muted-foreground/70">
                        {reminders.length} {reminders.length === 1 ? "aviso" : "avisos"}
                      </span>
                    </div>

                    {/* Chips de adição rápida */}
                    <div className="flex flex-wrap items-center gap-1">
                      {[
                        { label: "+ 10 min", min: 10 },
                        { label: "+ 30 min", min: 30 },
                        { label: "+ 1h", min: 60 },
                        { label: "+ 2h", min: 120 },
                        { label: "+ 1 dia", min: 1440 },
                      ].map((chip) => {
                        const added = reminders.some((r) => r.offset_minutes === chip.min);
                        return (
                          <button
                            key={chip.min}
                            type="button"
                            data-compact="true"
                            onClick={() => handleAddPresetReminder(chip.min)}
                            disabled={added}
                            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
                              added
                                ? "bg-muted text-muted-foreground/40 border-border/30 cursor-not-allowed"
                                : "bg-card text-foreground border-border/70 hover:bg-primary/10 hover:border-primary/40 hover:text-primary"
                            }`}
                          >
                            {chip.label}
                          </button>
                        );
                      })}
                    </div>

                    {/* Lista de lembretes configurados */}
                    {reminders.length === 0 ? (
                      <p className="text-[10px] text-muted-foreground/70 italic py-1">
                        Nenhum aviso configurado. Use os botões acima para adicionar.
                      </p>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                        {reminders.map((rem, idx) => (
                          <div
                            key={idx}
                            className="rounded-md border border-border/70 bg-card p-2 space-y-1.5 text-xs"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-primary text-[11px] flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {formatOffsetLabel(rem.offset_minutes)}
                              </span>
                              <button
                                type="button"
                                data-compact="true"
                                onClick={() => handleRemoveReminder(idx)}
                                className="text-muted-foreground hover:text-red-400 p-0.5 cursor-pointer"
                                aria-label={`Remover aviso de ${formatOffsetLabel(rem.offset_minutes)}`}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                            <textarea
                              value={rem.message}
                              onChange={(e) => handleUpdateReminderMessage(idx, e.target.value)}
                              rows={2}
                              aria-label={`Mensagem do aviso de ${formatOffsetLabel(rem.offset_minutes)}`}
                              placeholder="Mensagem do aviso..."
                              className="w-full resize-none rounded border border-border/60 bg-muted/60 p-1.5 text-[11px] text-foreground placeholder-muted-foreground/70 outline-none focus:border-primary/50"
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Outro horário customizado */}
                    {showCustomOffset ? (
                      <div className="flex items-center gap-1.5 pt-1">
                        <input
                          type="number"
                          min={1}
                          max={10080}
                          value={customMinutes}
                          onChange={(e) => setCustomMinutes(Math.max(1, Number(e.target.value)))}
                          className="w-16 rounded border border-border bg-card px-2 py-0.5 text-xs text-foreground outline-none"
                          placeholder="Min"
                        />
                        <span className="text-[10px] text-muted-foreground">min antes</span>
                        <button
                          type="button"
                          data-compact="true"
                          onClick={() => {
                            if (customMinutes > 0) {
                              handleAddPresetReminder(customMinutes);
                              setShowCustomOffset(false);
                            }
                          }}
                          className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer font-medium"
                        >
                          Adicionar
                        </button>
                        <button
                          type="button"
                          data-compact="true"
                          onClick={() => setShowCustomOffset(false)}
                          className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-compact="true"
                        onClick={() => setShowCustomOffset(true)}
                        className="text-[10px] text-primary hover:underline cursor-pointer flex items-center gap-0.5"
                      >
                        + Outro horário
                      </button>
                    )}

                    <p className="text-[10px] text-muted-foreground/70 leading-tight">
                      Tags: <code className="text-primary">{`{nome}`}</code>, <code className="text-primary">{`{hora_agendamento}`}</code>, <code className="text-primary">{`{data_agendamento}`}</code>
                    </p>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      className="flex-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
                      onClick={handleScheduleMeeting}
                      disabled={savingAppointment || !meetingDate}
                    >
                      {savingAppointment ? "Agendando..." : "Agendar e Ativar Avisos"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                      onClick={() => setIsSchedulingOpen(false)}
                      disabled={savingAppointment}
                    >
                      Fechar
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <hr className="border-border/60" />

          {/* Seção de Tags */}
          <div>
            <div className={styles.contactHeading}>
              <TagIcon className="h-3.5 w-3.5" />
              Tags do Contato
            </div>

            <form onSubmit={(event) => { event.preventDefault(); void handleTagChange(newTag); }} className="mt-3 flex gap-1.5">
              <Autocomplete.Root
                items={availableTags}
                filter={matchesTag}
                open={tagSuggestionsOpen && availableTags.some((name) => matchesTag(name, newTag.trim()))}
                onOpenChange={setTagSuggestionsOpen}
                value={newTag}
                onValueChange={(value, details) => {
                  setNewTag(value);
                  if (details.reason === "item-press") void handleTagChange(value);
                }}
                disabled={addingTag || !clientId}
              >
                <Autocomplete.Input
                  placeholder="Buscar ou criar tag..."
                  aria-label="Nova tag do contato"
                  onBlur={(event) => {
                    if (!(event.relatedTarget instanceof Node) || !tagPopup.current?.contains(event.relatedTarget)) setTagSuggestionsOpen(false);
                  }}
                  className="min-w-0 flex-1 rounded-md border border-border/80 bg-muted px-2.5 py-1 text-xs text-foreground placeholder-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Autocomplete.Portal>
                  <Autocomplete.Positioner sideOffset={4} className={`${styles.portal} z-50`}>
                    <Autocomplete.Popup ref={tagPopup} className="w-[var(--anchor-width)] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                      <Autocomplete.List className="max-h-48 overflow-y-auto" aria-label="Tags existentes">
                        {(name: string) => <Autocomplete.Item key={name} value={name} className="cursor-pointer break-words rounded px-2 py-2 text-xs data-highlighted:bg-accent data-highlighted:text-accent-foreground">{name}</Autocomplete.Item>}
                      </Autocomplete.List>
                    </Autocomplete.Popup>
                  </Autocomplete.Positioner>
                </Autocomplete.Portal>
              </Autocomplete.Root>
              <Button
                type="submit"
                aria-label="Adicionar tag"
                size="sm"
                className="h-auto bg-primary px-2.5 hover:bg-primary/90 shrink-0 cursor-pointer"
                disabled={!newTag.trim() || addingTag}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </form>
            {tagCatalogLoading && <p className="mt-1 text-xs text-muted-foreground" role="status">Carregando tags...</p>}
            {tagCatalogError && <div className="mt-1 text-xs text-muted-foreground" role="status">
              Não foi possível carregar as sugestões. <button type="button" className="underline focus-visible:outline-2" onClick={() => setTagRetry((value) => value + 1)}>Recarregar tags</button>
            </div>}

            <div className="mt-3 flex flex-wrap gap-1">
              {(!contact.tags || contact.tags.length === 0) ? (
                <p className="px-1 text-xs text-muted-foreground">Sem tags associadas.</p>
              ) : (
                contact.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary"
                  >
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => void handleTagChange(tag.name, true)}
                      aria-label={`Remover tag ${tag.name}`}
                      disabled={addingTag}
                      className="text-primary hover:text-red-500 transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))
              )}
            </div>
          </div>

          <hr className="border-border/60" />

          {/* Seção de Anotações */}
          <div>
            <div className={styles.contactHeading}>
              <StickyNote className="h-3.5 w-3.5" />
              Anotações do Contato
            </div>
            
            <div className="mt-3 space-y-2">
              <textarea
                aria-label="Anotações do contato"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Escreva anotações importantes sobre as negociações com este lead..."
                rows={4}
                className="w-full resize-none rounded-lg border border-border bg-muted p-2.5 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
              />
              
              <Button
                size="sm"
                className="w-full bg-primary text-xs font-medium hover:bg-primary/90 cursor-pointer"
                onClick={handleSaveNote}
                disabled={savingNote}
              >
                Salvar Anotações
              </Button>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function X({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2.5}
      stroke="currentColor"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}
