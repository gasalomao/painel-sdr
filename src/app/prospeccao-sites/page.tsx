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
  Clock, MessageSquare, ChevronRight, Bot, Smartphone, Zap, Repeat, Plus, Scissors,
} from "lucide-react";
import { renderTemplate, type TemplateContext } from "@/lib/template-vars";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { AutomationLogs } from "../automacao/AutomationLogs";

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
  created_at: string;
  opt_out: boolean;
  primeiro_contato_source: string | null;
  primeiro_contato_at: string | null;
  resumo_avaliacoes?: string | null;
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
] as const;
type TabKey = typeof TABS[number]["key"];

const DEFAULT_TEMPLATE = `{{saudacao}}! Tudo bem? Aqui é a Sarah, da Salomão AI.

Achei a {{nome_empresa}} no Google pesquisando sobre {{ramo}} e me chamou muita atenção nota de vocês (nota {{avaliacao}} com {{reviews}} avaliações, parabéns!).

Fui procurar o site de vocês pra ver mais detalhes e vi que ainda não têm um no ar. Hoje em dia muita gente acha o perfil no Google, mas se não vê um site na hora com os serviços, acaba indo pro concorrente.

Por conta disso, já deixei montado um modelo de site pronto pra vocês verem como ficaria na prática.

Você prefere que eu te mande o link aqui por mensagem ou prefere marcar uma reunião rápida para te mostrar como ficou? Qual você prefere? (É totalmente sem compromisso).`;

const VENDEDOR_DEFAULT = "Salomão";

const HAS_WEBSITE_LABELS: Record<string, string> = {
  only_empty: "Sem site",
  all: "Todos os sites",
  only_with: "Com site",
};

const SORT_LABELS: Record<string, string> = {
  reviews: "Avaliações",
  rating: "Nota",
  created_at: "Data captura",
};

