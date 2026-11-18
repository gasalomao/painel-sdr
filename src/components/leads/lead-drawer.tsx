"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  MessageSquare,
  MapPin,
  Calendar,
  Clock,
  Copy,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Save,
  Loader2,
  Sparkles,
  Globe,
  Trash2,
  RotateCw,
  Download,
  Building2,
  UserCheck,
  ShieldCheck,
  Megaphone,
  Layers,
  ChevronDown,
  Pencil,
  Zap,
  Star,
  Bot,
} from "lucide-react";
import { toast } from "sonner";
import { LeadAvatar } from "@/components/leads/lead-avatar";
import {
  extractFullLeadCrmDossier,
  formatBrPhoneDisplay,
  type LeadAiDossierMode,
  type LeadCrmDossier,
  type LeadCrmSummary,
} from "@/lib/crm-lead-profile";
import { getPhotoJid } from "@/lib/whatsapp-photo-utils";
import { downloadLeadMapsKit } from "@/lib/lead-maps-kit-client";
import type { WhatsAppChannelType } from "@/lib/scraper-lead-enrichment";
import styles from "./lead-drawer.module.css";

function formatPhoneNumber(phoneOrJid?: string | null): string {
  if (!phoneOrJid) return "—";
  return formatBrPhoneDisplay(phoneOrJid) || phoneOrJid;
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
  avaliacao?: number | string | null;
  rating?: number | string | null;
  reviews?: number | string | null;
  status?: string | null;
  remoteJid?: string | null;
  instance_name?: string | null;
  observacoes?: string | null;
  next_follow_up?: string | null;
  lembrete_texto?: string | null;
  owner_name?: string | null;
  year_established?: number | string | null;
  business_details?: Record<string, unknown> | null;
  crm_summary?: LeadCrmSummary | null;
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

interface ProfileDraft {
  socio_decisor: string;
  canal_whatsapp: WhatsAppChannelType | "";
  telefone_alternativo: string;
  cnpj: string;
  porte: string;
  servico_principal: string;
  email: string;
  website: string;
  instagram: string;
  facebook: string;
}

function buildDraftFromLeadAndDossier(
  lead: LeadDrawerData,
  dossier: LeadCrmDossier,
): ProfileDraft {
  return {
    socio_decisor: dossier.socioDecisor || "",
    canal_whatsapp: dossier.canalWhatsapp || "",
    telefone_alternativo: dossier.telefoneAlternativoFormatted || dossier.telefoneAlternativo || "",
    cnpj: dossier.cnpj || "",
    porte: dossier.porte || "",
    servico_principal: dossier.servicoPrincipal || "",
    email: dossier.emailValidado || lead.email || "",
    website: lead.website || dossier.discoveredRealWebsite || "",
    instagram: lead.instagram || "",
    facebook: lead.facebook || "",
  };
}

const AI_MODE_OPTIONS: ReadonlyArray<{
  value: LeadAiDossierMode;
  label: string;
  hint: string;
}> = [
  {
    value: "inherit",
    label: "Padrão do agente",
    hint: "Segue a regra definida na configuração do Agente IA",
  },
  {
    value: "strategic",
    label: "Bastidores discretos",
    hint: "IA usa sócio, porte e falhas do site sem citar CNPJ/capital",
  },
  {
    value: "full",
    label: "Personalização total",
    hint: "IA personaliza com especialidade, histórico e contexto completo",
  },
  {
    value: "off",
    label: "Não enviar à IA",
    hint: "IA ignora dados de CNPJ/enriquecimento neste lead",
  },
];

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
  const [auditingLead, setAuditingLead] = useState<boolean>(false);
  const [savingProfile, setSavingProfile] = useState<boolean>(false);
  const [savingAiMode, setSavingAiMode] = useState<boolean>(false);
  const [profilePic, setProfilePic] = useState<string | null>(null);
  const [dossier, setDossier] = useState<LeadCrmDossier | null>(null);
  const [hydratedLeadFields, setHydratedLeadFields] = useState<Partial<LeadDrawerData>>({});
  const [dossierExpanded, setDossierExpanded] = useState<boolean>(false);
  const [editingProfile, setEditingProfile] = useState<boolean>(false);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({
    socio_decisor: "",
    canal_whatsapp: "",
    telefone_alternativo: "",
    cnpj: "",
    porte: "",
    servico_principal: "",
    email: "",
    website: "",
    instagram: "",
    facebook: "",
  });

  const edited = useRef({ notes: false, text: false, due: false, profile: false });
  const generation = useRef(0);
  const leadRef = useRef(lead);
  const leadId = lead?.id;

  useEffect(() => {
    leadRef.current = lead;
  }, [lead]);

  useEffect(() => {
    if (lead?.profilePicUrl !== undefined) {
      setProfilePic(lead.profilePicUrl || null);
    }
  }, [lead?.id, lead?.profilePicUrl]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const currentLead = leadRef.current;
    edited.current = { notes: false, text: false, due: false, profile: false };
    setSavingNotes(false);
    setSavingReminder(false);
    setSyncingPhoto(false);
    setDownloadingKit(false);
    setAuditingLead(false);
    setSavingProfile(false);
    setSavingAiMode(false);
    setEditingProfile(false);
    setHydratedLeadFields({});

    if (currentLead && open) {
      const initialDossier = extractFullLeadCrmDossier(currentLead as unknown as Record<string, unknown>);
      setDossier(initialDossier);
      setDossierExpanded(initialDossier.richSignalsCount >= 3);
      setProfileDraft(buildDraftFromLeadAndDossier(currentLead, initialDossier));

      const bdLembrete =
        currentLead.business_details && typeof currentLead.business_details === "object"
          ? ((currentLead.business_details as Record<string, unknown>).lembrete_texto as string | null | undefined)
          : undefined;
      setObservacoes(currentLead.observacoes || "");
      setLembreteTexto(
        currentLead.next_follow_up
          ? (currentLead.lembrete_texto ?? bdLembrete ?? currentLead.observacoes ?? "")
          : "",
      );
      if (currentLead.next_follow_up) {
        try {
          const d = new Date(currentLead.next_follow_up);
          const pad = (n: number) => String(n).padStart(2, "0");
          const localStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          setNextFollowUp(localStr);
        } catch {
          setNextFollowUp("");
        }
      } else {
        setNextFollowUp("");
      }
      setProfilePic(currentLead.profilePicUrl || null);

      fetch(`/api/leads/${currentLead.id}/crm`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (generation.current !== currentGeneration) return;
          if (data?.lead) {
            setHydratedLeadFields({
              email: data.lead.email ?? currentLead.email ?? null,
              website: data.lead.website ?? currentLead.website ?? null,
              instagram: data.lead.instagram ?? currentLead.instagram ?? null,
              facebook: data.lead.facebook ?? currentLead.facebook ?? null,
              endereco: data.lead.endereco ?? currentLead.endereco ?? null,
              owner_name: data.lead.owner_name ?? currentLead.owner_name ?? null,
              year_established: data.lead.year_established ?? currentLead.year_established ?? null,
            });
            const freshDossier: LeadCrmDossier =
              data.crm_dossier ||
              extractFullLeadCrmDossier(data.lead as Record<string, unknown>);
            setDossier(freshDossier);
            if (freshDossier.richSignalsCount >= 2) {
              setDossierExpanded(true);
            }
            if (!edited.current.profile) {
              setProfileDraft(
                buildDraftFromLeadAndDossier(
                  { ...currentLead, ...data.lead },
                  freshDossier,
                ),
              );
            }
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
    return () => {
      generation.current = currentGeneration + 1;
    };
  }, [leadId, open]);

  if (!lead) return null;

  const effectiveLead: LeadDrawerData = { ...lead, ...hydratedLeadFields };
  const activeDossier: LeadCrmDossier =
    dossier || extractFullLeadCrmDossier(effectiveLead as unknown as Record<string, unknown>);
  const ratingValue = effectiveLead.avaliacao ?? effectiveLead.rating ?? null;

  const copyValue = (val: string | null | undefined, label: string) => {
    if (!val) return;
    navigator.clipboard?.writeText(val);
    toast.success(`${label} copiado para a área de transferência`);
  };

  const handleCopyPhone = () => {
    if (!effectiveLead.telefone) return;
    navigator.clipboard.writeText(effectiveLead.telefone);
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

  const handleAuditLead = async () => {
    const currentGeneration = generation.current;
    setAuditingLead(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/enrich`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (generation.current !== currentGeneration) return;
      if (!res.ok) {
        throw new Error(data.error || "Não foi possível auditar este lead agora.");
      }
      if (data.crm_dossier) {
        setDossier(data.crm_dossier);
        setDossierExpanded(true);
        if (!edited.current.profile) {
          setProfileDraft(
            buildDraftFromLeadAndDossier(
              { ...effectiveLead, ...(data.lead || {}) },
              data.crm_dossier,
            ),
          );
        }
      }
      if (data.lead) {
        setHydratedLeadFields((prev) => ({
          ...prev,
          email: data.lead.email ?? prev.email ?? null,
          owner_name: data.lead.owner_name ?? prev.owner_name ?? null,
        }));
      }
      onLeadUpdated?.({
        id: lead.id,
        ...(data.lead?.email ? { email: data.lead.email } : {}),
        ...(data.lead?.owner_name ? { owner_name: data.lead.owner_name } : {}),
        ...(data.crm_summary ? { crm_summary: data.crm_summary } : {}),
      });
      toast.success("Auditoria de CNPJ e site concluída!");
    } catch (err: unknown) {
      if (generation.current === currentGeneration) {
        toast.error(err instanceof Error ? err.message : "Falha ao auditar lead.");
      }
    } finally {
      if (generation.current === currentGeneration) {
        setAuditingLead(false);
      }
    }
  };

  const handleSaveProfile = async () => {
    const currentGeneration = generation.current;
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/crm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crm_profile: {
            socio_decisor: profileDraft.socio_decisor,
            canal_whatsapp: profileDraft.canal_whatsapp || null,
            telefone_alternativo: profileDraft.telefone_alternativo,
            cnpj: profileDraft.cnpj,
            porte: profileDraft.porte,
            servico_principal: profileDraft.servico_principal,
            email: profileDraft.email,
            website: profileDraft.website,
            instagram: profileDraft.instagram,
            facebook: profileDraft.facebook,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (generation.current !== currentGeneration) return;
      if (!res.ok) throw new Error(data.error || "Falha ao salvar dados do lead");

      if (data.crm_dossier) {
        setDossier(data.crm_dossier);
      }
      const nextFields: Partial<LeadDrawerData> = {
        email: profileDraft.email.trim().toLowerCase() || null,
        website: profileDraft.website.trim() || null,
        instagram: profileDraft.instagram.trim() || null,
        facebook: profileDraft.facebook.trim() || null,
        owner_name: profileDraft.socio_decisor.trim() || null,
        ...(data.crm_summary ? { crm_summary: data.crm_summary } : {}),
      };
      setHydratedLeadFields((prev) => ({ ...prev, ...nextFields }));
      edited.current.profile = false;
      setEditingProfile(false);
      toast.success("Dados comerciais atualizados!");
      onLeadUpdated?.({ id: lead.id, ...nextFields });
    } catch (err: unknown) {
      if (generation.current === currentGeneration) {
        toast.error(err instanceof Error ? err.message : "Erro ao atualizar dados");
      }
    } finally {
      if (generation.current === currentGeneration) {
        setSavingProfile(false);
      }
    }
  };

  const handleChangeAiMode = async (mode: LeadAiDossierMode) => {
    if (mode === activeDossier.aiDossierMode || savingAiMode) return;
    const currentGeneration = generation.current;
    setSavingAiMode(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/crm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crm_profile: { ai_dossier_mode: mode },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (generation.current !== currentGeneration) return;
      if (!res.ok) throw new Error(data.error || "Não foi possível salvar preferência de IA");

      if (data.crm_dossier) setDossier(data.crm_dossier);
      if (data.crm_summary) {
        onLeadUpdated?.({ id: lead.id, crm_summary: data.crm_summary });
      }
      toast.success("Preferência de uso na IA atualizada!");
    } catch (err: unknown) {
      if (generation.current === currentGeneration) {
        toast.error(err instanceof Error ? err.message : "Erro ao salvar preferência de IA");
      }
    } finally {
      if (generation.current === currentGeneration) {
        setSavingAiMode(false);
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
      if (generation.current === currentGeneration) {
        toast.error(err instanceof Error ? err.message : "Erro ao salvar anotações");
      }
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
      if (generation.current === currentGeneration) {
        toast.error(err instanceof Error ? err.message : "Erro ao salvar lembrete");
      }
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
      if (generation.current === currentGeneration) {
        toast.error(err instanceof Error ? err.message : "Erro ao concluir lembrete");
      }
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

  const altPhone = activeDossier.telefonesAlternativos[0] ?? null;
  const altChatUrl = altPhone
    ? `/chat?c=${altPhone.telefone}@s.whatsapp.net&n=${encodeURIComponent(lead.nome_negocio)}${
        lead.instance_name ? `&i=${encodeURIComponent(lead.instance_name)}` : ""
      }`
    : null;

  const effectiveSiteUrl =
    effectiveLead.website || activeDossier.discoveredRealWebsite || null;

  // Coleta apenas campos preenchidos para não poluir com estados vazios
  const contactItems: Array<{ label: string; value: string; copyable?: boolean; href?: string }> = [];
  const finalEmail = activeDossier.emailValidado || effectiveLead.email || null;
  if (finalEmail) {
    contactItems.push({ label: "E-mail", value: finalEmail, copyable: true });
  }
  if (effectiveLead.endereco) {
    contactItems.push({ label: "Endereço", value: effectiveLead.endereco });
  }
  if (effectiveLead.instagram) {
    const igHref = effectiveLead.instagram.startsWith("http")
      ? effectiveLead.instagram
      : `https://instagram.com/${effectiveLead.instagram.replace(/^@/, "")}`;
    contactItems.push({ label: "Instagram", value: effectiveLead.instagram, href: igHref });
  }
  if (effectiveLead.facebook) {
    const fbHref = effectiveLead.facebook.startsWith("http")
      ? effectiveLead.facebook
      : `https://${effectiveLead.facebook}`;
    contactItems.push({ label: "Facebook", value: effectiveLead.facebook, href: fbHref });
  }

  // Sinais para o bloco retrátil Raio-X Empresarial
  const dossierRows: Array<{ label: string; value: string; copyRaw?: string; fullWidth?: boolean }> = [];
  if (activeDossier.socioDecisor) {
    const socioWithAge = activeDossier.faixaEtariaSocio
      ? `${activeDossier.socioDecisor} (${activeDossier.faixaEtariaSocio})`
      : activeDossier.socioDecisor;
    dossierRows.push({
      label: "Sócio-decisor / Proprietário",
      value: socioWithAge,
      copyRaw: activeDossier.socioDecisor,
    });
  }
  if (activeDossier.cnpj) {
    dossierRows.push({
      label: "CNPJ",
      value: activeDossier.situacaoCadastral
        ? `${activeDossier.cnpj} · ${activeDossier.situacaoCadastral}`
        : activeDossier.cnpj,
      copyRaw: activeDossier.cnpj,
    });
  }
  if (activeDossier.razaoSocial) {
    dossierRows.push({ label: "Razão social", value: activeDossier.razaoSocial });
  }
  const porteParts = [
    activeDossier.porte,
    activeDossier.capitalSocial
      ? `Capital R$ ${Math.round(activeDossier.capitalSocial).toLocaleString("pt-BR")}`
      : null,
  ].filter(Boolean);
  if (porteParts.length > 0) {
    dossierRows.push({ label: "Porte e capital", value: porteParts.join(" · ") });
  }
  const maturityParts = [
    activeDossier.anosEmpresa !== null ? `${activeDossier.anosEmpresa} anos de CNPJ` : null,
    activeDossier.anoGoogle !== null ? `No Google desde ${activeDossier.anoGoogle}` : null,
    activeDossier.claimed === true ? "Perfil verificado" : null,
  ].filter(Boolean);
  if (maturityParts.length > 0) {
    dossierRows.push({ label: "Maturidade no mercado", value: maturityParts.join(" · ") });
  }
  if (activeDossier.servicoPrincipal || activeDossier.cnaeDescricao) {
    dossierRows.push({
      label: "Especialidade / Atividade",
      value: activeDossier.servicoPrincipal || activeDossier.cnaeDescricao || "",
    });
  }
  if (activeDossier.siteDiagnostico || activeDossier.siteStatusLabel) {
    const diagParts = [
      activeDossier.siteStatusLabel,
      activeDossier.siteDiagnostico && activeDossier.siteDiagnostico !== activeDossier.siteStatusLabel
        ? activeDossier.siteDiagnostico
        : null,
      activeDossier.abandonedCopyrightYear ? `Rodapé © ${activeDossier.abandonedCopyrightYear}` : null,
    ].filter(Boolean);
    dossierRows.push({
      label: "Diagnóstico técnico do site",
      value: diagParts.join(" — "),
      fullWidth: true,
    });
  }
  if (activeDossier.socios.length > 1) {
    dossierRows.push({
      label: "Quadro societário (QSA)",
      value: activeDossier.socios
        .map((s) => (s.qualificacao ? `${s.nome} (${s.qualificacao})` : s.nome))
        .join(" · "),
      fullWidth: true,
    });
  }
  if (activeDossier.horarioFuncionamento) {
    dossierRows.push({
      label: "Horário de atendimento",
      value: activeDossier.horarioFuncionamento,
      fullWidth: true,
    });
  }
  if (activeDossier.topicosAvaliacoes.length > 0) {
    dossierRows.push({
      label: "Temas citados nas avaliações",
      value: activeDossier.topicosAvaliacoes.join(", "),
      fullWidth: true,
    });
  }

  const hasSignalBadges =
    activeDossier.qualificationScore !== null ||
    activeDossier.siteHealth !== null ||
    activeDossier.hasPaidTraffic ||
    activeDossier.managementTools.length > 0 ||
    activeDossier.anosEmpresa !== null ||
    activeDossier.anoGoogle !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={`${styles.drawer} w-full sm:max-w-xl md:max-w-2xl p-0 flex flex-col h-full shadow-2xl`}
      >
        <div className={styles.header}>
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

          <SheetHeader className="space-y-0 text-left">
            <div className={styles.titleRow}>
              <div className="flex flex-col items-center gap-1.5 shrink-0">
                <LeadAvatar
                  url={profilePic}
                  name={lead.nome_negocio}
                  size="lg"
                  className="h-15 w-15 rounded-xl border border-[#303a32] bg-[#111612] text-[#edf2ee]"
                  fallbackClassName="text-lg font-semibold bg-[#111612] text-[#6ee7b7]"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleRefreshPhoto}
                  disabled={syncingPhoto}
                  className="h-6 px-1.5 text-[10px] text-[#a5b1a8] hover:text-[#edf2ee] hover:bg-[#232d26] gap-1 font-medium"
                  title="Atualizar foto de perfil do WhatsApp"
                  aria-label="Atualizar foto do WhatsApp"
                >
                  {syncingPhoto ? (
                    <Loader2 className="w-3 h-3 animate-spin text-[#6ee7b7]" />
                  ) : (
                    <RotateCw className="w-3 h-3 text-[#6ee7b7]" />
                  )}
                  <span className="hidden sm:inline">Foto WhatsApp</span>
                </Button>
              </div>

              <div className="min-w-0 flex-1 pr-6">
                <div className="flex items-start gap-2 flex-wrap">
                  <SheetTitle className={styles.titleText} title={lead.nome_negocio}>
                    {lead.nome_negocio}
                  </SheetTitle>
                  {lead.status ? (
                    <span className={styles.statusPill}>
                      {lead.status}
                    </span>
                  ) : null}
                </div>

                <p className={styles.metaLine}>
                  <span>{lead.ramo_negocio || lead.categoria || "Comércio / Serviços"}</span>
                  {ratingValue ? (
                    <span className={styles.ratingTag}>
                      <Star className="w-3 h-3 fill-current" />
                      {ratingValue} ({lead.reviews || 0})
                    </span>
                  ) : null}
                </p>

                {effectiveLead.telefone ? (
                  <div className={styles.phoneGroup}>
                    <div className={styles.primaryPhoneRow}>
                      <span className={styles.primaryPhone}>
                        {formatPhoneNumber(effectiveLead.telefone)}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyPhone}
                        className={styles.iconCopyBtn}
                        title="Copiar telefone"
                        aria-label="Copiar telefone"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      {activeDossier.canalLabel ? (
                        <span
                          className={
                            activeDossier.canalWhatsapp === "socio_direto" ||
                            activeDossier.canalWhatsapp === "provavel_socio"
                              ? styles.pillMint
                              : styles.pillSage
                          }
                        >
                          <UserCheck className="w-3 h-3" />
                          {activeDossier.canalWhatsapp === "socio_direto" && activeDossier.primeiroNomeSocio
                            ? `Sócio: ${activeDossier.primeiroNomeSocio}`
                            : activeDossier.canalLabel}
                        </span>
                      ) : null}
                    </div>

                    {altPhone ? (
                      <div className={styles.secondaryPhoneRow}>
                        <span>
                          {altPhone.label}: {altPhone.formatted}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyValue(altPhone.telefone, "Telefone alternativo")}
                          className={styles.iconCopyBtn}
                          title="Copiar telefone alternativo"
                          aria-label="Copiar telefone alternativo"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        {altChatUrl ? (
                          <button
                            type="button"
                            onClick={() => window.open(altChatUrl, "_blank")}
                            className={styles.inlineLink}
                          >
                            Chamar reserva
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className={styles.quickActions}>
              {chatUrl ? (
                <button
                  type="button"
                  className={styles.whatsappBtn}
                  onClick={() => window.open(chatUrl, "_blank")}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  Abrir no WhatsApp
                </button>
              ) : null}

              {effectiveLead.endereco || effectiveLead.maps_url ? (
                <button
                  type="button"
                  className={styles.ghostActionBtn}
                  onClick={() =>
                    window.open(
                      effectiveLead.maps_url ||
                        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                          `${effectiveLead.nome_negocio} ${effectiveLead.endereco || ""}`.trim(),
                        )}`,
                      "_blank",
                    )
                  }
                >
                  <MapPin className="h-3.5 w-3.5" />
                  Maps
                </button>
              ) : null}

              <button
                type="button"
                disabled={downloadingKit}
                className={styles.kitActionBtn}
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
                title="Baixar fotos do Google Maps + TXT com todos os dados do negócio"
              >
                {downloadingKit ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {downloadingKit ? "Baixando Kit..." : "Baixar Kit Site"}
              </button>

              {effectiveSiteUrl ? (
                <button
                  type="button"
                  className={styles.ghostActionBtn}
                  onClick={() =>
                    window.open(
                      effectiveSiteUrl.startsWith("http")
                        ? effectiveSiteUrl
                        : `https://${effectiveSiteUrl}`,
                      "_blank",
                    )
                  }
                >
                  <Globe className="h-3.5 w-3.5" />
                  Site
                </button>
              ) : null}

              <button
                type="button"
                disabled={auditingLead}
                onClick={handleAuditLead}
                className={styles.ghostActionBtn}
                title="Consultar gratuitamente CNPJ, sócios (QSA), saúde do site, pixels e sistemas"
              >
                {auditingLead ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#6ee7b7]" />
                ) : (
                  <Zap className="h-3.5 w-3.5 text-[#6ee7b7]" />
                )}
                {auditingLead ? "Auditando..." : activeDossier.cnpj ? "Reauditar CNPJ" : "Auditar CNPJ e site"}
              </button>
            </div>
          </SheetHeader>
        </div>

        <div className={styles.body}>
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1 flex flex-col overflow-hidden"
          >
            <TabsList className={styles.tabsList}>
              <TabsTrigger value="overview" className={styles.tabTrigger}>
                Visão Geral
              </TabsTrigger>
              <TabsTrigger value="notes" className={`${styles.tabTrigger} relative`}>
                Anotações
                {observacoes ? (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-[#6ee7b7] inline-block" />
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="reminders" className={`${styles.tabTrigger} relative`}>
                Lembretes & Retorno
                {nextFollowUp ? (
                  <span
                    className={`ml-1.5 w-1.5 h-1.5 rounded-full inline-block ${
                      isOverdue ? "bg-[#fda4af]" : "bg-[#7dd3fc]"
                    }`}
                  />
                ) : null}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className={styles.scrollPane}>
              <div className={styles.flatStack}>
                {hasSignalBadges ? (
                  <section aria-label="Sinais rápidos de qualificação">
                    <div className={styles.signalStrip}>
                      {activeDossier.qualificationScore !== null ? (
                        <span
                          className={
                            activeDossier.qualificationScore >= 70
                              ? styles.pillMint
                              : activeDossier.qualificationScore >= 45
                                ? styles.pillSky
                                : styles.pillSage
                          }
                          title={
                            activeDossier.qualificationReasons.length > 0
                              ? activeDossier.qualificationReasons.join(" · ")
                              : "Pontuação comercial automática"
                          }
                        >
                          <ShieldCheck className="w-3 h-3" />
                          ICP {activeDossier.qualificationScore}/100
                        </span>
                      ) : null}

                      {activeDossier.siteHealth === "broken_site" ? (
                        <span className={styles.pillRose} title={activeDossier.siteDiagnostico || undefined}>
                          <AlertTriangle className="w-3 h-3" />
                          {activeDossier.siteStatusLabel || "Site com falha"}
                        </span>
                      ) : activeDossier.siteHealth === "weak_site" ? (
                        <span className={styles.pillAmber} title={activeDossier.siteDiagnostico || undefined}>
                          <AlertTriangle className="w-3 h-3" />
                          {activeDossier.siteStatusLabel || "Site improvisado"}
                        </span>
                      ) : activeDossier.siteHealth === "no_site" ? (
                        <span className={styles.pillAmber}>
                          <Globe className="w-3 h-3" />
                          Sem site próprio
                        </span>
                      ) : activeDossier.siteHealth === "active_site" ? (
                        <span className={styles.pillSage}>
                          <Globe className="w-3 h-3" />
                          Site ativo
                        </span>
                      ) : null}

                      {activeDossier.hasPaidTraffic ? (
                        <span
                          className={styles.pillSky}
                          title={
                            activeDossier.trafficTags.length > 0
                              ? activeDossier.trafficTags.join(", ")
                              : "Tags de anúncio detectadas"
                          }
                        >
                          <Megaphone className="w-3 h-3" />
                          {activeDossier.trafficTags[0] || "Tráfego pago"}
                        </span>
                      ) : null}

                      {activeDossier.managementTools.map((tool) => (
                        <span key={tool} className={styles.pillSage}>
                          <Layers className="w-3 h-3" />
                          {tool}
                        </span>
                      ))}
                    </div>
                  </section>
                ) : null}

                {/* Acordeão discreto: Raio-X empresarial, decisor e contato */}
                <section>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={styles.disclosureTrigger}
                      aria-expanded={dossierExpanded || editingProfile}
                      onClick={() => setDossierExpanded((prev) => !prev)}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Building2 className="w-4 h-4 text-[#6ee7b7] shrink-0" />
                        <span className="truncate">
                          {dossierRows.length > 0
                            ? `Raio-X empresarial e decisor (${dossierRows.length})`
                            : "Dados empresariais e decisor"}
                        </span>
                      </span>
                      <ChevronDown
                        className={`w-4 h-4 text-[#a5b1a8] shrink-0 transition-transform ${
                          dossierExpanded || editingProfile ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    <button
                      type="button"
                      className={styles.ghostActionBtn}
                      onClick={() => {
                        setEditingProfile((prev) => !prev);
                        setDossierExpanded(true);
                      }}
                      title="Editar ou completar dados do lead"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      {editingProfile ? "Cancelar" : "Editar"}
                    </button>
                  </div>

                  {editingProfile ? (
                    <div className="mt-3 space-y-3">
                      <div className={styles.editGrid}>
                        <div>
                          <label htmlFor="crm-socio" className={styles.dataLabel}>
                            Sócio-decisor / Proprietário
                          </label>
                          <input
                            id="crm-socio"
                            type="text"
                            value={profileDraft.socio_decisor}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, socio_decisor: e.target.value }));
                            }}
                            placeholder="Ex: Dr. Marcos Oliveira"
                            className={styles.fieldInput}
                          />
                        </div>

                        <div>
                          <label htmlFor="crm-canal" className={styles.dataLabel}>
                            Quem atende no WhatsApp principal
                          </label>
                          <select
                            id="crm-canal"
                            value={profileDraft.canal_whatsapp}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({
                                ...p,
                                canal_whatsapp: e.target.value as WhatsAppChannelType | "",
                              }));
                            }}
                            className={styles.fieldSelect}
                          >
                            <option value="">Não classificado</option>
                            <option value="socio_direto">WhatsApp direto do sócio</option>
                            <option value="provavel_socio">Provável celular do sócio</option>
                            <option value="recepcao_comercial">Recepção / Secretária</option>
                          </select>
                        </div>

                        <div>
                          <label htmlFor="crm-tel-alt" className={styles.dataLabel}>
                            2º Telefone / Reserva (DDD + número)
                          </label>
                          <input
                            id="crm-tel-alt"
                            type="text"
                            value={profileDraft.telefone_alternativo}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, telefone_alternativo: e.target.value }));
                            }}
                            placeholder="Ex: (11) 3222-4455"
                            className={styles.fieldInput}
                          />
                        </div>

                        <div>
                          <label htmlFor="crm-cnpj" className={styles.dataLabel}>
                            CNPJ (14 dígitos)
                          </label>
                          <input
                            id="crm-cnpj"
                            type="text"
                            value={profileDraft.cnpj}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, cnpj: e.target.value }));
                            }}
                            placeholder="00.000.000/0001-00"
                            className={styles.fieldInput}
                          />
                        </div>

                        <div>
                          <label htmlFor="crm-porte" className={styles.dataLabel}>
                            Porte empresarial
                          </label>
                          <input
                            id="crm-porte"
                            type="text"
                            value={profileDraft.porte}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, porte: e.target.value }));
                            }}
                            placeholder="ME, EPP, Médio/Grande..."
                            className={styles.fieldInput}
                          />
                        </div>

                        <div>
                          <label htmlFor="crm-servico" className={styles.dataLabel}>
                            Especialidade / Serviço principal
                          </label>
                          <input
                            id="crm-servico"
                            type="text"
                            value={profileDraft.servico_principal}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, servico_principal: e.target.value }));
                            }}
                            placeholder="Ex: Implantes e Ortodontia"
                            className={styles.fieldInput}
                          />
                        </div>

                        <div>
                          <label htmlFor="crm-email" className={styles.dataLabel}>
                            E-mail comercial
                          </label>
                          <input
                            id="crm-email"
                            type="email"
                            value={profileDraft.email}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, email: e.target.value }));
                            }}
                            placeholder="contato@empresa.com.br"
                            className={styles.fieldInput}
                          />
                        </div>

                        <div>
                          <label htmlFor="crm-website" className={styles.dataLabel}>
                            Website
                          </label>
                          <input
                            id="crm-website"
                            type="text"
                            value={profileDraft.website}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, website: e.target.value }));
                            }}
                            placeholder="https://..."
                            className={styles.fieldInput}
                          />
                        </div>

                        <div>
                          <label htmlFor="crm-instagram" className={styles.dataLabel}>
                            Instagram
                          </label>
                          <input
                            id="crm-instagram"
                            type="text"
                            value={profileDraft.instagram}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, instagram: e.target.value }));
                            }}
                            placeholder="@perfil"
                            className={styles.fieldInput}
                          />
                        </div>

                        <div>
                          <label htmlFor="crm-facebook" className={styles.dataLabel}>
                            Facebook
                          </label>
                          <input
                            id="crm-facebook"
                            type="text"
                            value={profileDraft.facebook}
                            onChange={(e) => {
                              edited.current.profile = true;
                              setProfileDraft((p) => ({ ...p, facebook: e.target.value }));
                            }}
                            placeholder="facebook.com/..."
                            className={styles.fieldInput}
                          />
                        </div>
                      </div>

                      <div className="flex justify-end gap-2 pt-1">
                        <button
                          type="button"
                          onClick={handleSaveProfile}
                          disabled={savingProfile}
                          className={styles.whatsappBtn}
                        >
                          {savingProfile ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Save className="w-3.5 h-3.5" />
                          )}
                          Salvar dados do lead
                        </button>
                      </div>
                    </div>
                  ) : dossierExpanded ? (
                    dossierRows.length > 0 ? (
                      <dl className={styles.dataGrid}>
                        {dossierRows.map((item) => (
                          <div
                            key={item.label}
                            className={item.fullWidth ? styles.dataItemFull : undefined}
                          >
                            <dt className={styles.dataLabel}>{item.label}</dt>
                            <dd className={styles.dataValueRow}>
                              <span className={styles.dataValue}>{item.value}</span>
                              {item.copyRaw ? (
                                <button
                                  type="button"
                                  onClick={() => copyValue(item.copyRaw, item.label)}
                                  className={styles.iconCopyBtn}
                                  title={`Copiar ${item.label}`}
                                  aria-label={`Copiar ${item.label}`}
                                >
                                  <Copy className="w-3 h-3" />
                                </button>
                              ) : null}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="mt-3 text-xs text-[#a5b1a8] leading-relaxed">
                        Nenhum dado societário auditado ainda neste lead. Clique em{" "}
                        <button
                          type="button"
                          onClick={handleAuditLead}
                          disabled={auditingLead}
                          className={styles.inlineLink}
                        >
                          Auditar CNPJ e site
                        </button>{" "}
                        para consultar gratuitamente ou em{" "}
                        <button
                          type="button"
                          onClick={() => setEditingProfile(true)}
                          className={styles.inlineLink}
                        >
                          Editar
                        </button>{" "}
                        para preencher manualmente.
                      </p>
                    )
                  ) : null}
                </section>

                {/* Controle discreto: Como a IA usa esses dados na abordagem */}
                <section>
                  <div className={styles.sectionHeader}>
                    <h4 className={styles.sectionTitle}>
                      <Bot className="w-3.5 h-3.5 text-[#6ee7b7]" />
                      Uso deste dossiê pela IA na abordagem
                    </h4>
                  </div>
                  <div className={styles.segmentedAi} role="group" aria-label="Modo de uso do dossiê pela IA">
                    {AI_MODE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={savingAiMode}
                        aria-pressed={activeDossier.aiDossierMode === opt.value}
                        onClick={() => handleChangeAiMode(opt.value)}
                        title={opt.hint}
                        className={styles.aiOptionBtn}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </section>

                {extraContent ? <section>{extraContent}</section> : null}

                {lead.resumo_ia ? (
                  <section>
                    <div className={styles.sectionHeader}>
                      <h4 className={styles.sectionTitle}>
                        <Sparkles className="h-3.5 w-3.5 text-[#6ee7b7]" />
                        Resumo da conversa
                      </h4>
                    </div>
                    <p className="text-sm leading-relaxed text-[#d5e0d7]">{lead.resumo_ia}</p>
                  </section>
                ) : null}

                {/* Próxima Ação Agendada */}
                <section>
                  <div className={styles.sectionHeader}>
                    <h4 className={styles.sectionTitle}>
                      <Clock className="h-3.5 w-3.5 text-[#a5b1a8]" />
                      Próxima ação agendada
                    </h4>
                    {nextFollowUp ? (
                      <span className={isOverdue ? styles.pillRose : styles.pillSky}>
                        {isOverdue ? "Atrasado" : "No prazo"}
                      </span>
                    ) : null}
                  </div>

                  {nextFollowUp ? (
                    <div className="space-y-1 mb-2">
                      {lembreteTexto ? (
                        <p className="text-sm font-semibold text-[#edf2ee]">{lembreteTexto}</p>
                      ) : null}
                      <p className="text-xs text-[#a5b1a8] tabular-nums">
                        Vencimento:{" "}
                        {new Date(nextFollowUp).toLocaleString("pt-BR", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-[#a5b1a8] mb-2">
                      Nenhum lembrete agendado para este lead.
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => setActiveTab("reminders")}
                    className={styles.inlineLink}
                  >
                    {nextFollowUp ? "Alterar ou concluir lembrete" : "Agendar um lembrete agora"}
                  </button>
                </section>

                {/* Contato e Localização — sem campos vazios ocupando espaço */}
                <section>
                  <div className={styles.sectionHeader}>
                    <h4 className={styles.sectionTitle}>Contato e localização</h4>
                    {contactItems.length < 4 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingProfile(true);
                          setDossierExpanded(true);
                        }}
                        className={styles.inlineLink}
                      >
                        Completar contato
                      </button>
                    ) : null}
                  </div>

                  {contactItems.length > 0 ? (
                    <dl className={styles.dataGrid}>
                      {contactItems.map((item) => (
                        <div
                          key={item.label}
                          className={item.label === "Endereço" ? styles.dataItemFull : undefined}
                        >
                          <dt className={styles.dataLabel}>{item.label}</dt>
                          <dd className={styles.dataValueRow}>
                            {item.href ? (
                              <a
                                href={item.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={styles.inlineLink}
                              >
                                {item.value}
                              </a>
                            ) : (
                              <span className={styles.dataValue}>{item.value}</span>
                            )}
                            {item.copyable ? (
                              <button
                                type="button"
                                onClick={() => copyValue(item.value, item.label)}
                                className={styles.iconCopyBtn}
                                title={`Copiar ${item.label}`}
                                aria-label={`Copiar ${item.label}`}
                              >
                                <Copy className="w-3 h-3" />
                              </button>
                            ) : null}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-xs text-[#a5b1a8]">
                      Apenas o telefone principal está registrado até o momento.
                    </p>
                  )}
                </section>

                {/* Última Anotação */}
                <section>
                  <div className={styles.sectionHeader}>
                    <h4 className={styles.sectionTitle}>Última anotação</h4>
                    <button
                      type="button"
                      onClick={() => setActiveTab("notes")}
                      className={styles.inlineLink}
                    >
                      Editar
                    </button>
                  </div>
                  <p className="text-sm text-[#d5e0d7] whitespace-pre-wrap leading-relaxed">
                    {observacoes ? observacoes : "Nenhuma anotação registrada ainda."}
                  </p>
                </section>
              </div>
            </TabsContent>

            {/* ABA: ANOTAÇÕES */}
            <TabsContent value="notes" className="flex-1 flex flex-col space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[#edf2ee]">
                  Anotações internas do operador
                </h3>
                <p className="text-xs text-[#a5b1a8]">
                  Registre detalhes importantes sobre o contato, objeções, valores discutidos e perfil da empresa.
                </p>
              </div>

              <Textarea
                value={observacoes}
                onChange={(e) => {
                  edited.current.notes = true;
                  setObservacoes(e.target.value);
                }}
                placeholder="Ex: Falou com o gerente financeiro, pediram envio de proposta até quinta-feira às 14h..."
                className="flex-1 bg-[#111612] border-[#3b483e] text-[#edf2ee] placeholder:text-[#a5b1a8] resize-none p-3 text-sm rounded-lg"
              />

              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-[#a5b1a8] tabular-nums">
                  {observacoes.length} caracteres
                </span>

                <Button
                  onClick={handleSaveNotes}
                  disabled={savingNotes}
                  className="bg-[#6ee7b7] hover:bg-[#8ef0c8] text-[#10251b] font-semibold gap-2 px-4"
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
            <TabsContent value="reminders" className={`${styles.scrollPane} space-y-5`}>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[#edf2ee]">
                  Lembrete & data de vencimento
                </h3>
                <p className="text-xs text-[#a5b1a8]">
                  Escreva a tarefa pendente e defina a data de retorno. Seus lembretes aparecem na Dashboard.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-[#181d19] border border-[#303a32] space-y-4">
                <div>
                  <label
                    htmlFor="lead-reminder-text"
                    className="text-xs font-medium text-[#d5e0d7] block mb-1.5"
                  >
                    O que você precisa lembrar? (Anotação / Tarefa)
                  </label>
                  <Input
                    id="lead-reminder-text"
                    required
                    maxLength={1000}
                    type="text"
                    value={lembreteTexto}
                    onChange={(e) => {
                      edited.current.text = true;
                      setLembreteTexto(e.target.value);
                    }}
                    placeholder="Ex: Entregar projeto x, ligar para fechar proposta..."
                    className="bg-[#111612] border-[#3b483e] text-[#edf2ee] placeholder:text-[#a5b1a8] text-sm rounded-lg"
                  />
                </div>

                <div>
                  <label
                    htmlFor="lead-reminder-due"
                    className="text-xs font-medium text-[#d5e0d7] block mb-1.5"
                  >
                    Data e Horário de Vencimento
                  </label>
                  <Input
                    id="lead-reminder-due"
                    required
                    type="datetime-local"
                    value={nextFollowUp}
                    onChange={(e) => {
                      edited.current.due = true;
                      setNextFollowUp(e.target.value);
                    }}
                    className="bg-[#111612] border-[#3b483e] text-[#edf2ee] text-sm rounded-lg"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <Button
                    onClick={handleSaveReminder}
                    disabled={savingReminder || !nextFollowUp || !lembreteTexto.trim()}
                    className="bg-[#6ee7b7] hover:bg-[#8ef0c8] text-[#10251b] font-semibold gap-2"
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
                      className="border-[#3b483e] bg-[#111612] hover:bg-[#232d26] text-[#d5e0d7] gap-1.5"
                    >
                      <CheckCircle2 className="h-4 w-4 text-[#6ee7b7]" />
                      Concluir Lembrete
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="p-3.5 rounded-lg bg-[#181d19] border border-[#303a32] text-xs text-[#a5b1a8] flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 text-[#6ee7b7] shrink-0 mt-0.5" />
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
