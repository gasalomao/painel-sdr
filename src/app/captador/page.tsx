"use client";

import { useState, useRef, useEffect, useCallback, useMemo, type CSSProperties } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  MapPin, Rocket, Square, Filter, Loader2, CheckCircle2, XCircle, Terminal, Bot, ChevronRight,
  Download, Trash2, Send, ToggleLeft, Eye, Star, Clock, Link2, MapPinned,
  Building2, Search, Phone, ExternalLink, Copy, Check, Sparkles, AlertCircle,
  SlidersHorizontal, ChevronDown, Globe, MessageCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseMinReviews } from "@/lib/scraper-review-count";

// ponytail: cores locais enquanto o tema global expuser canais HSL; remover após normalizar os tokens globais.
const CAPTADOR_COLORS = {
  "--color-background": "hsl(240 10% 3.9%)",
  "--color-foreground": "hsl(0 0% 98%)",
  "--color-card": "hsl(240 10% 3.9%)",
  "--color-card-foreground": "hsl(0 0% 98%)",
  "--color-popover": "hsl(240 10% 3.9%)",
  "--color-popover-foreground": "hsl(0 0% 98%)",
  "--color-primary": "hsl(0 0% 98%)",
  "--color-primary-foreground": "hsl(240 5.9% 10%)",
  "--color-secondary": "hsl(240 3.7% 15.9%)",
  "--color-secondary-foreground": "hsl(0 0% 98%)",
  "--color-muted": "hsl(240 3.7% 15.9%)",
  "--color-muted-foreground": "hsl(240 5% 64.9%)",
  "--color-border": "hsl(240 3.7% 15.9%)",
  "--color-input": "hsl(240 3.7% 15.9%)",
  "--color-ring": "hsl(240 4.9% 83.9%)",
} as CSSProperties;

interface ReviewDetalhe {
  autor?: string;
  nota?: string;
  data?: string;
  texto?: string;
  fotoAutor?: string;
  fotos?: string[];
  respostaDono?: string;
  util?: number;
}

/** hostname seguro p/ render — lead.website pode vir sem esquema/inválido do scraper. */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatPhoneNumber(phone?: string | null): string {
  if (!phone) return "—";
  const clean = phone.replace(/\D/g, "");
  if (clean.length === 11) {
    return `(${clean.slice(0, 2)}) ${clean.slice(2, 7)}-${clean.slice(7)}`;
  }
  if (clean.length === 10) {
    return `(${clean.slice(0, 2)}) ${clean.slice(2, 6)}-${clean.slice(6)}`;
  }
  if (clean.startsWith("55") && clean.length === 13) {
    return `+55 (${clean.slice(2, 4)}) ${clean.slice(4, 9)}-${clean.slice(9)}`;
  }
  if (clean.startsWith("55") && clean.length === 12) {
    return `+55 (${clean.slice(2, 4)}) ${clean.slice(4, 8)}-${clean.slice(8)}`;
  }
  return phone;
}

function getWhatsAppUrl(phone?: string | null): string | null {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, "");
  if (clean.length === 10 || clean.length === 11) return `https://wa.me/55${clean}`;
  return /^55\d{10,11}$/.test(clean) ? `https://wa.me/${clean}` : null;
}

