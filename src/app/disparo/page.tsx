"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import styles from "./disparo.module.css";
import {
  Send, Play, Pause, Square, Trash2, Loader2, Plus, Search, Users,
  Clock, ShieldAlert, Smartphone, CheckCircle2, XCircle, ChevronRight, Zap, Globe, BarChart3,
  Pencil, Bot, MessageSquare, Save, Paperclip, RefreshCw, ArrowLeft
} from "lucide-react";
import { TEMPLATE_VARIABLES, renderTemplate, greetingFor } from "@/lib/template-vars";
import { MediaUploader } from "@/components/media-uploader";
import { cn } from "@/lib/utils";
import { useClientSession } from "@/lib/use-session";
import { LeadIntelligenceBatch } from "@/components/lead-intelligence-batch";
import { ModelOptions } from "@/components/ai-module-shared";

type Lead = {
  id: number;
  remoteJid: string;
  nome_negocio: string | null;
  ramo_negocio: string | null;
  status: string | null;
  instance_name: string | null;
};

type Campaign = {
  id: string;
  name: string;
  instance_name: string;
  message_template: string;
  status: string;
  total_targets: number;
  sent_count: number;
  failed_count: number;
  min_interval_seconds: number;
  max_interval_seconds: number;
  allowed_start_hour: number;
  allowed_end_hour: number;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
  agent_id?: number | null;
  personalize_with_ai?: boolean;
  humanize_messages?: boolean;
  use_web_search?: boolean;
  ai_prompt?: string | null;
  ai_model?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_caption?: string | null;
  media_file_name?: string | null;
  media_mimetype?: string | null;
};

const DEFAULT_AI_PROMPT = `Você é um SDR experiente fazendo uma primeira abordagem PROFISSIONAL via WhatsApp.

INSTRUÇÕES:
- Reescreva a MENSAGEM-BASE de forma natural, curta (até 3 frases), em PT-BR.
- Mantenha o sentido original do template.
- Personalize SUTILMENTE pra empresa/ramo (sem inventar nada).
- Não use emojis exagerados.
- NÃO invente dados que não tem certeza.`;

