"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
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

interface ContactSidebarProps {
  contact: Contact | null;
  clientId: string | null;
  aiAgents?: { id: number | string; name: string }[];
  onContactUpdate?: (updatedContact: Contact) => void;
}

export function ContactSidebar({ contact, clientId, aiAgents = [], onContactUpdate }: ContactSidebarProps) {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  
  // Estados para integração com Kanban (leads_extraidos) do Painel-SDR
  const [lead, setLead] = useState<any | null>(null);
  const [kanbanColumns, setKanbanColumns] = useState<any[]>([]);
  const [updatingLead, setUpdatingLead] = useState(false);

  // Estado do Agente de IA atribuído à sessão
  const [assignedAgentId, setAssignedAgentId] = useState<string>("");
  const [updatingAgent, setUpdatingAgent] = useState(false);

  // Estados para anotações (campo notes na tabela contacts)
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // Estado para gerenciar novas tags
  const [newTag, setNewTag] = useState("");
  const [addingTag, setAddingTag] = useState(false);

  // Carrega as informações do Lead, Agente de IA e colunas do Kanban
  const fetchLeadAndKanbanData = useCallback(async () => {
    if (!contact || !clientId) return;
    setLoading(true);

    try {
      // 1. Busca as colunas do Kanban configuradas
      const { data: cols } = await supabase
        .from("kanban_columns")
        .select("*")
        .eq("client_id", clientId)
        .order("order_index", { ascending: true });
      if (cols) setKanbanColumns(cols);

      // 2. Busca o Agente de IA atribuído na tabela sessions
      const { data: sessionData } = await supabase
        .from("sessions")
        .select("agent_id")
        .eq("contact_id", contact.id)
        .maybeSingle();

      if (sessionData?.agent_id) {
        setAssignedAgentId(String(sessionData.agent_id));
      } else {
        setAssignedAgentId("");
      }

      // 3. Busca os dados do lead vinculados a este contato (se houver lead_id ou via telefone)
      let query = supabase.from("leads_extraidos").select("*").eq("client_id", clientId);
      
      const rawContact = contact as any;
      if (rawContact.lead_id) {
        query = query.eq("id", rawContact.lead_id);
      } else {
        // Fallback por telefone
        const phoneClean = contact.phone ? contact.phone.replace(/\D/g, "") : "";
        query = query.eq("telefone", phoneClean);
      }

      const { data: leadData } = await query.maybeSingle();
      if (leadData) {
        setLead(leadData);
        if (!rawContact.lead_id) {
          await supabase
            .from("contacts")
            .update({ lead_id: leadData.id })
            .eq("id", contact.id);
        }
      } else {
        setLead(null);
      }
      
      // Carrega a anotação atual do contato
      setNoteText(rawContact.notes || "");
    } catch (err) {
      console.error("Erro ao carregar dados do contato:", err);
    } finally {
      setLoading(false);
    }
  }, [contact, clientId]);

  useEffect(() => {
    fetchLeadAndKanbanData();
  }, [fetchLeadAndKanbanData]);

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
      
      // 1. Atualiza na tabela sessions
      const { error: sessionErr } = await supabase
        .from("sessions")
        .update({ agent_id: agentIdNum })
        .eq("contact_id", contact.id);

      if (sessionErr) throw sessionErr;

      setAssignedAgentId(newAgentId);
      toast.success(newAgentId ? "Agente de IA atribuído à conversa!" : "Atendimento sem Agente de IA atribuído.");
    } catch (err: any) {
      toast.error("Erro ao alterar Agente de IA: " + err.message);
    } finally {
      setUpdatingAgent(false);
    }
  }, [contact, clientId]);

  // Salvar anotação direto em contacts.notes
  const handleSaveNote = useCallback(async () => {
    if (!contact) return;
    setSavingNote(true);

    try {
      const { error } = await supabase
        .from("contacts")
        .update({ notes: noteText.trim() })
        .eq("id", contact.id);

      if (error) throw error;

      toast.success("Anotações salvas com sucesso!");
      if (onContactUpdate) {
        onContactUpdate({
          ...contact,
          notes: noteText.trim()
        } as any);
      }
    } catch (err: any) {
      toast.error("Erro ao salvar anotações: " + err.message);
    } finally {
      setSavingNote(false);
    }
  }, [contact, noteText, onContactUpdate]);

  // Criar nova oportunidade no Kanban para este contato
  const handleCreateLead = useCallback(async () => {
    if (!contact || !clientId) return;
    setUpdatingLead(true);

    try {
      const firstColumn = kanbanColumns[0]?.status_key || "novo";
      const cleanPhone = contact.phone ? contact.phone.replace(/\D/g, "") : "";

      const newLeadPayload = {
        client_id: clientId,
        nome_negocio: contact.name || "Lead WhatsApp",
        telefone: cleanPhone,
        status: firstColumn,
        remoteJid: (contact as any).remote_jid || `${cleanPhone}@s.whatsapp.net`,
        primeiro_contato_at: new Date().toISOString(),
        primeiro_contato_source: "whatsapp_chat"
      };

      const { data: newLead, error } = await supabase
        .from("leads_extraidos")
        .insert(newLeadPayload)
        .select()
        .single();

      if (error) throw error;

      await supabase
        .from("contacts")
        .update({ lead_id: newLead.id })
        .eq("id", contact.id);

      setLead(newLead);
      toast.success("Oportunidade criada no Kanban!");
      
      if (onContactUpdate) {
        onContactUpdate({
          ...contact,
          lead_id: newLead.id
        } as any);
      }
    } catch (err: any) {
      toast.error("Erro ao criar lead: " + err.message);
    } finally {
      setUpdatingLead(false);
    }
  }, [contact, clientId, kanbanColumns, onContactUpdate]);

  // Atualizar estágio do lead no Kanban
  const handleUpdateLeadStage = useCallback(async (newStage: string) => {
    if (!lead) return;
    setUpdatingLead(true);

    try {
      const { error } = await supabase
        .from("leads_extraidos")
        .update({ status: newStage })
        .eq("id", lead.id);

      if (error) throw error;

      setLead((prev: any) => ({ ...prev, status: newStage }));
      toast.success("Estágio do Kanban atualizado!");
    } catch (err: any) {
      toast.error("Erro ao atualizar estágio: " + err.message);
    } finally {
      setUpdatingLead(false);
    }
  }, [lead]);

  // Adicionar Tag ao Contato
  const handleAddTag = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contact || !newTag.trim()) return;
    setAddingTag(true);

    const tagToAdd = newTag.trim();
    const currentTags = contact.tags?.map(t => t.name) || [];
    if (currentTags.includes(tagToAdd)) {
      toast.error("Esta tag já está associada ao contato.");
      setAddingTag(false);
      return;
    }

    const updatedTags = [...currentTags, tagToAdd];

    try {
      const { error } = await supabase
        .from("contacts")
        .update({ tags: updatedTags })
        .eq("id", contact.id);

      if (error) throw error;

      toast.success("Tag adicionada!");
      setNewTag("");
      if (onContactUpdate) {
        onContactUpdate({
          ...contact,
          tags: updatedTags.map(name => ({
            id: name,
            name,
            color: "#3b82f6",
            user_id: clientId || "",
            created_at: new Date().toISOString()
          }))
        });
      }
    } catch (err: any) {
      toast.error("Erro ao adicionar tag: " + err.message);
    } finally {
      setAddingTag(false);
    }
  }, [contact, newTag, clientId, onContactUpdate]);

  // Remover Tag do Contato
  const handleRemoveTag = useCallback(async (tagName: string) => {
    if (!contact) return;

    const currentTags = contact.tags?.map(t => t.name) || [];
    const updatedTags = currentTags.filter(t => t !== tagName);

    try {
      const { error } = await supabase
        .from("contacts")
        .update({ tags: updatedTags })
        .eq("id", contact.id);

      if (error) throw error;

      toast.success("Tag removida!");
      if (onContactUpdate) {
        onContactUpdate({
          ...contact,
          tags: updatedTags.map(name => ({
            id: name,
            name,
            color: "#3b82f6",
            user_id: clientId || "",
            created_at: new Date().toISOString()
          }))
        });
      }
    } catch (err: any) {
      toast.error("Erro ao remover tag: " + err.message);
    }
  }, [contact, clientId, onContactUpdate]);

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
    <div className="flex h-full w-72 flex-col border-l border-border bg-card shrink-0">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
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
            <h3 className="mt-3 text-sm font-semibold text-foreground">
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
            <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Bot className="h-3.5 w-3.5 text-primary" />
              Agente de IA Atribuído
            </div>
            
            <div className="mt-2.5">
              <select
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
            <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5" />
              Oportunidade CRM (Kanban)
            </div>
            
            <div className="mt-3">
              {lead ? (
                <div className="rounded-lg bg-muted p-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      {lead.nome_negocio || "Lead Sem Nome"}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Criado em: {new Date(lead.created_at).toLocaleDateString("pt-BR")}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-muted-foreground block">
                      Estágio no Funil
                    </label>
                    <select
                      value={lead.status}
                      disabled={updatingLead}
                      onChange={(e) => handleUpdateLeadStage(e.target.value)}
                      className="w-full text-xs bg-card border border-border/80 rounded-md p-1.5 text-foreground focus:outline-none focus:border-primary/50"
                    >
                      {kanbanColumns.map((col) => (
                        <option key={col.id} value={col.status_key}>
                          {col.label} {col.is_terminal ? "🔒" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
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
            <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3.5 w-3.5" />
              Tags do Contato
            </div>

            <form onSubmit={handleAddTag} className="mt-3 flex gap-1.5">
              <input
                type="text"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="Nova tag..."
                disabled={addingTag}
                className="flex-1 rounded-md border border-border/80 bg-muted px-2.5 py-1 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
              />
              <Button
                type="submit"
                size="sm"
                className="h-auto bg-primary px-2.5 hover:bg-primary/90 shrink-0 cursor-pointer"
                disabled={!newTag.trim() || addingTag}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </form>

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
                      onClick={() => handleRemoveTag(tag.name)}
                      className="text-primary hover:text-red-500 transition-colors cursor-pointer"
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
            <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3.5 w-3.5" />
              Anotações do Contato
            </div>
            
            <div className="mt-3 space-y-2">
              <textarea
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