function CopyButton({ text, title }: { text: string; title?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = setTimeout(() => setCopyState("idle"), 1800);
    return () => clearTimeout(timeout);
  }, [copyState]);
  const label = copyState === "copied" ? "Telefone copiado" : copyState === "error" ? "Não foi possível copiar. Tente novamente." : title || "Copiar texto";
  const handleCopy = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={label}
      aria-label={label}
      className="inline-flex min-w-6 min-h-6 items-center justify-center p-1 rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary transition-colors cursor-pointer"
    >
      {copyState === "copied" ? <Check className="w-3 h-3 text-emerald-400" /> : copyState === "error" ? <AlertCircle className="w-3 h-3 text-red-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

interface BusinessDetails {
  about?: string;
  descricao?: string;
  services?: string[];
  subcategorias?: string[];
  pessoasProcuramPor?: string[];
  popularTimes?: { atual?: string } & Record<string, string | { hora: number; ocupacao: number }[] | undefined>;
  redesAdicionais?: Record<string, string>;
  menuUrl?: string;
  reservaUrl?: string;
  plusCode?: string;
  lat?: string;
  lng?: string;
  placeId?: string;
  atualizadoEm?: string;
}

interface Lead {
  name: string;
  phones: string;
  fullAddress: string;
  categories: string | string[];
  averageRating: string;
  reviewCount: string;
  website: string;
  instagram: string;
  facebook: string;
  extractedAt: string;
  // ---- Campos extras do Maps (captura profunda) ----
  remoteJid?: string;
  reviewsDetalhes?: ReviewDetalhe[];
  businessDetails?: BusinessDetails;
  openingHours?: Record<string, string>;
  attributes?: string[];
  priceRange?: string;
  openNow?: string;
  photos?: string[];
  mapsUrl?: string;
  plusCode?: string;
  lat?: string;
  lng?: string;
  placeId?: string;
  distribuicaoEstrelas?: Record<string, number>;
  cep?: string;
}

interface LogEntry {
  message: string;
  type: string;
  time: string;
}

const PRESET_NICHES = [
  "Clínicas Odontológicas",
  "Escritórios de Advocacia",
  "Imobiliárias & Corretores",
  "Restaurantes & Bares",
  "Academias & Fitness",
  "Oficinas Mecânicas",
  "Salões de Beleza & Estética",
  "Contabilidade & Gestão",
];

const PRESET_REGIONS = [
  "São Paulo, SP",
  "Rio de Janeiro, RJ",
  "Belo Horizonte, MG",
  "Curitiba, PR",
  "Vitória, ES",
  "Vila Velha, ES",
  "Serra, ES",
  "Brasília, DF",
];

export default function CaptadorPage() {
  const [niches, setNiches] = useState("");
  const [regions, setRegions] = useState("");
  const [webhookUrl, setWebhookUrl] = useState(process.env.NEXT_PUBLIC_N8N_WEBHOOK_LEAD || "");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [sendMode, setSendMode] = useState<"realtime" | "batch">("realtime");
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filterEmpty, setFilterEmpty] = useState(true);
  const [filterDuplicates, setFilterDuplicates] = useState(true);
  const [filterLandlines, setFilterLandlines] = useState(false);
  const [captureAllReviews, setCaptureAllReviews] = useState(false);
  const [filterWithWebsite, setFilterWithWebsite] = useState(false);
  const [filterWithInstagram, setFilterWithInstagram] = useState(false);
  const [minReviews, setMinReviews] = useState("0");
  const [minReviewsError, setMinReviewsError] = useState(false);
  const [limitEnabled, setLimitEnabled] = useState(true);
  const [maxLeads, setMaxLeads] = useState("50");
  const [maxLeadsError, setMaxLeadsError] = useState(false);
  const [reviewsAiEnabled, setReviewsAiEnabled] = useState(false);
  const [reviewsAiModel, setReviewsAiModel] = useState("");
  const [reviewsAiPrompt, setReviewsAiPrompt] = useState("");
  const [aiModels, setAiModels] = useState<{ id: string; name?: string }[]>([]);
  const [loadingAiModels, setLoadingAiModels] = useState(false);
  const [aiModelsError, setAiModelsError] = useState("");
  const [activeTab, setActiveTab] = useState<"config" | "leads">("config");
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showConsoleInLeads, setShowConsoleInLeads] = useState(false);
  const [showWebhookConfig, setShowWebhookConfig] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  function addLog(message: string, type: string = "info") {
    const time = new Date().toLocaleTimeString("pt-BR");
    setLogs((prev) => [...prev, { message, type, time }]);
  }

  // SSE Connection
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) eventSourceRef.current.close();
    const es = new EventSource("/api/scraper");
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.event) {
          case "log":
            addLog(data.message, data.type);
            break;
          case "status":
            setIsRunning(data.isScraping);
            setIsPaused(data.isPaused || false);
            break;
          case "new_lead":
            setLeads((prev) => [...prev, data.lead]);
            break;
          case "leads_update":
            setLeads(data.leads || []);
            break;
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => {
      es.close();
      setTimeout(connectSSE, 5000);
    };
    eventSourceRef.current = es;
  }, []);

  useEffect(() => {
    connectSSE();
    fetch("/api/scraper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "get_leads" }) })
      .then((r) => r.json())
      .then((d) => { if (d.leads) setLeads(d.leads); })
      .catch(() => {});
    return () => { eventSourceRef.current?.close(); };
  }, [connectSSE]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (!reviewsAiEnabled) return;
    const controller = new AbortController();
    setLoadingAiModels(true);
    setAiModelsError("");
    fetch("/api/ai-models", { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok || !data.success || !Array.isArray(data.models)) {
          throw new Error(data.error || "Não foi possível carregar os modelos de IA.");
        }
        if (controller.signal.aborted) return;
        const models: { id: string; name?: string }[] = data.models.filter(
          (model: { id?: unknown } | null) => model && typeof model.id === "string",
        );
        setAiModels(models);
        setReviewsAiModel(current => models.some(model => model.id === current) ? current : models[0]?.id || "");
        if (!models.length) setAiModelsError("Sem modelos disponíveis. Configure a IA antes de ativar o resumo.");
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setAiModels([]);
        setReviewsAiModel("");
        setAiModelsError(error.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingAiModels(false); });
    return () => controller.abort();
  }, [reviewsAiEnabled]);

  async function handleStart() {
    const minimum = parseMinReviews(minReviews.trim() === "" ? null : Number(minReviews));
    const goal = limitEnabled ? Number(maxLeads) : 0;
    const invalidGoal = limitEnabled && (maxLeads.trim() === "" || !Number.isInteger(goal) || goal < 1 || goal > 5000);
    setMinReviewsError(minimum === null);
    setMaxLeadsError(invalidGoal);
    if (minimum === null || invalidGoal) return;
    if (reviewsAiEnabled && (loadingAiModels || !reviewsAiModel)) {
      addLog("Selecione um modelo de IA para resumir as avaliações.", "error");
      return;
    }
    const nicheList = niches.split("\n").map((n) => n.trim()).filter(Boolean);
    const regionList = regions.split("\n").map((r) => r.trim()).filter(Boolean);
    if (!nicheList.length || !regionList.length) {
      addLog("Preencha pelo menos 1 nicho e 1 região!", "error");
      return;
    }
    setLeads([]);
    try {
      const res = await fetch("/api/scraper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          niches: nicheList,
          regions: regionList,
          webhookUrl,
          webhookEnabled,
          mode: sendMode,
          filterEmpty,
          filterDuplicates,
          filterLandlines,
          filterWithWebsite,
          filterWithInstagram,
          minReviews: minimum,
          maxLeads: goal,
          captureAllReviews,
          reviews_ai: reviewsAiEnabled
            ? { enabled: true, model: reviewsAiModel, prompt: reviewsAiPrompt || null }
            : undefined,
        }),
      });
      const data = await res.json();
      if (data.error) addLog(data.error, "error");
      else { 
        setIsRunning(true); 
        setIsPaused(false);
        setActiveTab("leads"); 
      }
    } catch (err) {
      addLog(`Erro: ${(err as Error).message}`, "error");
    }
  }

  async function handleStop() {
    await fetch("/api/scraper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    setIsRunning(false);
    setIsPaused(false);
  }

  async function handlePause() {
    await fetch("/api/scraper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    setIsPaused(true);
  }

  async function handleResume() {
    await fetch("/api/scraper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    setIsPaused(false);
  }

  async function handleClear() {
    try {
      const res = await fetch("/api/scraper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      if (!res.ok) { addLog("Não foi possível limpar. Aguarde o encerramento da captura e tente novamente.", "error"); return; }
      setLeads([]);
      addLog("Leads limpos.", "info");
    } catch {
      addLog("Falha de conexão ao limpar leads. A lista foi preservada.", "error");
    }
  }

  async function handleSendBatch() {
    if (!webhookUrl || leads.length === 0) { addLog("Sem leads ou URL para enviar.", "error"); return; }
    try {
      const res = await fetch("/api/scraper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send_batch", webhookUrl }),
      });
      const data = await res.json();
      if (data.success) addLog(`Enviados ${data.count} leads!`, "success");
      else addLog(data.error || "Erro ao enviar", "error");
    } catch (err) {
      addLog(`Erro: ${(err as Error).message}`, "error");
    }
  }

  // Local UI filters (without re-scraping)
  function filterLocalDuplicates() {
    const seen = new Set();
    const unique = leads.filter(l => {
      const clean = l.phones.replace(/\D/g, "");
      if (!clean) return true;
      if (seen.has(clean)) return false;
      seen.add(clean);
      return true;
    });
    setLeads(unique);
    addLog(`Filtro Local: Removidos ${leads.length - unique.length} duplicados.`, "info");
  }

  function filterLocalLandlines() {
    const filtered = leads.filter(l => {
      const clean = l.phones.replace(/\D/g, "");
      if (!clean) return true;
      if (clean.length === 10) return false;
      if (clean.startsWith("55") && clean.length === 12) return false;
      return true;
    });
    setLeads(filtered);
    addLog(`Filtro Local: Removidos ${leads.length - filtered.length} telefones fixos.`, "info");
  }

  function filterLocalEmpty() {
    const filtered = leads.filter(l => l.phones.replace(/\D/g, ""));
    setLeads(filtered);
    addLog(`Filtro Local: Removidos ${leads.length - filtered.length} leads sem telefone.`, "info");
  }

  function addPresetNiche(niche: string) {
    if (isRunning) return;
    setNiches((prev) => {
      const list = prev.split("\n").map(s => s.trim()).filter(Boolean);
      if (list.includes(niche)) return prev;
      return prev.trim() ? `${prev.trim()}\n${niche}` : niche;
    });
  }

  function addPresetRegion(region: string) {
    if (isRunning) return;
    setRegions((prev) => {
      const list = prev.split("\n").map(s => s.trim()).filter(Boolean);
      if (list.includes(region)) return prev;
      return prev.trim() ? `${prev.trim()}\n${region}` : region;
    });
  }

  async function handleExport() {
    const XLSX = await import("xlsx");
    const niche = niches.split("\n")[0]?.trim().replace(/\s+/g, "_") || "Leads";
    const region = regions.split("\n")[0]?.trim().replace(/\s+/g, "_") || "Exportados";

    // ---- ABA 1: Leads (linha por lead, todas as colunas principais) ----
    const header = [
      "Nome", "Telefone", "Categoria", "Endereço", "CEP", "Avaliação", "Nº Reviews",
      "Faixa Preço", "Aberto Agora", "Website", "Instagram", "Facebook",
      "Place ID", "Plus Code", "Latitude", "Longitude", "Maps URL",
      "Menu URL", "Reserva URL", "Redes Adicionais",
      "Horários", "Atributos", "Subcategorias", "Serviços", "Pessoas Procuram Por",
      "Descrição", "Atualizado Em", "Qtd Fotos", "Qtd Reviews Detalhadas",
      "5★", "4★", "3★", "2★", "1★", "Extraído Em",
    ];
    const rows = leads.map((l) => {
      const bd = l.businessDetails || {};
      const dist = l.distribuicaoEstrelas || {};
      const redes = bd.redesAdicionais || {};
      const redesStr = Object.entries(redes).map(([k, v]) => `${k}: ${v}`).join(" | ");
      return [
        l.name, l.phones, l.categories, l.fullAddress, l.cep || "",
        l.averageRating, l.reviewCount, l.priceRange || "", l.openNow || "",
        l.website, l.instagram, l.facebook,
        l.placeId || "", l.plusCode || "", l.lat || "", l.lng || "", l.mapsUrl || "",
        bd.menuUrl || "", bd.reservaUrl || "", redesStr,
        l.openingHours ? JSON.stringify(l.openingHours) : "",
        l.attributes ? l.attributes.join(" | ") : "",
        bd.subcategorias ? bd.subcategorias.join(" | ") : "",
        bd.services ? bd.services.join(" | ") : "",
        bd.pessoasProcuramPor ? bd.pessoasProcuramPor.join(" | ") : "",
        bd.descricao || bd.about || "", bd.atualizadoEm || "",
        l.photos?.length || 0, l.reviewsDetalhes?.length || 0,
        dist["5estrelas"] || "", dist["4estrelas"] || "", dist["3estrelas"] || "",
        dist["2estrelas"] || "", dist["1estrelas"] || "",
        l.extractedAt,
      ];
    });
    const wsLeads = XLSX.utils.aoa_to_sheet([header, ...rows]);

    // ---- ABA 2: Reviews detalhadas (uma linha por review) ----
    const reviewsHeader = ["Negócio", "Autor", "Nota", "Data", "Texto", "Qtd Fotos Review", "Resposta Dono", "Útil"];
    const reviewsRows: (string | number)[][] = [];
    for (const l of leads) {
      if (!l.reviewsDetalhes?.length) continue;
      for (const r of l.reviewsDetalhes) {
        reviewsRows.push([
          l.name, r.autor || "", r.nota || "", r.data || "",
          (r.texto || "").slice(0, 32000),
          r.fotos?.length || 0,
          r.respostaDono ? r.respostaDono.slice(0, 32000) : "",
          r.util || 0,
        ]);
      }
    }
    const wsReviews = reviewsRows.length > 0
      ? XLSX.utils.aoa_to_sheet([reviewsHeader, ...reviewsRows])
      : XLSX.utils.aoa_to_sheet([reviewsHeader, ["—", "Nenhuma review capturada", "", "", "", "", "", ""]]);

    // ---- ABA 3: Fotos (todas as URLs, com referência ao negócio) ----
    const fotosHeader = ["Negócio", "URL Foto"];
    const fotosRows: string[][] = [];
    for (const l of leads) {
      if (!l.photos?.length) continue;
      for (const url of l.photos) fotosRows.push([l.name, url]);
    }
    const wsFotos = fotosRows.length > 0
      ? XLSX.utils.aoa_to_sheet([fotosHeader, ...fotosRows])
      : XLSX.utils.aoa_to_sheet([fotosHeader, ["—", "Nenhuma foto capturada"]]);

    // Larguras amigáveis
    wsLeads["!cols"] = Array(header.length).fill({ wch: 22 });
    wsReviews["!cols"] = Array(reviewsHeader.length).fill({ wch: 28 });
    wsFotos["!cols"] = [{ wch: 30 }, { wch: 80 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsLeads, "Leads");
    XLSX.utils.book_append_sheet(wb, wsReviews, "Reviews");
    XLSX.utils.book_append_sheet(wb, wsFotos, "Fotos");
    XLSX.writeFile(wb, `${niche}_${region}.xlsx`);
    addLog(`Exportado: ${leads.length} leads, ${reviewsRows.length} reviews, ${fotosRows.length} fotos.`, "success");
  }

  // Estatísticas calculadas dinamicamente
  const nicheCount = useMemo(() => niches.split("\n").map(n => n.trim()).filter(Boolean).length, [niches]);
  const regionCount = useMemo(() => regions.split("\n").map(r => r.trim()).filter(Boolean).length, [regions]);
  const searchCombinations = nicheCount * regionCount;

  const leadsWithPhone = useMemo(() => leads.filter(l => Boolean(l.phones && l.phones.replace(/\D/g, "").length >= 8)).length, [leads]);
  const leadsWithWebsite = useMemo(() => leads.filter(l => Boolean(l.website && l.website.trim().length > 3)).length, [leads]);
  const averageRatingNum = useMemo(() => {
    const list = leads.map(l => parseFloat(l.averageRating.replace(",", "."))).filter(n => !isNaN(n) && n > 0);
    if (!list.length) return null;
    return (list.reduce((a, b) => a + b, 0) / list.length).toFixed(1);
  }, [leads]);

  // Busca instantânea em memória na tabela de leads
  const filteredLeads = useMemo(() => {
    if (!searchQuery.trim()) return leads;
    const q = searchQuery.toLowerCase().trim();
    return leads.filter(l =>
      (l.name && l.name.toLowerCase().includes(q)) ||
      (l.phones && l.phones.includes(q)) ||
      (l.categories && l.categories.toString().toLowerCase().includes(q)) ||
      (l.fullAddress && l.fullAddress.toLowerCase().includes(q)) ||
      (l.website && l.website.toLowerCase().includes(q))
    );
  }, [leads, searchQuery]);

  return (
    <div style={CAPTADOR_COLORS} className="captador-surface flex flex-col h-[100dvh] overflow-hidden bg-background text-foreground">
      <style>{".captador-surface, .captador-surface * { border-color: revert-layer; }"}</style>
      <Header />

      <div className="flex-1 p-3 sm:p-6 space-y-4 overflow-y-auto w-full max-w-7xl mx-auto mobile-safe-bottom">

        {/* Painel de Controle Superior / Cockpit */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4 rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm shadow-xs">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight">Captador Maps</h1>
                <Badge variant="outline" className="text-[10px] uppercase font-mono tracking-wider text-muted-foreground border-border/80">
                  Google Maps Scraper
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Extração precisa de estabelecimentos, contatos telefônicos e reputação comercial.
              </p>
            </div>
          </div>

          <div className="flex min-w-0 items-center flex-wrap gap-2">
            {/* Tab Switcher - preserva nomes exatos esperados pelos testes */}
            <div className="flex flex-wrap items-center rounded-lg border border-border/70 bg-secondary/30 p-1">
              <Button
                variant={activeTab === "config" ? "default" : "ghost"}
                size="sm"
                className="gap-2 text-xs h-7 px-3 rounded-md transition-all font-medium"
                onClick={() => setActiveTab("config")}
              >
                <MapPin className="w-3.5 h-3.5" /> Configuração
              </Button>
              <Button
                variant={activeTab === "leads" ? "default" : "ghost"}
                size="sm"
                className="gap-2 text-xs h-7 px-3 rounded-md transition-all font-medium"
                onClick={() => setActiveTab("leads")}
              >
                <Terminal className="w-3.5 h-3.5" /> Leads & Console
                {leads.length > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{leads.length}</Badge>}
              </Button>
            </div>

            {/* Badge de status ativo / pausado */}
            {isRunning && (
              <Badge className={cn(
                "animate-pulse text-[10px] px-2.5 py-1 font-medium border flex items-center gap-1.5",
                isPaused
                  ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                  : "bg-green-500/20 text-green-400 border-green-500/30"
              )}>
                {isPaused ? <Square className="w-3 h-3 mr-1" /> : <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                {isPaused ? "Pausado" : "Extraindo..."}
              </Badge>
            )}
          </div>
        </div>

        {/* Métricas Rápidas em Linha */}
        {leads.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg border border-border/50 bg-card/40 flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Total Extraído</span>
                <span className="text-lg font-bold tracking-tight text-foreground">{leads.length}</span>
              </div>
              <Building2 className="w-5 h-5 text-primary/40" />
            </div>
            <div className="p-3 rounded-lg border border-border/50 bg-card/40 flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Com Telefone</span>
                <span className="text-lg font-bold tracking-tight text-emerald-400">{leadsWithPhone}</span>
              </div>
              <Phone className="w-5 h-5 text-emerald-400/40" />
            </div>
            <div className="p-3 rounded-lg border border-border/50 bg-card/40 flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Com Website</span>
                <span className="text-lg font-bold tracking-tight text-foreground">{leadsWithWebsite}</span>
              </div>
              <Globe className="w-5 h-5 text-primary/40" />
            </div>
            <div className="p-3 rounded-lg border border-border/50 bg-card/40 flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Nota Média</span>
                <span className="text-lg font-bold tracking-tight text-amber-400 flex items-center gap-1">
                  {averageRatingNum ? `${averageRatingNum} ★` : "—"}
                </span>
              </div>
              <Star className="w-5 h-5 text-amber-400/40 fill-amber-400/20" />
            </div>
          </div>
        )}

        {/* ABA 1: CONFIGURAÇÃO */}
        {activeTab === "config" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

            {/* Coluna Esquerda: Formulário e Filtros */}
            <div className="lg:col-span-7 space-y-4">
              <Card className="border-border/60 bg-card/80 shadow-xs">
                <CardHeader className="pb-3 border-b border-border/40">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <SlidersHorizontal className="w-4 h-4 text-primary" />
                      <CardTitle className="text-sm font-semibold">Parâmetros de Pesquisa</CardTitle>
                    </div>
                    {searchCombinations > 0 && (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground border-border/70">
                        {searchCombinations} {searchCombinations === 1 ? "busca programada" : "buscas programadas"}
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="text-xs text-muted-foreground">
                    O robô visitará o Google Maps combinando cada nicho com cada cidade informada.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 pt-4">
                  {/* Nichos & Regiões */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label htmlFor="captador-niches" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">
                          Nichos (um por linha)
                        </label>
                        {nicheCount > 0 && (
                          <span className="text-[10px] text-muted-foreground">{nicheCount} {nicheCount === 1 ? "nicho" : "nichos"}</span>
                        )}
                      </div>
                      <Textarea
                        id="captador-niches"
                        disabled={isRunning}
                        placeholder={"Contabilidade\nAdvocacia\nPsicologia\nClínica Odontológica"}
                        value={niches}
                        onChange={(e) => setNiches(e.target.value)}
                        className="h-32 bg-secondary/40 border-border/60 text-sm resize-none focus-visible:ring-primary/40 font-mono text-xs"
                      />
                      {/* Chips rápidos de nicho */}
                      <div className="space-y-1">
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Sparkles className="w-2.5 h-2.5 text-primary" /> Sugestões rápidas:
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {PRESET_NICHES.slice(0, 4).map((p) => (
                            <button
                              key={p}
                              type="button"
                              disabled={isRunning}
                              onClick={() => addPresetNiche(p)}
                              className="text-[10px] px-2 py-0.5 rounded-md bg-secondary/50 hover:bg-secondary border border-border/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
                            >
                              + {p}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label htmlFor="captador-regions" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">
                          Regiões (uma por linha)
                        </label>
                        {regionCount > 0 && (
                          <span className="text-[10px] text-muted-foreground">{regionCount} {regionCount === 1 ? "região" : "regiões"}</span>
                        )}
                      </div>
                      <Textarea
                        id="captador-regions"
                        disabled={isRunning}
                        placeholder={"São Paulo, SP\nVitória, ES\nBelo Horizonte, MG"}
                        value={regions}
                        onChange={(e) => setRegions(e.target.value)}
                        className="h-32 bg-secondary/40 border-border/60 text-sm resize-none focus-visible:ring-primary/40 font-mono text-xs"
                      />
                      {/* Chips rápidos de região */}
                      <div className="space-y-1">
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <MapPin className="w-2.5 h-2.5 text-primary" /> Cidades frequentes:
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {PRESET_REGIONS.slice(0, 4).map((r) => (
                            <button
                              key={r}
                              type="button"
                              disabled={isRunning}
                              onClick={() => addPresetRegion(r)}
                              className="text-[10px] px-2 py-0.5 rounded-md bg-secondary/50 hover:bg-secondary border border-border/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
                            >
                              + {r}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <Separator className="bg-border/40" />

                  {/* Filtros e Regras Automáticas */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-1.5">
                      <Filter className="w-3.5 h-3.5 text-primary" />
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Filtros Automáticos & Qualificação
                      </h3>
                    </div>

                    {/* Mínimo de Reviews */}
                    <div className="p-3 rounded-lg border border-border/50 bg-secondary/20 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label htmlFor="captador-min-reviews" className="text-xs font-medium text-foreground">
                          Mínimo de avaliações no Google
                        </label>
                        <Input
                          id="captador-min-reviews"
                          disabled={isRunning}
                          type="number"
                          min={0}
                          step={1}
                          max={2147483647}
                          value={minReviews}
                          onChange={e => { setMinReviews(e.target.value); setMinReviewsError(false); }}
                          aria-invalid={minReviewsError}
                          aria-describedby={`captador-min-reviews-help${minReviewsError ? " captador-min-reviews-error" : ""}`}
                          className="w-24 h-8 text-right font-mono text-xs bg-background"
                        />
                      </div>
                      <p id="captador-min-reviews-help" className="text-[11px] text-muted-foreground">
                        Quantidade de pessoas que deram estrelas, com ou sem comentário. Não filtra pela nota. 0 = sem mínimo.
                      </p>
                      {minReviewsError && (
                        <p id="captador-min-reviews-error" role="alert" className="text-xs text-destructive flex items-center gap-1 pt-1">
                          <AlertCircle className="w-3 h-3" /> Informe um inteiro entre 0 e 2147483647.
                        </p>
                      )}
                    </div>

                    {/* Somente com Instagram */}
                    <div className="p-2.5 rounded-lg border border-border/50 bg-secondary/15 hover:bg-secondary/30 transition-colors">
                      <label className="flex items-center justify-between gap-2 cursor-pointer">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">Somente com Instagram</span>
                        </div>
                        <input
                          type="checkbox"
                          disabled={isRunning}
                          checked={filterWithInstagram}
                          onChange={e => setFilterWithInstagram(e.target.checked)}
                          aria-describedby="captador-instagram-help"
                          className="w-4 h-4 rounded accent-primary cursor-pointer"
                        />
                      </label>
                      <p id="captador-instagram-help" className="text-[11px] text-muted-foreground mt-1 pl-0.5">
                        Exige perfil informado no Google Maps; não busca no site.
                      </p>
                    </div>

                    {/* Avaliações completas e análise com IA - details obrigatório com matching de texto exato para testes */}
                    <details className="rounded-lg border border-border/60 bg-secondary/20 p-3 space-y-3 group">
                      <summary className="flex items-center gap-2 text-xs font-medium cursor-pointer list-none select-none">
                        <Bot className="w-4 h-4 text-primary shrink-0" />
                        <span>Avaliações completas e análise com IA</span>
                        <ChevronRight className="w-4 h-4 ml-auto text-muted-foreground transition-transform group-open:rotate-90" />
                      </summary>

                      <div className="pt-2 space-y-3 border-t border-border/40 mt-2">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <label htmlFor="capture-all-reviews" className="text-xs font-medium cursor-pointer">
                              Capturar todas as avaliações
                            </label>
                            <p className="text-[11px] text-muted-foreground">
                              Salva os comentários disponíveis no Google Maps. Esta opção pode aumentar o tempo de captura.
                            </p>
                          </div>
                          <Switch
                            id="capture-all-reviews"
                            aria-label="Capturar todas as avaliações"
                            disabled={isRunning}
                            checked={captureAllReviews}
                            onCheckedChange={setCaptureAllReviews}
                            size="sm"
                          />
                        </div>

                        <Separator className="bg-border/30" />

                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <label htmlFor="captador-reviews-ai" className="text-xs font-medium cursor-pointer">
                              Resumir avaliações com IA
                            </label>
                            <p className="text-[11px] text-muted-foreground">
                              Ativa a captura de comentários e gera um resumo por lead após salvar. Disponível no CRM como resumo de avaliações.
                            </p>
                          </div>
                          <Switch
                            id="captador-reviews-ai"
                            aria-label="Resumir avaliações com IA"
                            disabled={isRunning}
                            checked={reviewsAiEnabled}
                            onCheckedChange={enabled => { setReviewsAiEnabled(enabled); if (enabled) setCaptureAllReviews(true); }}
                            size="sm"
                          />
                        </div>

                        {reviewsAiEnabled && (
                          <div className="space-y-3 pt-2 p-3 rounded-md bg-background/60 border border-border/50">
                            <div className="space-y-1">
                              <label htmlFor="captador-reviews-model" className="text-xs font-medium">
                                Modelo de IA para avaliações
                              </label>
                              <select
                                id="captador-reviews-model"
                                aria-label="Modelo de IA para avaliações"
                                value={reviewsAiModel}
                                onChange={e => setReviewsAiModel(e.target.value)}
                                disabled={isRunning || loadingAiModels}
                                className="w-full min-w-0 rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs focus:ring-1 focus:ring-primary"
                              >
                                {!aiModels.length && <option value="">{loadingAiModels ? "Carregando…" : "Sem modelos disponíveis"}</option>}
                                {aiModels.map(model => (
                                  <option key={model.id} value={model.id}>{model.name || model.id}</option>
                                ))}
                              </select>
                              {aiModelsError && <p role="alert" className="text-xs text-destructive">{aiModelsError}</p>}
                            </div>

                            <div className="space-y-1">
                              <label htmlFor="captador-reviews-prompt" className="text-xs font-medium">
                                Instruções para resumir avaliações
                              </label>
                              <Textarea
                                id="captador-reviews-prompt"
                                disabled={isRunning}
                                value={reviewsAiPrompt}
                                onChange={e => setReviewsAiPrompt(e.target.value)}
                                rows={3}
                                placeholder="Vazio usa o padrão: elogios, reclamações, gancho e nota geral."
                                className="text-xs bg-secondary/30 resize-none font-mono"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </details>

                    {/* Demais filtros em lista estilizada */}
                    <div className="space-y-1.5 pt-1">
                      {[
                        { label: "Remover leads sem telefone", value: filterEmpty, set: setFilterEmpty, desc: "Descarta empresas sem número cadastrado no Maps" },
                        { label: "Remover telefones duplicados", value: filterDuplicates, set: setFilterDuplicates, desc: "Garante que o mesmo número não entre duas vezes" },
                        { label: "Remover telefones fixos", value: filterLandlines, set: setFilterLandlines, desc: "Prioriza celulares com WhatsApp habilitado" },
                        { label: "Capturar somente leads sem site", value: filterWithWebsite, set: setFilterWithWebsite, desc: "Perfeito para prospecção de criação de sites" },
                      ].map((f) => (
                        <div key={f.label} className="p-2.5 rounded-lg border border-border/40 hover:bg-secondary/30 transition-colors">
                          <label className="flex items-center justify-between gap-3 cursor-pointer">
                            <span className="text-xs font-medium text-foreground select-none">{f.label}</span>
                            <input
                              type="checkbox"
                              disabled={isRunning}
                              checked={f.value}
                              onChange={e => f.set(e.target.checked)}
                              className="w-4 h-4 rounded accent-primary cursor-pointer shrink-0"
                            />
                          </label>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{f.desc}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <Separator className="bg-border/40" />

                  {/* Limite de leads e Meta */}
                  <div className="p-3 rounded-lg border border-border/50 bg-secondary/20 space-y-2">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <label htmlFor="captador-limit-enabled" className="text-xs font-semibold cursor-pointer">
                          Limite de leads
                        </label>
                        <Switch
                          id="captador-limit-enabled"
                          aria-label="Limite de leads"
                          disabled={isRunning}
                          checked={limitEnabled}
                          onCheckedChange={enabled => { setLimitEnabled(enabled); setMaxLeadsError(false); }}
                          size="sm"
                        />
                      </div>
                      {limitEnabled && (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">Meta:</span>
                          <Input
                            aria-label="Quantidade máxima de leads"
                            disabled={isRunning}
                            type="number"
                            min={1}
                            step={1}
                            max={5000}
                            value={maxLeads}
                            onChange={e => { setMaxLeads(e.target.value); setMaxLeadsError(false); }}
                            className="w-24 h-8 text-right font-mono text-xs bg-background"
                            aria-invalid={maxLeadsError}
                            aria-describedby={`captador-limit-help${maxLeadsError ? " captador-limit-error" : ""}`}
                          />
                        </div>
                      )}
                    </div>
                    <p id="captador-limit-help" className="text-[11px] text-muted-foreground leading-relaxed">
                      {limitEnabled
                        ? "Continua buscando até atingir a meta de leads aprovados e salvos, com novas tentativas e expansão para cidades próximas. Você pode pausar ou parar."
                        : "Sem limite definido: encerra ao esgotar as buscas informadas."}
                    </p>
                    {maxLeadsError && (
                      <p id="captador-limit-error" role="alert" className="text-xs text-destructive flex items-center gap-1 pt-1">
                        <AlertCircle className="w-3 h-3" /> Informe um inteiro entre 1 e 5000.
                      </p>
                    )}
                  </div>

                  {/* Integrações Opcionais (Webhook / n8n) */}
                  <div className="border border-border/40 rounded-lg p-2.5 bg-secondary/10">
                    <button
                      type="button"
                      onClick={() => setShowWebhookConfig(v => !v)}
                      className="w-full flex items-center justify-between text-xs text-muted-foreground hover:text-foreground font-medium cursor-pointer"
                    >
                      <span className="flex items-center gap-1.5">
                        <Send className="w-3.5 h-3.5" /> Integração de Envio (n8n / Webhook)
                      </span>
                      <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showWebhookConfig && "rotate-180")} />
                    </button>

                    {showWebhookConfig && (
                      <div className="mt-3 pt-3 border-t border-border/30 space-y-3">
                        <div className="flex items-center justify-between">
                          <label htmlFor="webhook-active-toggle" className="text-xs text-foreground cursor-pointer">
                            Ativar envio automático para Webhook
                          </label>
                          <Switch
                            id="webhook-active-toggle"
                            disabled={isRunning}
                            checked={webhookEnabled}
                            onCheckedChange={setWebhookEnabled}
                            size="sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="captador-webhook-url" className="text-[11px] text-muted-foreground">URL do Webhook</label>
                          <Input
                            id="captador-webhook-url"
                            disabled={isRunning}
                            value={webhookUrl}
                            onChange={e => setWebhookUrl(e.target.value)}
                            placeholder="https://seu-n8n.com/webhook/leads"
                            className="text-xs h-8 font-mono bg-background"
                          />
                        </div>
                        <div className="flex items-center gap-4 text-xs">
                          <span className="text-[11px] text-muted-foreground">Modo:</span>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              name="sendMode"
                              checked={sendMode === "realtime"}
                              onChange={() => setSendMode("realtime")}
                              disabled={isRunning}
                              className="accent-primary"
                            />
                            Tempo Real
                          </label>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              name="sendMode"
                              checked={sendMode === "batch"}
                              onChange={() => setSendMode("batch")}
                              disabled={isRunning}
                              className="accent-primary"
                            />
                            Em Lote (manual)
                          </label>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Botões de Ação Principais */}
                  <div className="pt-2">
                    {!isRunning ? (
                      <Button
                        className="w-full gap-2 text-sm font-semibold h-11 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm cursor-pointer"
                        onClick={handleStart}
                      >
                        <Rocket className="w-4 h-4" /> Iniciar Captação
                      </Button>
                    ) : (
                      <div className="flex items-center gap-2">
                        {isPaused ? (
                          <Button
                            className="flex-1 gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium h-11 cursor-pointer"
                            onClick={handleResume}
                          >
                            <Rocket className="w-4 h-4" /> Retomar
                          </Button>
                        ) : (
                          <Button
                            className="flex-1 gap-2 bg-amber-600 hover:bg-amber-700 text-white font-medium h-11 cursor-pointer"
                            onClick={handlePause}
                          >
                            <Square className="w-4 h-4" /> Pausar
                          </Button>
                        )}
                        <Button
                          variant="destructive"
                          className="px-6 h-11 font-medium cursor-pointer"
                          onClick={handleStop}
                        >
                          Parar
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Coluna Direita: Console de Operação em Tempo Real */}
            <div className="lg:col-span-5 flex flex-col">
              <Card className="border-border/60 bg-card/80 shadow-xs flex-1 flex flex-col overflow-hidden">
                <CardHeader className="pb-3 border-b border-border/40">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1.5 mr-1">
                        <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                        <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                      </div>
                      <Terminal className="w-4 h-4 text-primary" />
                      <CardTitle className="text-sm font-semibold">Console de Logs</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] font-mono font-normal">
                        {logs.length} logs
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-muted-foreground hover:text-foreground h-7 px-2"
                        onClick={() => setLogs([])}
                      >
                        Limpar
                      </Button>
                    </div>
                  </div>
                  <CardDescription className="text-xs text-muted-foreground flex items-center justify-between">
                    <span>Acompanhamento das chamadas e extrações ao vivo.</span>
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      Eventos em tempo real
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 p-0 flex flex-col">
                  <div className="bg-[oklch(0.08_0.01_260)] rounded-b-lg flex-1 min-h-[440px] max-h-[560px] overflow-y-auto p-4 font-mono text-xs leading-6 select-text border-t border-white/[0.04]">
                    {logs.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-16">
                        <Terminal className="w-8 h-8 stroke-1 opacity-50" />
                        <p className="text-xs">Aguardando execução...</p>
                        <span className="text-[10px] text-muted-foreground text-center max-w-[200px]">
                          Configure os nichos e clique em &quot;Iniciar Captação&quot; para iniciar o scraper.
                        </span>
                      </div>
                    ) : (
                      logs.map((log, i) => (
                        <div key={i} className="flex items-start gap-2 py-0.5 hover:bg-white/[0.02] rounded px-1 -mx-1">
                          <span className="text-muted-foreground/50 shrink-0 text-[10px]">[{log.time}]</span>
                          {log.type === "success" && <CheckCircle2 className="w-3.5 h-3.5 mt-1 text-emerald-400 shrink-0" />}
                          {log.type === "error" && <XCircle className="w-3.5 h-3.5 mt-1 text-red-400 shrink-0" />}
                          {log.type === "warning" && <AlertCircle className="w-3.5 h-3.5 mt-1 text-amber-400 shrink-0" />}
                          <span className={cn(
                            "break-words text-xs",
                            log.type === "success" && "text-emerald-300 font-medium",
                            log.type === "error" && "text-red-400",
                            log.type === "warning" && "text-amber-300",
                            log.type === "info" && "text-muted-foreground/90",
                          )}>
                            {log.message}
                          </span>
                        </div>
                      ))
                    )}
                    <div ref={logsEndRef} />
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ABA 2: LEADS & RESULTADOS */}
        {activeTab === "leads" && (
          <div className="space-y-4">
            <Card className="border-border/60 bg-card/80 shadow-xs">
              <CardHeader className="pb-3 border-b border-border/40">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ToggleLeft className="w-4 h-4 text-primary" />
                    <CardTitle className="text-sm font-semibold">Clientes Extraídos</CardTitle>
                    {/* Badge com formato exato 'X clientes' esperado pelos testes */}
                    <Badge variant="secondary" className="text-[10px] font-mono">
                      {leads.length} clientes
                    </Badge>
                  </div>

                  {/* Toolbar de Ações Rápidas */}
                  <div className="flex items-center flex-wrap gap-2">
                    {webhookEnabled && leads.length > 0 && sendMode === "batch" && (
                      <Button variant="outline" size="sm" className="gap-2 text-xs h-8" onClick={handleSendBatch}>
                        <Send className="w-3 h-3" /> Enviar para n8n
                      </Button>
                    )}

                    {/* Botões de Filtros Locais - preserva nomes e tags esperados */}
                    <div className="flex items-center rounded-lg border border-border/60 bg-secondary/30 p-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-[10px] uppercase font-bold text-amber-500 hover:text-amber-400 h-7 px-2.5"
                        onClick={filterLocalDuplicates}
                        title="Remove números duplicados da lista atual"
                      >
                        Duplicados
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-[10px] uppercase font-bold text-amber-500 hover:text-amber-400 h-7 px-2.5"
                        onClick={filterLocalLandlines}
                        title="Remove números fixos da lista atual"
                      >
                        Fixos
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-[10px] uppercase font-bold text-amber-500 hover:text-amber-400 h-7 px-2.5"
                        onClick={filterLocalEmpty}
                        title="Remove leads sem telefone da lista atual"
                      >
                        Sem Tel
                      </Button>
                    </div>

                    <div className="w-px h-5 bg-border/60 mx-0.5 hidden sm:block" />

                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8 font-medium cursor-pointer"
                      onClick={handleExport}
                      disabled={leads.length === 0}
                    >
                      <Download className="w-3.5 h-3.5" /> Exportar
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-xs h-8 text-red-400 hover:text-red-300 hover:bg-red-500/10 cursor-pointer"
                      onClick={handleClear}
                      disabled={isRunning || isPaused || leads.length === 0}
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Limpar
                    </Button>

                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8 ml-auto lg:ml-0"
                      onClick={() => setShowConsoleInLeads(v => !v)}
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      {showConsoleInLeads ? "Ocultar Logs" : "Ver Logs"}
                    </Button>
                  </div>
                </div>

                {/* Barra de Pesquisa Instantânea em Memória */}
                {leads.length > 0 && (
                  <div className="pt-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        aria-label="Buscar leads"
                        placeholder="Filtrar por nome, telefone, categoria ou cidade..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="h-8 pl-8 text-xs bg-background/80"
                      />
                    </div>
                    {searchQuery && (
                      <span className="text-[11px] text-muted-foreground self-center">
                        Exibindo {filteredLeads.length} de {leads.length}
                      </span>
                    )}
                  </div>
                )}
              </CardHeader>

              <CardContent className="p-0">
                {/* Tabela Desktop */}
                <div className="hidden sm:block overflow-x-auto max-h-[540px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/60 hover:bg-transparent bg-secondary/20">
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10 w-[220px]">Nome do Negócio</TableHead>
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10">Telefone</TableHead>
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10">Categoria</TableHead>
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10 w-[240px]">Endereço</TableHead>
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10 text-center">Avaliação</TableHead>
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10 text-center">Reviews</TableHead>
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10 text-center">Detalhes</TableHead>
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10">Website</TableHead>
                        <TableHead className="text-[10px] uppercase font-bold sticky top-0 bg-card z-10">Extraído Em</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leads.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={9} className="text-center py-16 text-muted-foreground text-sm">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <Building2 className="w-8 h-8 stroke-1 opacity-40 text-muted-foreground" />
                              <p className="font-medium">{isRunning ? "Aguardando leads..." : "Nenhum lead extraído"}</p>
                              <p className="text-xs text-muted-foreground/60 max-w-sm">
                                {isRunning
                                  ? "O robô está navegando no Google Maps. Os resultados aparecerão aqui assim que forem encontrados."
                                  : "Vá para a aba 'Configuração' e inicie a busca para extrair leads."}
                              </p>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : filteredLeads.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={9} className="text-center py-12 text-muted-foreground text-xs">
                            Nenhum lead encontrado para o termo &quot;{searchQuery}&quot;.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredLeads.map((lead, i) => {
                          const temExtras = (lead.reviewsDetalhes?.length || 0) + (lead.photos?.length || 0) + (lead.businessDetails ? 1 : 0) + (lead.attributes?.length || 0) > 0;
                          const waUrl = getWhatsAppUrl(lead.phones);
                          return (
                            <TableRow key={i} className="border-border/30 text-xs hover:bg-secondary/20 transition-colors">
                              <TableCell className="font-medium max-w-[220px]">
                                <div className="truncate font-semibold text-foreground" title={lead.name}>
                                  {lead.name}
                                </div>
                                {lead.priceRange && (
                                  <span className="text-[10px] text-muted-foreground/70">{lead.priceRange}</span>
                                )}
                              </TableCell>
                              <TableCell className="whitespace-nowrap">
                                {lead.phones ? (
                                  <div className="flex items-center gap-1.5 font-mono text-emerald-400">
                                    <span>{formatPhoneNumber(lead.phones)}</span>
                                    <CopyButton text={lead.phones} title="Copiar telefone" />
                                    {waUrl && (
                                      <a
                                        href={waUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-muted-foreground hover:text-emerald-400 transition-colors p-1"
                                        title="Abrir no WhatsApp"
                                      >
                                        <MessageCircle className="w-3 h-3" />
                                      </a>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground/40">—</span>
                                )}
                              </TableCell>
                              <TableCell className="max-w-[150px] truncate text-muted-foreground" title={lead.categories?.toString()}>
                                {lead.categories || "—"}
                              </TableCell>
                              <TableCell className="max-w-[240px] truncate text-muted-foreground" title={lead.fullAddress}>
                                {lead.fullAddress || "—"}
                              </TableCell>
                              <TableCell className="text-center whitespace-nowrap">
                                {lead.averageRating ? (
                                  <span className="inline-flex items-center gap-1 font-semibold text-amber-400">
                                    <Star className="w-3 h-3 fill-amber-400" />
                                    {lead.averageRating}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground/40">—</span>
                                )}
                              </TableCell>
                              <TableCell className="text-center">
                                <span className="text-foreground">{lead.reviewCount || "0"}</span>
                                {lead.reviewsDetalhes && lead.reviewsDetalhes.length > 0 && (
                                  <span className="block text-[9px] text-muted-foreground mt-0.5">
                                    {lead.reviewsDetalhes.length} detalhadas
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-center">
                                <Button
                                  variant={temExtras ? "secondary" : "ghost"}
                                  size="sm"
                                  className={cn("gap-1 text-[10px] h-6 px-2 font-medium cursor-pointer", !temExtras && "text-muted-foreground/40")}
                                  onClick={() => setSelectedLead(lead)}
                                  disabled={!temExtras}
                                  title={temExtras ? "Ver reviews, fotos, horários e detalhes completos" : "Sem detalhes extras capturados"}
                                >
                                  <Eye className="w-3 h-3" />
                                  {temExtras ? "Ver" : "—"}
                                </Button>
                              </TableCell>
                              <TableCell className="max-w-[150px] truncate">
                                {lead.website ? (
                                  <a
                                    href={lead.website}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
                                  >
                                    {safeHostname(lead.website)}
                                    <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
                                  </a>
                                ) : (
                                  <span className="text-muted-foreground/40">—</span>
                                )}
                              </TableCell>
                              <TableCell className="text-muted-foreground whitespace-nowrap text-[11px]">
                                {lead.extractedAt}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Lista Mobile (Cards Responsivos) */}
                <div className="sm:hidden divide-y divide-border/40 max-h-[500px] overflow-y-auto p-3 space-y-3">
                  {leads.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground text-sm">
                      {isRunning ? "Aguardando leads..." : "Nenhum lead extraído"}
                    </div>
                  ) : filteredLeads.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground text-xs">
                      Nenhum lead encontrado para o termo &quot;{searchQuery}&quot;.
                    </div>
                  ) : (
                    filteredLeads.map((lead, i) => {
                      const temExtras = (lead.reviewsDetalhes?.length || 0) + (lead.photos?.length || 0) + (lead.businessDetails ? 1 : 0) + (lead.attributes?.length || 0) > 0;
                      return (
                        <div key={i} className="py-2.5 flex flex-col gap-2 text-xs">
                          <div className="flex justify-between items-start gap-2">
                            <span className="font-bold text-sm text-foreground">{lead.name}</span>
                            <span className="text-emerald-400 font-mono whitespace-nowrap text-xs font-semibold">
                              {lead.phones ? formatPhoneNumber(lead.phones) : "—"}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-1 text-muted-foreground">
                            <div className="col-span-2"><strong className="text-foreground/80">Cat:</strong> {lead.categories || "—"}</div>
                            <div><strong className="text-foreground/80">Rating:</strong> {lead.averageRating ? `${lead.averageRating} ⭐` : "—"}</div>
                            <div><strong className="text-foreground/80">Reviews:</strong> {lead.reviewCount || "0"}</div>
                            <div className="col-span-2"><strong className="text-foreground/80">End:</strong> {lead.fullAddress || "—"}</div>
                            {lead.cep && <div className="col-span-2"><strong className="text-foreground/80">CEP:</strong> {lead.cep}</div>}
                            {lead.priceRange && <div><strong className="text-foreground/80">Preço:</strong> {lead.priceRange}</div>}
                            {lead.openNow && <div className="col-span-2"><strong className="text-foreground/80">Status:</strong> {lead.openNow}</div>}
                            {lead.website && (
                              <div className="col-span-2 truncate">
                                <strong className="text-foreground/80">Web:</strong>{" "}
                                <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                  {lead.website}
                                </a>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2 pt-1">
                            {temExtras ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1 text-[10px] h-7 px-2.5"
                                onClick={() => setSelectedLead(lead)}
                              >
                                <Eye className="w-3 h-3" /> Ver Detalhes ({(lead.reviewsDetalhes?.length || 0)} reviews, {(lead.photos?.length || 0)} fotos)
                              </Button>
                            ) : <span />}
                            <span className="text-[10px] text-muted-foreground/60">{lead.extractedAt}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Console Embutido na Aba Leads (quando o usuário deseja monitorar sem alternar abas) */}
            {showConsoleInLeads && (
              <Card className="border-border/60 bg-card/80 shadow-xs">
                <CardHeader className="py-2.5 px-4 border-b border-border/40 flex flex-row items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-semibold">Monitor de Execução em Tempo Real</span>
                  </div>
                  <Button variant="ghost" size="sm" className="text-xs h-6 px-2 text-muted-foreground" onClick={() => setShowConsoleInLeads(false)}>
                    Fechar
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="bg-[oklch(0.08_0.01_260)] h-48 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
                    {logs.map((log, i) => (
                      <div key={i} className="flex items-start gap-1.5 py-0.5">
                        <span className="text-muted-foreground/50 shrink-0">[{log.time}]</span>
                        <span className={cn(
                          log.type === "success" && "text-emerald-300",
                          log.type === "error" && "text-red-400",
                          log.type === "warning" && "text-amber-300",
                          log.type === "info" && "text-muted-foreground/90",
                        )}>
                          {log.message}
                        </span>
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* ---- Modal: Detalhes Completos do Lead ---- */}
      <Dialog open={!!selectedLead} onOpenChange={(open) => !open && setSelectedLead(null)}>
        <DialogContent style={CAPTADOR_COLORS} className="captador-surface max-w-[calc(100%-2rem)] sm:max-w-[min(56rem,calc(100%-2rem))] max-h-[92vh] overflow-y-auto bg-card border-border/70 p-4 sm:p-6 shadow-xl">
          {selectedLead && <LeadDetailContent lead={selectedLead} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================================
// Componente de Detalhes do Lead (Modal)
// ============================================================================
function LeadDetailContent({ lead }: { lead: Lead }) {
  const [modalTab, setModalTab] = useState<"geral" | "reviews" | "fotos" | "detalhes">("geral");
  const bd = lead.businessDetails || {};
  const redes = bd.redesAdicionais || {};
  const dist = lead.distribuicaoEstrelas || {};
  const distKeys = ["5estrelas", "4estrelas", "3estrelas", "2estrelas", "1estrelas"];
  const totalDist = Object.values(dist).reduce((s, v) => s + (v || 0), 0);
  const waUrl = getWhatsAppUrl(lead.phones);

  return (
    <div className="space-y-4">
      <DialogHeader className="space-y-1 pr-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <DialogTitle className="flex items-center gap-2 text-lg sm:text-xl font-bold tracking-tight">
              <Building2 className="w-5 h-5 text-primary shrink-0" />
              {lead.name}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {lead.categories || "Sem categoria"} · {lead.fullAddress || "Sem endereço"}
            </p>
          </div>
          {lead.mapsUrl && (
            <a
              href={lead.mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary font-medium hover:underline self-start shrink-0"
            >
              <MapPinned className="w-3.5 h-3.5" /> Abrir no Google Maps
            </a>
          )}
        </div>
      </DialogHeader>

      {/* Badges Principais de Status e Reputação */}
      <div className="flex flex-wrap gap-1.5">
        {lead.averageRating && (
          <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-xs font-semibold">
            <Star className="w-3.5 h-3.5 mr-1 fill-amber-400" />
            {lead.averageRating} ({lead.reviewCount || 0} avaliações)
          </Badge>
        )}
        {lead.priceRange && <Badge variant="secondary" className="text-xs">{lead.priceRange}</Badge>}
        {lead.openNow && (
          <Badge className={lead.openNow.toLowerCase().includes("aberto") ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-xs" : "bg-red-500/15 text-red-400 border-red-500/30 text-xs"}>
            <Clock className="w-3.5 h-3.5 mr-1" />{lead.openNow}
          </Badge>
        )}
        {lead.cep && <Badge variant="outline" className="text-xs font-mono">CEP: {lead.cep}</Badge>}
        {lead.plusCode && <Badge variant="outline" className="text-xs font-mono"><MapPinned className="w-3 h-3 mr-1" />{lead.plusCode}</Badge>}
      </div>

      {/* Navegação Interna do Modal */}
      <div className="flex flex-wrap items-center border-b border-border/60 gap-2 pb-1" role="group" aria-label="Seções dos detalhes do lead">
        <button
          type="button"
          onClick={() => setModalTab("geral")}
          aria-pressed={modalTab === "geral"}
          className={cn(
            "text-xs font-medium min-h-9 focus-visible:outline-2 focus-visible:outline-primary pb-2 px-3 border-b-2 transition-colors cursor-pointer",
            modalTab === "geral" ? "border-primary text-foreground font-semibold" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          Visão Geral & Contatos
        </button>
        {((lead.reviewsDetalhes?.length ?? 0) > 0 || totalDist > 0) && (
          <button
            type="button"
            onClick={() => setModalTab("reviews")}
            aria-pressed={modalTab === "reviews"}
            className={cn(
              "text-xs font-medium min-h-9 focus-visible:outline-2 focus-visible:outline-primary pb-2 px-3 border-b-2 transition-colors cursor-pointer flex items-center gap-1.5",
              modalTab === "reviews" ? "border-primary text-foreground font-semibold" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            Avaliações <Badge variant="secondary" className="text-[10px] px-1 py-0">{lead.reviewsDetalhes?.length ?? 0}</Badge>
          </button>
        )}
        {lead.photos && lead.photos.length > 0 && (
          <button
            type="button"
            onClick={() => setModalTab("fotos")}
            aria-pressed={modalTab === "fotos"}
            className={cn(
              "text-xs font-medium min-h-9 focus-visible:outline-2 focus-visible:outline-primary pb-2 px-3 border-b-2 transition-colors cursor-pointer flex items-center gap-1.5",
              modalTab === "fotos" ? "border-primary text-foreground font-semibold" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            Fotos <Badge variant="secondary" className="text-[10px] px-1 py-0">{lead.photos.length}</Badge>
          </button>
        )}
        {(bd.subcategorias?.length || bd.services?.length || bd.pessoasProcuramPor?.length || bd.about || bd.descricao || bd.popularTimes) && (
          <button
            type="button"
            onClick={() => setModalTab("detalhes")}
            aria-pressed={modalTab === "detalhes"}
            className={cn(
              "text-xs font-medium min-h-9 focus-visible:outline-2 focus-visible:outline-primary pb-2 px-3 border-b-2 transition-colors cursor-pointer",
              modalTab === "detalhes" ? "border-primary text-foreground font-semibold" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            Detalhes Comerciais
          </button>
        )}
      </div>

      {/* CONTEÚDO DA ABA 1: GERAL */}
      {modalTab === "geral" && (
        <div className="space-y-4 pt-1">
          {/* Ações de Contato Direto */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded-lg border border-border/60 bg-secondary/20 space-y-1">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground">Telefone Comercial</span>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold font-mono text-emerald-400">
                  {formatPhoneNumber(lead.phones)}
                </span>
                <div className="flex items-center gap-1">
                  <CopyButton text={lead.phones} title="Copiar telefone" />
                  {waUrl && (
                    <a
                      href={waUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 text-xs font-medium"
                    >
                      <MessageCircle className="w-3 h-3" /> WhatsApp
                    </a>
                  )}
                </div>
              </div>
            </div>

            <div className="p-3 rounded-lg border border-border/60 bg-secondary/20 space-y-1">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground">Website</span>
              <div className="flex items-center justify-between">
                {lead.website ? (
                  <a
                    href={lead.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline font-medium truncate max-w-[200px]"
                  >
                    {safeHostname(lead.website)}
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">Sem site cadastrado</span>
                )}
                {lead.website && (
                  <a
                    href={lead.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    Visitar <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Redes Sociais */}
          {(lead.instagram || lead.facebook || Object.keys(redes).length > 0) && (
            <div className="p-3 rounded-lg border border-border/60 bg-secondary/15 space-y-2">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Presença Digital & Redes</span>
              <div className="flex flex-wrap gap-2">
                {lead.instagram && (
                  <a href={lead.instagram} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary text-xs hover:text-primary">
                    <Link2 className="w-3 h-3 text-pink-400" /> Instagram
                  </a>
                )}
                {lead.facebook && (
                  <a href={lead.facebook} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary text-xs hover:text-primary">
                    <Link2 className="w-3 h-3 text-blue-400" /> Facebook
                  </a>
                )}
                {Object.entries(redes).map(([k, v]) => (
                  <a key={k} href={v} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary text-xs hover:text-primary capitalize">
                    <Link2 className="w-3 h-3" /> {k}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Horários de funcionamento */}
          {lead.openingHours && Object.keys(lead.openingHours).length > 0 && (
            <div className="p-3 rounded-lg border border-border/60 bg-secondary/15 space-y-2">
              <div className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1.5">
                <Clock className="w-3 h-3" /> Horários de Funcionamento
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs">
                {Object.entries(lead.openingHours).map(([dia, hora]) => (
                  <div key={dia} className="flex justify-between gap-2 p-1 rounded bg-background/40">
                    <span className="text-muted-foreground capitalize font-medium">{dia}:</span>
                    <span className="font-mono text-foreground">{String(hora)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Atributos do Google Maps */}
          {lead.attributes && lead.attributes.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] uppercase font-semibold text-muted-foreground">
                Atributos e Comodidades ({lead.attributes.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {lead.attributes.map((a, i) => (
                  <Badge key={i} variant="secondary" className="text-[10px] font-normal">{a}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Dados Técnicos de Localização */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs pt-1">
            <DetailRow label="Place ID" value={lead.placeId || ""} mono />
            <DetailRow label="Coordenadas" value={lead.lat && lead.lng ? `${lead.lat}, ${lead.lng}` : ""} mono />
            {bd.menuUrl && <DetailRow label="Cardápio / Menu" value={bd.menuUrl} link />}
            {bd.reservaUrl && <DetailRow label="Reservas" value={bd.reservaUrl} link />}
          </div>
        </div>
      )}

      {/* CONTEÚDO DA ABA 2: AVALIAÇÕES */}
      {modalTab === "reviews" && (
        <div className="space-y-4 pt-1">
          {/* Distribuição de Estrelas */}
          {totalDist > 0 && (
            <div className="p-4 rounded-xl border border-border/60 bg-secondary/20 space-y-2">
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Star className="w-4 h-4 text-amber-400 fill-amber-400" /> Distribuição de Notas no Google
              </div>
              <div className="space-y-1.5 pt-1">
                {distKeys.map((k) => {
                  const count = dist[k] || 0;
                  const pct = totalDist > 0 ? (count / totalDist) * 100 : 0;
                  const star = k.charAt(0);
                  return (
                    <div key={k} className="flex items-center gap-2 text-xs">
                      <span className="w-3 text-amber-400 font-bold">{star}</span>
                      <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full bg-amber-400/80 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-16 text-right font-mono text-[11px] text-muted-foreground">
                        {count} ({pct.toFixed(0)}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Lista de Reviews Detalhadas */}
          {lead.reviewsDetalhes && lead.reviewsDetalhes.length > 0 && (
            <div className="space-y-3">
              <span className="text-xs font-semibold text-muted-foreground block">
                Comentários de Clientes ({lead.reviewsDetalhes.length})
              </span>
              <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
                {lead.reviewsDetalhes.map((r, i) => (
                  <article key={`${r.autor || "anon"}-${r.data || i}-${i}`} className="rounded-xl border border-border/60 bg-secondary/15 p-3.5 space-y-2.5">
                    <div className="flex items-start gap-3">
                      {r.fotoAutor ? (
                        <img src={r.fotoAutor} alt={r.autor || "Autor"} className="w-8 h-8 rounded-full object-cover ring-1 ring-border shrink-0" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center text-xs shrink-0">
                          👤
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-foreground truncate">{r.autor || "Cliente Google"}</p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                          {r.nota && (
                            <span className="inline-flex items-center gap-1 font-semibold text-amber-400">
                              <Star className="w-2.5 h-2.5 fill-amber-400" />{r.nota}/5
                            </span>
                          )}
                          {r.data && <span>· {r.data}</span>}
                          {r.util ? <span>· 👍 {r.util} acharam útil</span> : null}
                        </div>
                      </div>
                    </div>

                    {r.texto && (
                      <p className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
                        {r.texto}
                      </p>
                    )}

                    {r.fotos && r.fotos.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {r.fotos.map((f, j) => (
                          <a key={j} href={f} target="_blank" rel="noopener noreferrer" className="w-14 h-14 rounded-md overflow-hidden border border-border hover:opacity-80 transition-opacity">
                            <img src={f} alt={`Foto da review ${j + 1}`} className="w-full h-full object-cover" loading="lazy" />
                          </a>
                        ))}
                      </div>
                    )}

                    {r.respostaDono && (
                      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] p-3 text-xs space-y-1">
                        <div className="flex items-center gap-1.5 font-bold text-emerald-400 text-[11px] uppercase tracking-wide">
                          <Building2 className="w-3.5 h-3.5" /> Resposta do estabelecimento
                        </div>
                        <p className="text-xs leading-relaxed text-emerald-100/90 whitespace-pre-wrap">
                          {r.respostaDono}
                        </p>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* CONTEÚDO DA ABA 3: FOTOS */}
      {modalTab === "fotos" && lead.photos && (
        <div className="pt-1">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 max-h-[55vh] overflow-y-auto pr-1">
            {lead.photos.map((url, i) => (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="group relative aspect-square rounded-lg overflow-hidden border border-border bg-secondary/30 block"
              >
                <img src={url} alt={`Foto ${i + 1}`} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-medium">
                  <ExternalLink className="w-4 h-4" />
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* CONTEÚDO DA ABA 4: DETALHES COMERCIAIS */}
      {modalTab === "detalhes" && (
        <div className="space-y-4 pt-1">
          {(bd.about || bd.descricao) && (
            <div className="p-3.5 rounded-lg border border-border/60 bg-secondary/15 space-y-1.5">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground block">Descrição do Estabelecimento</span>
              <p className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed">
                {bd.descricao || bd.about}
              </p>
              {bd.about && bd.about !== bd.descricao && bd.descricao && (
                <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{bd.about}</p>
              )}
              {bd.atualizadoEm && (
                <p className="text-[10px] text-muted-foreground/60 pt-1">Atualizado há: {bd.atualizadoEm}</p>
              )}
            </div>
          )}

          {bd.subcategorias && bd.subcategorias.length > 0 && (
            <DetailList label="Subcategorias no Google Maps" items={bd.subcategorias} />
          )}

          {bd.services && bd.services.length > 0 && (
            <DetailList label="Serviços Oferecidos" items={bd.services} />
          )}

          {bd.pessoasProcuramPor && bd.pessoasProcuramPor.length > 0 && (
            <DetailList label="As Pessoas Também Procuram Por" items={bd.pessoasProcuramPor} />
          )}

          {/* Popular times / Horários de Movimento */}
          {bd.popularTimes && Object.keys(bd.popularTimes).length > 0 && (
            <div className="p-3.5 rounded-lg border border-border/60 bg-secondary/15 space-y-2">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1.5">
                <Clock className="w-3 h-3" /> Horários de Pico (Popular Times)
              </span>
              {bd.popularTimes.atual && (
                <p className="text-xs text-emerald-400 font-medium">Movimentação agora: {bd.popularTimes.atual}</p>
              )}
              <div className="space-y-2 pt-1">
                {Object.entries(bd.popularTimes)
                  .filter(([k]) => k !== "atual")
                  .map(([dia, horas]) => (
                    <div key={dia} className="text-xs">
                      <div className="text-muted-foreground capitalize text-[11px] mb-1">{dia}:</div>
                      <div className="flex items-end gap-0.5 h-8 bg-background/50 p-1 rounded">
                        {Array.isArray(horas) && horas.map((h, i) => (
                          <div key={i} className="flex-1 flex flex-col items-center justify-end h-full" title={`${h.hora}h: ${h.ocupacao}%`}>
                            <div
                              className="w-full bg-primary/50 hover:bg-primary rounded-t transition-colors"
                              style={{ height: `${Math.max(4, h.ocupacao)}%` }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono, link }: { label: string; value: string; mono?: boolean; link?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5 p-2 rounded bg-secondary/20 border border-border/40">
      <span className="text-[10px] uppercase font-semibold text-muted-foreground">{label}</span>
      {link ? (
        <a href={value} target="_blank" rel="noopener noreferrer" className={cn("text-xs text-primary hover:underline truncate", mono && "font-mono")}>
          {value}
        </a>
      ) : (
        <span className={cn("text-xs text-foreground/90 break-words", mono && "font-mono")}>{value}</span>
      )}
    </div>
  );
}

function DetailList({ label, items }: { label: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="p-3 rounded-lg border border-border/50 bg-secondary/15 space-y-1.5">
      <div className="text-[10px] uppercase font-semibold text-muted-foreground">{label}:</div>
      <div className="flex flex-wrap gap-1">
        {items.map((s, i) => (
          <Badge key={i} variant="outline" className="text-[10px] font-normal bg-background/50">{s}</Badge>
        ))}
      </div>
    </div>
  );
}