export default function DisparoPage() {
  const { clientId } = useClientSession();
  const [tab, setTab] = useState<"create" | "list">("list");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);

  // Lista de instâncias da Evolution
  const [instances, setInstances] = useState<{ instanceName: string; profileName?: string }[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(true);
  const [instancesError, setInstancesError] = useState<string | null>(null);

  // Form de criação
  const [name, setName] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [template, setTemplate] = useState("{{saudacao}}, {{nome_empresa}}! Tudo bem? Posso te falar rapidinho sobre…");
  const [minSec, setMinSec] = useState(30);
  const [maxSec, setMaxSec] = useState(60);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(20);
  const [personalizeWithAI, setPersonalizeWithAI] = useState(false);
  const [humanizeMessages, setHumanizeMessages] = useState(false);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<string | null>(null);
  const [mediaFileName, setMediaFileName] = useState<string | null>(null);
  const [mediaMimetype, setMediaMimetype] = useState<string | null>(null);
  const [mediaCaption, setMediaCaption] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const templateRef = useRef<HTMLTextAreaElement | null>(null);

  // Edit mode: quando preenchido, o formulário salva em vez de criar.
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);

  // Agente IA da CAMPANHA (exclusivo, não usa agent_settings).
  // Só precisa de: modelo + prompt. A API Key vem central (Configurações).
  // aiModel inicia com o último usado (localStorage) pra não precisar
  // reescolher toda vez que criar uma campanha.
  const [aiModel, setAiModel] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("disparo_last_ai_model") || "";
  });
  const [aiPrompt, setAiPrompt] = useState<string>("");
  const [aiModels, setAiModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingAiModels, setLoadingAiModels] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [defaultAiModel, setDefaultAiModel] = useState<string | null>(null);

  // Toda vez que o usuário escolhe um modelo, grava como default.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (aiModel) localStorage.setItem("disparo_last_ai_model", aiModel);
  }, [aiModel]);

  // Leads (CRM)
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadsSearch, setLeadsSearch] = useState("");
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Logs da campanha selecionada
  const [activeLogCampaignId, setActiveLogCampaignId] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ id: number; message: string; level: string; created_at: string }[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Último log por campanha (pra exibir "o que está acontecendo agora" no card,
  // sem precisar abrir o painel de logs).
  const [latestLogByCampaign, setLatestLogByCampaign] = useState<Record<string, { message: string; level: string; created_at: string }>>({});

  // Histórico de mensagens enviadas (por campanha) — aberto por card.
  type TargetRow = {
    id: string;
    remote_jid: string;
    nome_negocio: string | null;
    ramo_negocio: string | null;
    status: string;
    rendered_message: string | null;
    ai_input: string | null;              // Template que foi pra IA (só quando personalize_with_ai=true)
    sent_at: string | null;
    error_message: string | null;
    attempts: number | null;
  };
  const [activeTargetsCampaignId, setActiveTargetsCampaignId] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [targetsFilter, setTargetsFilter] = useState<"all" | "sent" | "failed" | "pending">("all");

  async function loadTargets(campaignId: string) {
    setLoadingTargets(true);
    try {
      const r = await fetch(`/api/campaigns/${campaignId}`, { cache: "no-store" });
      const d = await r.json();
      if (d.success) setTargets((d.targets || []) as TargetRow[]);
    } catch {}
    finally { setLoadingTargets(false); }
  }

  // Recarrega os targets em tempo real quando o painel está aberto numa
  // campanha rodando (a cada 5s). Se terminar, só fica o snapshot final.
  useEffect(() => {
    if (!activeTargetsCampaignId) return;
    loadTargets(activeTargetsCampaignId);
    const camp = campaigns.find(c => c.id === activeTargetsCampaignId);
    if (camp?.status !== "running") return;
    const t = setInterval(() => loadTargets(activeTargetsCampaignId), 5000);
    return () => clearInterval(t);
  }, [activeTargetsCampaignId, campaigns]);

  // initial = true só no primeiro carregamento pra mostrar skeleton.
  // Polls subsequentes NÃO viram loading=true (evita flicker da lista toda).
  async function loadCampaigns(initial = false) {
    if (initial) setLoadingCampaigns(true);
    try {
      const r = await fetch("/api/campaigns", { cache: "no-store" });
      const d = await r.json();
      if (d.success) {
        // Só atualiza se mudou algo relevante — evita re-render desnecessário.
        setCampaigns(prev => {
          const next: Campaign[] = d.campaigns || [];
          if (prev.length !== next.length) return next;
          const changed = next.some((c, i) => {
            const p = prev[i];
            return !p || p.id !== c.id
              || p.status !== c.status
              || p.sent_count !== c.sent_count
              || p.failed_count !== c.failed_count
              || p.total_targets !== c.total_targets
              || p.last_error !== c.last_error;
          });
          return changed ? next : prev;
        });
      }
    } finally {
      if (initial) setLoadingCampaigns(false);
    }
  }

  const loadInstances = useCallback(async () => {
    if (!clientId) return;
    console.log("[DISPARO] loadInstances() iniciado");
    setLoadingInstances(true);
    setInstancesError(null);
    try {
      const { data: conns } = await supabase.from("channel_connections").select("instance_name").eq("client_id", clientId);
      const myInstances = new Set((conns || []).map((c: any) => c.instance_name));

      // Timeout generoso (35s) — Evolution pode levar até 30s em instâncias pesadas
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 35000);
      const r = await fetch("/api/whatsapp?instances=true", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(tm);
      const d = await r.json();
      console.log("[DISPARO] loadInstances() resposta:", d);
      if (d.success && Array.isArray(d.instances)) {
        const filtered = d.instances.filter((i: any) => myInstances.has(i.instanceName));
        setInstances(filtered);
        if (filtered.length === 0) setInstancesError("Nenhuma instância conectada. Conecte em WhatsApp.");
      } else {
        setInstancesError(d.error || "Falha ao carregar instâncias.");
      }
    } catch (e: any) {
      console.error("[DISPARO] loadInstances() erro:", e);
      const msg = e?.name === "AbortError"
        ? "Timeout — a Evolution API não respondeu em 35s. Verifique se o container está online."
        : (e?.message || "Falha ao carregar instâncias.");
      setInstancesError(msg);
    } finally {
      console.log("[DISPARO] loadInstances() terminou");
      setLoadingInstances(false);
    }
  }, [clientId]);

  async function loadLeads() {
    const sessRes = await fetch("/api/auth/session");
    const session = await sessRes.json();

    setIsAdmin(!!session?.isAdmin && !session?.impersonating);
    setDefaultAiModel(session?.defaultAiModel || null);
    
    let query = supabase
      .from("leads_extraidos")
      .select("id, remoteJid, nome_negocio, ramo_negocio, status, instance_name")
      .order("created_at", { ascending: false })
      .limit(2000);
      
    if (session?.clientId) {
      query = query.eq("client_id", session.clientId);
    }
    
    const { data } = await query;
    setLeads((data as Lead[]) || []);
  }

  useEffect(() => {
    if (!clientId) return;
    loadCampaigns(true);
    loadInstances();
    loadLeads();
    loadAiModels();
    const t = setInterval(() => loadCampaigns(false), 8000);
    return () => clearInterval(t);
  }, [clientId, loadInstances]);

  // Ao ligar "personalizar com IA" sem prompt preenchido, sugere o default
  // e carrega a lista de modelos Gemini.
  useEffect(() => {
    if (!personalizeWithAI) return;
    if (!aiPrompt.trim()) setAiPrompt(DEFAULT_AI_PROMPT);
    if (aiModels.length === 0 && !loadingAiModels) loadAiModels();
  }, [personalizeWithAI]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAiModels() {
    setLoadingAiModels(true);
    try {
      const r = await fetch("/api/ai-models");
      const d = await r.json();
      if (d.success && Array.isArray(d.models)) {
        setAiModels(d.models);
        // Mantém o que o usuário escolheu por último (já vem do localStorage).
        // Só cai no default do Google quando não há escolha prévia.
        setAiModel(prev => prev || d.models[0]?.id || "");
      } else if (d.error) {
        console.warn("[DISPARO] /api/ai-models:", d.error);
      }
    } catch (e: any) {
      console.warn("[DISPARO] Falha ao carregar modelos:", e?.message);
    }
    finally { setLoadingAiModels(false); }
  }

  // Escuta logs em tempo real
  useEffect(() => {
    if (!activeLogCampaignId) {
      setLogs([]);
      return;
    }

    // Carrega logs iniciais
    async function fetchInitialLogs() {
      const { data } = await supabase
        .from("campaign_logs")
        .select("*")
        .eq("campaign_id", activeLogCampaignId)
        .order("created_at", { ascending: true })
        .limit(100);
      setLogs(data || []);
    }
    fetchInitialLogs();

    // Inscrição Realtime
    const channel = supabase
      .channel(`logs-${activeLogCampaignId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "campaign_logs", filter: `campaign_id=eq.${activeLogCampaignId}` },
        (payload) => {
          setLogs(prev => [...prev, payload.new as any].slice(-100));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeLogCampaignId]);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  async function refreshLogs() {
    if (!activeLogCampaignId) return;
    const { data } = await supabase
      .from("campaign_logs")
      .select("*")
      .eq("campaign_id", activeLogCampaignId)
      .order("created_at", { ascending: true })
      .limit(100);
    setLogs(data || []);
  }

  // Polling mais rápido se houver campanha rodando (também sem loading=true)
  useEffect(() => {
    const anyRunning = campaigns.some(c => c.status === "running");
    if (!anyRunning) return;
    const t = setInterval(() => loadCampaigns(false), 3000);
    return () => clearInterval(t);
  }, [campaigns]);

  // Puxa o ÚLTIMO log de cada campanha visível (pra mostrar atividade em tempo
  // real direto no card). Refresca a cada 4s quando há campanha rodando.
  useEffect(() => {
    const runningIds = campaigns.filter(c => c.status === "running").map(c => c.id);
    if (runningIds.length === 0) return;

    let cancelled = false;
    async function fetchLatest() {
      const { data } = await supabase
        .from("campaign_logs")
        .select("campaign_id, message, level, created_at")
        .in("campaign_id", runningIds)
        .order("created_at", { ascending: false })
        .limit(runningIds.length * 3);
      if (cancelled || !data) return;
      const byId: Record<string, any> = {};
      for (const row of data as any[]) {
        if (!byId[row.campaign_id]) byId[row.campaign_id] = row;
      }
      setLatestLogByCampaign(prev => ({ ...prev, ...byId }));
    }
    fetchLatest();
    const t = setInterval(fetchLatest, 4000);

    // Também escuta realtime de INSERT pra cada campanha rodando (fica instantâneo).
    const channel = supabase
      .channel(`live-log-${runningIds.join("-")}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "campaign_logs" },
        (payload) => {
          const row = payload.new as any;
          if (!runningIds.includes(row.campaign_id)) return;
          setLatestLogByCampaign(prev => ({ ...prev, [row.campaign_id]: row }));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(t);
      supabase.removeChannel(channel);
    };
  }, [campaigns]);

  const filteredLeads = useMemo(() => {
    return leads.filter(l => {
      if (statusFilter !== "all" && l.status !== statusFilter) return false;
      if (!leadsSearch) return true;
      const s = leadsSearch.toLowerCase();
      return (l.nome_negocio || "").toLowerCase().includes(s)
          || (l.ramo_negocio || "").toLowerCase().includes(s)
          || (l.remoteJid || "").includes(s);
    });
  }, [leads, leadsSearch, statusFilter]);

  const previewMessage = useMemo(() => {
    const sample = leads.find(l => selectedLeadIds.has(l.id)) || leads[0];
    return renderTemplate(template, {
      remoteJid: sample?.remoteJid,
      nome_negocio: sample?.nome_negocio,
      ramo_negocio: sample?.ramo_negocio,
    });
  }, [template, leads, selectedLeadIds]);

  function insertVariable(key: string) {
    const v = `{{${key}}}`;
    const ta = templateRef.current;
    if (!ta) { setTemplate(t => t + v); return; }
    const start = ta.selectionStart ?? template.length;
    const end = ta.selectionEnd ?? template.length;
    setTemplate(template.slice(0, start) + v + template.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + v.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  function resetForm() {
    setEditingCampaignId(null);
    setName("");
    setInstanceName("");
    setTemplate("{{saudacao}}, {{nome_empresa}}! Tudo bem? Posso te falar rapidinho sobre…");
    setMinSec(30); setMaxSec(60);
    setStartHour(9); setEndHour(20);
    setPersonalizeWithAI(false);
    setHumanizeMessages(false);
    setUseWebSearch(false);
    setMediaUrl(null); setMediaType(null); setMediaFileName(null); setMediaMimetype(null); setMediaCaption("");
    // NÃO limpa aiModel — mantém o último escolhido pra próxima campanha
    // (o usuário pediu pra ele ficar salvo até mudar de novo).
    setAiPrompt("");
    setSelectedLeadIds(new Set());
  }

  function openEdit(c: Campaign) {
    setEditingCampaignId(c.id);
    setName(c.name);
    setInstanceName(c.instance_name);
    setTemplate(c.message_template);
    setMinSec(c.min_interval_seconds);
    setMaxSec(c.max_interval_seconds);
    setStartHour(c.allowed_start_hour);
    setEndHour(c.allowed_end_hour);
    setPersonalizeWithAI(!!c.personalize_with_ai);
    setHumanizeMessages(!!c.humanize_messages);
    setUseWebSearch(!!c.use_web_search);
    setAiModel(c.ai_model || "");
    setAiPrompt(c.ai_prompt || "");
    setMediaUrl(c.media_url ?? null);
    setMediaType(c.media_type ?? null);
    setMediaFileName(c.media_file_name ?? null);
    setMediaMimetype(c.media_mimetype ?? null);
    setMediaCaption(c.media_caption ?? "");
    setSelectedLeadIds(new Set()); // edit não mexe em targets
    if (c.personalize_with_ai && aiModels.length === 0) loadAiModels();
    setTab("create");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleCreate(startImmediately: boolean = false) {
    if (!name || !instanceName || !template) {
      return alert("Preencha nome, instância e template.");
    }
    if (!editingCampaignId && selectedLeadIds.size === 0) {
      return alert("Selecione pelo menos 1 lead.");
    }
    if (minSec < 1 || maxSec < 1 || minSec > maxSec) {
      return alert("Intervalo inválido. Mínimo 1s, e min ≤ max.");
    }
    if (minSec < 5) {
      const ok = confirm(`Intervalo de ${minSec}s é muito agressivo — risco de ban pelo WhatsApp. Quer continuar assim mesmo?`);
      if (!ok) return;
    }
    if (personalizeWithAI && !aiModel) {
      return alert("Personalizar com IA ligado — escolha o modelo Gemini da campanha.");
    }
    setCreating(true);
    try {
      const payload: Record<string, any> = {
        name, instance_name: instanceName, message_template: template,
        min_interval_seconds: minSec, max_interval_seconds: maxSec,
        allowed_start_hour: startHour, allowed_end_hour: endHour,
        personalize_with_ai: personalizeWithAI,
        use_web_search: useWebSearch,
        humanize_messages: humanizeMessages,
        ai_model: personalizeWithAI ? aiModel : null,
        ai_prompt: personalizeWithAI ? (aiPrompt.trim() || null) : null,
        media_url: mediaUrl,
        media_type: mediaType,
        media_caption: mediaCaption.trim() || null,
        media_file_name: mediaFileName,
        media_mimetype: mediaMimetype,
      };

      if (editingCampaignId) {
        // EDITAR
        const r = await fetch(`/api/campaigns/${editingCampaignId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || "Erro ao editar");
        
        if (startImmediately) {
          const startRes = await fetch(`/api/campaigns/${editingCampaignId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "start" }),
          });
          const startData = await startRes.json();
          if (!startData.success) {
            alert(`Campanha atualizada, mas não pôde iniciar: ${startData.error}`);
          } else {
            alert(`Campanha "${name}" atualizada e iniciada!`);
          }
        } else {
          alert(`Campanha "${name}" atualizada como rascunho.`);
        }
      } else {
        // CRIAR
        payload.lead_ids = Array.from(selectedLeadIds);
        const r = await fetch("/api/campaigns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || "Erro");
        
        if (startImmediately) {
          const startRes = await fetch(`/api/campaigns/${d.campaign.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "start" }),
          });
          const startData = await startRes.json();
          if (!startData.success) {
            alert(`Campanha salva, mas não pôde iniciar: ${startData.error}`);
          } else {
            alert(`Campanha "${name}" criada e iniciada com ${d.campaign.total_targets} leads.`);
          }
        } else {
          alert(`Campanha "${name}" salva como rascunho com ${d.campaign.total_targets} leads.`);
        }
      }
      resetForm();
      setTab("list");
      loadCampaigns();
    } catch (e: any) {
      alert("Erro: " + e.message);
    } finally {
      setCreating(false);
    }
  }

  async function controlCampaign(id: string, action: "start" | "pause" | "cancel") {
    const r = await fetch(`/api/campaigns/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const d = await r.json();
    if (!d.success) {
      // Abre o painel de logs pra esse id pra o usuário ver o contexto
      setActiveLogCampaignId(id);
      alert("Não foi possível iniciar:\n\n" + (d.error || "erro desconhecido") + "\n\n(o motivo fica salvo no card da campanha também)");
    }
    loadCampaigns();
  }

  async function deleteCampaign(id: string) {
    if (!confirm("Apagar esta campanha (e todos os targets)?")) return;
    await fetch(`/api/campaigns/${id}`, { method: "DELETE" });
    loadCampaigns();
  }

  async function clearLogs(campaignId: string) {
    if (!confirm("Tem certeza que deseja apagar todo o histórico de logs desta campanha?")) return;
    const { error } = await supabase.from("campaign_logs").delete().eq("campaign_id", campaignId);
    if (error) alert("Erro ao apagar logs: " + error.message);
    else setLogs([]);
  }

  // Aviso visual de horário fora do ideal (madrugada)
  const currentHour = new Date().getHours();
  const isLateNight = currentHour >= 0 && currentHour < 6;

  const campaignStatus: Record<string, string> = { running: "Em andamento", paused: "Pausada", done: "Concluída", cancelled: "Cancelada", draft: "Rascunho" };
  const targetStatus: Record<string, string> = { sent: "Enviada", failed: "Falha", pending: "Pendente", skipped: "Ignorada", sending: "Enviando" };

  return (
    <div className={cn(styles.page, "flex flex-col h-[100dvh] max-h-[100dvh] overflow-hidden")}>
      <Header />
      <main className={cn(styles.content, "flex-1 overflow-y-auto max-w-7xl mx-auto w-full")}>
        <div className={styles.heading}>
          <div>
            <h1>Disparo em Massa</h1>
            <p>
              {tab === "list" ? "Organize suas abordagens e acompanhe cada envio pelo WhatsApp." : editingCampaignId ? "Ajuste a campanha sem alterar os destinatários já definidos." : "Prepare sua mensagem, escolha os destinatários e defina o ritmo de envio."}
            </p>
          </div>
          {tab === "list" ? (
            <Button className={styles.primaryAction} onClick={() => { if (editingCampaignId) resetForm(); setTab("create"); }}><Plus className="w-4 h-4" />Nova campanha</Button>
          ) : (
            <Button variant="ghost" className={styles.secondaryAction} onClick={() => setTab("list")}><ArrowLeft className="w-4 h-4" />Voltar às campanhas</Button>
          )}
        </div>

        <div className={styles.navigation}>
          <div className={styles.viewButtons} role="group" aria-label="Visualização de disparos">
            <button type="button" className={styles.viewButton} aria-pressed={tab === "list"} onClick={() => setTab("list")}>Campanhas {!loadingCampaigns && <span>
              {campaigns.length}
            </span>}</button>
            <button type="button" className={styles.viewButton} aria-pressed={tab === "create"} onClick={() => setTab("create")}>
              {editingCampaignId ? "Editar campanha" : "Criar campanha"}
            </button>
          </div>
          <p className={styles.serverNote}><CheckCircle2 />O envio continua mesmo com esta aba fechada.</p>
        </div>

        {isLateNight && <div className={styles.notice}>
          <ShieldAlert />
          <p><strong>Atenção ao horário.</strong> Evite disparos entre 00h e 06h. Esse período aumenta o risco de bloqueio no WhatsApp.</p>
        </div>}

        {tab === "list" && (
          <section aria-label="Suas campanhas" className={styles.campaignList}>
            {!loadingCampaigns && campaigns.length > 0 && (
              <div className={styles.overview}>
                <span><Play /><strong>
                  {campaigns.filter(c => c.status === "running").length}
                </strong> em andamento</span>
                <span><Pause /><strong>
                  {campaigns.filter(c => c.status === "paused").length}
                </strong> pausadas</span>
                <span><Send /><strong>
                  {campaigns.reduce((sum, c) => sum + (c.sent_count || 0), 0).toLocaleString("pt-BR")}
                </strong> mensagens enviadas</span>
              </div>
            )}
            {loadingCampaigns ? (
              <div role="status" className="flex items-center justify-center gap-3 py-20 text-sm text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" />Carregando campanhas…</div>
            ) : campaigns.length === 0 ? (
              <div className={styles.empty}>
                <Send />
                <h2>Sua primeira campanha começa aqui</h2>
                <p>Escolha seus contatos, prepare uma mensagem e acompanhe os envios em um só lugar.</p>
                <Button className={styles.primaryAction} onClick={() => setTab("create")}><Plus className="w-4 h-4" />Criar a primeira campanha</Button>
              </div>
            ) : campaigns.map(c => {
              const total = c.total_targets || 0;
              const done = (c.sent_count || 0) + (c.failed_count || 0);
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              return (
                <Card key={c.id} className={styles.campaign}>
                  <CardContent className={styles.campaignBody}>
                    <div className={styles.campaignHeading}>
                      <div className="min-w-0">
                        <h2>
                          {c.name}
                        </h2>
                        <div className={styles.metadata}>
                          <span>
                            <Smartphone />
                            {c.instance_name}
                          </span>
                          <span><Clock />{c.allowed_start_hour}h às {c.allowed_end_hour}h</span>
                          <span><Zap />Intervalo de {c.min_interval_seconds}–{c.max_interval_seconds}s</span>
                        </div>
                      </div>
                      <span className={styles.status} data-status={c.status}>
                        {c.status === "running" && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
                        {campaignStatus[c.status] || c.status}
                      </span>
                    </div>
                    <p className={styles.messageExcerpt}>
                      {c.message_template}
                    </p>
                    <div>
                      <div className={styles.progressLabels}>
                        <span><strong>
                          {c.sent_count || 0}
                        </strong> de {total} enviados {c.failed_count > 0 && <span className="text-rose-300">· {c.failed_count} falhas</span>}</span>
                        <span>{pct}% processado</span>
                      </div>
                      <div className={styles.progressTrack} role="progressbar" aria-label={`Progresso de ${c.name}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    {c.status === "running" && latestLogByCampaign[c.id] && (
                      <div className={styles.activity}>
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 shrink-0 mt-1.5" />
                        <div className="min-w-0">
                          <p className={styles.activityTitle}>Última atividade · {new Date(latestLogByCampaign[c.id].created_at).toLocaleTimeString("pt-BR")}</p>
                          <p className={cn(latestLogByCampaign[c.id].level === "error" ? "text-rose-300" : latestLogByCampaign[c.id].level === "warning" ? "text-amber-200" : "text-emerald-100")}>
                            {latestLogByCampaign[c.id].message}
                          </p>
                        </div>
                      </div>
                    )}
                    {c.last_error && <div className={cn(styles.notice, styles.errorNotice)}>
                      <XCircle />
                      <div className="min-w-0">
                        <p className="font-medium">Último erro{c.last_error_at ? ` · ${new Date(c.last_error_at).toLocaleString("pt-BR")}` : ""}</p>
                        <p className="break-words">
                          {c.last_error}
                        </p>
                      </div>
                    </div>}
                    <div className={styles.campaignActions}>
                      {c.status === "running" ? <Button size="sm" className={styles.pauseAction} onClick={() => controlCampaign(c.id, "pause")}><Pause className="w-3.5 h-3.5" />Pausar</Button>
                        : c.status === "paused" || c.status === "draft" ? <Button size="sm" className={styles.startAction} onClick={() => controlCampaign(c.id, "start")}>
                          <Play className="w-3.5 h-3.5" />
                          {c.status === "draft" ? "Iniciar" : "Retomar"}
                        </Button> : null}
                      {c.status !== "done" && c.status !== "cancelled" && <Button size="sm" variant="ghost" className={styles.dangerAction} onClick={() => controlCampaign(c.id, "cancel")}><Square className="w-3.5 h-3.5" />Cancelar</Button>}
                      <div className={styles.iconActions}>
                        <Button size="sm" variant="ghost" className={styles.iconAction} onClick={() => openEdit(c)} title="Editar campanha" aria-label={`Editar ${c.name}`}>
                          <Pencil />
                        </Button>
                        <Button size="sm" variant="ghost" className={styles.iconAction} onClick={() => deleteCampaign(c.id)} title="Excluir campanha" aria-label={`Excluir ${c.name}`}>
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                    <Button variant="ghost" className={styles.detailsButton} aria-expanded={activeLogCampaignId === c.id} aria-controls={`logs-${c.id}`} onClick={() => setActiveLogCampaignId(activeLogCampaignId === c.id ? null : c.id)}>
                      <span className="flex items-center">
                        <BarChart3 />
                        {activeLogCampaignId === c.id ? "Ocultar logs de execução" : "Ver logs de execução em tempo real"}
                      </span>
                      <ChevronRight className={cn("transition-transform", activeLogCampaignId === c.id && "rotate-90")} />
                    </Button>
                    {activeLogCampaignId === c.id && (
                      <div id={`logs-${c.id}`} className={styles.logPanel}>
                        <div className={styles.panelToolbar}>
                          <span>Histórico de execução</span>
                          <div className="flex gap-2">
                            <Button size="sm" variant="ghost" className={styles.secondaryAction} onClick={refreshLogs}><RefreshCw className="w-3 h-3" />Atualizar</Button>
                            <Button size="sm" variant="ghost" className={styles.dangerAction} onClick={() => clearLogs(c.id)}><Trash2 className="w-3 h-3" />Limpar logs</Button>
                          </div>
                        </div>
                        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                          {logs.length === 0 && <p className="text-muted-foreground text-center py-8">Aguardando novos eventos…</p>}
                          {logs.map((log, i) => <div key={log.id || i} className="flex gap-3 leading-relaxed">
                            <span className="text-muted-foreground shrink-0">
                              {new Date(log.created_at).toLocaleTimeString("pt-BR")}
                            </span>
                            <span className={cn(log.level === "error" ? "text-rose-300" : log.level === "success" ? "text-emerald-300" : log.level === "warning" ? "text-amber-200" : "text-sky-200")}>
                              {log.message}
                            </span>
                          </div>)}
                          <div ref={logEndRef} />
                        </div>
                      </div>
                    )}
                    <Button variant="ghost" className={styles.detailsButton} aria-expanded={activeTargetsCampaignId === c.id} aria-controls={`messages-${c.id}`} onClick={() => setActiveTargetsCampaignId(activeTargetsCampaignId === c.id ? null : c.id)}>
                      <span className="flex items-center">
                        <MessageSquare />
                        {activeTargetsCampaignId === c.id ? "Ocultar mensagens enviadas" : `Ver mensagens enviadas (${c.sent_count || 0}/${c.total_targets || 0})`}
                      </span>
                      <ChevronRight className={cn("transition-transform", activeTargetsCampaignId === c.id && "rotate-90")} />
                    </Button>
                    {activeTargetsCampaignId === c.id && (
                      <div id={`messages-${c.id}`} className={cn(styles.historyPanel, "flex flex-col")}>
                        <div className={styles.panelToolbar}>
                          <span className="flex items-center gap-2">Histórico de envios {loadingTargets && <Loader2 className="w-3.5 h-3.5 animate-spin" />}</span>
                          <Button variant="ghost" size="sm" className={styles.secondaryAction} aria-label="Atualizar mensagens enviadas" onClick={() => loadTargets(c.id)}><RefreshCw className="w-3 h-3" />Atualizar</Button>
                          <div className={styles.historyFilters} role="group" aria-label="Filtrar histórico de envios">
                            {(["all", "sent", "failed", "pending"] as const).map(f => <button type="button" key={f} aria-pressed={targetsFilter === f} onClick={() => setTargetsFilter(f)}>
                              {f === "all" ? `Todos (${targets.length})` : `${f === "sent" ? "Enviadas" : f === "failed" ? "Falhas" : "Pendentes"} (${targets.filter(t => t.status === f).length})`}
                            </button>)}
                          </div>
                        </div>
                        <div className="flex-1 overflow-y-auto min-h-0">
                          {targets.length === 0 ? <p className="text-muted-foreground text-center py-8 text-xs">Nenhum destinatário no histórico.</p> : targets.filter(t => targetsFilter === "all" || t.status === targetsFilter).map(t => (
                            <div key={t.id} className={styles.historyEntry}>
                              <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
                                <div className="min-w-0">
                                  <p className="font-medium">
                                    {t.nome_negocio || "Sem nome"}
                                  </p>
                                  <p className="text-muted-foreground">
                                    {(t.remote_jid || "").replace("@s.whatsapp.net", "")}
                                    {t.ramo_negocio ? ` · ${t.ramo_negocio}` : ""}
                                  </p>
                                </div>
                                <div className="flex items-center gap-2 flex-wrap">
                                  {t.sent_at && <span className="text-muted-foreground text-xs">
                                    {new Date(t.sent_at).toLocaleString("pt-BR")}
                                  </span>}
                                  <span className={styles.status} data-status={t.status === "sent" ? "running" : t.status === "failed" ? "cancelled" : "draft"}>
                                    {targetStatus[t.status] || t.status}
                                  </span>
                                </div>
                              </div>
                              {t.ai_input ? <div className="space-y-3">
                                <div>
                                  <p className="text-muted-foreground mb-1">Mensagem-base enviada à IA</p>
                                  <p className="whitespace-pre-wrap text-muted-foreground">
                                    {t.ai_input}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-emerald-300 mb-1 flex items-center gap-1.5"><Bot className="w-3.5 h-3.5" />Mensagem gerada pela IA</p>
                                  <p className="whitespace-pre-wrap">
                                    {t.rendered_message}
                                  </p>
                                </div>
                              </div> : t.rendered_message && <p className="whitespace-pre-wrap">
                                {t.rendered_message}
                              </p>}
                              {t.error_message && <p className="text-rose-300 mt-2">Erro: {t.error_message}</p>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </section>
        )}

        {tab === "create" && (
          <div className={styles.createGrid}>
            <div className={styles.formColumn}>
              {editingCampaignId && <div className={styles.editNotice}>
                <p><strong>Editando campanha existente.</strong><br />Os destinatários não serão alterados.</p>
                <Button size="sm" variant="ghost" className={styles.secondaryAction} onClick={resetForm}>Cancelar edição</Button>
              </div>}
              <section className={styles.panel} aria-labelledby="campaign-identity-heading">
                <div className={styles.sectionHeader}>
                  <span className={styles.step} aria-hidden="true">1</span>
                  <div>
                    <h2 id="campaign-identity-heading">Identifique a campanha</h2>
                    <p>Defina um nome e a conta que fará os envios.</p>
                  </div>
                </div>
                <div className={styles.formBody}>
                  <div>
                    <label className={styles.fieldLabel} htmlFor="campaign-name">Nome da campanha</label>
                    <Input id="campaign-name" value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Prospecção de escritórios · Outubro" className={styles.field} />
                  </div>
                  <div>
                    <div className={styles.fieldHeading}>
                      <label className={styles.fieldLabel} htmlFor="campaign-instance">Conta do WhatsApp</label>
                      <button type="button" onClick={loadInstances} disabled={loadingInstances} className={styles.inlineAction}>
                        <RefreshCw className={cn(loadingInstances && "animate-spin")} />
                        {loadingInstances ? "Carregando…" : "Atualizar"}
                      </button>
                    </div>
                    <select id="campaign-instance" value={instanceName} onChange={e => setInstanceName(e.target.value)} disabled={loadingInstances} className={styles.field} aria-describedby={instancesError ? "campaign-instance-error" : undefined}>
                      <option value="">
                        {loadingInstances ? "Carregando contas…" : instances.length === 0 ? "Nenhuma conta disponível" : "Selecione a conta de envio"}
                      </option>
                      {instances.map(i => <option key={i.instanceName} value={i.instanceName}>
                        {i.profileName || i.instanceName}
                      </option>)}
                    </select>
                    {instancesError && !loadingInstances && <p id="campaign-instance-error" role="alert" className="text-xs text-rose-300 mt-2 flex items-start gap-1.5">
                      <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      {instancesError}
                    </p>}
                  </div>
                </div>
              </section>
              <section className={styles.panel} aria-labelledby="campaign-message-heading">
                <div className={styles.sectionHeader}>
                  <span className={styles.step} aria-hidden="true">2</span>
                  <div>
                    <h2 id="campaign-message-heading">Prepare a mensagem</h2>
                    <p>Use variáveis para adaptar o texto a cada contato.</p>
                  </div>
                </div>
                <div className={styles.formBody}>
                  <div>
                    <label htmlFor="campaign-template" className={styles.fieldLabel}>Mensagem-base</label>
                    <Textarea id="campaign-template" ref={templateRef} value={template} onChange={e => setTemplate(e.target.value)} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const v = e.dataTransfer.getData("text/plain"); if (!v) return; const ta = e.currentTarget; const start = ta.selectionStart ?? template.length; const end = ta.selectionEnd ?? template.length; setTemplate(template.slice(0, start) + v + template.slice(end)); }} className={cn(styles.field, styles.template)} />
                  </div>
                  <details>
                    <summary className={styles.variablesToggle}>Inserir variáveis de personalização ({TEMPLATE_VARIABLES.length})</summary>
                    <div className={styles.variables}>
                      {TEMPLATE_VARIABLES.map(v => <button key={v.key} type="button" onClick={() => insertVariable(v.key)} draggable onDragStart={e => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)} title={v.hint}>
                        {`{{${v.key}}}`}
                      </button>)}
                    </div>
                  </details>
                  <div className={styles.preview}>
                    <div className={styles.previewHeading}>
                      <span><MessageSquare />Prévia da mensagem</span>
                      <span>
                        {selectedLeadIds.size ? "Primeiro contato selecionado" : "Exemplo com um contato"}
                      </span>
                    </div>
                    <p className={styles.bubble}>
                      {previewMessage}
                    </p>
                    <p className={cn(styles.helper, "mt-3")}>Saudação atual: {greetingFor()}. {personalizeWithAI && "A IA reescreve este texto no momento do envio."}</p>
                  </div>
                </div>
              </section>
              <section className={styles.panel} aria-labelledby="campaign-timing-heading">
                <div className={styles.sectionHeader}>
                  <span className={styles.step} aria-hidden="true">3</span>
                  <div>
                    <h2 id="campaign-timing-heading">Defina o ritmo de envio</h2>
                    <p>Os intervalos variam dentro dos limites escolhidos.</p>
                  </div>
                </div>
                <div className={styles.formBody}>
                  <div className={styles.timingGrid}>
                    <div>
                      <label className={styles.fieldLabel} htmlFor="campaign-min">Intervalo mínimo (segundos)</label>
                      <NumberInput id="campaign-min" min={1} fallback={30} value={minSec} onChange={n => setMinSec(n)} className={styles.field} />
                    </div>
                    <div>
                      <label className={styles.fieldLabel} htmlFor="campaign-max">Intervalo máximo (segundos)</label>
                      <NumberInput id="campaign-max" min={1} fallback={60} value={maxSec} onChange={n => setMaxSec(n)} className={styles.field} />
                    </div>
                    <div>
                      <label className={styles.fieldLabel} htmlFor="campaign-start">Horário inicial (hora)</label>
                      <NumberInput id="campaign-start" min={0} max={23} fallback={9} value={startHour} onChange={n => setStartHour(n)} className={styles.field} />
                    </div>
                    <div>
                      <label className={styles.fieldLabel} htmlFor="campaign-end">Horário final (hora)</label>
                      <NumberInput id="campaign-end" min={0} max={23} fallback={20} value={endHour} onChange={n => setEndHour(n)} className={styles.field} />
                    </div>
                  </div>
                  <div className={styles.notice}>
                    <ShieldAlert />
                    <p>Referência de uso: 30–60s entre mensagens, de 9h a 20h. Para contas novas, 40–50 mensagens/dia. Intervalos não garantem proteção contra bloqueios. Em erro 429, o sistema aumenta a espera automaticamente.</p>
                  </div>
                </div>
              </section>
              <section className={styles.panel} aria-labelledby="campaign-options-heading">
                <div className={styles.sectionHeader}>
                  <span className={styles.step} aria-hidden="true">4</span>
                  <div>
                    <h2 id="campaign-options-heading">Personalização e anexos</h2>
                    <p>Recursos opcionais para complementar sua abordagem.</p>
                  </div>
                </div>
                <div className={styles.formBody}>
                  <div>
                    <label className={styles.option}>
                      <input type="checkbox" checked={personalizeWithAI} onChange={e => setPersonalizeWithAI(e.target.checked)} aria-label="Personalizar mensagem com IA" aria-describedby="campaign-ai-help" />
                      <span>
                        <strong>Personalizar mensagem com IA</strong>
                        <small id="campaign-ai-help">Reescreve a mensagem para cada empresa usando nome e ramo. Consome tokens de IA.</small>
                      </span>
                    </label>
                    {personalizeWithAI && <div className={styles.aiSettings}>
                      <label className={styles.option}>
                        <input type="checkbox" checked={useWebSearch} onChange={e => setUseWebSearch(e.target.checked)} aria-label="Pesquisar empresa na internet" aria-describedby="campaign-web-help" />
                        <span>
                          <strong className="flex items-center gap-1.5"><Globe className="w-3.5 h-3.5" />Pesquisar empresa na internet</strong>
                          <small id="campaign-web-help">Faz uma busca no DuckDuckGo antes de gerar a mensagem. Acrescenta cerca de 3–5s por contato.</small>
                        </span>
                      </label>
                      <div>
                        <div className={styles.fieldHeading}>
                          <label className={styles.fieldLabel} htmlFor="campaign-ai-model">Modelo de IA da campanha</label>
                          {isAdmin && <button type="button" onClick={loadAiModels} disabled={loadingAiModels} className={styles.inlineAction}>
                            <RefreshCw />
                            {loadingAiModels ? "Carregando…" : "Atualizar"}
                          </button>}
                        </div>
                        <select id="campaign-ai-model" value={isAdmin ? aiModel : (defaultAiModel || "")} onChange={e => setAiModel(e.target.value)} disabled={!isAdmin || aiModels.length === 0} className={styles.field}>
                          <option value="">
                            {aiModels.length === 0 ? loadingAiModels ? "Carregando modelos…" : "Atualize para carregar os modelos" : "Escolha um modelo"}
                          </option>
                          {!isAdmin && defaultAiModel && !aiModels.some(m => m.id === defaultAiModel) && <option value={defaultAiModel}>
                            {defaultAiModel}
                          </option>}
                          <ModelOptions models={aiModels} />
                        </select>
                        {!isAdmin && <p className={cn(styles.helper, "mt-2")}>Modelo definido pelo administrador: {defaultAiModel || "Não configurado"}.</p>}
                        <p className={cn(styles.helper, "mt-2")}>Modelo e prompt exclusivos desta campanha. A chave da API é gerenciada em <a href="/configuracoes" className="text-primary underline underline-offset-4">Configurações</a>.</p>
                      </div>
                      <div>
                        <div className={styles.fieldHeading}>
                          <label className={styles.fieldLabel} htmlFor="campaign-ai-prompt">Prompt da personalização</label>
                          <button type="button" onClick={() => setAiPrompt(DEFAULT_AI_PROMPT)} className={styles.inlineAction}>Restaurar padrão</button>
                        </div>
                        <Textarea id="campaign-ai-prompt" value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} placeholder="Descreva o tom e a abordagem da mensagem…" className={cn(styles.field, "min-h-40")} />
                        <p className={cn(styles.helper, "mt-2")}>A mensagem-base e os dados do contato são anexados automaticamente. Use este campo para orientar a IA.</p>
                      </div>
                    </div>}
                    <label className={styles.option}>
                      <input type="checkbox" checked={humanizeMessages} onChange={e => setHumanizeMessages(e.target.checked)} aria-label="Humanizar disparo" aria-describedby="campaign-humanize-help" />
                      <span>
                        <strong>Humanizar disparo</strong>
                        <small id="campaign-humanize-help">Divide o texto em mensagens menores e simula digitação entre elas (2–5s). Também funciona com IA.</small>
                      </span>
                    </label>
                    <div className={styles.media}>
                      <p className={cn(styles.fieldLabel, "flex items-center gap-2")}><Paperclip className="w-4 h-4" />Anexar mídia <span className="text-muted-foreground font-normal">Opcional</span></p>
                      <p className={styles.helper}>Imagem, vídeo, documento ou áudio enviado após o texto. Documentos de até 100 MB; outros tipos seguem os limites do WhatsApp.</p>
                      <MediaUploader mediaUrl={mediaUrl} mediaType={mediaType} mediaFileName={mediaFileName} mediaMimetype={mediaMimetype} onChange={f => { setMediaUrl(f.mediaUrl); setMediaType(f.mediaType); setMediaFileName(f.mediaFileName); setMediaMimetype(f.mediaMimetype); }} />
                      {mediaUrl && <div>
                        <label htmlFor="campaign-media-caption" className={styles.fieldLabel}>Legenda da mídia</label>
                        <Input id="campaign-media-caption" placeholder="Legenda opcional" value={mediaCaption} onChange={e => setMediaCaption(e.target.value)} className={styles.field} />
                      </div>}
                    </div>
                  </div>
                  {personalizeWithAI && selectedLeadIds.size > 0 && !editingCampaignId && <div className="border-t border-white/10 pt-5">
                    <p className="flex items-center gap-2 text-sm font-medium mb-2"><Bot className="w-4 h-4 text-primary" />Lead Intelligence <span className="text-muted-foreground text-xs font-normal">Opcional</span></p>
                    <p className={cn(styles.helper, "mb-4")}>Pesquisa site, Maps e informações públicas antes do disparo. Os dados ficam em cache por 30 dias.</p>
                    <LeadIntelligenceBatch leadIds={Array.from(selectedLeadIds)} />
                  </div>}
                </div>
              </section>
            </div>
            <aside className={styles.recipients} aria-labelledby="campaign-recipients-heading">
              <section className={styles.panel}>
                <div className={styles.sectionHeader}>
                  <div className={styles.recipientHeading}>
                    <Users />
                    <div>
                      <h2 id="campaign-recipients-heading">Destinatários</h2>
                      <p>
                        {editingCampaignId ? "A seleção é preservada na edição." : "Selecione os contatos da campanha."}
                      </p>
                    </div>
                  </div>
                </div>
                <div className={styles.formBody}>
                  {editingCampaignId ? <p className={styles.helper}>Esta campanha mantém os destinatários originais. Para enviar a outros contatos, crie uma nova campanha.</p> : <>
                    <div className={styles.search}>
                      <label className="sr-only" htmlFor="campaign-lead-search">Buscar destinatários</label>
                      <Search />
                      <Input id="campaign-lead-search" placeholder="Nome, ramo ou telefone" value={leadsSearch} onChange={e => setLeadsSearch(e.target.value)} className={styles.field} />
                    </div>
                    <div>
                      <label className="sr-only" htmlFor="campaign-lead-status">Filtrar destinatários por status</label>
                      <select id="campaign-lead-status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={styles.field}>
                        <option value="all">Todos os status</option>
                        <option value="novo">Novo</option>
                        <option value="interessado">Interessado</option>
                        <option value="follow-up">Follow-up</option>
                      </select>
                    </div>
                    <div className={styles.selectionTools}>
                      <button type="button" className={styles.inlineAction} onClick={() => setSelectedLeadIds(new Set(filteredLeads.map(l => l.id)))}>Selecionar todos ({filteredLeads.length})</button>
                      <button type="button" className={styles.inlineAction} onClick={() => setSelectedLeadIds(new Set())}>Limpar</button>
                    </div>
                    <p className={styles.selectionCount} role="status">
                      {selectedLeadIds.size} {selectedLeadIds.size === 1 ? "contato selecionado" : "contatos selecionados"}
                    </p>
                    <div className={styles.leadList}>
                      {filteredLeads.map(l => <label key={l.id} className={styles.lead}>
                        <input type="checkbox" checked={selectedLeadIds.has(l.id)} aria-label={`Selecionar ${l.nome_negocio || l.remoteJid}`} onChange={e => { const next = new Set(selectedLeadIds); if (e.target.checked) next.add(l.id); else next.delete(l.id); setSelectedLeadIds(next); }} />
                        <span className="min-w-0">
                          <strong>
                            {l.nome_negocio || "Sem nome"}
                          </strong>
                          <small>
                            {[l.ramo_negocio, l.remoteJid?.replace(/@.*$/, "")].filter(Boolean).join(" · ")}
                          </small>
                        </span>
                      </label>)}
                      {filteredLeads.length === 0 && <p className={cn(styles.helper, "text-center py-6")}>Nenhum contato encontrado. Tente outro nome ou status.</p>}
                    </div>
                  </>}
                </div>
              </section>
            </aside>
            <div className={styles.submitBar} style={{ gridColumn: "1 / -1" }}>
              <p>
                {editingCampaignId ? "Os destinatários originais serão mantidos." : `${selectedLeadIds.size} ${selectedLeadIds.size === 1 ? "contato receberá" : "contatos receberão"} esta campanha.`}
              </p>
              <div className={styles.submitActions}>
                <Button className={styles.secondaryAction} onClick={() => handleCreate(false)} disabled={creating || !name || !instanceName || (!editingCampaignId && selectedLeadIds.size === 0)}>{creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Salvar rascunho</Button>
                <Button className={styles.primaryAction} onClick={() => handleCreate(true)} disabled={creating || !name || !instanceName || (!editingCampaignId && selectedLeadIds.size === 0)}>
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  {editingCampaignId ? "Salvar e iniciar" : `Salvar e iniciar (${selectedLeadIds.size} ${selectedLeadIds.size === 1 ? "lead" : "leads"})`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
