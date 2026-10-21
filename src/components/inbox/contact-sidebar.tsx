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
  Bot
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import styles from "./inbox.module.css";

interface ContactSidebarProps {
  contact: Contact | null;
  clientId: string | null;
  aiAgents?: { id: number | string; name: string }[];
  onContactUpdate?: (updatedContact: Contact) => void;
  /** ID da sessão ativa (conversation.session_id). Quando fornecido,
   * busca/atualiza o agent_id DIRETO por id — evita ambiguidade quando
   * o contato tem múltiplas sessões (várias instâncias conectadas). */
  sessionId?: string;
}

export function ContactSidebar(props: ContactSidebarProps): React.JSX.Element {
  const { contact, clientId } = props;
  return <ContactSidebarContent key={JSON.stringify([clientId, contact?.id, contact?.phone, contact?.remote_jid])} {...props} />;
}

function ContactSidebarContent({ contact, clientId, aiAgents = [], onContactUpdate, sessionId }: ContactSidebarProps): React.JSX.Element {
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

  // Estado do Agente de IA atribuído à sessão
  const [assignedAgentId, setAssignedAgentId] = useState<string>("");
  const [updatingAgent, setUpdatingAgent] = useState(false);

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
        let query = supabase.from("sessions").select("agent_id").eq("client_id", clientId);
        query = sessionId ? query.eq("id", sessionId) : query.eq("contact_id", contactId)
          .order("last_message_at", { ascending: false, nullsFirst: false }).limit(1);
        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        if (active) setAssignedAgentId(data?.agent_id ? String(data.agent_id) : "");
      } catch {
        if (active) setAssignedAgentId("");
      }
    })();
    return () => { active = false; };
  }, [contactId, clientId, sessionId]);

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
