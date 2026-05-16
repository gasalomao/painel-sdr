"use client";

import { useEffect, useState, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  Cpu, Play, Pause, Trash2, Plus, Loader2, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Bot, MapPin, Zap, Repeat, Clock, Save, AlertTriangle, Pencil,
} from "lucide-react";
import { AutomationLogs } from "./AutomationLogs";
import { LeadIntelligenceBatch } from "@/components/lead-intelligence-batch";

type FollowupStep = { day_offset: number; template: string };

type Automation = {
  id: string;
  name: string;
  agent_id: number | null;
  instance_name: string;
  niches: string[];
  regions: string[];
  scrape_filters: any;
  scrape_max_leads: number;
  dispatch_template: string;
  dispatch_min_interval: number;
  dispatch_max_interval: number;
  dispatch_personalize: boolean;
  dispatch_ai_model: string | null;
  dispatch_ai_prompt: string | null;
  lead_intelligence_enabled: boolean;
  followup_enabled: boolean;
  followup_steps: FollowupStep[];
  followup_min_interval: number;
  followup_max_interval: number;
  followup_ai_enabled: boolean;
  followup_ai_model: string | null;
  followup_ai_prompt: string | null;
  allowed_start_hour: number;
  allowed_end_hour: number;
  phase: string;
  status: string;
  scraped_count: number;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  campaign_id: string | null;
  followup_campaign_id: string | null;
  created_at?: string;
  updated_at?: string;
};

type Agent = { id: number; name: string };
type Instance = { instanceName: string };
type GeminiModel = { id: string; name?: string; version?: string; description?: string };

// Fallback estático caso a API falhe ou a chave não esteja configurada.
// Lista ampliada para cobrir os modelos principais hoje (Gemini 2.5/2.0/1.5).
const FALLBACK_MODELS: GeminiModel[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite" },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" },
  { id: "gemini-1.5-flash-8b", name: "Gemini 1.5 Flash 8B" },
];

// safeJson: parse defensivo. Se a rota retornar HTML (404 do Next, redirect,
// página de erro), `r.json()` joga "Unexpected token '<'". Isso aqui captura
// e devolve um payload uniforme `{ success:false, error }` em vez de quebrar
// a página inteira.
async function safeJson(input: RequestInfo, init?: RequestInit): Promise<any> {
  try {
    const r = await fetch(input, init);
    const text = await r.text();
    if (!text.trim()) return { success: false, error: `Empty response (HTTP ${r.status})` };
    if (text.trimStart().startsWith("<")) {
      return { success: false, error: `Endpoint retornou HTML (HTTP ${r.status}). Rota provavelmente quebrou.` };
    }
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, error: `Resposta não-JSON: ${text.slice(0, 120)}` };
    }
  } catch (e: any) {
    return { success: false, error: `Falha de rede: ${e?.message || String(e)}` };
  }
}

