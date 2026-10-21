"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  Play, Pause, Trash2, Plus, Loader2, ChevronDown, ChevronRight, ChevronLeft, X,
  CheckCircle2, XCircle, Bot, MapPin, Zap, Repeat, Clock, Save, AlertTriangle, Pencil,
  Workflow, Sparkles, Target, MessageSquareText, Paperclip, ShieldCheck, LockKeyhole, type LucideIcon,
} from "lucide-react";
import { AutomationLogs } from "./AutomationLogs";
import { MediaUploader } from "@/components/media-uploader";
import { LeadIntelligenceBatch } from "@/components/lead-intelligence-batch";
import { ModelOptions } from "@/components/ai-module-shared";
import styles from "./automacao.module.css";

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
  dispatch_humanize: boolean;
  dispatch_ai_model: string | null;
  dispatch_ai_prompt: string | null;
  dispatch_media_url: string | null;
  dispatch_media_type: string | null;
  dispatch_media_caption: string | null;
  dispatch_media_file_name: string | null;
  dispatch_media_mimetype: string | null;
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

// SEM LISTA HARDCODED: modelos vêm 100% em tempo real de /api/ai-models
// (que consulta a API da Google). Modelos novos aparecem automaticamente
// sem deploy. Se a API falhar, dropdown fica vazio + aviso pro user.
const FALLBACK_MODELS: GeminiModel[] = [];

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

const PHASE_LABEL: Record<string, { label: string; icon: LucideIcon }> = {
  idle: { label: "Pronta", icon: Workflow },
  scraping: { label: "Captando", icon: MapPin },
  dispatching: { label: "Disparando", icon: Zap },
  following: { label: "Follow-up", icon: Repeat },
  done: { label: "Concluída", icon: CheckCircle2 },
  paused: { label: "Pausada", icon: Pause },
  error: { label: "Erro", icon: AlertTriangle },
};

const FORM_STEPS = [
  { label: "Identificação", description: "Nome, agente e conexão", icon: Workflow },
  { label: "Captação e análise", description: "Público e inteligência", icon: MapPin },
  { label: "Mensagem inicial", description: "Texto, IA e mídia", icon: MessageSquareText },
  { label: "Follow-up", description: "Sequência de contatos", icon: Repeat },
  { label: "Horários e revisão", description: "Janela de envio e resumo", icon: Clock },
];

