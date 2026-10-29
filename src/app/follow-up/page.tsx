"use client";

import { useEffect, useState, useCallback, type ReactElement } from "react";
import styles from "./followup.module.css";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel,
} from "@/components/ui/select";
import { groupModels, PROVIDER_LABEL } from "@/lib/model-grouping";
import { useGatewayAccounts, accountsForFamily, accountsLabelSnippet } from "@/hooks/use-gateway-accounts";
import { Switch } from "@/components/ui/switch";
import {
  Repeat, Plus, Play, Pause, Trash2, Send, Loader2, Bot, Clock,
  UserPlus, CheckCircle2, AlertCircle, Sparkles, Eye, Search, X,
  MessageSquare, FileText, Pencil, ChevronRight, BarChart3, Workflow,
} from "lucide-react";
import { TEMPLATE_VARIABLES, renderTemplate } from "@/lib/template-vars";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

type Step = { day_offset: number; template: string };

type FollowupCampaign = {
  id: string;
  name: string;
  instance_name: string;
  ai_enabled: boolean;
  ai_model: string | null;
  ai_prompt: string | null;
  steps: Step[];
  min_interval_seconds: number;
  max_interval_seconds: number;
  allowed_start_hour: number;
  allowed_end_hour: number;
  auto_execute: boolean;
  source_status?: string; // coluna do kanban que abastece essa campanha
  status: string;
  total_enrolled: number;
  total_sent: number;
  total_responded: number;
  total_exhausted: number;
  created_at: string;
  last_error?: string | null;
  last_error_at?: string | null;
};

type FollowupTarget = {
  id: string;
  remote_jid: string;
  nome_negocio: string | null;
  current_step: number;
  last_sent_at: string | null;
  next_send_at: string | null;
  status: string;
  error_message: string | null;
};

const DEFAULT_STEPS: Step[] = [
  { day_offset: 2, template: "{{saudacao}}, {{nome_empresa}}! Ainda está por aí? Só voltando aqui pra saber se faz sentido falarmos." },
  { day_offset: 3, template: "{{saudacao}}! Imagino que a correria seja grande. Se preferir, me avisa o melhor horário que eu te chamo rapidinho." },
  { day_offset: 4, template: "Oi {{nome_empresa}}, último toque por aqui. Se não for o momento agora, tranquilo — só me diz e não te importuno mais." },
];

type FollowupLog = { id: number; followup_campaign_id: string; message: string; level: string; created_at: string };

const STATUS_LABELS: Record<string, string> = {
  active: "Ativa", paused: "Pausada", draft: "Rascunho", completed: "Concluída",
  waiting: "Aguardando", responded: "Respondeu", exhausted: "Sem resposta", failed: "Falhou", sent: "Enviado",
};