const PHASE_LABEL: Record<string, { label: string; color: string }> = {
  idle:        { label: "⏸ Pronta",       color: "text-zinc-300 bg-zinc-500/10 border-zinc-500/20" },
  scraping:    { label: "🔍 Captando",    color: "text-blue-300 bg-blue-500/10 border-blue-500/30" },
  dispatching: { label: "📨 Disparando",  color: "text-cyan-300 bg-cyan-500/10 border-cyan-500/30" },
  following:   { label: "🔁 Follow-up",   color: "text-purple-300 bg-purple-500/10 border-purple-500/30" },
  done:        { label: "✓ Concluída",   color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30" },
  paused:      { label: "⏸ Pausada",     color: "text-amber-300 bg-amber-500/10 border-amber-500/30" },
  error:       { label: "⚠ Erro",         color: "text-red-300 bg-red-500/10 border-red-500/30" },
};

export default function AutomacaoPage() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [aiModels, setAiModels] = useState<GeminiModel[]>(FALLBACK_MODELS);
  const [loadingAiModels, setLoadingAiModels] = useState(false);
  const [aiModelsError, setAiModelsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Form state pra criar/editar automação. editingId=null → modo "criar".
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<Partial<Automation>>(blankAutomation());
  // Estados crus dos textareas pra não perder espaço/linha vazia digitando.
  // O array final só é calculado no momento de salvar.
  const [nichesText, setNichesText] = useState("");
  const [regionsText, setRegionsText] = useState("");

  function blankAutomation(): Partial<Automation> {
    return {
      name: "",
      instance_name: "",
      agent_id: null,
      niches: [],
      regions: [],
      scrape_filters: { filterEmpty: true, filterDuplicates: true, filterLandlines: true },
      scrape_max_leads: 100,
      dispatch_template: "{{saudacao}} {{nome_empresa}}! Sou da Sarah Tech, vi sua empresa no Maps e queria saber se faz sentido conversarmos sobre [oferta]. Pode ser?",
      // Defaults SEGUROS WhatsApp: 60-180s aleatório (média ~2 min, ~30 envios/h)
      dispatch_min_interval: 60,
      dispatch_max_interval: 180,
      dispatch_personalize: false,
      lead_intelligence_enabled: false,
      followup_enabled: true,
      followup_steps: [
        { day_offset: 2, template: "{{saudacao}} {{nome_empresa}}, passando pra reforçar — vi que ainda não trocamos uma palavra. Faz sentido pra você uma conversa rápida?" },
        { day_offset: 5, template: "Oi {{nome_empresa}}, último contato: se não fizer sentido agora, sem problema! Posso voltar daqui um tempo?" },
      ] as FollowupStep[],
      // Follow-up mais espaçado ainda: 60-240s
      followup_min_interval: 60,
      followup_max_interval: 240,
      followup_ai_enabled: false,
      allowed_start_hour: 9,
      allowed_end_hour: 20,
    };
  }

  // showLoader: só usa o spinner full-page no carregamento inicial.
  // Realtime / refreshes silenciosos passam false pra não piscar a lista.
  const loadAll = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const sessRes = await fetch("/api/auth/session");
      const session = await sessRes.json();
      if (!session?.authenticated) return;

      let agQuery = supabase.from("agent_settings").select("id, name").order("id");
      let chQuery = supabase.from("channel_connections").select("instance_name").order("instance_name");

      if (session.clientId) {
        agQuery = agQuery.eq("client_id", session.clientId);
        chQuery = chQuery.eq("client_id", session.clientId);
      }

      const [autoRes, agRes, chRes, evoRes] = await Promise.all([
        safeJson("/api/automations"),
        agQuery,
        chQuery,
        safeJson("/api/whatsapp?instances=true"),
      ]);
      if (autoRes.success) setAutomations(autoRes.automations || []);
      if (agRes.data) setAgents(agRes.data as Agent[]);
      const fromDb = ((chRes.data || []) as any[]).map(c => ({ instanceName: c.instance_name }));
      
      const myInstances = new Set(fromDb.map((i: any) => i.instanceName));
      const fromEvo = (evoRes.instances || []).filter((i: any) => myInstances.has(i.instanceName)).map((i: any) => ({ instanceName: i.instanceName }));
      
      const merged: Instance[] = [];
      const seen = new Set<string>();
      for (const x of [...fromDb, ...fromEvo]) {
        if (x.instanceName && !seen.has(x.instanceName)) {
          seen.add(x.instanceName);
          merged.push(x);
        }
      }
      setInstances(merged);
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(true); }, [loadAll]);

  // Carrega modelos Gemini em tempo real (mesma fonte que /disparo, /follow-up, /agente).
  // Usa a chave central salva em ai_organizer_config. Fallback: lista estática.
  const loadAiModels = useCallback(async () => {
    setLoadingAiModels(true);
    setAiModelsError(null);
    try {
      const d = await safeJson("/api/ai-models");
      if (d.success && Array.isArray(d.models) && d.models.length > 0) {
        // Mescla a lista da API com fallback (sem duplicar) — garante que
        // mesmo se a API retornar pouca coisa, modelos comuns estão sempre lá.
        const seen = new Set<string>();
        const merged: GeminiModel[] = [];
        for (const m of [...d.models, ...FALLBACK_MODELS]) {
          if (m.id && !seen.has(m.id)) {
            seen.add(m.id);
            merged.push(m);
          }
        }
        setAiModels(merged);
      } else {
        setAiModelsError(d.error || "Sem modelos retornados — usando lista padrão");
        setAiModels(FALLBACK_MODELS);
      }
    } catch (e: any) {
      setAiModelsError(e?.message || "Falha de rede");
    } finally {
      setLoadingAiModels(false);
    }
  }, []);

  useEffect(() => { loadAiModels(); }, [loadAiModels]);

  // Realtime: qualquer mudança em automations → recarrega lista SEM piscar.
  // Debounced 300ms pra agrupar updates em rajada (start dispara várias UPDATEs em sequência).
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    const debouncedLoad = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadAll(false), 300);
    };
    const ch = supabase
      .channel("automations-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "automations" }, debouncedLoad)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(ch);
    };
  }, [loadAll]);

  function openCreateForm() {
    setEditingId(null);
    setFormData(blankAutomation());
    setNichesText("");
    setRegionsText("");
    setShowForm(true);
  }

  function openEditForm(a: Automation) {
    setEditingId(a.id);
    setFormData({
      ...a,
      // garante objetos editáveis
      scrape_filters: a.scrape_filters || { filterEmpty: true, filterDuplicates: true, filterLandlines: true },
      followup_steps: Array.isArray(a.followup_steps) ? a.followup_steps : [],
    });
    setNichesText((a.niches || []).join("\n"));
    setRegionsText((a.regions || []).join("\n"));
    setShowForm(true);
    // scroll suave pro topo onde está o form
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setFormData(blankAutomation());
    setNichesText("");
    setRegionsText("");
  }

  async function saveAutomation(startImmediately: boolean = false) {
    if (!formData.name?.trim() || !formData.instance_name) {
      alert("Preenche nome e instância antes de salvar.");
      return;
    }
    setCreating(true);
    try {
      // Normaliza os textareas só na hora de salvar (preserva digitação).
      const niches  = nichesText.split("\n").map(s => s.trim()).filter(Boolean);
      const regions = regionsText.split("\n").map(s => s.trim()).filter(Boolean);
      const payload = { ...formData, niches, regions };

      const url = editingId ? `/api/automations/${editingId}` : "/api/automations";
      const method = editingId ? "PATCH" : "POST";
      const d = await safeJson(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!d.success) throw new Error(d.error);

      const automationId = editingId || d.automation?.id;

      if (startImmediately && automationId) {
        const startD = await safeJson(`/api/automations/${automationId}/start`, { method: "POST" });
        if (!startD.ok && !startD.success) {
           alert("Automação salva, mas falhou ao iniciar:\n\n" + (startD.error || "Erro desconhecido"));
        } else {
           alert("Automação salva e iniciada com sucesso!");
        }
      } else {
        alert("Automação salva como rascunho com sucesso!");
      }

      closeForm();
      await loadAll();
    } catch (e: any) {
      alert("Erro: " + e.message);
    } finally {
      setCreating(false);
    }
  }

  async function startAutomation(id: string) {
    setBusyId(id);
    setExpanded(id); // Expand the card so the user sees the real-time logs immediately
    try {
      const d = await safeJson(`/api/automations/${id}/start`, { method: "POST" });
      if (!d.ok) {
        // Mostra erro no card (last_error) E em alert. Importante pra debug:
        // o usuário precisa ver POR QUE falhou, não só "falhou".
        const msg = d.error || "Erro desconhecido";
        await loadAll(false);
        alert("❌ Falha ao iniciar:\n\n" + msg + "\n\n(também aparece em vermelho no card da automação)");
        return;
      }
      await loadAll(false);
    } catch (e: any) {
      alert("❌ Erro de rede: " + e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function pauseAutomation(id: string) {
    setBusyId(id);
    try {
      await fetch(`/api/automations/${id}/pause`, { method: "POST" });
      setAutomations(prev => prev.map(a => a.id === id ? { ...a, status: "paused", phase: "paused" } : a));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteAutomation(id: string) {
    if (!confirm("Apagar esta automação? Campanhas vinculadas vão parar.")) return;
    const d = await safeJson(`/api/automations/${id}`, { method: "DELETE" });
    if (!d.success) alert("Erro: " + d.error);
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden text-white">
      <Header />
      <main className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-8 max-w-6xl mx-auto w-full space-y-4 sm:space-y-6 mobile-safe-bottom">
        {/* Cabeçalho */}
        <div className="flex flex-col sm:flex-row items-start justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-black tracking-tight flex items-center gap-3">
              <Cpu className="w-5 h-5 sm:w-6 sm:h-6 text-primary" /> Automação completa
            </h1>
            <p className="text-[11px] sm:text-xs text-muted-foreground mt-1 max-w-2xl">
              Pipeline de ponta a ponta. Define o nicho, região, agente IA e os filtros — o painel <strong>capta os
              leads</strong>, <strong>dispara a primeira mensagem</strong> com intervalo aleatório, faz <strong>follow-up</strong> em
              steps configuráveis, e quando o cliente responder, o <strong>agente IA</strong> assume a conversa
              respeitando todo o histórico.
            </p>
          </div>
          <Button onClick={() => (showForm ? closeForm() : openCreateForm())} className="bg-primary text-primary-foreground font-bold gap-2 w-full sm:w-auto shrink-0">
            <Plus className="w-4 h-4" /> Nova automação
          </Button>
        </div>

        {/* Form de criação */}
        {showForm && (
          <Card className="border-primary/30 bg-primary/[0.03]">
            <CardHeader>
              <CardTitle className="text-sm font-black uppercase tracking-widest text-primary flex items-center gap-2">
                {editingId ? <><Pencil className="w-3.5 h-3.5" /> Editando automação</> : <>Configurar nova automação</>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {editingId && automations.find(a => a.id === editingId)?.status === "running" && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold mb-0.5">⚠ Esta automação está rodando.</p>
                    <p className="opacity-90">Alterações em template de disparo, IA e steps de follow-up valem a partir do próximo envio. Mudar nicho/região não afeta os leads já captados.</p>
                  </div>
                </div>
              )}
              {/* Identidade */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Nome</label>
                  <Input value={formData.name || ""} onChange={e => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Pizzarias ES — Outubro" className="bg-black/40 border-white/10 h-10" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1">
                    <Bot className="w-3 h-3" /> Agente IA
                  </label>
                  <select value={formData.agent_id || ""}
                    onChange={e => setFormData({ ...formData, agent_id: e.target.value ? Number(e.target.value) : null })}
                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-3 h-10 text-sm">
                    <option value="">— escolha um agente —</option>
                    {agents.map(a => <option key={a.id} value={a.id} className="bg-neutral-900">{a.name} (ID {a.id})</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Instância WhatsApp</label>
                  <select value={formData.instance_name || ""}
                    onChange={e => setFormData({ ...formData, instance_name: e.target.value })}
                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-3 h-10 text-sm">
                    <option value="">— escolha uma instância —</option>
                    {instances.map(i => <option key={i.instanceName} value={i.instanceName} className="bg-neutral-900">{i.instanceName}</option>)}
                  </select>
                </div>
              </div>

              {/* Captação */}
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
                <p className="text-[11px] font-black uppercase tracking-widest text-blue-300 flex items-center gap-2">
                  <MapPin className="w-3 h-3" /> Captação Google Maps
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted-foreground">Nichos (1 por linha — pode ter espaço)</label>
                    <Textarea rows={3}
                      value={nichesText}
                      onChange={e => setNichesText(e.target.value)}
                      placeholder="pizzaria artesanal&#10;hamburgueria gourmet&#10;açaí premium"
                      className="bg-black/40 border-white/10 font-mono text-xs" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted-foreground">Regiões (1 por linha — pode ter espaço)</label>
                    <Textarea rows={3}
                      value={regionsText}
                      onChange={e => setRegionsText(e.target.value)}
                      placeholder="Vitória/ES&#10;Vila Velha/ES&#10;Serra/ES"
                      className="bg-black/40 border-white/10 font-mono text-xs" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 items-start">
                  {[
                    { key: "filterEmpty",      label: "Pular sem telefone" },
                    { key: "filterDuplicates", label: "Pular duplicados" },
                    { key: "filterLandlines",  label: "Pular fixos" },
                  ].map(f => (
                    <label key={f.key} className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                      <input type="checkbox"
                        checked={!!formData.scrape_filters?.[f.key]}
                        onChange={e => setFormData({ ...formData, scrape_filters: { ...formData.scrape_filters, [f.key]: e.target.checked } })} />
                      {f.label}
                    </label>
                  ))}
                  <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">Limite de leads:</span>
                    <NumberInput min={1} max={5000} fallback={100}
                      value={formData.scrape_max_leads}
                      onChange={n => setFormData({ ...formData, scrape_max_leads: n })}
                      className="bg-black/40 border-white/10 h-8 w-20 text-xs" />
                  </div>
                </div>
              </div>

              {/* Lead Intelligence — entre captação e disparo. Análise IA de
                  cada lead colhido (site, busca web, Maps). O briefing é
                  injetado automaticamente no disparo, follow-up E agente. */}
              <div className={cn(
                "rounded-xl border p-4 space-y-2 transition-colors",
                formData.lead_intelligence_enabled
                  ? "border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 to-purple-500/10"
                  : "border-white/10 bg-white/[0.02]"
              )}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Bot className={cn("w-3 h-3", formData.lead_intelligence_enabled ? "text-cyan-300" : "text-zinc-500")} />
                    <p className={cn(
                      "text-[11px] font-black uppercase tracking-widest",
                      formData.lead_intelligence_enabled ? "text-cyan-300" : "text-zinc-400"
                    )}>
                      Lead Intelligence
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] cursor-pointer select-none">
                    <span className={cn("font-bold", formData.lead_intelligence_enabled ? "text-cyan-200" : "text-zinc-400")}>
                      {formData.lead_intelligence_enabled ? "ATIVADO" : "DESATIVADO"}
                    </span>
                    <input
                      type="checkbox"
                      className="h-4 w-8 appearance-none rounded-full bg-zinc-700 checked:bg-cyan-500 transition-colors relative cursor-pointer
                                 before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:w-3 before:h-3 before:rounded-full before:bg-white before:transition-transform
                                 checked:before:translate-x-4"
                      checked={!!formData.lead_intelligence_enabled}
                      onChange={e => setFormData({ ...formData, lead_intelligence_enabled: e.target.checked })}
                    />
                  </label>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Após captar os leads, IA analisa cada um (site oficial + busca web sobre o lead + busca sobre concorrentes/top players da região). O briefing fica em cache 30 dias e é <strong>injetado automaticamente</strong> em:
                  {" "}1) personalização do disparo inicial, 2) personalização dos follow-ups, 3) agente de IA que assume a conversa. Resultado: prospecção cirúrgica, sem genérico.
                </p>
                {formData.lead_intelligence_enabled && (
                  <p className="text-[10px] text-cyan-200/80 italic">
                    Custo ~1k tokens/lead (~R$ 0,002 com 2.5-flash). Modelo configurável em <span className="font-mono">Configurações</span>.
                  </p>
                )}
              </div>

              {/* Disparo */}
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 space-y-3">
                <p className="text-[11px] font-black uppercase tracking-widest text-cyan-300 flex items-center gap-2">
                  <Zap className="w-3 h-3" /> Disparo inicial
                </p>

                {/* Chips de variáveis — extraídas pelo captador. Clica pra inserir
                    no fim do template; arrasta direto pra qualquer posição. */}
                <div className="space-y-1.5">
                  <p className="text-[9px] uppercase font-bold text-muted-foreground">Variáveis disponíveis (clica ou arrasta):</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { key: "saudacao",      label: "Saudação",     hint: "Bom dia / Boa tarde / Boa noite" },
                      { key: "nome",          label: "Nome",         hint: "Push name do WhatsApp (fallback empresa)" },
                      { key: "nome_empresa",  label: "Empresa",      hint: "leads_extraidos.nome_negocio" },
                      { key: "primeiro_nome", label: "1ª palavra",   hint: "Primeira palavra do nome empresa" },
                      { key: "ramo",          label: "Ramo",         hint: "leads_extraidos.ramo_negocio" },
                      { key: "categoria",     label: "Categoria",    hint: "Categoria Google Maps" },
                      { key: "endereco",      label: "Endereço",     hint: "Endereço completo" },
                      { key: "website",       label: "Website",      hint: "Site do lead" },
                      { key: "avaliacao",     label: "Avaliação",    hint: "Nota Google (1-5)" },
                      { key: "reviews",       label: "Reviews",      hint: "Qtd. de reviews" },
                      { key: "telefone",      label: "Telefone",     hint: "Número limpo" },
                      { key: "data",          label: "Data",         hint: "DD/MM/AAAA" },
                      { key: "hora",          label: "Hora",         hint: "HH:MM" },
                    ].map(v => (
                      <button
                        key={v.key} type="button" title={v.hint}
                        draggable
                        onDragStart={e => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)}
                        onClick={() => setFormData({ ...formData, dispatch_template: (formData.dispatch_template || "") + `{{${v.key}}}` })}
                        className="px-2 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20 text-[10px] cursor-grab active:cursor-grabbing flex items-center gap-1"
                      >
                        <span className="font-bold text-cyan-100">{v.label}</span>
                        <code className="text-[9px] font-mono text-cyan-300/70">{`{{${v.key}}}`}</code>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-muted-foreground">
                    Mensagem-base (template)
                  </label>
                  <Textarea rows={3}
                    value={formData.dispatch_template || ""}
                    onChange={e => setFormData({ ...formData, dispatch_template: e.target.value })}
                    placeholder="Ex: {{saudacao}} {{nome_empresa}}! Vi vocês no Maps…"
                    className="bg-black/40 border-white/10 font-mono text-xs" />
                </div>

                <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 items-start sm:items-center">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">Intervalo aleatório entre envios (segundos):</span>
                    <div className="flex items-center gap-2">
                      <NumberInput min={5} fallback={60} value={formData.dispatch_min_interval}
                        onChange={n => setFormData({ ...formData, dispatch_min_interval: n })}
                        className="bg-black/40 border-white/10 h-8 w-16 text-xs" />
                      <span className="text-[10px] text-muted-foreground">até</span>
                      <NumberInput min={5} fallback={180} value={formData.dispatch_max_interval}
                        onChange={n => setFormData({ ...formData, dispatch_max_interval: n })}
                        className="bg-black/40 border-white/10 h-8 w-16 text-xs" />
                    </div>
                  </div>
                  <p className="text-[9px] text-amber-300/80 italic">
                    🛡 Recomendado: <strong>60–180s</strong> (anti-banimento WhatsApp).
                  </p>
                </div>

                {/* Personalização por IA — anti-banimento */}
                <div className="border-t border-white/5 pt-3 space-y-2">
                  <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                    <input type="checkbox" checked={!!formData.dispatch_personalize}
                      onChange={e => setFormData({ ...formData, dispatch_personalize: e.target.checked })} />
                    <Bot className="w-3 h-3 text-cyan-300" />
                    <span className="font-bold text-cyan-200">Reescrever cada mensagem com IA antes de enviar</span>
                  </label>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Cada lead recebe um <strong>texto único</strong> gerado pela Gemini a partir do template + dados do lead. Reduz risco de banimento por padrão repetitivo no WhatsApp.
                  </p>
                  {formData.dispatch_personalize && (
                    <div className="space-y-2 pl-4 border-l-2 border-cyan-500/30">
                      <div>
                        <label className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                          <span>Modelo Gemini</span>
                          {loadingAiModels && <Loader2 className="w-3 h-3 animate-spin" />}
                          <button type="button" onClick={loadAiModels} className="text-cyan-300 hover:underline text-[9px] normal-case">recarregar</button>
                        </label>
                        <select value={formData.dispatch_ai_model || (aiModels[0]?.id ?? "gemini-1.5-flash")}
                          onChange={e => setFormData({ ...formData, dispatch_ai_model: e.target.value })}
                          className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 h-8 text-xs">
                          {aiModels.length === 0 ? (
                            <option value="gemini-1.5-flash">gemini-1.5-flash (fallback)</option>
                          ) : aiModels.map(m => (
                            <option key={m.id} value={m.id} className="bg-neutral-900">
                              {m.id}{m.name ? ` — ${m.name}` : ""}
                            </option>
                          ))}
                        </select>
                        {aiModelsError && (
                          <p className="text-[9px] text-amber-300/80 mt-0.5">⚠ {aiModelsError} — salve sua chave Gemini em Configurações.</p>
                        )}
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-muted-foreground">Prompt para a IA (instruções de como reescrever)</label>
                        <Textarea rows={4}
                          value={formData.dispatch_ai_prompt || ""}
                          onChange={e => setFormData({ ...formData, dispatch_ai_prompt: e.target.value })}
                          placeholder="Ex: Reescreva a mensagem-base de forma natural e única para cada lead, mantendo o tom amigável e profissional. Não use emojis exagerados. Adapte ao ramo do negócio se for relevante. Mensagem deve ter no máximo 3 frases."
                          className="bg-black/40 border-white/10 font-mono text-xs" />
                        <p className="text-[9px] text-muted-foreground mt-1">
                          A IA recebe: prompt + mensagem-base + dados do lead (nome, ramo). Devolve a mensagem final que será enviada.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Follow-up */}
              <div className={cn(
                "rounded-xl border p-4 space-y-3 transition-colors",
                formData.followup_enabled !== false
                  ? "border-purple-500/20 bg-purple-500/5"
                  : "border-zinc-500/20 bg-zinc-500/5 opacity-60"
              )}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-[11px] font-black uppercase tracking-widest text-purple-300 flex items-center gap-2">
                    <Repeat className="w-3 h-3" /> Follow-up automático
                  </p>
                  {/* Toggle on/off — quando OFF, automação termina logo após o disparo */}
                  <label className="flex items-center gap-2 text-[11px] cursor-pointer select-none">
                    <span className={cn("font-bold", formData.followup_enabled !== false ? "text-purple-200" : "text-zinc-400")}>
                      {formData.followup_enabled !== false ? "ATIVADO" : "DESATIVADO"}
                    </span>
                    <input
                      type="checkbox"
                      className="h-4 w-8 appearance-none rounded-full bg-zinc-700 checked:bg-purple-500 transition-colors relative cursor-pointer
                                 before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:w-3 before:h-3 before:rounded-full before:bg-white before:transition-transform
                                 checked:before:translate-x-4"
                      checked={formData.followup_enabled !== false}
                      onChange={e => setFormData({ ...formData, followup_enabled: e.target.checked })}
                    />
                  </label>
                </div>
                {formData.followup_enabled === false && (
                  <p className="text-[10px] text-zinc-400 italic">
                    Automação vai terminar logo após o disparo inicial. Os steps abaixo ficam guardados mas não são enviados.
                  </p>
                )}
                <div className="space-y-2">
                  {(formData.followup_steps || []).map((step, idx) => (
                    <div key={idx} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-start p-2 rounded-xl bg-black/20 border border-white/5 sm:border-none sm:bg-transparent sm:p-0">
                      <div className="flex flex-col gap-1 shrink-0 w-full sm:w-24">
                        <span className="text-[9px] uppercase font-bold text-muted-foreground">Após (dias)</span>
                        <NumberInput min={1} fallback={1} value={step.day_offset}
                          onChange={n => {
                            const next = [...(formData.followup_steps || [])];
                            next[idx] = { ...next[idx], day_offset: n };
                            setFormData({ ...formData, followup_steps: next });
                          }}
                          className="bg-black/40 border-white/10 h-8 text-xs" />
                      </div>
                      <div className="flex-1">
                        <span className="text-[9px] uppercase font-bold text-muted-foreground">Mensagem</span>
                        <Textarea rows={2} value={step.template}
                          onChange={e => {
                            const next = [...(formData.followup_steps || [])];
                            next[idx] = { ...next[idx], template: e.target.value };
                            setFormData({ ...formData, followup_steps: next });
                          }}
                          className="bg-black/40 border-white/10 font-mono text-xs" />
                      </div>
                      <Button onClick={() => setFormData({
                        ...formData,
                        followup_steps: (formData.followup_steps || []).filter((_, i) => i !== idx),
                      })} variant="ghost" size="icon" className="h-8 w-8 text-red-400 self-end sm:mt-4">
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                  <Button onClick={() => setFormData({
                    ...formData,
                    followup_steps: [...(formData.followup_steps || []), { day_offset: 3, template: "" }],
                  })} variant="outline" className="text-[10px] uppercase font-bold gap-2 h-8">
                    <Plus className="w-3 h-3" /> Adicionar step
                  </Button>
                </div>
                {/* Personalização IA do follow-up */}
                <div className="border-t border-white/5 pt-3 space-y-2">
                  <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                    <input type="checkbox" checked={!!formData.followup_ai_enabled}
                      onChange={e => setFormData({ ...formData, followup_ai_enabled: e.target.checked })} />
                    <Bot className="w-3 h-3 text-purple-300" />
                    <span className="font-bold text-purple-200">Reescrever cada follow-up com IA</span>
                  </label>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Cada follow-up vira único, considerando o <strong>histórico da conversa</strong> daquele lead. Útil pra puxar gancho do que o cliente já disse e fugir de padrão repetitivo.
                  </p>
                  {formData.followup_ai_enabled && (
                    <div className="space-y-2 pl-4 border-l-2 border-purple-500/30">
                      <div>
                        <label className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                          <span>Modelo Gemini</span>
                          {loadingAiModels && <Loader2 className="w-3 h-3 animate-spin" />}
                          <button type="button" onClick={loadAiModels} className="text-purple-300 hover:underline text-[9px] normal-case">recarregar</button>
                        </label>
                        <select value={formData.followup_ai_model || (aiModels[0]?.id ?? "gemini-1.5-flash")}
                          onChange={e => setFormData({ ...formData, followup_ai_model: e.target.value })}
                          className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 h-8 text-xs">
                          {aiModels.length === 0 ? (
                            <option value="gemini-1.5-flash">gemini-1.5-flash (fallback)</option>
                          ) : aiModels.map(m => (
                            <option key={m.id} value={m.id} className="bg-neutral-900">
                              {m.id}{m.name ? ` — ${m.name}` : ""}
                            </option>
                          ))}
                        </select>
                        {aiModelsError && (
                          <p className="text-[9px] text-amber-300/80 mt-0.5">⚠ {aiModelsError} — salve sua chave Gemini em Configurações.</p>
                        )}
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-muted-foreground">Prompt para a IA</label>
                        <Textarea rows={4}
                          value={formData.followup_ai_prompt || ""}
                          onChange={e => setFormData({ ...formData, followup_ai_prompt: e.target.value })}
                          placeholder="Ex: Você é um SDR cordial fazendo follow-up sem ser insistente. Use o histórico pra puxar gancho do que o cliente já mencionou. Tom natural, máximo 3 frases."
                          className="bg-black/40 border-white/10 font-mono text-xs" />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Janela de horário */}
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                <p className="text-[11px] font-black uppercase tracking-widest text-amber-300 flex items-center gap-2 mb-3">
                  <Clock className="w-3 h-3" /> Horário de funcionamento (vale pra disparo + follow-up)
                </p>
                <div className="flex items-center gap-3">
                  <NumberInput min={0} max={23} fallback={9} value={formData.allowed_start_hour}
                    onChange={n => setFormData({ ...formData, allowed_start_hour: n })}
                    className="bg-black/40 border-white/10 h-8 w-20 text-xs" />
                  <span className="text-xs text-muted-foreground">até</span>
                  <NumberInput min={0} max={23} fallback={20} value={formData.allowed_end_hour}
                    onChange={n => setFormData({ ...formData, allowed_end_hour: n })}
                    className="bg-black/40 border-white/10 h-8 w-20 text-xs" />
                  <span className="text-[10px] text-muted-foreground">(0–23, hora local)</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 sm:justify-end">
                <Button onClick={closeForm} variant="ghost" disabled={creating} className="w-full sm:w-auto">Cancelar</Button>
                <Button onClick={() => saveAutomation(false)} disabled={creating} className="gap-2 bg-white/5 border border-white/10 hover:bg-white/10 text-white font-bold text-xs uppercase tracking-widest w-full sm:w-auto">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Salvar Rascunho
                </Button>
                <Button onClick={() => saveAutomation(true)} disabled={creating} className="gap-2 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white font-black text-xs uppercase tracking-widest w-full sm:w-auto">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  {editingId ? "Salvar e Iniciar" : "Salvar e Iniciar"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Lista de automações */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando…
          </div>
        ) : automations.length === 0 ? (
          <Card className="border-dashed border-white/10 bg-white/[0.02]">
            <CardContent className="py-12 text-center text-muted-foreground space-y-3">
              <Cpu className="w-10 h-10 opacity-30 mx-auto" />
              <p className="text-sm">Nenhuma automação criada ainda. Clica em <strong>Nova automação</strong> pra começar.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {automations.map(a => {
              const ph = PHASE_LABEL[a.phase] || PHASE_LABEL.idle;
              const isOpen = expanded === a.id;
              return (
                <Card key={a.id} className="border-white/10 bg-white/[0.02]">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <button onClick={() => setExpanded(isOpen ? null : a.id)} className="text-muted-foreground hover:text-white">
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-white truncate">{a.name}</p>
                          <p className="text-[10px] text-muted-foreground font-mono truncate">
                            #{a.instance_name} · agente {a.agent_id ?? "—"} · {a.scraped_count} captado(s)
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 shrink-0">
                        <span className={cn("text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-md border", ph.color)}>
                          {ph.label}
                        </span>
                        {a.status === "running" ? (
                          <Button onClick={() => pauseAutomation(a.id)} disabled={busyId === a.id} size="sm" variant="ghost" className="h-8 px-2 text-amber-400 gap-1">
                            {busyId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />} Pausar
                          </Button>
                        ) : (
                          <Button onClick={() => startAutomation(a.id)} disabled={busyId === a.id} size="sm" variant="ghost" className="h-8 px-2 text-emerald-400 gap-1">
                            {busyId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} {a.status === "done" || a.status === "error" ? "Rodar de novo" : "Iniciar"}
                          </Button>
                        )}
                        <Button onClick={() => openEditForm(a)} size="icon" variant="ghost" className="h-8 w-8 text-cyan-300" title="Editar automação">
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button onClick={() => deleteAutomation(a.id)} size="icon" variant="ghost" className="h-8 w-8 text-red-400" title="Apagar automação">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>

                    {a.last_error && (
                      <div className="mt-3 p-3 rounded-lg bg-red-500/15 border-2 border-red-500/50 text-red-100 text-xs flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-300" />
                        <div className="flex-1 min-w-0">
                          <p className="font-black uppercase text-[10px] tracking-widest text-red-300 mb-1">Último erro</p>
                          <p className="break-words whitespace-pre-wrap leading-relaxed">{a.last_error}</p>
                        </div>
                      </div>
                    )}

                    {isOpen && (
                      <div className="mt-4 pt-4 border-t border-white/5 space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-[11px]">
                          <Stat icon={MapPin}  label="Nichos"     value={(a.niches || []).join(", ") || "—"} color="text-blue-300" />
                          <Stat icon={MapPin}  label="Regiões"    value={(a.regions || []).join(", ") || "—"} color="text-blue-300" />
                          <Stat icon={Clock}   label="Horário"    value={`${String(a.allowed_start_hour).padStart(2,"0")}h–${String(a.allowed_end_hour).padStart(2,"0")}h`} color="text-amber-300" />
                          <Stat icon={Zap}     label="Disparo"    value={`${a.dispatch_min_interval}–${a.dispatch_max_interval}s${a.dispatch_personalize ? " · IA on" : ""}`} color="text-cyan-300" />
                          <Stat icon={Repeat}  label="Follow-up"  value={`${(a.followup_steps || []).length} step(s)${a.followup_ai_enabled ? " · IA on" : ""}`} color="text-purple-300" />
                          <Stat icon={a.campaign_id ? CheckCircle2 : XCircle} label="Campanha disparo" value={a.campaign_id ? a.campaign_id.slice(0,8) : "—"} color={a.campaign_id ? "text-emerald-300" : "text-zinc-500"} />
                          <Stat icon={a.followup_campaign_id ? CheckCircle2 : XCircle} label="Campanha follow-up" value={a.followup_campaign_id ? a.followup_campaign_id.slice(0,8) : "—"} color={a.followup_campaign_id ? "text-emerald-300" : "text-zinc-500"} />
                          <Stat icon={Clock}   label="Iniciada"   value={a.started_at ? new Date(a.started_at).toLocaleString("pt-BR") : "—"} color="text-zinc-400" />
                          <Stat icon={Clock}   label="Concluída"  value={a.finished_at ? new Date(a.finished_at).toLocaleString("pt-BR") : "—"} color="text-zinc-400" />
                        </div>

                        {/* Lead Intelligence — pré-analisar os leads captados.
                            Só faz sentido se tem leads colhidos (scraped_count > 0)
                            E a IA está ligada no disparo OU follow-up (senão briefing
                            não é usado em lugar nenhum, gasto à toa). */}
                        {a.scraped_count > 0 && (a.dispatch_personalize || a.followup_ai_enabled) && (
                          <AutomationLeadIntelBatch automationId={a.id} startedAt={a.started_at} scrapedCount={a.scraped_count} />
                        )}

                        {/* Painel de logs ao vivo */}
                        <AutomationLogs
                          automationId={a.id}
                          campaignId={a.campaign_id}
                          followupCampaignId={a.followup_campaign_id}
                          startedAt={a.started_at || a.updated_at || a.created_at}
                          scraping={a.phase === "scraping"}
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

/**
 * Sub-componente: carrega os IDs dos leads colhidos por uma automação
 * (filtrando por created_at >= started_at) e mostra o batch de pré-análise.
 *
 * Por que não passar lead_ids direto: a automação não tem coluna que liste
 * os leads dela. Calculamos por janela de tempo, igual o startDispatchPhase faz.
 */
function AutomationLeadIntelBatch({ automationId, startedAt, scrapedCount }: { automationId: string; startedAt: string | null; scrapedCount: number }) {
  const [leadIds, setLeadIds] = useState<number[]>([]);
  useEffect(() => {
    if (!startedAt) { setLeadIds([]); return; }
    let alive = true;
    supabase
      .from("leads_extraidos")
      .select("id")
      .gte("created_at", startedAt)
      .not("remoteJid", "is", null)
      .limit(scrapedCount + 50)
      .then(({ data }) => { if (alive) setLeadIds((data || []).map((r: any) => r.id)); });
    return () => { alive = false; };
  }, [automationId, startedAt, scrapedCount]);

  if (leadIds.length === 0) return null;

  return (
    <div className="rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/5 to-purple-500/5 p-3 space-y-2">
      <p className="text-[10px] font-black text-cyan-300 uppercase tracking-widest flex items-center gap-2">
        <Bot className="w-3.5 h-3.5" /> Lead Intelligence — pré-análise
      </p>
      <p className="text-[11px] text-cyan-100/80 leading-relaxed">
        IA estuda cada lead (Maps, site, busca web) ANTES de personalizar mensagens. Resulta em disparos cirúrgicos. Cache 30 dias — futuras automações pra esses leads reaproveitam.
      </p>
      <LeadIntelligenceBatch leadIds={leadIds} />
    </div>
  );
}

function Stat({ icon: Icon, label, value, color }: { icon: any; label: string; value: string; color: string }) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      <Icon className={cn("w-3.5 h-3.5 shrink-0 mt-0.5", color)} />
      <div className="min-w-0">
        <p className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">{label}</p>
        <p className="text-[11px] text-white truncate">{value}</p>
      </div>
    </div>
  );
}