export default function AutomacaoPage() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [aiModels, setAiModels] = useState<GeminiModel[]>(FALLBACK_MODELS);
  const [isAdmin, setIsAdmin] = useState(false);
  const [defaultAiModel, setDefaultAiModel] = useState<string | null>(null);
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
  const [formStep, setFormStep] = useState(0);
  const contentRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  function revealEditor() {
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = 0;
      editorRef.current?.focus({ preventScroll: true });
    });
  }

  function changeStep(step: number) {
    setFormStep(step);
    requestAnimationFrame(() => {
      const panel = document.getElementById(`automation-step-${step}`);
      panel?.focus({ preventScroll: true });
      panel?.scrollIntoView?.({ block: "start" });
    });
  }

  const editingAutomation = automations.find(a => a.id === editingId);
  const captureLocked = !!editingAutomation && (
    editingAutomation.scraped_count > 0 || editingAutomation.scrape_filters?._captureSessionId != null
  );

  function blankAutomation(): Partial<Automation> {
    return {
      name: "",
      instance_name: "",
      agent_id: null,
      niches: [],
      regions: [],
      scrape_filters: { filterEmpty: true, filterDuplicates: true, filterLandlines: true, captureAllReviews: false, reviews_ai: { enabled: false, model: null, prompt: null } },
      scrape_max_leads: 100,
      dispatch_template: "{{saudacao}} {{nome_empresa}}! Sou da Sarah Tech, vi sua empresa no Maps e queria saber se faz sentido conversarmos sobre [oferta]. Pode ser?",
      // Defaults SEGUROS WhatsApp: 60-180s aleatório (média ~2 min, ~30 envios/h)
      dispatch_min_interval: 60,
      dispatch_max_interval: 180,
      dispatch_personalize: false,
      dispatch_humanize: false,
      dispatch_media_url: null,
      dispatch_media_type: null,
      dispatch_media_caption: null,
      dispatch_media_file_name: null,
      dispatch_media_mimetype: null,
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

      setIsAdmin(!!session?.isAdmin && !session?.impersonating);
      setDefaultAiModel(session?.defaultAiModel || null);

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
        // pré-seleciona modelo de reviews-ai se vier vazio do formulário
        setFormData(prev => {
          const cur = prev.scrape_filters?.reviews_ai as any;
          if (cur && !cur.model && merged.length && !prev.scraped_count && prev.scrape_filters?._captureSessionId == null) {
            return { ...prev, scrape_filters: { ...prev.scrape_filters, reviews_ai: { ...cur, model: merged[0].id } } };
          }
          return prev;
        });
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
    setFormStep(0);
    setShowForm(true);
    revealEditor();
  }

  function openEditForm(a: Automation) {
    setEditingId(a.id);
    setFormData({
      ...a,
      // Não injeta defaults na configuração congelada de uma captura iniciada.
      scrape_filters: a.scraped_count > 0 || a.scrape_filters?._captureSessionId != null
        ? { ...a.scrape_filters }
        : {
          filterEmpty: true, filterDuplicates: true, filterLandlines: true,
          ...(a.scrape_filters || {}),
          captureAllReviews: a.scrape_filters?.captureAllReviews ?? false,
          reviews_ai: { enabled: false, model: null, prompt: null, ...(a.scrape_filters?.reviews_ai || {}) },
        },
      followup_steps: Array.isArray(a.followup_steps) ? a.followup_steps : [],
    });
    setNichesText((a.niches || []).join("\n"));
    setRegionsText((a.regions || []).join("\n"));
    setFormStep(0);
    setShowForm(true);
    revealEditor();
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
      // Checkpoints pertencem ao servidor; a API preserva os marcadores existentes.
      const scrape_filters = Object.fromEntries(Object.entries(formData.scrape_filters || {}).filter(
        ([key, value]) => !key.startsWith("_") || (key === "_source" && value === "prospeccao-sites"),
      ));
      const payload = { ...formData, niches, regions, scrape_filters };

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
    <div className={cn("flex flex-col h-[100dvh] overflow-hidden", styles.page)}>
      <Header />
      <main ref={contentRef} className={styles.content}>
        {/* Cabeçalho */}
        <div className={styles.heading}>
          <div>
            <h2>Automação completa</h2>
            <p>Da captação à conversa: configure mensagens, acompanhe os envios e deixe a IA assumir quando o cliente responder.</p>
          </div>
          <Button onClick={() => (showForm ? closeForm() : openCreateForm())} disabled={creating}
            className={showForm ? styles.secondaryAction : styles.primaryAction}>
            {showForm ? <><X className="w-4 h-4" /> Fechar configuração</> : <><Plus className="w-4 h-4" /> Nova automação</>}
          </Button>
        </div>

        {/* Stats Overview — visão imediata do estado da operação. Só aparece
            quando tem automações (não polui empty state pra primeira vez). */}
        {!loading && automations.length > 0 && (() => {
          const rodando = automations.filter(a => a.status === "running").length;
          const pausadas = automations.filter(a => a.status === "paused").length;
          const concluidas = automations.filter(a => a.status === "done").length;
          const totalCaptado = automations.reduce((sum, a) => sum + (a.scraped_count || 0), 0);
          const overview = [
            { label: "Em execução", value: rodando, icon: Play, state: "running" },
            { label: "Pausadas", value: pausadas, icon: Pause, state: "paused" },
            { label: "Concluídas", value: concluidas, icon: CheckCircle2, state: "done" },
            { label: "Leads captados", value: totalCaptado, icon: Target, state: "total" },
          ];
          return (
            <dl className={styles.overview} aria-label="Resumo das automações">
              {overview.map(({ label, value, icon: Icon, state }) => (
                <div key={label} data-state={state}>
                  <dt><Icon className="w-4 h-4" />{label}</dt>
                  <dd>{value.toLocaleString("pt-BR")}</dd>
                </div>
              ))}
            </dl>
          );
        })()}

        {/* Form de criação */}
        {showForm && (
          <Card ref={editorRef} tabIndex={-1} className={styles.editor} aria-labelledby="automation-editor-title">
            <CardHeader className={styles.editorHeader}>
              <div>
                <h3 id="automation-editor-title" className={styles.editorTitle}>
                  {editingId ? "Editando automação" : "Configurar nova automação"}
                </h3>
                <p>Configure no seu ritmo. Você pode salvar um rascunho em qualquer etapa.</p>
              </div>
              <span className={styles.stepCount}>Etapa {formStep + 1} de {FORM_STEPS.length}</span>
            </CardHeader>
            <CardContent className={styles.editorContent}>
              <div className={styles.editorLayout}>
                <nav className={styles.stepNav} aria-label="Etapas da configuração">
                  {FORM_STEPS.map((step, index) => {
                    const Icon = step.icon;
                    return (
                      <button key={step.label} type="button" aria-current={formStep === index ? "step" : undefined}
                        aria-controls={`automation-step-${index}`} onClick={() => changeStep(index)}>
                        <span className={styles.stepNumber}>{index + 1}</span>
                        <span><strong>{step.label}</strong><small>{step.description}</small></span>
                        <Icon className="w-4 h-4" />
                      </button>
                    );
                  })}
                </nav>
                <div className={styles.stepBody}>
              {editingAutomation?.status === "running" && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold mb-0.5">Esta automação está rodando.</p>
                    <p className="opacity-90">Pause a automação antes de editar e salvar a configuração.</p>
                  </div>
                </div>
              )}
              <section id="automation-step-0" tabIndex={-1} hidden={formStep !== 0} className={styles.stepPanel} aria-labelledby="identity-title">
                <div className={styles.sectionIntro}>
                  <h4 id="identity-title">Identifique sua automação</h4>
                  <p>Escolha um nome, o agente que assume as respostas e a conexão usada nos envios.</p>
                </div>
              <div className={styles.identityGrid}>
                <div>
                  <label htmlFor="automation-name">Nome da automação</label>
                  <Input id="automation-name" aria-required="true" value={formData.name || ""} onChange={e => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Pizzarias ES — Outubro" className="bg-black/40 border-white/10 h-10" />
                </div>
                <div>
                  <label htmlFor="automation-agent"><Bot className="w-3 h-3" /> Agente IA</label>
                  <select id="automation-agent" value={formData.agent_id || ""}
                    onChange={e => setFormData({ ...formData, agent_id: e.target.value ? Number(e.target.value) : null })}
                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-3 h-10 text-sm">
                    <option value="">— escolha um agente —</option>
                    {agents.map(a => <option key={a.id} value={a.id} className="bg-neutral-900">{a.name} (ID {a.id})</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="automation-instance">Instância WhatsApp</label>
                  <select id="automation-instance" aria-required="true" value={formData.instance_name || ""}
                    onChange={e => setFormData({ ...formData, instance_name: e.target.value })}
                    className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-3 h-10 text-sm">
                    <option value="">— escolha uma instância —</option>
                    {instances.map(i => <option key={i.instanceName} value={i.instanceName} className="bg-neutral-900">{i.instanceName}</option>)}
                  </select>
                </div>
              </div>

              <p className={styles.fieldHint}>Nome e instância WhatsApp são obrigatórios para salvar. As demais configurações estão nas próximas etapas.</p>
              </section>

              <section id="automation-step-1" tabIndex={-1} hidden={formStep !== 1} className={styles.stepPanel} aria-label="Captação e análise">
              <fieldset disabled={captureLocked} aria-label="Captação Google Maps" className={styles.formSection}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className={styles.sectionTitle}><MapPin className="w-4 h-4" /> Captação Google Maps</h4>
                  <p className={styles.fieldHint}>Defina o público que deseja alcançar.</p>
                </div>
                {captureLocked && <p className="text-[11px] text-blue-200">A captura já foi iniciada. Crie outra automação para mudar nichos, regiões, filtros ou meta.</p>}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="automation-niches">Nichos (um por linha)</label>
                    <Textarea id="automation-niches" rows={3}
                      value={nichesText}
                      onChange={e => setNichesText(e.target.value)}
                      placeholder="pizzaria artesanal&#10;hamburgueria gourmet&#10;açaí premium"
                      className="bg-black/40 border-white/10 font-mono text-xs" />
                  </div>
                  <div>
                    <label htmlFor="automation-regions">Regiões (uma por linha)</label>
                    <Textarea id="automation-regions" rows={3}
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
                    <label htmlFor="automation-limit">Limite de leads</label>
                    <NumberInput id="automation-limit" min={1} max={5000} fallback={100}
                      value={formData.scrape_max_leads}
                      onChange={n => setFormData({ ...formData, scrape_max_leads: n })}
                      className="bg-black/40 border-white/10 h-8 w-20 text-xs" />
                  </div>
                </div>

                {/* Resumo de avaliações com IA (reviews-ai) */}
                <div className={cn(
                  "rounded-lg border p-3 space-y-2 transition-colors",
                  formData.scrape_filters?.reviews_ai?.enabled
                    ? "border-cyan-400/40 bg-cyan-500/5"
                    : "border-white/10 bg-white/[0.02]"
                )}>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox"
                      checked={!!formData.scrape_filters?.reviews_ai?.enabled}
                      onChange={e => setFormData({
                        ...formData,
                        scrape_filters: {
                          ...formData.scrape_filters,
                          captureAllReviews: e.target.checked || !!formData.scrape_filters?.captureAllReviews,
                          reviews_ai: {
                            enabled: e.target.checked,
                            model: aiModels.length ? (formData.scrape_filters?.reviews_ai?.model || aiModels[0].id) : null,
                            prompt: formData.scrape_filters?.reviews_ai?.prompt ?? null,
                          },
                        },
                      })} />
                    <Bot className="w-3.5 h-3.5 text-cyan-300" />
                    <span className="font-bold text-cyan-200 text-xs">Resumir avaliações do Google com IA (antes do disparo)</span>
                  </label>
                  <p className="text-[10px] text-white/40 leading-relaxed">
                    Reúne TODAS as avaliações capturadas de cada lead e a IA resume elogios, reclamações e um gancho. Disponível como <code className="bg-black/40 px-1 rounded">{"{{resumo_avaliacoes}}"}</code> no template de disparo e follow-up. Ativa &quot;Capturar todas as avaliações&quot;.
                  </p>
                  {formData.scrape_filters?.reviews_ai?.enabled && (
                    <div className="space-y-2 pl-3 border-l border-cyan-500/30">
                      <div>
                        <label htmlFor="automation-reviews-model">Modelo de IA das avaliações</label>
                        <select id="automation-reviews-model"
                          value={formData.scrape_filters?.reviews_ai?.model || ""}
                          onChange={e => setFormData({
                            ...formData,
                            scrape_filters: { ...formData.scrape_filters, reviews_ai: { ...formData.scrape_filters!.reviews_ai!, model: e.target.value } },
                          })}
                          className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 h-8 text-xs"
                        >
                          {aiModels.length === 0 && <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — configure API key)"}</option>}
                          {aiModels.map((m: any) => <option key={m.id} value={m.id}>{m.name || m.id}{m.provider ? ` (${m.provider})` : ""}</option>)}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="automation-reviews-prompt">Prompt das avaliações (vazio usa o padrão: elogios, reclamações, gancho e nota geral)</label>
                        <Textarea id="automation-reviews-prompt" rows={2}
                          value={formData.scrape_filters?.reviews_ai?.prompt || ""}
                          onChange={e => setFormData({
                            ...formData,
                            scrape_filters: { ...formData.scrape_filters, reviews_ai: { ...formData.scrape_filters!.reviews_ai!, prompt: e.target.value || null } },
                          })}
                          placeholder="Ex: Resuma em tom comercial, focando dores que um site profissional resolveria…"
                          className="bg-black/40 border-white/10 font-mono text-xs" />
                      </div>
                    </div>
                  )}
                </div>
              </fieldset>

              {/* Lead Intelligence — entre captação e disparo. Análise IA de
                  cada lead colhido (site, busca web, Maps). O briefing é
                  injetado automaticamente no disparo, follow-up E agente. */}
              <div className={styles.formSection}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h4 className={styles.sectionTitle}><Bot className="w-4 h-4" /> Lead Intelligence <span className={styles.optional}>Opcional</span></h4>
                  <label className="flex items-center gap-2 text-[11px] cursor-pointer select-none">
                    <span className={cn("font-bold", formData.lead_intelligence_enabled ? "text-cyan-200" : "text-zinc-400")}>
                      {formData.lead_intelligence_enabled ? "ATIVADO" : "DESATIVADO"}
                    </span>
                    <input
                      type="checkbox"
                      aria-label="Ativar Lead Intelligence"
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

              </section>

              <section id="automation-step-2" tabIndex={-1} hidden={formStep !== 2} className={styles.stepPanel} aria-label="Mensagem inicial">
              <div className={styles.formSection}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className={styles.sectionTitle}><Zap className="w-4 h-4" /> Disparo inicial</h4>
                  <p className={styles.fieldHint}>Prepare o primeiro contato com cada lead.</p>
                </div>

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
                      { key: "reviews", label: "Reviews", hint: "Qtd. de reviews" },
                      { key: "resumo_avaliacoes", label: "Resumo aval.", hint: "Resumo IA das avaliações (reviews-ai)" },
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
                  <label htmlFor="automation-message">Mensagem-base (template)</label>
                  <Textarea id="automation-message" rows={4}
                    value={formData.dispatch_template || ""}
                    onChange={e => setFormData({ ...formData, dispatch_template: e.target.value })}
                    placeholder="Ex: {{saudacao}} {{nome_empresa}}! Vi vocês no Maps…"
                    className="bg-black/40 border-white/10 font-mono text-xs" />
                </div>

                <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 items-start sm:items-center">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">Intervalo aleatório entre envios (segundos):</span>
                    <div className="flex items-center gap-2">
                      <NumberInput aria-label="Intervalo mínimo entre envios (segundos)" min={5} fallback={60} value={formData.dispatch_min_interval}
                        onChange={n => setFormData({ ...formData, dispatch_min_interval: n })}
                        className="bg-black/40 border-white/10 h-8 w-16 text-xs" />
                      <span className="text-[10px] text-muted-foreground">até</span>
                      <NumberInput aria-label="Intervalo máximo entre envios (segundos)" min={5} fallback={180} value={formData.dispatch_max_interval}
                        onChange={n => setFormData({ ...formData, dispatch_max_interval: n })}
                        className="bg-black/40 border-white/10 h-8 w-16 text-xs" />
                    </div>
                  </div>
                  <p className="text-[9px] text-amber-300/80 italic flex items-center gap-1.5">
                    <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
                    <span>Recomendado: <strong>60–180s</strong> (anti-banimento WhatsApp).</span>
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
                    <div className="space-y-2 pl-4 border-l border-cyan-500/30">
                      <div>
                        <div className={styles.labelRow}>
                          <label htmlFor="automation-dispatch-model">Modelo de IA do disparo</label>
                          {loadingAiModels && <Loader2 className="w-3 h-3 animate-spin" />}
                          <button type="button" onClick={loadAiModels} className={styles.reloadAction}>Recarregar modelos</button>
                        </div>
                        <select id="automation-dispatch-model" value={isAdmin ? (formData.dispatch_ai_model || aiModels[0]?.id || "") : (defaultAiModel || "")}
                          onChange={e => setFormData({ ...formData, dispatch_ai_model: e.target.value })}
                          disabled={!isAdmin || aiModels.length === 0}
                          className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 h-8 text-xs disabled:opacity-50">
                          {aiModels.length === 0 ? (
                            <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — admin precisa configurar API key)"}</option>
                          ) : (
                            <>
                              {!isAdmin && defaultAiModel && !aiModels.some(m => m.id === defaultAiModel) && (
                                <option value={defaultAiModel} className="bg-neutral-900">{defaultAiModel}</option>
                              )}
                              <ModelOptions models={aiModels as any} />
                            </>
                          )}
                        </select>
                        {!isAdmin && (
                          <p className="text-[10px] text-cyan-300/80 mt-1.5 flex items-center gap-1">
                            <LockKeyhole aria-hidden="true" className="w-3 h-3 shrink-0" /><span>Modelo definido pelo administrador:</span>
                            <span className="font-mono font-bold bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20">{defaultAiModel || "Não configurado"}</span>
                          </p>
                        )}
                        {aiModelsError && isAdmin && (
                          <p className="text-[9px] text-amber-300/80 mt-0.5">{aiModelsError} — admin precisa salvar a chave Gemini em Configurações.</p>
                        )}
                      </div>
                      <div>
                        <label htmlFor="automation-dispatch-prompt">Prompt para a IA (instruções de como reescrever)</label>
                        <Textarea id="automation-dispatch-prompt" rows={4}
                          value={formData.dispatch_ai_prompt || ""}
                          onChange={e => setFormData({ ...formData, dispatch_ai_prompt: e.target.value })}
                          placeholder="Ex: Reescreva a mensagem-base de forma natural e única para cada cliente, mantendo o tom amigável e profissional. Não use emojis exagerados. Adapte ao ramo do negócio se for relevante. Mensagem deve ter no máximo 3 frases."
                          className="bg-black/40 border-white/10 font-mono text-xs" />
                        <p className="text-[9px] text-muted-foreground mt-1">
                          A IA recebe: prompt + mensagem-base + dados do lead (nome, ramo). Devolve a mensagem final que será enviada.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Humanizar — picotar mensagem */}
                <div className="border-t border-white/5 pt-3 space-y-2">
                  <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                    <input type="checkbox" checked={!!formData.dispatch_humanize}
                      onChange={e => setFormData({ ...formData, dispatch_humanize: e.target.checked })} />
                    <MessageSquareText className="w-3 h-3 text-emerald-300" />
                    <span className="font-bold text-emerald-200">Humanizar disparo (picotar mensagens)</span>
                  </label>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Quebra cada mensagem em <strong>várias partes menores</strong> e simula tempo de digitação entre elas (2–5s) — igual ao agente de IA. Funciona com mensagens reescritas por IA também. Reduz padrão robótico no WhatsApp.
                  </p>
                </div>

                {/* Mídia anexa — imagem/vídeo/documento enviado após o texto */}
                <div className="border-t border-white/5 pt-3 space-y-2">
                  <p className="text-[11px] font-bold text-cyan-200 flex items-center gap-1.5">
                    <Paperclip className="w-3 h-3" /> Anexar mídia (opcional)
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Envia <strong>logo após</strong> a mensagem de texto. Suporta imagem, vídeo, documento ou áudio. Limite por tipo: imagem/áudio 16&nbsp;MB, vídeo 64&nbsp;MB, documento até 100&nbsp;MB. Use para cartão de visita, catálogo, áudio de apresentação, etc.
                  </p>
                  <MediaUploader
                    mediaUrl={formData.dispatch_media_url ?? null}
                    mediaType={formData.dispatch_media_type ?? null}
                    mediaFileName={formData.dispatch_media_file_name ?? null}
                    mediaMimetype={formData.dispatch_media_mimetype ?? null}
                    onChange={(f) => setFormData({
                      ...formData,
                      dispatch_media_url: f.mediaUrl,
                      dispatch_media_type: f.mediaType,
                      dispatch_media_file_name: f.mediaFileName,
                      dispatch_media_mimetype: f.mediaMimetype,
                    })}
                  />
                  {(!!formData.dispatch_media_url) && (
                    <input
                      type="text"
                      aria-label="Legenda da mídia (opcional)"
                      placeholder="Legenda da mídia (opcional)"
                      value={formData.dispatch_media_caption ?? ""}
                      onChange={e => setFormData({ ...formData, dispatch_media_caption: e.target.value })}
                      className="w-full text-[11px] bg-zinc-900/70 border border-white/10 rounded px-2 py-1"
                    />
                  )}
                </div>
              </div>

              </section>

              <section id="automation-step-3" tabIndex={-1} hidden={formStep !== 3} className={styles.stepPanel} aria-label="Follow-up">
              <div className={styles.formSection}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h4 className={styles.sectionTitle}><Repeat className="w-4 h-4" /> Follow-up automático</h4>
                  {/* Toggle on/off — quando OFF, automação termina logo após o disparo */}
                  <label className="flex items-center gap-2 text-[11px] cursor-pointer select-none">
                    <span className={cn("font-bold", formData.followup_enabled !== false ? "text-purple-200" : "text-zinc-400")}>
                      {formData.followup_enabled !== false ? "ATIVADO" : "DESATIVADO"}
                    </span>
                    <input
                      type="checkbox"
                      aria-label="Ativar follow-up automático"
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
                        <label htmlFor={`followup-day-${idx}`}>Após (dias)</label>
                        <NumberInput id={`followup-day-${idx}`} min={1} fallback={1} value={step.day_offset}
                          onChange={n => {
                            const next = [...(formData.followup_steps || [])];
                            next[idx] = { ...next[idx], day_offset: n };
                            setFormData({ ...formData, followup_steps: next });
                          }}
                          className="bg-black/40 border-white/10 h-8 text-xs" />
                      </div>
                      <div className="flex-1">
                        <label htmlFor={`followup-message-${idx}`}>Mensagem do follow-up {idx + 1}</label>
                        <Textarea id={`followup-message-${idx}`} rows={2} value={step.template}
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
                      })} aria-label={`Remover follow-up ${idx + 1}`} variant="ghost" size="icon" className={cn(styles.iconAction, styles.dangerAction, "self-end sm:mt-6")}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                  <Button onClick={() => setFormData({
                    ...formData,
                    followup_steps: [...(formData.followup_steps || []), { day_offset: 3, template: "" }],
                  })} variant="outline" className={styles.secondaryAction}>
                    <Plus className="w-4 h-4" /> Adicionar etapa
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
                    <div className="space-y-2 pl-4 border-l border-purple-500/30">
                      <div>
                        <div className={styles.labelRow}>
                          <label htmlFor="automation-followup-model">Modelo de IA do follow-up</label>
                          {loadingAiModels && <Loader2 className="w-3 h-3 animate-spin" />}
                          <button type="button" onClick={loadAiModels} className={styles.reloadAction}>Recarregar modelos</button>
                        </div>
                        <select id="automation-followup-model" value={isAdmin ? (formData.followup_ai_model || aiModels[0]?.id || "") : (defaultAiModel || "")}
                          onChange={e => setFormData({ ...formData, followup_ai_model: e.target.value })}
                          disabled={!isAdmin || aiModels.length === 0}
                          className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 h-8 text-xs disabled:opacity-50">
                          {aiModels.length === 0 ? (
                            <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — admin precisa configurar API key)"}</option>
                          ) : (
                            <>
                              {!isAdmin && defaultAiModel && !aiModels.some(m => m.id === defaultAiModel) && (
                                <option value={defaultAiModel} className="bg-neutral-900">{defaultAiModel}</option>
                              )}
                              <ModelOptions models={aiModels as any} />
                            </>
                          )}
                        </select>
                        {!isAdmin && (
                          <p className="text-[10px] text-purple-300/80 mt-1.5 flex items-center gap-1">
                            <LockKeyhole aria-hidden="true" className="w-3 h-3 shrink-0" /><span>Modelo definido pelo administrador:</span>
                            <span className="font-mono font-bold bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20">{defaultAiModel || "Não configurado"}</span>
                          </p>
                        )}
                        {aiModelsError && isAdmin && (
                          <p className="text-[9px] text-amber-300/80 mt-0.5">{aiModelsError} — admin precisa salvar a chave Gemini em Configurações.</p>
                        )}
                      </div>
                      <div>
                        <label htmlFor="automation-followup-prompt">Prompt para a IA do follow-up</label>
                        <Textarea id="automation-followup-prompt" rows={4}
                          value={formData.followup_ai_prompt || ""}
                          onChange={e => setFormData({ ...formData, followup_ai_prompt: e.target.value })}
                          placeholder="Ex: Você é um SDR cordial fazendo follow-up sem ser insistente. Use o histórico pra puxar gancho do que o cliente já mencionou. Tom natural, máximo 3 frases."
                          className="bg-black/40 border-white/10 font-mono text-xs" />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              </section>

              <section id="automation-step-4" tabIndex={-1} hidden={formStep !== 4} className={styles.stepPanel} aria-label="Horários e revisão">
              <div className={styles.formSection}>
                <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
                  <h4 className={styles.sectionTitle}><Clock className="w-4 h-4" /> Horário permitido</h4>
                  <p className={styles.fieldHint}>Aplicado ao disparo e ao follow-up, na hora local.</p>
                </div>
                <div className="flex items-center gap-3">
                  <NumberInput aria-label="Horário inicial" min={0} max={23} fallback={9} value={formData.allowed_start_hour}
                    onChange={n => setFormData({ ...formData, allowed_start_hour: n })}
                    className="bg-black/40 border-white/10 h-8 w-20 text-xs" />
                  <span className="text-xs text-muted-foreground">até</span>
                  <NumberInput aria-label="Horário final" min={0} max={23} fallback={20} value={formData.allowed_end_hour}
                    onChange={n => setFormData({ ...formData, allowed_end_hour: n })}
                    className="bg-black/40 border-white/10 h-8 w-20 text-xs" />
                  <span className="text-[10px] text-muted-foreground">(0–23, hora local)</span>
                </div>
              </div>

              <div className={styles.review}>
                <h4>Revise antes de iniciar</h4>
                <dl>
                  <div><dt>Automação</dt><dd>{formData.name || "Nome não preenchido"}</dd></div>
                  <div><dt>WhatsApp</dt><dd>{formData.instance_name || "Selecione uma instância"}</dd></div>
                  <div><dt>Público</dt><dd>{nichesText.split("\n").filter(s => s.trim()).length} nicho(s) · {regionsText.split("\n").filter(s => s.trim()).length} região(ões) · até {formData.scrape_max_leads} leads</dd></div>
                  <div><dt>Mensagem</dt><dd>{formData.dispatch_personalize ? "Personalizada com IA" : "Mensagem-base"}{formData.dispatch_media_url ? " · com mídia" : ""}</dd></div>
                  <div><dt>Follow-up</dt><dd>{formData.followup_enabled !== false ? `${formData.followup_steps?.length || 0} etapa(s) configurada(s)` : "Desativado"}</dd></div>
                </dl>
                <p>Salvar e iniciar coloca a automação em execução. Para configurar sem executar, salve como rascunho.</p>
              </div>
              </section>
                </div>
              </div>
              <div className={styles.formFooter}>
                <div className={styles.stepActions}>
                  <Button onClick={() => changeStep(formStep - 1)} disabled={formStep === 0 || creating} variant="ghost" className={styles.secondaryAction}>
                    <ChevronLeft className="w-4 h-4" /> Voltar
                  </Button>
                  {formStep < FORM_STEPS.length - 1 && <Button onClick={() => changeStep(formStep + 1)} className={styles.secondaryAction}>
                    Próxima etapa <ChevronRight className="w-4 h-4" />
                  </Button>}
                </div>
                <div className={styles.saveActions}>
                  <Button onClick={closeForm} variant="ghost" disabled={creating} className={styles.textAction}>Cancelar</Button>
                  <Button onClick={() => saveAutomation(false)} disabled={creating || editingAutomation?.status === "running"} className={styles.secondaryAction}>
                    {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Salvar Rascunho
                  </Button>
                  <Button onClick={() => saveAutomation(true)} disabled={creating || editingAutomation?.status === "running"} className={styles.primaryAction}>
                    {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    Salvar e Iniciar
                  </Button>
                </div>
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
          !showForm && <section className={styles.empty}>
            <Workflow className="w-8 h-8" />
            <h3>Sua próxima conversa começa aqui</h3>
            <p>Conecte a captação no Google Maps, a mensagem inicial e os retornos em uma automação. Quando o cliente responder, seu agente IA assume a conversa.</p>
            <ol className={styles.emptyFlow}>
              {[
                { icon: MapPin, label: "Captação" },
                { icon: Sparkles, label: "Análise" },
                { icon: Zap, label: "Disparo" },
                { icon: Bot, label: "Conversa com IA" },
              ].map(({ icon: Icon, label }) => <li key={label}><Icon className="w-4 h-4" />{label}</li>)}
            </ol>
            <Button onClick={openCreateForm} className={styles.primaryAction}>
              <Plus className="w-4 h-4" /> Criar primeira automação
            </Button>
          </section>
        ) : (
          <section className={styles.automationList} aria-labelledby="automations-title">
            <div className={styles.listHeading}>
              <h3 id="automations-title">Suas automações <span>{automations.length}</span></h3>
              <p>Expanda uma automação para ver os detalhes e o histórico.</p>
            </div>
            {automations.map(a => {
              const ph = PHASE_LABEL[a.phase] || PHASE_LABEL.idle;
              const PhaseIcon = ph.icon;
              const isOpen = expanded === a.id;
              return (
                <Card key={a.id} className={styles.automation} data-state={a.status}>
                  <CardContent className={styles.automationContent}>
                    <div className={styles.automationHeader}>
                      <button type="button" onClick={() => setExpanded(isOpen ? null : a.id)}
                        aria-expanded={isOpen} aria-controls={`automation-details-${a.id}`} className={styles.automationToggle}>
                        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        <span className={styles.automationIdentity}>
                          <strong>{a.name}</strong>
                          <span>{a.instance_name} · agente {a.agent_id ?? "—"} · <b>{a.scraped_count || 0}</b> {a.scraped_count === 1 ? "lead captado" : "leads captados"}</span>
                        </span>
                      </button>
                      <div className={styles.automationActions}>
                        <span className={styles.status} data-phase={a.phase}><PhaseIcon className="w-3.5 h-3.5" />{ph.label}</span>
                        {a.status === "running" ? (
                          <Button onClick={() => pauseAutomation(a.id)} disabled={busyId === a.id} size="sm" variant="ghost" className={cn(styles.secondaryAction, styles.pauseAction)}>
                            {busyId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />} Pausar
                          </Button>
                        ) : (
                          <Button onClick={() => startAutomation(a.id)} disabled={busyId === a.id} size="sm" variant="ghost" className={cn(styles.secondaryAction, styles.startAction)}>
                            {busyId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} {a.status === "done" || a.status === "error" ? "Rodar de novo" : "Iniciar"}
                          </Button>
                        )}
                        <Button onClick={() => openEditForm(a)} size="icon" variant="ghost" className={styles.iconAction} title="Editar automação" aria-label={`Editar automação ${a.name}`}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button onClick={() => deleteAutomation(a.id)} size="icon" variant="ghost" className={cn(styles.iconAction, styles.dangerAction)} title="Apagar automação" aria-label={`Apagar automação ${a.name}`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>

                    {a.last_error && (
                      <div className="mt-3 p-3 rounded-lg bg-red-500/15 border-2 border-red-500/50 text-red-100 text-xs flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-300" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-xs text-red-200 mb-1">Último erro</p>
                          <p className="break-words whitespace-pre-wrap leading-relaxed">{a.last_error}</p>
                        </div>
                      </div>
                    )}

                    {isOpen && (
                      <div id={`automation-details-${a.id}`} className={styles.automationDetails}>
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
                          startedAt={a.started_at || a.updated_at || a.created_at || null}
                          scraping={a.phase === "scraping"}
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </section>
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
    // Reset síncrono ao trocar de automação + fetch assinado logo abaixo (padrão data-fetch).
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    <div className={styles.intelligenceBatch}>
      <p className="text-xs font-medium text-cyan-200 flex items-center gap-2">
        <Bot className="w-3.5 h-3.5" /> Lead Intelligence — pré-análise
      </p>
      <p className="text-[11px] text-cyan-100/80 leading-relaxed">
        IA estuda cada lead (Maps, site, busca web) ANTES de personalizar mensagens. Resulta em disparos cirúrgicos. Cache 30 dias — futuras automações pra esses leads reaproveitam.
      </p>
      <LeadIntelligenceBatch leadIds={leadIds} />
    </div>
  );
}

function Stat({ icon: Icon, label, value, color }: { icon: LucideIcon; label: string; value: string; color: string }) {
  return (
    <div className={styles.stat}>
      <Icon className={cn("w-3.5 h-3.5 shrink-0 mt-0.5", color)} />
      <div className="min-w-0">
        <p>{label}</p>
        <p>{value}</p>
      </div>
    </div>
  );
}
