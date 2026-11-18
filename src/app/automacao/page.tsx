"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { useClientSession } from "@/lib/use-session";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { parseMinReviews } from "@/lib/scraper-review-count";
import {
  applyScraperFilterChange,
  parseGoogleYear,
  parseMaxReviews,
  parseMinCapitalSocial,
  parseRatingBound,
  SCRAPER_PRESET_OPTIONS,
  validateGoogleYearRange,
  validateRatingRange,
  validateReviewCountRange,
  type ScraperFilterChangeAction,
  type ScraperFilterSyncState,
  type ScraperPresetId,
} from "@/lib/scraper-lead-filters";
import type { SiteFilterMode } from "@/lib/scraper-lead-enrichment";
import {
  Play, Pause, Trash2, Plus, Loader2, ChevronDown, ChevronRight, ChevronLeft, X,
  CheckCircle2, XCircle, Bot, MapPin, Zap, Repeat, Clock, Save, AlertTriangle, Pencil,
  Workflow, Sparkles, Target, MessageSquareText, Paperclip, ShieldCheck, LockKeyhole, Globe, Info, type LucideIcon,
} from "lucide-react";
import { AutomationLogs } from "./AutomationLogs";
import { MediaUploader } from "@/components/media-uploader";
import { LeadIntelligenceBatch } from "@/components/lead-intelligence-batch";
import { ModelOptions } from "@/components/ai-module-shared";
import { AUTO_POOL_INSTANCE, formatInstanceLabel } from "@/lib/campaign-pool";
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
const MIN_REVIEWS_HELP = "Quantidade de pessoas que deram estrelas, com ou sem comentário. Não filtra pela nota. 0 = sem mínimo.";
const MIN_REVIEWS_ERROR = "Informe um inteiro entre 0 e 2147483647.";
const INSTAGRAM_FILTER_HELP = "Exige perfil informado no Google Maps; não busca no site.";

