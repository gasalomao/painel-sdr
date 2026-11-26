"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { NumberInput } from "@/components/ui/number-input";
import { ModelOptions } from "@/components/ai-module-shared";
import {
  Send, Play, Pause, Square, Loader2, Search, Globe, BarChart3,
  CheckCircle2, XCircle, Star, Ban, RefreshCw,
  Rocket, Terminal, Filter, TrendingUp, Building2, Link2, Link2Off, Trash2, MapPin, ExternalLink,
  Clock, MessageSquare, ChevronRight, Bot, Smartphone, Zap, Repeat, Plus, Sparkles, Info,
  ShieldCheck, Workflow,
} from "lucide-react";
import { renderTemplate, type TemplateContext } from "@/lib/template-vars";
import {
  AUTO_POOL_INSTANCE,
  formatInstanceLabel,
  type WeekendB2BGuardMode,
} from "@/lib/campaign-pool";
import {
  MENTOR_2STEP_TEMPLATE,
  MENTOR_VIDEO_PRAISE_TEMPLATE,
} from "@/lib/mentor-presets";
import { supabase } from "@/lib/supabase";
import { mergeRealtimeLog } from "@/lib/realtime-logs";
import { useClientSession } from "@/lib/use-session";
import { cn } from "@/lib/utils";
import { parseMinReviews } from "@/lib/scraper-review-count";
import {
  applyScraperFilterChange,
  isNonWebsiteUrl,
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
import type { LeadEnrichmentData, SiteFilterMode } from "@/lib/scraper-lead-enrichment";
import { AutomationLogs } from "../automacao/AutomationLogs";
import { MentorPreviewQueuePanel } from "@/components/mentor-preview-queue-panel";
import styles from "./prospeccao-sites.module.css";

type Lead = {
  id: number;
  remoteJid: string;
  nome_negocio: string | null;
  telefone: string | null;
  ramo_negocio: string | null;
  endereco: string | null;
  rating: string | null;
  reviews: string | null;
  website: string | null;
  maps_url: string | null;
  place_id: string | null;
  year_established?: string | null;
  owner_name?: string | null;
  enrichment?: LeadEnrichmentData | null;
  created_at: string;
  opt_out: boolean;
  primeiro_contato_source: string | null;
  primeiro_contato_at: string | null;
  resumo_avaliacoes?: string | null;
  previa_status?: string | null;
  link_previa?: string | null;
  previa_qa_score?: number | null;
  previa_error?: string | null;
  reuniao_horario_confirmado?: string | null;
  reuniao_resumo?: string | null;
  previa_pronta_em?: string | null;
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
  skipped_count?: number;
  min_interval_seconds: number;
  max_interval_seconds: number;
  allowed_start_hour: number;
  allowed_end_hour: number;
  personalize_with_ai?: boolean;
  humanize_messages?: boolean;
  ai_prompt?: string | null;
  ai_model?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
  updated_at?: string;
};

type LogEntry = { message: string; type: string; time: string };

const TABS = [
  { key: "captura",   label: "Captura",   icon: Rocket },
  { key: "leads",     label: "Leads",     icon: Search },
  { key: "revisao",   label: "Revisão",   icon: CheckCircle2 },
  { key: "disparo",   label: "Disparo",   icon: Send },
  { key: "historico", label: "Histórico", icon: BarChart3 },
  { key: "automacao", label: "Automação", icon: Zap },
  { key: "mentor",    label: "Mentor & X1", icon: Sparkles },
] as const;
type TabKey = typeof TABS[number]["key"];

const TAB_CONTEXT: Record<TabKey, { title: string; description: string }> = {
  captura: { title: "Encontre sua próxima oportunidade", description: "Defina os negócios e as regiões. Depois, selecione as empresas e prepare sua abordagem." },
  leads: { title: "Escolha quem você quer abordar", description: "Filtre as empresas capturadas e selecione os leads para revisar a mensagem antes do envio." },
  revisao: { title: "Uma abordagem com contexto", description: "Ajuste a mensagem-base e confira como ela ficará para cada empresa selecionada." },
  disparo: { title: "Prepare sua campanha", description: "Escolha o WhatsApp, os intervalos e o horário de envio. A campanha será criada antes de iniciar." },
  historico: { title: "Acompanhe suas campanhas", description: "Consulte o progresso, as mensagens e os registros de execução em um só lugar." },
  automacao: { title: "Organize a prospecção automática", description: "Configure a captura, a primeira mensagem e os retornos. Você controla quando a automação começa." },
  mentor: { title: "Método Mentor & Fila X1", description: "Acompanhe as 4 taxas do funil e agende entregas naturais de prévias mantendo a IA pausada para fechamento manual." },
};

const DEFAULT_TEMPLATE = `{{saudacao}}! Tudo bem? {{nome_empresa}}?`;

const VENDEDOR_DEFAULT = "Salomão";
const MIN_REVIEWS_HELP = "Quantidade de pessoas que deram estrelas, com ou sem comentário. Não filtra pela nota. 0 = sem mínimo.";
const MIN_REVIEWS_ERROR = "Informe um inteiro entre 0 e 2147483647.";
const INSTAGRAM_FILTER_HELP = "Exige perfil informado no Google Maps; não busca no site.";

const HAS_WEBSITE_LABELS: Record<string, string> = {
  only_empty: "Sem site",
  broken_or_empty: "Sem site + Quebrado",
  broken_or_weak: "Site quebrado / fraco",
  all: "Todos os sites",
  only_with: "Com site",
};

const SORT_LABELS: Record<string, string> = {
  reviews: "Avaliações",
  rating: "Nota",
  qualification: "Score qualificação",
  created_at: "Data captura",
};

const SITE_FILTER_MODE_OPTIONS: { value: SiteFilterMode; label: string }[] = [
  { value: "any", label: "Todos" },
  { value: "no_site", label: "Sem site" },
  { value: "broken_or_no_site", label: "Sem site + Quebrado" },
  { value: "only_broken_or_weak", label: "Só Site Quebrado/Fraco" },
  { value: "only_active_site", label: "Só Site Ativo" },
];

const ORDER_LABELS: Record<string, string> = {
  desc: "Maior → menor",
  asc: "Menor → maior",
};

const CHANNEL_FILTER_LABELS: Record<string, string> = {
  all: "Todos os canais",
  owner_direct: "Direto no Sócio",
  reception: "Recepção / Secretária",
  paid_traffic: "Investe em Anúncios",
};

/**
 * Countdown auto-contido: tem intervalo próprio de 1s e re-renderiza SÓ ele.
 * Antes um setTick global re-renderizava a página inteira (2.2k linhas) por segundo.
 */
function CountdownCard({ cd }: { cd: { secs: number; nextAt: number } | undefined }) {
  const [remainingState, setRemaining] = useState<number | null>(null);
  const nextAt = cd?.nextAt;
  useEffect(() => {
    if (nextAt === undefined) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)));
    // Primeira medição via rAF — Date.now() fora do render (regra de pureza React 19).
    const raf = requestAnimationFrame(tick);
    const t = setInterval(tick, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, [nextAt]);
  // Caso sem countdown derivado no render — puro, sem setState no effect.
  const remaining = nextAt === undefined ? null : remainingState;
  if (remaining === null || remaining <= 0) {
    return (
      <div className={styles.countdownIdle}>
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        <span>Processando agora.</span>
      </div>
    );
  }
  return (
    <div className={styles.countdownBox}>
      <Clock className="w-4 h-4 text-[#9ce9bc] shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-[#a5b1a8]">Próximo disparo em</span>
        <div className="text-base font-semibold text-[#edf2ee] font-mono leading-none mt-1">
          {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}
        </div>
      </div>
      <div className="w-16 h-1.5 bg-[#26332b] rounded-full overflow-hidden">
        <div
          className="h-full bg-[#6ee7b7] transition-all duration-1000"
          style={{ width: `${cd && cd.secs > 0 ? Math.max(0, (remaining / cd.secs) * 100) : 0}%` }}
        />
      </div>
    </div>
  );
}

function mapsUrlFor(lead: { maps_url?: string | null; place_id?: string | null; nome_negocio?: string | null; endereco?: string | null }): string {
  if (lead.maps_url && lead.maps_url.trim()) return lead.maps_url;
  if (lead.place_id && lead.place_id.trim()) return `https://www.google.com/maps/place/?q=place_id:${lead.place_id}`;
  const q = `${lead.nome_negocio || ""} ${lead.endereco || ""}`.trim();
  if (q) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  return "https://maps.google.com";
}

