"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Send, Play, Pause, Square, Trash2, Loader2, Plus, Search, Users,
  Clock, ShieldAlert, Smartphone, CheckCircle2, XCircle, ChevronRight, Zap, Globe, BarChart3,
  Pencil, Bot, Sparkles, MessageSquare, Save
} from "lucide-react";
import { TEMPLATE_VARIABLES, renderTemplate, greetingFor } from "@/lib/template-vars";
import { cn } from "@/lib/utils";
import { useClientSession } from "@/lib/use-session";
import { LeadIntelligenceBatch } from "@/components/lead-intelligence-batch";

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
  use_web_search?: boolean;
  ai_prompt?: string | null;
  ai_model?: string | null;
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
  const [useWebSearch, setUseWebSearch] = useState(false);
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
        setAiModel(prev => prev || d.models[0]?.id || "gemini-1.5-flash");
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
    setUseWebSearch(false);
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
    setUseWebSearch(!!c.use_web_search);
    setAiModel(c.ai_model || "");
    setAiPrompt(c.ai_prompt || "");
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
        ai_model: personalizeWithAI ? aiModel : null,
        ai_prompt: personalizeWithAI ? (aiPrompt.trim() || null) : null,
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

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-background overflow-hidden text-white">
      <Header />
      <main className="flex-1 overflow-y-auto p-3 sm:p-6 md:p-10 max-w-7xl mx-auto w-full space-y-4 sm:space-y-6 mobile-safe-bottom">

        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-3">
              <Zap className="w-6 h-6 text-amber-400" /> Disparo em Massa
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Primeira mensagem automática via Evolution. Use intervalo aleatório pra evitar banimento.
            </p>
            <p className="text-[10px] text-emerald-400/80 mt-1 flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              O disparo roda no servidor — continua mesmo com esta aba fechada.
            </p>
          </div>
          <div className="flex bg-white/5 border border-white/10 p-1 rounded-xl">
            <button
              onClick={() => setTab("list")}
              className={cn("px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest", tab === "list" ? "bg-primary text-black" : "text-muted-foreground hover:text-white")}
            >Campanhas</button>
            <button
              onClick={() => { if (editingCampaignId) resetForm(); setTab("create"); }}
              className={cn("px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest", tab === "create" ? "bg-primary text-black" : "text-muted-foreground hover:text-white")}
            >+ Nova</button>
          </div>
        </div>

        {/* Aviso de horário ruim */}
        {isLateNight && (
          <div className="p-3 rounded-xl bg-orange-500/10 border border-orange-500/30 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-orange-400" />
            <p className="text-[11px] text-orange-200">
              <strong>Horário arriscado:</strong> disparar entre 00h-06h é sinal claro de bot pro WhatsApp. Evite.
            </p>
          </div>
        )}

        {tab === "list" && (
          <div className="space-y-3">
            {loadingCampaigns ? (
              <div className="text-center py-20 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
            ) : campaigns.length === 0 ? (
              <Card className="border-dashed border-white/10 bg-white/[0.02]">
                <CardContent className="py-16 text-center">
                  <Users className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">Nenhuma campanha ainda.</p>
                  <Button className="mt-4" onClick={() => setTab("create")}><Plus className="w-4 h-4 mr-2" /> Criar a primeira</Button>
                </CardContent>
              </Card>
            ) : (
              campaigns.map(c => {
                const total = c.total_targets || 0;
                const done = (c.sent_count || 0) + (c.failed_count || 0);
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                const statusColor = c.status === "running" ? "text-green-400" : c.status === "paused" ? "text-yellow-400" : c.status === "done" ? "text-blue-400" : c.status === "cancelled" ? "text-red-400" : "text-muted-foreground";
                return (
                  <Card key={c.id} className="border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <h3 className="font-black text-base truncate">{c.name}</h3>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mt-0.5 flex items-center gap-2">
                            <Smartphone className="w-3 h-3" /> {c.instance_name}
                            <span className="opacity-30">·</span>
                            <Clock className="w-3 h-3" /> {c.allowed_start_hour}h-{c.allowed_end_hour}h
                            <span className="opacity-30">·</span>
                            jitter {c.min_interval_seconds}-{c.max_interval_seconds}s
                          </p>
                        </div>
                        <Badge className={cn("text-[9px] font-black uppercase tracking-widest", statusColor)}>
                          {c.status}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
                          <span>{c.sent_count}/{total} enviados {c.failed_count > 0 && <span className="text-red-400">· {c.failed_count} falhas</span>}</span>
                          <span>{pct}%</span>
                        </div>
                        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-primary to-emerald-400 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <p className="text-[11px] text-white/70 italic line-clamp-2">{c.message_template}</p>

                      {c.status === "running" && latestLogByCampaign[c.id] && (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse mt-1.5 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[9px] font-black uppercase tracking-widest text-emerald-400">
                              Agora · {new Date(latestLogByCampaign[c.id].created_at).toLocaleTimeString()}
                            </p>
                            <p className={cn(
                              "text-[11px] break-words mt-0.5",
                              latestLogByCampaign[c.id].level === "error" ? "text-red-300"
                              : latestLogByCampaign[c.id].level === "warning" ? "text-yellow-300"
                              : latestLogByCampaign[c.id].level === "success" ? "text-emerald-200"
                              : "text-white/80"
                            )}>{latestLogByCampaign[c.id].message}</p>
                          </div>
                        </div>
                      )}

                      {c.last_error && (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/30">
                          <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-[9px] font-black uppercase tracking-widest text-red-400">
                              Último erro{c.last_error_at ? ` · ${new Date(c.last_error_at).toLocaleString("pt-BR")}` : ""}
                            </p>
                            <p className="text-[11px] text-red-200/90 break-words mt-0.5">{c.last_error}</p>
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2">
                        {c.status === "running" ? (
                          <Button size="sm" onClick={() => controlCampaign(c.id, "pause")} className="bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 border border-yellow-500/30 text-[10px] font-black uppercase">
                            <Pause className="w-3 h-3 mr-1" /> Pausar
                          </Button>
                        ) : c.status === "paused" || c.status === "draft" ? (
                          <Button size="sm" onClick={() => controlCampaign(c.id, "start")} className="bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/30 text-[10px] font-black uppercase">
                            <Play className="w-3 h-3 mr-1" /> {c.status === "draft" ? "Iniciar" : "Retomar"}
                          </Button>
                        ) : null}
                        {c.status !== "done" && c.status !== "cancelled" && (
                          <Button size="sm" variant="ghost" onClick={() => controlCampaign(c.id, "cancel")} className="text-red-400 hover:bg-red-500/10 text-[10px] font-black uppercase">
                            <Square className="w-3 h-3 mr-1" /> Cancelar
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(c)}
                          className="text-blue-400 hover:bg-blue-500/10 ml-auto"
                          title="Editar campanha"
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteCampaign(c.id)} className="text-muted-foreground hover:bg-white/5">
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>

                      {/* Botão de abrir logs */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActiveLogCampaignId(activeLogCampaignId === c.id ? null : c.id)}
                        className="w-full justify-between h-8 bg-white/5 border border-white/5 hover:bg-white/10 text-[10px] uppercase font-black"
                      >
                        <span className="flex items-center gap-2">
                          <BarChart3 className="w-3 h-3 text-primary" /> 
                          {activeLogCampaignId === c.id ? "Ocultar Logs de Execução" : "Ver Logs de Execução (Tempo Real)"}
                        </span>
                        <ChevronRight className={cn("w-3 h-3 transition-transform", activeLogCampaignId === c.id && "rotate-90")} />
                      </Button>

                      {/* Área de Logs */}
                      {activeLogCampaignId === c.id && (
                        <div className="mt-2 rounded-xl bg-black/40 border border-white/5 p-3 font-mono text-[10px] h-56 flex flex-col">
                          <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2">
                            <div className="flex items-center gap-3">
                              <span className="text-[9px] uppercase font-black text-muted-foreground">Histórico de Execução</span>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                onClick={refreshLogs}
                                className="h-5 px-1.5 text-[8px] bg-white/5 hover:bg-white/10"
                              >
                                ↻ Atualizar
                              </Button>
                            </div>
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              onClick={() => clearLogs(c.id)}
                              className="h-6 px-2 text-[9px] text-red-400 hover:bg-red-500/10 hover:text-red-300"
                            >
                              <Trash2 className="w-3 h-3 mr-1" /> Limpar Logs
                            </Button>
                          </div>
                          <div className="flex-1 overflow-y-auto space-y-1.5 custom-scrollbar pr-2">
                            {logs.length === 0 && (
                              <p className="text-muted-foreground italic text-center py-10">Aguardando novos eventos...</p>
                            )}
                            {logs.map((log, i) => {
                              const color = log.level === "error" ? "text-red-400" : log.level === "success" ? "text-green-400" : log.level === "warning" ? "text-yellow-400" : "text-blue-300";
                              return (
                                <div key={log.id || i} className="flex gap-2 leading-relaxed">
                                  <span className="text-muted-foreground shrink-0">[{new Date(log.created_at).toLocaleTimeString()}]</span>
                                  <span className={cn("font-bold", color)}>{log.message}</span>
                                </div>
                              );
                            })}
                            <div ref={logEndRef} />
                          </div>
                        </div>
                      )}

                      {/* Botão de abrir histórico de mensagens */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActiveTargetsCampaignId(activeTargetsCampaignId === c.id ? null : c.id)}
                        className="w-full justify-between h-8 bg-white/5 border border-white/5 hover:bg-white/10 text-[10px] uppercase font-black"
                      >
                        <span className="flex items-center gap-2">
                          <MessageSquare className="w-3 h-3 text-cyan-300" />
                          {activeTargetsCampaignId === c.id ? "Ocultar mensagens enviadas" : `Ver mensagens enviadas (${c.sent_count || 0}/${c.total_targets || 0})`}
                        </span>
                        <ChevronRight className={cn("w-3 h-3 transition-transform", activeTargetsCampaignId === c.id && "rotate-90")} />
                      </Button>

                      {activeTargetsCampaignId === c.id && (
                        <div className="mt-2 rounded-xl bg-black/40 border border-white/5 p-3 flex flex-col max-h-[420px]">
                          <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2 gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] uppercase font-black text-muted-foreground">Histórico de envios</span>
                              {loadingTargets && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                            </div>
                            <div className="flex items-center gap-1 text-[9px]">
                              {(["all", "sent", "failed", "pending"] as const).map(f => (
                                <button
                                  key={f}
                                  onClick={() => setTargetsFilter(f)}
                                  className={cn(
                                    "px-2 py-0.5 rounded-md font-black uppercase tracking-widest transition",
                                    targetsFilter === f ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/30" : "text-muted-foreground hover:text-white"
                                  )}
                                >
                                  {f === "all" ? `Todos (${targets.length})`
                                    : f === "sent" ? `Enviadas (${targets.filter(t => t.status === "sent").length})`
                                    : f === "failed" ? `Falhas (${targets.filter(t => t.status === "failed").length})`
                                    : `Pendentes (${targets.filter(t => t.status === "pending").length})`}
                                </button>
                              ))}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => loadTargets(c.id)}
                                className="h-5 px-1.5 text-[8px] bg-white/5 hover:bg-white/10 ml-1"
                                title="Atualizar"
                              >↻</Button>
                            </div>
                          </div>
                          <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-2">
                            {targets.length === 0 ? (
                              <p className="text-muted-foreground italic text-center py-10 text-[11px]">Nenhum target ainda.</p>
                            ) : (
                              targets
                                .filter(t => targetsFilter === "all" || t.status === targetsFilter)
                                .map(t => {
                                  const phone = (t.remote_jid || "").replace("@s.whatsapp.net", "");
                                  const statusColor =
                                    t.status === "sent" ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" :
                                    t.status === "failed" ? "text-red-400 border-red-500/30 bg-red-500/10" :
                                    t.status === "skipped" ? "text-yellow-400 border-yellow-500/30 bg-yellow-500/10" :
                                    "text-muted-foreground border-white/10 bg-white/5";
                                  return (
                                    <div key={t.id} className="rounded-lg bg-white/[0.02] border border-white/5 p-2.5 space-y-1.5">
                                      <div className="flex items-center justify-between gap-2 flex-wrap">
                                        <div className="min-w-0 flex-1">
                                          <p className="text-[11px] font-bold text-white truncate">
                                            {t.nome_negocio || "(sem nome)"}
                                          </p>
                                          <p className="text-[9px] text-muted-foreground font-mono">
                                            {phone}{t.ramo_negocio ? ` · ${t.ramo_negocio}` : ""}
                                          </p>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          {t.sent_at && (
                                            <span className="text-[9px] text-muted-foreground font-mono">
                                              {new Date(t.sent_at).toLocaleString("pt-BR")}
                                            </span>
                                          )}
                                          <span className={cn("text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md border", statusColor)}>
                                            {t.status}
                                          </span>
                                        </div>
                                      </div>
                                      {t.ai_input ? (
                                        // Personalizado com IA — mostra INPUT (template) e OUTPUT (IA).
                                        <div className="space-y-1.5">
                                          <div className="rounded-md bg-white/[0.03] border border-white/5 px-2 py-1.5">
                                            <p className="text-[8px] font-black uppercase tracking-widest text-muted-foreground mb-0.5">Template → IA</p>
                                            <p className="text-[11px] text-white/60 whitespace-pre-wrap italic">{t.ai_input}</p>
                                          </div>
                                          <div className="rounded-md bg-cyan-500/5 border border-cyan-500/20 px-2 py-1.5">
                                            <p className="text-[8px] font-black uppercase tracking-widest text-cyan-300 mb-0.5 flex items-center gap-1">
                                              <Bot className="w-2.5 h-2.5" /> IA gerou (enviado ao cliente)
                                            </p>
                                            <p className="text-[11px] text-white/90 whitespace-pre-wrap">{t.rendered_message}</p>
                                          </div>
                                        </div>
                                      ) : t.rendered_message && (
                                        <p className="text-[11px] text-white/80 whitespace-pre-wrap bg-black/20 rounded-md px-2 py-1.5 border border-white/5">
                                          {t.rendered_message}
                                        </p>
                                      )}
                                      {t.error_message && (
                                        <p className="text-[10px] text-red-300 bg-red-500/5 border border-red-500/20 rounded-md px-2 py-1">
                                          ⚠ {t.error_message}
                                        </p>
                                      )}
                                    </div>
                                  );
                                })
                            )}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        )}

        {tab === "create" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Coluna esquerda: configuração */}
            <div className="lg:col-span-2 space-y-4">
              {editingCampaignId && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-blue-500/10 border border-blue-500/30">
                  <div className="flex items-center gap-2">
                    <Pencil className="w-4 h-4 text-blue-300" />
                    <p className="text-[12px] text-blue-100">
                      Editando campanha existente. <strong className="text-white">Os leads/targets não serão alterados.</strong>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { resetForm(); }}
                    className="text-[10px] font-black uppercase tracking-widest text-blue-200 hover:bg-blue-500/20"
                  >
                    Cancelar edição
                  </Button>
                </div>
              )}
              <Card className="border-white/10 bg-white/[0.02]">
                <CardHeader><CardTitle className="text-sm font-black uppercase tracking-widest">
                  {editingCampaignId ? "Editar Campanha" : "Configuração da Campanha"}
                </CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Nome</label>
                    <Input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Prospecção Advogados — Abril" className="bg-white/5 border-white/10 mt-1" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Instância (de qual conta enviar)</label>
                      <button
                        type="button"
                        onClick={loadInstances}
                        disabled={loadingInstances}
                        className="text-[9px] font-black uppercase tracking-widest text-primary hover:text-primary/80 disabled:opacity-50"
                      >
                        {loadingInstances ? "Carregando…" : "↻ Atualizar"}
                      </button>
                    </div>
                    {/* Native select pra evitar bug visual com SelectContent transparente */}
                    <select
                      value={instanceName}
                      onChange={e => setInstanceName(e.target.value)}
                      disabled={loadingInstances}
                      className="w-full mt-1 bg-white/5 border border-white/10 text-white h-11 rounded-xl text-sm px-3 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
                    >
                      <option value="" className="bg-neutral-900 text-muted-foreground">
                        {loadingInstances ? "Carregando instâncias…"
                          : instances.length === 0 ? "Nenhuma instância disponível"
                          : "Escolha a instância"}
                      </option>
                      {instances.map(i => (
                        <option key={i.instanceName} value={i.instanceName} className="bg-neutral-900 text-white">
                          {i.profileName || i.instanceName}
                        </option>
                      ))}
                    </select>
                    {instancesError && !loadingInstances && (
                      <p className="text-[10px] text-red-300 mt-1 flex items-start gap-1">
                        <XCircle className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>{instancesError}</span>
                      </p>
                    )}
                  </div>

                  {/* Template + chips de variáveis */}
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Mensagem (template)</label>
                    <div className="flex flex-wrap gap-1.5 mt-1 mb-2">
                      {TEMPLATE_VARIABLES.map(v => (
                        <button
                          key={v.key}
                          type="button"
                          onClick={() => insertVariable(v.key)}
                          draggable
                          onDragStart={e => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)}
                          className="text-[10px] font-mono px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/30 text-purple-200 hover:bg-purple-500/20"
                          title={v.hint}
                        >
                          {`{{${v.key}}}`}
                        </button>
                      ))}
                    </div>
                    <Textarea
                      ref={templateRef}
                      value={template}
                      onChange={e => setTemplate(e.target.value)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => {
                        e.preventDefault();
                        const v = e.dataTransfer.getData("text/plain");
                        if (!v) return;
                        const ta = e.currentTarget;
                        const start = ta.selectionStart ?? template.length;
                        const end = ta.selectionEnd ?? template.length;
                        setTemplate(template.slice(0, start) + v + template.slice(end));
                      }}
                      className="bg-[#0a0a0a] border-white/10 h-32 font-mono text-xs"
                    />
                    <div className="mt-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/15">
                      <p className="text-[9px] uppercase font-black tracking-widest text-emerald-400 mb-1">Pré-visualização (1º lead selecionado)</p>
                      <p className="text-[12px] text-emerald-100/90 whitespace-pre-wrap font-mono">{previewMessage}</p>
                      <p className="text-[9px] text-emerald-100/50 mt-2 italic">Saudação atual: <strong>{greetingFor()}</strong></p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Intervalo MIN (s)</label>
                      <NumberInput min={1} fallback={30} value={minSec} onChange={n => setMinSec(n)} className="bg-white/5 border-white/10 mt-1 font-mono" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Intervalo MAX (s)</label>
                      <NumberInput min={1} fallback={60} value={maxSec} onChange={n => setMaxSec(n)} className="bg-white/5 border-white/10 mt-1 font-mono" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Janela início (h)</label>
                      <NumberInput min={0} max={23} fallback={9} value={startHour} onChange={n => setStartHour(n)} className="bg-white/5 border-white/10 mt-1 font-mono" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Janela fim (h)</label>
                      <NumberInput min={0} max={23} fallback={20} value={endHour} onChange={n => setEndHour(n)} className="bg-white/5 border-white/10 mt-1 font-mono" />
                    </div>
                  </div>
                  <p className="text-[9px] text-muted-foreground">
                    💡 Recomendado: 30-60s entre msgs. Conta nova: 40-50 msgs/dia. Janela 9h-20h. Backoff automático em erro 429.
                  </p>

                  {/* Personalização com IA */}
                  <div className="pt-3 border-t border-white/5 space-y-3">
                    <label
                      onClick={() => setPersonalizeWithAI(!personalizeWithAI)}
                      className={cn(
                        "flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all",
                        personalizeWithAI ? "bg-cyan-500/10 border-cyan-500/30" : "bg-black/30 border-white/5 hover:border-white/20"
                      )}
                    >
                      <div className={cn("w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 mt-0.5", personalizeWithAI ? "bg-cyan-500 border-cyan-500" : "border-white/30")}>
                        {personalizeWithAI && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold text-cyan-200">Personalizar mensagem com IA</p>
                        <p className="text-[9px] text-cyan-100/60 leading-relaxed">
                          Gemini reescreve o template pra cada lead, ajustando ao nome/ramo. Mais natural, MENOS chance de banimento por mensagem repetida (boa prática), mas usa tokens.
                        </p>
                      </div>
                    </label>

                    {personalizeWithAI && (
                      <label
                        onClick={() => setUseWebSearch(!useWebSearch)}
                        className={cn(
                          "flex items-start gap-3 p-3 ml-6 rounded-xl border cursor-pointer transition-all",
                          useWebSearch ? "bg-purple-500/10 border-purple-500/30" : "bg-black/30 border-white/5 hover:border-white/20"
                        )}
                      >
                        <div className={cn("w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 mt-0.5", useWebSearch ? "bg-purple-500 border-purple-500" : "border-white/30")}>
                          {useWebSearch && <CheckCircle2 className="w-3 h-3 text-white" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] font-bold text-purple-200 flex items-center gap-1.5">
                            <Globe className="w-3 h-3" /> Pesquisar empresa na internet
                          </p>
                          <p className="text-[9px] text-purple-100/60 leading-relaxed">
                            A IA faz 1 busca web (DuckDuckGo) sobre cada empresa antes de gerar a msg, pra citar algo específico. Mais lento (≈3-5s/lead).
                          </p>
                        </div>
                      </label>
                    )}

                    {personalizeWithAI && (
                      <div className="ml-6 space-y-3 p-4 rounded-xl bg-cyan-500/5 border border-cyan-500/20">
                        <div className="flex items-center gap-2">
                          <Bot className="w-4 h-4 text-cyan-300" />
                          <p className="text-[10px] font-black uppercase tracking-widest text-cyan-300">
                            Agente + Prompt da IA
                          </p>
                        </div>

                        <div>
                          <div className="flex items-center justify-between">
                            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Modelo Gemini desta campanha</label>
                            <button
                              type="button"
                              onClick={loadAiModels}
                              disabled={loadingAiModels}
                              className="text-[9px] font-black uppercase tracking-widest text-cyan-300 hover:text-cyan-200 disabled:opacity-50"
                              title="Recarregar lista de modelos"
                            >
                              {loadingAiModels ? "Carregando…" : "↻ Atualizar"}
                            </button>
                          </div>
                          <select
                            value={aiModel}
                            onChange={e => setAiModel(e.target.value)}
                            className="w-full mt-1 bg-white/5 border border-white/10 text-white h-11 rounded-xl text-sm px-3 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                          >
                            <option value="" className="bg-neutral-900 text-muted-foreground">
                              {aiModels.length === 0
                                ? (loadingAiModels ? "Carregando modelos…" : "Clique em atualizar ↻ para listar")
                                : "Escolha um modelo…"}
                            </option>
                            {aiModels.map(m => (
                              <option key={m.id} value={m.id} className="bg-neutral-900 text-white">
                                {m.name || m.id}
                              </option>
                            ))}
                          </select>
                          <p className="text-[9px] text-muted-foreground mt-1 leading-relaxed">
                            Cada campanha tem seu próprio agente exclusivo (modelo + prompt abaixo). A API Key do Gemini é a central (configurada em{" "}
                            <a href="/configuracoes" className="text-primary underline decoration-dotted">Configurações</a>).
                          </p>
                        </div>

                        <div>
                          <div className="flex items-center justify-between">
                            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                              <Sparkles className="w-3 h-3 text-cyan-300" /> Prompt da personalização
                            </label>
                            <button
                              type="button"
                              onClick={() => setAiPrompt(DEFAULT_AI_PROMPT)}
                              className="text-[9px] font-black uppercase tracking-widest text-cyan-300 hover:text-cyan-200"
                              title="Restaurar prompt padrão"
                            >
                              Restaurar padrão
                            </button>
                          </div>
                          <Textarea
                            value={aiPrompt}
                            onChange={e => setAiPrompt(e.target.value)}
                            placeholder="Instruções que a IA vai seguir ao reescrever cada mensagem…"
                            className="mt-1 bg-black/40 border-white/10 h-40 font-mono text-[11px]"
                          />
                          <p className="text-[9px] text-muted-foreground mt-1 leading-relaxed">
                            Esse texto vira o "system prompt" da IA ao reescrever cada mensagem. A MENSAGEM-BASE (template) + DADOS DO LEAD são anexados automaticamente; você só precisa descrever tom e abordagem aqui.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Lead Intelligence batch — só aparece quando "personalizar com IA"
                  está ligado E há leads selecionados. O briefing é injetado
                  automaticamente pelo campaign-worker quando a msg sair. */}
              {personalizeWithAI && selectedLeadIds.size > 0 && !editingCampaignId && (
                <Card className="border-cyan-500/20 bg-gradient-to-br from-cyan-500/5 to-purple-500/5">
                  <CardContent className="p-4">
                    <p className="text-[10px] font-black text-cyan-300 uppercase tracking-widest mb-2 flex items-center gap-2">
                      <Bot className="w-3.5 h-3.5" /> Lead Intelligence (opcional)
                    </p>
                    <p className="text-[11px] text-cyan-100/80 mb-3 leading-relaxed">
                      Faz a IA estudar cada lead (site, Maps, busca web sobre concorrentes da região) ANTES do disparo. As mensagens personalizadas saem muito mais cirúrgicas. Cache 30 dias.
                    </p>
                    <LeadIntelligenceBatch leadIds={Array.from(selectedLeadIds)} />
                  </CardContent>
                </Card>
              )}

              <div className="flex gap-3">
                <Button
                  onClick={() => handleCreate(false)}
                  disabled={creating || !name || !instanceName || (!editingCampaignId && selectedLeadIds.size === 0)}
                  className="flex-1 h-12 bg-white/5 border border-white/10 text-white hover:bg-white/10 font-black uppercase tracking-widest text-[11px]"
                >
                  {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Salvar Rascunho
                </Button>
                <Button
                  onClick={() => handleCreate(true)}
                  disabled={creating || !name || !instanceName || (!editingCampaignId && selectedLeadIds.size === 0)}
                  className="flex-1 h-12 bg-gradient-to-r from-amber-500 to-orange-600 text-black hover:from-amber-400 hover:to-orange-500 font-black uppercase tracking-widest text-[11px]"
                >
                  {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                  {editingCampaignId
                    ? "Salvar e Iniciar"
                    : `Salvar e Iniciar (${selectedLeadIds.size} leads)`}
                </Button>
              </div>
            </div>

            {/* Coluna direita: leads (escondida em edição) */}
            <div className={cn("space-y-3", editingCampaignId && "hidden lg:block lg:opacity-40 lg:pointer-events-none")}>
              <Card className="border-white/10 bg-white/[0.02]">
                <CardHeader><CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
                  <Users className="w-4 h-4" /> Leads ({filteredLeads.length})
                  {editingCampaignId && <span className="text-[9px] font-black text-blue-400 ml-1">(não editável)</span>}
                </CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Buscar por nome / ramo / telefone…"
                      value={leadsSearch}
                      onChange={e => setLeadsSearch(e.target.value)}
                      className="pl-10 bg-white/5 border-white/10 h-10"
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 text-white h-9 rounded-lg text-xs px-3 focus:outline-none"
                  >
                    <option value="all" className="bg-neutral-900">Todos status</option>
                    <option value="novo" className="bg-neutral-900">Novo</option>
                    <option value="interessado" className="bg-neutral-900">Interessado</option>
                    <option value="follow-up" className="bg-neutral-900">Follow-up</option>
                  </select>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setSelectedLeadIds(new Set(filteredLeads.map(l => l.id)))} className="text-[10px] font-black uppercase">
                      Marcar todos
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelectedLeadIds(new Set())} className="text-[10px] font-black uppercase">
                      Limpar
                    </Button>
                    <Badge className="ml-auto bg-amber-500/20 text-amber-300 border-amber-500/30">{selectedLeadIds.size} selecionados</Badge>
                  </div>

                  <div className="max-h-[480px] overflow-y-auto space-y-1.5 pr-1">
                    {filteredLeads.map(l => {
                      const checked = selectedLeadIds.has(l.id);
                      return (
                        <label
                          key={l.id}
                          onClick={() => {
                            const next = new Set(selectedLeadIds);
                            if (checked) next.delete(l.id); else next.add(l.id);
                            setSelectedLeadIds(next);
                          }}
                          className={cn(
                            "flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-all",
                            checked ? "bg-amber-500/10 border-amber-500/30" : "bg-white/5 border-white/5 hover:border-white/20"
                          )}
                        >
                          <div className={cn("w-3.5 h-3.5 mt-0.5 rounded border flex items-center justify-center shrink-0", checked ? "bg-amber-500 border-amber-500" : "border-white/30")}>
                            {checked && <CheckCircle2 className="w-2.5 h-2.5 text-black" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-bold truncate">{l.nome_negocio || "(sem nome)"}</p>
                            <p className="text-[9px] text-muted-foreground truncate">{l.ramo_negocio} · {l.remoteJid?.replace(/@.*$/, "")}</p>
                          </div>
                        </label>
                      );
                    })}
                    {filteredLeads.length === 0 && (
                      <p className="text-center text-[11px] text-muted-foreground py-8">Nenhum lead com esses filtros.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
