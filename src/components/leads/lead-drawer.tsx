"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  MessageSquare,
  MapPin,
  Calendar,
  Clock,
  Copy,
  CheckCircle2,
  AlertCircle,
  Save,
  Loader2,
  Sparkles,
  Globe,
  Trash2,
  RotateCw,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { LeadAvatar } from "@/components/leads/lead-avatar";
import { getPhotoJid } from "@/lib/whatsapp-photo-utils";
import { downloadLeadMapsKit } from "@/lib/lead-maps-kit-client";

function formatPhoneNumber(phoneOrJid?: string | null): string {
  if (!phoneOrJid) return "—";
  const num = phoneOrJid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
  if (num.length >= 12) {
    return `+${num.slice(0, 2)} (${num.slice(2, 4)}) ${num.slice(4, 9)}-${num.slice(9)}`;
  }
  return phoneOrJid;
}

export interface LeadDrawerData {
  id: string | number;
  nome_negocio: string;
  telefone?: string | null;
  email?: string | null;
  ramo_negocio?: string | null;
  categoria?: string | null;
  endereco?: string | null;
  website?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  maps_url?: string | null;
  avaliacao?: number | null;
  reviews?: number | null;
  status?: string | null;
  remoteJid?: string | null;
  instance_name?: string | null;
  observacoes?: string | null;
  next_follow_up?: string | null;
  lembrete_texto?: string | null;
  business_details?: { lembrete_texto?: string | null } | null;
  resumo_ia?: string | null;
  profilePicUrl?: string | null;
}

interface LeadDrawerProps {
  lead: LeadDrawerData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLeadUpdated?: (updatedLead: Partial<LeadDrawerData> & { id: string | number }) => void;
  onDelete?: (lead: LeadDrawerData) => void;
  extraContent?: React.ReactNode;
  defaultTab?: "overview" | "notes" | "reminders";
}