export default function ProspeccaoSitesPage() {
  const { clientId } = useClientSession();
  const [tab, setTab] = useState<TabKey>("captura");

  // ----- Captura (scraper) -----
  const [niches, setNiches] = useState("");
  const [regions, setRegions] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scraperLeadsCount, setScraperLeadsCount] = useState(0);
  const [maxLeads, setMaxLeads] = useState<number>(50);
  const [filterEmpty, setFilterEmpty] = useState(true);
  const [filterDuplicates, setFilterDuplicates] = useState(true);
  const [filterLandlines, setFilterLandlines] = useState(false);
  const [captureAllReviews, setCaptureAllReviews] = useState(false);
  const [filterWithWebsite, setFilterWithWebsite] = useState(false);
  const [filterWithInstagram, setFilterWithInstagram] = useState(false);
  const [turboMode, setTurboMode] = useState(true);
  const [filterClosedBusinesses, setFilterClosedBusinesses] = useState(true);
  const [auditSiteHealth, setAuditSiteHealth] = useState(true);
  const [siteFilterMode, setSiteFilterMode] = useState<SiteFilterMode>("any");
  const [enrichCnpj, setEnrichCnpj] = useState(true);
  const [prioritizePartnerPhone, setPrioritizePartnerPhone] = useState(true);
  const [validateWhatsApp, setValidateWhatsApp] = useState(true);
  const [excludeMei, setExcludeMei] = useState(false);
  const [excludeFranchises, setExcludeFranchises] = useState(false);
  const [huntPartnerDirectPhone, setHuntPartnerDirectPhone] = useState(false);
  const [expandNeighborhoods, setExpandNeighborhoods] = useState(false);
  const [minCapitalSocial, setMinCapitalSocial] = useState("0");
  const [minReviews, setMinReviews] = useState("0");
  const [minReviewsError, setMinReviewsError] = useState(false);
  const [maxReviews, setMaxReviews] = useState("0");
  const [minRating, setMinRating] = useState("0");
  const [maxRating, setMaxRating] = useState("0");
  const [googleYearFrom, setGoogleYearFrom] = useState("0");
  const [googleYearTo, setGoogleYearTo] = useState("0");
  const [extraFiltersError, setExtraFiltersError] = useState("");
  const [captureSyncNote, setCaptureSyncNote] = useState<string | null>(null);
  const [disparoSyncNote, setDisparoSyncNote] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((message: string, type = "info") => {
    setLogs((p) => {
      const next = [...p, { message, type, time: new Date().toLocaleTimeString("pt-BR") }];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) eventSourceRef.current.close();
    const es = new EventSource("/api/scraper");
    es.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data);
        if (d.event === "log") addLog(d.message, d.type);
        else if (d.event === "status") {
          setIsRunning(!!d.isScraping);
          setIsPaused(!!d.isPaused);
          setScraperLeadsCount(d.leadCount ?? 0);
        } else if (d.event === "leads_update" || d.event === "new_lead") {
          setScraperLeadsCount(d.leadCount ?? d.count ?? (d.leads?.length ?? 0));
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
    eventSourceRef.current = es;
  }, [addLog]);

  useEffect(() => {
    connectSSE();
    return () => { eventSourceRef.current?.close(); };
  }, [connectSSE]);

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const handleStart = async () => {
    const minimum = parseMinReviews(minReviews.trim() === "" ? null : Number(minReviews));
    setMinReviewsError(minimum === null);
    const parsedMaxReviews = parseMaxReviews(maxReviews);
    const parsedMinRating = parseRatingBound(minRating);
    const parsedMaxRating = parseRatingBound(maxRating);
    const parsedYearFrom = parseGoogleYear(googleYearFrom);
    const parsedYearTo = parseGoogleYear(googleYearTo);
    const parsedMinCapital = parseMinCapitalSocial(minCapitalSocial);
    let extraErr = "";
    if (parsedMaxReviews === null) extraErr = "Máximo de avaliações deve ser um inteiro entre 0 e 2147483647.";
    else if (minimum !== null) {
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
    setExtraFiltersError(extraErr);
    if (minimum === null || extraErr) return;
    const nicheList = niches.split("\n").map((n) => n.trim()).filter(Boolean);
    const regionList = regions.split("\n").map((r) => r.trim()).filter(Boolean);
    if (!nicheList.length || !regionList.length) {
      addLog("Preencha pelo menos 1 nicho e 1 região!", "error");
      return;
    }
    setLogs([]);
    addLog("Iniciando captura via Captador Maps…", "info");
    try {
      const res = await fetch("/api/scraper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          _source: "prospeccao-sites",
          niches: nicheList,
          regions: regionList,
          filterEmpty,
          filterDuplicates,
          filterLandlines,
          filterWithWebsite,
          filterWithInstagram,
          turboMode,
          filterClosedBusinesses,
          auditSiteHealth,
          siteFilterMode,
          enrichCnpj,
          prioritizePartnerPhone,
          validateWhatsApp,
          excludeMei,
          excludeFranchises,
          huntPartnerDirectPhone,
          expandNeighborhoods,
          ...(parsedMinCapital && parsedMinCapital > 0 ? { minCapitalSocial: parsedMinCapital } : {}),
          minReviews: minimum,
          ...(parsedMaxReviews && parsedMaxReviews > 0 ? { maxReviews: parsedMaxReviews } : {}),
          ...(parsedMinRating && parsedMinRating > 0 ? { minRating: parsedMinRating } : {}),
          ...(parsedMaxRating && parsedMaxRating > 0 ? { maxRating: parsedMaxRating } : {}),
          ...(parsedYearFrom && parsedYearFrom > 0 ? { googleYearFrom: parsedYearFrom } : {}),
          ...(parsedYearTo && parsedYearTo > 0 ? { googleYearTo: parsedYearTo } : {}),
          captureAllReviews,
          reviews_ai: reviewsAiEnabled
            ? { enabled: true, model: reviewsAiModel || null, prompt: reviewsAiPrompt || null }
            : undefined,
          maxLeads,
        }),
      });
      const j = await res.json();
      if (j.error) { addLog(j.error, "error"); return; }
      setIsRunning(true);
      setIsPaused(false);
      setTab("leads");
    } catch (e: any) {
      addLog(`Erro: ${e.message}`, "error");
    }
  };

  const handleScraperAction = async (action: "stop" | "pause" | "resume") => {
    try {
      await fetch("/api/scraper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (action === "stop") { setIsRunning(false); setIsPaused(false); }
      if (action === "pause") setIsPaused(true);
      if (action === "resume") setIsPaused(false);
    } catch (e: any) { addLog(`Erro: ${e.message}`, "error"); }
  };

  // ----- Lista leads -----
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [limit] = useState(50);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [sort, setSort] = useState<"reviews" | "rating" | "qualification" | "created_at">("qualification");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [ramoFilter, setRamoFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [ratingMin, setRatingMin] = useState("");
  const [ratingMax, setRatingMax] = useState("");
  const [reviewsMin, setReviewsMin] = useState("");
  const [reviewsMax, setReviewsMax] = useState("");
  const [leadYearFrom, setLeadYearFrom] = useState("");
  const [leadYearTo, setLeadYearTo] = useState("");
  const [hasWebsite, setHasWebsite] = useState<"only_empty" | "broken_or_empty" | "broken_or_weak" | "all" | "only_with">("only_empty");
  const [channelFilter, setChannelFilter] = useState<"all" | "owner_direct" | "reception" | "paid_traffic">("all");
  const [showOptOut, setShowOptOut] = useState(false);
  const [disparoFilter, setDisparoFilter] = useState<"all" | "pending" | "sent">("all");
  const [disparoJids, setDisparoJids] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Map<number, Lead>>(new Map());

  const fetchLeads = useCallback(async () => {
    setLoadingLeads(true);
    try {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
        sort,
        order,
        ignore_opt_out: showOptOut ? "false" : "true",
        hasWebsite,
        ...(channelFilter !== "all" ? { channel: channelFilter } : {}),
      });
      if (ramoFilter) params.set("ramo", ramoFilter);
      if (regionFilter) params.set("region", regionFilter);
      if (ratingMin) params.set("ratingMin", ratingMin);
      if (ratingMax) params.set("ratingMax", ratingMax);
      if (reviewsMin) params.set("reviewsMin", reviewsMin);
      if (reviewsMax) params.set("reviewsMax", reviewsMax);
      if (leadYearFrom) params.set("googleYearFrom", leadYearFrom);
      if (leadYearTo) params.set("googleYearTo", leadYearTo);
      const r = await fetch(`/api/prospeccao-sites/leads?${params}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) { setLeads(j.leads); setTotal(j.total); }

      // Fetch sent disparo JIDs for badge/filter accuracy
      try {
        const dr = await fetch("/api/prospeccao-sites/leads?disparo_status=1", { cache: "no-store" });
        const dj = await dr.json();
        if (dj.ok && dj.disparoJids) { setDisparoJids(new Set(dj.disparoJids)); }
      } catch { /* fallback to primeiro_contato_source */ }
    } catch (e) { console.error("fetchLeads", e); }
    finally { setLoadingLeads(false); }
  }, [page, limit, sort, order, ramoFilter, regionFilter, showOptOut, hasWebsite, channelFilter, ratingMin, ratingMax, reviewsMin, reviewsMax, leadYearFrom, leadYearTo]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // Auto-pull após scraper parar → atualiza lista
  useEffect(() => {
    if (!isRunning && scraperLeadsCount > 0 && tab === "leads") {
      const t = setTimeout(fetchLeads, 800);
      return () => clearTimeout(t);
    }
  }, [isRunning, scraperLeadsCount, tab, fetchLeads]);

  // Filtros client-side p/ hasWebsite + rating + reviews + ano no Google
  const filteredLeads = useMemo(() => {
    return leads.filter((l) => {
      const isDisparado = l.primeiro_contato_source === "disparo" || disparoJids.has(l.remoteJid);
      if (disparoFilter === "pending" && isDisparado) return false;
      if (disparoFilter === "sent" && !isDisparado) return false;
      const hasW = !isNonWebsiteUrl(l.website) && l.enrichment?.siteHealth !== "no_site";
      const sh = l.enrichment?.siteHealth;
      if (hasWebsite === "only_empty" && hasW) return false;
      if (hasWebsite === "only_with" && !hasW) return false;
      if (hasWebsite === "broken_or_weak" && sh !== "broken_site" && sh !== "weak_site") return false;
      if (hasWebsite === "broken_or_empty" && hasW && sh !== "broken_site" && sh !== "weak_site") return false;
      if (channelFilter === "owner_direct" && l.enrichment?.whatsappChannelType !== "socio_direto" && l.enrichment?.whatsappChannelType !== "provavel_socio") return false;
      if (channelFilter === "reception" && l.enrichment?.whatsappChannelType !== "recepcao_comercial") return false;
      if (channelFilter === "paid_traffic" && !l.enrichment?.hasPaidTrafficTag) return false;
      if (ratingMin) {
        const r = parseFloat(l.rating || "0");
        if (isNaN(r) || r < Number(ratingMin)) return false;
      }
      if (ratingMax && Number(ratingMax) > 0) {
        const r = parseFloat(l.rating || "0");
        if (!isNaN(r) && r > Number(ratingMax)) return false;
      }
      if (reviewsMin) {
        const rv = parseInt(l.reviews || "0", 10);
        if (isNaN(rv) || rv < Number(reviewsMin)) return false;
      }
      if (reviewsMax && Number(reviewsMax) > 0) {
        const rv = parseInt(l.reviews || "0", 10);
        if (!isNaN(rv) && rv > Number(reviewsMax)) return false;
      }
      if ((leadYearFrom && Number(leadYearFrom) > 0) || (leadYearTo && Number(leadYearTo) > 0)) {
        const yr = parseInt(String(l.year_established || ""), 10);
        if (isNaN(yr)) return false;
        if (leadYearFrom && Number(leadYearFrom) > 0 && yr < Number(leadYearFrom)) return false;
        if (leadYearTo && Number(leadYearTo) > 0 && yr > Number(leadYearTo)) return false;
      }
      return true;
    });
  }, [leads, hasWebsite, channelFilter, ratingMin, ratingMax, reviewsMin, reviewsMax, leadYearFrom, leadYearTo, disparoFilter, disparoJids]);

  // Ranking: reviews desc default. Score = reviews * rating (proxy importância)
  const rankedLeads = useMemo(() => {
    const sorted = [...filteredLeads].sort((a, b) => {
      const ra = parseInt(a.reviews || "0", 10) || 0;
      const rb = parseInt(b.reviews || "0", 10) || 0;
      const sa = parseFloat(a.rating || "0") || 0;
      const sb = parseFloat(b.rating || "0") || 0;
      const qa = a.enrichment?.qualificationScore ?? 0;
      const qb = b.enrichment?.qualificationScore ?? 0;
      if (sort === "qualification") return order === "desc" ? qb - qa : qa - qb;
      if (sort === "reviews") return order === "desc" ? rb - ra : ra - rb;
      if (sort === "rating")  return order === "desc" ? sb - sa : sa - sb;
      return order === "desc"
        ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        : new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    return sorted;
  }, [filteredLeads, sort, order]);

  const toggleSelect = (lead: Lead) => {
    setSelected((cur) => {
      const next = new Map(cur);
      if (next.has(lead.id)) next.delete(lead.id); else next.set(lead.id, lead);
      return next;
    });
  };
  const selectAllVisible = () => {
    if (selected.size === rankedLeads.length && rankedLeads.length > 0) setSelected(new Map());
    else setSelected(new Map(rankedLeads.map((l) => [l.id, l])));
  };

  const deleteLeads = async (ids: number[]) => {
    if (!ids.length) return;
    if (!confirm(`Deletar ${ids.length} lead(s) do banco? Esta ação não pode ser desfeita.`)) return;
    try {
      const res = await fetch("/api/prospeccao-sites/leads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "falha");
      setSelected(new Map());
      await fetchLeads();
    } catch (e: any) {
      alert("Erro ao deletar: " + e.message);
    }
  };

  // Geração de prévia removida desta tela: Prospecção de Sites é somente disparo.
  // O site continua disponível pelo Site Studio (/sites) e por outros fluxos.

  // ----- Instâncias + Campaigns -----
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [vendedor, setVendedor] = useState(VENDEDOR_DEFAULT);
  const [name, setName] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [instances, setInstances] = useState<{ instance_name: string; provider?: string; status?: string; agent_id?: string }[]>([]);
  const [minSec, setMinSec] = useState(30);
  const [maxSec, setMaxSec] = useState(60);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(20);
  const [creating, setCreating] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);

  // ----- Real-time logs + targets (igual Disparo) -----
  const [activeLogCampaignId, setActiveLogCampaignId] = useState<string | null>(null);
  const [campLogs, setCampLogs] = useState<{ id: number; message: string; level: string; created_at: string }[]>([]);
  const campLogEndRef = useRef<HTMLDivElement>(null);
  const [latestLogByCampaign, setLatestLogByCampaign] = useState<Record<string, { message: string; level: string; created_at: string }>>({});
  const [countdowns, setCountdowns] = useState<Record<string, { secs: number; nextAt: number }>>({});

  type TargetRow = {
    id: string;
    remote_jid: string;
    nome_negocio: string | null;
    ramo_negocio: string | null;
    status: string;
    rendered_message: string | null;
    ai_input: string | null;
    sent_at: string | null;
    error_message: string | null;
    attempts: number | null;
  };
  const [activeTargetsCampaignId, setActiveTargetsCampaignId] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [targetsFilter, setTargetsFilter] = useState<"all" | "sent" | "failed" | "pending">("all");

  // ----- IA rewrite (igual automação) -----
  const [personalizeWithAi, setPersonalizeWithAi] = useState(false);
  const [humanizeMessages, setHumanizeMessages] = useState(false);
  const [antibanMixer, setAntibanMixer] = useState(true);
  const [weekendGuard, setWeekendGuard] = useState<WeekendB2BGuardMode>(false);
  const [coldShield, setColdShield] = useState(true);
  const [spintaxSeed, setSpintaxSeed] = useState(0);
  const [aiModels, setAiModels] = useState<{ id: string; name?: string; provider?: string }[]>([]);
  const [aiModel, setAiModel] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [loadingAiModels, setLoadingAiModels] = useState(false);

  // ----- Reviews AI (resumo de avaliações com IA) -----
  const [reviewsAiEnabled, setReviewsAiEnabled] = useState(false);
  const [reviewsAiModel, setReviewsAiModel] = useState("");
  const [reviewsAiPrompt, setReviewsAiPrompt] = useState("");
  const [reviewsAiRunning, setReviewsAiRunning] = useState(false);
  const [reviewsAiResults, setReviewsAiResults] = useState<{ lead_id: number; ok: boolean; nome_negocio?: string | null; resumo?: string; cached?: boolean; error?: string }[] | null>(null);

  // ----- Automação (full pipeline) -----
  type AutomationRow = {
    id: string;
    name: string;
    status: string;
    phase: string;
    instance_name: string;
    niches: string[];
    regions: string[];
    scrape_filters: Record<string, any>;
    scrape_max_leads: number;
    dispatch_template: string;
    dispatch_min_interval: number;
    dispatch_max_interval: number;
    dispatch_personalize: boolean;
    dispatch_ai_model: string | null;
    dispatch_ai_prompt: string | null;
    followup_enabled: boolean;
    followup_steps: any[];
    followup_min_interval: number;
    followup_max_interval: number;
    allowed_start_hour: number;
    allowed_end_hour: number;
    scraped_count: number;
    campaign_id: string | null;
    followup_campaign_id: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  };
  type AutoLog = { id: number; kind: string; level: string; message: string; created_at: string };
  const [automations, setAutomations] = useState<AutomationRow[]>([]);
  const [pendingAutoActions, setPendingAutoActions] = useState<Set<string>>(new Set());
  const pendingAutoActionsRef = useRef(new Set<string>());
  const [autoLogs, setAutoLogs] = useState<Record<string, AutoLog[]>>({});
  const [expandedAuto, setExpandedAuto] = useState<string | null>(null);

  const [autoName, setAutoName] = useState("");
  const [autoNiches, setAutoNiches] = useState("");
  const [autoRegions, setAutoRegions] = useState("");
  const [autoMaxLeads, setAutoMaxLeads] = useState(200);
  const [autoTemplate, setAutoTemplate] = useState(DEFAULT_TEMPLATE);
  const [autoMinSec, setAutoMinSec] = useState(60);
  const [autoMaxSec, setAutoMaxSec] = useState(180);
  const [autoStartHour, setAutoStartHour] = useState(9);
  const [autoEndHour, setAutoEndHour] = useState(20);
  const [autoFollowup, setAutoFollowup] = useState(true);
  const [autoFollowupAi, setAutoFollowupAi] = useState(false);
  const [autoFollowupAiModel, setAutoFollowupAiModel] = useState("");
  const [autoFollowupAiPrompt, setAutoFollowupAiPrompt] = useState("");
  const [autoFuMinSec, setAutoFuMinSec] = useState(60);
  const [autoFuMaxSec, setAutoFuMaxSec] = useState(240);
  const [autoPersonalize, setAutoPersonalize] = useState(false);
  const [autoHumanize, setAutoHumanize] = useState(false);
  const [autoAntibanMixer, setAutoAntibanMixer] = useState(true);
  const [autoWeekendGuard, setAutoWeekendGuard] = useState<WeekendB2BGuardMode>(false);
  const [autoColdShield, setAutoColdShield] = useState(true);
  const [autoAiModel, setAutoAiModel] = useState("");
  const [autoAiPrompt, setAutoAiPrompt] = useState("");
  const [autoCaptureAllReviews, setAutoCaptureAllReviews] = useState(false);
  const [autoReviewsAi, setAutoReviewsAi] = useState(false);
  const [autoReviewsAiModel, setAutoReviewsAiModel] = useState("");
  const [autoReviewsAiPrompt, setAutoReviewsAiPrompt] = useState("");
  const [autoFilterEmpty, setAutoFilterEmpty] = useState(true);
  const [autoFilterDuplicates, setAutoFilterDuplicates] = useState(true);
  const [autoFilterLandlines, setAutoFilterLandlines] = useState(false);
  const [autoFilterWithWebsite, setAutoFilterWithWebsite] = useState(true);
  const [autoFilterWithInstagram, setAutoFilterWithInstagram] = useState(false);
  const [autoTurboMode, setAutoTurboMode] = useState(true);
  const [autoFilterClosedBusinesses, setAutoFilterClosedBusinesses] = useState(true);
  const [autoAuditSiteHealth, setAutoAuditSiteHealth] = useState(false);
  const [autoSiteFilterMode, setAutoSiteFilterMode] = useState<SiteFilterMode>("no_site");
  const [autoSyncNote, setAutoSyncNote] = useState<string | null>(null);
  const [autoEnrichCnpj, setAutoEnrichCnpj] = useState(true);
  const [autoPrioritizePartnerPhone, setAutoPrioritizePartnerPhone] = useState(true);
  const [autoValidateWhatsApp, setAutoValidateWhatsApp] = useState(true);
  const [autoExcludeMei, setAutoExcludeMei] = useState(false);
  const [autoExcludeFranchises, setAutoExcludeFranchises] = useState(false);
  const [autoHuntPartnerDirectPhone, setAutoHuntPartnerDirectPhone] = useState(false);
  const [autoExpandNeighborhoods, setAutoExpandNeighborhoods] = useState(false);
  const [autoPrioritizeByScore, setAutoPrioritizeByScore] = useState(true);
  const [autoMinCapitalSocial, setAutoMinCapitalSocial] = useState("0");
  const [autoMinReviews, setAutoMinReviews] = useState("0");
  const [autoMinReviewsError, setAutoMinReviewsError] = useState(false);
  const [autoMaxReviews, setAutoMaxReviews] = useState("0");
  const [autoMinRating, setAutoMinRating] = useState("0");
  const [autoMaxRating, setAutoMaxRating] = useState("0");
  const [autoGoogleYearFrom, setAutoGoogleYearFrom] = useState("0");
  const [autoGoogleYearTo, setAutoGoogleYearTo] = useState("0");
  const [autoExtraFiltersError, setAutoExtraFiltersError] = useState("");
  // Delay & Digitando na Evolution API (anti-banimento)
  const [autoTypingDelayMode, setAutoTypingDelayMode] = useState<"fixed" | "random">("random");
  const [autoTypingDelaySeconds, setAutoTypingDelaySeconds] = useState(10);
  const [autoTypingDelayMinSeconds, setAutoTypingDelayMinSeconds] = useState(5);
  const [autoTypingDelayMaxSeconds, setAutoTypingDelayMaxSeconds] = useState(25);
  const [autoSteps, setAutoSteps] = useState<{ day_offset: number; template: string }[]>([
    { day_offset: 2, template: "Olá {{nome_empresa}}, tudo bem? Ainda tem interesse em ter um site profissional para sua empresa {{ramo}}?" },
  ]);
  const [autoInstance, setAutoInstance] = useState("");
  const [creatingAuto, setCreatingAuto] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/instances", { cache: "no-store" });
        const j = await r.json();
        if (Array.isArray(j.instances)) setInstances(j.instances);
      } catch (e) { console.warn("instances", e); }
      try {
        setLoadingAiModels(true);
        const r2 = await fetch("/api/ai-models", { cache: "no-store" });
        const j2 = await r2.json();
        const list = Array.isArray(j2.models) ? j2.models : [];
        setAiModels(list);
        if (list.length && !aiModel) setAiModel(list[0].id);
        if (list.length && !reviewsAiModel) setReviewsAiModel(list[0].id);
        if (list.length && !autoReviewsAiModel) setAutoReviewsAiModel(list[0].id);
      } catch (e) { console.warn("ai-models", e); }
      finally { setLoadingAiModels(false); }
    })();
  }, []);

  async function loadCampaigns(initial = false) {
    if (initial) setLoadingCampaigns(true);
    try {
      const r = await fetch("/api/prospeccao-sites/campaigns", { cache: "no-store" });
      const j = await r.json();
      if (j.success) {
        setCampaigns(prev => {
          const next: Campaign[] = j.campaigns || [];
          if (prev.length !== next.length) return next;
          const changed = next.some((c, i) => {
            const p = prev[i];
            return !p || p.id !== c.id
              || p.status !== c.status
              || p.sent_count !== c.sent_count
              || p.failed_count !== c.failed_count
              || p.total_targets !== c.total_targets
              || p.skipped_count !== c.skipped_count
              || p.last_error !== c.last_error;
          });
          return changed ? next : prev;
        });
      }
    } catch (e) { console.error(e); }
    finally { if (initial) setLoadingCampaigns(false); }
  }
  useEffect(() => { loadCampaigns(true); }, []);

  // ----- Automação fetch + actions -----
  const loadAutomations = useCallback(async () => {
    try {
      const r = await fetch("/api/automations?source=prospeccao-sites", { cache: "no-store" });
      const j = await r.json();
      if (j.success) {
        const autos = j.automations || [];
        setAutomations(autos);
        setExpandedAuto((prev) => {
          if (prev && autos.some((a: any) => a.id === prev)) return prev;
          const running = autos.find((a: any) => a.status === "running");
          return running ? running.id : (autos[0]?.id || null);
        });
      }
    } catch (e) { console.error("loadAutomations", e); }
  }, []);

  useEffect(() => { loadAutomations(); }, [loadAutomations]);

  useEffect(() => {
    if (tab !== "automacao") return;
    const timer = setInterval(loadAutomations, 3000);
    return () => clearInterval(timer);
  }, [tab, loadAutomations]);

  const loadAutoLogs = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(id)}/logs?only=automation`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        setAutoLogs(prev => ({ ...prev, [id]: (json.logs as AutoLog[]) || [] }));
      }
    } catch { /* noop */ }
  }, []);

  const createAutomation = async () => {
    const minimum = parseMinReviews(autoMinReviews.trim() === "" ? null : Number(autoMinReviews));
    setAutoMinReviewsError(minimum === null);
    const parsedMaxReviews = parseMaxReviews(autoMaxReviews);
    const parsedMinRating = parseRatingBound(autoMinRating);
    const parsedMaxRating = parseRatingBound(autoMaxRating);
    const parsedYearFrom = parseGoogleYear(autoGoogleYearFrom);
    const parsedYearTo = parseGoogleYear(autoGoogleYearTo);
    const parsedMinCapital = parseMinCapitalSocial(autoMinCapitalSocial);
    let extraErr = "";
    if (parsedMaxReviews === null) extraErr = "Máximo de avaliações deve ser um inteiro entre 0 e 2147483647.";
    else if (minimum !== null) {
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
    setAutoExtraFiltersError(extraErr);
    if (minimum === null || extraErr) return;
    const nichesArr = autoNiches.split("\n").map(s => s.trim()).filter(Boolean);
    const regionsArr = autoRegions.split("\n").map(s => s.trim()).filter(Boolean);
    if (!autoName.trim() || !autoInstance || !autoTemplate.trim() || nichesArr.length === 0 || regionsArr.length === 0) {
      alert("Preencha nome, instância, template, nichos e regiões.");
      return;
    }
    if (autoFollowup && autoSteps.length === 0) {
      alert("Adicione ao menos 1 passo de follow-up ou desative o follow-up.");
      return;
    }
    setCreatingAuto(true);
    try {
      const r = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: autoName,
          instance_name: autoInstance,
          niches: nichesArr,
          regions: regionsArr,
          scrape_filters: {
            _source: "prospeccao-sites",
            filterEmpty: autoFilterEmpty,
            filterDuplicates: autoFilterDuplicates,
            filterLandlines: autoFilterLandlines,
            filterWithWebsite: autoFilterWithWebsite,
            filterWithInstagram: autoFilterWithInstagram,
            turboMode: autoTurboMode,
            filterClosedBusinesses: autoFilterClosedBusinesses,
            auditSiteHealth: autoAuditSiteHealth,
            siteFilterMode: autoSiteFilterMode,
            enrichCnpj: autoEnrichCnpj,
            prioritizePartnerPhone: autoPrioritizePartnerPhone,
            validateWhatsApp: autoValidateWhatsApp,
            excludeMei: autoExcludeMei,
            excludeFranchises: autoExcludeFranchises,
            huntPartnerDirectPhone: autoHuntPartnerDirectPhone,
            expandNeighborhoods: autoExpandNeighborhoods,
            prioritize_by_score: autoPrioritizeByScore,
            ...(parsedMinCapital && parsedMinCapital > 0 ? { minCapitalSocial: parsedMinCapital } : {}),
            minReviews: minimum,
            ...(parsedMaxReviews && parsedMaxReviews > 0 ? { maxReviews: parsedMaxReviews } : {}),
            ...(parsedMinRating && parsedMinRating > 0 ? { minRating: parsedMinRating } : {}),
            ...(parsedMaxRating && parsedMaxRating > 0 ? { maxRating: parsedMaxRating } : {}),
            ...(parsedYearFrom && parsedYearFrom > 0 ? { googleYearFrom: parsedYearFrom } : {}),
            ...(parsedYearTo && parsedYearTo > 0 ? { googleYearTo: parsedYearTo } : {}),
            captureAllReviews: autoCaptureAllReviews || autoReviewsAi,
            reviews_ai: autoReviewsAi
              ? { enabled: true, model: autoReviewsAiModel || null, prompt: autoReviewsAiPrompt || null }
              : { enabled: false },
            typing_delay_mode: autoTypingDelayMode,
            typing_delay_seconds: autoTypingDelaySeconds,
            typing_delay_min_seconds: autoTypingDelayMinSeconds,
            typing_delay_max_seconds: autoTypingDelayMaxSeconds,
            typing_delay: {
              mode: autoTypingDelayMode,
              seconds: autoTypingDelaySeconds,
              min_seconds: autoTypingDelayMinSeconds,
              max_seconds: autoTypingDelayMaxSeconds,
            },
            antiban_mixer: autoAntibanMixer,
            weekend_guard: autoWeekendGuard,
            cold_shield: autoColdShield,
          },
          scrape_max_leads: autoMaxLeads,
          dispatch_template: autoTemplate,
          dispatch_min_interval: autoMinSec,
          dispatch_max_interval: autoMaxSec,
          dispatch_personalize: autoPersonalize,
          dispatch_humanize: autoHumanize,
          dispatch_ai_model: autoPersonalize ? (autoAiModel || null) : null,
          dispatch_ai_prompt: autoPersonalize ? (autoAiPrompt || null) : null,
          followup_enabled: autoFollowup,
          followup_steps: autoFollowup ? autoSteps.map(s => ({ day_offset: Math.max(1, Number(s.day_offset) || 1), template: s.template })) : [],
          followup_min_interval: autoFuMinSec,
          followup_max_interval: autoFuMaxSec,
          followup_ai_enabled: autoFollowup && autoFollowupAi,
          followup_ai_model: (autoFollowup && autoFollowupAi) ? (autoFollowupAiModel || null) : null,
          followup_ai_prompt: (autoFollowup && autoFollowupAi) ? (autoFollowupAiPrompt || null) : null,
          allowed_start_hour: autoStartHour,
          allowed_end_hour: autoEndHour,
          site_generation_enabled: false,
        }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "create fail");
      setAutoName("");
      loadAutomations();
    } catch (e: any) { alert("Erro: " + e.message); }
    finally { setCreatingAuto(false); }
  };

  const autoAction = async (id: string, action: "start" | "pause" | "delete") => {
    if (pendingAutoActionsRef.current.has(id)) return;
    if (action === "delete" && !confirm("Deletar esta automação?")) return;
    pendingAutoActionsRef.current.add(id);
    setPendingAutoActions(new Set(pendingAutoActionsRef.current));
    try {
      const response = action === "delete"
        ? await fetch(`/api/automations/${id}`, { method: "DELETE" })
        : await fetch(`/api/automations/${id}/${action}`, { method: "POST" });
      const result: { success?: boolean; ok?: boolean; error?: unknown } | null = await response.json().catch(() => null);
      const succeeded = action === "delete" ? result?.success : result?.ok;
      if (!response.ok || succeeded !== true || result?.ok === false || result?.success === false) {
        throw new Error(typeof result?.error === "string" && result.error ? result.error : "Não foi possível atualizar a automação.");
      }
      await loadAutomations();
    } catch (e: unknown) {
      alert("Erro: " + (e instanceof Error ? e.message : "Não foi possível atualizar a automação."));
    } finally {
      pendingAutoActionsRef.current.delete(id);
      setPendingAutoActions(new Set(pendingAutoActionsRef.current));
    }
  };

  async function loadTargets(campaignId: string) {
    setLoadingTargets(true);
    try {
      const r = await fetch(`/api/prospeccao-sites/campaigns/${campaignId}`, { cache: "no-store" });
      const d = await r.json();
      if (d.success) setTargets((d.targets || []) as TargetRow[]);
    } catch {}
    finally { setLoadingTargets(false); }
  }

  useEffect(() => {
    if (!activeTargetsCampaignId) return;
    loadTargets(activeTargetsCampaignId);
    const camp = campaigns.find(c => c.id === activeTargetsCampaignId);
    if (camp?.status !== "running") return;
    const t = setInterval(() => loadTargets(activeTargetsCampaignId), 5000);
    return () => clearInterval(t);
  }, [activeTargetsCampaignId, campaigns]);

  // Fast polling when any campaign is running (no loading=true = no flicker)
  useEffect(() => {
    const anyRunning = campaigns.some(c => c.status === "running");
    if (!anyRunning) return;
    const t = setInterval(() => loadCampaigns(false), 3000);
    return () => clearInterval(t);
  }, [campaigns]);

  // Real-time log subscription for the selected campaign
  useEffect(() => {
    if (!activeLogCampaignId) {
      setCampLogs([]);
      return;
    }
    async function fetchInitialLogs() {
      const r = await fetch(`/api/campaigns/logs?campaign_id=${encodeURIComponent(activeLogCampaignId!)}&limit=200`, { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (r.ok && d?.success) setCampLogs(Array.isArray(d.logs) ? d.logs : []);
    }
    fetchInitialLogs();
    const campLogPoll = setInterval(() => {
      if (!document.hidden) fetchInitialLogs();
    }, 4000);

    const channel = typeof supabase?.channel === "function"
      ? supabase
          .channel(`ps-logs-${activeLogCampaignId}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "campaign_logs", filter: `campaign_id=eq.${activeLogCampaignId}` },
            (payload) => {
              const incoming = payload.new as any;
              if (clientId && incoming?.client_id && incoming.client_id !== clientId) return;
              setCampLogs((prev) => mergeRealtimeLog(prev, incoming, 200));
            }
          )
          .subscribe()
      : null;

    return () => { clearInterval(campLogPoll); if (channel) supabase.removeChannel(channel); };
  }, [activeLogCampaignId, clientId]);

  useEffect(() => {
    campLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [campLogs]);

  async function refreshLogs() {
    if (!activeLogCampaignId) return;
    const r = await fetch(`/api/campaigns/logs?campaign_id=${encodeURIComponent(activeLogCampaignId)}&limit=200`, { cache: "no-store" });
    const d = await r.json().catch(() => null);
    if (r.ok && d?.success) setCampLogs(Array.isArray(d.logs) ? d.logs : []);
  }

  async function clearLogs(campaignId: string) {
    if (!confirm("Apagar todo o histórico de logs desta campanha?")) return;
    const r = await fetch(`/api/campaigns/logs?campaign_id=${encodeURIComponent(campaignId)}`, { method: "DELETE" });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.success) alert("Erro: " + (d?.error || "falha no servidor"));
    else setCampLogs([]);
  }

  // Latest log per running campaign (poll + realtime) — shows "what's happening NOW"
  useEffect(() => {
    const runningIds = campaigns.filter(c => c.status === "running").map(c => c.id);
    if (runningIds.length === 0) {
      setCountdowns({});
      return;
    }

    let cancelled = false;
    async function fetchLatest() {
      const r = await fetch(`/api/campaigns/logs?latest_ids=${encodeURIComponent(runningIds.join(","))}`, { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (cancelled || !r.ok || !d?.latestById) return;
      const byId = d.latestById as Record<string, any>;
      setLatestLogByCampaign(prev => ({ ...prev, ...byId }));

      // Parse countdown from "Aguardando Xs até o próximo envio..."
      const cd: Record<string, { secs: number; nextAt: number }> = {};
      for (const [cid, row] of Object.entries(byId)) {
        const m = (row as any).message?.match(/Aguardando\s+(\d+)s/i);
        if (m) {
          const secs = parseInt(m[1], 10);
          const startMs = new Date((row as any).created_at).getTime();
          cd[cid] = { secs, nextAt: startMs + secs * 1000 };
        }
      }
      setCountdowns(prev => {
        const next = { ...prev };
        for (const cid of Object.keys(cd)) next[cid] = cd[cid];
        for (const cid of Object.keys(next)) {
          if (!cd[cid] && runningIds.includes(cid)) delete next[cid];
        }
        return next;
      });
    }
    fetchLatest();
    const t = setInterval(fetchLatest, 3000);

    const channel = clientId && typeof supabase?.channel === "function"
      ? supabase
          .channel(`ps-live-${clientId}-${runningIds.join("-")}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "campaign_logs", filter: `client_id=eq.${clientId}` },
            (payload) => {
              const row = payload.new as any;
              if (row?.client_id !== clientId || !runningIds.includes(row.campaign_id)) return;
              setLatestLogByCampaign(prev => ({ ...prev, [row.campaign_id]: row }));
              const m = row.message?.match(/Aguardando\s+(\d+)s/i);
              if (m) {
                const secs = parseInt(m[1], 10);
                const startMs = new Date(row.created_at).getTime();
                setCountdowns(prev => ({ ...prev, [row.campaign_id]: { secs, nextAt: startMs + secs * 1000 } }));
              }
            }
          )
          .subscribe()
      : null;

    return () => {
      cancelled = true;
      clearInterval(t);
      if (channel) supabase.removeChannel(channel);
    };
  }, [campaigns, clientId]);

  const previewFor = (lead: Lead) => {
    void spintaxSeed;
    const ctx: TemplateContext = {
      nome_negocio: lead.nome_negocio || "",
      ramo_negocio: lead.ramo_negocio || "",
      telefone: lead.telefone || lead.remoteJid.split("@")[0],
      endereco: lead.endereco || "",
      avaliacao: lead.rating || "",
      reviews: lead.reviews || "",
      website: lead.website || "",
      owner_name: lead.owner_name || lead.enrichment?.socioDecisor || "",
      business_details: lead.enrichment ? { enrichment: lead.enrichment } : null,
      variables: { vendedor },
    };
    return renderTemplate(template, ctx, { spintax: true });
  };

  const createCampaign = async () => {
    if (!name.trim() || !instanceName || !template.trim() || selected.size === 0) {
      alert("Preencha nome, instância, template e selecione ao menos 1 lead.");
      return;
    }
    setCreating(true);
    try {
      const r = await fetch("/api/prospeccao-sites/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, instance_name: instanceName, message_template: template,
          min_interval_seconds: minSec, max_interval_seconds: maxSec,
          allowed_start_hour: startHour, allowed_end_hour: endHour,
          lead_ids: Array.from(selected.keys()),
          personalize_with_ai: personalizeWithAi,
          humanize_messages: humanizeMessages,
          antiban_mixer: antibanMixer,
          weekend_guard: weekendGuard,
          cold_shield: coldShield,
          ai_model: personalizeWithAi ? (aiModel || null) : null,
          ai_prompt: personalizeWithAi ? (aiPrompt || null) : null,
          order_by: sort, order_dir: order,
          min_reviews: Number(reviewsMin) || 0,
          min_rating: Number(ratingMin) || 0,
        }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "POST fail");
      alert(`Campanha criada com ${j.campaign.total_targets} alvos.`);
      setName("");
      setSelected(new Map());
      setTab("historico");
      loadCampaigns();
    } catch (e: any) { alert("Erro: " + e.message); }
    finally { setCreating(false); }
  };

  const actionCampaign = async (id: string, a: "start" | "pause" | "cancel" | "reset") => {
    try {
      const res = await fetch(`/api/prospeccao-sites/campaigns/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: a }),
      });
      const data = await res.json();
      if (!data.success && data.error) {
        alert("Erro: " + data.error);
      }
      loadCampaigns();
    } catch (e: any) { alert("Erro de conexão: " + e.message); }
  };

  const deleteCampaign = async (c: { id: string; name: string }) => {
    if (!confirm(`Excluir a campanha "${c.name}"? Alvos, logs e histórico de envios serão removidos.`)) return;
    try {
      const res = await fetch(`/api/prospeccao-sites/campaigns/${c.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success && data.error) {
        alert("Erro: " + data.error);
        return;
      }
      loadCampaigns();
    } catch (e: any) { alert("Erro de conexão: " + e.message); }
  };

  const runReviewsAi = async () => {
    const ids = selected.size > 0 ? Array.from(selected.keys()) : leads.map((l) => l.id);
    if (ids.length === 0) { alert("Selecione leads na aba Leads (ou capture leads primeiro)."); return; }
    if (!reviewsAiModel) { alert("Nenhum modelo de IA disponível (admin precisa configurar API key)."); return; }
    if (!confirm(`Analisar avaliações de ${Math.min(ids.length, 50)} lead(s) com IA? (cache de 7 dias por lead)`)) return;
    setReviewsAiRunning(true);
    setReviewsAiResults(null);
    try {
      const r = await fetch("/api/prospeccao-sites/reviews-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_ids: ids.slice(0, 50), model: reviewsAiModel, prompt: reviewsAiPrompt || undefined }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "POST fail");
      setReviewsAiResults(j.results || []);
      fetchLeads();
    } catch (e: any) { alert("Erro: " + e.message); }
    finally { setReviewsAiRunning(false); }
  };

  const markOptOut = async (lead: Lead) => {
    if (!confirm(`Marcar ${lead.nome_negocio || lead.remoteJid} como opt-out?`)) return;
    try {
      await fetch("/api/prospeccao-sites/opt-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remote_jid: lead.remoteJid }),
      });
      fetchLeads();
    } catch (e) { console.error(e); }
  };

  // Estatísticas helper
  const stats = useMemo(() => {
    const withW = rankedLeads.filter((l) => !isNonWebsiteUrl(l.website) && l.enrichment?.siteHealth !== "no_site").length;
    const withoutW = rankedLeads.length - withW;
    const rated = rankedLeads.map((l) => parseFloat(l.rating || "0")).filter((r) => !isNaN(r) && r > 0);
    const avgRating = rated.length
      ? (rated.reduce((s, r) => s + r, 0) / rated.length).toFixed(1)
      : "0";
    const totalReviews = rankedLeads.reduce((s, l) => s + (parseInt(l.reviews || "0", 10) || 0), 0);
    return { withW, withoutW, avgRating, totalReviews };
  }, [rankedLeads]);

  function renderPresetIcon(presetId: ScraperPresetId) {
    if (presetId === "vender_sites") return <Globe className="w-4 h-4" />;
    if (presetId === "vender_ia") return <Bot className="w-4 h-4" />;
    if (presetId === "direto_socio") return <Smartphone className="w-4 h-4" />;
    return <Zap className="w-4 h-4" />;
  }

  function applyCaptureFilterSync(action: ScraperFilterChangeAction) {
    const current: ScraperFilterSyncState = {
      filterEmpty,
      filterDuplicates,
      filterLandlines,
      filterWithWebsite,
      filterWithInstagram,
      captureAllReviews,
      reviewsAiEnabled,
      turboMode,
      filterClosedBusinesses,
      auditSiteHealth,
      siteFilterMode,
      enrichCnpj,
      prioritizePartnerPhone,
      validateWhatsApp,
      excludeMei,
      excludeFranchises,
      huntPartnerDirectPhone,
      expandNeighborhoods,
      prioritizeByScore: false,
      minCapitalSocial,
    };
    const { state: next, autoNote } = applyScraperFilterChange(current, action, "prospeccao-sites");
    setFilterEmpty(next.filterEmpty);
    setFilterDuplicates(next.filterDuplicates);
    setFilterLandlines(next.filterLandlines);
    setFilterWithWebsite(next.filterWithWebsite);
    setFilterWithInstagram(next.filterWithInstagram);
    setCaptureAllReviews(next.captureAllReviews);
    setReviewsAiEnabled(next.reviewsAiEnabled);
    setTurboMode(next.turboMode);
    setFilterClosedBusinesses(next.filterClosedBusinesses);
    setAuditSiteHealth(next.auditSiteHealth);
    setSiteFilterMode(next.siteFilterMode);
    setEnrichCnpj(next.enrichCnpj);
    setPrioritizePartnerPhone(next.prioritizePartnerPhone);
    setValidateWhatsApp(next.validateWhatsApp);
    setExcludeMei(next.excludeMei);
    setExcludeFranchises(next.excludeFranchises);
    setHuntPartnerDirectPhone(next.huntPartnerDirectPhone);
    setMinCapitalSocial(next.minCapitalSocial);
    setCaptureSyncNote(autoNote);
    if (action.type === "minCapitalSocial" || action.type === "preset") {
      setExtraFiltersError("");
    }
  }

  function applyDisparoFilterSync(action: { type: "personalizeWithAi" | "antibanMixer"; value: boolean }) {
    const current: ScraperFilterSyncState = {
      filterEmpty,
      filterDuplicates,
      filterLandlines,
      filterWithWebsite,
      filterWithInstagram,
      captureAllReviews,
      reviewsAiEnabled,
      turboMode,
      filterClosedBusinesses,
      auditSiteHealth,
      siteFilterMode,
      enrichCnpj,
      prioritizePartnerPhone,
      validateWhatsApp,
      excludeMei,
      excludeFranchises,
      huntPartnerDirectPhone,
      expandNeighborhoods,
      prioritizeByScore: false,
      minCapitalSocial,
      personalizeWithAi,
      antibanMixer,
    };
    const { state: next, autoNote } = applyScraperFilterChange(current, action, "prospeccao-sites");
    setPersonalizeWithAi(Boolean(next.personalizeWithAi));
    setAntibanMixer(next.antibanMixer !== false);
    setDisparoSyncNote(autoNote);
  }

  function applyAutoFilterSync(action: ScraperFilterChangeAction) {
    const current: ScraperFilterSyncState = {
      filterEmpty: autoFilterEmpty,
      filterDuplicates: autoFilterDuplicates,
      filterLandlines: autoFilterLandlines,
      filterWithWebsite: autoFilterWithWebsite,
      filterWithInstagram: autoFilterWithInstagram,
      captureAllReviews: autoCaptureAllReviews,
      reviewsAiEnabled: autoReviewsAi,
      turboMode: autoTurboMode,
      filterClosedBusinesses: autoFilterClosedBusinesses,
      auditSiteHealth: autoAuditSiteHealth,
      siteFilterMode: autoSiteFilterMode,
      enrichCnpj: autoEnrichCnpj,
      prioritizePartnerPhone: autoPrioritizePartnerPhone,
      validateWhatsApp: autoValidateWhatsApp,
      excludeMei: autoExcludeMei,
      excludeFranchises: autoExcludeFranchises,
      huntPartnerDirectPhone: autoHuntPartnerDirectPhone,
      expandNeighborhoods: autoExpandNeighborhoods,
      prioritizeByScore: autoPrioritizeByScore,
      minCapitalSocial: autoMinCapitalSocial,
      personalizeWithAi: autoPersonalize,
      antibanMixer: autoAntibanMixer,
    };
    const { state: next, autoNote } = applyScraperFilterChange(current, action, "prospeccao-sites");
    setAutoFilterEmpty(next.filterEmpty);
    setAutoFilterDuplicates(next.filterDuplicates);
    setAutoFilterLandlines(next.filterLandlines);
    setAutoFilterWithWebsite(next.filterWithWebsite);
    setAutoFilterWithInstagram(next.filterWithInstagram);
    setAutoCaptureAllReviews(next.captureAllReviews);
    setAutoReviewsAi(next.reviewsAiEnabled);
    setAutoTurboMode(next.turboMode);
    setAutoFilterClosedBusinesses(next.filterClosedBusinesses);
    setAutoAuditSiteHealth(next.auditSiteHealth);
    setAutoSiteFilterMode(next.siteFilterMode);
    setAutoEnrichCnpj(next.enrichCnpj);
    setAutoPrioritizePartnerPhone(next.prioritizePartnerPhone);
    setAutoValidateWhatsApp(next.validateWhatsApp);
    setAutoExcludeMei(next.excludeMei);
    setAutoExcludeFranchises(next.excludeFranchises);
    setAutoHuntPartnerDirectPhone(next.huntPartnerDirectPhone);
    setAutoPrioritizeByScore(next.prioritizeByScore);
    setAutoMinCapitalSocial(next.minCapitalSocial);
    setAutoPersonalize(Boolean(next.personalizeWithAi));
    setAutoAntibanMixer(next.antibanMixer !== false);
    setAutoSyncNote(autoNote);
    if (action.type === "minCapitalSocial" || action.type === "preset") {
      setAutoExtraFiltersError("");
    }
  }

  return (
    <div className={cn(styles.workspace, "h-full flex flex-col overflow-hidden")}>
      <Header />
      <div className={cn(styles.scrollArea, "flex-1 min-h-0 overflow-y-auto")}>
        <div className={styles.content}>
        <div className={styles.pageHeading}>
          <div>
            <h2>{TAB_CONTEXT[tab].title}</h2>
            <p>{TAB_CONTEXT[tab].description}</p>
          </div>
          <div className={styles.sessionStatus} aria-live="polite">
            {isRunning ? (
              <span className={styles.captureStatus}><span className={styles.statusDot} />{isPaused ? "Captura pausada" : "Captura em andamento"}</span>
            ) : <span><Globe className="size-4" /> Prospecção de sites</span>}
            {selected.size > 0 && <span>{selected.size} lead{selected.size > 1 ? "s" : ""} selecionado{selected.size > 1 ? "s" : ""}</span>}
          </div>
        </div>
        {/* Tabs */}
        <nav aria-label="Etapas da prospecção" className={styles.tabs}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              aria-controls="prospeccao-panel"
              className={styles.tab}
            >
              <t.icon className="w-3.5 h-3.5 inline mr-1.5" />
              {t.label}
              {t.key === "revisao" && selected.size > 0 && (
                <Badge className="ml-1.5 bg-primary/20 text-primary">{selected.size}</Badge>
              )}
              {t.key === "captura" && (isRunning || scraperLeadsCount > 0) && (
                <Badge className={cn("ml-1.5", isRunning ? "bg-green-500/20 text-green-400" : "bg-white/10 text-white/60")}>
                  {isRunning ? "RODANDO" : `${scraperLeadsCount} leads`}
                </Badge>
              )}
            </button>
          ))}
        </nav>

        <section id="prospeccao-panel" aria-label={TABS.find((t) => t.key === tab)?.label} className={styles.panel}>
        {/* TAB CAPTURA */}
        {tab === "captura" && (
          <div className={styles.captureLayout}>
            <Card className="border-white/10 bg-white/[0.02]">
              <CardContent className="p-4 space-y-3">
                <div className={styles.sectionHeading}>
                  <h3><MapPin className="size-4" /> Capturar empresas no Google Maps</h3>
                  <p>Informe um nicho e uma região por linha. Os resultados ficam disponíveis na aba Leads.</p>
                </div>

                <div className={styles.fieldGrid}>
                  <div>
                    <label htmlFor="ps-niches">Nichos (1 por linha)</label>
                    <Textarea id="ps-niches" value={niches} onChange={(e) => setNiches(e.target.value)} rows={3} placeholder={"pizzaria\ndentista\nacademia"} />
                  </div>
                  <div>
                    <label htmlFor="ps-regions">Regiões (1 por linha)</label>
                    <Textarea id="ps-regions" value={regions} onChange={(e) => setRegions(e.target.value)} rows={3} placeholder={"São Paulo SP\nCentro, Belo Horizonte MG"} />
                  </div>
                </div>

                <div className={styles.filterSection}>
                  <div className={styles.subGroup}>
                    <div className={styles.groupHeader}>
                      <Sparkles className="w-4 h-4" />
                      <div>
                        <h4 className={styles.groupTitle}>Perfis rápidos de captura</h4>
                        <p className={styles.groupDesc}>Escolha um perfil pronto para ajustar site, CNPJ e WhatsApp automaticamente.</p>
                      </div>
                    </div>
                    <div className={styles.presetGrid}>
                      {SCRAPER_PRESET_OPTIONS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          aria-label={preset.label}
                          onClick={() => applyCaptureFilterSync({ type: "preset", preset: preset.id })}
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
                    {captureSyncNote && (
                      <div role="status" className={styles.syncBanner}>
                        <span className={styles.syncBannerText}>
                          <Info className="w-4 h-4" />
                          <span>{captureSyncNote}</span>
                        </span>
                      </div>
                    )}
                  </div>

                  <div className={styles.subGroup}>
                    <div className={styles.groupHeader}>
                      <Clock className="w-4 h-4" />
                      <div>
                        <h4 className={styles.groupTitle}>Reputação e tempo no Google Maps</h4>
                        <p className={styles.groupDesc}>Defina quantidade mínima/máxima de avaliações, nota média e ano no Google. Use 0 para desativar.</p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="ps-min-reviews">Mínimo de avaliações no Google</label>
                      <Input id="ps-min-reviews" type="number" min={0} step={1} max={2147483647}
                        value={minReviews} onChange={(e) => { setMinReviews(e.target.value); setMinReviewsError(false); }}
                        aria-invalid={minReviewsError}
                        aria-describedby={`ps-min-reviews-help${minReviewsError ? " ps-min-reviews-error" : ""}`} />
                      <p id="ps-min-reviews-help" className={styles.optionDesc}>{MIN_REVIEWS_HELP}</p>
                      {minReviewsError && <p id="ps-min-reviews-error" role="alert" className="text-xs text-[#fda4af]">{MIN_REVIEWS_ERROR}</p>}
                    </div>
                    <div className="space-y-2 pt-1">
                      <span className={styles.optionTitle}>Está no Google desde (atalho por ano)</span>
                      <div className={styles.segmentedPills}>
                        {[
                          { label: "Qualquer ano", from: "0", to: "0" },
                          { label: "Desde 2019 até hoje", from: "2019", to: String(new Date().getFullYear()) },
                          { label: "Desde 2020 até hoje", from: "2020", to: String(new Date().getFullYear()) },
                          { label: "Desde 2022 até hoje", from: "2022", to: String(new Date().getFullYear()) },
                          { label: "Até 2019", from: "1900", to: "2019" },
                        ].map(preset => (
                          <button
                            key={preset.label}
                            type="button"
                            data-active={googleYearFrom === preset.from && googleYearTo === preset.to ? "true" : undefined}
                            onClick={() => {
                              setGoogleYearFrom(preset.from);
                              setGoogleYearTo(preset.to);
                              setExtraFiltersError("");
                            }}
                            className={styles.pillChoice}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                      <div>
                        <label htmlFor="ps-google-year-from">No Google desde (ano)</label>
                        <Input
                          id="ps-google-year-from"
                          type="number"
                          min={0}
                          max={new Date().getFullYear() + 1}
                          step={1}
                          value={googleYearFrom}
                          onChange={(e) => { setGoogleYearFrom(e.target.value); setExtraFiltersError(""); }}
                          placeholder="Ex: 2019 (0 = todos)"
                        />
                      </div>
                      <div>
                        <label htmlFor="ps-google-year-to">Até o ano (0 = atual)</label>
                        <Input
                          id="ps-google-year-to"
                          type="number"
                          min={0}
                          max={new Date().getFullYear() + 1}
                          step={1}
                          value={googleYearTo}
                          onChange={(e) => { setGoogleYearTo(e.target.value); setExtraFiltersError(""); }}
                          placeholder={`Ex: ${new Date().getFullYear()}`}
                        />
                      </div>
                      <div>
                        <label htmlFor="ps-max-reviews">Máximo de avaliações</label>
                        <Input
                          id="ps-max-reviews"
                          type="number"
                          min={0}
                          max={2147483647}
                          step={1}
                          value={maxReviews}
                          onChange={(e) => { setMaxReviews(e.target.value); setExtraFiltersError(""); }}
                        />
                      </div>
                      <div>
                        <label htmlFor="ps-min-rating">Nota mínima (0 a 5)</label>
                        <Input
                          id="ps-min-rating"
                          type="number"
                          min={0}
                          max={5}
                          step={0.1}
                          value={minRating}
                          onChange={(e) => { setMinRating(e.target.value); setExtraFiltersError(""); }}
                        />
                      </div>
                      <div>
                        <label htmlFor="ps-max-rating">Nota máxima (0 a 5)</label>
                        <Input
                          id="ps-max-rating"
                          type="number"
                          min={0}
                          max={5}
                          step={0.1}
                          value={maxRating}
                          onChange={(e) => { setMaxRating(e.target.value); setExtraFiltersError(""); }}
                        />
                      </div>
                    </div>
                    {extraFiltersError && <p role="alert" className="text-xs text-[#fda4af]">{extraFiltersError}</p>}
                  </div>

                  <div className={styles.subGroup}>
                    <div className={styles.groupHeader}>
                      <Globe className="w-4 h-4" />
                      <div>
                        <h4 className={styles.groupTitle}>Presença digital e saúde do site</h4>
                        <p className={styles.groupDesc}>Separa automaticamente sites reais de links do Instagram/iFood/Linktree e detecta falhas técnicas ou falta de versão celular.</p>
                      </div>
                    </div>
                    <div className={styles.optionList}>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-audit-site" className={styles.optionTitle}>Auditar saúde do site (quebrado, SSL vencido, erro 500 ou fraco)</label>
                          <p id="ps-audit-site-help" className={styles.optionDesc}>Protegido contra falso positivo Cloudflare; gera nota técnica e diagnóstico comercial.</p>
                        </div>
                        <Switch id="ps-audit-site" aria-describedby="ps-audit-site-help" checked={auditSiteHealth} onCheckedChange={(v) => applyCaptureFilterSync({ type: "auditSiteHealth", value: v })} />
                      </div>
                      <div className="py-2 space-y-2 border-t border-[#263028]">
                        <div>
                          <span className={styles.optionTitle}>Filtro por saúde do site:</span>
                          <p className={styles.optionDesc}>Escolher um critério de qualidade ativa a auditoria do site automaticamente.</p>
                        </div>
                        <div className={styles.segmentedPills} role="radiogroup" aria-label="Filtro por saúde do site na captura">
                          {SITE_FILTER_MODE_OPTIONS.map((opt) => {
                            const active = siteFilterMode === opt.value;
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => applyCaptureFilterSync({ type: "siteFilterMode", value: opt.value })}
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
                          <label htmlFor="ps-only-no-site" className={styles.optionTitle}>Capturar somente leads sem site</label>
                          <p id="ps-only-no-site-help" className={styles.optionDesc}>Exige campo Website vazio no Maps e desliga auditoria HTTP.</p>
                        </div>
                        <input
                          id="ps-only-no-site"
                          type="checkbox"
                          aria-describedby="ps-only-no-site-help"
                          checked={filterWithWebsite}
                          onChange={(e) => applyCaptureFilterSync({ type: "filterWithWebsite", value: e.target.checked })}
                          className={styles.toggleInput}
                        />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-filter-with-instagram" className={styles.optionTitle}>Somente com Instagram</label>
                          <p id="ps-filter-with-instagram-help" className={styles.optionDesc}>{INSTAGRAM_FILTER_HELP}</p>
                        </div>
                        <input id="ps-filter-with-instagram" type="checkbox" checked={filterWithInstagram}
                          onChange={(e) => setFilterWithInstagram(e.target.checked)}
                          aria-describedby="ps-filter-with-instagram-help"
                          className={styles.toggleInput} />
                      </div>
                    </div>
                  </div>

                  <div className={styles.subGroup}>
                    <div className={styles.groupHeader}>
                      <ShieldCheck className="w-4 h-4" />
                      <div>
                        <h4 className={styles.groupTitle}>Contato, CNPJ e sócio decisor</h4>
                        <p className={styles.groupDesc}>Higienize telefones, valide WhatsApp na Evolution e consulte dados gratuitos da Receita Federal.</p>
                      </div>
                    </div>
                    <div className={styles.optionList}>
                      {[
                        { id: "ps-filter-empty", label: "Remover leads sem telefone", desc: "Descarta empresas sem número de contato.", value: filterEmpty, set: setFilterEmpty },
                        { id: "ps-filter-dups", label: "Remover telefones duplicados", desc: "Evita duplicidade de números na base.", value: filterDuplicates, set: setFilterDuplicates },
                        { id: "ps-filter-landlines", label: "Remover telefones fixos", desc: "Ignora fixos comuns (mantém fixos com WhatsApp Business ativo se a validação estiver ligada).", value: filterLandlines, set: setFilterLandlines },
                      ].map((f) => (
                        <div key={f.label} className={styles.optionRow}>
                          <div className={styles.optionCopy}>
                            <label htmlFor={f.id} className={styles.optionTitle}>{f.label}</label>
                            <p id={`${f.id}-help`} className={styles.optionDesc}>{f.desc}</p>
                          </div>
                          <input id={f.id} type="checkbox" aria-describedby={`${f.id}-help`} checked={f.value} onChange={(e) => f.set(e.target.checked)} className={styles.toggleInput} />
                        </div>
                      ))}
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-validate-wa" className={styles.optionTitle}>Validar WhatsApp ativo na Evolution (recupera fixos Business)</label>
                          <p id="ps-validate-wa-help" className={styles.optionDesc}>Confirma no chip conectado se o telefone realmente recebe WhatsApp.</p>
                        </div>
                        <Switch id="ps-validate-wa" aria-describedby="ps-validate-wa-help" checked={validateWhatsApp} onCheckedChange={(v) => applyCaptureFilterSync({ type: "validateWhatsApp", value: v })} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-filter-closed" className={styles.optionTitle}>Descartar empresas fechadas ou CNPJ baixado/inapto</label>
                          <p id="ps-filter-closed-help" className={styles.optionDesc}>Rejeita empresas encerradas no Maps ou inativas na Receita Federal.</p>
                        </div>
                        <Switch id="ps-filter-closed" aria-describedby="ps-filter-closed-help" checked={filterClosedBusinesses} onCheckedChange={setFilterClosedBusinesses} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-exclude-franchises" className={styles.optionTitle}>Ignorar grandes redes e franquias</label>
                          <p id="ps-exclude-franchises-help" className={styles.optionDesc}>Descarta redes conhecidas e S/A para focar decisores locais.</p>
                        </div>
                        <Switch id="ps-exclude-franchises" aria-label="Ignorar grandes redes e franquias" aria-describedby="ps-exclude-franchises-help" checked={excludeFranchises} onCheckedChange={setExcludeFranchises} />
                      </div>
                      <div className="py-2.5 border-t border-[#263028]">
                        <div className="flex items-start justify-between gap-4">
                          <div className={styles.optionCopy}>
                            <label htmlFor="ps-enrich-cnpj" className={styles.optionTitle}>Enriquecer CNPJ e Sócio Decisor grátis (Receita + RDAP)</label>
                            <p id="ps-enrich-cnpj-help" className={styles.optionDesc}>Consulta gratuita em cascata (BrasilAPI → OpenCNPJ → MinhaReceita).</p>
                          </div>
                          <Switch id="ps-enrich-cnpj" aria-describedby="ps-enrich-cnpj-help" checked={enrichCnpj} onCheckedChange={(v) => applyCaptureFilterSync({ type: "enrichCnpj", value: v })} />
                        </div>
                        {enrichCnpj && (
                          <div className={styles.nestedPanel}>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                              <div className="flex items-center justify-between gap-3">
                                <label htmlFor="ps-exclude-mei" className={styles.optionTitle}>Ignorar MEI (focar ME, EPP e Ltda)</label>
                                <input id="ps-exclude-mei" type="checkbox" checked={excludeMei} onChange={(e) => applyCaptureFilterSync({ type: "excludeMei", value: e.target.checked })} className={styles.toggleInput} />
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <label htmlFor="ps-min-capital" className={styles.optionTitle}>Capital mínimo (R$)</label>
                                <Input id="ps-min-capital" type="number" min={0} step={1000} value={minCapitalSocial} onChange={(e) => { applyCaptureFilterSync({ type: "minCapitalSocial", value: e.target.value }); }} className="w-28" />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-partner-phone" className={styles.optionTitle}>Priorizar WhatsApp oculto do site / celular do sócio</label>
                          <p id="ps-partner-phone-help" className={styles.optionDesc}>Usa links WhatsApp do site ou telefone direto do administrador quando disponível.</p>
                        </div>
                        <Switch id="ps-partner-phone" aria-describedby="ps-partner-phone-help" checked={prioritizePartnerPhone} onCheckedChange={(v) => applyCaptureFilterSync({ type: "prioritizePartnerPhone", value: v })} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-hunt-partner" className={styles.optionTitle}>Modo Direto no Dono</label>
                          <p id="ps-hunt-partner-help" className={styles.optionDesc}>9º dígito Anatel + WhatsApp Pessoal do sócio vs Recepção.</p>
                        </div>
                        <Switch id="ps-hunt-partner" aria-label="Modo Direto no Dono" aria-describedby="ps-hunt-partner-help" checked={huntPartnerDirectPhone} onCheckedChange={(v) => applyCaptureFilterSync({ type: "huntPartnerDirectPhone", value: v })} />
                      </div>
                    </div>
                  </div>

                  <div className={styles.subGroup}>
                    <div className={styles.groupHeader}>
                      <Zap className="w-4 h-4" />
                      <div>
                        <h4 className={styles.groupTitle}>Velocidade e alcance da busca</h4>
                        <p className={styles.groupDesc}>Controle economia de memória na VPS e subdivisão por bairros em cidades grandes.</p>
                      </div>
                    </div>
                    <div className={styles.optionList}>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-turbo-mode" className={styles.optionTitle}>Modo Turbo VPS (alta velocidade e economia de RAM)</label>
                          <p id="ps-turbo-mode-help" className={styles.optionDesc}>Reutiliza aba, bloqueia mídia pesada e pula duplicados via cache em RAM.</p>
                        </div>
                        <Switch id="ps-turbo-mode" aria-describedby="ps-turbo-mode-help" checked={turboMode} onCheckedChange={(v) => applyCaptureFilterSync({ type: "turboMode", value: v })} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-expand-neighborhoods" className={styles.optionTitle}>Busca profunda por bairros</label>
                          <p id="ps-expand-neighborhoods-help" className={styles.optionDesc}>Subdivide cidades em bairros para furar o teto de 120 leads.</p>
                        </div>
                        <Switch id="ps-expand-neighborhoods" aria-label="Busca profunda por bairros" aria-describedby="ps-expand-neighborhoods-help" checked={expandNeighborhoods} onCheckedChange={setExpandNeighborhoods} />
                      </div>
                    </div>
                  </div>

                  <details className={styles.advancedOptions}>
                    <summary><Bot className="size-4" /> Avaliações completas e análise com IA <ChevronRight className="size-4" /></summary>
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="ps-capture-all-reviews">Capturar todas as avaliações</label>
                      <Switch id="ps-capture-all-reviews" checked={captureAllReviews} onCheckedChange={(v) => applyCaptureFilterSync({ type: "captureAllReviews", value: v })} />
                    </div>
                    <p>Salva os comentários disponíveis no Google Maps. Esta opção pode aumentar o tempo de captura.</p>
                    <div className={styles.optionSection}>
                      <div className="flex items-center justify-between gap-2">
                        <label htmlFor="ps-reviews-ai" className={styles.optionTitle}>Resumir avaliações com IA</label>
                        <Switch id="ps-reviews-ai" checked={reviewsAiEnabled} onCheckedChange={(v) => applyCaptureFilterSync({ type: "reviewsAiEnabled", value: v })} />
                      </div>
                      <p className={styles.optionDesc}>
                        Ativa a captura de comentários e gera um resumo por lead. Use <code>{"{{resumo_avaliacoes}}"}</code> para incluir o resultado na mensagem.
                      </p>
                      {reviewsAiEnabled && (
                        <div className={styles.nestedPanel}>
                          <div>
                            <label>Modelo de IA</label>
                            <select aria-label="Modelo de IA para avaliações" value={reviewsAiModel} onChange={(e) => setReviewsAiModel(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg text-sm">
                              {loadingAiModels && <option value="">Carregando…</option>}
                              {!loadingAiModels && aiModels.length === 0 && <option value="">(sem modelos — admin precisa configurar API key)</option>}
                              <ModelOptions models={aiModels as any} />
                            </select>
                          </div>
                          <div>
                            <label>Prompt (vazio = padrão: ELOGIOS / RECLAMAÇÕES / GANCHO / NOTA GERAL)</label>
                            <Textarea aria-label="Instruções para resumir avaliações" value={reviewsAiPrompt} onChange={(e) => setReviewsAiPrompt(e.target.value)} rows={3}
                              placeholder="Ex: Resuma em tom de vendas, focando dores que um site profissional resolveria…" />
                          </div>
                          <Button onClick={runReviewsAi} disabled={reviewsAiRunning} size="sm" className="w-full">
                            {reviewsAiRunning ? "Analisando…" : `Analisar avaliações (${selected.size > 0 ? selected.size : leads.length} lead${selected.size > 0 ? " selecionado" : ""})`}
                          </Button>
                        </div>
                      )}
                    </div>
                  </details>
                </div>

                <div className={styles.captureLimit}>
                  <label className="flex items-center gap-2">
                    <Switch checked={maxLeads > 0} onCheckedChange={(v) => setMaxLeads(v ? 50 : 0)} />
                    Limite de leads
                  </label>
                  {maxLeads > 0 && (
                    <Input aria-label="Quantidade máxima de leads" type="number" value={maxLeads} onChange={(e) => setMaxLeads(Number(e.target.value))} className="w-24" min={1} max={500} />
                  )}
                  <span>{maxLeads > 0 ? "A captura para ao atingir o limite." : "Sem limite definido."}</span>
                </div>

                <div className="flex gap-2 pt-2">
                  {!isRunning ? (
                    <Button onClick={handleStart} className="flex-1">
                      <Rocket className="w-4 h-4 mr-1" /> Iniciar captura
                    </Button>
                  ) : (
                    <>
                      {!isPaused ? (
                        <Button variant="outline" onClick={() => handleScraperAction("pause")}><Pause className="w-4 h-4 mr-1" /> Pausar</Button>
                      ) : (
                        <Button variant="outline" onClick={() => handleScraperAction("resume")}><Play className="w-4 h-4 mr-1" /> Retomar</Button>
                      )}
                      <Button variant="destructive" onClick={() => handleScraperAction("stop")}><Square className="w-4 h-4 mr-1" /> Parar</Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            <aside className={styles.captureGuide} aria-label="Como funciona a prospecção">
              <h3>Da busca à conversa</h3>
              <p>Comece pela captura. Você revisa os leads e a mensagem antes de criar uma campanha.</p>
              <ol>
                <li><Search className="size-4" /><div><strong>Encontre as empresas</strong><span>Combine nichos e regiões para definir sua busca.</span></div></li>
                <li><CheckCircle2 className="size-4" /><div><strong>Selecione e revise</strong><span>Na aba Leads, o filtro sem site já vem selecionado.</span></div></li>
                <li><Send className="size-4" /><div><strong>Prepare a abordagem</strong><span>Confira as mensagens e configure seu WhatsApp.</span></div></li>
              </ol>
              <div className={styles.guideNote}><Filter className="size-4" /><p>Quer excluir sites já na captura? Ative <strong>Capturar somente leads sem site</strong> nos filtros.</p></div>
              <Button variant="outline" onClick={() => setTab("leads")} className="w-full">Ver leads disponíveis <ChevronRight className="size-4" /></Button>
            </aside>

            {/* Resultado do resumo de avaliações com IA */}
            {reviewsAiResults && (
              <Card>
                <CardContent className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-[#c5f0d8]">
                      Resumo de avaliações (IA) · {reviewsAiResults.filter((r) => r.ok).length}/{reviewsAiResults.length} concluídos
                    </div>
                    <button type="button" onClick={() => setReviewsAiResults(null)} className="text-[#9cab9f] hover:text-[#edf2ee] text-xs cursor-pointer">fechar ✕</button>
                  </div>
                  {reviewsAiResults.map((r) => (
                    <div key={r.lead_id} className={cn("rounded-lg border p-3 text-xs", r.ok ? "border-[#303a32] bg-[#141a16]" : "border-[#663030] bg-[#2d1a1a]")}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-[#edf2ee]">{r.nome_negocio || `Lead #${r.lead_id}`}</span>
                        {r.cached && <span className="px-2 py-0.5 rounded bg-[#1b241e] border border-[#334338] text-[#a5b1a8] text-xs">Cache</span>}
                      </div>
                      {r.ok
                        ? <pre className="whitespace-pre-wrap font-sans text-[#dce7df] leading-relaxed">{r.resumo}</pre>
                        : <span className="text-[#fca5a5]">Erro: {r.error}</span>}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Log panel */}
            {logs.length > 0 && (
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#c4d4c9] mb-2">
                    <Terminal className="w-3.5 h-3.5 text-[#6ee7b7]" /> Histórico de execução
                  </div>
                  <div className="space-y-1 text-xs font-mono max-h-64 overflow-y-auto custom-scrollbar">
                    {logs.map((l, i) => (
                      <div key={i} className={cn(
                        "flex gap-2",
                        l.type === "error" ? "text-red-400" :
                        l.type === "success" ? "text-green-400" :
                        l.type === "warning" ? "text-amber-400" :
                        "text-white/70"
                      )}>
                        <span className="text-white/30 shrink-0">{l.time}</span>
                        <span>{l.message}</span>
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* TAB LEADS */}
        {tab === "leads" && (
          <div className="space-y-3">
            <div className={styles.leadSummary}>
              <span>Na página atual</span>
              <dl>
                <div><dt>Sem site</dt><dd>{stats.withoutW}</dd></div>
                <div><dt>Com site</dt><dd>{stats.withW}</dd></div>
                <div><dt>Nota média</dt><dd>{stats.avgRating}</dd></div>
                <div><dt>Avaliações</dt><dd>{stats.totalReviews.toLocaleString("pt-BR")}</dd></div>
              </dl>
            </div>

            {/* Filters */}
            <Card className="border-white/10 bg-white/[0.02]">
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white/50">
                  <Filter className="w-3.5 h-3.5" /> Filtros
                </div>
                <div className={styles.leadFilters}>
                  <label>Ramo<Input aria-label="Filtrar por ramo" placeholder="Ex.: pizzaria" value={ramoFilter} onChange={(e) => setRamoFilter(e.target.value)} /></label>
                  <label>Região<Input aria-label="Filtrar por região" placeholder="Cidade ou bairro" value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} /></label>
                  <label>Nota mínima<Input aria-label="Nota mínima" placeholder="0 a 5" type="number" step="0.1" min="0" max="5" value={ratingMin} onChange={(e) => setRatingMin(e.target.value)} /></label>
                  <label>Nota máxima<Input aria-label="Nota máxima" placeholder="0 a 5" type="number" step="0.1" min="0" max="5" value={ratingMax} onChange={(e) => setRatingMax(e.target.value)} /></label>
                  <label>Avaliações mínimas<Input aria-label="Mínimo de avaliações dos leads" placeholder="Sem mínimo" type="number" min="0" value={reviewsMin} onChange={(e) => setReviewsMin(e.target.value)} /></label>
                  <label>Avaliações máximas<Input aria-label="Máximo de avaliações dos leads" placeholder="Sem máximo" type="number" min="0" value={reviewsMax} onChange={(e) => setReviewsMax(e.target.value)} /></label>
                  <label>No Google desde (ano)<Input aria-label="No Google desde (ano) nos leads" placeholder="Ex.: 2019" type="number" min="1900" max={new Date().getFullYear() + 1} value={leadYearFrom} onChange={(e) => setLeadYearFrom(e.target.value)} /></label>
                  <label>Até o ano (Google)<Input aria-label="Até o ano no Google nos leads" placeholder={`Ex.: ${new Date().getFullYear()}`} type="number" min="1900" max={new Date().getFullYear() + 1} value={leadYearTo} onChange={(e) => setLeadYearTo(e.target.value)} /></label>
                  <div className={styles.selectField}><span>Presença de site</span><Select value={hasWebsite} onValueChange={(v: string | null) => setHasWebsite((v as any) || "only_empty")}>
                    <SelectTrigger aria-label="Presença de site" className="w-44"><SelectValue placeholder="Presença site">{HAS_WEBSITE_LABELS[hasWebsite] || "Presença site"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="only_empty">Sem site</SelectItem>
                      <SelectItem value="broken_or_empty">Sem site + Quebrado</SelectItem>
                      <SelectItem value="broken_or_weak">Site quebrado / fraco</SelectItem>
                      <SelectItem value="all">Todos os sites</SelectItem>
                      <SelectItem value="only_with">Com site</SelectItem>
                    </SelectContent>
                  </Select></div>
                  <div className={styles.selectField}><span>Canal WhatsApp</span><Select value={channelFilter} onValueChange={(v: string | null) => setChannelFilter((v as any) || "all")}>
                    <SelectTrigger aria-label="Canal WhatsApp" className="w-44"><SelectValue placeholder="Canal WhatsApp">{CHANNEL_FILTER_LABELS[channelFilter] || "Todos os canais"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos os canais</SelectItem>
                      <SelectItem value="owner_direct">Direto no Sócio</SelectItem>
                      <SelectItem value="reception">Recepção / Secretária</SelectItem>
                      <SelectItem value="paid_traffic">Investe em Anúncios</SelectItem>
                    </SelectContent>
                  </Select></div>
                  <div className={styles.selectField}><span>Ordenar por</span><Select value={sort} onValueChange={(v: string | null) => setSort((v as any) || "reviews")}>
                    <SelectTrigger aria-label="Ordenar por" className="w-40"><SelectValue placeholder="Ordenar por">{SORT_LABELS[sort] || "Avaliações"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reviews">Avaliações</SelectItem>
                      <SelectItem value="rating">Nota</SelectItem>
                      <SelectItem value="qualification">Score qualificação</SelectItem>
                      <SelectItem value="created_at">Data captura</SelectItem>
                    </SelectContent>
                  </Select></div>
                  <div className={styles.selectField}><span>Ordem</span><Select value={order} onValueChange={(v: string | null) => setOrder((v as any) || "desc")}>
                    <SelectTrigger aria-label="Ordem" className="w-36"><SelectValue placeholder="Ordem">{ORDER_LABELS[order] || "Maior → menor"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="desc">Maior → menor</SelectItem>
                      <SelectItem value="asc">Menor → maior</SelectItem>
                    </SelectContent>
                  </Select></div>
                </div>
                <div className={styles.filterActions}>
                  <label className="flex items-center gap-2 text-xs text-white/60">
                    <Switch checked={showOptOut} onCheckedChange={setShowOptOut} />
                    Mostrar descadastrados
                  </label>
                  <Button variant="outline" size="sm" onClick={() => { setPage(0); fetchLeads(); }}>
                    <Search className="w-3.5 h-3.5 mr-1" /> Aplicar
                  </Button>
                  <div className="ml-auto text-xs text-white/40">
                    {rankedLeads.length} / {total}
                  </div>
                </div>

                {/* Disparo Status Segmented Control */}
                <div className={styles.dispatchFilters}>
                  <span>Status do disparo</span>
                  <div className={styles.segmented} role="group" aria-label="Status do disparo">
                    <Button variant="ghost" size="sm" aria-pressed={disparoFilter === "all"} onClick={() => setDisparoFilter("all")}>Todos</Button>
                    <Button variant="ghost" size="sm" aria-pressed={disparoFilter === "pending"} onClick={() => setDisparoFilter("pending")}><Send className="size-3.5" /> Pendentes</Button>
                    <Button variant="ghost" size="sm" aria-pressed={disparoFilter === "sent"} onClick={() => setDisparoFilter("sent")}><CheckCircle2 className="size-3.5" /> Disparados</Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Selecionar todos + deletar */}
            <div className="flex justify-between items-center text-xs text-white/60 gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={selectAllVisible}>
                  {selected.size === rankedLeads.length && rankedLeads.length > 0 ? "Limpar seleção" : "Selecionar todos"}
                </Button>
                {selected.size > 0 && (
                  <Button variant="destructive" size="sm" onClick={() => deleteLeads(Array.from(selected.keys()))} className="gap-1">
                    <Trash2 className="w-3.5 h-3.5" /> Deletar {selected.size} selecionado{selected.size > 1 ? "s" : ""}
                  </Button>
                )}
              </div>
              <span>{selected.size} selecionados · ordenado por {sort === "reviews" ? "avaliações" : sort === "rating" ? "nota" : sort === "qualification" ? "score qualificação" : "data captura"}</span>
            </div>

            {/* Table */}
            <Card className={styles.listPanel}>
              <div className={styles.listHeading}>
                <h3>Empresas encontradas</h3>
                <span>{rankedLeads.length} nesta página · {total} no total</span>
              </div>
              <CardContent className={styles.tableScroll} tabIndex={0} role="region" aria-label="Tabela de leads; role horizontalmente para ver todas as colunas">
                {loadingLeads ? (
                  <div className="p-8 text-center text-white/40"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Carregando…</div>
                ) : rankedLeads.length === 0 ? (
                  <div className={styles.emptyState}>
                    <Search className="size-6" />
                    <h3>Nenhuma empresa com esses filtros</h3>
                    <p>Ajuste a busca ou capture novas empresas por nicho e região.</p>
                    <Button variant="outline" onClick={() => setTab("captura")}>Capturar empresas</Button>
                  </div>
                ) : (
                  <table className={styles.leadsTable}>
                    <thead className="bg-white/[0.03] text-white/50 uppercase tracking-wider">
                      <tr>
                        <th className="p-2 text-left w-8"><input aria-label="Selecionar todos os leads da página" type="checkbox" checked={selected.size === rankedLeads.length && rankedLeads.length > 0} onChange={selectAllVisible} /></th>
                        <th className="p-2 text-left">#</th>
                        <th className="p-2 text-left">Negócio</th>
                        <th className="p-2 text-left">Ramo</th>
                        <th className="p-2 text-left">Telefone</th>
                        <th className="p-2 text-left">Nota</th>
                        <th className="p-2 text-left">Avaliações</th>
                        <th className="p-2 text-left">Site</th>
                        <th className="p-2 text-left">Disparo</th>
                        <th className="p-2 text-left">Prévia IA</th>
                        <th className="p-2 text-left">Maps</th>
                        <th className="p-2 text-left">Descadastro</th>
                        <th className="p-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rankedLeads.map((l, idx) => {
                        const hasW = !!(l.website && l.website.trim());
                        const mUrl = mapsUrlFor(l);
                        return (
                          <tr key={l.id} className={cn("border-t border-white/5 hover:bg-white/[0.03]", selected.has(l.id) && "bg-primary/[0.05]")}>
                            <td className="p-2"><input aria-label={`Selecionar ${l.nome_negocio || l.telefone || "lead"}`} type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l)} /></td>
                            <td className="p-2 text-white/30 font-mono">{idx + 1}</td>
                            <td className="p-2 font-bold text-white">
                              <div className="flex items-center gap-1.5">
                                <Building2 className="w-3.5 h-3.5 text-white/40 shrink-0" />
                                <a
                                  href={mUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 hover:text-blue-400 group/link transition-colors"
                                  title="Abrir no Google Maps"
                                >
                                  <span className="hover:underline">{l.nome_negocio || "—"}</span>
                                  <ExternalLink className="w-3.5 h-3.5 text-blue-400 shrink-0 opacity-80 group-hover/link:opacity-100 group-hover/link:translate-x-0.5 transition-all" />
                                </a>
                              </div>
                              {(l.enrichment || l.owner_name) && (
                                <div className="flex flex-wrap gap-1.5 mt-1 font-normal">
                                  {l.enrichment?.qualificationScore != null && (
                                    <Badge variant="outline" className="text-xs px-2 py-0 text-[#c5f0d8] border-[#355844] bg-[#18281f]">
                                      Score {l.enrichment.qualificationScore}
                                    </Badge>
                                  )}
                                  {(l.enrichment?.primeiroNomeSocio || l.enrichment?.socioDecisor || l.owner_name) && (
                                    <Badge variant="outline" className="text-xs px-2 py-0 text-[#c5f0d8] border-[#355844] bg-[#18281f]">
                                      Sócio: {l.enrichment?.primeiroNomeSocio || l.enrichment?.socioDecisor || l.owner_name}
                                    </Badge>
                                  )}
                                  {l.enrichment?.porte && (
                                    <Badge variant="outline" className="text-xs px-2 py-0 text-[#dce7df] border-[#334338] bg-[#1b241e]">
                                      {l.enrichment.porte}
                                    </Badge>
                                  )}
                                  {(l.enrichment?.whatsappChannelType === "socio_direto" || l.enrichment?.whatsappChannelType === "provavel_socio") && (
                                    <Badge variant="outline" className="text-xs px-2 py-0 text-[#c5f0d8] border-[#355844] bg-[#18281f]">
                                      Direto Sócio
                                    </Badge>
                                  )}
                                  {l.enrichment?.whatsappChannelType === "recepcao_comercial" && (
                                    <Badge variant="outline" className="text-xs px-2 py-0 text-[#fde68a] border-[#614d23] bg-[#2c2516]">
                                      Recepção
                                    </Badge>
                                  )}
                                  {l.enrichment?.hasPaidTrafficTag && (
                                    <Badge variant="outline" className="text-xs px-2 py-0 text-[#dce7df] border-[#334338] bg-[#1b241e]" title={l.enrichment.trafficTags?.join(", ") || "Investe em tráfego pago"}>
                                      Ads
                                    </Badge>
                                  )}
                                  {l.enrichment?.managementTools && l.enrichment.managementTools.length > 0 && (
                                    <Badge variant="outline" className="text-xs px-2 py-0 text-[#dce7df] border-[#334338] bg-[#1b241e]" title={l.enrichment.managementTools.join(", ")}>
                                      Sistemas: {l.enrichment.managementTools.slice(0, 2).join(", ")}
                                    </Badge>
                                  )}
                                  {l.enrichment?.abandonedCopyrightYear && (
                                    <Badge variant="outline" className="text-xs px-2 py-0 text-[#dce7df] border-[#334338] bg-[#1b241e]" title={`Rodapé desatualizado (${l.enrichment.abandonedCopyrightYear})`}>
                                      © {l.enrichment.abandonedCopyrightYear}
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="p-2">{l.ramo_negocio || "—"}</td>
                            <td className="p-2 font-mono text-[#a5f3cf]">{l.telefone || l.remoteJid.split("@")[0]}</td>
                            <td className="p-2">
                              {l.rating && (
                                <span className="inline-flex items-center gap-1">
                                  <Star className="w-3 h-3 text-[#eab308] fill-[#eab308]" />{l.rating}
                                </span>
                              )}
                            </td>
                            <td className="p-2 font-bold">
                              <span className="inline-flex items-center gap-1">
                                <TrendingUp className="w-3 h-3 text-[#9ce9bc]" />{parseInt(l.reviews || "0", 10).toLocaleString("pt-BR")}
                              </span>
                              {l.year_established && (
                                <span className="block text-xs font-medium text-[#9ce9bc] mt-0.5">
                                  Desde {l.year_established}
                                </span>
                              )}
                            </td>
                            <td className="p-2">
                              {l.enrichment?.siteHealth === "broken_site" ? (
                                <Badge variant="outline" className="text-[#fca5a5] border-[#663030] bg-[#2d1a1a]" title={l.enrichment.siteDiagnostico || "Site fora do ar ou quebrado"}>
                                  Quebrado
                                </Badge>
                              ) : l.enrichment?.siteHealth === "weak_site" ? (
                                <Badge variant="outline" className="text-[#fde68a] border-[#614d23] bg-[#2c2516]" title={l.enrichment.siteDiagnostico || "Site fraco / sem SSL"}>
                                  Fraco
                                </Badge>
                              ) : hasW ? (
                                <Badge variant="outline" className="text-[#dce7df] border-[#334338] bg-[#1b241e]">
                                  <Link2 className="w-3 h-3 mr-1" />tem
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[#fca5a5] border-[#663030] bg-[#2d1a1a]">
                                  <Link2Off className="w-3 h-3 mr-1" />sem
                                </Badge>
                              )}
                            </td>
                            <td className="p-2">
                              {(l.primeiro_contato_source === "disparo" || disparoJids.has(l.remoteJid)) ? (
                                <Badge variant="outline" className="text-[#dce7df] border-[#334338] bg-[#1b241e]" title={l.primeiro_contato_at ? `Disparado em ${new Date(l.primeiro_contato_at).toLocaleDateString("pt-BR")}` : "Já recebeu disparo"}>
                                  <Send className="w-3 h-3 mr-1" />Enviado
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[#dce7df] border-[#334338] bg-[#1b241e]">
                                  <Clock className="w-3 h-3 mr-1" />Pendente
                                </Badge>
                              )}
                            </td>
                            <td className="p-2">
                              {l.previa_status === "REUNIAO_AGENDADA" ? (
                                <Badge variant="outline" className="text-[#c5f0d8] border-[#355844] bg-[#18281f] gap-1" title={l.reuniao_horario_confirmado ? `Reunião: ${l.reuniao_horario_confirmado}` : "Reunião agendada"}>
                                  <CheckCircle2 className="w-3 h-3 text-[#6ee7b7]" />
                                  Reunião Marcada
                                </Badge>
                              ) : l.previa_status === "PREVIA_PRONTA" && l.link_previa ? (
                                <a href={l.link_previa} target="_blank" rel="noopener noreferrer" title={`Nota QA: ${l.previa_qa_score || 85}/100`}>
                                  <Badge variant="outline" className="text-[#c5f0d8] border-[#355844] bg-[#18281f] hover:bg-[#243d30] gap-1 transition-colors">
                                    <Globe className="w-3 h-3 text-[#6ee7b7]" />
                                    Ver Site {l.previa_qa_score ? `(${l.previa_qa_score})` : ""}
                                    <ExternalLink className="w-2.5 h-2.5 opacity-70" />
                                  </Badge>
                                </a>
                              ) : ["GERANDO_WORKSPACE", "EXECUTANDO_OPENCODE", "FAZENDO_DEPLOY", "INSPECIONANDO_QA"].includes(l.previa_status || "") ? (
                                <Badge variant="outline" className="text-blue-300 border-blue-500/40 bg-blue-500/10 gap-1 animate-pulse">
                                  <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
                                  {l.previa_status === "GERANDO_WORKSPACE" ? "Fotos Maps..." :
                                   l.previa_status === "EXECUTANDO_OPENCODE" ? "OpenCode..." :
                                   l.previa_status === "FAZENDO_DEPLOY" ? "Deploy Vercel..." : "Auditoria QA..."}
                                </Badge>
                              ) : l.previa_status === "PREVIA_SOLICITADA" ? (
                                <Badge variant="outline" className="text-amber-300 border-amber-500/40 bg-amber-500/10 gap-1 animate-pulse">
                                  <Clock className="w-3 h-3 text-amber-400" />
                                  Na Fila VPS
                                </Badge>
                              ) : l.previa_status === "PREVIA_FALHOU" ? (
                                <Badge variant="outline" className="text-red-400 border-red-500/30 bg-red-500/5 gap-1" title={l.previa_error || "Falha na geração"}>
                                  <XCircle className="w-3 h-3" />
                                  Falhou
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-[11px] text-white/40 border-white/10 bg-white/5 gap-1"
                                  title="Este módulo apenas envia o disparo. A geração de site fica no Site Studio."
                                >
                                  <Send className="w-3 h-3" />
                                  Somente disparo
                                </Badge>
                              )}
                            </td>
                            <td className="p-2">
                              <a href={mUrl} target="_blank" rel="noopener noreferrer" title="Abrir no Google Maps">
                                <Badge variant="outline" className="text-blue-400 border-blue-500/30 cursor-pointer hover:bg-blue-500/10 gap-1">
                                  <MapPin className="w-3 h-3" />Maps <ExternalLink className="w-2.5 h-2.5 opacity-70" />
                                </Badge>
                              </a>
                            </td>
                            <td className="p-2">
                              {l.opt_out ? (
                                <Badge variant="outline" className="text-red-400 border-red-500/30"><Ban className="w-3 h-3 mr-1" />opt-out</Badge>
                              ) : (
                                <Button variant="ghost" size="sm" onClick={() => markOptOut(l)} aria-label={`Marcar descadastro de ${l.nome_negocio || "lead"}`} title="Marcar descadastro">
                                  <Ban className="w-3 h-3" />
                                </Button>
                              )}
                            </td>
                            <td className="p-2">
                              <div className="flex items-center gap-1">
                                <a href={mUrl} target="_blank" rel="noopener noreferrer" aria-label={`Ver ${l.nome_negocio || "empresa"} no Google Maps`} className={styles.rowLink}>
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => deleteLeads([l.id])} aria-label={`Deletar ${l.nome_negocio || "lead"}`} title="Deletar lead">
                                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {total > limit && (
              <div className="flex justify-between items-center">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</Button>
                <span className="text-xs text-white/50">Página {page + 1} / {Math.ceil(total / limit)}</span>
                <Button variant="outline" size="sm" disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)}>Próxima</Button>
              </div>
            )}

            {selected.size > 0 && (
              <div className="sticky bottom-3">
                <Button onClick={() => setTab("revisao")} className="w-full py-3">
                  Revisar {selected.size} leads →
                </Button>
              </div>
            )}
          </div>
        )}

        {/* TAB REVISÃO */}
        {tab === "revisao" && (
          <div className="space-y-3">
            {selected.size === 0 ? (
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-8 text-center text-white/40">
                Nenhum lead selecionado. Volte pra aba Leads.
                <div className="mt-3"><Button variant="outline" onClick={() => setTab("leads")}>← Leads</Button></div>
              </CardContent></Card>
            ) : (
              <>
                <Card><CardContent className="p-4 space-y-4">
                  <div className={styles.groupHeader}>
                    <div>
                      <h4 className={styles.groupTitle}>Mensagem-base da campanha</h4>
                      <p className={styles.groupDesc}>Clique em qualquer variável abaixo para inserir no texto automaticamente.</p>
                    </div>
                  </div>
                  <div className={styles.varCategoryBox}>
                    {[
                      {
                        cat: "Empresa e contato",
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
                          { key: "telefone", label: "Telefone", hint: "Número limpo" },
                          { key: "vendedor", label: "Vendedor", hint: "Nome do vendedor preenchido abaixo" },
                        ],
                      },
                      {
                        cat: "Site e reputação no Google",
                        vars: [
                          { key: "website", label: "Website", hint: "Site do lead" },
                          { key: "avaliacao", label: "Avaliação", hint: "Nota Google (1-5)" },
                          { key: "reviews", label: "Reviews", hint: "Qtd. de reviews" },
                          { key: "resumo_avaliacoes", label: "Resumo aval.", hint: "Resumo IA das avaliações do Google (reviews-ai)" },
                          { key: "diagnostico_site", label: "Diagnóstico Site", hint: "Diagnóstico técnico do site" },
                        ],
                      },
                      {
                        cat: "Dados do CNPJ e sócio decisor",
                        vars: [
                          { key: "primeiro_nome_socio", label: "1º Nome Sócio", hint: "Primeiro nome do sócio-administrador" },
                          { key: "nome_socio", label: "Sócio Decisor", hint: "Nome completo do sócio-administrador (Receita)" },
                          { key: "porte_receita", label: "Porte Receita", hint: "MEI / ME / EPP / Ltda" },
                          { key: "anos_empresa", label: "Anos CNPJ", hint: "Idade da empresa em anos" },
                          { key: "abertura_inteligente", label: "Abertura Inteligente", hint: "Abordagem adaptada para Sócio Direto vs Recepção" },
                          { key: "canal_whatsapp", label: "Canal WhatsApp", hint: "WhatsApp direto do sócio ou Recepção" },
                        ],
                      },
                    ].map((group) => (
                      <div key={group.cat} className={styles.varCategoryRow}>
                        <span className={styles.varCategoryTitle}>{group.cat}</span>
                        <div className="flex flex-wrap gap-1.5">
                          {group.vars.map((v) => (
                            <button
                              key={v.key}
                              type="button"
                              title={v.hint}
                              onClick={() => setTemplate((template || "") + `{{${v.key}}}`)}
                              className={styles.varChip}
                            >
                              <span className="font-medium text-[#edf2ee]">{v.label}</span>
                              <code>{`{{${v.key}}}`}</code>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-[#a5b1a8]">Modelos prontos:</span>
                    <button
                      type="button"
                      onClick={() => setTemplate(MENTOR_2STEP_TEMPLATE)}
                      className={styles.pillChoice}
                    >
                      Abridor 2-Step (Mentor)
                    </button>
                    <button
                      type="button"
                      onClick={() => setTemplate(MENTOR_VIDEO_PRAISE_TEMPLATE)}
                      className={styles.pillChoice}
                    >
                      Abridor Vídeo (Nota Google + Site/Insta)
                    </button>
                  </div>
                  <Textarea aria-label="Mensagem-base da campanha" value={template} onChange={(e) => setTemplate(e.target.value)} rows={5} className="text-sm font-mono" />
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs text-[#a5b1a8]">Vendedor:</span>
                    <Input aria-label="Nome do vendedor" value={vendedor} onChange={(e) => setVendedor(e.target.value)} className="w-52" />
                  </div>
                </CardContent></Card>

                <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3 space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-white/50">Filtros de envio</div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <Input aria-label="Nota mínima" placeholder="Nota mín (0-5)" type="number" step="0.1" min="0" max="5" value={ratingMin} onChange={(e) => setRatingMin(e.target.value)} className="w-28" />
                    <Input aria-label="Mínimo de avaliações dos leads" placeholder="Avaliações mín" type="number" min="0" value={reviewsMin} onChange={(e) => setReviewsMin(e.target.value)} className="w-32" />
                    <Select value={sort} onValueChange={(v: string | null) => setSort((v as any) || "reviews")}>
                      <SelectTrigger aria-label="Ordenar por" className="w-40"><SelectValue placeholder="Ordenar por">{SORT_LABELS[sort] || "Avaliações"}</SelectValue></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="reviews">Avaliações</SelectItem>
                        <SelectItem value="rating">Nota</SelectItem>
                        <SelectItem value="qualification">Score qualificação</SelectItem>
                        <SelectItem value="created_at">Data captura</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={order} onValueChange={(v: string | null) => setOrder((v as any) || "desc")}>
                      <SelectTrigger aria-label="Ordem" className="w-40"><SelectValue placeholder="Ordem">{ORDER_LABELS[order] || "Maior → menor"}</SelectValue></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="desc">Maior → menor</SelectItem>
                        <SelectItem value="asc">Menor → maior</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="text-xs text-white/40">
                    {rankedLeads.length} leads elegíveis após filtros · {selected.size} selecionados
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setSelected(new Map(rankedLeads.map((l) => [l.id, l]))); }}>
                      Selecionar elegíveis ({rankedLeads.length})
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setSelected(new Map())}>
                      Limpar seleção
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setSpintaxSeed((s) => s + 1)} title="Sortear nova variação para blocos Spintax {op1|op2}">
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                      Sortear variação
                    </Button>
                  </div>
                </CardContent></Card>

                <div className="space-y-2">
                  {Array.from(selected.values()).map((lead) => (
                    <Card key={lead.id} className="border-white/10 bg-white/[0.02]"><CardContent className="p-3">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="font-bold text-white text-sm flex items-center gap-1.5">
                            <a
                              href={mapsUrlFor(lead)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 hover:text-blue-400 group/link transition-colors"
                              title="Abrir no Google Maps"
                            >
                              <span className="hover:underline">{lead.nome_negocio || "—"}</span>
                              <ExternalLink className="w-3.5 h-3.5 text-blue-400 shrink-0 opacity-80 group-hover/link:opacity-100" />
                            </a>
                          </div>
                          <div className="text-xs text-white/50">
                            {lead.ramo_negocio} · {lead.telefone || lead.remoteJid.split("@")[0]} · {lead.rating || "—"} ★ ({lead.reviews || "0"})
                          </div>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => toggleSelect(lead)} aria-label={`Remover ${lead.nome_negocio || "lead"} da seleção`}>
                          <XCircle className="w-3.5 h-3.5 text-red-400" />
                        </Button>
                      </div>
                      <div className="text-xs bg-black/40 p-2 rounded font-mono whitespace-pre-wrap text-white/80">
                        {previewFor(lead)}
                      </div>
                    </CardContent></Card>
                  ))}
                </div>

                <Button onClick={() => setTab("disparo")} className="w-full py-3">Configurar disparo →</Button>
              </>
            )}
          </div>
        )}

        {/* TAB DISPARO */}
        {tab === "disparo" && (
          <div className={cn(styles.campaignForm, "space-y-3")}>
            {selected.size === 0 ? (
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-8 text-center text-white/40">
                Selecione leads na aba Leads primeiro.
                <div className="mt-3"><Button variant="outline" onClick={() => setTab("leads")}>← Leads</Button></div>
              </CardContent></Card>
            ) : (
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-4 space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-white/50">Nova campanha de prospecção</div>
                <div>
                  <label htmlFor="ps-campaign-name" className="text-xs text-white/60">Nome da campanha</label>
                  <Input id="ps-campaign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Pizzarias SP sem site — Agosto" />
                </div>
                <div>
                  <label className="text-xs text-white/60">Instância WhatsApp</label>
                  <Select value={instanceName} onValueChange={(v: string | null) => setInstanceName(v || "")}>
                    <SelectTrigger aria-label="Instância WhatsApp" className="w-full"><SelectValue placeholder="Selecione…">{instanceName ? formatInstanceLabel(instanceName) : "Selecione…"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {instances.map((i) => (
                        <SelectItem key={i.instance_name} value={i.instance_name}>
                          {i.instance_name}{i.status ? ` — ${i.status}` : ""}
                        </SelectItem>
                      ))}
                      {instances.length >= 1 && (
                        <SelectItem key={AUTO_POOL_INSTANCE} value={AUTO_POOL_INSTANCE}>
                          ⚡ Pool Automático (alternar entre chips saudáveis)
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-white/60">Intervalo mín (s)</label>
                    <Input aria-label="Intervalo mínimo entre envios em segundos" type="number" value={minSec} onChange={(e) => setMinSec(Number(e.target.value))} /></div>
                  <div><label className="text-xs text-white/60">Intervalo máx (s)</label>
                    <Input aria-label="Intervalo máximo entre envios em segundos" type="number" value={maxSec} onChange={(e) => setMaxSec(Number(e.target.value))} /></div>
                  <div><label className="text-xs text-white/60">Hora inicial</label>
                    <Input aria-label="Hora inicial dos envios" type="number" value={startHour} onChange={(e) => setStartHour(Number(e.target.value))} min={0} max={23} /></div>
                  <div><label className="text-xs text-white/60">Hora final</label>
                    <Input aria-label="Hora final dos envios" type="number" value={endHour} onChange={(e) => setEndHour(Number(e.target.value))} min={0} max={23} /></div>
                </div>

                <div className={styles.subGroup}>
                  <div className={styles.groupHeader}>
                    <Bot className="w-4 h-4" />
                    <div>
                      <h4 className={styles.groupTitle}>Personalização e proteção anti-banimento</h4>
                      <p className={styles.groupDesc}>Defina se cada lead receberá variação com IA, mensagens picotadas ou proteção comercial.</p>
                    </div>
                  </div>
                  <div className={styles.optionList}>
                    <div className="py-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-disparo-ai" className={styles.optionTitle}>Reescrever cada mensagem com IA</label>
                          <p className={styles.optionDesc}>Personaliza e varia o texto por lead para reduzir banimento (igual à Automação).</p>
                        </div>
                        <Switch id="ps-disparo-ai" aria-label="Reescrever cada mensagem com IA" checked={personalizeWithAi} onCheckedChange={(v) => applyDisparoFilterSync({ type: "personalizeWithAi", value: v })} />
                      </div>
                      {personalizeWithAi && (
                        <div className={styles.nestedPanel}>
                          <div>
                            <label>Modelo de IA</label>
                            <select aria-label="Modelo de IA para mensagens" value={aiModel} onChange={(e) => setAiModel(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg text-sm">
                              {loadingAiModels && <option value="">Carregando…</option>}
                              {!loadingAiModels && aiModels.length === 0 && <option value="">(sem modelos — admin precisa configurar API key)</option>}
                              <ModelOptions models={aiModels as any} />
                            </select>
                          </div>
                          <div>
                            <label>Prompt de reescrita</label>
                            <Textarea aria-label="Instruções para reescrever mensagens" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} rows={4} placeholder="Ex: Reescreva a mensagem a seguir de forma natural, variação conversacional, mantenha os dados do lead mas evite linguagem padrão. Não use emojis." />
                          </div>
                        </div>
                      )}
                    </div>

                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="ps-disparo-humanize" className={styles.optionTitle}>Humanizar Mensagens (Picotar)</label>
                        <p className={styles.optionDesc}>Divide a mensagem em partes menores e simula tempo de digitação entre elas.</p>
                      </div>
                      <Switch id="ps-disparo-humanize" aria-label="Humanizar mensagens" checked={humanizeMessages} onCheckedChange={setHumanizeMessages} />
                    </div>

                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="ps-disparo-mixer" className={styles.optionTitle}>Misturador Anti-Ban (Variação de Abordagem)</label>
                        <p className={styles.optionDesc}>Alterna variações naturais de saudação e limpa sufixos do Maps no nome da empresa.</p>
                      </div>
                      <Switch id="ps-disparo-mixer" aria-label="Misturador Anti-Ban" checked={antibanMixer} onCheckedChange={(v) => applyDisparoFilterSync({ type: "antibanMixer", value: v })} />
                    </div>

                    <div className="py-2 space-y-2">
                      <div className={styles.optionCopy}>
                        <span id="ps-disparo-weekend-label" className={styles.optionTitle}>Modo Comercial B2B (Proteção Fim de Semana)</span>
                        <p className={styles.optionDesc}>Pausa disparos frios aos domingos; sábado pode operar em 100% ou 50%.</p>
                      </div>
                      <div className={styles.segmentedPills} role="group" aria-labelledby="ps-disparo-weekend-label">
                        <button
                          type="button"
                          data-active={!weekendGuard ? "true" : undefined}
                          aria-pressed={!weekendGuard}
                          onClick={() => setWeekendGuard(false)}
                          className={styles.pillChoice}
                        >
                          Desligado
                        </button>
                        <button
                          type="button"
                          data-active={weekendGuard === "sunday_only" ? "true" : undefined}
                          aria-pressed={weekendGuard === "sunday_only"}
                          onClick={() => setWeekendGuard("sunday_only")}
                          className={styles.pillChoice}
                        >
                          Pausar só Domingo (Sábado 100%)
                        </button>
                        <button
                          type="button"
                          data-active={weekendGuard === "full" || weekendGuard === true ? "true" : undefined}
                          aria-pressed={weekendGuard === "full" || weekendGuard === true}
                          onClick={() => setWeekendGuard("full")}
                          className={styles.pillChoice}
                        >
                          Domingo + 50% Sábado
                        </button>
                      </div>
                    </div>

                    <div className={styles.optionRow}>
                      <div className={styles.optionCopy}>
                        <label htmlFor="ps-disparo-cold-shield" className={styles.optionTitle}>Proteção Anti-Ban (cotas do chip e descanso de 15 min)</label>
                        <p className={styles.optionDesc}>Ligada: respeita o teto por hora/dia do chip e pausa 15 min quando o teto é atingido. Desligada: esta campanha ignora cotas, berçário, quarentena e pausas automáticas — dispara no ritmo configurado. Aumenta o risco de bloqueio.</p>
                      </div>
                      <Switch id="ps-disparo-cold-shield" aria-label="Proteção Anti-Ban" checked={coldShield} onCheckedChange={setColdShield} />
                    </div>
                  </div>
                  {disparoSyncNote && (
                    <div role="status" className={styles.syncBanner}>
                      <span className={styles.syncBannerText}>
                        <Info className="w-4 h-4" />
                        <span>{disparoSyncNote}</span>
                      </span>
                    </div>
                  )}
                </div>
                <div className="text-xs text-white/50">
                  <Globe className="w-3.5 h-3.5 inline mr-1" /> {selected.size} leads selecionados
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setTab("revisao")}>← Voltar</Button>
                  <Button onClick={createCampaign} disabled={creating} className="flex-1">
                    {creating ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                    Criar campanha
                  </Button>
                </div>
              </CardContent></Card>
            )}
          </div>
        )}

        {/* TAB HISTÓRICO */}
        {tab === "historico" && (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <div className="text-xs font-bold uppercase tracking-wider text-white/50">Campanhas de prospecção</div>
              <Button variant="ghost" size="sm" onClick={() => loadCampaigns(false)}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Atualizar</Button>
            </div>
            {loadingCampaigns ? (
              <div className="p-8 text-center text-white/40"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
            ) : campaigns.length === 0 ? (
              <Card><CardContent className={styles.emptyState}>
                <Send className="size-6" />
                <h3>Sua primeira campanha começa pelos leads</h3>
                <p>Selecione empresas, revise a mensagem e configure o envio. As campanhas aparecerão aqui.</p>
                <Button variant="outline" onClick={() => setTab("leads")}>Selecionar leads</Button>
              </CardContent></Card>
            ) : (
              <div className="grid gap-3">
                {campaigns.map((c) => {
                  const total_sent = (c.sent_count || 0) + (c.failed_count || 0) + (c.skipped_count || 0);
                  const pct = c.total_targets > 0 ? Math.round((total_sent / c.total_targets) * 100) : 0;
                  return (
                    <Card key={c.id} className="border-white/10 bg-white/[0.02]"><CardContent className="p-4 space-y-2">
                      <div className="flex justify-between items-start">
                        <div className="min-w-0">
                          <div className="font-bold text-white truncate">{c.name}</div>
                          <div className="text-[10px] text-white/50 uppercase tracking-wider flex items-center gap-2 flex-wrap">
                            <Smartphone className="w-3 h-3" /> {formatInstanceLabel(c.instance_name)}
                            <span className="opacity-30">·</span>
                            <Clock className="w-3 h-3" /> {c.allowed_start_hour}h-{c.allowed_end_hour}h
                            <span className="opacity-30">·</span>
                            jitter {c.min_interval_seconds}-{c.max_interval_seconds}s
                          </div>
                        </div>
                        <Badge variant="outline" className={cn(
                          "text-xs font-medium",
                          c.status === "running" ? "bg-[#243d30] text-[#a5f3cf] border-[#4e7c62]" :
                          c.status === "paused" ? "bg-[#2c2516] text-[#fde68a] border-[#614d23]" :
                          c.status === "done" ? "bg-[#18281f] text-[#c5f0d8] border-[#355844]" :
                          "bg-[#141a16] text-[#b5c4b9] border-[#303a32]"
                        )}>{({ draft: "Rascunho", running: "Em execução", paused: "Pausada", done: "Concluída", cancelled: "Cancelada", stopped: "Interrompida", error: "Erro" } as Record<string, string>)[c.status] || c.status}</Badge>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div className="bg-[#141a16] border border-[#2b362e] p-2.5 rounded-lg"><div className="text-[#a5b1a8]">Alvos</div><div className="text-[#edf2ee] font-semibold mt-0.5">{c.total_targets}</div></div>
                        <div className="bg-[#141a16] border border-[#2b362e] p-2.5 rounded-lg"><div className="text-[#9ce9bc]">Enviados</div><div className="text-[#a5f3cf] font-semibold mt-0.5">{c.sent_count}</div></div>
                        <div className="bg-[#141a16] border border-[#2b362e] p-2.5 rounded-lg"><div className="text-[#fca5a5]">Falhas</div><div className="text-[#fecaca] font-semibold mt-0.5">{c.failed_count}</div></div>
                        <div className="bg-[#141a16] border border-[#2b362e] p-2.5 rounded-lg"><div className="text-[#fde68a]">Pulados</div><div className="text-[#fef3c7] font-semibold mt-0.5">{c.skipped_count || 0}</div></div>
                      </div>

                      <div className="w-full h-1.5 bg-[#141a16] rounded-full overflow-hidden">
                        <div className="h-full bg-[#6ee7b7] transition-all" style={{ width: `${pct}%` }} />
                      </div>

                      {/* Countdown timer + live log */}
                      {c.status === "running" && (
                        <>
                          <CountdownCard cd={countdowns[c.id]} />

                          {latestLogByCampaign[c.id] && (
                            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-[#18281f] border border-[#355844]">
                              <span className="inline-block w-2 h-2 rounded-full bg-[#6ee7b7] mt-1.5 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium text-[#9ce9bc]">
                                  Agora · {new Date(latestLogByCampaign[c.id].created_at).toLocaleTimeString()}
                                </p>
                                <p className={cn(
                                  "text-xs break-words mt-0.5 whitespace-pre-wrap",
                                  latestLogByCampaign[c.id].level === "error" ? "text-[#fca5a5]"
                                  : latestLogByCampaign[c.id].level === "warning" ? "text-[#fde68a]"
                                  : latestLogByCampaign[c.id].level === "success" ? "text-[#c5f0d8]"
                                  : "text-[#dce7df]"
                                )}>{latestLogByCampaign[c.id].message}</p>
                              </div>
                            </div>
                          )}
                        </>
                      )}

                      {c.last_error && (
                        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-[#2d1a1a] border border-[#663030]">
                          <XCircle className="w-3.5 h-3.5 text-[#f87171] shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-[#fca5a5]">
                              Último erro{c.last_error_at ? ` · ${new Date(c.last_error_at).toLocaleString("pt-BR")}` : ""}
                            </p>
                            <p className="text-[11px] text-red-200/90 break-words mt-0.5">{c.last_error}</p>
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2 pt-1 flex-wrap">
                        {(c.status === "draft" || c.status === "paused" || c.status === "stopped") && (
                          <Button size="sm" onClick={() => actionCampaign(c.id, "start")}><Play className="w-3.5 h-3.5 mr-1" /> {c.status === "draft" ? "Iniciar" : "Retomar"}</Button>
                        )}
                        {c.status === "running" && (
                          <Button size="sm" variant="outline" onClick={() => actionCampaign(c.id, "pause")}><Pause className="w-3.5 h-3.5 mr-1" /> Pausar</Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => actionCampaign(c.id, "reset")}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Resetar</Button>
                        {c.status !== "done" && c.status !== "cancelled" && (
                          <Button size="sm" variant="ghost" onClick={() => actionCampaign(c.id, "cancel")}><Square className="w-3.5 h-3.5 mr-1" /> Cancelar</Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => deleteCampaign(c)} className="text-red-400 hover:bg-red-500/10 hover:text-red-300"><Trash2 className="w-3.5 h-3.5 mr-1" /> Excluir</Button>
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
                          {activeLogCampaignId === c.id ? "Ocultar Logs (Tempo Real)" : "Ver Logs de Execução (Tempo Real)"}
                        </span>
                        <ChevronRight className={cn("w-3 h-3 transition-transform", activeLogCampaignId === c.id && "rotate-90")} />
                      </Button>

                      {/* Área de Logs em tempo real */}
                      {activeLogCampaignId === c.id && (
                        <div className="mt-2 rounded-xl bg-black/40 border border-white/5 p-3 font-mono text-[10px] h-64 flex flex-col">
                          <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2">
                            <div className="flex items-center gap-3">
                              <span className="text-[9px] uppercase font-black text-white/40">Log completo de execução</span>
                              <Button variant="ghost" size="sm" onClick={refreshLogs} className="h-5 px-1.5 text-[8px] bg-white/5 hover:bg-white/10">
                                ↻ Atualizar
                              </Button>
                            </div>
                            <Button variant="ghost" size="sm" onClick={() => clearLogs(c.id)} className="h-6 px-2 text-[9px] text-red-400 hover:bg-red-500/10 hover:text-red-300">
                              <Trash2 className="w-3 h-3 mr-1" /> Limpar Logs
                            </Button>
                          </div>
                          <div className="flex-1 overflow-y-auto space-y-1.5 custom-scrollbar pr-2">
                            {campLogs.length === 0 && (
                              <p className="text-white/40 italic text-center py-10">Aguardando eventos…</p>
                            )}
                            {campLogs.map((log, i) => {
                              const color = log.level === "error" ? "text-red-400" : log.level === "success" ? "text-green-400" : log.level === "warning" ? "text-yellow-400" : "text-blue-300";
                              return (
                                <div key={log.id || i} className="flex gap-2 leading-relaxed">
                                  <span className="text-white/30 shrink-0">[{new Date(log.created_at).toLocaleTimeString()}]</span>
                                  <span className={cn("font-bold whitespace-pre-wrap break-words", color)}>{log.message}</span>
                                </div>
                              );
                            })}
                            <div ref={campLogEndRef} />
                          </div>
                        </div>
                      )}

                      {/* Botão histórico de mensagens */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActiveTargetsCampaignId(activeTargetsCampaignId === c.id ? null : c.id)}
                        className="w-full justify-between h-8 bg-[#141a16] border border-[#303a32] hover:bg-[#1e2720] text-xs font-medium text-[#dce7df]"
                      >
                        <span className="flex items-center gap-2">
                          <MessageSquare className="w-3.5 h-3.5 text-[#9ce9bc]" />
                          {activeTargetsCampaignId === c.id ? "Ocultar mensagens" : `Ver mensagens enviadas (${c.sent_count || 0}/${c.total_targets || 0})`}
                        </span>
                        <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", activeTargetsCampaignId === c.id && "rotate-90")} />
                      </Button>

                      {activeTargetsCampaignId === c.id && (
                        <div className="mt-2 rounded-xl bg-[#111712] border border-[#303a32] p-3 flex flex-col max-h-[420px]">
                          <div className="flex items-center justify-between mb-2 border-b border-[#263028] pb-2 gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-[#c4d4c9]">Histórico de envios</span>
                              {loadingTargets && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#a5b1a8]" />}
                            </div>
                            <div className="flex items-center gap-1.5 text-xs flex-wrap">
                              {(["all", "sent", "failed", "pending"] as const).map(f => (
                                <button
                                  key={f}
                                  onClick={() => setTargetsFilter(f)}
                                  className={cn(
                                    "px-2.5 py-1 rounded-md font-medium transition cursor-pointer",
                                    targetsFilter === f ? "bg-[#243d30] text-[#a5f3cf] border border-[#4e7c62]" : "text-[#a5b1a8] hover:text-[#edf2ee]"
                                  )}
                                >
                                  {f === "all" ? `Todos (${targets.length})`
                                    : f === "sent" ? `Enviadas (${targets.filter(t => t.status === "sent").length})`
                                    : f === "failed" ? `Falhas (${targets.filter(t => t.status === "failed").length})`
                                    : `Pendentes (${targets.filter(t => t.status === "pending").length})`}
                                </button>
                              ))}
                              <Button variant="ghost" size="sm" onClick={() => loadTargets(c.id)} className="h-7 px-2 text-xs bg-[#141a16] border border-[#303a32] hover:bg-[#1e2720] ml-1" title="Atualizar">
                                <RefreshCw className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                          <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-2">
                            {targets.length === 0 ? (
                              <p className="text-[#a5b1a8] italic text-center py-10 text-xs">Nenhum envio ainda.</p>
                            ) : (
                              targets
                                .filter(t => targetsFilter === "all" || t.status === targetsFilter)
                                .map(t => {
                                  const phone = (t.remote_jid || "").replace("@s.whatsapp.net", "");
                                  const statusColor =
                                    t.status === "sent" ? "text-[#a5f3cf] border-[#4e7c62] bg-[#243d30]" :
                                    t.status === "failed" ? "text-[#fca5a5] border-[#663030] bg-[#2d1a1a]" :
                                    t.status === "skipped" ? "text-[#fde68a] border-[#614d23] bg-[#2c2516]" :
                                    "text-[#b5c4b9] border-[#303a32] bg-[#141a16]";
                                  return (
                                    <div key={t.id} className="rounded-lg bg-[#141a16] border border-[#2b362e] p-2.5 space-y-1.5">
                                      <div className="flex items-center justify-between gap-2 flex-wrap">
                                        <div className="min-w-0 flex-1">
                                          <p className="text-xs font-semibold text-[#edf2ee] truncate">{t.nome_negocio || "(sem nome)"}</p>
                                          <p className="text-xs text-[#9cab9f] font-mono">{phone}{t.ramo_negocio ? ` · ${t.ramo_negocio}` : ""}</p>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          {t.sent_at && <span className="text-[9px] text-white/40 font-mono">{new Date(t.sent_at).toLocaleString("pt-BR")}</span>}
                                          <span className={cn("text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md border", statusColor)}>{t.status}</span>
                                        </div>
                                      </div>
                                      {t.ai_input ? (
                                        <div className="space-y-1.5">
                                          <div className="rounded-md bg-white/[0.03] border border-white/5 px-2 py-1.5">
                                            <p className="text-[8px] font-black uppercase tracking-widest text-white/40 mb-0.5">Template → IA</p>
                                            <p className="text-[11px] text-white/60 whitespace-pre-wrap italic">{t.ai_input}</p>
                                          </div>
                                          <div className="rounded-md bg-cyan-500/5 border border-cyan-500/20 px-2 py-1.5">
                                            <p className="text-[8px] font-black uppercase tracking-widest text-cyan-300 mb-0.5 flex items-center gap-1">
                                              <Bot className="w-2.5 h-2.5" /> IA gerou (enviado)
                                            </p>
                                            <p className="text-[11px] text-white/90 whitespace-pre-wrap">{t.rendered_message}</p>
                                          </div>
                                        </div>
                                      ) : t.rendered_message ? (
                                        <p className="text-[11px] text-white/80 whitespace-pre-wrap bg-black/20 rounded-md px-2 py-1.5 border border-white/5">{t.rendered_message}</p>
                                      ) : null}
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
                    </CardContent></Card>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB AUTOMAÇÃO */}
        {tab === "automacao" && (
          <div className={cn(styles.automationLayout, "space-y-4")}>
            <Card>
              <CardContent className="space-y-4">
                <div className={styles.sectionHeading}>
                  <h3><Zap className="size-4" /> Nova automação</h3>
                  <p>Configure o público, a mensagem e os retornos em 4 blocos organizados. Depois de criar, clique em Iniciar na lista abaixo.</p>
                </div>

                <nav aria-label="Atalhos do formulário da automação" className={styles.quickJumpBar}>
                  <a href="#ps-auto-id" className={styles.quickJumpLink}><Workflow className="w-3.5 h-3.5" /> 1. Identificação</a>
                  <a href="#ps-auto-publico" className={styles.quickJumpLink}><MapPin className="w-3.5 h-3.5" /> 2. Público e filtros</a>
                  <a href="#ps-auto-msg" className={styles.quickJumpLink}><MessageSquare className="w-3.5 h-3.5" /> 3. Mensagem e IA</a>
                  <a href="#ps-auto-followup" className={styles.quickJumpLink}><Repeat className="w-3.5 h-3.5" /> 4. Follow-up e horário</a>
                </nav>

                {/* Bloco 1: Identificação */}
                <section id="ps-auto-id" className={styles.chapterCard} aria-label="Identificação e conexão WhatsApp">
                  <div className={styles.groupHeader}>
                    <Workflow className="w-4 h-4" />
                    <div>
                      <h4 className={styles.groupTitle}>Identificação e conexão WhatsApp</h4>
                      <p className={styles.groupDesc}>Defina o nome da automação, o chip de envio e quantos leads elegíveis deseja captar.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label htmlFor="ps-automation-name">Nome da automação</label>
                      <Input id="ps-automation-name" value={autoName} onChange={(e) => setAutoName(e.target.value)} placeholder="Ex: Pizzarias SP - Outubro" />
                    </div>
                    <div>
                      <label>Instância WhatsApp</label>
                      <Select value={autoInstance} onValueChange={(v) => setAutoInstance(v || "")}>
                        <SelectTrigger aria-label="Instância WhatsApp" className="w-full"><SelectValue placeholder="Selecionar…" /></SelectTrigger>
                        <SelectContent>
                          {instances.map((inst) => (
                            <SelectItem key={inst.instance_name} value={inst.instance_name}>
                              {inst.instance_name}{inst.status ? ` (${inst.status})` : ""}
                            </SelectItem>
                          ))}
                          {instances.length >= 1 && (
                            <SelectItem key={AUTO_POOL_INSTANCE} value={AUTO_POOL_INSTANCE}>
                              ⚡ Pool Automático (alternar entre chips saudáveis)
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label htmlFor="ps-auto-max-leads">Máx. leads a captar</label>
                      <Input id="ps-auto-max-leads" aria-label="Máximo de leads a captar" type="number" value={autoMaxLeads} onChange={(e) => setAutoMaxLeads(Number(e.target.value))} min={1} />
                    </div>
                  </div>
                </section>

                {/* Bloco 2: Público e Filtros */}
                <section id="ps-auto-publico" className={styles.chapterCard} aria-label="Público e filtros da captura">
                  <div className={styles.groupHeader}>
                    <MapPin className="w-4 h-4" />
                    <div>
                      <h4 className={styles.groupTitle}>Público e filtros de captura no Google Maps</h4>
                      <p className={styles.groupDesc}>Informe nichos e regiões, ou escolha um perfil rápido para configurar todos os filtros automaticamente.</p>
                    </div>
                  </div>

                  <div className={styles.fieldGrid}>
                    <div>
                      <label htmlFor="auto-niches">Nichos (1 por linha)</label>
                      <Textarea id="auto-niches" value={autoNiches} onChange={(e) => setAutoNiches(e.target.value)} rows={2} placeholder={"pizzaria\ndentista"} />
                    </div>
                    <div>
                      <label htmlFor="auto-regions">Regiões (1 por linha)</label>
                      <Textarea id="auto-regions" value={autoRegions} onChange={(e) => setAutoRegions(e.target.value)} rows={2} placeholder={"São Paulo SP\nCentro, Belo Horizonte MG"} />
                    </div>
                  </div>

                  <div className={styles.subGroupMuted}>
                    <div className={styles.groupHeader}>
                      <Sparkles className="w-4 h-4" />
                      <div>
                        <h5 className={styles.groupTitle}>Perfis rápidos</h5>
                        <p className={styles.groupDesc}>Um clique ajusta saúde do site, CNPJ, validação WhatsApp e velocidade sem conflitos.</p>
                      </div>
                    </div>
                    <div className={styles.presetGrid}>
                      {SCRAPER_PRESET_OPTIONS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          aria-label={preset.label}
                          onClick={() => applyAutoFilterSync({ type: "preset", preset: preset.id })}
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
                    {autoSyncNote && (
                      <div role="status" className={styles.syncBanner}>
                        <span className={styles.syncBannerText}>
                          <Info className="w-4 h-4" />
                          <span>{autoSyncNote}</span>
                        </span>
                      </div>
                    )}
                  </div>

                  <div className={styles.subGroupMuted}>
                    <div className={styles.groupHeader}>
                      <Clock className="w-4 h-4" />
                      <div>
                        <h5 className={styles.groupTitle}>Reputação e tempo no Google Maps</h5>
                        <p className={styles.groupDesc}>Filtre empresas por avaliações, nota média e ano de presença no Google (0 desativa).</p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="auto-min-reviews">Mínimo de avaliações no Google</label>
                      <Input id="auto-min-reviews" type="number" min={0} step={1} max={2147483647}
                        value={autoMinReviews} onChange={(e) => { setAutoMinReviews(e.target.value); setAutoMinReviewsError(false); }}
                        aria-invalid={autoMinReviewsError}
                        aria-describedby={`auto-min-reviews-help${autoMinReviewsError ? " auto-min-reviews-error" : ""}`} />
                      <p id="auto-min-reviews-help" className={styles.optionDesc}>{MIN_REVIEWS_HELP}</p>
                      {autoMinReviewsError && <p id="auto-min-reviews-error" role="alert" className="text-xs text-[#fda4af]">{MIN_REVIEWS_ERROR}</p>}
                    </div>
                    <div className="space-y-2 pt-1">
                      <span className={styles.optionTitle}>Está no Google desde (atalho por ano)</span>
                      <div className={styles.segmentedPills}>
                        {[
                          { label: "Qualquer ano", from: "0", to: "0" },
                          { label: "Desde 2019 até hoje", from: "2019", to: String(new Date().getFullYear()) },
                          { label: "Desde 2020 até hoje", from: "2020", to: String(new Date().getFullYear()) },
                          { label: "Desde 2022 até hoje", from: "2022", to: String(new Date().getFullYear()) },
                          { label: "Até 2019", from: "1900", to: "2019" },
                        ].map(preset => (
                          <button
                            key={preset.label}
                            type="button"
                            data-active={autoGoogleYearFrom === preset.from && autoGoogleYearTo === preset.to ? "true" : undefined}
                            onClick={() => {
                              setAutoGoogleYearFrom(preset.from);
                              setAutoGoogleYearTo(preset.to);
                              setAutoExtraFiltersError("");
                            }}
                            className={styles.pillChoice}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                      <div>
                        <label htmlFor="auto-google-year-from">No Google desde (ano)</label>
                        <Input
                          id="auto-google-year-from"
                          type="number"
                          min={0}
                          max={new Date().getFullYear() + 1}
                          step={1}
                          value={autoGoogleYearFrom}
                          onChange={(e) => { setAutoGoogleYearFrom(e.target.value); setAutoExtraFiltersError(""); }}
                          placeholder="Ex: 2019 (0 = todos)"
                        />
                      </div>
                      <div>
                        <label htmlFor="auto-google-year-to">Até o ano (0 = atual)</label>
                        <Input
                          id="auto-google-year-to"
                          type="number"
                          min={0}
                          max={new Date().getFullYear() + 1}
                          step={1}
                          value={autoGoogleYearTo}
                          onChange={(e) => { setAutoGoogleYearTo(e.target.value); setAutoExtraFiltersError(""); }}
                          placeholder={`Ex: ${new Date().getFullYear()}`}
                        />
                      </div>
                      <div>
                        <label htmlFor="auto-max-reviews">Máximo de avaliações</label>
                        <Input
                          id="auto-max-reviews"
                          type="number"
                          min={0}
                          max={2147483647}
                          step={1}
                          value={autoMaxReviews}
                          onChange={(e) => { setAutoMaxReviews(e.target.value); setAutoExtraFiltersError(""); }}
                        />
                      </div>
                      <div>
                        <label htmlFor="auto-min-rating">Nota mínima (0 a 5)</label>
                        <Input
                          id="auto-min-rating"
                          type="number"
                          min={0}
                          max={5}
                          step={0.1}
                          value={autoMinRating}
                          onChange={(e) => { setAutoMinRating(e.target.value); setAutoExtraFiltersError(""); }}
                        />
                      </div>
                      <div>
                        <label htmlFor="auto-max-rating">Nota máxima (0 a 5)</label>
                        <Input
                          id="auto-max-rating"
                          type="number"
                          min={0}
                          max={5}
                          step={0.1}
                          value={autoMaxRating}
                          onChange={(e) => { setAutoMaxRating(e.target.value); setAutoExtraFiltersError(""); }}
                        />
                      </div>
                    </div>
                    {autoExtraFiltersError && <p role="alert" className="text-xs text-[#fda4af]">{autoExtraFiltersError}</p>}
                  </div>

                  <div className={styles.subGroupMuted}>
                    <div className={styles.groupHeader}>
                      <Globe className="w-4 h-4" />
                      <div>
                        <h5 className={styles.groupTitle}>Presença digital e saúde do site</h5>
                        <p className={styles.groupDesc}>Avalie se a empresa possui site próprio saudável, site com falhas ou apenas redes sociais/plataformas terceiras.</p>
                      </div>
                    </div>
                    <div className={styles.optionList}>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-audit-site" className={styles.optionTitle}>Auditar saúde do site (quebrado, SSL vencido, erro 500 ou fraco)</label>
                          <p id="auto-audit-site-help" className={styles.optionDesc}>Protegido contra falso positivo Cloudflare; alimenta o diagnóstico técnico no template/IA.</p>
                        </div>
                        <Switch id="auto-audit-site" aria-describedby="auto-audit-site-help" checked={autoAuditSiteHealth} onCheckedChange={(v) => applyAutoFilterSync({ type: "auditSiteHealth", value: v })} />
                      </div>
                      <div className="py-2 space-y-2 border-t border-[#263028]">
                        <div>
                          <span className={styles.optionTitle}>Filtro por saúde do site na automação:</span>
                          <p className={styles.optionDesc}>Opções que exigem diagnóstico ativam a auditoria automaticamente.</p>
                        </div>
                        <div className={styles.segmentedPills} role="radiogroup" aria-label="Filtro por saúde do site na automação">
                          {SITE_FILTER_MODE_OPTIONS.map((opt) => {
                            const active = autoSiteFilterMode === opt.value;
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => applyAutoFilterSync({ type: "siteFilterMode", value: opt.value })}
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
                          <label htmlFor="auto-only-no-site" className={styles.optionTitle}>Capturar somente leads sem site</label>
                          <p id="auto-only-no-site-help" className={styles.optionDesc}>Mantém apenas empresas sem link de site cadastrado no Google Maps.</p>
                        </div>
                        <input
                          id="auto-only-no-site"
                          type="checkbox"
                          aria-describedby="auto-only-no-site-help"
                          checked={autoFilterWithWebsite}
                          onChange={(e) => applyAutoFilterSync({ type: "filterWithWebsite", value: e.target.checked })}
                          className={styles.toggleInput}
                        />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-filter-with-instagram" className={styles.optionTitle}>Somente com Instagram</label>
                          <p id="auto-filter-with-instagram-help" className={styles.optionDesc}>{INSTAGRAM_FILTER_HELP}</p>
                        </div>
                        <input id="auto-filter-with-instagram" type="checkbox" checked={autoFilterWithInstagram}
                          onChange={(e) => setAutoFilterWithInstagram(e.target.checked)}
                          aria-describedby="auto-filter-with-instagram-help"
                          className={styles.toggleInput} />
                      </div>
                    </div>
                  </div>

                  <div className={styles.subGroupMuted}>
                    <div className={styles.groupHeader}>
                      <ShieldCheck className="w-4 h-4" />
                      <div>
                        <h5 className={styles.groupTitle}>Contato, CNPJ e sócio decisor</h5>
                        <p className={styles.groupDesc}>Filtre telefones válidos, empresas ativas na Receita e encontre o WhatsApp direto do dono.</p>
                      </div>
                    </div>
                    <div className={styles.optionList}>
                      {[
                        { id: "auto-filter-empty", label: "Remover leads sem telefone", desc: "Descarta empresas sem nenhum número.", value: autoFilterEmpty, set: setAutoFilterEmpty },
                        { id: "auto-filter-dups", label: "Remover telefones duplicados", desc: "Evita abordar o mesmo telefone mais de uma vez.", value: autoFilterDuplicates, set: setAutoFilterDuplicates },
                        { id: "auto-filter-landlines", label: "Remover telefones fixos", desc: "Remove fixos sem WhatsApp Business ativo.", value: autoFilterLandlines, set: setAutoFilterLandlines },
                      ].map((f) => (
                        <div key={f.label} className={styles.optionRow}>
                          <div className={styles.optionCopy}>
                            <label htmlFor={f.id} className={styles.optionTitle}>{f.label}</label>
                            <p id={`${f.id}-help`} className={styles.optionDesc}>{f.desc}</p>
                          </div>
                          <input id={f.id} type="checkbox" aria-describedby={`${f.id}-help`} checked={f.value} onChange={(e) => f.set(e.target.checked)} className={styles.toggleInput} />
                        </div>
                      ))}
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-validate-wa" className={styles.optionTitle}>Validar WhatsApp ativo na Evolution (recupera fixos Business)</label>
                          <p id="auto-validate-wa-help" className={styles.optionDesc}>Confirma no chip conectado antes de salvar o lead para disparo.</p>
                        </div>
                        <Switch id="auto-validate-wa" aria-describedby="auto-validate-wa-help" checked={autoValidateWhatsApp} onCheckedChange={(v) => applyAutoFilterSync({ type: "validateWhatsApp", value: v })} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-filter-closed" className={styles.optionTitle}>Descartar empresas fechadas ou CNPJ baixado/inapto</label>
                          <p id="auto-filter-closed-help" className={styles.optionDesc}>Evita disparos para empresas encerradas no Maps ou inativas na Receita Federal.</p>
                        </div>
                        <Switch id="auto-filter-closed" aria-describedby="auto-filter-closed-help" checked={autoFilterClosedBusinesses} onCheckedChange={setAutoFilterClosedBusinesses} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-exclude-franchises" className={styles.optionTitle}>Ignorar grandes redes e franquias</label>
                          <p id="auto-exclude-franchises-help" className={styles.optionDesc}>Descarta redes conhecidas e S/A para focar decisores locais.</p>
                        </div>
                        <Switch id="auto-exclude-franchises" aria-label="Ignorar grandes redes e franquias na automação" aria-describedby="auto-exclude-franchises-help" checked={autoExcludeFranchises} onCheckedChange={setAutoExcludeFranchises} />
                      </div>
                      <div className="py-2.5 border-t border-[#263028]">
                        <div className="flex items-start justify-between gap-4">
                          <div className={styles.optionCopy}>
                            <label htmlFor="auto-enrich-cnpj" className={styles.optionTitle}>Enriquecer CNPJ e Sócio Decisor grátis (Receita + RDAP)</label>
                            <p id="auto-enrich-cnpj-help" className={styles.optionDesc}>Preenche nome do sócio, CNPJ, porte e idade da empresa antes dos disparos.</p>
                          </div>
                          <Switch id="auto-enrich-cnpj" aria-describedby="auto-enrich-cnpj-help" checked={autoEnrichCnpj} onCheckedChange={(v) => applyAutoFilterSync({ type: "enrichCnpj", value: v })} />
                        </div>
                        {autoEnrichCnpj && (
                          <div className={styles.nestedPanel}>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                              <div className="flex items-center justify-between gap-3">
                                <label htmlFor="auto-exclude-mei" className={styles.optionTitle}>Ignorar MEI (focar ME, EPP e Ltda)</label>
                                <input id="auto-exclude-mei" type="checkbox" checked={autoExcludeMei} onChange={(e) => applyAutoFilterSync({ type: "excludeMei", value: e.target.checked })} className={styles.toggleInput} />
                              </div>
                              <div className="flex items-center justify-between gap-3">
                                <label htmlFor="auto-min-capital" className={styles.optionTitle}>Capital mínimo (R$)</label>
                                <Input id="auto-min-capital" type="number" min={0} step={1000} value={autoMinCapitalSocial} onChange={(e) => applyAutoFilterSync({ type: "minCapitalSocial", value: e.target.value })} className="w-28" />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-partner-phone" className={styles.optionTitle}>Priorizar WhatsApp oculto do site / celular do sócio</label>
                          <p id="auto-partner-phone-help" className={styles.optionDesc}>Dá preferência para números extraídos do site oficial ou sócio.</p>
                        </div>
                        <Switch id="auto-partner-phone" aria-describedby="auto-partner-phone-help" checked={autoPrioritizePartnerPhone} onCheckedChange={(v) => applyAutoFilterSync({ type: "prioritizePartnerPhone", value: v })} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-hunt-partner" className={styles.optionTitle}>Modo Direto no Dono</label>
                          <p id="auto-hunt-partner-help" className={styles.optionDesc}>9º dígito Anatel + WhatsApp Pessoal do sócio vs Recepção.</p>
                        </div>
                        <Switch id="auto-hunt-partner" aria-label="Modo Direto no Dono na automação" aria-describedby="auto-hunt-partner-help" checked={autoHuntPartnerDirectPhone} onCheckedChange={(v) => applyAutoFilterSync({ type: "huntPartnerDirectPhone", value: v })} />
                      </div>
                    </div>
                  </div>

                  <div className={styles.subGroupMuted}>
                    <div className={styles.groupHeader}>
                      <Zap className="w-4 h-4" />
                      <div>
                        <h5 className={styles.groupTitle}>Velocidade, fila inteligente e avaliações com IA</h5>
                        <p className={styles.groupDesc}>Defina ordem de disparo por Score ICP, economia de RAM e resumo de avaliações.</p>
                      </div>
                    </div>
                    <div className={styles.optionList}>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-turbo-mode" className={styles.optionTitle}>Modo Turbo VPS (alta velocidade e economia de RAM)</label>
                          <p id="auto-turbo-mode-help" className={styles.optionDesc}>Reutiliza aba, bloqueia mídia pesada e pula duplicados via cache em RAM.</p>
                        </div>
                        <Switch id="auto-turbo-mode" aria-describedby="auto-turbo-mode-help" checked={autoTurboMode} onCheckedChange={(v) => applyAutoFilterSync({ type: "turboMode", value: v })} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-expand-neighborhoods" className={styles.optionTitle}>Busca profunda por bairros</label>
                          <p id="auto-expand-neighborhoods-help" className={styles.optionDesc}>Subdivide cidades em bairros para furar o teto de 120 leads.</p>
                        </div>
                        <Switch id="auto-expand-neighborhoods" aria-label="Busca profunda por bairros na automação" aria-describedby="auto-expand-neighborhoods-help" checked={autoExpandNeighborhoods} onCheckedChange={setAutoExpandNeighborhoods} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-prioritize-score" className={styles.optionTitle}>Priorizar fila por Score ICP</label>
                          <p id="auto-prioritize-score-help" className={styles.optionDesc}>Envia primeiro para leads com maior Score ICP e contato direto do sócio.</p>
                        </div>
                        <Switch id="auto-prioritize-score" aria-label="Priorizar fila por Score ICP na automação" aria-describedby="auto-prioritize-score-help" checked={autoPrioritizeByScore} onCheckedChange={(v) => applyAutoFilterSync({ type: "prioritizeByScore", value: v })} />
                      </div>
                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="auto-capture-all-reviews" className={styles.optionTitle}>Capturar todas as avaliações</label>
                          <p id="auto-capture-all-reviews-help" className={styles.optionDesc}>Salva todos os comentários disponíveis no Maps (aumenta o tempo de captura e pausa o Modo Turbo).</p>
                        </div>
                        <Switch id="auto-capture-all-reviews" aria-describedby="auto-capture-all-reviews-help" checked={autoCaptureAllReviews} onCheckedChange={(v) => applyAutoFilterSync({ type: "captureAllReviews", value: v })} />
                      </div>
                      <div className="py-2.5 border-t border-[#263028]">
                        <div className="flex items-start justify-between gap-4">
                          <div className={styles.optionCopy}>
                            <label htmlFor="ps-auto-reviews-ai" className={styles.optionTitle}>Resumir avaliações do Google com IA</label>
                            <p id="ps-auto-reviews-ai-help" className={styles.optionDesc}>
                              Gera elogios, reclamações e gancho comercial em <code>{"{{resumo_avaliacoes}}"}</code> antes do disparo. Ativa &quot;Capturar todas as avaliações&quot; automaticamente.
                            </p>
                          </div>
                          <Switch id="ps-auto-reviews-ai" aria-describedby="ps-auto-reviews-ai-help" checked={autoReviewsAi} onCheckedChange={(v) => applyAutoFilterSync({ type: "reviewsAiEnabled", value: v })} />
                        </div>
                        {autoReviewsAi && (
                          <div className={styles.nestedPanel}>
                            <div>
                              <label>Modelo de IA</label>
                              <select
                                aria-label="Modelo de IA para avaliações da automação"
                                value={autoReviewsAiModel || ""}
                                onChange={(e) => setAutoReviewsAiModel(e.target.value)}
                                className="w-full mt-0.5 rounded-md px-2 text-xs"
                              >
                                {aiModels.length === 0 ? (
                                  <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — configure API key)"}</option>
                                ) : (
                                  <ModelOptions models={aiModels as any} />
                                )}
                              </select>
                            </div>
                            <div>
                              <label>Prompt (vazio = padrão)</label>
                              <Textarea aria-label="Instruções de IA para avaliações da automação" rows={2}
                                value={autoReviewsAiPrompt}
                                onChange={(e) => setAutoReviewsAiPrompt(e.target.value)}
                                placeholder="Ex: Resuma as avaliações focando em dores que um site profissional resolveria…" />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                {/* Bloco 3: Mensagem inicial, ritmo e variação */}
                <section id="ps-auto-msg" className={styles.chapterCard} aria-label="Mensagem inicial e ritmo de envio">
                  <div className={styles.groupHeader}>
                    <MessageSquare className="w-4 h-4" />
                    <div>
                      <h4 className={styles.groupTitle}>Mensagem inicial, ritmo e anti-banimento</h4>
                      <p className={styles.groupDesc}>Monte a mensagem com variáveis dinâmicas, ajuste o ritmo humano e escolha como variar o texto.</p>
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
                          { key: "porte_receita", label: "Porte Receita", hint: "MEI / ME / EPP / Ltda" },
                          { key: "anos_empresa", label: "Anos CNPJ", hint: "Idade da empresa em anos" },
                        ],
                      },
                      {
                        title: "Avaliações e data",
                        vars: [
                          { key: "avaliacao", label: "Avaliação", hint: "Nota Google (1-5)" },
                          { key: "reviews", label: "Reviews", hint: "Qtd. de reviews" },
                          { key: "resumo_avaliacoes", label: "Resumo aval.", hint: "Resumo IA das avaliações do Google (reviews-ai)" },
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
                              onClick={() => setAutoTemplate((autoTemplate || "") + `{{${v.key}}}`)}
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
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <label htmlFor="ps-auto-template">Mensagem-base (template de disparo)</label>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => setAutoTemplate(MENTOR_2STEP_TEMPLATE)}
                          className={styles.pillChoice}
                        >
                          Abridor 2-Step (Mentor)
                        </button>
                        <button
                          type="button"
                          onClick={() => setAutoTemplate(MENTOR_VIDEO_PRAISE_TEMPLATE)}
                          className={styles.pillChoice}
                        >
                          Abridor Vídeo (Nota Google + Site/Insta)
                        </button>
                      </div>
                    </div>
                    <Textarea id="ps-auto-template" aria-label="Mensagem-base da automação" value={autoTemplate} onChange={(e) => setAutoTemplate(e.target.value)} rows={3}
                      placeholder="Ex: {{saudacao}} {{nome_empresa}}! Vi vocês no Maps…" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="ps-auto-min-sec">Intervalo mín. entre disparos (s)</label>
                      <Input id="ps-auto-min-sec" aria-label="Intervalo mínimo entre disparos em segundos" type="number" value={autoMinSec} onChange={(e) => setAutoMinSec(Number(e.target.value))} min={5} />
                    </div>
                    <div>
                      <label htmlFor="ps-auto-max-sec">Intervalo máx. entre disparos (s)</label>
                      <Input id="ps-auto-max-sec" aria-label="Intervalo máximo entre disparos em segundos" type="number" value={autoMaxSec} onChange={(e) => setAutoMaxSec(Number(e.target.value))} min={autoMinSec} />
                    </div>
                  </div>

                  <div className={styles.subGroupMuted}>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className={styles.optionTitle}>Delay e Presença &quot;Digitando...&quot; (Evolution API)</span>
                      <span className={styles.noteBadge}>
                        {autoTypingDelayMode === "fixed" ? `Fixo: ${autoTypingDelaySeconds}s digitando` : `Aleatório: ${autoTypingDelayMinSeconds}s a ${autoTypingDelayMaxSeconds}s`}
                      </span>
                    </div>
                    <p className={styles.optionDesc}>
                      Simula digitação real antes de entregar cada mensagem para prevenir bloqueios por envios mecânicos.
                    </p>
                    <div className={styles.segmentedPills}>
                      <button
                        type="button"
                        data-active={autoTypingDelayMode === "fixed" ? "true" : undefined}
                        onClick={() => setAutoTypingDelayMode("fixed")}
                        className={styles.pillChoice}
                      >
                        Modo Fixo
                      </button>
                      <button
                        type="button"
                        data-active={autoTypingDelayMode === "random" ? "true" : undefined}
                        onClick={() => setAutoTypingDelayMode("random")}
                        className={styles.pillChoice}
                      >
                        Modo Aleatório (Faixa Min–Máx)
                      </button>
                    </div>
                    {autoTypingDelayMode === "fixed" ? (
                      <div className="space-y-1.5 pt-1 max-w-md">
                        <div className="flex items-center justify-between text-xs">
                          <span className={styles.optionDesc}>Tempo digitando por mensagem:</span>
                          <span className={styles.noteBadge}>{autoTypingDelaySeconds}s</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <input
                            type="range"
                            min={1}
                            max={60}
                            value={autoTypingDelaySeconds}
                            onChange={(e) => setAutoTypingDelaySeconds(Number(e.target.value))}
                          />
                          <Input
                            type="number"
                            min={1}
                            max={120}
                            value={autoTypingDelaySeconds}
                            onChange={(e) => setAutoTypingDelaySeconds(Math.max(1, Math.min(Number(e.target.value), 120)))}
                            className="w-20 text-center"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1 max-w-lg">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className={styles.optionDesc}>Mínimo digitando:</span>
                            <span className={styles.noteBadge}>{autoTypingDelayMinSeconds}s</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="range"
                              min={1}
                              max={60}
                              value={autoTypingDelayMinSeconds}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setAutoTypingDelayMinSeconds(val);
                                if (val > autoTypingDelayMaxSeconds) setAutoTypingDelayMaxSeconds(val);
                              }}
                            />
                            <Input
                              type="number"
                              min={1}
                              max={120}
                              value={autoTypingDelayMinSeconds}
                              onChange={(e) => {
                                const val = Math.max(1, Math.min(Number(e.target.value), 120));
                                setAutoTypingDelayMinSeconds(val);
                                if (val > autoTypingDelayMaxSeconds) setAutoTypingDelayMaxSeconds(val);
                              }}
                              className="w-20 text-center"
                            />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className={styles.optionDesc}>Máximo digitando:</span>
                            <span className={styles.noteBadge}>{autoTypingDelayMaxSeconds}s</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="range"
                              min={1}
                              max={60}
                              value={autoTypingDelayMaxSeconds}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setAutoTypingDelayMaxSeconds(val);
                                if (val < autoTypingDelayMinSeconds) setAutoTypingDelayMinSeconds(val);
                              }}
                            />
                            <Input
                              type="number"
                              min={1}
                              max={120}
                              value={autoTypingDelayMaxSeconds}
                              onChange={(e) => {
                                const val = Math.max(1, Math.min(Number(e.target.value), 120));
                                setAutoTypingDelayMaxSeconds(val);
                                if (val < autoTypingDelayMinSeconds) setAutoTypingDelayMinSeconds(val);
                              }}
                              className="w-20 text-center"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className={styles.subGroupMuted}>
                    <div className={styles.optionList}>
                      <div className="py-2">
                        <div className="flex items-start justify-between gap-4">
                          <div className={styles.optionCopy}>
                            <label htmlFor="ps-auto-personalize" className={styles.optionTitle}>Reescrever cada disparo com IA</label>
                            <p className={styles.optionDesc}>Cada lead recebe um texto único a partir do template e dos dados captados, reduzindo risco de banimento.</p>
                          </div>
                          <Switch id="ps-auto-personalize" checked={autoPersonalize} onCheckedChange={(v) => applyAutoFilterSync({ type: "personalizeWithAi", value: v })} />
                        </div>
                        {autoPersonalize && (
                          <div className={styles.nestedPanel}>
                            <div>
                              <label>Modelo de IA</label>
                              <select
                                aria-label="Modelo de IA da automação"
                                value={autoAiModel || ""}
                                onChange={(e) => setAutoAiModel(e.target.value)}
                                className="w-full mt-0.5 rounded-md px-2 text-xs"
                              >
                                {aiModels.length === 0 ? (
                                  <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — configure API key em Configurações)"}</option>
                                ) : (
                                  <ModelOptions models={aiModels as any} />
                                )}
                              </select>
                            </div>
                            <div>
                              <label>Prompt para a IA (como reescrever)</label>
                              <Textarea aria-label="Instruções de IA para disparos" rows={3}
                                value={autoAiPrompt}
                                onChange={(e) => setAutoAiPrompt(e.target.value)}
                                placeholder="Ex: Reescreva a mensagem-base de forma natural e única para cada cliente, mantendo o tom amigável e profissional. Não use emojis exagerados. Adapte ao ramo do negócio se for relevante. Mensagem deve ter no máximo 3 frases." />
                              <p className={styles.optionDesc}>
                                A IA recebe: prompt + mensagem-base + dados do lead (nome, ramo). Devolve a mensagem final enviada.
                              </p>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-auto-humanize" className={styles.optionTitle}>Humanizar disparo (picotar mensagem)</label>
                          <p className={styles.optionDesc}>Divide a mensagem em blocos curtos com pausa de digitação entre eles (2–5s).</p>
                        </div>
                        <Switch id="ps-auto-humanize" checked={autoHumanize} onCheckedChange={setAutoHumanize} />
                      </div>

                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-auto-mixer" className={styles.optionTitle}>Misturador Anti-Ban (Variação de Abordagem)</label>
                          <p className={styles.optionDesc}>Alterna variações naturais de saudação sem IA paga. Desativa automaticamente se a reescrita IA estiver ligada.</p>
                        </div>
                        <Switch id="ps-auto-mixer" aria-label="Misturador Anti-Ban na automação" checked={autoAntibanMixer} onCheckedChange={(v) => applyAutoFilterSync({ type: "antibanMixer", value: v })} />
                      </div>

                      <div className="py-2 space-y-2">
                        <div className={styles.optionCopy}>
                          <span id="ps-auto-weekend-label" className={styles.optionTitle}>Modo Comercial B2B (Proteção Fim de Semana)</span>
                          <p className={styles.optionDesc}>Pausa disparos frios aos domingos; sábado pode operar em 100% ou 50%.</p>
                        </div>
                        <div className={styles.segmentedPills} role="group" aria-labelledby="ps-auto-weekend-label">
                          <button
                            type="button"
                            data-active={!autoWeekendGuard ? "true" : undefined}
                            aria-pressed={!autoWeekendGuard}
                            onClick={() => setAutoWeekendGuard(false)}
                            className={styles.pillChoice}
                          >
                            Desligado
                          </button>
                          <button
                            type="button"
                            data-active={autoWeekendGuard === "sunday_only" ? "true" : undefined}
                            aria-pressed={autoWeekendGuard === "sunday_only"}
                            onClick={() => setAutoWeekendGuard("sunday_only")}
                            className={styles.pillChoice}
                          >
                            Pausar só Domingo (Sábado 100%)
                          </button>
                          <button
                            type="button"
                            data-active={autoWeekendGuard === "full" || autoWeekendGuard === true ? "true" : undefined}
                            aria-pressed={autoWeekendGuard === "full" || autoWeekendGuard === true}
                            onClick={() => setAutoWeekendGuard("full")}
                            className={styles.pillChoice}
                          >
                            Domingo + 50% Sábado
                          </button>
                        </div>
                      </div>

                      <div className={styles.optionRow}>
                        <div className={styles.optionCopy}>
                          <label htmlFor="ps-auto-cold-shield" className={styles.optionTitle}>Proteção Anti-Ban (cotas do chip e descanso de 15 min)</label>
                          <p className={styles.optionDesc}>Ligada: respeita o teto por hora/dia do chip e pausa 15 min quando o teto é atingido. Desligada: esta automação ignora cotas, berçário, quarentena e pausas automáticas — dispara no ritmo configurado. Aumenta o risco de bloqueio.</p>
                        </div>
                        <Switch id="ps-auto-cold-shield" aria-label="Proteção Anti-Ban na automação" checked={autoColdShield} onCheckedChange={setAutoColdShield} />
                      </div>
                    </div>
                  </div>
                </section>

                {/* Bloco 4: Follow-up e Horário */}
                <section id="ps-auto-followup" className={styles.chapterCard} aria-label="Follow-up automático e horário permitido">
                  <div className="flex items-start justify-between gap-4">
                    <div className={styles.groupHeader}>
                      <Repeat className="w-4 h-4" />
                      <div>
                        <h4 className={styles.groupTitle}>Follow-up automático e horário comercial</h4>
                        <p className={styles.groupDesc}>Configure retornos programados para quem não respondeu e a janela diária permitida para envios.</p>
                      </div>
                    </div>
                    <Switch checked={autoFollowup} onCheckedChange={setAutoFollowup} aria-label="Ativar follow-up automático na automação" />
                  </div>

                  {!autoFollowup ? (
                    <p className={styles.optionDesc}>
                      Follow-up desativado: a automação encerra logo após o disparo inicial sem enviar retornos.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {autoSteps.map((step, idx) => (
                        <div key={idx} className={styles.followupCard}>
                          <div className={styles.followupCardHead}>
                            <span className={styles.followupBadge}>{idx + 1}º retorno</span>
                            <Button onClick={() => setAutoSteps(autoSteps.filter((_, i) => i !== idx))}
                              aria-label={`Remover retorno ${idx + 1}`}
                              variant="ghost" size="icon" className="h-8 w-8 text-[#fda4af]">
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                          <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-start">
                            <div className="flex flex-col gap-1 shrink-0 w-full sm:w-28">
                              <label>Após (dias)</label>
                              <NumberInput aria-label={`Dias até o retorno ${idx + 1}`} min={1} fallback={1} value={step.day_offset}
                                onChange={n => {
                                  const next = [...autoSteps];
                                  next[idx] = { ...next[idx], day_offset: n };
                                  setAutoSteps(next);
                                }}
                                className="w-full" />
                            </div>
                            <div className="flex-1 min-w-0 space-y-1.5">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <label>Mensagem do follow-up</label>
                                <div className="flex flex-wrap gap-1">
                                  {[
                                    { key: "saudacao", label: "Saudação" },
                                    { key: "nome_empresa", label: "Empresa" },
                                    { key: "ramo", label: "Ramo" },
                                    { key: "resumo_avaliacoes", label: "Resumo aval." },
                                  ].map(v => (
                                    <button
                                      key={v.key} type="button"
                                      onClick={() => {
                                        const next = [...autoSteps];
                                        next[idx] = { ...next[idx], template: (next[idx].template || "") + `{{${v.key}}}` };
                                        setAutoSteps(next);
                                      }}
                                      className={styles.pillChoice}
                                    >
                                      +{v.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <Textarea aria-label={`Mensagem do retorno ${idx + 1}`} rows={2} value={step.template}
                                onChange={e => {
                                  const next = [...autoSteps];
                                  next[idx] = { ...next[idx], template: e.target.value };
                                  setAutoSteps(next);
                                }}
                                placeholder="Ex: Olá {{nome_empresa}}! Vi os elogios em {{resumo_avaliacoes}} e..." />
                            </div>
                          </div>
                        </div>
                      ))}

                      <Button onClick={() => setAutoSteps([...autoSteps, { day_offset: 3, template: "" }])}
                        variant="outline" className="gap-2">
                        <Plus className="w-3.5 h-3.5" /> Adicionar retorno
                      </Button>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                        <div>
                          <label>Intervalo mín. entre follow-ups (s)</label>
                          <Input aria-label="Intervalo mínimo entre retornos em segundos" type="number" value={autoFuMinSec} onChange={(e) => setAutoFuMinSec(Number(e.target.value))} min={5} />
                        </div>
                        <div>
                          <label>Intervalo máx. entre follow-ups (s)</label>
                          <Input aria-label="Intervalo máximo entre retornos em segundos" type="number" value={autoFuMaxSec} onChange={(e) => setAutoFuMaxSec(Number(e.target.value))} min={autoFuMinSec} />
                        </div>
                      </div>

                      <div className={styles.subGroupMuted}>
                        <div className="flex items-start justify-between gap-4">
                          <div className={styles.optionCopy}>
                            <label htmlFor="ps-auto-followup-ai" className={styles.optionTitle}>Reescrever cada follow-up com IA</label>
                            <p className={styles.optionDesc}>Considera o histórico da conversa de cada lead para puxar um gancho natural sem parecer automático.</p>
                          </div>
                          <Switch id="ps-auto-followup-ai" checked={autoFollowupAi} onCheckedChange={setAutoFollowupAi} />
                        </div>
                        {autoFollowupAi && (
                          <div className={styles.nestedPanel}>
                            <div>
                              <label>Modelo de IA</label>
                              <select
                                aria-label="Modelo de IA para retornos"
                                value={autoFollowupAiModel || ""}
                                onChange={(e) => setAutoFollowupAiModel(e.target.value)}
                                className="w-full mt-0.5 rounded-md px-2 text-xs"
                              >
                                {aiModels.length === 0 ? (
                                  <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — configure API key em Configurações)"}</option>
                                ) : (
                                  <ModelOptions models={aiModels as any} />
                                )}
                              </select>
                            </div>
                            <div>
                              <label>Prompt para a IA</label>
                              <Textarea aria-label="Instruções de IA para retornos" rows={3}
                                value={autoFollowupAiPrompt}
                                onChange={(e) => setAutoFollowupAiPrompt(e.target.value)}
                                placeholder="Ex: Você é um SDR cordial fazendo follow-up sem ser insistente. Use o histórico pra puxar gancho do que o cliente já mencionou. Tom natural, máximo 3 frases." />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="pt-2 border-t border-[#263028] grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="ps-auto-start-hour">Enviar a partir das (h)</label>
                      <Input id="ps-auto-start-hour" aria-label="Hora inicial da automação" type="number" value={autoStartHour} onChange={(e) => setAutoStartHour(Number(e.target.value))} min={0} max={23} />
                    </div>
                    <div>
                      <label htmlFor="ps-auto-end-hour">Enviar até as (h)</label>
                      <Input id="ps-auto-end-hour" aria-label="Hora final da automação" type="number" value={autoEndHour} onChange={(e) => setAutoEndHour(Number(e.target.value))} min={1} max={24} />
                    </div>
                  </div>
                </section>

                <Button onClick={createAutomation} disabled={creatingAuto} className="w-full">
                  {creatingAuto ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Zap className="w-4 h-4 mr-1" />}
                  Criar automação
                </Button>
              </CardContent>
            </Card>

            {/* Lista de automações */}
            <div className="flex justify-between items-center pt-2">
              <div className={styles.groupHeader}>
                <div>
                  <h4 className={styles.groupTitle}>Automações ativas</h4>
                  <p className={styles.groupDesc}>Acompanhe o andamento da captação, disparos e retornos.</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={loadAutomations}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Atualizar</Button>
            </div>

            {automations.length === 0 ? (
              <Card><CardContent className="p-8 text-center text-[#a5b1a8] text-sm">
                Nenhuma automação criada ainda.
              </CardContent></Card>
            ) : (
              <div className="space-y-3">
                {automations.map((a) => {
                  const phaseLabels: Record<string, string> = {
                    idle: "Aguardando", scraping: "Captando", campaigning: "Disparando", dispatching: "Disparando",
                    following: "Follow-up", paused: "Pausada", done: "Concluída", error: "Erro",
                  };
                  const statusLabels: Record<string, string> = {
                    draft: "Rascunho", running: "Em execução", paused: "Pausada", error: "Erro", done: "Concluída",
                  };
                  const statusColor =
                    a.status === "running" ? "text-[#a5f3cf] bg-[#243d30] border-[#4e7c62]" :
                    a.status === "paused" ? "text-[#fde68a] bg-[#2c2516] border-[#614d23]" :
                    a.status === "error" ? "text-[#fca5a5] bg-[#2d1a1a] border-[#663030]" :
                    a.status === "done" ? "text-[#c5f0d8] bg-[#18281f] border-[#355844]" :
                    "text-[#b5c4b9] bg-[#141a16] border-[#303a32]";
                  return (
                    <Card key={a.id}>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="min-w-0 flex-1 basis-full sm:basis-0">
                            <p className="text-sm font-semibold text-[#edf2ee] truncate">{a.name}</p>
                            <p className="text-xs text-[#9cab9f] mt-0.5">
                              {(a.niches || []).join(", ") || "—"} · {(a.regions || []).join(", ") || "—"} · {formatInstanceLabel(a.instance_name)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 flex-wrap">
                            <span className={cn("text-xs font-medium px-2.5 py-0.5 rounded-md border", statusColor)}>
                              {statusLabels[a.status] || a.status} · {phaseLabels[a.phase] || a.phase}
                            </span>
                            <Badge className="bg-[#141a16] border border-[#303a32] text-[#c4d4c9] text-xs font-medium">{a.scraped_count ?? 0}/{a.scrape_max_leads} leads</Badge>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                          {(a.status === "draft" || a.status === "paused" || a.status === "error" || a.status === "done") && (
                            <Button size="sm" onClick={() => autoAction(a.id, "start")} disabled={pendingAutoActions.has(a.id)} className="h-8 text-xs">
                              <Play className="w-3.5 h-3.5 mr-1" /> {a.status === "paused" || a.status === "error" || (a.status === "done" && (a.scraped_count ?? 0) < a.scrape_max_leads) ? "Retomar" : "Iniciar"}
                            </Button>
                          )}
                          {a.status === "running" && (
                            <Button size="sm" variant="outline" onClick={() => autoAction(a.id, "pause")} disabled={pendingAutoActions.has(a.id)} className="h-8 text-xs">
                              <Pause className="w-3.5 h-3.5 mr-1" /> Pausar
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant={expandedAuto === a.id ? "default" : "ghost"}
                            onClick={() => {
                              if (expandedAuto === a.id) { setExpandedAuto(null); }
                              else { setExpandedAuto(a.id); loadAutoLogs(a.id); }
                            }}
                            className={cn(
                              "h-8 text-xs",
                              expandedAuto === a.id
                                ? "bg-[#243d30] text-[#a5f3cf] border border-[#4e7c62] hover:bg-[#2a4738]"
                                : "border border-[#303a32] bg-[#141a16] text-[#c4d4c9] hover:bg-[#1e2720] hover:text-[#edf2ee]"
                            )}
                          >
                            <Terminal className="w-3.5 h-3.5 mr-1" />
                            {expandedAuto === a.id ? "Terminal ao vivo (ativo)" : "Ver terminal"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => autoAction(a.id, "delete")} disabled={pendingAutoActions.has(a.id)} aria-label={`Deletar automação ${a.name}`} className="h-8 text-xs text-[#fca5a5] hover:bg-[#2d1a1a]">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>

                        {a.last_error && (
                          <p className="flex items-start gap-2 text-xs text-[#fecaca] bg-[#2d1a1a] border border-[#663030] rounded-md px-3 py-2">
                            <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#f87171]" />
                            <span>{a.last_error}</span>
                          </p>
                        )}

                        {expandedAuto === a.id && (
                          <div className="mt-2">
                            <AutomationLogs
                              automationId={a.id}
                              campaignId={a.campaign_id}
                              followupCampaignId={a.followup_campaign_id}
                              startedAt={(a as any).started_at || null}
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
          </div>
        )}

        {tab === "mentor" && (
          <MentorPreviewQueuePanel
            instances={instances.map((i) => i.instance_name).filter(Boolean)}
          />
        )}

        </section>
        </div>
      </div>
    </div>
  );
}