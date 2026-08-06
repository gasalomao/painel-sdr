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
import {
  Send, Play, Pause, Square, Loader2, Search, Globe, BarChart3,
  CheckCircle2, XCircle, Star, Ban, RefreshCw, ShieldAlert,
  Rocket, Terminal, Filter, TrendingUp, Building2, Link2, Link2Off, Trash2, MapPin,
} from "lucide-react";
import { renderTemplate, type TemplateContext } from "@/lib/template-vars";
import { cn } from "@/lib/utils";

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
  ai_prompt?: string | null;
  ai_model?: string | null;
  created_at: string;
  last_error?: string | null;
};

type LogEntry = { message: string; type: string; time: string };

const TABS = [
  { key: "captura",  label: "Captura",   icon: Rocket },
  { key: "leads",    label: "Leads",     icon: Search },
  { key: "revisao",  label: "Revisão",   icon: CheckCircle2 },
  { key: "disparo",  label: "Disparo",   icon: Send },
  { key: "historico",label: "Histórico", icon: BarChart3 },
] as const;
type TabKey = typeof TABS[number]["key"];

const DEFAULT_TEMPLATE = `{{saudacao}} {{nome_empresa}}! Tudo bem?
Notei que sua empresa {{ramo}} ainda não tem site — isso tá te fazendo perder clientes que pesquisam no Google antes de comprar.
Queria te mostrar como podemos resolver rápido. Tem 2 min pra um papo? — {{vendedor}}`;