export default function FollowUpPage(): ReactElement {
  const [campaigns, setCampaigns] = useState<FollowupCampaign[]>([]);
  const gwAccounts = useGatewayAccounts();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  // Modo edição — quando preenchido, submit vira PATCH na campanha correspondente
  const [editingId, setEditingId] = useState<string | null>(null);

  // Logs ao vivo por campanha (card expansível)
  const [activeLogCampaignId, setActiveLogCampaignId] = useState<string | null>(null);
  const [logs, setLogs] = useState<FollowupLog[]>([]);
  const [latestLogByCampaign, setLatestLogByCampaign] = useState<Record<string, FollowupLog>>({});

  // Histórico de envios (targets detalhados)
  const [activeHistCampaignId, setActiveHistCampaignId] = useState<string | null>(null);
  const [histTargets, setHistTargets] = useState<any[]>([]);
  const [histFilter, setHistFilter] = useState<"all" | "waiting" | "responded" | "exhausted" | "failed">("all");

  // Form fields
  const [name, setName] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [instances, setInstances] = useState<any[]>([]);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiModel, setAiModel] = useState<string>("");
  const [aiModels, setAiModels] = useState<Array<{ id: string; name: string }>>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [defaultAiModel, setDefaultAiModel] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState(
    "Você é um SDR profissional fazendo follow-up no WhatsApp. Seja breve, humano e nunca insista demais. Se o cliente já demonstrou indefinição, ofereça uma saída fácil."
  );
  const [steps, setSteps] = useState<Step[]>(DEFAULT_STEPS);
  const [minSec, setMinSec] = useState(40);
  const [maxSec, setMaxSec] = useState(90);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(20);
  const [autoExecute, setAutoExecute] = useState(true);

  // Coluna do kanban que abastece a campanha. Default "follow-up" (estágio
  // padrão histórico). Quando o cliente cria kanban customizado via
  // Organizador IA, o dropdown abaixo permite apontar pra coluna real.
  const [sourceStatus, setSourceStatus] = useState<string>("follow-up");
  // Colunas do kanban deste cliente — carregadas de /api/kanban-columns.
  // Vira o dropdown no form. Inclui label e cor pra UI visual.
  const [kanbanCols, setKanbanCols] = useState<Array<{ status_key: string; label: string; color?: string | null }>>([]);

  // Details pane
  const [selected, setSelected] = useState<FollowupCampaign | null>(null);
  const [selTargets, setSelTargets] = useState<FollowupTarget[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [actioning, setActioning] = useState(false);

  // Preview de variáveis: lead "amostra" (real ou mock)
  const [previewLead, setPreviewLead] = useState<{
    remoteJid: string;
    nome_negocio: string | null;
    ramo_negocio: string | null;
  }>({ remoteJid: "5511999999999@s.whatsapp.net", nome_negocio: "Padaria São João", ramo_negocio: "Alimentação" });
  const [availableLeads, setAvailableLeads] = useState<any[]>([]);

  // Seleção específica de leads
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCampaignId, setPickerCampaignId] = useState<string | null>(null);
  const [pickerLeads, setPickerLeads] = useState<any[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerSelected, setPickerSelected] = useState<Set<number>>(new Set());
  const [pickerSearch, setPickerSearch] = useState("");

  // Preview de IA (por target)
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);

  const loadCampaigns = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetch("/api/followup", { cache: "no-store" });
      const d = await r.json();
      if (d.success) setCampaigns(d.campaigns || []);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadInstances = useCallback(async () => {
    try {
      const sessRes = await fetch("/api/auth/session");
      const session = await sessRes.json();
      setIsAdmin(!!session?.isAdmin && !session?.impersonating);
      setDefaultAiModel(session?.defaultAiModel || null);

      let connQuery = supabase.from("channel_connections").select("instance_name");
      if (session?.clientId) {
         connQuery = connQuery.eq("client_id", session.clientId);
      }
      const { data: conns } = await connQuery;
      const myInstances = new Set((conns || []).map((c: any) => c.instance_name));

      const r = await fetch("/api/whatsapp?instances=true");
      const d = await r.json();
      if (d.success && d.instances) {
        const filtered = d.instances.filter((i: any) => myInstances.has(i.instanceName));
        setInstances(filtered);
        if (!instanceName && filtered[0]) setInstanceName(filtered[0].instanceName);
      }

      // Carrega colunas do kanban do cliente — usadas no dropdown de
      // "qual coluna abastece essa campanha". Permite trabalhar com
      // kanban customizado feito via Organizador IA.
      try {
        let kanbanQ = supabase
          .from("kanban_columns")
          .select("status_key, label, color, order_index")
          .order("order_index", { ascending: true });
        if (session?.clientId) kanbanQ = kanbanQ.eq("client_id", session.clientId);
        const { data: cols } = await kanbanQ;
        if (cols && cols.length > 0) setKanbanCols(cols as any);
      } catch {}
    } catch {}
  }, [instanceName]);

  const loadModels = useCallback(async () => {
    try {
      const r = await fetch("/api/ai-models");
      const d = await r.json();
      if (d.success && Array.isArray(d.models)) {
        setAiModels(d.models);
        if (!aiModel && d.models[0]) setAiModel(d.models[0].id);
      }
    } catch {}
  }, [aiModel]);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const r = await fetch(`/api/followup/${id}`, { cache: "no-store" });
      const d = await r.json();
      if (d.success) {
        setSelected(d.campaign);
        setSelTargets(d.targets || []);
      }
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const loadAvailableLeads = useCallback(async () => {
    const sessRes = await fetch("/api/auth/session");
    const session = await sessRes.json();
    
    // Pega os leads em follow-up (mais úteis para preview) + alguns recentes como fallback
    let query = supabase
      .from("leads_extraidos")
      .select("id, remoteJid, nome_negocio, ramo_negocio, status")
      .order("created_at", { ascending: false })
      .limit(200);
      
    if (session?.clientId) {
       query = query.eq("client_id", session.clientId);
    }
    
    const { data } = await query;
    setAvailableLeads(data || []);
  }, []);

  useEffect(() => {
    loadCampaigns();
    loadInstances();
    loadModels();
    loadAvailableLeads();
    const t = setInterval(() => loadCampaigns(true), 8000);
    return () => clearInterval(t);
  }, [loadCampaigns, loadInstances, loadModels, loadAvailableLeads]);

  // ============================================================
  // Logs ao vivo por campanha — igual disparo em massa
  // ============================================================
  useEffect(() => {
    if (!activeLogCampaignId) { setLogs([]); return; }
    let cancelled = false;
    async function fetchInitial() {
      const { data } = await supabase
        .from("followup_logs")
        .select("*")
        .eq("followup_campaign_id", activeLogCampaignId)
        .order("created_at", { ascending: true })
        .limit(100);
      if (!cancelled) setLogs((data as any) || []);
    }
    fetchInitial();
    const channel = supabase
      .channel(`followup-logs-${activeLogCampaignId}`)
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "followup_logs",
        filter: `followup_campaign_id=eq.${activeLogCampaignId}`,
      }, (payload) => {
        setLogs(prev => [...prev, payload.new as any].slice(-100));
      })
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [activeLogCampaignId]);

  // Último log por campanha ativa (card "Agora…")
  useEffect(() => {
    const activeIds = campaigns.filter(c => c.status === "active").map(c => c.id);
    if (activeIds.length === 0) return;
    let cancelled = false;
    async function fetchLatest() {
      const { data } = await supabase
        .from("followup_logs")
        .select("*")
        .in("followup_campaign_id", activeIds)
        .order("created_at", { ascending: false })
        .limit(activeIds.length * 3);
      if (cancelled || !data) return;
      const byId: Record<string, FollowupLog> = {};
      for (const row of data as any[]) {
        if (!byId[row.followup_campaign_id]) byId[row.followup_campaign_id] = row;
      }
      setLatestLogByCampaign(prev => ({ ...prev, ...byId }));
    }
    fetchLatest();
    const t = setInterval(fetchLatest, 5000);
    const channel = supabase
      .channel(`followup-latest-${activeIds.join("-")}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "followup_logs" }, (payload) => {
        const row = payload.new as any;
        if (!activeIds.includes(row.followup_campaign_id)) return;
        setLatestLogByCampaign(prev => ({ ...prev, [row.followup_campaign_id]: row }));
      })
      .subscribe();
    return () => { cancelled = true; clearInterval(t); supabase.removeChannel(channel); };
  }, [campaigns]);

  // Histórico de envios (targets) do card ativo
  async function loadHistTargets(campaignId: string) {
    const r = await fetch(`/api/followup/${campaignId}`, { cache: "no-store" });
    const d = await r.json();
    if (d.success) setHistTargets(d.targets || []);
  }
  useEffect(() => {
    if (!activeHistCampaignId) return;
    loadHistTargets(activeHistCampaignId);
    const camp = campaigns.find(c => c.id === activeHistCampaignId);
    if (camp?.status !== "active") return;
    const t = setInterval(() => loadHistTargets(activeHistCampaignId), 5000);
    return () => clearInterval(t);
  }, [activeHistCampaignId, campaigns]);

  // ============================================================
  // Reset e edição do formulário
  // ============================================================
  const resetForm = () => {
    setEditingId(null);
    setName("");
    setSteps(DEFAULT_STEPS);
    setAiEnabled(true);
    setAiPrompt("Você é um SDR profissional fazendo follow-up no WhatsApp. Seja breve, humano e nunca insista demais. Se o cliente já demonstrou indefinição, ofereça uma saída fácil.");
    setMinSec(40); setMaxSec(90);
    setStartHour(9); setEndHour(20);
    setAutoExecute(true);
    setSourceStatus("follow-up");
  };

  const openEdit = (c: FollowupCampaign) => {
    setEditingId(c.id);
    setName(c.name);
    setInstanceName(c.instance_name);
    setAiEnabled(!!c.ai_enabled);
    setAiModel(c.ai_model || "");
    setAiPrompt(c.ai_prompt || "");
    setSteps((c.steps && c.steps.length > 0 ? c.steps : DEFAULT_STEPS) as Step[]);
    setMinSec(c.min_interval_seconds);
    setMaxSec(c.max_interval_seconds);
    setStartHour(c.allowed_start_hour);
    setEndHour(c.allowed_end_hour);
    setAutoExecute(!!c.auto_execute);
    setSourceStatus((c as any).source_status || "follow-up");
    setShowForm(true);
  };

  // Helper: renderiza um template com o lead de preview
  const previewOf = useCallback(
    (template: string) =>
      renderTemplate(template, {
        remoteJid: previewLead.remoteJid,
        nome_negocio: previewLead.nome_negocio,
        ramo_negocio: previewLead.ramo_negocio,
      }),
    [previewLead]
  );

  // Retorna o valor atual de uma variável do template para mostrar no chip
  const variableValue = useCallback(
    (key: string) => {
      const sample = renderTemplate(`{{${key}}}`, {
        remoteJid: previewLead.remoteJid,
        nome_negocio: previewLead.nome_negocio,
        ramo_negocio: previewLead.ramo_negocio,
      });
      return sample || "(vazio)";
    },
    [previewLead]
  );

  // ============================================================
  // Seleção específica de leads (picker)
  // ============================================================

  const openLeadPicker = async (campaignId: string) => {
    setPickerCampaignId(campaignId);
    setPickerSelected(new Set());
    setPickerSearch("");
    setPickerOpen(true);
    setPickerLoading(true);
    try {
      const sessRes = await fetch("/api/auth/session");
      const session = await sessRes.json();

      // Prioriza leads em status follow-up; traz também demais (pro usuário escolher à vontade)
      let q1 = supabase
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio, status, created_at")
        .eq("status", "follow-up")
        .order("created_at", { ascending: false })
        .limit(1000);
        
      let q2 = supabase
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio, status, created_at")
        .neq("status", "follow-up")
        .not("status", "in", "(fechado,sem_interesse,descartado)")
        .order("created_at", { ascending: false })
        .limit(500);

      if (session?.clientId) {
        q1 = q1.eq("client_id", session.clientId);
        q2 = q2.eq("client_id", session.clientId);
      }
      
      const [{ data: a }, { data: b }] = await Promise.all([q1, q2]);
      
      const merged = [...(a || []), ...(b || [])];
      setPickerLeads(merged);
    } finally {
      setPickerLoading(false);
    }
  };

  const filteredPickerLeads = pickerLeads.filter((l) => {
    if (!pickerSearch.trim()) return true;
    const s = pickerSearch.toLowerCase();
    return (
      (l.nome_negocio || "").toLowerCase().includes(s) ||
      (l.remoteJid || "").toLowerCase().includes(s) ||
      (l.ramo_negocio || "").toLowerCase().includes(s)
    );
  });

  const pickerAllVisibleSelected =
    filteredPickerLeads.length > 0 && filteredPickerLeads.every((l) => pickerSelected.has(l.id));

  const togglePickerOne = (id: number) => {
    setPickerSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePickerAllVisible = () => {
    setPickerSelected((prev) => {
      const next = new Set(prev);
      const everyOn = filteredPickerLeads.every((l) => next.has(l.id));
      if (everyOn) filteredPickerLeads.forEach((l) => next.delete(l.id));
      else filteredPickerLeads.forEach((l) => next.add(l.id));
      return next;
    });
  };

  const confirmEnrollSelected = async () => {
    if (!pickerCampaignId || pickerSelected.size === 0) {
      setMsg({ type: "err", text: "Selecione ao menos 1 lead." });
      return;
    }
    setActioning(true);
    try {
      const r = await fetch(`/api/followup/${pickerCampaignId}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_ids: Array.from(pickerSelected) }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      setMsg({ type: "ok", text: `${d.enrolled} lead(s) adicionados.` });
      setPickerOpen(false);
      await loadCampaigns();
      if (selected?.id === pickerCampaignId) await loadDetail(pickerCampaignId);
    } catch (err: any) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setActioning(false);
    }
  };

  // ============================================================
  // Preview de IA (mostra histórico + mensagem final antes de enviar)
  // ============================================================

  const openPreview = async (campaignId: string, target: FollowupTarget) => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const r = await fetch(`/api/followup/${campaignId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: target.id }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      setPreviewData(d.preview);
    } catch (err: any) {
      setPreviewData({ error: err.message });
    } finally {
      setPreviewLoading(false);
    }
  };

  const addStep = () =>
    setSteps((prev) => [
      ...prev,
      { day_offset: (prev[prev.length - 1]?.day_offset || 2) + 1, template: "" },
    ]);
  const removeStep = (idx: number) => setSteps((prev) => prev.filter((_, i) => i !== idx));
  const updateStep = (idx: number, patch: Partial<Step>) =>
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const submitCreate = async () => {
    setMsg(null);
    if (!name.trim() || !instanceName || steps.length === 0) {
      setMsg({ type: "err", text: "Preencha nome, instância e pelo menos 1 passo." });
      return;
    }
    for (const s of steps) {
      if (!s.template.trim()) {
        setMsg({ type: "err", text: "Todos os passos precisam de mensagem." });
        return;
      }
      if (!Number.isFinite(s.day_offset) || s.day_offset < 1) {
        setMsg({ type: "err", text: "Cada passo precisa de 'após X dias' >= 1." });
        return;
      }
    }
    setCreating(true);
    try {
      const payload = {
        name,
        instance_name: instanceName,
        ai_enabled: aiEnabled,
        ai_model: aiModel,
        ai_prompt: aiPrompt,
        steps,
        min_interval_seconds: minSec,
        max_interval_seconds: maxSec,
        allowed_start_hour: startHour,
        allowed_end_hour: endHour,
        auto_execute: autoExecute,
        source_status: sourceStatus,
      };
      const r = editingId
        ? await fetch(`/api/followup/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/followup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Erro ao salvar");
      setMsg({ type: "ok", text: editingId ? "Campanha atualizada." : "Campanha criada." });
      setShowForm(false);
      resetForm();
      await loadCampaigns();
      if (selected && editingId === selected.id) await loadDetail(editingId);
    } catch (err: any) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setCreating(false);
    }
  };

  const setStatus = async (id: string, status: "active" | "paused") => {
    setActioning(true);
    try {
      await fetch(`/api/followup/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await loadCampaigns();
      if (selected?.id === id) await loadDetail(id);
    } finally {
      setActioning(false);
    }
  };

  const toggleAuto = async (id: string, auto_execute: boolean) => {
    setActioning(true);
    try {
      await fetch(`/api/followup/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_execute }),
      });
      await loadCampaigns();
      if (selected?.id === id) await loadDetail(id);
    } finally {
      setActioning(false);
    }
  };

  const deleteCampaign = async (id: string) => {
    if (!confirm("Excluir esta campanha de follow-up? Targets e histórico local serão removidos.")) return;
    setActioning(true);
    try {
      await fetch(`/api/followup/${id}`, { method: "DELETE" });
      if (selected?.id === id) setSelected(null);
      await loadCampaigns();
    } finally {
      setActioning(false);
    }
  };

  const enrollAllFollowUp = async (id: string) => {
    setActioning(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/followup/${id}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all_in_followup: true }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      setMsg({ type: "ok", text: `${d.enrolled} lead(s) adicionados.` });
      await loadCampaigns();
      if (selected?.id === id) await loadDetail(id);
    } catch (err: any) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setActioning(false);
    }
  };

  const tickNow = async (id: string) => {
    setActioning(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/followup/${id}/tick`, { method: "POST" });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      setMsg({ type: "ok", text: `${d.processed} target(s) processados.` });
      await loadCampaigns();
      if (selected?.id === id) await loadDetail(id);
    } catch (err: any) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setActioning(false);
    }
  };

  const insertVarIntoStep = (idx: number, variable: string) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, template: (s.template || "") + `{{${variable}}}` } : s))
    );
  };

  const targetBadge = (s: string) =>
    s === "responded"
      ? "bg-green-500/10 text-green-400"
      : s === "exhausted"
      ? "bg-red-500/10 text-red-400"
      : s === "failed"
      ? "bg-red-500/10 text-red-300"
      : s === "waiting"
      ? "bg-blue-500/10 text-blue-300"
      : "bg-white/5 text-white/70";

  return (
    <div className={cn(styles.page, "flex flex-col h-[100dvh] overflow-hidden")}>
      <Header />
      <main className={cn(styles.content, "flex-1 w-full max-w-7xl mx-auto overflow-y-auto")}>
        <div className={styles.heading}>
          <div>
            <h1>Follow-up automático</h1>
            <p>Retome conversas com sequências de mensagens e acompanhe cada retorno.</p>
          </div>
          <div className={styles.headingActions}>
            <a href="/follow-up-control" className={styles.secondaryAction}>
              <Bot className="w-4 h-4" aria-hidden="true" /> Controle Sarah
            </a>
            <Button onClick={() => { resetForm(); setMsg(null); setShowForm(true); }} className={styles.primaryAction}>
              <Plus className="w-4 h-4" aria-hidden="true" /> Nova campanha
            </Button>
          </div>
        </div>
        <div className={styles.overview} aria-label="Resumo das campanhas" aria-busy={loading}>
          <span><Repeat aria-hidden="true" /><strong>{campaigns.length}</strong> campanhas</span>
          <span><Play aria-hidden="true" /><strong>{campaigns.filter(c => c.status === "active").length}</strong> ativas</span>
          <span><MessageSquare aria-hidden="true" /><strong>{campaigns.reduce((sum, c) => sum + c.total_responded, 0)}</strong> respostas</span>
        </div>

        {msg && (
          <div
            role={msg.type === "err" ? "alert" : "status"}
            className={cn(styles.notice, msg.type === "err" && styles.errorNotice)}
          >
            {msg.text}
          </div>
        )}

        <div className={styles.workspace}>
          <section className={styles.campaignList} aria-label="Campanhas de follow-up">
            {loading ? (
              <div className="text-muted-foreground text-sm py-10 text-center">
                <Loader2 className="w-4 h-4 inline animate-spin mr-2" /> Carregando...
              </div>
            ) : campaigns.length === 0 ? (
              <div className={styles.empty}>
                <Repeat aria-hidden="true" />
                <h2>Continue a conversa</h2>
                <p>Crie sua primeira campanha para definir quando e como retomar o contato com seus leads.</p>
                <Button className={styles.primaryAction} onClick={() => { resetForm(); setMsg(null); setShowForm(true); }}>
                  <Plus className="w-4 h-4" aria-hidden="true" /> Criar primeira campanha
                </Button>
              </div>
            ) : (
              campaigns.map((c) => (
                <Card
                  key={c.id}
                  className={cn(styles.campaign, selected?.id === c.id && styles.selectedCampaign)}
                >
                  <CardContent className={styles.campaignBody}>
                    <div className={styles.campaignHeading}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className={styles.campaignTitle}>
                            <button type="button" onClick={() => loadDetail(c.id)} aria-label={`Ver detalhes de ${c.name}`} aria-pressed={selected?.id === c.id}>{c.name}</button>
                          </h2>
                          <Badge className={styles.status} data-status={c.status}>
                            {STATUS_LABELS[c.status] || c.status}
                          </Badge>
                          {c.auto_execute && (
                            <Badge className={styles.status}>
                              Automática
                            </Badge>
                          )}
                          {c.ai_enabled && (
                            <Badge className={styles.status}>
                              <Sparkles className="w-2.5 h-2.5" /> IA
                            </Badge>
                          )}
                        </div>
                        <p className={styles.metadata}>
                          {c.instance_name} · {c.steps.length} etapas · {c.allowed_start_hour}h–{c.allowed_end_hour}h
                        </p>
                        {/* Coluna do kanban que abastece — mostra qual pool a
                            campanha está mirando. Crítico pra cliente que tem
                            kanban customizado entender de onde os leads vêm. */}
                        {(() => {
                          const src = c.source_status || "follow-up";
                          const col = kanbanCols.find(k => k.status_key === src);
                          const label = col?.label || src;
                          const color = col?.color || "#eab308";
                          return (
                            <div className={styles.source}>
                              <Workflow className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>Origem:</span>
                              <span className={styles.sourceLabel}>
                                <span className="w-1 h-1 rounded-full" style={{ background: color }} />
                                {label}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                      <div
                        className={styles.iconActions}
                      >
                        {c.status === "active" ? (
                          <Button size="icon" variant="ghost" className={styles.iconAction} onClick={() => setStatus(c.id, "paused")} disabled={actioning} aria-label={`Pausar ${c.name}`} title="Pausar campanha">
                            <Pause className="w-3.5 h-3.5" />
                          </Button>
                        ) : (
                          <Button size="icon" variant="ghost" className={styles.iconAction} onClick={() => setStatus(c.id, "active")} disabled={actioning} aria-label={`Ativar ${c.name}`} title="Ativar campanha">
                            <Play className="w-3.5 h-3.5 text-green-400" />
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" className={styles.iconAction} onClick={() => { setMsg(null); openEdit(c); }} disabled={actioning} aria-label={`Editar ${c.name}`} title="Editar campanha">
                          <Pencil className="w-3.5 h-3.5 text-blue-400" />
                        </Button>
                        <Button size="icon" variant="ghost" className={cn(styles.iconAction, styles.dangerAction)} onClick={() => deleteCampaign(c.id)} disabled={actioning} aria-label={`Excluir ${c.name}`} title="Excluir campanha">
                          <Trash2 className="w-3.5 h-3.5 text-red-400" />
                        </Button>
                      </div>
                    </div>

                    <div className={styles.metrics}>
                      <div className="p-2 rounded-lg bg-white/5">
                        <p className="text-[9px] uppercase text-muted-foreground">Clientes</p>
                        <p className="text-sm font-black text-white">{c.total_enrolled}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-white/5">
                        <p className="text-[9px] uppercase text-muted-foreground">Enviados</p>
                        <p className="text-sm font-black text-white">{c.total_sent}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-green-500/5">
                        <p className="text-[9px] uppercase text-green-400">Responderam</p>
                        <p className="text-sm font-black text-green-400">{c.total_responded}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-red-500/5">
                        <p className="text-[9px] uppercase text-red-400">Esgotados</p>
                        <p className="text-sm font-black text-red-400">{c.total_exhausted}</p>
                      </div>
                    </div>

                    {/* Banner "Agora..." com último log */}
                    {c.status === "active" && latestLogByCampaign[c.id] && (
                      <div className={styles.activity}>
                        <span className={styles.activityDot} aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className={styles.activityTitle}>
                            Última atividade · {new Date(latestLogByCampaign[c.id].created_at).toLocaleTimeString()}
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

                    {/* Último erro persistente */}
                    {c.last_error && (
                      <div className={cn(styles.notice, styles.errorNotice, "mt-3 flex items-start gap-2")}>
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[9px] font-black uppercase tracking-widest text-red-400">
                            Último erro{c.last_error_at ? ` · ${new Date(c.last_error_at).toLocaleString("pt-BR")}` : ""}
                          </p>
                          <p className="text-[11px] text-red-200/90 break-words mt-0.5">{c.last_error}</p>
                        </div>
                      </div>
                    )}

                    {/* Logs ao vivo + histórico de envios */}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActiveLogCampaignId(activeLogCampaignId === c.id ? null : c.id)}
                        aria-expanded={activeLogCampaignId === c.id}
                        aria-controls={`logs-${c.id}`}
                        className={styles.disclosure}
                      >
                        <span className="flex items-center gap-2">
                          <BarChart3 className="w-3 h-3 text-primary" />
                          {activeLogCampaignId === c.id ? "Ocultar logs" : "Ver logs em tempo real"}
                        </span>
                        <ChevronRight className={cn("w-3 h-3 transition-transform", activeLogCampaignId === c.id && "rotate-90")} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActiveHistCampaignId(activeHistCampaignId === c.id ? null : c.id)}
                        aria-expanded={activeHistCampaignId === c.id}
                        aria-controls={`history-${c.id}`}
                        className={styles.disclosure}
                      >
                        <span className="flex items-center gap-2">
                          <MessageSquare className="w-3 h-3 text-cyan-300" />
                          {activeHistCampaignId === c.id ? "Ocultar envios" : `Ver envios (${c.total_sent || 0})`}
                        </span>
                        <ChevronRight className={cn("w-3 h-3 transition-transform", activeHistCampaignId === c.id && "rotate-90")} />
                      </Button>
                    </div>

                    {activeLogCampaignId === c.id && (
                      <div id={`logs-${c.id}`} className={styles.logPanel}>
                        <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2">
                          <span className="text-[9px] uppercase font-black text-muted-foreground">Histórico de execução</span>
                        </div>
                        <div className="flex-1 overflow-y-auto space-y-1.5 custom-scrollbar pr-2">
                          {logs.length === 0 && <p className="text-muted-foreground italic text-center py-8">Aguardando novos eventos...</p>}
                          {logs.map((log, i) => {
                            const color = log.level === "error" ? "text-red-400" : log.level === "success" ? "text-green-400" : log.level === "warning" ? "text-yellow-400" : "text-blue-300";
                            return (
                              <div key={log.id || i} className="flex gap-2 leading-relaxed">
                                <span className="text-muted-foreground shrink-0">[{new Date(log.created_at).toLocaleTimeString()}]</span>
                                <span className={cn("font-bold", color)}>{log.message}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {activeHistCampaignId === c.id && (
                      <div id={`history-${c.id}`} className={styles.historyPanel}>
                        <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2 gap-2 flex-wrap">
                          <span className="text-[9px] uppercase font-black text-muted-foreground">Histórico de envios</span>
                          <div className={styles.historyFilters} aria-label="Filtrar histórico de envios">
                            {(["all", "waiting", "responded", "exhausted", "failed"] as const).map(f => (
                              <button
                                key={f}
                                onClick={() => setHistFilter(f)}
                                aria-pressed={histFilter === f}
                              >
                                {f === "all" ? `Todos (${histTargets.length})`
                                  : f === "waiting" ? `Aguardando (${histTargets.filter(t => t.status === "waiting").length})`
                                  : f === "responded" ? `Responderam (${histTargets.filter(t => t.status === "responded").length})`
                                  : f === "exhausted" ? `Esgotados (${histTargets.filter(t => t.status === "exhausted").length})`
                                  : `Falhas (${histTargets.filter(t => t.status === "failed").length})`}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-2">
                          {histTargets.length === 0 ? (
                            <p className="text-muted-foreground italic text-center py-8 text-[11px]">Nenhum cliente inscrito ainda.</p>
                          ) : histTargets.filter(t => histFilter === "all" || t.status === histFilter).length === 0 ? (
                            <p className={styles.helper}>Nenhum envio neste filtro.</p>
                          ) : (
                            histTargets
                              .filter(t => histFilter === "all" || t.status === histFilter)
                              .map(t => {
                                const phone = (t.remote_jid || "").replace("@s.whatsapp.net", "");
                                const statusColor =
                                  t.status === "responded" ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" :
                                  t.status === "failed" ? "text-red-400 border-red-500/30 bg-red-500/10" :
                                  t.status === "exhausted" ? "text-yellow-400 border-yellow-500/30 bg-yellow-500/10" :
                                  t.status === "waiting" ? "text-blue-400 border-blue-500/30 bg-blue-500/10" :
                                  "text-muted-foreground border-white/10 bg-white/5";
                                return (
                                  <div key={t.id} className="rounded-lg bg-white/[0.02] border border-white/5 p-2.5 space-y-1.5">
                                    <div className="flex items-center justify-between gap-2 flex-wrap">
                                      <div className="min-w-0 flex-1">
                                        <p className="text-[11px] font-bold text-white truncate">{t.nome_negocio || "(sem nome)"}</p>
                                        <p className="text-[9px] text-muted-foreground font-mono">
                                          {phone} · etapa {t.current_step}/{c.steps.length}
                                          {t.last_sent_at ? ` · enviado ${new Date(t.last_sent_at).toLocaleString("pt-BR")}` : ""}
                                          {t.next_send_at ? ` · próximo ${new Date(t.next_send_at).toLocaleDateString("pt-BR")}` : ""}
                                        </p>
                                      </div>
                                      <span className={cn(styles.status, statusColor)}>
                                        {STATUS_LABELS[t.status] || t.status}
                                      </span>
                                    </div>
                                    {t.ai_input ? (
                                      <div className="space-y-1">
                                        <div className="rounded-md bg-white/[0.03] border border-white/5 px-2 py-1.5">
                                          <p className="text-[8px] font-black uppercase tracking-widest text-muted-foreground mb-0.5">Template → IA</p>
                                          <p className="text-[11px] text-white/60 whitespace-pre-wrap italic">{t.ai_input}</p>
                                        </div>
                                        <div className="rounded-md bg-cyan-500/5 border border-cyan-500/20 px-2 py-1.5">
                                          <p className="text-[8px] font-black uppercase tracking-widest text-cyan-300 mb-0.5 flex items-center gap-1">
                                            <Bot className="w-2.5 h-2.5" /> IA gerou (enviado)
                                          </p>
                                          <p className="text-[11px] text-white/90 whitespace-pre-wrap">{t.last_rendered}</p>
                                        </div>
                                      </div>
                                    ) : t.last_rendered && (
                                      <p className="text-[11px] text-white/80 whitespace-pre-wrap bg-black/20 rounded-md px-2 py-1.5 border border-white/5">{t.last_rendered}</p>
                                    )}
                                    {t.error_message && (
                                      <p className="text-xs text-red-300 bg-red-500/5 border border-red-500/20 rounded-md px-2 py-1"><AlertCircle className="inline w-3.5 h-3.5 mr-1" aria-hidden="true" />{t.error_message}</p>
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
              ))
            )}
          </section>

          <aside className={styles.detailColumn} aria-label="Detalhes da campanha" aria-busy={loadingDetail}>
            {!selected ? (
              <div className={styles.detailEmpty}>
                <h2>Detalhes da campanha</h2>
                <p>Selecione o nome de uma campanha para acompanhar os leads e gerenciar os envios.</p>
                <div className={styles.helper}><Clock className="w-4 h-4" aria-hidden="true" /> Os envios respeitam os dias e horários configurados.</div>
              </div>
            ) : (
              <Card className={styles.detailPanel}>
                <CardHeader className={styles.detailHeader}>
                  <CardTitle className={styles.detailTitle}>
                    <Repeat className="w-4 h-4 text-primary" /> {selected.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className={styles.detailBody}>
                  <div className={styles.optionRow}>
                    <div>
                      <label htmlFor="detail-auto" className={styles.fieldLabel}>Executar automaticamente</label>
                      <p className={styles.helper}>A cada 2 minutos, respeitando a janela de envio.</p>
                    </div>
                    <Switch
                      id="detail-auto"
                      checked={selected.auto_execute}
                      onCheckedChange={(v) => toggleAuto(selected.id, v)}
                      disabled={actioning}
                    />
                  </div>

                  <div className={styles.detailActions}>
                    <Button
                      variant="outline"
                      size="sm"
                      className={styles.secondaryAction}
                      onClick={() => enrollAllFollowUp(selected.id)}
                      disabled={actioning}
                      title="Adiciona todos os clientes do CRM em status follow-up"
                    >
                      <UserPlus className="w-3.5 h-3.5" aria-hidden="true" /> Adicionar do CRM
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className={styles.secondaryAction}
                      onClick={() => openLeadPicker(selected.id)}
                      disabled={actioning}
                      title="Selecionar clientes específicos"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Escolher
                    </Button>
                    <Button
                      size="sm"
                      className={styles.primaryAction}
                      onClick={() => tickNow(selected.id)}
                      disabled={actioning}
                    >
                      {actioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Processar agora
                    </Button>
                  </div>

                  <div>
                    <p className={styles.fieldLabel}>
                      Leads ({selTargets.length})
                    </p>
                    <div className="max-h-[420px] overflow-y-auto space-y-2 custom-scrollbar pr-1">
                      {loadingDetail ? (
                        <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                      ) : selTargets.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-4 text-center">
                          Nenhum lead adicionado. Use <strong>Adicionar do CRM</strong> ou <strong>Escolher</strong> para começar.
                        </p>
                      ) : (
                        selTargets.map((t) => (
                          <div key={t.id} className={styles.target}>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-bold text-white truncate flex-1">
                                {t.nome_negocio || t.remote_jid.split("@")[0]}
                              </p>
                              <Badge className={cn(styles.status, targetBadge(t.status))}>
                                {STATUS_LABELS[t.status] || t.status}
                              </Badge>
                              <Button
                                size="icon"
                                variant="ghost"
                                className={styles.iconAction}
                                aria-label={`Pré-visualizar mensagem para ${t.nome_negocio || t.remote_jid.split("@")[0]}`}
                                onClick={() => openPreview(selected.id, t)}
                                title="Ver o que a IA vai enviar (histórico + mensagem final)"
                              >
                                <Eye className="w-3 h-3" />
                              </Button>
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                              passo {t.current_step}/{selected.steps.length} ·{" "}
                              {t.next_send_at
                                ? `próx. ${new Date(t.next_send_at).toLocaleDateString("pt-BR")}`
                                : "sem agendamento"}
                            </p>
                            {t.error_message && (
                              <p className="text-[10px] text-red-300 mt-1 truncate">
                                <AlertCircle className="w-2.5 h-2.5 inline mr-1" />
                                {t.error_message}
                              </p>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </aside>
        </div>
      </main>

      {/* Dialog: criar campanha */}
      <Dialog open={showForm} onOpenChange={(o) => !creating && setShowForm(o)}>
        <DialogContent className={cn(styles.page, styles.formDialog)}>
          <div className={styles.dialogHeader}>
            <DialogTitle className={styles.dialogTitle}>
              {editingId ? "Editar campanha de follow-up" : "Nova campanha de follow-up"}
            </DialogTitle>
            <DialogDescription className={styles.helper}>
              Defina a sequência de contato. Quando o lead responde, o follow-up é interrompido. Sem resposta após a última etapa, ele vai para Sem Interesse.
            </DialogDescription>
          </div>

          <div className={styles.formBody}>
            <section className={styles.connectionSection} aria-labelledby="connection-heading">
              <h2 id="connection-heading" className={styles.sectionTitle}>Campanha e conexão</h2>
              <div className={styles.fieldGrid}>
              <div>
                <label htmlFor="campaign-name" className={styles.fieldLabel}>Nome da campanha</label>
                <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Retorno comercial · Outubro" className={styles.field} aria-required="true" />
              </div>
              <div>
                <label htmlFor="campaign-instance" className={styles.fieldLabel}>Conta do WhatsApp</label>
                {instances.length === 0 ? (
                  <div className="mt-1 text-xs text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5">
                    Nenhuma conta disponível. <a href="/whatsapp" className="underline underline-offset-4">Conecte seu WhatsApp</a> antes de criar a campanha.
                  </div>
                ) : (
                  <Select value={instanceName} onValueChange={(v) => setInstanceName(v as string)}>
                    <SelectTrigger id="campaign-instance" className={styles.field}>
                      <SelectValue placeholder="Escolher conta">{instances.find(i => i.instanceName === instanceName)?.profileName || instanceName}</SelectValue>
                    </SelectTrigger>
                    <SelectContent className={styles.selectPopup}>
                      {instances.map((i, idx) => (
                        <SelectItem key={idx} value={i.instanceName}>
                          {i.profileName || i.instanceName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            <div className={styles.sourceField}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <Workflow className="w-4 h-4 text-amber-300" />
                  <label htmlFor="campaign-source" className={styles.fieldLabel}>Origem dos leads no Kanban</label>
                </div>
                {kanbanCols.length > 0 && (() => {
                  const sel = kanbanCols.find(c => c.status_key === sourceStatus);
                  return sel ? (
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded ring-1 flex items-center gap-1.5"
                      style={{ background: `${sel.color || "#eab308"}20`, color: sel.color || "#fbbf24", borderColor: `${sel.color || "#eab308"}40` } as any}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: sel.color || "#eab308" }} />
                      {sel.label}
                    </span>
                  ) : null;
                })()}
              </div>
              <p className={styles.helper}>Escolha a coluna que abastece esta campanha. Apenas os leads dessa coluna recebem o follow-up.</p>
              {kanbanCols.length === 0 ? (
                <div className="text-[11px] text-zinc-400 italic">
                  Sem colunas disponíveis. Origem atual: <code>follow-up</code>.
                </div>
              ) : (
                <Select value={sourceStatus} onValueChange={(v) => setSourceStatus(v as string)}>
                  <SelectTrigger id="campaign-source" className={styles.field}>
                    <SelectValue placeholder="Escolher coluna do Kanban">{kanbanCols.find(c => c.status_key === sourceStatus)?.label || sourceStatus}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className={cn(styles.selectPopup, "max-h-72")}>
                    {kanbanCols.map((c) => (
                      <SelectItem key={c.status_key} value={c.status_key}>
                        <span className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color || "#71717a" } as any} />
                          <span className="font-bold">{c.label}</span>
                          <span className="text-[9px] font-mono text-muted-foreground">{c.status_key}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            </section>

            <section className={styles.aiSection} aria-labelledby="ai-heading">
              <div className={styles.optionRow}>
                <div>
                  <h2 id="ai-heading" className={styles.sectionTitle}>Personalização com IA</h2>
                  <label htmlFor="campaign-ai" className={styles.helper}>Adaptar a mensagem ao histórico de cada conversa</label>
                </div>
                <Switch id="campaign-ai" checked={aiEnabled} onCheckedChange={setAiEnabled} />
              </div>
              {aiEnabled && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="campaign-model" className={styles.fieldLabel}>Modelo de IA</label>
                    {aiModels.length === 0 && isAdmin ? (
                      <div className="mt-1 text-xs text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5">
                        Nenhum modelo disponível. Configure a API Key Gemini em <strong>Configurações → Organizador IA</strong>.
                      </div>
                    ) : (
                      <Select
                        value={isAdmin ? aiModel : (defaultAiModel || "")}
                        onValueChange={(v) => setAiModel(v as string)}
                        disabled={!isAdmin}
                      >
                        <SelectTrigger id="campaign-model" className={styles.field}>
                          <SelectValue placeholder="Escolher modelo">{aiModels.find(m => m.id === (isAdmin ? aiModel : defaultAiModel))?.name || (isAdmin ? aiModel : defaultAiModel) || "Escolher modelo"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent className={cn(styles.selectPopup, "max-h-[40vh]")}>
                          {!isAdmin && defaultAiModel && !aiModels.some(m => m.id === defaultAiModel) && (
                            <SelectItem key={defaultAiModel} value={defaultAiModel}>
                              {defaultAiModel}
                            </SelectItem>
                          )}
                          {groupModels(aiModels as any).flatMap((group) =>
                            group.subgroups.map((sub) => (
                              <SelectGroup key={group.provider + "|" + (sub.label || "_")}>
                                <SelectLabel className="text-[10px] uppercase tracking-wider opacity-70">
                                  {(() => {
                                    const base = (PROVIDER_LABEL[group.provider] || group.provider) + (sub.label ? ` · ${sub.label === "Grátis" ? "★ Grátis" : sub.label}` : "");
                                    if (group.provider === "gateway") {
                                      const accs = accountsForFamily(gwAccounts, sub.label);
                                      if (accs.length) return `${base} — ${accountsLabelSnippet(accs)}`;
                                    }
                                    return base;
                                  })()}
                                </SelectLabel>
                                {sub.items.map((m) => {
                                  const raw = (m as any).rawId || m.id;
                                  return (
                                    <SelectItem key={m.id} value={m.id}>
                                      {m.name && m.name !== raw ? `${raw} — ${m.name}` : raw}
                                    </SelectItem>
                                  );
                                })}
                              </SelectGroup>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    )}
                    {!isAdmin && (
                      <p className="text-[10px] text-purple-300/80 mt-1.5 flex items-center gap-1">
                        <span>Modelo definido pelo administrador:</span>
                        <span className="font-mono font-bold bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20">{defaultAiModel || "Não configurado"}</span>
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="campaign-prompt" className={styles.fieldLabel}>Instruções para a IA</label>
                    <Textarea
                      id="campaign-prompt"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      rows={6}
                      className={cn(styles.field, styles.prompt)}
                      placeholder="Ex: Você é um SDR cordial, vai reengajar o cliente de forma humana..."
                    />
                  </div>
                </div>
              )}
            </section>

            <section className={styles.sequenceSection} aria-labelledby="sequence-heading">
            <div className={styles.sectionHeading}>
              <div><h2 id="sequence-heading" className={styles.sectionTitle}>Sequência de mensagens</h2><p className={styles.helper}>Defina os dias de espera e a mensagem de cada etapa.</p></div>
              <Button size="sm" variant="outline" onClick={addStep} className={styles.secondaryAction}><Plus className="w-4 h-4" aria-hidden="true" /> Adicionar etapa</Button>
            </div>
            <div className={styles.sampleLead}>
              <label htmlFor="preview-lead" className={styles.fieldLabel}>Lead para pré-visualização</label>
              <Select
                value={availableLeads.some(l => l.remoteJid === previewLead.remoteJid) ? previewLead.remoteJid : "_mock"}
                onValueChange={(v) => {
                  if (v === "_mock") {
                    setPreviewLead({
                      remoteJid: "5511999999999@s.whatsapp.net",
                      nome_negocio: "Padaria São João",
                      ramo_negocio: "Alimentação",
                    });
                    return;
                  }
                  const lead = availableLeads.find((l) => l.remoteJid === v);
                  if (lead) {
                    setPreviewLead({
                      remoteJid: lead.remoteJid,
                      nome_negocio: lead.nome_negocio,
                      ramo_negocio: lead.ramo_negocio,
                    });
                  }
                }}
              >
                <SelectTrigger id="preview-lead" className={styles.field}>
                  <SelectValue>{availableLeads.some(l => l.remoteJid === previewLead.remoteJid) ? previewLead.nome_negocio || previewLead.remoteJid.split("@")[0] : "Exemplo genérico (Padaria São João)"}</SelectValue>
                </SelectTrigger>
                <SelectContent className={cn(styles.selectPopup, "max-h-[40vh]")}>
                  <SelectItem value="_mock">Exemplo genérico (Padaria São João)</SelectItem>
                  {availableLeads.slice(0, 100).map((l) => (
                    <SelectItem key={l.id} value={l.remoteJid}>
                      {l.nome_negocio || l.remoteJid.split("@")[0]} {l.ramo_negocio ? `· ${l.ramo_negocio}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <details className={styles.variableGuide}><summary>Consultar variáveis disponíveis</summary><div className={styles.variableGrid}>
                {TEMPLATE_VARIABLES.map((v) => (
                  <div
                    key={v.key}
                    className="p-1.5 rounded bg-black/30 border border-white/5"
                    title={v.hint}
                  >
                    <p className="font-mono text-blue-300">{`{{${v.key}}}`}</p>
                    <p className="text-white/80 truncate">→ {variableValue(v.key) || "(vazio)"}</p>
                  </div>
                ))}
              </div></details>
              <p className={styles.helper}>A amostra só preenche as variáveis; nenhuma mensagem é enviada.</p>
            </div>

            <div className={styles.stepsList}>
                {steps.map((s, i) => (
                  <div key={i} className={styles.step}>
                    <div className={styles.stepHeading}>
                      <h3><span className={styles.stepNumber}>{i + 1}</span> Etapa {i + 1}</h3>
                      <div className={styles.dayField}>
                        <label htmlFor={`step-days-${i}`} className="sr-only">Dias sem resposta da etapa {i + 1}</label>
                        <span>Após</span>
                        <NumberInput id={`step-days-${i}`} min={1} max={60} fallback={1} value={s.day_offset} onChange={(n) => updateStep(i, { day_offset: n })} className={cn(styles.field, styles.dayInput)} />
                        <span>dia{s.day_offset === 1 ? "" : "s"} sem resposta</span>
                      </div>
                      {steps.length > 1 && (
                        <Button size="icon" variant="ghost" className={cn(styles.iconAction, styles.dangerAction)} aria-label={`Remover etapa ${i + 1}`} onClick={() => removeStep(i)}>
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                    <div className={styles.messageGrid}><div>
                    <label htmlFor={`step-message-${i}`} className={styles.fieldLabel}>Mensagem da etapa {i + 1}</label>
                    <Textarea
                      id={`step-message-${i}`}
                      value={s.template}
                      onChange={(e) => updateStep(i, { template: e.target.value })}
                      rows={3}
                      className={cn(styles.field, styles.messageInput)}
                      placeholder="{{saudacao}} {{nome_empresa}}, ainda faz sentido a gente conversar?"
                    />
                    <div className={styles.variables}>
                      {TEMPLATE_VARIABLES.map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          onClick={() => insertVarIntoStep(i, v.key)}
                          aria-label={`Inserir ${v.key} na etapa ${i + 1}`}
                          title={`${v.hint} — valor atual: ${variableValue(v.key)}`}
                        >
                          <span>{`{{${v.key}}}`}</span>

                        </button>
                      ))}
                    </div></div>
                    <div className={styles.messagePreview}>
                      <p className={styles.previewLabel}><Eye className="w-3.5 h-3.5" aria-hidden="true" /> Prévia com variáveis</p>
                      <p className={styles.bubble}>{s.template.trim() ? previewOf(s.template) : "Escreva a mensagem para ver a prévia."}</p>
                      {aiEnabled && <p className={styles.helper}>A IA adapta esta base ao histórico do lead antes do envio.</p>}
                    </div>
                    </div>
                  </div>
                ))}
              </div>
              <p className={styles.helper}>Após a última etapa sem resposta, o lead é movido para <strong>Sem Interesse</strong> com o motivo registrado.</p>
            </section>

            <section className={styles.rulesSection} aria-labelledby="rules-heading">
              <h2 id="rules-heading" className={styles.sectionTitle}>Ritmo e horário de envio</h2>
              <p className={styles.helper}>Intervalo entre mensagens, em segundos. A janela de envio usa o horário de Brasília.</p>
              <div className={styles.timingGrid}>
                <div><label htmlFor="min-interval" className={styles.fieldLabel}>Intervalo mínimo (segundos)</label><NumberInput id="min-interval" min={5} fallback={30} value={minSec} onChange={setMinSec} className={styles.field} /></div>
                <div><label htmlFor="max-interval" className={styles.fieldLabel}>Intervalo máximo (segundos)</label><NumberInput id="max-interval" min={5} fallback={60} value={maxSec} onChange={setMaxSec} className={styles.field} /></div>
                <div><label htmlFor="start-hour" className={styles.fieldLabel}>Hora de início</label><NumberInput id="start-hour" min={0} max={23} fallback={9} value={startHour} onChange={setStartHour} className={styles.field} /></div>
                <div><label htmlFor="end-hour" className={styles.fieldLabel}>Hora de término</label><NumberInput id="end-hour" min={0} max={23} fallback={20} value={endHour} onChange={setEndHour} className={styles.field} /></div>
              </div>
              <div className={styles.optionRow}>
                <div><label htmlFor="campaign-auto" className={styles.fieldLabel}>Executar automaticamente</label><p className={styles.helper}>Respeita os dias e horários configurados. Desative para processar somente de forma manual.</p></div>
                <Switch id="campaign-auto" checked={autoExecute} onCheckedChange={setAutoExecute} />
              </div>
            </section>
          </div>
          <div className={styles.dialogFooter}>
            {msg?.type === "err" && <p role="alert" className={styles.formError}>{msg.text}</p>}
            <div className={styles.footerActions}>
              <span className={styles.helper}>{steps.length} etapa{steps.length === 1 ? "" : "s"} na sequência</span>
              <div>
                <Button variant="outline" className={styles.secondaryAction} onClick={() => setShowForm(false)} disabled={creating}>Cancelar</Button>
                <Button className={styles.primaryAction} onClick={submitCreate} disabled={creating}>
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
                  {editingId ? "Salvar alterações" : "Criar campanha"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Escolher leads específicos */}
      <Dialog open={pickerOpen} onOpenChange={(o) => !actioning && setPickerOpen(o)}>
        <DialogContent className={cn(styles.page, styles.smallDialog)}>
          <div className="p-5 border-b border-white/10 flex items-center justify-between gap-3">
            <div>
              <DialogTitle className="text-base font-black text-white flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-primary" /> Escolher leads
              </DialogTitle>
              <DialogDescription className={styles.helper}>Leads em follow-up aparecem primeiro. Você também pode selecionar outros.</DialogDescription>
            </div>
            <Badge className="bg-primary/10 text-primary border-primary/20">
              {pickerSelected.size} selecionado{pickerSelected.size === 1 ? "" : "s"}
            </Badge>
          </div>

          <div className="p-4 space-y-3">
            <div className={styles.search}>
              <Search aria-hidden="true" />
              <Input
                aria-label="Buscar leads por nome, telefone ou ramo"
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Buscar por nome, telefone, ramo..."
                className={styles.field}
              />
            </div>

            <div className="flex items-center justify-between px-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={pickerAllVisibleSelected}
                  onChange={togglePickerAllVisible}
                  disabled={filteredPickerLeads.length === 0}
                  className="h-4 w-4 rounded border-white/20 bg-white/5 accent-primary cursor-pointer"
                />
                <span className="font-bold text-white/90">
                  Selecionar todos visíveis ({filteredPickerLeads.length})
                </span>
              </label>
              {pickerSelected.size > 0 && (
                <button
                  onClick={() => setPickerSelected(new Set())}
                  className="text-[11px] text-muted-foreground hover:text-white flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> Limpar
                </button>
              )}
            </div>

            <div className="max-h-[50vh] overflow-y-auto custom-scrollbar space-y-1 pr-1">
              {pickerLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Carregando...
                </div>
              ) : filteredPickerLeads.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">Nenhum cliente encontrado.</p>
              ) : (
                filteredPickerLeads.map((l) => {
                  const on = pickerSelected.has(l.id);
                  return (
                    <label
                      key={l.id}
                      className={cn(
                        "flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition",
                        on
                          ? "bg-primary/10 border-primary/30"
                          : "bg-white/5 border-white/5 hover:bg-white/10"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => togglePickerOne(l.id)}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-primary cursor-pointer"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-bold text-white truncate">
                            {l.nome_negocio || l.remoteJid.split("@")[0]}
                          </p>
                          {l.status === "follow-up" && (
                            <Badge className="text-[8px] bg-amber-500/10 text-amber-400 border-amber-500/20">
                              follow-up
                            </Badge>
                          )}
                        </div>
                        <p className="text-[10px] font-mono text-muted-foreground">
                          {l.remoteJid.split("@")[0]} {l.ramo_negocio ? `· ${l.ramo_negocio}` : ""}
                        </p>
                      </div>
                    </label>
                  );
                })
              )}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-white/10">
              <Button variant="ghost" onClick={() => setPickerOpen(false)} disabled={actioning}>
                Cancelar
              </Button>
              <Button
                className="gap-2"
                onClick={confirmEnrollSelected}
                disabled={actioning || pickerSelected.size === 0}
              >
                {actioning ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                Adicionar {pickerSelected.size} lead{pickerSelected.size === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Preview de IA (histórico + mensagem final) */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className={cn(styles.page, styles.smallDialog)}>
          <div className={styles.dialogHeader}>
            <DialogTitle className="text-base font-black text-white flex items-center gap-2">
              <Eye className="w-4 h-4 text-purple-400" /> O que a IA vai enviar
            </DialogTitle>
            <DialogDescription className={styles.helper}>Prévia gerada a partir do histórico. A mensagem ainda não foi enviada.</DialogDescription>
          </div>

          <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
            {previewLoading ? (
              <div className="py-10 text-center text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                Consultando a IA e lendo histórico...
              </div>
            ) : !previewData ? (
              <p className="text-xs text-muted-foreground text-center py-6">Sem dados.</p>
            ) : previewData.error ? (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
                {previewData.error}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-white/5 text-white/80 border-white/10">
                    {previewData.target?.nome_negocio ||
                      previewData.target?.remote_jid?.split("@")[0]}
                  </Badge>
                  <Badge className="bg-primary/10 text-primary border-primary/20">
                    passo {(previewData.step_index ?? 0) + 1}
                  </Badge>
                  {previewData.ai_used ? (
                    <Badge className="bg-purple-500/10 text-purple-300 border-purple-500/20 gap-1">
                      <Sparkles className="w-2.5 h-2.5" /> IA usada
                    </Badge>
                  ) : (
                    <Badge className="bg-neutral-500/10 text-neutral-300 border-neutral-500/20">
                      Sem IA — envia template puro
                    </Badge>
                  )}
                  <Badge className="bg-white/5 text-white/60 border-white/10 gap-1">
                    <MessageSquare className="w-2.5 h-2.5" />
                    {previewData.history_msg_count || 0} msgs no histórico
                  </Badge>
                </div>

                {previewData.note && (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    {previewData.note}
                  </div>
                )}

                {previewData.ai_error && (
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    IA falhou: {previewData.ai_error}. Se tentasse enviar agora, o template puro seria usado.
                  </div>
                )}

                {/* Histórico lido pela IA */}
                <div>
                  <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-2">
                    <FileText className="w-3 h-3" /> Histórico que a IA leu
                  </p>
                  <pre className="p-3 rounded-xl bg-black/40 border border-white/5 text-[11px] text-white/80 whitespace-pre-wrap font-mono max-h-[30vh] overflow-y-auto custom-scrollbar">
{previewData.history || "(sem histórico)"}
                  </pre>
                </div>

                {/* Template renderizado */}
                {previewData.rendered && (
                  <div>
                    <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest mb-2">
                      Template renderizado (base antes da IA)
                    </p>
                    <div className="p-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white/80 whitespace-pre-wrap">
                      {previewData.rendered}
                    </div>
                  </div>
                )}

                {/* Mensagem final */}
                <div>
                  <p className="text-[10px] font-black text-green-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                    <Send className="w-3 h-3" /> Mensagem que SERÁ enviada
                  </p>
                  <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/30 text-sm text-green-100 whitespace-pre-wrap leading-relaxed">
                    {previewData.final_message || "(vazia)"}
                  </div>
                </div>
              </>
            )}

            <div className="flex justify-end pt-3 border-t border-white/10">
              <Button variant="ghost" onClick={() => setPreviewOpen(false)}>
                Fechar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