const ORDER_LABELS: Record<string, string> = {
  desc: "Maior → menor",
  asc: "Menor → maior",
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
      <div className="flex items-center gap-2 p-2 rounded-lg bg-green-500/5 border border-green-500/20">
        <Loader2 className="w-3.5 h-3.5 text-green-400 animate-spin shrink-0" />
        <span className="text-[11px] text-green-300 font-bold">Processando agora.</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/30">
      <Clock className="w-4 h-4 text-blue-400 animate-pulse shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-[10px] font-black uppercase tracking-wider text-blue-400">Próximo disparo em</span>
        <div className="text-lg font-black text-blue-300 font-mono leading-none mt-0.5">
          {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}
        </div>
      </div>
      <div className="w-16 h-1 bg-blue-500/20 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-400 transition-all duration-1000"
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
          setScraperLeadsCount(d.leadCount ?? (d.leads?.length ?? 0));
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
          niches: nicheList,
          regions: regionList,
          filterEmpty,
          filterDuplicates,
          filterLandlines,
          filterWithWebsite,
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
  const [sort, setSort] = useState<"reviews" | "rating" | "created_at">("reviews");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [ramoFilter, setRamoFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [ratingMin, setRatingMin] = useState("");
  const [reviewsMin, setReviewsMin] = useState("");
  const [hasWebsite, setHasWebsite] = useState<"only_empty" | "all" | "only_with">("only_empty");
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
      });
      if (ramoFilter) params.set("ramo", ramoFilter);
      if (regionFilter) params.set("region", regionFilter);
      if (ratingMin) params.set("ratingMin", ratingMin);
      if (reviewsMin) params.set("reviewsMin", reviewsMin);
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
  }, [page, limit, sort, order, ramoFilter, regionFilter, showOptOut, hasWebsite, ratingMin, reviewsMin]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // Auto-pull após scraper parar → atualiza lista
  useEffect(() => {
    if (!isRunning && scraperLeadsCount > 0 && tab === "leads") {
      const t = setTimeout(fetchLeads, 800);
      return () => clearTimeout(t);
    }
  }, [isRunning, scraperLeadsCount, tab, fetchLeads]);

  // Filtros client-side p/ hasWebsite + ratingMin + reviewsMin (API não suporta ainda)
  const filteredLeads = useMemo(() => {
    return leads.filter((l) => {
      const isDisparado = l.primeiro_contato_source === "disparo" || disparoJids.has(l.remoteJid);
      if (disparoFilter === "pending" && isDisparado) return false;
      if (disparoFilter === "sent" && !isDisparado) return false;
      const hasW = !!(l.website && l.website.trim());
      if (hasWebsite === "only_empty" && hasW) return false;
      if (hasWebsite === "only_with" && !hasW) return false;
      if (ratingMin) {
        const r = parseFloat(l.rating || "0");
        if (isNaN(r) || r < Number(ratingMin)) return false;
      }
      if (reviewsMin) {
        const rv = parseInt(l.reviews || "0", 10);
        if (isNaN(rv) || rv < Number(reviewsMin)) return false;
      }
      return true;
    });
  }, [leads, hasWebsite, ratingMin, reviewsMin, disparoFilter, disparoJids]);

  // Ranking: reviews desc default. Score = reviews * rating (proxy importância)
  const rankedLeads = useMemo(() => {
    const sorted = [...filteredLeads].sort((a, b) => {
      const ra = parseInt(a.reviews || "0", 10) || 0;
      const rb = parseInt(b.reviews || "0", 10) || 0;
      const sa = parseFloat(a.rating || "0") || 0;
      const sb = parseFloat(b.rating || "0") || 0;
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
      if (j.success) setAutomations(j.automations || []);
    } catch (e) { console.error("loadAutomations", e); }
  }, []);

  useEffect(() => { loadAutomations(); }, [loadAutomations]);

  const loadAutoLogs = useCallback(async (id: string) => {
    try {
      const { data } = await supabase
        .from("automation_logs")
        .select("id, kind, level, message, created_at")
        .eq("automation_id", id)
        .order("created_at", { ascending: false })
        .limit(100);
      setAutoLogs(prev => ({ ...prev, [id]: (data as AutoLog[]) || [] }));
    } catch { /* noop */ }
  }, []);

  const createAutomation = async () => {
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
            captureAllReviews: autoCaptureAllReviews || autoReviewsAi,
            reviews_ai: autoReviewsAi
              ? { enabled: true, model: autoReviewsAiModel || null, prompt: autoReviewsAiPrompt || null }
              : { enabled: false },
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
    try {
      if (action === "delete") {
        if (!confirm("Deletar esta automação?")) return;
        await fetch(`/api/automations/${id}`, { method: "DELETE" });
      } else {
        await fetch(`/api/automations/${id}/${action}`, { method: "POST" });
      }
      loadAutomations();
    } catch (e: any) { alert("Erro: " + e.message); }
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
      const { data } = await supabase
        .from("campaign_logs")
        .select("*")
        .eq("campaign_id", activeLogCampaignId)
        .order("created_at", { ascending: true })
        .limit(200);
      setCampLogs(data || []);
    }
    fetchInitialLogs();

    const channel = supabase
      .channel(`ps-logs-${activeLogCampaignId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "campaign_logs", filter: `campaign_id=eq.${activeLogCampaignId}` },
        (payload) => {
          setCampLogs(prev => [...prev, payload.new as any].slice(-200));
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [activeLogCampaignId]);

  useEffect(() => {
    campLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [campLogs]);

  async function refreshLogs() {
    if (!activeLogCampaignId) return;
    const { data } = await supabase
      .from("campaign_logs")
      .select("*")
      .eq("campaign_id", activeLogCampaignId)
      .order("created_at", { ascending: true })
      .limit(200);
    setCampLogs(data || []);
  }

  async function clearLogs(campaignId: string) {
    if (!confirm("Apagar todo o histórico de logs desta campanha?")) return;
    const { error } = await supabase.from("campaign_logs").delete().eq("campaign_id", campaignId);
    if (error) alert("Erro: " + error.message);
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

    const channel = supabase
      .channel(`ps-live-${runningIds.join("-")}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "campaign_logs" },
        (payload) => {
          const row = payload.new as any;
          if (!runningIds.includes(row.campaign_id)) return;
          setLatestLogByCampaign(prev => ({ ...prev, [row.campaign_id]: row }));
          const m = row.message?.match(/Aguardando\s+(\d+)s/i);
          if (m) {
            const secs = parseInt(m[1], 10);
            const startMs = new Date(row.created_at).getTime();
            setCountdowns(prev => ({ ...prev, [row.campaign_id]: { secs, nextAt: startMs + secs * 1000 } }));
          }
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(t);
      supabase.removeChannel(channel);
    };
  }, [campaigns]);

  const previewFor = (lead: Lead) => {
    const ctx: TemplateContext = {
      nome_negocio: lead.nome_negocio || "",
      ramo_negocio: lead.ramo_negocio || "",
      telefone: lead.telefone || lead.remoteJid.split("@")[0],
      endereco: lead.endereco || "",
      avaliacao: lead.rating || "",
      reviews: lead.reviews || "",
      website: lead.website || "",
      variables: { vendedor },
    };
    return renderTemplate(template, ctx);
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
    const withW = rankedLeads.filter((l) => l.website && l.website.trim()).length;
    const withoutW = rankedLeads.length - withW;
    const rated = rankedLeads.map((l) => parseFloat(l.rating || "0")).filter((r) => !isNaN(r) && r > 0);
    const avgRating = rated.length
      ? (rated.reduce((s, r) => s + r, 0) / rated.length).toFixed(1)
      : "0";
    const totalReviews = rankedLeads.reduce((s, l) => s + (parseInt(l.reviews || "0", 10) || 0), 0);
    return { withW, withoutW, avgRating, totalReviews };
  }, [rankedLeads]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header />
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="px-3 sm:px-6 py-4 max-w-[1600px] mx-auto w-full">
        {/* Tabs */}
        <div className="flex gap-1 border-b border-white/10 mb-4 overflow-x-auto sticky top-0 bg-background/95 backdrop-blur z-20 -mx-3 sm:-mx-6 px-3 sm:px-6 py-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "px-4 py-2 text-xs font-bold uppercase tracking-wider border-b-2 transition-colors whitespace-nowrap",
                tab === t.key ? "border-primary text-primary" : "border-transparent text-white/50 hover:text-white"
              )}
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
        </div>

        {/* TAB CAPTURA */}
        {tab === "captura" && (
          <div className="space-y-3 max-w-3xl">
            <Card className="border-white/10 bg-white/[0.02]">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white/70">
                  <Rocket className="w-4 h-4" /> Captura automática (reusa Captador Maps)
                </div>
                <div className="text-xs text-white/50">
                  A captura roda o mesmo engine do Captador Maps e popula a coluna <code className="bg-black/40 px-1 rounded">website</code> em leads.
                  Depois de pronta, vá pra aba Leads — o filtro &quot;sem site&quot; já vem ativo.
                </div>

                <div>
                  <label className="text-xs text-white/60">Nichos (1 por linha)</label>
                  <Textarea value={niches} onChange={(e) => setNiches(e.target.value)} rows={3} placeholder={"pizzaria\ndentista\nacademia"} />
                </div>
                <div>
                  <label className="text-xs text-white/60">Regiões (1 por linha)</label>
                  <Textarea value={regions} onChange={(e) => setRegions(e.target.value)} rows={3} placeholder={"São Paulo SP\nCentro, Belo Horizonte MG"} />
                </div>

                <div className="space-y-3 rounded-lg border border-white/10 p-3 bg-white/[0.02]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <Filter className="w-3 h-3 text-white/60" />
                      <label className="text-xs font-semibold text-white/60 uppercase tracking-wider">Filtros Automáticos</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <label htmlFor="ps-capture-all-reviews" className="text-xs text-white/60 cursor-pointer">Capturar todas as avaliações</label>
                      <Switch id="ps-capture-all-reviews" checked={captureAllReviews} onCheckedChange={setCaptureAllReviews} />
                    </div>
                  </div>
                  <p className="text-[11px] text-white/50">Quando ativado, carrega e salva todos os comentários e avaliações disponíveis no Google Maps. A captação pode levar mais tempo.</p>

                  {/* Resumo de avaliações com IA (reviews-ai) */}
                  <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor="ps-reviews-ai" className="text-xs font-semibold text-white/70 cursor-pointer">Resumir avaliações com IA</label>
                      <Switch id="ps-reviews-ai" checked={reviewsAiEnabled} onCheckedChange={(v) => { setReviewsAiEnabled(v); if (v) setCaptureAllReviews(true); }} />
                    </div>
                    <p className="text-[11px] text-white/50">
                      Liga &quot;Capturar todas as avaliações&quot; automaticamente. Cada lead capturado é resumido NA HORA pela IA com o prompt abaixo (todos os comentários vão junto). O resumo fica em <code className="bg-black/40 px-1 rounded">{"{{resumo_avaliacoes}}"}</code> nos disparos.
                    </p>
                    {reviewsAiEnabled && (
                      <>
                        <div>
                          <label className="text-xs text-white/60">Modelo de IA</label>
                          <select value={reviewsAiModel} onChange={(e) => setReviewsAiModel(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm">
                            {loadingAiModels && <option value="">Carregando…</option>}
                            {!loadingAiModels && aiModels.length === 0 && <option value="">(sem modelos — admin precisa configurar API key)</option>}
                            <ModelOptions models={aiModels as any} />
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-white/60">Prompt (vazio = padrão: ELOGIOS / RECLAMAÇÕES / GANCHO / NOTA GERAL)</label>
                          <Textarea value={reviewsAiPrompt} onChange={(e) => setReviewsAiPrompt(e.target.value)} rows={3}
                            placeholder="Ex: Resuma em tom de vendas, focando dores que um site profissional resolveria…"
                            className="bg-black/40 border-white/10 font-mono text-xs" />
                        </div>
                        <Button onClick={runReviewsAi} disabled={reviewsAiRunning} size="sm" className="w-full">
                          {reviewsAiRunning ? "Analisando…" : `Analisar avaliações (${selected.size > 0 ? selected.size : leads.length} lead${selected.size > 0 ? " selecionado" : ""})`}
                        </Button>
                      </>
                    )}
                  </div>

                  {[
                    { label: "Remover leads sem telefone", value: filterEmpty, set: setFilterEmpty },
                    { label: "Remover telefones duplicados", value: filterDuplicates, set: setFilterDuplicates },
                    { label: "Remover telefones fixos", value: filterLandlines, set: setFilterLandlines },
                    { label: "Capturar somente leads sem site", value: filterWithWebsite, set: setFilterWithWebsite },
                  ].map((f) => (
                    <div
                      key={f.label}
                      className="flex items-center justify-between p-2 rounded-lg hover:bg-white/5 cursor-pointer"
                      onClick={() => f.set(!f.value)}
                    >
                      <span className="text-sm text-white/90 select-none flex-1">{f.label}</span>
                      <input
                        type="checkbox"
                        checked={f.value}
                        onChange={(e) => f.set(e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 accent-primary cursor-pointer"
                      />
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <label className="text-xs text-white/60 flex items-center gap-2">
                    <Switch checked={maxLeads > 0} onCheckedChange={(v) => setMaxLeads(v ? 50 : 0)} />
                    Limite de leads
                  </label>
                  {maxLeads > 0 && (
                    <Input type="number" value={maxLeads} onChange={(e) => setMaxLeads(Number(e.target.value))} className="w-24" min={1} max={500} />
                  )}
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

            {/* Resultado do resumo de avaliações com IA */}
            {reviewsAiResults && (
              <Card className="border-cyan-500/20 bg-white/[0.02]">
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold uppercase tracking-wider text-cyan-300/80">
                      Resumo de avaliações (IA) · {reviewsAiResults.filter((r) => r.ok).length}/{reviewsAiResults.length} ok
                    </div>
                    <button type="button" onClick={() => setReviewsAiResults(null)} className="text-white/40 hover:text-white text-xs">fechar ✕</button>
                  </div>
                  {reviewsAiResults.map((r) => (
                    <div key={r.lead_id} className={`rounded-lg border p-2 text-xs ${r.ok ? "border-white/10 bg-black/30" : "border-red-500/30 bg-red-500/5"}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-white/80">{r.nome_negocio || `Lead #${r.lead_id}`}</span>
                        {r.cached && <span className="px-1.5 py-0.5 rounded bg-white/10 text-white/50 text-[9px]">CACHE</span>}
                      </div>
                      {r.ok
                        ? <pre className="whitespace-pre-wrap font-sans text-white/70 leading-relaxed">{r.resumo}</pre>
                        : <span className="text-red-300/80">Erro: {r.error}</span>}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Log panel */}
            {logs.length > 0 && (
              <Card className="border-white/10 bg-black/40">
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white/50 mb-2">
                    <Terminal className="w-3.5 h-3.5" /> Log
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
            {/* Stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3">
                <div className="text-xs text-white/50">Sem site</div>
                <div className="text-2xl font-bold text-red-400">{stats.withoutW}</div>
              </CardContent></Card>
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3">
                <div className="text-xs text-white/50">Com site</div>
                <div className="text-2xl font-bold text-green-400">{stats.withW}</div>
              </CardContent></Card>
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3">
                <div className="text-xs text-white/50">Rating médio</div>
                <div className="text-2xl font-bold text-amber-400">{stats.avgRating} ★</div>
              </CardContent></Card>
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3">
                <div className="text-xs text-white/50">Total reviews</div>
                <div className="text-2xl font-bold text-blue-400">{stats.totalReviews.toLocaleString("pt-BR")}</div>
              </CardContent></Card>
            </div>

            {/* Filters */}
            <Card className="border-white/10 bg-white/[0.02]">
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white/50">
                  <Filter className="w-3.5 h-3.5" /> Filtros
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <Input placeholder="Ramo (pizzaria)" value={ramoFilter} onChange={(e) => setRamoFilter(e.target.value)} className="w-40" />
                  <Input placeholder="Região" value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} className="w-40" />
                  <Input placeholder="Nota mín (0-5)" type="number" step="0.1" min="0" max="5" value={ratingMin} onChange={(e) => setRatingMin(e.target.value)} className="w-28" />
                  <Input placeholder="Avaliações mín" type="number" min="0" value={reviewsMin} onChange={(e) => setReviewsMin(e.target.value)} className="w-32" />
                  <Select value={hasWebsite} onValueChange={(v: string | null) => setHasWebsite((v as any) || "only_empty")}>
                    <SelectTrigger className="w-40"><SelectValue placeholder="Presença site">{HAS_WEBSITE_LABELS[hasWebsite] || "Presença site"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="only_empty">Sem site</SelectItem>
                      <SelectItem value="all">Todos os sites</SelectItem>
                      <SelectItem value="only_with">Com site</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sort} onValueChange={(v: string | null) => setSort((v as any) || "reviews")}>
                    <SelectTrigger className="w-36"><SelectValue placeholder="Ordenar por">{SORT_LABELS[sort] || "Avaliações"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reviews">Avaliações</SelectItem>
                      <SelectItem value="rating">Nota</SelectItem>
                      <SelectItem value="created_at">Data captura</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={order} onValueChange={(v: string | null) => setOrder((v as any) || "desc")}>
                    <SelectTrigger className="w-36"><SelectValue placeholder="Ordem">{ORDER_LABELS[order] || "Maior → menor"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="desc">Maior → menor</SelectItem>
                      <SelectItem value="asc">Menor → maior</SelectItem>
                    </SelectContent>
                  </Select>
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
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">Disparo:</span>
                  <div className="flex bg-white/5 p-0.5 rounded-lg border border-white/10">
                    <Button variant="ghost" size="sm" className={cn("h-7 px-3 text-xs rounded-md transition-all", disparoFilter === "all" ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80")}>
                      <span onClick={() => setDisparoFilter("all")}>Todos</span>
                    </Button>
                    <Button variant="ghost" size="sm" className={cn("h-7 px-3 text-xs rounded-md transition-all gap-1", disparoFilter === "pending" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "text-white/50 hover:text-white/80 border border-transparent")}>
                      <span className="flex items-center gap-1" onClick={() => setDisparoFilter("pending")}><Send className="w-3 h-3" /> Pendentes</span>
                    </Button>
                    <Button variant="ghost" size="sm" className={cn("h-7 px-3 text-xs rounded-md transition-all gap-1", disparoFilter === "sent" ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30" : "text-white/50 hover:text-white/80 border border-transparent")}>
                      <span className="flex items-center gap-1" onClick={() => setDisparoFilter("sent")}><CheckCircle2 className="w-3 h-3" /> Disparados</span>
                    </Button>
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
              <span>{selected.size} selecionados · ordenado por {sort === "reviews" ? "avaliações" : sort === "rating" ? "nota" : "data captura"}</span>
            </div>

            {/* Table */}
            <Card className="border-white/10 bg-white/[0.02]">
              <CardContent className="p-0 overflow-x-auto">
                {loadingLeads ? (
                  <div className="p-8 text-center text-white/40"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Carregando…</div>
                ) : rankedLeads.length === 0 ? (
                  <div className="p-8 text-center text-white/40">
                    Sem leads com esses filtros. Vá na aba Captura pra extrair empresas.
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-white/[0.03] text-white/50 uppercase tracking-wider">
                      <tr>
                        <th className="p-2 text-left w-8"><input type="checkbox" checked={selected.size === rankedLeads.length && rankedLeads.length > 0} onChange={selectAllVisible} /></th>
                        <th className="p-2 text-left">#</th>
                        <th className="p-2 text-left">Negócio</th>
                        <th className="p-2 text-left">Ramo</th>
                        <th className="p-2 text-left">Telefone</th>
                        <th className="p-2 text-left">Nota</th>
                        <th className="p-2 text-left">Avaliações</th>
                        <th className="p-2 text-left">Site</th>
                        <th className="p-2 text-left">Disparo</th>
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
                            <td className="p-2"><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l)} /></td>
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
                            </td>
                            <td className="p-2">{l.ramo_negocio || "—"}</td>
                            <td className="p-2 font-mono text-green-300">{l.telefone || l.remoteJid.split("@")[0]}</td>
                            <td className="p-2">
                              {l.rating && (
                                <span className="inline-flex items-center gap-1">
                                  <Star className="w-3 h-3 text-amber-400 fill-amber-400" />{l.rating}
                                </span>
                              )}
                            </td>
                            <td className="p-2 font-bold">
                              <span className="inline-flex items-center gap-1">
                                <TrendingUp className="w-3 h-3 text-blue-400" />{parseInt(l.reviews || "0", 10).toLocaleString("pt-BR")}
                              </span>
                            </td>
                            <td className="p-2">
                              {hasW ? (
                                <Badge variant="outline" className="text-green-400 border-green-500/30">
                                  <Link2 className="w-3 h-3 mr-1" />tem
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-red-400 border-red-500/30">
                                  <Link2Off className="w-3 h-3 mr-1" />sem
                                </Badge>
                              )}
                            </td>
                            <td className="p-2">
                              {(l.primeiro_contato_source === "disparo" || disparoJids.has(l.remoteJid)) ? (
                                <Badge variant="outline" className="text-cyan-400 border-cyan-500/30 bg-cyan-500/5" title={l.primeiro_contato_at ? `Disparado em ${new Date(l.primeiro_contato_at).toLocaleDateString("pt-BR")}` : "Já recebeu disparo"}>
                                  <Send className="w-3 h-3 mr-1" />Enviado
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-emerald-400/60 border-emerald-500/20">
                                  <Clock className="w-3 h-3 mr-1" />Pendente
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
                                <Button variant="ghost" size="sm" onClick={() => markOptOut(l)} title="Marcar descadastro">
                                  <Ban className="w-3 h-3" />
                                </Button>
                              )}
                            </td>
                            <td className="p-2">
                              <div className="flex items-center gap-1">
                                <a href={mUrl} target="_blank" rel="noopener noreferrer" title="Ver no Google Maps">
                                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300">
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </Button>
                                </a>
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => deleteLeads([l.id])} title="Deletar lead">
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
                <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3 space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-white/50">Template</div>
                  <div className="space-y-1.5">
                    <p className="text-[9px] uppercase font-bold text-white/40">Variáveis disponíveis (clica pra inserir):</p>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { key: "saudacao",          label: "Saudação",      hint: "Bom dia / Boa tarde / Boa noite" },
                        { key: "nome",              label: "Nome",          hint: "Push name do WhatsApp (fallback empresa)" },
                        { key: "nome_empresa",      label: "Empresa",       hint: "leads_extraidos.nome_negocio" },
                        { key: "primeiro_nome",     label: "1ª palavra",    hint: "Primeira palavra do nome empresa" },
                        { key: "ramo",              label: "Ramo",          hint: "leads_extraidos.ramo_negocio" },
                        { key: "categoria",         label: "Categoria",     hint: "Categoria Google Maps" },
                        { key: "endereco",          label: "Endereço",      hint: "Endereço completo" },
                        { key: "website",           label: "Website",       hint: "Site do lead" },
                        { key: "avaliacao",         label: "Avaliação",     hint: "Nota Google (1-5)" },
                        { key: "reviews",           label: "Reviews",       hint: "Qtd. de reviews" },
                        { key: "resumo_avaliacoes", label: "Resumo aval.",  hint: "Resumo IA das avaliações do Google (reviews-ai)" },
                        { key: "telefone",          label: "Telefone",      hint: "Número limpo" },
                        { key: "vendedor",          label: "Vendedor",      hint: "Nome do vendedor preenchido abaixo" },
                      ].map(v => (
                        <button
                          key={v.key} type="button" title={v.hint}
                          onClick={() => setTemplate((template || "") + `{{${v.key}}}`)}
                          className="px-2 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20 text-[10px] cursor-pointer flex items-center gap-1"
                        >
                          <span className="font-bold text-cyan-100">{v.label}</span>
                          <code className="text-[9px] font-mono text-cyan-300/70">{`{{${v.key}}}`}</code>
                        </button>
                      ))}
                    </div>
                  </div>
                  <Textarea value={template} onChange={(e) => setTemplate(e.target.value)} rows={5} className="text-sm font-mono bg-black/40 border-white/10" />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white/50">Vendedor:</span>
                    <Input value={vendedor} onChange={(e) => setVendedor(e.target.value)} className="w-48" />
                  </div>
                </CardContent></Card>

                <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3 space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-white/50">Filtros de envio</div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <Input placeholder="Nota mín (0-5)" type="number" step="0.1" min="0" max="5" value={ratingMin} onChange={(e) => setRatingMin(e.target.value)} className="w-28" />
                    <Input placeholder="Avaliações mín" type="number" min="0" value={reviewsMin} onChange={(e) => setReviewsMin(e.target.value)} className="w-32" />
                    <Select value={sort} onValueChange={(v: string | null) => setSort((v as any) || "reviews")}>
                      <SelectTrigger className="w-36"><SelectValue placeholder="Ordenar por">{SORT_LABELS[sort] || "Avaliações"}</SelectValue></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="reviews">Avaliações</SelectItem>
                        <SelectItem value="rating">Nota</SelectItem>
                        <SelectItem value="created_at">Data captura</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={order} onValueChange={(v: string | null) => setOrder((v as any) || "desc")}>
                      <SelectTrigger className="w-40"><SelectValue placeholder="Ordem">{ORDER_LABELS[order] || "Maior → menor"}</SelectValue></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="desc">Maior → menor</SelectItem>
                        <SelectItem value="asc">Menor → maior</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="text-xs text-white/40">
                    {rankedLeads.length} leads elegíveis após filtros · {selected.size} selecionados
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setSelected(new Map(rankedLeads.map((l) => [l.id, l]))); }}>
                      Selecionar elegíveis ({rankedLeads.length})
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setSelected(new Map())}>
                      Limpar seleção
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
                        <Button variant="ghost" size="sm" onClick={() => toggleSelect(lead)}>
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
          <div className="max-w-2xl space-y-3">
            {selected.size === 0 ? (
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-8 text-center text-white/40">
                Selecione leads na aba Leads primeiro.
                <div className="mt-3"><Button variant="outline" onClick={() => setTab("leads")}>← Leads</Button></div>
              </CardContent></Card>
            ) : (
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-4 space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-white/50">Nova campanha de prospecção</div>
                <div>
                  <label className="text-xs text-white/60">Nome da campanha</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Pizzarias SP sem site — Agosto" />
                </div>
                <div>
                  <label className="text-xs text-white/60">Instância WhatsApp</label>
                  <Select value={instanceName} onValueChange={(v: string | null) => setInstanceName(v || "")}>
                    <SelectTrigger><SelectValue placeholder="Selecione…">{instanceName || "Selecione…"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      {instances.map((i) => (
                        <SelectItem key={i.instance_name} value={i.instance_name}>
                          {i.instance_name}{i.status ? ` — ${i.status}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-white/60">Intervalo mín (s)</label>
                    <Input type="number" value={minSec} onChange={(e) => setMinSec(Number(e.target.value))} /></div>
                  <div><label className="text-xs text-white/60">Intervalo máx (s)</label>
                    <Input type="number" value={maxSec} onChange={(e) => setMaxSec(Number(e.target.value))} /></div>
                  <div><label className="text-xs text-white/60">Hora inicial</label>
                    <Input type="number" value={startHour} onChange={(e) => setStartHour(Number(e.target.value))} min={0} max={23} /></div>
                  <div><label className="text-xs text-white/60">Hora final</label>
                    <Input type="number" value={endHour} onChange={(e) => setEndHour(Number(e.target.value))} min={0} max={23} /></div>
                </div>

                <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wider text-white/50">Reescrever cada mensagem com IA</div>
                      <div className="text-xs text-white/40">Personaliza e varia o texto por lead pra reduzir banimento (igual Automação).</div>
                    </div>
                    <Switch checked={personalizeWithAi} onCheckedChange={setPersonalizeWithAi} />
                  </div>
                  {personalizeWithAi && (
                    <>
                      <div>
                        <label className="text-xs text-white/60">Modelo de IA</label>
                        <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm">
                          {loadingAiModels && <option value="">Carregando…</option>}
                          {!loadingAiModels && aiModels.length === 0 && <option value="">(sem modelos — admin precisa configurar API key)</option>}
                          <ModelOptions models={aiModels as any} />
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-white/60">Prompt de reescrita</label>
                        <Textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} rows={4} placeholder="Ex: Reescreva a mensagem a seguir de forma natural, variação conversacional, mantenha os dados do lead mas evite linguagem padrão. Não use emojis." />
                      </div>
                    </>
                  )}
                </CardContent></Card>

                <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wider text-white/50">Humanizar Mensagens (Picotar)</div>
                      <div className="text-xs text-white/40">Divide a mensagem em várias partes e simula tempo de digitação entre elas (igual ao Agente de IA).</div>
                    </div>
                    <Switch checked={humanizeMessages} onCheckedChange={setHumanizeMessages} />
                  </div>
                </CardContent></Card>
                <div className="text-xs text-white/50">
                  <Globe className="w-3.5 h-3.5 inline mr-1" /> {selected.size} alvos sem site
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
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-8 text-center text-white/40">
                Nenhuma campanha ainda. Crie uma na aba Disparo.
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
                            <Smartphone className="w-3 h-3" /> {c.instance_name}
                            <span className="opacity-30">·</span>
                            <Clock className="w-3 h-3" /> {c.allowed_start_hour}h-{c.allowed_end_hour}h
                            <span className="opacity-30">·</span>
                            jitter {c.min_interval_seconds}-{c.max_interval_seconds}s
                          </div>
                        </div>
                        <Badge variant="outline" className={
                          c.status === "running" ? "text-green-400 border-green-500/30" :
                          c.status === "paused" ? "text-amber-400 border-amber-500/30" :
                          c.status === "done" ? "text-blue-400 border-blue-500/30" :
                          "text-white/50"
                        }>{c.status}</Badge>
                      </div>

                      <div className="grid grid-cols-4 gap-2 text-xs">
                        <div className="bg-black/30 p-2 rounded"><div className="text-white/40">Alvos</div><div className="text-white font-bold">{c.total_targets}</div></div>
                        <div className="bg-black/30 p-2 rounded"><div className="text-green-400/60">Enviados</div><div className="text-green-400 font-bold">{c.sent_count}</div></div>
                        <div className="bg-black/30 p-2 rounded"><div className="text-red-400/60">Falhas</div><div className="text-red-400 font-bold">{c.failed_count}</div></div>
                        <div className="bg-black/30 p-2 rounded"><div className="text-amber-400/60">Pulados</div><div className="text-amber-400 font-bold">{c.skipped_count || 0}</div></div>
                      </div>

                      <div className="w-full h-1.5 bg-black/40 rounded-full overflow-hidden">
                        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                      </div>

                      {/* Countdown timer + live log */}
                      {c.status === "running" && (
                        <>
                          <CountdownCard cd={countdowns[c.id]} />

                          {latestLogByCampaign[c.id] && (
                            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse mt-1.5 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-[9px] font-black uppercase tracking-widest text-emerald-400">
                                  Agora · {new Date(latestLogByCampaign[c.id].created_at).toLocaleTimeString()}
                                </p>
                                <p className={cn(
                                  "text-[11px] break-words mt-0.5 whitespace-pre-wrap",
                                  latestLogByCampaign[c.id].level === "error" ? "text-red-300"
                                  : latestLogByCampaign[c.id].level === "warning" ? "text-yellow-300"
                                  : latestLogByCampaign[c.id].level === "success" ? "text-emerald-200"
                                  : "text-white/80"
                                )}>{latestLogByCampaign[c.id].message}</p>
                              </div>
                            </div>
                          )}
                        </>
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
                        className="w-full justify-between h-8 bg-white/5 border border-white/5 hover:bg-white/10 text-[10px] uppercase font-black"
                      >
                        <span className="flex items-center gap-2">
                          <MessageSquare className="w-3 h-3 text-cyan-300" />
                          {activeTargetsCampaignId === c.id ? "Ocultar mensagens" : `Ver mensagens enviadas (${c.sent_count || 0}/${c.total_targets || 0})`}
                        </span>
                        <ChevronRight className={cn("w-3 h-3 transition-transform", activeTargetsCampaignId === c.id && "rotate-90")} />
                      </Button>

                      {activeTargetsCampaignId === c.id && (
                        <div className="mt-2 rounded-xl bg-black/40 border border-white/5 p-3 flex flex-col max-h-[420px]">
                          <div className="flex items-center justify-between mb-2 border-b border-white/5 pb-2 gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] uppercase font-black text-white/40">Histórico de envios</span>
                              {loadingTargets && <Loader2 className="w-3 h-3 animate-spin text-white/40" />}
                            </div>
                            <div className="flex items-center gap-1 text-[9px] flex-wrap">
                              {(["all", "sent", "failed", "pending"] as const).map(f => (
                                <button
                                  key={f}
                                  onClick={() => setTargetsFilter(f)}
                                  className={cn(
                                    "px-2 py-0.5 rounded-md font-black uppercase tracking-widest transition",
                                    targetsFilter === f ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/30" : "text-white/40 hover:text-white"
                                  )}
                                >
                                  {f === "all" ? `Todos (${targets.length})`
                                    : f === "sent" ? `Enviadas (${targets.filter(t => t.status === "sent").length})`
                                    : f === "failed" ? `Falhas (${targets.filter(t => t.status === "failed").length})`
                                    : `Pendentes (${targets.filter(t => t.status === "pending").length})`}
                                </button>
                              ))}
                              <Button variant="ghost" size="sm" onClick={() => loadTargets(c.id)} className="h-5 px-1.5 text-[8px] bg-white/5 hover:bg-white/10 ml-1" title="Atualizar">↻</Button>
                            </div>
                          </div>
                          <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-2">
                            {targets.length === 0 ? (
                              <p className="text-white/40 italic text-center py-10 text-[11px]">Nenhum envio ainda.</p>
                            ) : (
                              targets
                                .filter(t => targetsFilter === "all" || t.status === targetsFilter)
                                .map(t => {
                                  const phone = (t.remote_jid || "").replace("@s.whatsapp.net", "");
                                  const statusColor =
                                    t.status === "sent" ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" :
                                    t.status === "failed" ? "text-red-400 border-red-500/30 bg-red-500/10" :
                                    t.status === "skipped" ? "text-yellow-400 border-yellow-500/30 bg-yellow-500/10" :
                                    "text-white/40 border-white/10 bg-white/5";
                                  return (
                                    <div key={t.id} className="rounded-lg bg-white/[0.02] border border-white/5 p-2.5 space-y-1.5">
                                      <div className="flex items-center justify-between gap-2 flex-wrap">
                                        <div className="min-w-0 flex-1">
                                          <p className="text-[11px] font-bold text-white truncate">{t.nome_negocio || "(sem nome)"}</p>
                                          <p className="text-[9px] text-white/40 font-mono">{phone}{t.ramo_negocio ? ` · ${t.ramo_negocio}` : ""}</p>
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
          <div className="space-y-3 max-w-4xl">
            <Card className="border-white/10 bg-white/[0.02]">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white/70">
                  <Zap className="w-4 h-4" /> Automação completa (captura → disparo → follow-up)
                </div>
                <p className="text-xs text-white/50">
                  Cria uma automação que capta leads do Google Maps, dispara o template via WhatsApp e faz follow-up automático. Tudo orquestrado em segundo plano.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-white/60">Nome da automação</label>
                    <Input value={autoName} onChange={(e) => setAutoName(e.target.value)} placeholder="Ex: Pizzarias SP - Outubro" />
                  </div>
                  <div>
                    <label className="text-xs text-white/60">Instância WhatsApp</label>
                    <Select value={autoInstance} onValueChange={(v) => setAutoInstance(v || "")}>
                      <SelectTrigger><SelectValue placeholder="Selecionar…" /></SelectTrigger>
                      <SelectContent>
                        {instances.map((inst) => (
                          <SelectItem key={inst.instance_name} value={inst.instance_name}>
                            {inst.instance_name}{inst.status ? ` (${inst.status})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <label className="text-xs text-white/60">Nichos (1 por linha)</label>
                  <Textarea value={autoNiches} onChange={(e) => setAutoNiches(e.target.value)} rows={2} placeholder={"pizzaria\ndentista"} />
                </div>
                <div>
                  <label className="text-xs text-white/60">Regiões (1 por linha)</label>
                  <Textarea value={autoRegions} onChange={(e) => setAutoRegions(e.target.value)} rows={2} placeholder={"São Paulo SP\nCentro, Belo Horizonte MG"} />
                </div>

                {/* Filtros Automáticos da Automação */}
                <div className="space-y-3 rounded-lg border border-white/10 p-3 bg-white/[0.02]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <Filter className="w-3 h-3 text-white/60" />
                      <label className="text-xs font-semibold text-white/60 uppercase tracking-wider">Filtros Automáticos da Captura</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <label htmlFor="auto-capture-all-reviews" className="text-xs text-white/60 cursor-pointer">Capturar todas as avaliações</label>
                      <Switch id="auto-capture-all-reviews" checked={autoCaptureAllReviews || autoReviewsAi} onCheckedChange={setAutoCaptureAllReviews} />
                    </div>
                  </div>
                  <p className="text-[11px] text-white/50">Configurações de filtragem que serão aplicadas durante a fase de captação de leads desta automação.</p>

                  {[
                    { label: "Remover leads sem telefone", value: autoFilterEmpty, set: setAutoFilterEmpty },
                    { label: "Remover telefones duplicados", value: autoFilterDuplicates, set: setAutoFilterDuplicates },
                    { label: "Remover telefones fixos", value: autoFilterLandlines, set: setAutoFilterLandlines },
                    { label: "Capturar somente leads sem site", value: autoFilterWithWebsite, set: setAutoFilterWithWebsite },
                  ].map((f) => (
                    <div
                      key={f.label}
                      className="flex items-center justify-between p-2 rounded-lg hover:bg-white/5 cursor-pointer"
                      onClick={() => f.set(!f.value)}
                    >
                      <span className="text-sm text-white/90 select-none flex-1">{f.label}</span>
                      <input
                        type="checkbox"
                        checked={f.value}
                        onChange={(e) => f.set(e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 accent-primary cursor-pointer"
                      />
                    </div>
                  ))}
                </div>

                {/* Template de disparo + variáveis */}
                <div className="space-y-1.5">
                  <p className="text-[9px] uppercase font-bold text-white/40">Variáveis disponíveis (clica pra inserir):</p>
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
                      { key: "resumo_avaliacoes", label: "Resumo aval.", hint: "Resumo IA das avaliações do Google (reviews-ai)" },
                      { key: "telefone",      label: "Telefone",     hint: "Número limpo" },
                      { key: "data",          label: "Data",         hint: "DD/MM/AAAA" },
                      { key: "hora",          label: "Hora",         hint: "HH:MM" },
                    ].map(v => (
                      <button
                        key={v.key} type="button" title={v.hint}
                        onClick={() => setAutoTemplate((autoTemplate || "") + `{{${v.key}}}`)}
                        className="px-2 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20 text-[10px] cursor-pointer flex items-center gap-1"
                      >
                        <span className="font-bold text-cyan-100">{v.label}</span>
                        <code className="text-[9px] font-mono text-cyan-300/70">{`{{${v.key}}}`}</code>
                      </button>
                    ))}
                  </div>
                  <label className="text-xs text-white/60">Mensagem-base (template de disparo)</label>
                  <Textarea value={autoTemplate} onChange={(e) => setAutoTemplate(e.target.value)} rows={3}
                    placeholder="Ex: {{saudacao}} {{nome_empresa}}! Vi vocês no Maps…"
                    className="bg-black/40 border-white/10 font-mono text-xs" />
                </div>

                {/* Intervalos de disparo */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-white/60">Máx. leads a captar</label>
                    <Input type="number" value={autoMaxLeads} onChange={(e) => setAutoMaxLeads(Number(e.target.value))} min={1} />
                  </div>
                  <div>
                    <label className="text-xs text-white/60">Intervalo mín. entre disparos (s)</label>
                    <Input type="number" value={autoMinSec} onChange={(e) => setAutoMinSec(Number(e.target.value))} min={5} />
                  </div>
                  <div>
                    <label className="text-xs text-white/60">Intervalo máx. entre disparos (s)</label>
                    <Input type="number" value={autoMaxSec} onChange={(e) => setAutoMaxSec(Number(e.target.value))} min={autoMinSec} />
                  </div>
                </div>

                {/* IA personaliza disparo */}
                <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-2">
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <Switch checked={autoPersonalize} onCheckedChange={setAutoPersonalize} />
                    <Bot className="w-3.5 h-3.5 text-cyan-300" />
                    <span className="font-bold text-cyan-200">Reescrever cada disparo com IA</span>
                  </label>
                  <p className="text-[10px] text-white/40 leading-relaxed">
                    Cada lead recebe um <strong>texto único</strong> gerado pela IA a partir do template + dados do lead. Reduz risco de banimento por padrão repetitivo no WhatsApp.
                  </p>
                  {autoPersonalize && (
                    <div className="space-y-2 pl-3 border-l-2 border-cyan-500/30">
                      <div>
                        <label className="text-[10px] uppercase font-bold text-white/40">Modelo de IA</label>
                        <select
                          value={autoAiModel || ""}
                          onChange={(e) => setAutoAiModel(e.target.value)}
                          className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 h-8 text-xs"
                        >
                          {aiModels.length === 0 ? (
                            <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — configure API key em Configurações)"}</option>
                          ) : (
                            <ModelOptions models={aiModels as any} />
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-white/40">Prompt para a IA (como reescrever)</label>
                        <Textarea rows={3}
                          value={autoAiPrompt}
                          onChange={(e) => setAutoAiPrompt(e.target.value)}
                          placeholder="Ex: Reescreva a mensagem-base de forma natural e única para cada cliente, mantendo o tom amigável e profissional. Não use emojis exagerados. Adapte ao ramo do negócio se for relevante. Mensagem deve ter no máximo 3 frases."
                          className="bg-black/40 border-white/10 font-mono text-xs" />
                        <p className="text-[9px] text-white/30 mt-1">
                          A IA recebe: prompt + mensagem-base + dados do lead (nome, ramo). Devolve a mensagem final que será enviada.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Humanizar disparo (picotar mensagem) */}
                <div className={cn(
                  "rounded-lg border p-3 space-y-2 transition-colors",
                  autoHumanize ? "border-emerald-400/40 bg-emerald-500/5" : "border-white/10 bg-white/[0.02]"
                )}>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <Switch checked={autoHumanize} onCheckedChange={setAutoHumanize} />
                    <Scissors className="w-3.5 h-3.5 text-emerald-300" />
                    <span className="font-bold text-emerald-200">Humanizar disparo (picotar mensagem)</span>
                  </label>
                  <p className="text-[10px] text-white/40 leading-relaxed">
                    Cada disparo chega <strong>dividido em várias mensagens curtas</strong> com pausa de digitação entre elas (2-5s), igual ao Agente de IA — muito mais humano e menos risco de banimento.
                  </p>
                </div>

                {/* Resumo de avaliações com IA (antes do disparo) — reviews-ai */}
                <div className={cn(
                  "rounded-lg border p-3 space-y-2 transition-colors",
                  autoReviewsAi ? "border-cyan-400/40 bg-cyan-500/5" : "border-white/10 bg-white/[0.02]"
                )}>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <Switch checked={autoReviewsAi} onCheckedChange={setAutoReviewsAi} />
                    <Bot className="w-3.5 h-3.5 text-cyan-300" />
                    <span className="font-bold text-cyan-200">Resumir avaliações do Google com IA</span>
                  </label>
                  <p className="text-[10px] text-white/40 leading-relaxed">
                    Antes do disparo, roda a IA em todas as avaliações capturadas de cada lead e gera um resumo (elogios, reclamações e gancho). Disponível como <code className="bg-black/40 px-1 rounded">{"{{resumo_avaliacoes}}"}</code> no template. Ativa &quot;Capturar todas as avaliações&quot; automaticamente.
                  </p>
                  {autoReviewsAi && (
                    <div className="space-y-2 pl-3 border-l-2 border-cyan-500/30">
                      <div>
                        <label className="text-[10px] uppercase font-bold text-white/40">Modelo de IA</label>
                        <select
                          value={autoReviewsAiModel || ""}
                          onChange={(e) => setAutoReviewsAiModel(e.target.value)}
                          className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 h-8 text-xs"
                        >
                          {aiModels.length === 0 ? (
                            <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — configure API key)"}</option>
                          ) : (
                            <ModelOptions models={aiModels as any} />
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-white/40">Prompt (vazio = padrão)</label>
                        <Textarea rows={2}
                          value={autoReviewsAiPrompt}
                          onChange={(e) => setAutoReviewsAiPrompt(e.target.value)}
                          placeholder="Ex: Resuma as avaliações focando em dores que um site profissional resolveria…"
                          className="bg-black/40 border-white/10 font-mono text-xs" />
                      </div>
                    </div>
                  )}
                </div>

                {/* Follow-up automático */}
                <div className={cn(
                  "rounded-xl border p-4 space-y-3 transition-colors",
                  autoFollowup
                    ? "border-purple-500/20 bg-purple-500/5"
                    : "border-zinc-500/20 bg-zinc-500/5 opacity-60"
                )}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-xs font-bold uppercase tracking-wider text-purple-300 flex items-center gap-2">
                      <Repeat className="w-3.5 h-3.5" /> Follow-up automático
                    </p>
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <span className={cn("font-bold", autoFollowup ? "text-purple-200" : "text-white/40")}>
                        {autoFollowup ? "ATIVADO" : "DESATIVADO"}
                      </span>
                      <Switch checked={autoFollowup} onCheckedChange={setAutoFollowup} />
                    </label>
                  </div>
                  {!autoFollowup && (
                    <p className="text-[10px] text-white/40 italic">
                      Automação vai terminar logo após o disparo inicial. Leads nesta lista não receberão follow-up.
                    </p>
                  )}
                  {autoFollowup && (
                    <>
                      <div className="space-y-2">
                        {autoSteps.map((step, idx) => (
                          <div key={idx} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-start p-2 rounded-xl bg-black/20 border border-white/5 sm:border-none sm:bg-transparent sm:p-0">
                            <div className="flex flex-col gap-1 shrink-0 w-full sm:w-24">
                              <span className="text-[9px] uppercase font-bold text-white/40">Após (dias)</span>
                              <NumberInput min={1} fallback={1} value={step.day_offset}
                                onChange={n => {
                                  const next = [...autoSteps];
                                  next[idx] = { ...next[idx], day_offset: n };
                                  setAutoSteps(next);
                                }}
                                className="bg-black/40 border-white/10 h-8 text-xs" />
                            </div>
                            <div className="flex-1 space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-[9px] uppercase font-bold text-white/40">Mensagem do follow-up</span>
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
                                      className="px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 text-[9px] text-purple-200 cursor-pointer"
                                    >
                                      +{v.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <Textarea rows={2} value={step.template}
                                onChange={e => {
                                  const next = [...autoSteps];
                                  next[idx] = { ...next[idx], template: e.target.value };
                                  setAutoSteps(next);
                                }}
                                placeholder="Ex: Olá {{nome_empresa}}! Vi os elogios em {{resumo_avaliacoes}} e..."
                                className="bg-black/40 border-white/10 font-mono text-xs" />
                            </div>
                            <Button onClick={() => setAutoSteps(autoSteps.filter((_, i) => i !== idx))}
                              variant="ghost" size="icon" className="h-8 w-8 text-red-400 self-end sm:mt-4">
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                        <Button onClick={() => setAutoSteps([...autoSteps, { day_offset: 3, template: "" }])}
                          variant="outline" className="text-[10px] uppercase font-bold gap-2 h-8">
                          <Plus className="w-3 h-3" /> Adicionar step
                        </Button>
                      </div>

                      {/* Intervalos follow-up */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-white/60">Intervalo mín. entre follow-ups (s)</label>
                          <Input type="number" value={autoFuMinSec} onChange={(e) => setAutoFuMinSec(Number(e.target.value))} min={5} />
                        </div>
                        <div>
                          <label className="text-xs text-white/60">Intervalo máx. entre follow-ups (s)</label>
                          <Input type="number" value={autoFuMaxSec} onChange={(e) => setAutoFuMaxSec(Number(e.target.value))} min={autoFuMinSec} />
                        </div>
                      </div>

                      {/* IA reescrever follow-up */}
                      <div className="border-t border-white/5 pt-3 space-y-2">
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <Switch checked={autoFollowupAi} onCheckedChange={setAutoFollowupAi} />
                          <Bot className="w-3.5 h-3.5 text-purple-300" />
                          <span className="font-bold text-purple-200">Reescrever cada follow-up com IA</span>
                        </label>
                        <p className="text-[10px] text-white/40 leading-relaxed">
                          Cada follow-up vira único, considerando o <strong>histórico da conversa</strong> daquele lead. Útil pra puxar gancho do que o cliente já disse e fugir de padrão repetitivo.
                        </p>
                        {autoFollowupAi && (
                          <div className="space-y-2 pl-3 border-l-2 border-purple-500/30">
                            <div>
                              <label className="text-[10px] uppercase font-bold text-white/40">Modelo de IA</label>
                              <select
                                value={autoFollowupAiModel || ""}
                                onChange={(e) => setAutoFollowupAiModel(e.target.value)}
                                className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 h-8 text-xs"
                              >
                                {aiModels.length === 0 ? (
                                  <option value="">{loadingAiModels ? "carregando…" : "(sem modelos — configure API key em Configurações)"}</option>
                                ) : (
                                  <ModelOptions models={aiModels as any} />
                                )}
                              </select>
                            </div>
                            <div>
                              <label className="text-[10px] uppercase font-bold text-white/40">Prompt para a IA</label>
                              <Textarea rows={3}
                                value={autoFollowupAiPrompt}
                                onChange={(e) => setAutoFollowupAiPrompt(e.target.value)}
                                placeholder="Ex: Você é um SDR cordial fazendo follow-up sem ser insistente. Use o histórico pra puxar gancho do que o cliente já mencionou. Tom natural, máximo 3 frases."
                                className="bg-black/40 border-white/10 font-mono text-xs" />
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Horário permitido */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-white/60">Enviar a partir das (h)</label>
                    <Input type="number" value={autoStartHour} onChange={(e) => setAutoStartHour(Number(e.target.value))} min={0} max={23} />
                  </div>
                  <div>
                    <label className="text-xs text-white/60">Enviar até as (h)</label>
                    <Input type="number" value={autoEndHour} onChange={(e) => setAutoEndHour(Number(e.target.value))} min={1} max={24} />
                  </div>
                </div>

                <Button onClick={createAutomation} disabled={creatingAuto} className="w-full">
                  {creatingAuto ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Zap className="w-4 h-4 mr-1" />}
                  Criar automação
                </Button>
              </CardContent>
            </Card>

            {/* Lista de automações */}
            <div className="flex justify-between items-center">
              <div className="text-xs font-bold uppercase tracking-wider text-white/50">Automações ativas</div>
              <Button variant="ghost" size="sm" onClick={loadAutomations}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Atualizar</Button>
            </div>

            {automations.length === 0 ? (
              <Card className="border-white/10 bg-white/[0.02]"><CardContent className="p-8 text-center text-white/40 text-sm">
                Nenhuma automação criada ainda.
              </CardContent></Card>
            ) : (
              <div className="space-y-2">
                {automations.map((a) => {
                  const phaseLabels: Record<string, string> = {
                    idle: "Aguardando", scraping: "Captando", dispatching: "Disparando",
                    following: "Follow-up", done: "Concluída", error: "Erro",
                  };
                  const statusColor =
                    a.status === "running" ? "text-green-400 bg-green-500/10 border-green-500/30" :
                    a.status === "paused" ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/30" :
                    a.status === "error" ? "text-red-400 bg-red-500/10 border-red-500/30" :
                    a.status === "done" ? "text-blue-400 bg-blue-500/10 border-blue-500/30" :
                    "text-white/50 bg-white/5 border-white/10";
                  return (
                    <Card key={a.id} className="border-white/10 bg-white/[0.02]">
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-white truncate">{a.name}</p>
                            <p className="text-[10px] text-white/40">
                              {(a.niches || []).join(", ") || "—"} · {(a.regions || []).join(", ") || "—"} · {a.instance_name}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={cn("text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border", statusColor)}>
                              {a.status} · {phaseLabels[a.phase] || a.phase}
                            </span>
                            {a.scraped_count > 0 && (
                              <Badge className="bg-white/10 text-white/60">{a.scraped_count} leads</Badge>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap">
                          {(a.status === "draft" || a.status === "paused" || a.status === "error" || a.status === "done") && (
                            <Button size="sm" onClick={() => autoAction(a.id, "start")} className="h-7 text-[10px]">
                              <Play className="w-3 h-3 mr-1" /> {a.status === "paused" ? "Retomar" : "Iniciar"}
                            </Button>
                          )}
                          {a.status === "running" && (
                            <Button size="sm" variant="outline" onClick={() => autoAction(a.id, "pause")} className="h-7 text-[10px]">
                              <Pause className="w-3 h-3 mr-1" /> Pausar
                            </Button>
                          )}
                          <Button
                            size="sm" variant="ghost"
                            onClick={() => {
                              if (expandedAuto === a.id) { setExpandedAuto(null); }
                              else { setExpandedAuto(a.id); loadAutoLogs(a.id); }
                            }}
                            className="h-7 text-[10px] bg-white/5 hover:bg-white/10"
                          >
                            <Terminal className="w-3 h-3 mr-1" />
                            {expandedAuto === a.id ? "Ocultar logs" : "Ver logs"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => autoAction(a.id, "delete")} className="h-7 text-[10px] text-red-400 hover:bg-red-500/10">
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>

                        {a.last_error && (
                          <p className="text-[10px] text-red-300 bg-red-500/5 border border-red-500/20 rounded-md px-2 py-1">⚠ {a.last_error}</p>
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

        </div>
      </div>
    </div>
  );
}