export function LeadDrawer({
  lead,
  open,
  onOpenChange,
  onLeadUpdated,
  onDelete,
  extraContent,
  defaultTab = "overview",
}: LeadDrawerProps) {
  const [activeTab, setActiveTab] = useState<string>(defaultTab);
  const [observacoes, setObservacoes] = useState<string>("");
  const [nextFollowUp, setNextFollowUp] = useState<string>("");
  const [lembreteTexto, setLembreteTexto] = useState<string>("");
  const [savingNotes, setSavingNotes] = useState<boolean>(false);
  const [savingReminder, setSavingReminder] = useState<boolean>(false);
  const [syncingPhoto, setSyncingPhoto] = useState<boolean>(false);
  const [downloadingKit, setDownloadingKit] = useState<boolean>(false);
  const [profilePic, setProfilePic] = useState<string | null>(null);
  const edited = useRef({ notes: false, text: false, due: false });
  const generation = useRef(0);
  // Atualizar o mesmo lead não reinicializa rascunhos nem invalida saves pendentes.
  const leadRef = useRef(lead);
  const leadId = lead?.id;

  useEffect(() => { leadRef.current = lead; }, [lead]);

  // Sincroniza foto caso URL mude no mesmo lead (ex: via sync em lote) sem reiniciar rascunhos
  useEffect(() => {
    if (lead?.profilePicUrl !== undefined) {
      setProfilePic(lead.profilePicUrl || null);
    }
  }, [lead?.id, lead?.profilePicUrl]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const lead = leadRef.current;
    edited.current = { notes: false, text: false, due: false };
    setSavingNotes(false);
    setSavingReminder(false);
    setSyncingPhoto(false);
    setDownloadingKit(false);
    if (lead && open) {
      setObservacoes(lead.observacoes || "");
      setLembreteTexto(lead.next_follow_up ? (lead.lembrete_texto ?? lead.business_details?.lembrete_texto ?? lead.observacoes ?? "") : "");
      if (lead.next_follow_up) {
        try {
          const d = new Date(lead.next_follow_up);
          const pad = (n: number) => String(n).padStart(2, "0");
          const localStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          setNextFollowUp(localStr);
        } catch {
          setNextFollowUp("");
        }
      } else {
        setNextFollowUp("");
      }
      setProfilePic(lead.profilePicUrl || null);

      // Carrega dados frescos via GET /api/leads/[id]/crm
      fetch(`/api/leads/${lead.id}/crm`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (generation.current !== currentGeneration) return;
          if (data?.lead) {
            if (!edited.current.notes) setObservacoes(data.lead.observacoes || "");
            if (!edited.current.due) {
              if (data.lead.next_follow_up) {
                const d = new Date(data.lead.next_follow_up);
                const pad = (n: number) => String(n).padStart(2, "0");
                const localStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                setNextFollowUp(localStr);
              } else {
                setNextFollowUp("");
              }
            }
          }
          if (!edited.current.text) {
            if (typeof data?.lembrete_texto === "string") {
              setLembreteTexto(data.lembrete_texto);
            } else if (typeof data?.lead?.lembrete_texto === "string") {
              setLembreteTexto(data.lead.lembrete_texto);
            }
          }
          if (data?.profilePicUrl) {
            setProfilePic(data.profilePicUrl);
          }
        })
        .catch(() => {});
    }
    return () => { generation.current = currentGeneration + 1; };
  }, [leadId, open]);

  if (!lead) return null;

  const handleCopyPhone = () => {
    if (!lead.telefone) return;
    navigator.clipboard.writeText(lead.telefone);
    toast.success("Telefone copiado para a área de transferência");
  };

  const handleRefreshPhoto = async () => {
    if (!lead) return;
    const currentGeneration = generation.current;
    const jid = getPhotoJid(lead.remoteJid) ?? getPhotoJid(lead.telefone);
    if (!jid) {
      toast.error("Lead sem telefone ou JID válido para buscar foto.");
      return;
    }
    setSyncingPhoto(true);
    try {
      const res = await fetch("/api/contacts/avatars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jids: [jid],
          force: true,
          instance: lead.instance_name || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (generation.current !== currentGeneration) return;

      if (!res.ok || data.failed > 0) {
        const errorMsg = data.error || "Não foi possível atualizar a foto do WhatsApp.";
        toast.error(errorMsg);
        return;
      }

      const freshUrl = data.avatars?.[jid] ?? null;
      if (!freshUrl) {
        setProfilePic(null);
        toast.info("Contato não possui foto pública no WhatsApp.");
        onLeadUpdated?.({ id: lead.id, profilePicUrl: null });
      } else {
        setProfilePic(freshUrl);
        if (data.noPhoto > 0) {
          toast.info("Contato não possui foto pública no WhatsApp. Foto anterior preservada.");
        } else {
          toast.success("Foto do WhatsApp atualizada!");
        }
        onLeadUpdated?.({ id: lead.id, profilePicUrl: freshUrl });
      }
    } catch (err: unknown) {
      if (generation.current === currentGeneration) {
        toast.error(err instanceof Error ? err.message : "Erro ao atualizar foto.");
      }
    } finally {
      if (generation.current === currentGeneration) {
        setSyncingPhoto(false);
      }
    }
  };

  const handleSaveNotes = async () => {
    const currentGeneration = generation.current;
    edited.current.notes = true;
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/crm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observacoes }),
      });
      const data = await res.json();
      if (generation.current !== currentGeneration) return;
      if (!res.ok) throw new Error(data.error || "Falha ao salvar anotações");

      toast.success("Anotações salvas com sucesso!");
      onLeadUpdated?.({ id: lead.id, observacoes });
    } catch (err: unknown) {
      if (generation.current === currentGeneration) toast.error(err instanceof Error ? err.message : "Erro ao salvar anotações");
    } finally {
      if (generation.current === currentGeneration) setSavingNotes(false);
    }
  };

  const handleSaveReminder = async () => {
    const currentGeneration = generation.current;
    edited.current.text = true;
    edited.current.due = true;
    if (!nextFollowUp || !lembreteTexto.trim()) {
      toast.error("Descreva o lembrete e selecione o vencimento");
      return;
    }
    setSavingReminder(true);
    try {
      const isoDate = new Date(nextFollowUp).toISOString();
      const res = await fetch(`/api/leads/${lead.id}/crm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          next_follow_up: isoDate,
          lembrete_texto: lembreteTexto,
        }),
      });
      const data = await res.json();
      if (generation.current !== currentGeneration) return;
      if (!res.ok) throw new Error(data.error || "Falha ao agendar retorno");

      toast.success("Lembrete agendado com sucesso!");
      onLeadUpdated?.({
        id: lead.id,
        next_follow_up: isoDate,
        lembrete_texto: lembreteTexto,
      });
    } catch (err: unknown) {
      if (generation.current === currentGeneration) toast.error(err instanceof Error ? err.message : "Erro ao salvar lembrete");
    } finally {
      if (generation.current === currentGeneration) setSavingReminder(false);
    }
  };

  const handleClearReminder = async () => {
    const currentGeneration = generation.current;
    edited.current.text = true;
    edited.current.due = true;
    setSavingReminder(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/crm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ next_follow_up: null }),
      });
      const data = await res.json();
      if (generation.current !== currentGeneration) return;
      if (!res.ok) throw new Error(data.error || "Falha ao concluir lembrete");

      setNextFollowUp("");
      setLembreteTexto("");
      toast.success("Lembrete concluído!");
      onLeadUpdated?.({ id: lead.id, next_follow_up: null, lembrete_texto: null });
    } catch (err: unknown) {
      if (generation.current === currentGeneration) toast.error(err instanceof Error ? err.message : "Erro ao concluir lembrete");
    } finally {
      if (generation.current === currentGeneration) setSavingReminder(false);
    }
  };

  const isOverdue =
    lead.next_follow_up && new Date(lead.next_follow_up).getTime() < Date.now();

  const chatUrl = lead.remoteJid
    ? `/chat?c=${lead.remoteJid}&n=${encodeURIComponent(lead.nome_negocio)}${
        lead.instance_name ? `&i=${encodeURIComponent(lead.instance_name)}` : ""
      }`
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl md:max-w-2xl bg-zinc-950 text-zinc-100 border-zinc-800 p-0 flex flex-col h-full shadow-2xl"
      >
        {/* Cabeçalho da Ficha com Foto do WhatsApp */}
        <div className="p-6 border-b border-zinc-800 bg-zinc-900/60 relative">
          {onDelete ? (
            <div className="absolute top-4 right-12 flex items-center">
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 hover:bg-red-500/20 text-red-400"
                onClick={() => onDelete(lead)}
                title="Excluir Lead"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ) : null}
          <SheetHeader className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="flex flex-col items-center gap-1.5 shrink-0">
                <LeadAvatar
                  url={profilePic}
                  name={lead.nome_negocio}
                  size="lg"
                  className="h-16 w-16 rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-200 shadow-md"
                  fallbackClassName="text-xl font-bold bg-zinc-800 text-emerald-400"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleRefreshPhoto}
                  disabled={syncingPhoto}
                  className="h-6 px-1.5 text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 gap-1 font-medium"
                  title="Atualizar foto de perfil do WhatsApp"
                  aria-label="Atualizar foto do WhatsApp"
                >
                  {syncingPhoto ? (
                    <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                  ) : (
                    <RotateCw className="w-3 h-3 text-emerald-400" />
                  )}
                  <span className="hidden sm:inline">Foto WhatsApp</span>
                </Button>
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <SheetTitle className="text-xl font-bold text-zinc-50 truncate tracking-tight">
                    {lead.nome_negocio}
                  </SheetTitle>
                  {lead.status ? (
                    <Badge variant="outline" className="text-xs uppercase bg-zinc-800 text-zinc-300 border-zinc-700">
                      {lead.status}
                    </Badge>
                  ) : null}
                </div>

                <p className="text-xs text-zinc-400 mt-1 flex items-center gap-2">
                  <span>{lead.ramo_negocio || lead.categoria || "Comércio / Serviços"}</span>
                  {lead.avaliacao ? (
                    <span className="text-amber-400 flex items-center gap-1 font-medium">
                      ★ {lead.avaliacao} ({lead.reviews || 0})
                    </span>
                  ) : null}
                </p>

                {lead.telefone ? (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-sm font-medium text-emerald-400">
                      {formatPhoneNumber(lead.telefone)}
                    </span>
                    <button
                      onClick={handleCopyPhone}
                      className="text-zinc-400 hover:text-zinc-200 p-1 rounded hover:bg-zinc-800 transition"
                      title="Copiar telefone"
                      aria-label="Copiar telefone"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Ações Rápidas de Contato */}
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-800/80">
              {chatUrl ? (
                <Button
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium gap-1.5 shadow-sm"
                  onClick={() => window.open(chatUrl, "_blank")}
                >
                  <MessageSquare className="h-4 w-4" />
                  Abrir no WhatsApp
                </Button>
              ) : null}

              {lead.endereco || lead.maps_url ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-zinc-700 hover:bg-zinc-800 text-zinc-300 gap-1.5"
                  onClick={() =>
                    window.open(
                      lead.maps_url ||
                        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                          `${lead.nome_negocio} ${lead.endereco || ""}`.trim()
                        )}`,
                      "_blank"
                    )
                  }
                >
                  <MapPin className="h-4 w-4" />
                  Maps
                </Button>
              ) : null}

              <Button
                size="sm"
                variant="outline"
                disabled={downloadingKit}
                className="border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 gap-1.5"
                onClick={async () => {
                  const currentGeneration = generation.current;
                  setDownloadingKit(true);
                  try {
                    await downloadLeadMapsKit({ id: lead.id, nome_negocio: lead.nome_negocio });
                  } finally {
                    if (generation.current === currentGeneration) {
                      setDownloadingKit(false);
                    }
                  }
                }}
                title="Baixar todas as fotos do Google Maps + TXT com todos os dados do negócio para criação de site"
              >
                {downloadingKit ? (
                  <Loader2 className="h-4 w-4 animate-spin text-amber-300" />
                ) : (
                  <Download className="h-4 w-4 text-amber-300" />
                )}
                {downloadingKit ? "Baixando Kit..." : "Baixar Kit Site"}
              </Button>

              {lead.website ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-zinc-700 hover:bg-zinc-800 text-zinc-300 gap-1.5"
                  onClick={() =>
                    window.open(
                      lead.website?.startsWith("http")
                        ? lead.website
                        : `https://${lead.website}`,
                      "_blank"
                    )
                  }
                >
                  <Globe className="h-4 w-4" />
                  Site
                </Button>
              ) : null}
            </div>
          </SheetHeader>
        </div>

        {/* Abas da Ficha: Visão Geral, Anotações e Lembretes */}
        <div className="flex-1 overflow-hidden flex flex-col p-6">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1 flex flex-col overflow-hidden"
          >
            <TabsList className="bg-zinc-900 border border-zinc-800 p-1 w-full justify-start rounded-lg mb-4">
              <TabsTrigger
                value="overview"
                className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-zinc-400 text-xs font-medium"
              >
                Visão Geral
              </TabsTrigger>
              <TabsTrigger
                value="notes"
                className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-zinc-400 text-xs font-medium relative"
              >
                Anotações
                {observacoes ? (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                ) : null}
              </TabsTrigger>
              <TabsTrigger
                value="reminders"
                className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-zinc-400 text-xs font-medium relative"
              >
                Lembretes & Retorno
                {nextFollowUp ? (
                  <span
                    className={`ml-1.5 w-1.5 h-1.5 rounded-full inline-block ${
                      isOverdue ? "bg-rose-500 animate-pulse" : "bg-cyan-500"
                    }`}
                  />
                ) : null}
              </TabsTrigger>
            </TabsList>

            {/* ABA: VISÃO GERAL */}
            <TabsContent value="overview" className="flex-1 overflow-y-auto space-y-5 pr-1">
              {extraContent}

              {lead.resumo_ia ? (
                <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-900/40 text-emerald-200">
                  <div className="flex items-center gap-2 mb-2 font-semibold text-xs tracking-wider uppercase text-emerald-400">
                    <Sparkles className="h-4 w-4" />
                    Inteligência do Lead
                  </div>
                  <p className="text-sm leading-relaxed text-zinc-300">{lead.resumo_ia}</p>
                </div>
              ) : null}

              {/* Status do Próximo Retorno */}
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    Próxima Ação Agendada
                  </span>
                  {nextFollowUp ? (
                    <Badge
                      variant="outline"
                      className={`text-xs ${
                        isOverdue
                          ? "bg-rose-950/50 text-rose-300 border-rose-800"
                          : "bg-cyan-950/50 text-cyan-300 border-cyan-800"
                      }`}
                    >
                      {isOverdue ? "Atrasado" : "No Prazo"}
                    </Badge>
                  ) : null}
                </div>

                {nextFollowUp ? (
                  <div className="space-y-1">
                    {lembreteTexto ? (
                      <p className="text-sm font-semibold text-cyan-300">
                        {lembreteTexto}
                      </p>
                    ) : null}
                    <p className="text-xs font-medium text-zinc-300">
                      Vencimento:{" "}
                      {new Date(nextFollowUp).toLocaleString("pt-BR", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">Nenhum lembrete agendado para este lead.</p>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setActiveTab("reminders")}
                  className="text-xs text-emerald-400 hover:text-emerald-300 hover:bg-zinc-800/80 p-0 h-auto font-medium"
                >
                  {nextFollowUp ? "Alterar ou concluir lembrete →" : "Agendar um lembrete agora →"}
                </Button>
              </div>

              {/* Dados Cadastrais Detalhados */}
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Dados de Contato e Localização
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-xs text-zinc-500 block">Email</span>
                    <span className="text-zinc-200 break-all">{lead.email || "Não informado"}</span>
                  </div>

                  <div>
                    <span className="text-xs text-zinc-500 block">Endereço</span>
                    <span className="text-zinc-200">{lead.endereco || "Não informado"}</span>
                  </div>

                  <div>
                    <span className="text-xs text-zinc-500 block">Instagram</span>
                    <span className="text-zinc-200">{lead.instagram || "—"}</span>
                  </div>

                  <div>
                    <span className="text-xs text-zinc-500 block">Facebook</span>
                    <span className="text-zinc-200">{lead.facebook || "—"}</span>
                  </div>
                </div>
              </div>

              {/* Prévia das Anotações */}
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Última Anotação
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setActiveTab("notes")}
                    className="text-xs text-emerald-400 hover:text-emerald-300 p-0 h-auto font-medium"
                  >
                    Editar →
                  </Button>
                </div>
                <p className="text-sm text-zinc-300 italic whitespace-pre-wrap">
                  {observacoes ? observacoes : "Nenhuma anotação registrada ainda."}
                </p>
              </div>
            </TabsContent>

            {/* ABA: ANOTAÇÕES */}
            <TabsContent value="notes" className="flex-1 flex flex-col space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-zinc-200">
                  Anotações Internas do Operador
                </h3>
                <p className="text-xs text-zinc-400">
                  Registre detalhes importantes sobre o contato, objeções, valores discutidos e perfil da empresa.
                </p>
              </div>

              <Textarea
                value={observacoes}
                onChange={(e) => { edited.current.notes = true; setObservacoes(e.target.value); }}
                placeholder="Ex: Falou com o gerente financeiro, pediram envio de proposta até quinta-feira às 14h..."
                className="flex-1 bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-500 resize-none p-3 text-sm rounded-xl focus-visible:ring-emerald-500"
              />

              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-zinc-500">
                  {observacoes.length} caracteres
                </span>

                <Button
                  onClick={handleSaveNotes}
                  disabled={savingNotes}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium gap-2 px-4 shadow-sm"
                >
                  {savingNotes ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Salvar Anotações
                </Button>
              </div>
            </TabsContent>

            {/* ABA: LEMBRETES & RETORNO */}
            <TabsContent value="reminders" className="flex-1 overflow-y-auto space-y-5">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-zinc-200">
                  Lembrete & Data de Vencimento
                </h3>
                <p className="text-xs text-zinc-400">
                  Escreva a anotação do que precisa ser feito e defina a data de vencimento. Seus lembretes aparecerão na Dashboard.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-4">
                <div>
                  <label htmlFor="lead-reminder-text" className="text-xs font-medium text-zinc-300 block mb-1.5">
                    O que você precisa lembrar? (Anotação / Tarefa)
                  </label>
                  <Input
                    id="lead-reminder-text"
                    required
                    maxLength={1000}
                    type="text"
                    value={lembreteTexto}
                    onChange={(e) => { edited.current.text = true; setLembreteTexto(e.target.value); }}
                    placeholder="Ex: Entregar projeto x, ligar para fechar proposta..."
                    className="bg-zinc-950 border-zinc-700 text-zinc-100 text-sm rounded-lg"
                  />
                </div>

                <div>
                  <label htmlFor="lead-reminder-due" className="text-xs font-medium text-zinc-300 block mb-1.5">
                    Data e Horário de Vencimento
                  </label>
                  <Input
                    id="lead-reminder-due"
                    required
                    type="datetime-local"
                    value={nextFollowUp}
                    onChange={(e) => { edited.current.due = true; setNextFollowUp(e.target.value); }}
                    className="bg-zinc-950 border-zinc-700 text-zinc-100 text-sm rounded-lg"
                  />
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <Button
                    onClick={handleSaveReminder}
                    disabled={savingReminder || !nextFollowUp || !lembreteTexto.trim()}
                    className="bg-cyan-600 hover:bg-cyan-500 text-white font-medium gap-2 shadow-sm"
                  >
                    {savingReminder ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Calendar className="h-4 w-4" />
                    )}
                    Salvar Lembrete
                  </Button>

                  {nextFollowUp ? (
                    <Button
                      variant="outline"
                      onClick={handleClearReminder}
                      disabled={savingReminder}
                      className="border-zinc-700 hover:bg-zinc-800 text-zinc-300 gap-1.5"
                    >
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      Concluir Lembrete
                    </Button>
                  ) : null}
                </div>
              </div>

              {/* Dica Operacional */}
              <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 text-xs text-zinc-400 flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 text-cyan-400 shrink-0 mt-0.5" />
                <span>
                  O retorno fica salvo no sistema e aparece com prioridade na sua Dashboard quando chegar o dia agendado ou caso fique atrasado.
                </span>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