const VENDEDOR_DEFAULT = "Salomão";

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
  }, [leads, hasWebsite, ratingMin, reviewsMin]);

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

  // ----- IA rewrite (igual automação) -----
  const [personalizeWithAi, setPersonalizeWithAi] = useState(false);
  const [aiModels, setAiModels] = useState<{ id: string; name?: string; provider?: string }[]>([]);
  const [aiModel, setAiModel] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [loadingAiModels, setLoadingAiModels] = useState(false);

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
      } catch (e) { console.warn("ai-models", e); }
      finally { setLoadingAiModels(false); }
    })();
  }, []);

  const fetchCampaigns = useCallback(async () => {
    setLoadingCampaigns(true);
    try {
      const r = await fetch("/api/prospeccao-sites/campaigns", { cache: "no-store" });
      const j = await r.json();
      if (j.success) setCampaigns(j.campaigns);
    } catch (e) { console.error(e); }
    finally { setLoadingCampaigns(false); }
  }, []);
  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

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
      fetchCampaigns();
    } catch (e: any) { alert("Erro: " + e.message); }
    finally { setCreating(false); }
  };

  const actionCampaign = async (id: string, a: "start" | "pause" | "cancel") => {
    try {
      await fetch(`/api/prospeccao-sites/campaigns/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: a }),
      });
      fetchCampaigns();
    } catch (e) { console.error(e); }
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
                  Depois de pronta, vá pra aba Leads — o filtro "sem site" já vem ativo.
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
                    <SelectTrigger className="w-40"><SelectValue placeholder="Presença site" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="only_empty">Sem site</SelectItem>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="only_with">Com site</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sort} onValueChange={(v: string | null) => setSort((v as any) || "reviews")}>
                    <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reviews">Avaliações</SelectItem>
                      <SelectItem value="rating">Nota</SelectItem>
                      <SelectItem value="created_at">Data captura</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={order} onValueChange={(v: string | null) => setOrder((v as any) || "desc")}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
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
                        <th className="p-2 text-left">Maps</th>
                        <th className="p-2 text-left">Descadastro</th>
                        <th className="p-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rankedLeads.map((l, idx) => {
                        const hasW = !!(l.website && l.website.trim());
                        return (
                          <tr key={l.id} className={cn("border-t border-white/5 hover:bg-white/[0.03]", selected.has(l.id) && "bg-primary/[0.05]")}>
                            <td className="p-2"><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l)} /></td>
                            <td className="p-2 text-white/30 font-mono">{idx + 1}</td>
                            <td className="p-2 font-bold text-white">
                              <Building2 className="w-3 h-3 inline mr-1 text-white/40" />
                              {(() => {
                                const mapsUrl = l.maps_url || (l.place_id ? `https://www.google.com/maps/place/?q=place_id:${l.place_id}` : null);
                                if (mapsUrl) {
                                  return (
                                    <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="hover:text-blue-400 hover:underline" title="Abrir no Google Maps">
                                      {l.nome_negocio || "—"}
                                    </a>
                                  );
                                }
                                return l.nome_negocio || "—";
                              })()}
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
                              {(() => {
                                const mapsUrl = l.maps_url || (l.place_id ? `https://www.google.com/maps/place/?q=place_id:${l.place_id}` : null);
                                if (!mapsUrl) return <span className="text-white/20">—</span>;
                                return (
                                  <a href={mapsUrl} target="_blank" rel="noopener noreferrer" title="Abrir no Google Maps">
                                    <Badge variant="outline" className="text-blue-400 border-blue-500/30 cursor-pointer hover:bg-blue-500/10">
                                      <MapPin className="w-3 h-3 mr-1" />Maps
                                    </Badge>
                                  </a>
                                );
                              })()}
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
                              <Button variant="ghost" size="sm" onClick={() => deleteLeads([l.id])} title="Deletar lead">
                                <Trash2 className="w-3 h-3 text-red-400" />
                              </Button>
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
                  <Textarea value={template} onChange={(e) => setTemplate(e.target.value)} rows={5} className="text-sm" />
                  <div className="flex flex-wrap gap-2 text-xs text-white/40">
                    <span>Variáveis:</span>
                    <code>{"{{saudacao}}"}</code><code>{"{{nome_empresa}}"}</code><code>{"{{ramo}}"}</code>
                    <code>{"{{telefone}}"}</code><code>{"{{endereco}}"}</code><code>{"{{vendedor}}"}</code>
                  </div>
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
                      <SelectTrigger className="w-36"><SelectValue placeholder="Ordenar por" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="reviews">Avaliações</SelectItem>
                        <SelectItem value="rating">Nota</SelectItem>
                        <SelectItem value="created_at">Data captura</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={order} onValueChange={(v: string | null) => setOrder((v as any) || "desc")}>
                      <SelectTrigger className="w-40"><SelectValue placeholder="Ordem" /></SelectTrigger>
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
                          <div className="font-bold text-white text-sm">{lead.nome_negocio || "—"}</div>
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
                    <SelectTrigger><SelectValue placeholder="Selecione…" /></SelectTrigger>
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
                          {loadingAiModels && <option value="">carregando…</option>}
                          {!loadingAiModels && aiModels.length === 0 && <option value="">(sem modelos — admin precisa configurar API key)</option>}
                          {aiModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.name || m.id}{m.provider ? ` (${m.provider})` : ""}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-white/60">Prompt de reescrita</label>
                        <Textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} rows={4} placeholder="Ex: Reescreva a mensagem a seguir de forma natural, variação conversacional, mantenha os dados do lead mas evite linguagem padrão. Não use emojis." />
                      </div>
                    </>
                  )}
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
              <Button variant="ghost" size="sm" onClick={fetchCampaigns}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Atualizar</Button>
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
                        <div>
                          <div className="font-bold text-white">{c.name}</div>
                          <div className="text-xs text-white/50">{c.instance_name} · {new Date(c.created_at).toLocaleString("pt-BR")}</div>
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
                      {c.last_error && (
                        <div className="text-xs text-red-400/80 bg-red-500/10 p-2 rounded border border-red-500/20">
                          <ShieldAlert className="w-3 h-3 inline mr-1" />{c.last_error}
                        </div>
                      )}
                      <div className="flex gap-2 pt-1">
                        {(c.status === "draft" || c.status === "paused") && (
                          <Button size="sm" onClick={() => actionCampaign(c.id, "start")}><Play className="w-3.5 h-3.5 mr-1" /> Iniciar</Button>
                        )}
                        {c.status === "running" && (
                          <Button size="sm" variant="outline" onClick={() => actionCampaign(c.id, "pause")}><Pause className="w-3.5 h-3.5 mr-1" /> Pausar</Button>
                        )}
                        {c.status !== "done" && c.status !== "cancelled" && (
                          <Button size="sm" variant="ghost" onClick={() => actionCampaign(c.id, "cancel")}><Square className="w-3.5 h-3.5 mr-1" /> Cancelar</Button>
                        )}
                      </div>
                    </CardContent></Card>
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