const SITE_FILTER_MODE_OPTIONS: { value: SiteFilterMode; label: string }[] = [
  { value: "any", label: "Todos" },
  { value: "no_site", label: "Sem site" },
  { value: "broken_or_no_site", label: "Sem site + Quebrado" },
  { value: "only_broken_or_weak", label: "Só Site Quebrado/Fraco" },
  { value: "only_active_site", label: "Só Site Ativo" },
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
  const { clientId } = useClientSession();
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
  const [minReviews, setMinReviews] = useState("0");
  const [minReviewsError, setMinReviewsError] = useState(false);
  const [maxReviews, setMaxReviews] = useState("0");
  const [minRating, setMinRating] = useState("0");
  const [maxRating, setMaxRating] = useState("0");
  const [googleYearFrom, setGoogleYearFrom] = useState("0");
  const [googleYearTo, setGoogleYearTo] = useState("0");
  const [minCapitalSocial, setMinCapitalSocial] = useState("0");
  const [extraFiltersError, setExtraFiltersError] = useState("");
  const [filterSyncNote, setFilterSyncNote] = useState<string | null>(null);
  // Configurações de delay de presença "digitando..." (Evolution API)
  const [typingDelayMode, setTypingDelayMode] = useState<"fixed" | "random">("random");
  const [typingDelaySeconds, setTypingDelaySeconds] = useState(10);
  const [typingDelayMinSeconds, setTypingDelayMinSeconds] = useState(5);
  const [typingDelayMaxSeconds, setTypingDelayMaxSeconds] = useState(25);
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

  function renderPresetIcon(presetId: ScraperPresetId) {
    if (presetId === "vender_sites") return <Globe className="w-4 h-4" />;
    if (presetId === "vender_ia") return <Bot className="w-4 h-4" />;
    if (presetId === "direto_socio") return <Target className="w-4 h-4" />;
    return <Zap className="w-4 h-4" />;
  }

  function applyAutomationFilterSync(action: ScraperFilterChangeAction) {
    const allowsDispatchOnly = action.type === "personalizeWithAi" || action.type === "antibanMixer";
    if (captureLocked && !allowsDispatchOnly) return;
    const sf = formData.scrape_filters || {};
    const curMode = (sf.siteFilterMode || (sf.filterWithWebsite ? "no_site" : "any")) as SiteFilterMode;
    const currentState: ScraperFilterSyncState = {
      filterEmpty: sf.filterEmpty !== false,
      filterDuplicates: sf.filterDuplicates !== false,
      filterLandlines: Boolean(sf.filterLandlines),
      filterWithWebsite: Boolean(sf.filterWithWebsite),
      filterWithInstagram: Boolean(sf.filterWithInstagram),
      captureAllReviews: Boolean(sf.captureAllReviews),
      reviewsAiEnabled: Boolean(sf.reviews_ai?.enabled),
      turboMode: sf.turboMode !== false,
      filterClosedBusinesses: sf.filterClosedBusinesses !== false,
      auditSiteHealth: sf.auditSiteHealth !== false,
      siteFilterMode: curMode,
      enrichCnpj: sf.enrichCnpj !== false,
      prioritizePartnerPhone: sf.prioritizePartnerPhone !== false,
      validateWhatsApp: sf.validateWhatsApp !== false,
      excludeMei: Boolean(sf.excludeMei),
      excludeFranchises: Boolean(sf.excludeFranchises),
      huntPartnerDirectPhone: Boolean(sf.huntPartnerDirectPhone),
      expandNeighborhoods: Boolean(sf.expandNeighborhoods),
      prioritizeByScore: sf.prioritize_by_score !== false,
      minCapitalSocial,
      personalizeWithAi: Boolean(formData.dispatch_personalize),
      antibanMixer: sf.antiban_mixer !== false,
    };

    const { state: next, autoNote } = applyScraperFilterChange(currentState, action, "automacao");
    setMinCapitalSocial(next.minCapitalSocial);
    setExtraFiltersError("");
    setFilterSyncNote(autoNote);

    const prevReviewsModel = sf.reviews_ai?.model ?? null;
    const nextReviewsModel = next.reviewsAiEnabled
      ? (prevReviewsModel || (aiModels.length ? aiModels[0].id : null))
      : prevReviewsModel;

    setFormData(prev => ({
      ...prev,
      ...(typeof next.personalizeWithAi === "boolean" ? { dispatch_personalize: next.personalizeWithAi } : {}),
      scrape_filters: {
        ...(prev.scrape_filters || {}),
        ...(allowsDispatchOnly
          ? {
              antiban_mixer: next.antibanMixer !== false,
            }
          : {
              filterEmpty: next.filterEmpty,
              filterDuplicates: next.filterDuplicates,
              filterLandlines: next.filterLandlines,
              filterWithWebsite: next.filterWithWebsite,
              filterWithInstagram: next.filterWithInstagram,
              captureAllReviews: next.captureAllReviews,
              turboMode: next.turboMode,
              filterClosedBusinesses: next.filterClosedBusinesses,
              auditSiteHealth: next.auditSiteHealth,
              siteFilterMode: next.siteFilterMode,
              enrichCnpj: next.enrichCnpj,
              prioritizePartnerPhone: next.prioritizePartnerPhone,
              validateWhatsApp: next.validateWhatsApp,
              excludeMei: next.excludeMei,
              excludeFranchises: next.excludeFranchises,
              huntPartnerDirectPhone: next.huntPartnerDirectPhone,
              expandNeighborhoods: next.expandNeighborhoods,
              prioritize_by_score: next.prioritizeByScore,
              antiban_mixer: next.antibanMixer !== false,
              cold_shield: sf.cold_shield !== false,
              reviews_ai: {
                enabled: next.reviewsAiEnabled,
                model: nextReviewsModel,
                prompt: prev.scrape_filters?.reviews_ai?.prompt ?? null,
              },
            }),
      },
    }));
  }

  function blankAutomation(): Partial<Automation> {
    return {
      name: "",
      instance_name: "",
      agent_id: null,
      niches: [],
      regions: [],
      scrape_filters: {
        filterEmpty: true,
        filterDuplicates: true,
        filterLandlines: true,
        minReviews: 0,
        filterWithInstagram: false,
        filterWithWebsite: false,
        captureAllReviews: false,
        turboMode: true,
        filterClosedBusinesses: true,
        auditSiteHealth: true,
        siteFilterMode: "any",
        enrichCnpj: true,
        prioritizePartnerPhone: true,
        validateWhatsApp: true,
        excludeMei: false,
        excludeFranchises: false,
        huntPartnerDirectPhone: false,
        expandNeighborhoods: false,
        prioritize_by_score: true,
        antiban_mixer: true,
        cold_shield: true,
        reviews_ai: { enabled: false, model: null, prompt: null },
      },
      scrape_max_leads: 100,
      dispatch_template: "{{saudacao}}! Tudo bem? {{nome_empresa}}?",
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

      const [autoRes, agRes, instRes, evoRes] = await Promise.all([
        safeJson("/api/automations"),
        safeJson("/api/agent/settings"),
        safeJson("/api/instances?scope=tenant"),
        safeJson("/api/whatsapp?instances=true"),
      ]);
      if (autoRes.success) setAutomations(autoRes.automations || []);
      if (Array.isArray(agRes.agents)) setAgents(agRes.agents as Agent[]);
      const fromDb = ((instRes?.instances || []) as Array<{ instance_name?: string; instanceName?: string }>)
        .map((c) => ({ instanceName: c.instance_name || c.instanceName || "" }))
        .filter((x) => Boolean(x.instanceName));
      
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
    const ch = clientId && typeof supabase?.channel === "function"
      ? supabase
          .channel(`automations-live-${clientId}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "automations", filter: `client_id=eq.${clientId}` },
            (payload: any) => {
              if (payload?.new?.client_id && payload.new.client_id !== clientId) return;
              debouncedLoad();
            }
          )
          .subscribe()
      : null;
    // Fallback de polling suave caso o canal Realtime seja bloqueado por RLS/rede
    const pollId = setInterval(() => {
      if (!document.hidden) loadAll(false);
    }, 15_000);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(pollId);
      if (ch) supabase.removeChannel(ch);
    };
  }, [loadAll, clientId]);

  function openCreateForm() {
    setEditingId(null);
    setFormData(blankAutomation());
    setNichesText("");
    setRegionsText("");
    setMinReviews("0");
    setMinReviewsError(false);
    setMaxReviews("0");
    setMinRating("0");
    setMaxRating("0");
    setGoogleYearFrom("0");
    setGoogleYearTo("0");
    setMinCapitalSocial("0");
    setExtraFiltersError("");
    setFilterSyncNote(null);
    setTypingDelayMode("random");
    setTypingDelaySeconds(10);
    setTypingDelayMinSeconds(5);
    setTypingDelayMaxSeconds(25);
    setFormStep(0);
    setShowForm(true);
    revealEditor();
  }

  function openEditForm(a: Automation) {
    setEditingId(a.id);
    const sf = a.scrape_filters || {};
    setTypingDelayMode(sf.typing_delay_mode || sf.typing_delay?.mode || "random");
    setTypingDelaySeconds(Number(sf.typing_delay_seconds || sf.typing_delay?.seconds || 10));
    setTypingDelayMinSeconds(Number(sf.typing_delay_min_seconds || sf.typing_delay?.min_seconds || 5));
    setTypingDelayMaxSeconds(Number(sf.typing_delay_max_seconds || sf.typing_delay?.max_seconds || 25));
    setFormData({
      ...a,
      // Não injeta defaults na configuração congelada de uma captura iniciada.
      scrape_filters: a.scraped_count > 0 || a.scrape_filters?._captureSessionId != null
        ? { ...a.scrape_filters }
        : {
          filterEmpty: true, filterDuplicates: true, filterLandlines: true,
          minReviews: 0, filterWithInstagram: false, filterWithWebsite: false,
          ...(a.scrape_filters || {}),
          captureAllReviews: a.scrape_filters?.captureAllReviews ?? false,
          turboMode: a.scrape_filters?.turboMode ?? true,
          filterClosedBusinesses: a.scrape_filters?.filterClosedBusinesses ?? true,
          auditSiteHealth: a.scrape_filters?.auditSiteHealth ?? true,
          siteFilterMode: a.scrape_filters?.siteFilterMode ?? (a.scrape_filters?.filterWithWebsite ? "no_site" : "any"),
          enrichCnpj: a.scrape_filters?.enrichCnpj ?? true,
          prioritizePartnerPhone: a.scrape_filters?.prioritizePartnerPhone ?? true,
          validateWhatsApp: a.scrape_filters?.validateWhatsApp ?? true,
          excludeMei: a.scrape_filters?.excludeMei ?? false,
          excludeFranchises: a.scrape_filters?.excludeFranchises ?? false,
          huntPartnerDirectPhone: a.scrape_filters?.huntPartnerDirectPhone ?? false,
          expandNeighborhoods: a.scrape_filters?.expandNeighborhoods ?? false,
          prioritize_by_score: a.scrape_filters?.prioritize_by_score ?? true,
          reviews_ai: { enabled: false, model: null, prompt: null, ...(a.scrape_filters?.reviews_ai || {}) },
        },
      followup_steps: Array.isArray(a.followup_steps) ? a.followup_steps : [],
    });
    setNichesText((a.niches || []).join("\n"));
    setRegionsText((a.regions || []).join("\n"));
    setMinReviews(String(a.scrape_filters?.minReviews ?? 0));
    setMinReviewsError(false);
    setMaxReviews(String(a.scrape_filters?.maxReviews ?? 0));
    setMinRating(String(a.scrape_filters?.minRating ?? 0));
    setMaxRating(String(a.scrape_filters?.maxRating ?? 0));
    setGoogleYearFrom(String(a.scrape_filters?.googleYearFrom ?? 0));
    setGoogleYearTo(String(a.scrape_filters?.googleYearTo ?? 0));
    setMinCapitalSocial(String(a.scrape_filters?.minCapitalSocial ?? 0));
    setExtraFiltersError("");
    setFilterSyncNote(null);
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
    setTypingDelayMode("random");
    setTypingDelaySeconds(10);
    setTypingDelayMinSeconds(5);
    setTypingDelayMaxSeconds(25);
    setMinReviews("0");
    setMinReviewsError(false);
    setMaxReviews("0");
    setMinRating("0");
    setMaxRating("0");
    setGoogleYearFrom("0");
    setGoogleYearTo("0");
    setMinCapitalSocial("0");
    setExtraFiltersError("");
    setFilterSyncNote(null);
  }

  async function saveAutomation(startImmediately: boolean = false) {
    const minimum = captureLocked ? undefined : parseMinReviews(minReviews.trim() === "" ? null : Number(minReviews));
    setMinReviewsError(minimum === null);
    const parsedMaxReviews = captureLocked ? 0 : parseMaxReviews(maxReviews);
    const parsedMinRating = captureLocked ? 0 : parseRatingBound(minRating);
    const parsedMaxRating = captureLocked ? 0 : parseRatingBound(maxRating);
    const parsedYearFrom = captureLocked ? 0 : parseGoogleYear(googleYearFrom);
    const parsedYearTo = captureLocked ? 0 : parseGoogleYear(googleYearTo);
    const parsedMinCapital = captureLocked ? 0 : parseMinCapitalSocial(minCapitalSocial);
    let extraErr = "";
    if (!captureLocked) {
      if (parsedMaxReviews === null) extraErr = "Máximo de avaliações deve ser um inteiro entre 0 e 2147483647.";
      else if (minimum !== null && minimum !== undefined) {
        const revErr = validateReviewCountRange(minimum, parsedMaxReviews);
        if (revErr) extraErr = revErr;
      }
      if (!extraErr && (parsedMinRating === null || parsedMaxRating === null)) {
        extraErr = "Nota mínima e máxima devem estar entre 0 e 5.";
      } else if (!extraErr && parsedMinRating !== null && parsedMaxRating !== null) {
        const ratErr = validateRatingRange(parsedMinRating, parsedMaxRating);
        if (ratErr) extraErr = ratErr;
      }
      if (!extraErr && (parsedYearFrom === null || parsedYearTo === null)) {
        extraErr = "Informe um ano válido no Google (ex.: 2019) ou 0 para desativar.";
      } else if (!extraErr && parsedYearFrom !== null && parsedYearTo !== null) {
        const yrErr = validateGoogleYearRange(parsedYearFrom, parsedYearTo);
        if (yrErr) extraErr = yrErr;
      }
      if (!extraErr && parsedMinCapital === null) {
        extraErr = "Capital social mínimo deve ser um número maior ou igual a 0.";
      }
    }
    setExtraFiltersError(extraErr);
    if (minimum === null || extraErr) {
      changeStep(1);
      return;
    }
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
      if (!captureLocked) {
        scrape_filters.minReviews = minimum;
        if (parsedMaxReviews && parsedMaxReviews > 0) scrape_filters.maxReviews = parsedMaxReviews;
        else delete scrape_filters.maxReviews;
        if (parsedMinRating && parsedMinRating > 0) scrape_filters.minRating = parsedMinRating;
        else delete scrape_filters.minRating;
        if (parsedMaxRating && parsedMaxRating > 0) scrape_filters.maxRating = parsedMaxRating;
        else delete scrape_filters.maxRating;
        if (parsedYearFrom && parsedYearFrom > 0) scrape_filters.googleYearFrom = parsedYearFrom;
        else delete scrape_filters.googleYearFrom;
        if (parsedYearTo && parsedYearTo > 0) scrape_filters.googleYearTo = parsedYearTo;
        else delete scrape_filters.googleYearTo;
        if (parsedMinCapital && parsedMinCapital > 0) scrape_filters.minCapitalSocial = parsedMinCapital;
        else delete scrape_filters.minCapitalSocial;
      }
      if (formData.scrape_filters?.typing_delay || formData.scrape_filters?.typing_delay_mode) {
        scrape_filters.typing_delay_mode = typingDelayMode;
        scrape_filters.typing_delay_seconds = typingDelaySeconds;
        scrape_filters.typing_delay_min_seconds = typingDelayMinSeconds;
        scrape_filters.typing_delay_max_seconds = typingDelayMaxSeconds;
        scrape_filters.typing_delay = {
          mode: typingDelayMode,
          seconds: typingDelaySeconds,
          min_seconds: typingDelayMinSeconds,
          max_seconds: typingDelayMaxSeconds,
        };
      }
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
              <div className={styles.filterGroup}>
                <div className={styles.identityGrid}>
                  <div>
                    <label htmlFor="automation-name">Nome da automação</label>
                    <Input id="automation-name" aria-required="true" value={formData.name || ""} onChange={e => setFormData({ ...formData, name: e.target.value })}
                      placeholder="Pizzarias ES — Outubro" />
                  </div>
                  <div>
                    <label htmlFor="automation-agent"><Bot className="w-3.5 h-3.5 text-[#9ce9bc]" /> Agente IA</label>
                    <select id="automation-agent" value={formData.agent_id || ""}
                      onChange={e => setFormData({ ...formData, agent_id: e.target.value ? Number(e.target.value) : null })}
                      className="w-full mt-0.5 rounded-md px-3">
                      <option value="">— escolha um agente —</option>
                      {agents.map(a => <option key={a.id} value={a.id} className="bg-neutral-900">{a.name} (ID {a.id})</option>)}
                    </select>
                    <p className={styles.editorFieldHint}>Opcional: assume o atendimento quando o lead responder no WhatsApp.</p>
                  </div>
                  <div>
                    <label htmlFor="automation-instance">Instância WhatsApp</label>
                    <select id="automation-instance" aria-required="true" value={formData.instance_name || ""}
                      onChange={e => setFormData({ ...formData, instance_name: e.target.value })}
                      className="w-full mt-0.5 rounded-md px-3">
                      <option value="">— escolha uma instância —</option>
                      {instances.length >= 1 && (
                        <option value={AUTO_POOL_INSTANCE} className="bg-neutral-900">
                          Pool Automático (alternar entre chips saudáveis)
                        </option>
                      )}
                      {instances.map(i => <option key={i.instanceName} value={i.instanceName} className="bg-neutral-900">{i.instanceName}</option>)}
                    </select>
                    <p className={styles.editorFieldHint}>Chip ou pool utilizado para os envios iniciais e follow-ups.</p>
                  </div>
                </div>
              </div>

              <p className={styles.fieldHint}>Nome e instância WhatsApp são obrigatórios para salvar. As demais configurações estão nas próximas etapas.</p>
              </section>

              <section id="automation-step-1" tabIndex={-1} hidden={formStep !== 1} className={styles.stepPanel} aria-label="Captação e análise">
              <fieldset disabled={captureLocked} aria-label="Captação Google Maps" className={styles.formSection}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className={styles.sectionTitle}><MapPin className="w-4 h-4" /> Captação Google Maps</h4>
                  <p className={styles.fieldHint}>Defina o público ideal, qualifique empresas e evite filtros conflitantes.</p>
                </div>
                {captureLocked && (
                  <div className={styles.syncBanner}>
                    <span className={styles.syncBannerText}>
                      <Info className="w-4 h-4" />
                      <span>A captura já foi iniciada. Crie outra automação para mudar nichos, regiões, filtros ou meta.</span>
                    </span>
                  </div>
                )}

                {!captureLocked && (
                  <div className={styles.filterGroup}>
                    <div className={styles.groupHeader}>
                      <Sparkles className="w-4 h-4" />
                      <div>
                        <h5 className={styles.groupTitle}>Atalhos por objetivo</h5>
                        <p className={styles.groupDesc}>Clique em um perfil para preencher automaticamente todos os filtros recomendados abaixo.</p>
                      </div>
                    </div>
                    <div className={styles.presetGrid}>
                      {SCRAPER_PRESET_OPTIONS.map(preset => (
                        <button
                          key={preset.id}
                          type="button"
                          aria-label={preset.label}
                          disabled={captureLocked}
                          onClick={() => applyAutomationFilterSync({ type: "preset", preset: preset.id })}
                          className={styles.presetCard}
                        >
                          {renderPresetIcon(preset.id)}
                          <span className={styles.presetCardText}>
                            <span className={styles.presetCardTitle}>{preset.label}</span>
                            <span className={styles.presetCardDesc}>{preset.shortDesc}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {filterSyncNote && (
                      <div role="status" className={styles.syncBanner}>
                        <span className={styles.syncBannerText}>
                          <Info className="w-4 h-4" />
                          <span>{filterSyncNote}</span>
                        </span>
                        <button type="button" onClick={() => setFilterSyncNote(null)} className={styles.syncClose}>Fechar</button>
                      </div>
                    )}
                  </div>
                )}

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <MapPin className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Onde buscar e meta de leads</h5>
                      <p className={styles.groupDesc}>O robô combina cada nicho com cada região até atingir a meta configurada.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="automation-niches">Nichos (um por linha)</label>
                      <Textarea id="automation-niches" rows={3}
                        value={nichesText}
                        onChange={e => setNichesText(e.target.value)}
                        placeholder="pizzaria artesanal&#10;hamburgueria gourmet&#10;açaí premium" />
                    </div>
                    <div>
                      <label htmlFor="automation-regions">Regiões (uma por linha)</label>
                      <Textarea id="automation-regions" rows={3}
                        value={regionsText}
                        onChange={e => setRegionsText(e.target.value)}
                        placeholder="Vitória/ES&#10;Vila Velha/ES&#10;Serra/ES" />
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 pt-1">
                    <div className="w-full sm:w-44">
                      <label htmlFor="automation-limit">Limite de leads</label>
                      <NumberInput id="automation-limit" min={1} max={5000} fallback={100}
                        value={formData.scrape_max_leads}
                        onChange={n => setFormData({ ...formData, scrape_max_leads: n })}
                        className="w-full" />
                    </div>
                    <p className={styles.fieldHint}>Somente leads elegíveis e salvos contam para o limite. A captura continua enquanto estiver abaixo da meta, retomando ou ampliando a busca antes do disparo.</p>
                  </div>
                  <div className={styles.optionList}>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-expand-neighborhoods" className={styles.optionTitle}>Busca profunda por bairros (anti-teto 120 leads)</label>
                        <p id="automation-expand-neighborhoods-help" className={styles.optionDesc}>Subdivide grandes cidades pelos principais bairros comerciais quando a busca atinge o limite por consulta.</p>
                      </div>
                      <Switch
                        id="automation-expand-neighborhoods"
                        aria-describedby="automation-expand-neighborhoods-help"
                        disabled={captureLocked}
                        checked={Boolean(formData.scrape_filters?.expandNeighborhoods)}
                        onCheckedChange={v => setFormData({ ...formData, scrape_filters: { ...formData.scrape_filters, expandNeighborhoods: v } })}
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <Clock className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Reputação e tempo no Google Maps</h5>
                      <p className={styles.groupDesc}>Filtre estabelecimentos pela quantidade de avaliações, nota média e ano de atividade no Google. Use 0 para desativar cada campo.</p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="automation-min-reviews">Mínimo de avaliações no Google</label>
                    <Input id="automation-min-reviews" type="number" min={0} step={1} max={2147483647}
                      value={minReviews} onChange={e => { setMinReviews(e.target.value); setMinReviewsError(false); }}
                      aria-invalid={minReviewsError}
                      aria-describedby={`automation-min-reviews-help${minReviewsError ? " automation-min-reviews-error" : ""}`} />
                    <p id="automation-min-reviews-help" className={styles.fieldHint}>{MIN_REVIEWS_HELP}</p>
                    {minReviewsError && <p id="automation-min-reviews-error" role="alert" className="text-xs text-[#f0aab6]">{MIN_REVIEWS_ERROR}</p>}
                  </div>
                  <div className="space-y-2 pt-1">
                    <span className={styles.optionTitle}>Atalho de período no Google</span>
                    <div className={styles.segmentedPills} role="radiogroup" aria-label="Período rápido no Google">
                      {[
                        { label: "Qualquer ano", from: "0", to: "0" },
                        { label: "Desde 2019 até hoje", from: "2019", to: String(new Date().getFullYear()) },
                        { label: "Desde 2020 até hoje", from: "2020", to: String(new Date().getFullYear()) },
                        { label: "Desde 2022 até hoje", from: "2022", to: String(new Date().getFullYear()) },
                        { label: "Até 2019", from: "1900", to: "2019" },
                      ].map(preset => {
                        const active = googleYearFrom === preset.from && googleYearTo === preset.to;
                        return (
                          <span
                            key={preset.label}
                            role="radio"
                            aria-checked={active}
                            tabIndex={captureLocked ? -1 : 0}
                            onClick={() => {
                              if (captureLocked) return;
                              setGoogleYearFrom(preset.from);
                              setGoogleYearTo(preset.to);
                              setExtraFiltersError("");
                            }}
                            onKeyDown={e => {
                              if (captureLocked) return;
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setGoogleYearFrom(preset.from);
                                setGoogleYearTo(preset.to);
                                setExtraFiltersError("");
                              }
                            }}
                            className={styles.pillChoice}
                          >
                            {preset.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                    <div>
                      <label htmlFor="automation-google-year-from">No Google desde (ano)</label>
                      <Input
                        id="automation-google-year-from"
                        inputMode="numeric"
                        value={googleYearFrom}
                        onChange={e => { setGoogleYearFrom(e.target.value); setExtraFiltersError(""); }}
                        placeholder="Ex: 2019 (0 = todos)"
                      />
                    </div>
                    <div>
                      <label htmlFor="automation-google-year-to">Até o ano (0 = atual)</label>
                      <Input
                        id="automation-google-year-to"
                        inputMode="numeric"
                        value={googleYearTo}
                        onChange={e => { setGoogleYearTo(e.target.value); setExtraFiltersError(""); }}
                        placeholder={`Ex: ${new Date().getFullYear()}`}
                      />
                    </div>
                    <div>
                      <label htmlFor="automation-max-reviews">Máximo de avaliações</label>
                      <Input
                        id="automation-max-reviews"
                        inputMode="numeric"
                        value={maxReviews}
                        onChange={e => { setMaxReviews(e.target.value); setExtraFiltersError(""); }}
                      />
                    </div>
                    <div>
                      <label htmlFor="automation-min-rating">Nota mínima (0 a 5)</label>
                      <Input
                        id="automation-min-rating"
                        inputMode="decimal"
                        value={minRating}
                        onChange={e => { setMinRating(e.target.value); setExtraFiltersError(""); }}
                      />
                    </div>
                    <div>
                      <label htmlFor="automation-max-rating">Nota máxima (0 a 5)</label>
                      <Input
                        id="automation-max-rating"
                        inputMode="decimal"
                        value={maxRating}
                        onChange={e => { setMaxRating(e.target.value); setExtraFiltersError(""); }}
                      />
                    </div>
                  </div>
                  {extraFiltersError && <p role="alert" className="text-xs text-[#f0aab6]">{extraFiltersError}</p>}
                </div>

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <Globe className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Presença digital e saúde do site</h5>
                      <p className={styles.groupDesc}>Avalia se o link do Maps é um site real, plataforma terceira (iFood/Doctoralia), rede social ou site com falhas no celular.</p>
                    </div>
                  </div>
                  <div className={styles.optionList}>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-audit-site" className={styles.optionTitle}>Auditar saúde do site (quebrado, SSL vencido, erro 500 ou fraco)</label>
                        <p id="automation-audit-site-help" className={styles.optionDesc}>Gera nota técnica 0–100 e diagnóstico real do site sem custo externo e protegido contra falsos positivos.</p>
                      </div>
                      <Switch
                        id="automation-audit-site"
                        aria-describedby="automation-audit-site-help"
                        disabled={captureLocked}
                        checked={formData.scrape_filters?.auditSiteHealth !== false}
                        onCheckedChange={v => applyAutomationFilterSync({ type: "auditSiteHealth", value: v })}
                      />
                    </div>
                    <div className="py-2 space-y-2 border-t border-[#263028]">
                      <div>
                        <span className={styles.optionTitle}>Quais leads manter pelo estado do site?</span>
                        <p className={styles.optionDesc}>Modos que exigem análise técnica ativam a auditoria do site automaticamente.</p>
                      </div>
                      <div className={styles.segmentedPills} role="radiogroup" aria-label="Filtro por saúde do site na automação">
                        {SITE_FILTER_MODE_OPTIONS.map(opt => {
                          const curMode = (formData.scrape_filters?.siteFilterMode || (formData.scrape_filters?.filterWithWebsite ? "no_site" : "any")) as SiteFilterMode;
                          const active = curMode === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              disabled={captureLocked}
                              onClick={() => applyAutomationFilterSync({ type: "siteFilterMode", value: opt.value })}
                              className={styles.pillChoice}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-only-no-site" className={styles.optionTitle}>Capturar somente leads sem site</label>
                        <p id="automation-only-no-site-help" className={styles.optionDesc}>Atalho rápido para exigir apenas estabelecimentos sem website no Maps.</p>
                      </div>
                      <input
                        id="automation-only-no-site"
                        type="checkbox"
                        aria-describedby="automation-only-no-site-help"
                        checked={!!formData.scrape_filters?.filterWithWebsite}
                        onChange={e => applyAutomationFilterSync({ type: "filterWithWebsite", value: e.target.checked })}
                        className={styles.toggleInput}
                      />
                    </div>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-with-instagram" className={styles.optionTitle}>Somente com Instagram</label>
                        <p id="automation-with-instagram-help" className={styles.optionDesc}>{INSTAGRAM_FILTER_HELP}</p>
                      </div>
                      <input
                        id="automation-with-instagram"
                        type="checkbox"
                        checked={!!formData.scrape_filters?.filterWithInstagram}
                        onChange={e => setFormData({ ...formData, scrape_filters: { ...formData.scrape_filters, filterWithInstagram: e.target.checked } })}
                        aria-describedby="automation-with-instagram-help"
                        className={styles.toggleInput}
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <ShieldCheck className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Contato, CNPJ e sócio decisor</h5>
                      <p className={styles.groupDesc}>Higienize telefones inválidos e consulte gratuitamente a Receita Federal para enriquecer porte, CNPJ e contato do dono.</p>
                    </div>
                  </div>
                  <div className={styles.optionList}>
                    {[
                      { id: "automation-filter-empty", key: "filterEmpty", label: "Pular sem telefone", desc: "Descarta empresas sem nenhum número de telefone disponível." },
                      { id: "automation-filter-dups", key: "filterDuplicates", label: "Pular duplicados", desc: "Evita salvar ou abordar dois leads com o mesmo telefone." },
                      { id: "automation-filter-landlines", key: "filterLandlines", label: "Pular fixos", desc: "Remove telefones fixos comuns caso não possuam WhatsApp ativo." },
                    ].map(f => (
                      <div key={f.key} className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor={f.id} className={styles.optionTitle}>{f.label}</label>
                          <p id={`${f.id}-help`} className={styles.optionDesc}>{f.desc}</p>
                        </div>
                        <input
                          id={f.id}
                          type="checkbox"
                          aria-describedby={`${f.id}-help`}
                          checked={!!formData.scrape_filters?.[f.key]}
                          onChange={e => setFormData({ ...formData, scrape_filters: { ...formData.scrape_filters, [f.key]: e.target.checked } })}
                          className={styles.toggleInput}
                        />
                      </div>
                    ))}
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-validate-wa" className={styles.optionTitle}>Validar WhatsApp ativo na Evolution (recupera fixos Business)</label>
                        <p id="automation-validate-wa-help" className={styles.optionDesc}>Confirma na instância conectada se o número comercial ou do sócio recebe WhatsApp de verdade.</p>
                      </div>
                      <Switch
                        id="automation-validate-wa"
                        aria-describedby="automation-validate-wa-help"
                        disabled={captureLocked}
                        checked={formData.scrape_filters?.validateWhatsApp !== false}
                        onCheckedChange={v => applyAutomationFilterSync({ type: "validateWhatsApp", value: v })}
                      />
                    </div>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-filter-closed" className={styles.optionTitle}>Descartar empresas fechadas ou CNPJ baixado/inapto</label>
                        <p id="automation-filter-closed-help" className={styles.optionDesc}>Evita desperdício de disparos com empresas encerradas no Maps ou inativas na Receita Federal.</p>
                      </div>
                      <Switch
                        id="automation-filter-closed"
                        aria-describedby="automation-filter-closed-help"
                        disabled={captureLocked}
                        checked={formData.scrape_filters?.filterClosedBusinesses !== false}
                        onCheckedChange={v => setFormData({ ...formData, scrape_filters: { ...formData.scrape_filters, filterClosedBusinesses: v } })}
                      />
                    </div>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-exclude-franchises" className={styles.optionTitle}>Ignorar grandes redes e franquias</label>
                        <p id="automation-exclude-franchises-help" className={styles.optionDesc}>Descarta redes nacionais e S/A para concentrar os envios em decisores locais.</p>
                      </div>
                      <Switch
                        id="automation-exclude-franchises"
                        aria-describedby="automation-exclude-franchises-help"
                        disabled={captureLocked}
                        checked={Boolean(formData.scrape_filters?.excludeFranchises)}
                        onCheckedChange={v => setFormData({ ...formData, scrape_filters: { ...formData.scrape_filters, excludeFranchises: v } })}
                      />
                    </div>
                    <div className="py-2.5 border-t border-[#263028]">
                      <div className="flex items-start justify-between gap-4">
                        <div className={styles.optionCopy}>
                          <label htmlFor="automation-enrich-cnpj" className={styles.optionTitle}>Enriquecer CNPJ e Sócio Decisor grátis (Receita + RDAP)</label>
                          <p id="automation-enrich-cnpj-help" className={styles.optionDesc}>Preenche sócio-administrador, CNPJ, porte e idade da empresa sem custo de API.</p>
                        </div>
                        <Switch
                          id="automation-enrich-cnpj"
                          aria-describedby="automation-enrich-cnpj-help"
                          disabled={captureLocked}
                          checked={formData.scrape_filters?.enrichCnpj !== false}
                          onCheckedChange={v => applyAutomationFilterSync({ type: "enrichCnpj", value: v })}
                        />
                      </div>
                      {formData.scrape_filters?.enrichCnpj !== false && (
                        <div className={styles.nestedPanel}>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                            <div className="flex items-center justify-between gap-3">
                              <label htmlFor="automation-exclude-mei" className={styles.optionTitle}>Ignorar MEI (focar ME, EPP e Ltda)</label>
                              <input
                                id="automation-exclude-mei"
                                type="checkbox"
                                disabled={captureLocked}
                                checked={!!formData.scrape_filters?.excludeMei}
                                onChange={e => applyAutomationFilterSync({ type: "excludeMei", value: e.target.checked })}
                                className={styles.toggleInput}
                              />
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <label htmlFor="automation-min-capital" className={styles.optionTitle}>Capital mínimo (R$)</label>
                              <Input
                                id="automation-min-capital"
                                disabled={captureLocked}
                                type="number"
                                min={0}
                                step={1000}
                                value={minCapitalSocial}
                                onChange={e => applyAutomationFilterSync({ type: "minCapitalSocial", value: e.target.value })}
                                className="w-28"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-partner-phone" className={styles.optionTitle}>Priorizar WhatsApp oculto do site / celular do sócio</label>
                        <p id="automation-partner-phone-help" className={styles.optionDesc}>Substitui telefone genérico quando encontra um canal mais direto com o decisor.</p>
                      </div>
                      <Switch
                        id="automation-partner-phone"
                        aria-describedby="automation-partner-phone-help"
                        disabled={captureLocked}
                        checked={formData.scrape_filters?.prioritizePartnerPhone !== false}
                        onCheckedChange={v => applyAutomationFilterSync({ type: "prioritizePartnerPhone", value: v })}
                      />
                    </div>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-hunt-partner" className={styles.optionTitle}>Modo Direto no Dono (9º dígito Anatel + WhatsApp pessoal do sócio)</label>
                        <p id="automation-hunt-partner-help" className={styles.optionDesc}>Cruza Receita + web para separar WhatsApp Pessoal do sócio vs Recepção (ativa CNPJ e validação).</p>
                      </div>
                      <Switch
                        id="automation-hunt-partner"
                        aria-describedby="automation-hunt-partner-help"
                        disabled={captureLocked}
                        checked={Boolean(formData.scrape_filters?.huntPartnerDirectPhone)}
                        onCheckedChange={v => applyAutomationFilterSync({ type: "huntPartnerDirectPhone", value: v })}
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <Zap className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Velocidade, ordenação e avaliações com IA</h5>
                      <p className={styles.groupDesc}>Equilibre velocidade de extração, ordem de disparo por Score ICP e leitura profunda de comentários.</p>
                    </div>
                  </div>
                  <div className={styles.optionList}>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-turbo-mode" className={styles.optionTitle}>Modo Turbo VPS (alta velocidade e economia de RAM)</label>
                        <p id="automation-turbo-mode-help" className={styles.optionDesc}>Reutiliza aba, bloqueia mídia pesada e pula duplicados via cache em RAM.</p>
                      </div>
                      <Switch
                        id="automation-turbo-mode"
                        aria-describedby="automation-turbo-mode-help"
                        disabled={captureLocked}
                        checked={formData.scrape_filters?.turboMode !== false}
                        onCheckedChange={v => applyAutomationFilterSync({ type: "turboMode", value: v })}
                      />
                    </div>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-prioritize-score" className={styles.optionTitle}>Priorizar fila de disparo por Score ICP</label>
                        <p id="automation-prioritize-score-help" className={styles.optionDesc}>Dispara primeiro para leads mais aderentes ao objetivo (site ou IA + sócio direto).</p>
                      </div>
                      <Switch
                        id="automation-prioritize-score"
                        aria-describedby="automation-prioritize-score-help"
                        disabled={captureLocked}
                        checked={formData.scrape_filters?.prioritize_by_score !== false}
                        onCheckedChange={v => applyAutomationFilterSync({ type: "prioritizeByScore", value: v })}
                      />
                    </div>
                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-capture-all-reviews" className={styles.optionTitle}>Capturar todas as avaliações</label>
                        <p id="automation-capture-all-reviews-help" className={styles.optionDesc}>Salva os comentários disponíveis no Google Maps. Esta opção pode aumentar o tempo de captura.</p>
                      </div>
                      <input
                        id="automation-capture-all-reviews"
                        type="checkbox"
                        checked={!!formData.scrape_filters?.captureAllReviews}
                        onChange={e => applyAutomationFilterSync({ type: "captureAllReviews", value: e.target.checked })}
                        aria-describedby="automation-capture-all-reviews-help"
                        className={styles.toggleInput}
                      />
                    </div>
                    <div className="py-2.5 border-t border-[#263028]">
                      <div className="flex items-start justify-between gap-4">
                        <div className={styles.optionCopy}>
                          <label htmlFor="automation-reviews-ai" className={styles.optionTitle}>Resumir avaliações do Google com IA (antes do disparo)</label>
                          <p id="automation-reviews-ai-help" className={styles.optionDesc}>
                            Gera resumo com elogios, reclamações e gancho comercial em <code>{"{{resumo_avaliacoes}}"}</code>. Ativa a captura completa de avaliações.
                          </p>
                        </div>
                        <input
                          id="automation-reviews-ai"
                          type="checkbox"
                          aria-describedby="automation-reviews-ai-help"
                          checked={!!formData.scrape_filters?.reviews_ai?.enabled}
                          onChange={e => applyAutomationFilterSync({ type: "reviewsAiEnabled", value: e.target.checked })}
                          className={styles.toggleInput}
                        />
                      </div>
                      {formData.scrape_filters?.reviews_ai?.enabled && !captureLocked && !formData.dispatch_personalize && !(formData.dispatch_template || "").includes("resumo_avaliacoes") && (
                        <div className={`${styles.warningBanner} mt-3`}>
                          <span>Seu template ainda não usa {"{{resumo_avaliacoes}}"} nem reescrita IA.</span>
                          <button
                            type="button"
                            onClick={() => setFormData(prev => ({
                              ...prev,
                              dispatch_template: `${(prev.dispatch_template || "").trim()} {{resumo_avaliacoes}}`.trim(),
                            }))}
                            className={styles.inlineActionBtn}
                          >
                            Inserir na mensagem
                          </button>
                        </div>
                      )}
                      {formData.scrape_filters?.reviews_ai?.enabled && (
                        <div className={styles.nestedPanel}>
                          <div>
                            <label htmlFor="automation-reviews-model">Modelo de IA das avaliações</label>
                            <select id="automation-reviews-model"
                              value={formData.scrape_filters?.reviews_ai?.model || ""}
                              onChange={e => setFormData({
                                ...formData,
                                scrape_filters: { ...formData.scrape_filters, reviews_ai: { ...formData.scrape_filters!.reviews_ai!, model: e.target.value } },
                              })}
                              className="w-full mt-0.5 rounded-md px-2"
                            >
                              {formData.scrape_filters?.reviews_ai?.model && !aiModels.some(m => m.id === formData.scrape_filters?.reviews_ai?.model) && (
                                <option value={formData.scrape_filters.reviews_ai.model} className="bg-neutral-900">{formData.scrape_filters.reviews_ai.model} (salvo)</option>
                              )}
                              {!formData.scrape_filters?.reviews_ai?.model && aiModels.length > 0 && <option value="" className="bg-neutral-900">(modelo não definido)</option>}
                              {aiModels.length === 0 && <option value="" className="bg-neutral-900">{loadingAiModels ? "carregando…" : "(sem modelos — configure API key)"}</option>}
                              <ModelOptions models={aiModels as any} />
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
                              placeholder="Ex: Resuma em tom comercial, focando dores que um site profissional resolveria…" />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </fieldset>

              {/* Lead Intelligence — entre captação e disparo. */}
              <div className={styles.formSection}>
                <div className={styles.filterGroup}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Bot className="w-4 h-4 text-[#9ce9bc] shrink-0 mt-0.5" />
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className={styles.groupTitle}>Lead Intelligence</h4>
                          <span className={styles.optional}>Opcional</span>
                        </div>
                        <p className={styles.groupDesc}>
                          Após captar os leads, a IA analisa site e busca web de cada empresa e injeta o briefing automaticamente no disparo inicial, follow-ups e agente IA (cache 30 dias).
                        </p>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      aria-label="Ativar Lead Intelligence"
                      className={styles.toggleInput}
                      checked={!!formData.lead_intelligence_enabled}
                      onChange={e => setFormData({ ...formData, lead_intelligence_enabled: e.target.checked })}
                    />
                  </div>
                  {formData.lead_intelligence_enabled && (
                    <div className="space-y-2 pt-1">
                      <p className={styles.optionDesc}>
                        Custo estimado de ~1k tokens por lead (~R$ 0,002 com 2.5-flash). Modelo configurável em <strong>Configurações</strong>.
                      </p>
                      {!formData.dispatch_personalize && !formData.followup_ai_enabled && !formData.agent_id && (
                        <div className={styles.warningBanner}>
                          <span>Nenhum consumidor IA ativo (Disparo IA, Follow-up IA ou Agente IA) para usar este briefing.</span>
                          <button
                            type="button"
                            onClick={() => applyAutomationFilterSync({ type: "personalizeWithAi", value: true })}
                            className={styles.inlineActionBtn}
                          >
                            Ativar reescrita IA no disparo
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              </section>

              <section id="automation-step-2" tabIndex={-1} hidden={formStep !== 2} className={styles.stepPanel} aria-label="Mensagem inicial">
              <div className={styles.formSection}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className={styles.sectionTitle}><Zap className="w-4 h-4" /> Disparo inicial</h4>
                  <p className={styles.fieldHint}>Escreva a mensagem-base, personalize com IA e defina o ritmo de envio.</p>
                </div>

                {filterSyncNote && (
                  <div role="status" className={styles.syncBanner}>
                    <span className={styles.syncBannerText}>
                      <Info className="w-4 h-4" />
                      <span>{filterSyncNote}</span>
                    </span>
                    <button type="button" onClick={() => setFilterSyncNote(null)} className={styles.syncClose}>Fechar</button>
                  </div>
                )}

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <MessageSquareText className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Mensagem-base e variáveis dinâmicas</h5>
                      <p className={styles.groupDesc}>Clique em qualquer variável ou arraste para o texto para personalizar automaticamente por empresa.</p>
                    </div>
                  </div>

                  <div className={styles.varCategoryBox}>
                    {[
                      {
                        title: "Empresa e contato",
                        vars: [
                          { key: "saudacao", label: "Saudação", hint: "Bom dia / Boa tarde / Boa noite" },
                          { key: "nome", label: "Nome", hint: "Push name do WhatsApp (fallback empresa)" },
                          { key: "nome_empresa", label: "Empresa", hint: "leads_extraidos.nome_negocio" },
                          { key: "empresa_curta", label: "Empresa Curta", hint: "Nome limpo sem LTDA/EPP/cidade" },
                          { key: "primeiro_nome", label: "1ª palavra", hint: "Primeira palavra do nome empresa" },
                          { key: "ramo", label: "Ramo", hint: "leads_extraidos.ramo_negocio" },
                          { key: "categoria", label: "Categoria", hint: "Categoria Google Maps" },
                          { key: "servico_principal", label: "Serviço Principal", hint: "Especialidade principal sem ruído" },
                          { key: "endereco", label: "Endereço", hint: "Endereço completo" },
                          { key: "website", label: "Website", hint: "Site do lead" },
                          { key: "telefone", label: "Telefone", hint: "Número limpo" },
                        ],
                      },
                      {
                        title: "Sócio decisor, CNPJ e diagnóstico",
                        vars: [
                          { key: "primeiro_nome_socio", label: "1º Nome Sócio", hint: "Primeiro nome do sócio-administrador" },
                          { key: "nome_socio", label: "Sócio Decisor", hint: "Nome completo do sócio-administrador (Receita)" },
                          { key: "canal_whatsapp", label: "Canal WhatsApp", hint: "WhatsApp direto do sócio ou Recepção" },
                          { key: "abertura_inteligente", label: "Abertura Inteligente", hint: "Abordagem adaptada para Sócio Direto vs Recepção" },
                          { key: "diagnostico_site", label: "Diagnóstico Site", hint: "Diagnóstico técnico do site" },
                          { key: "cnpj", label: "CNPJ", hint: "CNPJ da empresa" },
                          { key: "porte_receita", label: "Porte Receita", hint: "MEI / ME / EPP / Ltda" },
                          { key: "anos_empresa", label: "Anos CNPJ", hint: "Idade da empresa em anos" },
                        ],
                      },
                      {
                        title: "Avaliações e data",
                        vars: [
                          { key: "avaliacao", label: "Avaliação", hint: "Nota Google (1-5)" },
                          { key: "reviews", label: "Reviews", hint: "Qtd. de reviews" },
                          { key: "resumo_avaliacoes", label: "Resumo aval.", hint: "Resumo IA das avaliações (reviews-ai)" },
                          { key: "data", label: "Data", hint: "DD/MM/AAAA" },
                          { key: "hora", label: "Hora", hint: "HH:MM" },
                        ],
                      },
                    ].map(cat => (
                      <div key={cat.title} className={styles.varCategoryRow}>
                        <span className={styles.varCategoryTitle}>{cat.title}</span>
                        <div className="flex flex-wrap gap-1.5">
                          {cat.vars.map(v => (
                            <button
                              key={v.key} type="button" title={v.hint}
                              draggable
                              onDragStart={e => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)}
                              onClick={() => setFormData({ ...formData, dispatch_template: (formData.dispatch_template || "") + `{{${v.key}}}` })}
                              className={styles.varChip}
                            >
                              <span>{v.label}</span>
                              <code>{`{{${v.key}}}`}</code>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <label htmlFor="automation-message">Mensagem-base (template)</label>
                    <Textarea id="automation-message" rows={4}
                      value={formData.dispatch_template || ""}
                      onChange={e => setFormData({ ...formData, dispatch_template: e.target.value })}
                      placeholder="Ex: {{saudacao}} {{nome_empresa}}! Vi vocês no Maps…" />
                  </div>
                </div>

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <Clock className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Ritmo de envio e presença &quot;digitando...&quot;</h5>
                      <p className={styles.groupDesc}>Controla a cadência entre contatos e o indicador humano de digitação no WhatsApp (Evolution API).</p>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 items-start sm:items-center">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                      <span className={styles.optionTitle}>Intervalo aleatório entre envios (segundos):</span>
                      <div className="flex items-center gap-2">
                        <NumberInput aria-label="Intervalo mínimo entre envios (segundos)" min={5} fallback={60} value={formData.dispatch_min_interval}
                          onChange={n => setFormData({ ...formData, dispatch_min_interval: n })}
                          className="w-20" />
                        <span className={styles.optionDesc}>até</span>
                        <NumberInput aria-label="Intervalo máximo entre envios (segundos)" min={5} fallback={180} value={formData.dispatch_max_interval}
                          onChange={n => setFormData({ ...formData, dispatch_max_interval: n })}
                          className="w-20" />
                      </div>
                    </div>
                    <p className="text-xs text-[#f4d68e] flex items-center gap-1.5">
                      <ShieldCheck aria-hidden="true" className="w-4 h-4 shrink-0" />
                      <span>Recomendado: <strong>60–180s</strong> para proteger o chip.</span>
                    </p>
                  </div>

                  <div className="pt-2 border-t border-[#263028] space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className={styles.optionTitle}>Presença &quot;Digitando...&quot; antes de enviar</span>
                      <span className={styles.noteBadge}>
                        {typingDelayMode === "fixed" ? `Fixo: ${typingDelaySeconds}s digitando` : `Aleatório: ${typingDelayMinSeconds}s a ${typingDelayMaxSeconds}s`}
                      </span>
                    </div>
                    <div className={styles.segmentedPills}>
                      <button
                        type="button"
                        data-active={typingDelayMode === "fixed" ? "true" : undefined}
                        onClick={() => setTypingDelayMode("fixed")}
                        className={styles.pillChoice}
                      >
                        Modo Fixo
                      </button>
                      <button
                        type="button"
                        data-active={typingDelayMode === "random" ? "true" : undefined}
                        onClick={() => setTypingDelayMode("random")}
                        className={styles.pillChoice}
                      >
                        Modo Aleatório (Faixa Min–Máx)
                      </button>
                    </div>

                    {typingDelayMode === "fixed" ? (
                      <div className="space-y-1.5 max-w-md">
                        <div className="flex items-center justify-between text-xs">
                          <span className={styles.optionDesc}>Tempo digitando por mensagem:</span>
                          <span className={styles.noteBadge}>{typingDelaySeconds}s</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <input
                            type="range"
                            min={1}
                            max={60}
                            value={typingDelaySeconds}
                            onChange={(e) => setTypingDelaySeconds(Number(e.target.value))}
                          />
                          <NumberInput
                            min={1}
                            fallback={10}
                            value={typingDelaySeconds}
                            onChange={(v) => setTypingDelaySeconds(Math.max(1, Math.min(v, 120)))}
                            className="w-20"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className={styles.optionDesc}>Mínimo digitando:</span>
                            <span className={styles.noteBadge}>{typingDelayMinSeconds}s</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="range"
                              min={1}
                              max={60}
                              value={typingDelayMinSeconds}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setTypingDelayMinSeconds(val);
                                if (val > typingDelayMaxSeconds) setTypingDelayMaxSeconds(val);
                              }}
                            />
                            <NumberInput
                              min={1}
                              fallback={5}
                              value={typingDelayMinSeconds}
                              onChange={(v) => {
                                const val = Math.max(1, Math.min(v, 120));
                                setTypingDelayMinSeconds(val);
                                if (val > typingDelayMaxSeconds) setTypingDelayMaxSeconds(val);
                              }}
                              className="w-20"
                            />
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className={styles.optionDesc}>Máximo digitando:</span>
                            <span className={styles.noteBadge}>{typingDelayMaxSeconds}s</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="range"
                              min={1}
                              max={60}
                              value={typingDelayMaxSeconds}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setTypingDelayMaxSeconds(val);
                                if (val < typingDelayMinSeconds) setTypingDelayMinSeconds(val);
                              }}
                            />
                            <NumberInput
                              min={1}
                              fallback={25}
                              value={typingDelayMaxSeconds}
                              onChange={(v) => {
                                const val = Math.max(1, Math.min(v, 120));
                                setTypingDelayMaxSeconds(val);
                                if (val < typingDelayMinSeconds) setTypingDelayMinSeconds(val);
                              }}
                              className="w-20"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <Bot className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Personalização e proteção anti-banimento</h5>
                      <p className={styles.groupDesc}>Varie o texto automaticamente entre envios para evitar padrão robótico repetitivo.</p>
                    </div>
                  </div>
                  <div className={styles.optionList}>
                    <div className="py-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className={styles.optionCopy}>
                          <label htmlFor="automation-dispatch-personalize" className={styles.optionTitle}>Reescrever cada mensagem com IA antes de enviar</label>
                          <p id="automation-dispatch-personalize-help" className={styles.optionDesc}>Gera uma variação natural e única por empresa usando o template e os dados captados.</p>
                        </div>
                        <input
                          id="automation-dispatch-personalize"
                          type="checkbox"
                          aria-describedby="automation-dispatch-personalize-help"
                          checked={!!formData.dispatch_personalize}
                          onChange={e => applyAutomationFilterSync({ type: "personalizeWithAi", value: e.target.checked })}
                          className={styles.toggleInput}
                        />
                      </div>
                      {formData.dispatch_personalize && (
                        <div className={styles.nestedPanel}>
                          <div>
                            <div className={styles.labelRow}>
                              <label htmlFor="automation-dispatch-model">Modelo de IA do disparo</label>
                              {loadingAiModels && <Loader2 className="w-3 h-3 animate-spin" />}
                              <button type="button" onClick={loadAiModels} className={styles.reloadAction}>Recarregar modelos</button>
                            </div>
                            <select id="automation-dispatch-model" value={isAdmin ? (formData.dispatch_ai_model || aiModels[0]?.id || "") : (defaultAiModel || "")}
                              onChange={e => setFormData({ ...formData, dispatch_ai_model: e.target.value })}
                              disabled={!isAdmin || aiModels.length === 0}
                              className="w-full mt-0.5 rounded-md px-2 disabled:opacity-50">
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
                              <p className="text-xs text-[#9ce9bc] mt-1.5 flex items-center gap-1.5">
                                <LockKeyhole aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
                                <span>Modelo definido pelo administrador: <strong>{defaultAiModel || "Não configurado"}</strong></span>
                              </p>
                            )}
                            {aiModelsError && isAdmin && (
                              <p className="text-xs text-[#f4d68e] mt-1">{aiModelsError} — configure uma chave de IA em Configurações.</p>
                            )}
                          </div>
                          <div>
                            <label htmlFor="automation-dispatch-prompt">Prompt para a IA (instruções de como reescrever)</label>
                            <Textarea id="automation-dispatch-prompt" rows={4}
                              value={formData.dispatch_ai_prompt || ""}
                              onChange={e => setFormData({ ...formData, dispatch_ai_prompt: e.target.value })}
                              placeholder="Ex: Reescreva a mensagem-base de forma natural e única para cada cliente, mantendo o tom amigável e profissional. Não use emojis exagerados. Adapte ao ramo do negócio se for relevante. Mensagem deve ter no máximo 3 frases." />
                            <p className={styles.editorFieldHint}>A IA recebe este prompt + mensagem-base + dados do lead para gerar a mensagem final.</p>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-humanize" className={styles.optionTitle}>Humanizar disparo (picotar mensagens)</label>
                        <p id="automation-humanize-help" className={styles.optionDesc}>Divide o texto em mensagens curtas com pausa natural entre elas (2–5s), igual ao atendimento humano.</p>
                      </div>
                      <input
                        id="automation-humanize"
                        type="checkbox"
                        aria-describedby="automation-humanize-help"
                        checked={!!formData.dispatch_humanize}
                        onChange={e => setFormData({ ...formData, dispatch_humanize: e.target.checked })}
                        className={styles.toggleInput}
                      />
                    </div>

                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-antiban-mixer" className={styles.optionTitle}>Misturador Anti-Ban (Variação de Abordagem)</label>
                        <p id="automation-antiban-mixer-help" className={styles.optionDesc}>Alterna variações naturais de saudação sem IA paga. Desativa automaticamente se a reescrita IA estiver ligada.</p>
                      </div>
                      <input
                        id="automation-antiban-mixer"
                        type="checkbox"
                        aria-label="Misturador Anti-Ban"
                        aria-describedby="automation-antiban-mixer-help"
                        checked={formData.scrape_filters?.antiban_mixer !== false}
                        onChange={e => applyAutomationFilterSync({ type: "antibanMixer", value: e.target.checked })}
                        className={styles.toggleInput}
                      />
                    </div>

                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="automation-cold-shield" className={styles.optionTitle}>Proteção Anti-Ban (cotas do chip e descanso de 15 min)</label>
                        <p id="automation-cold-shield-help" className={styles.optionDesc}>Ligada: respeita o teto por hora/dia do chip e pausa 15 min quando o teto é atingido. Desligada: esta automação ignora cotas, berçário, quarentena e pausas automáticas — dispara no ritmo configurado. Aumenta o risco de bloqueio do número.</p>
                      </div>
                      <input
                        id="automation-cold-shield"
                        type="checkbox"
                        aria-label="Proteção Anti-Ban"
                        aria-describedby="automation-cold-shield-help"
                        checked={formData.scrape_filters?.cold_shield !== false}
                        onChange={e => setFormData({
                          ...formData,
                          scrape_filters: { ...(formData.scrape_filters || {}), cold_shield: e.target.checked },
                        })}
                        className={styles.toggleInput}
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <Paperclip className="w-4 h-4" />
                    <div>
                      <h5 className={styles.groupTitle}>Anexar mídia (opcional)</h5>
                      <p className={styles.groupDesc}>Envia imagem (16 MB), vídeo (64 MB), áudio (16 MB) ou documento (100 MB) logo após o texto.</p>
                    </div>
                  </div>
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
                    <Input
                      type="text"
                      aria-label="Legenda da mídia (opcional)"
                      placeholder="Legenda da mídia (opcional)"
                      value={formData.dispatch_media_caption ?? ""}
                      onChange={e => setFormData({ ...formData, dispatch_media_caption: e.target.value })}
                    />
                  )}
                </div>
              </div>

              </section>

              <section id="automation-step-3" tabIndex={-1} hidden={formStep !== 3} className={styles.stepPanel} aria-label="Follow-up">
              <div className={styles.formSection}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className={styles.sectionTitle}><Repeat className="w-4 h-4" /> Follow-up automático</h4>
                  <p className={styles.fieldHint}>Mensagens de acompanhamento enviadas só se o lead ainda não tiver respondido.</p>
                </div>

                <div className={styles.filterGroup}>
                  <div className={styles.optionRow}>
                    <div className={styles.optionCopy}>
                      <span className={styles.optionTitle}>Ativar follow-up automático</span>
                      <p className={styles.optionDesc}>Quando desativado, a automação encerra logo após o disparo inicial sem apagar os passos configurados.</p>
                    </div>
                    <input
                      type="checkbox"
                      aria-label="Ativar follow-up automático"
                      className={styles.toggleInput}
                      checked={formData.followup_enabled !== false}
                      onChange={e => setFormData({ ...formData, followup_enabled: e.target.checked })}
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  {(formData.followup_steps || []).map((step, idx) => (
                    <div key={idx} className={styles.followupCard}>
                      <div className={styles.followupCardHead}>
                        <span className={styles.followupBadge}>{idx + 1}º retorno</span>
                        <Button onClick={() => setFormData({
                          ...formData,
                          followup_steps: (formData.followup_steps || []).filter((_, i) => i !== idx),
                        })} aria-label={`Remover follow-up ${idx + 1}`} variant="ghost" size="icon" className={cn(styles.iconAction, styles.dangerAction)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-start">
                        <div className="flex flex-col gap-1 shrink-0 w-full sm:w-28">
                          <label htmlFor={`followup-day-${idx}`}>Após (dias)</label>
                          <NumberInput id={`followup-day-${idx}`} min={1} fallback={1} value={step.day_offset}
                            onChange={n => {
                              const next = [...(formData.followup_steps || [])];
                              next[idx] = { ...next[idx], day_offset: n };
                              setFormData({ ...formData, followup_steps: next });
                            }}
                            className="w-full" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <label htmlFor={`followup-message-${idx}`}>Mensagem do follow-up {idx + 1}</label>
                          <Textarea id={`followup-message-${idx}`} rows={2} value={step.template}
                            onChange={e => {
                              const next = [...(formData.followup_steps || [])];
                              next[idx] = { ...next[idx], template: e.target.value };
                              setFormData({ ...formData, followup_steps: next });
                            }} />
                        </div>
                      </div>
                    </div>
                  ))}
                  <Button onClick={() => setFormData({
                    ...formData,
                    followup_steps: [...(formData.followup_steps || []), { day_offset: 3, template: "" }],
                  })} variant="outline" className={styles.secondaryAction}>
                    <Plus className="w-4 h-4" /> Adicionar etapa
                  </Button>
                </div>

                <div className={styles.filterGroup}>
                  <div className="flex items-start justify-between gap-4">
                    <div className={styles.optionCopy}>
                      <label htmlFor="automation-followup-ai-toggle" className={styles.optionTitle}>Reescrever cada follow-up com IA</label>
                      <p id="automation-followup-ai-help" className={styles.optionDesc}>Adapta cada retorno ao histórico recente do lead para evitar mensagens mecânicas ou repetidas.</p>
                    </div>
                    <input
                      id="automation-followup-ai-toggle"
                      type="checkbox"
                      aria-describedby="automation-followup-ai-help"
                      checked={!!formData.followup_ai_enabled}
                      onChange={e => setFormData({ ...formData, followup_ai_enabled: e.target.checked })}
                      className={styles.toggleInput}
                    />
                  </div>
                  {formData.followup_ai_enabled && (
                    <div className={styles.nestedPanel}>
                      <div>
                        <div className={styles.labelRow}>
                          <label htmlFor="automation-followup-model">Modelo de IA do follow-up</label>
                          {loadingAiModels && <Loader2 className="w-3 h-3 animate-spin" />}
                          <button type="button" onClick={loadAiModels} className={styles.reloadAction}>Recarregar modelos</button>
                        </div>
                        <select id="automation-followup-model" value={isAdmin ? (formData.followup_ai_model || aiModels[0]?.id || "") : (defaultAiModel || "")}
                          onChange={e => setFormData({ ...formData, followup_ai_model: e.target.value })}
                          disabled={!isAdmin || aiModels.length === 0}
                          className="w-full mt-0.5 rounded-md px-2 disabled:opacity-50">
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
                          <p className="text-xs text-[#9ce9bc] mt-1.5 flex items-center gap-1.5">
                            <LockKeyhole aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
                            <span>Modelo definido pelo administrador: <strong>{defaultAiModel || "Não configurado"}</strong></span>
                          </p>
                        )}
                        {aiModelsError && isAdmin && (
                          <p className="text-xs text-[#f4d68e] mt-1">{aiModelsError} — configure uma chave de IA em Configurações.</p>
                        )}
                      </div>
                      <div>
                        <label htmlFor="automation-followup-prompt">Prompt para a IA do follow-up</label>
                        <Textarea id="automation-followup-prompt" rows={4}
                          value={formData.followup_ai_prompt || ""}
                          onChange={e => setFormData({ ...formData, followup_ai_prompt: e.target.value })}
                          placeholder="Ex: Você é um SDR cordial fazendo follow-up sem ser insistente. Use o histórico pra puxar gancho do que o cliente já mencionou. Tom natural, máximo 3 frases." />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              </section>

              <section id="automation-step-4" tabIndex={-1} hidden={formStep !== 4} className={styles.stepPanel} aria-label="Horários e revisão">
              <div className={styles.formSection}>
                <div className={styles.filterGroup}>
                  <div className={styles.groupHeader}>
                    <Clock className="w-4 h-4" />
                    <div>
                      <h4 className={styles.groupTitle}>Horário permitido de envio</h4>
                      <p className={styles.groupDesc}>Aplicado tanto ao disparo inicial quanto ao follow-up, no fuso local do servidor.</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <NumberInput aria-label="Horário inicial" min={0} max={23} fallback={9} value={formData.allowed_start_hour}
                      onChange={n => setFormData({ ...formData, allowed_start_hour: n })}
                      className="w-20" />
                    <span className={styles.optionDesc}>até</span>
                    <NumberInput aria-label="Horário final" min={0} max={23} fallback={20} value={formData.allowed_end_hour}
                      onChange={n => setFormData({ ...formData, allowed_end_hour: n })}
                      className="w-20" />
                    <span className={styles.optionDesc}>horas (0–23)</span>
                  </div>
                </div>
              </div>

              <div className={styles.review}>
                <h4>Revise antes de iniciar</h4>
                <dl>
                  <div><dt>Automação</dt><dd>{formData.name || "Nome não preenchido"}</dd></div>
                  <div><dt>WhatsApp</dt><dd>{formData.instance_name ? formatInstanceLabel(formData.instance_name) : "Selecione uma instância"}</dd></div>
                  <div><dt>Público</dt><dd>{nichesText.split("\n").filter(s => s.trim()).length} nicho(s) · {regionsText.split("\n").filter(s => s.trim()).length} região(ões) · até {formData.scrape_max_leads} leads</dd></div>
                  <div><dt>Qualificação</dt><dd>{SITE_FILTER_MODE_OPTIONS.find(o => o.value === (formData.scrape_filters?.siteFilterMode || (formData.scrape_filters?.filterWithWebsite ? "no_site" : "any")))?.label || "Todos"} · {formData.scrape_filters?.enrichCnpj !== false ? "CNPJ/Sócio ativo" : "Sem CNPJ"} · {formData.lead_intelligence_enabled ? "Com Lead Intelligence" : "Sem briefing IA"}</dd></div>
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
                          <span>{formatInstanceLabel(a.instance_name)} · agente {a.agent_id ?? "—"} · <b>{a.scraped_count || 0}</b> {a.scraped_count === 1 ? "lead captado" : "leads captados"}</span>
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
                      <div className={styles.errorBanner}>
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#f0aab6]" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-xs text-[#f5bcc6] mb-1">Último erro</p>
                          <p className="break-words whitespace-pre-wrap leading-relaxed">{a.last_error}</p>
                        </div>
                      </div>
                    )}

                    {isOpen && (
                      <div id={`automation-details-${a.id}`} className={styles.automationDetails}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                          <Stat icon={MapPin}  label="Nichos"     value={(a.niches || []).join(", ") || "—"} color="text-[#a5b1a8]" />
                          <Stat icon={MapPin}  label="Regiões"    value={(a.regions || []).join(", ") || "—"} color="text-[#a5b1a8]" />
                          <Stat icon={Clock}   label="Horário"    value={`${String(a.allowed_start_hour).padStart(2,"0")}h–${String(a.allowed_end_hour).padStart(2,"0")}h`} color="text-[#a5b1a8]" />
                          <Stat icon={Zap}     label="Disparo"    value={`${a.dispatch_min_interval}–${a.dispatch_max_interval}s${a.dispatch_personalize ? " · IA on" : ""}`} color="text-[#9ce9bc]" />
                          <Stat icon={Clock}   label="Digitando"  value={(a.scrape_filters?.typing_delay_mode || a.scrape_filters?.typing_delay?.mode) === "fixed" ? `${a.scrape_filters?.typing_delay_seconds || a.scrape_filters?.typing_delay?.seconds || 10}s (fixo)` : `${a.scrape_filters?.typing_delay_min_seconds || a.scrape_filters?.typing_delay?.min_seconds || 5}–${a.scrape_filters?.typing_delay_max_seconds || a.scrape_filters?.typing_delay?.max_seconds || 25}s (aleat.)`} color="text-[#a5b1a8]" />
                          <Stat icon={Repeat}  label="Follow-up"  value={`${(a.followup_steps || []).length} step(s)${a.followup_ai_enabled ? " · IA on" : ""}`} color="text-[#a5b1a8]" />
                          <Stat icon={a.campaign_id ? CheckCircle2 : XCircle} label="Campanha disparo" value={a.campaign_id ? a.campaign_id.slice(0,8) : "—"} color={a.campaign_id ? "text-[#9ce9bc]" : "text-zinc-500"} />
                          <Stat icon={a.followup_campaign_id ? CheckCircle2 : XCircle} label="Campanha follow-up" value={a.followup_campaign_id ? a.followup_campaign_id.slice(0,8) : "—"} color={a.followup_campaign_id ? "text-[#9ce9bc]" : "text-zinc-500"} />
                          <Stat icon={Clock}   label="Iniciada"   value={a.started_at ? new Date(a.started_at).toLocaleString("pt-BR") : "—"} color="text-[#a5b1a8]" />
                          <Stat icon={Clock}   label="Concluída"  value={a.finished_at ? new Date(a.finished_at).toLocaleString("pt-BR") : "—"} color="text-[#a5b1a8]" />
                        </div>

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
    const qs = new URLSearchParams({
      scrape_count: "1",
      started_at: startedAt,
      limit: String(scrapedCount + 50),
    });
    fetch(`/api/automations/${encodeURIComponent(automationId)}/logs?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.ok && Array.isArray(d.leadIds)) {
          setLeadIds(d.leadIds);
        }
      })
      .catch(() => {});
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
