"use client";

import { useEffect, useState, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Repeat, Plus, Play, Pause, Trash2, Send, Loader2, Bot, Clock,
  UserPlus, CheckCircle2, AlertCircle, Sparkles, Eye, Search, X,
  MessageSquare, FileText, Pencil, ChevronRight, BarChart3,
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

export default function FollowUpPage() {
  const [campaigns, setCampaigns] = useState<FollowupCampaign[]>([]);
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
  const [aiPrompt, setAiPrompt] = useState(
    "Você é um SDR profissional fazendo follow-up no WhatsApp. Seja breve, humano e nunca insista demais. Se o cliente já demonstrou indefinição, ofereça uma saída fácil."
  );
  const [steps, setSteps] = useState<Step[]>(DEFAULT_STEPS);
  const [minSec, setMinSec] = useState(40);
  const [maxSec, setMaxSec] = useState(90);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(20);
  const [autoExecute, setAutoExecute] = useState(true);

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

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/followup", { cache: "no-store" });
      const d = await r.json();
      if (d.success) setCampaigns(d.campaigns || []);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInstances = useCallback(async () => {
    try {
      const r = await fetch("/api/whatsapp?instances=true");
      const d = await r.json();
      if (d.success && d.instances) {
        setInstances(d.instances);
        if (!instanceName && d.instances[0]) setInstanceName(d.instances[0].instanceName);
      }
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
    // Pega os leads em follow-up (mais úteis para preview) + alguns recentes como fallback
    const { data } = await supabase
      .from("leads_extraidos")
      .select("id, remoteJid, nome_negocio, ramo_negocio, status")
      .order("created_at", { ascending: false })
      .limit(200);
    setAvailableLeads(data || []);
  }, []);

  useEffect(() => {
    loadCampaigns();
    loadInstances();
    loadModels();
    loadAvailableLeads();
    const t = setInterval(() => loadCampaigns(), 8000);
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
      // Prioriza leads em status follow-up; traz também demais (pro usuário escolher à vontade)
      const { data: a } = await supabase
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio, status, created_at")
        .eq("status", "follow-up")
        .order("created_at", { ascending: false })
        .limit(1000);
      const { data: b } = await supabase
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio, status, created_at")
        .neq("status", "follow-up")
        .not("status", "in", "(fechado,sem_interesse,descartado)")
        .order("created_at", { ascending: false })
        .limit(500);
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

  const statusColor = (s: string) =>
    s === "active"
      ? "bg-green-500/10 text-green-400 border-green-500/20"
      : s === "paused"
      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
      : "bg-neutral-500/10 text-neutral-400 border-neutral-500/20";

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
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden">
      <Header />
      <div className="flex-1 p-3 sm:p-6 space-y-4 sm:space-y-6 w-full max-w-7xl mx-auto mobile-safe-bottom overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-3">
              <Repeat className="w-6 h-6 text-primary" /> Follow-up Automático
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Reengajamento automático de leads em follow-up. IA lê a conversa e escreve a próxima mensagem.
            </p>
          </div>
          <Button onClick={() => { resetForm(); setShowForm(true); }} className="gap-2 glow-primary">
            <Plus className="w-4 h-4" /> Nova Campanha
          </Button>
        </div>

        {msg && (
          <div
            className={cn(
              "p-3 rounded-xl border text-sm",
              msg.type === "ok"
                ? "bg-green-500/10 border-green-500/30 text-green-300"
                : "bg-red-500/10 border-red-500/30 text-red-300"
            )}
          >
            {msg.text}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Lista de campanhas */}
          <div className="xl:col-span-2 space-y-4">
            {loading ? (
              <div className="text-muted-foreground text-sm py-10 text-center">
                <Loader2 className="w-4 h-4 inline animate-spin mr-2" /> Carregando...
              </div>
            ) : campaigns.length === 0 ? (
              <Card className="border-white/10 bg-white/5">
                <CardContent className="p-10 text-center text-muted-foreground">
                  Nenhuma campanha de follow-up ainda. Clique em <strong>Nova Campanha</strong>.
                </CardContent>
              </Card>
            ) : (
              campaigns.map((c) => (
                <Card
                  key={c.id}
                  className={cn(
                    "border-white/10 bg-black/40 hover:bg-white/5 cursor-pointer transition",
                    selected?.id === c.id && "border-primary/40 bg-primary/5"
                  )}
                  onClick={() => loadDetail(c.id)}
                >
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-black text-white truncate">{c.name}</h3>
                          <Badge className={cn("text-[9px] uppercase border", statusColor(c.status))}>
                            {c.status}
                          </Badge>
                          {c.auto_execute && (
                            <Badge className="text-[9px] uppercase bg-primary/10 text-primary border border-primary/20">
                              auto
                            </Badge>
                          )}
                          {c.ai_enabled && (
                            <Badge className="text-[9px] uppercase bg-purple-500/10 text-purple-300 border border-purple-500/20 gap-1">
                              <Sparkles className="w-2.5 h-2.5" /> IA
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Instância: <span className="font-mono">{c.instance_name}</span> ·{" "}
                          {c.steps.length} passos · janela {c.allowed_start_hour}h–{c.allowed_end_hour}h
                        </p>
                      </div>
                      <div
                        className="flex items-center gap-1 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.status === "active" ? (
                          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setStatus(c.id, "paused")} title="Pausar">
                            <Pause className="w-3.5 h-3.5" />
                          </Button>
                        ) : (
                          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setStatus(c.id, "active")} title="Ativar">
                            <Play className="w-3.5 h-3.5 text-green-400" />
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-blue-500/20" onClick={() => openEdit(c)} title="Editar">
                          <Pencil className="w-3.5 h-3.5 text-blue-400" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-red-500/20" onClick={() => deleteCampaign(c.id)} title="Excluir">
                          <Trash2 className="w-3.5 h-3.5 text-red-400" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div className="p-2 rounded-lg bg-white/5">
                        <p className="text-[9px] uppercase text-muted-foreground">Leads</p>
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
                      <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/20" onClick={(e) => e.stopPropagation()}>
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

                    {/* Último erro persistente */}
                    {c.last_error && (
                      <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/30" onClick={(e) => e.stopPropagation()}>
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
                    <div className="mt-3 grid grid-cols-2 gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActiveLogCampaignId(activeLogCampaignId === c.id ? null : c.id)}
                        className="justify-between h-8 bg-white/5 border border-white/5 hover:bg-white/10 text-[10px] uppercase font-black"
                      >
                        <span className="flex items-center gap-2">
                          <BarChart3 className="w-3 h-3 text-primary" />
                          {activeLogCampaignId === c.id ? "Ocultar logs" : "Ver logs (tempo real)"}
                        </span>
                        <ChevronRight className={cn("w-3 h-3 transition-transform", activeLogCampaignId === c.id && "rotate-90")} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActiveHistCampaignId(activeHistCampaignId === c.id ? null : c.id)}
                        className="justify-between h-8 bg-white/5 border border-white/5 hover:bg-white/10 text-[10px] uppercase font-black"
                      >
                        <span className="flex items-center gap-2">
                          <MessageSquare className="w-3 h-3 text-cyan-300" />
                          {activeHistCampaignId === c.id ? "Ocultar envios" : `Ver envios (${c.total_sent || 0})`}
                        </span>
                        <ChevronRight className={cn("w-3 h-3 transition-transform", activeHistCampaignId === c.id && "rotate-90")} />
                      </Button>
                    </div>

                    {activeLogCampaignId === c.id && (
                      <div className="mt-2 rounded-xl bg-black/40 border border-white/5 p-3 font-mono text-[10px] h-48 flex flex-col" onClick={(e) => e.stopPropagation()}>
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
                      <div className="mt-2 rounded-xl bg-black/40 border border-white/5 p-3 flex flex-col max-h-[420px]" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2 gap-2 flex-wrap">
                          <span className="text-[9px] uppercase font-black text-muted-foreground">Histórico de envios</span>
                          <div className="flex items-center gap-1 text-[9px]">
                            {(["all", "waiting", "responded", "exhausted", "failed"] as const).map(f => (
                              <button
                                key={f}
                                onClick={() => setHistFilter(f)}
                                className={cn(
                                  "px-2 py-0.5 rounded-md font-black uppercase tracking-widest transition",
                                  histFilter === f ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/30" : "text-muted-foreground hover:text-white"
                                )}
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
                            <p className="text-muted-foreground italic text-center py-8 text-[11px]">Nenhum lead inscrito ainda.</p>
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
                                          {phone} · step {t.current_step}/{c.steps.length}
                                          {t.last_sent_at ? ` · enviado ${new Date(t.last_sent_at).toLocaleString("pt-BR")}` : ""}
                                          {t.next_send_at ? ` · próximo ${new Date(t.next_send_at).toLocaleDateString("pt-BR")}` : ""}
                                        </p>
                                      </div>
                                      <span className={cn("text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md border shrink-0", statusColor)}>
                                        {t.status}
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
                                      <p className="text-[10px] text-red-300 bg-red-500/5 border border-red-500/20 rounded-md px-2 py-1">⚠ {t.error_message}</p>
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
          </div>

          {/* Painel da campanha selecionada */}
          <div className="xl:col-span-1 space-y-4">
            {!selected ? (
              <Card className="border-white/10 bg-white/5">
                <CardContent className="p-10 text-center text-muted-foreground text-sm">
                  Selecione uma campanha para ver detalhes e leads.
                </CardContent>
              </Card>
            ) : (
              <Card className="border-white/10 bg-black/40">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Repeat className="w-4 h-4 text-primary" /> {selected.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10">
                    <div>
                      <p className="text-xs font-bold text-white">Executar automaticamente</p>
                      <p className="text-[10px] text-muted-foreground">Roda sozinho a cada ~2 min respeitando janela</p>
                    </div>
                    <Switch
                      checked={selected.auto_execute}
                      onCheckedChange={(v) => toggleAuto(selected.id, v)}
                      disabled={actioning}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-white/10 bg-white/5 hover:bg-white/10 text-[11px]"
                      onClick={() => enrollAllFollowUp(selected.id)}
                      disabled={actioning}
                      title="Adiciona todos os leads do CRM em status follow-up"
                    >
                      <UserPlus className="w-3.5 h-3.5" /> Todos
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-white/10 bg-white/5 hover:bg-white/10 text-[11px]"
                      onClick={() => openLeadPicker(selected.id)}
                      disabled={actioning}
                      title="Selecionar leads específicos"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Escolher
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1.5 bg-primary hover:bg-primary/90 text-[11px]"
                      onClick={() => tickNow(selected.id)}
                      disabled={actioning}
                    >
                      {actioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Disparar
                    </Button>
                  </div>

                  <div>
                    <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest mb-2">
                      Leads ({selTargets.length})
                    </p>
                    <div className="max-h-[420px] overflow-y-auto space-y-2 custom-scrollbar pr-1">
                      {loadingDetail ? (
                        <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                      ) : selTargets.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-4 text-center">
                          Sem leads. Clique em <strong>Puxar CRM</strong>.
                        </p>
                      ) : (
                        selTargets.map((t) => (
                          <div key={t.id} className="p-2.5 rounded-lg bg-white/5 border border-white/5">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-bold text-white truncate flex-1">
                                {t.nome_negocio || t.remote_jid.split("@")[0]}
                              </p>
                              <Badge className={cn("text-[9px] uppercase", targetBadge(t.status))}>
                                {t.status}
                              </Badge>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 shrink-0"
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
          </div>
        </div>
      </div>

      {/* Dialog: criar campanha */}
      <Dialog open={showForm} onOpenChange={(o) => !creating && setShowForm(o)}>
        <DialogContent className="glass-card border-white/20 w-[96vw] max-w-[1400px] sm:max-w-[1400px] h-[92vh] sm:h-[90vh] p-0 overflow-hidden flex flex-col gap-0">
          <div className="p-6 border-b border-white/10 bg-gradient-to-r from-primary/15 via-purple-500/10 to-transparent shrink-0">
            <DialogTitle className="text-xl font-black text-white flex items-center gap-3">
              <Repeat className="w-6 h-6 text-primary" /> {editingId ? "Editar Campanha de Follow-up" : "Nova Campanha de Follow-up"}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Define os passos de reengajamento. Se o cliente responder no meio, o follow-up PARA. Se esgotar
              todos os passos sem resposta, o lead vai para <strong>Sem Interesse</strong> com motivo registrado.
            </p>
          </div>

          <div className="p-6 space-y-6 flex-1 overflow-y-auto custom-scrollbar">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Nome</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Reengajamento Out-2026" className="mt-1 h-10 bg-white/5 border-white/10" />
              </div>
              <div>
                <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Instância WhatsApp</label>
                <Select value={instanceName} onValueChange={(v) => setInstanceName(v as string)}>
                  <SelectTrigger className="mt-1 h-10 bg-white/5 border-white/10">
                    <SelectValue placeholder="Escolher" />
                  </SelectTrigger>
                  <SelectContent className="glass-card">
                    {instances.map((i, idx) => (
                      <SelectItem key={idx} value={i.instanceName}>
                        {i.profileName || i.instanceName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Agente IA */}
            <div className="p-4 rounded-xl bg-purple-500/5 border border-purple-500/20 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-purple-400" />
                  <p className="text-sm font-bold text-white">Agente IA escreve a mensagem</p>
                </div>
                <Switch checked={aiEnabled} onCheckedChange={setAiEnabled} />
              </div>
              {aiEnabled && (
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,280px)_1fr] gap-4">
                  <div>
                    <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Modelo Gemini</label>
                    <Select value={aiModel} onValueChange={(v) => setAiModel(v as string)}>
                      <SelectTrigger className="mt-1 h-10 bg-white/5 border-white/10">
                        <SelectValue placeholder="Escolher modelo" />
                      </SelectTrigger>
                      <SelectContent className="glass-card max-h-[40vh]">
                        {aiModels.length === 0 ? (
                          <SelectItem value="_none" disabled>
                            Nenhum (configure API Key em Chat → Organizador IA)
                          </SelectItem>
                        ) : (
                          aiModels.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">
                      Prompt do Agente — define como ele se comporta
                    </label>
                    <Textarea
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      rows={6}
                      className="mt-1 bg-white/5 border-white/10 text-sm leading-relaxed"
                      placeholder="Ex: Você é um SDR cordial, vai reengajar o cliente de forma humana..."
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Lead amostra pra preview de variáveis */}
            <div className="p-3 rounded-xl bg-blue-500/5 border border-blue-500/20 space-y-2">
              <div className="flex items-center gap-2">
                <Eye className="w-3.5 h-3.5 text-blue-400" />
                <p className="text-[11px] font-bold text-blue-200">Pré-visualizar variáveis usando o lead:</p>
              </div>
              <Select
                value={previewLead.remoteJid}
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
                <SelectTrigger className="h-9 bg-white/5 border-white/10 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="glass-card max-h-[40vh]">
                  <SelectItem value="_mock">Exemplo genérico (Padaria São João)</SelectItem>
                  {availableLeads.slice(0, 100).map((l) => (
                    <SelectItem key={l.id} value={l.remoteJid}>
                      {l.nome_negocio || l.remoteJid.split("@")[0]} {l.ramo_negocio ? `· ${l.ramo_negocio}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px]">
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
              </div>
            </div>

            {/* Passos */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">
                  Passos do Follow-up ({steps.length})
                </label>
                <Button size="sm" variant="ghost" onClick={addStep} className="h-7 text-xs gap-1">
                  <Plus className="w-3 h-3" /> Adicionar passo
                </Button>
              </div>
              <div className="space-y-3">
                {steps.map((s, i) => (
                  <div key={i} className="p-3 rounded-xl bg-white/5 border border-white/10 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-black text-primary bg-primary/10 px-2 py-1 rounded">
                        {i + 1}º FOLLOW-UP
                      </span>
                      <span className="text-[10px] text-muted-foreground">após</span>
                      <NumberInput
                        min={1}
                        max={60}
                        fallback={1}
                        value={s.day_offset}
                        onChange={(n) => updateStep(i, { day_offset: n })}
                        className="h-7 w-16 bg-black/30 border-white/10 text-center text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">
                        dia{s.day_offset === 1 ? "" : "s"} sem resposta
                      </span>
                      {steps.length > 1 && (
                        <Button size="icon" variant="ghost" className="h-7 w-7 ml-auto" onClick={() => removeStep(i)}>
                          <Trash2 className="w-3 h-3 text-red-400" />
                        </Button>
                      )}
                    </div>
                    <Textarea
                      value={s.template}
                      onChange={(e) => updateStep(i, { template: e.target.value })}
                      rows={3}
                      className="bg-black/30 border-white/10 text-sm leading-relaxed"
                      placeholder="{{saudacao}} {{nome_empresa}}, ainda faz sentido a gente conversar?"
                    />
                    <div className="flex flex-wrap gap-1">
                      {TEMPLATE_VARIABLES.map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          onClick={() => insertVarIntoStep(i, v.key)}
                          className="text-[9px] px-2 py-0.5 rounded bg-white/5 hover:bg-primary/20 text-muted-foreground hover:text-primary border border-white/5 font-mono flex items-center gap-1"
                          title={`${v.hint} — valor atual: ${variableValue(v.key)}`}
                        >
                          <span>{`{{${v.key}}}`}</span>
                          <span className="text-[8px] text-white/50 truncate max-w-[60px]">
                            → {variableValue(v.key)}
                          </span>
                        </button>
                      ))}
                    </div>
                    {s.template.trim() && (
                      <div className="p-2.5 rounded-lg bg-green-500/5 border border-green-500/20">
                        <p className="text-[9px] font-black text-green-400 uppercase tracking-widest mb-1 flex items-center gap-1">
                          <Eye className="w-2.5 h-2.5" /> Prévia real
                        </p>
                        <p className="text-xs text-green-100/90 whitespace-pre-wrap leading-relaxed">
                          {previewOf(s.template)}
                        </p>
                        {aiEnabled && (
                          <p className="text-[9px] text-purple-300 mt-1.5 italic">
                            ⓘ Esta é a base. A IA vai reescrever contextualizando com o histórico real do lead antes de enviar.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Após o último passo, se o cliente não responder, o lead vai pra <strong>Sem Interesse</strong>{" "}
                com motivo automático.
              </p>
            </div>

            {/* Anti-bloqueio */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="text-[10px] font-black text-muted-foreground uppercase">Min seg.</label>
                <NumberInput min={5} fallback={30} value={minSec} onChange={(n) => setMinSec(n)} className="mt-1 h-10 bg-white/5 border-white/10" />
              </div>
              <div>
                <label className="text-[10px] font-black text-muted-foreground uppercase">Max seg.</label>
                <NumberInput min={5} fallback={60} value={maxSec} onChange={(n) => setMaxSec(n)} className="mt-1 h-10 bg-white/5 border-white/10" />
              </div>
              <div>
                <label className="text-[10px] font-black text-muted-foreground uppercase">Hora início</label>
                <NumberInput min={0} max={23} fallback={9} value={startHour} onChange={(n) => setStartHour(n)} className="mt-1 h-10 bg-white/5 border-white/10" />
              </div>
              <div>
                <label className="text-[10px] font-black text-muted-foreground uppercase">Hora fim</label>
                <NumberInput min={0} max={23} fallback={20} value={endHour} onChange={(n) => setEndHour(n)} className="mt-1 h-10 bg-white/5 border-white/10" />
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10">
              <div>
                <p className="text-sm font-bold text-white">Executar automaticamente</p>
                <p className="text-[10px] text-muted-foreground">
                  Se ligado, roda sozinho respeitando dias + janela. Desligue se quiser só disparar manual.
                </p>
              </div>
              <Switch checked={autoExecute} onCheckedChange={setAutoExecute} />
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-white/10">
              <Button variant="ghost" onClick={() => setShowForm(false)} disabled={creating}>
                Cancelar
              </Button>
              <Button className="gap-2" onClick={submitCreate} disabled={creating}>
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {editingId ? "Salvar alterações" : "Criar campanha"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Escolher leads específicos */}
      <Dialog open={pickerOpen} onOpenChange={(o) => !actioning && setPickerOpen(o)}>
        <DialogContent className="glass-card border-white/20 max-w-2xl w-[95vw] p-0 overflow-hidden">
          <div className="p-5 border-b border-white/10 flex items-center justify-between gap-3">
            <div>
              <DialogTitle className="text-base font-black text-white flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-primary" /> Escolher leads
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Priorizando leads em status <strong>follow-up</strong>. Você também pode selecionar outros.
              </p>
            </div>
            <Badge className="bg-primary/10 text-primary border-primary/20">
              {pickerSelected.size} selecionado{pickerSelected.size === 1 ? "" : "s"}
            </Badge>
          </div>

          <div className="p-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Buscar por nome, telefone, ramo..."
                className="pl-9 h-10 bg-white/5 border-white/10 rounded-xl"
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
                <p className="text-xs text-muted-foreground text-center py-6">Nenhum lead encontrado.</p>
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
        <DialogContent className="glass-card border-white/20 max-w-2xl w-[95vw] p-0 overflow-hidden">
          <div className="p-5 border-b border-white/10 bg-gradient-to-r from-purple-500/15 via-primary/10 to-transparent">
            <DialogTitle className="text-base font-black text-white flex items-center gap-2">
              <Eye className="w-4 h-4 text-purple-400" /> O que a IA vai enviar
            </DialogTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Preview completo — a IA leu este histórico e gerou esta mensagem sem enviá-la ainda.
            </p>
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
