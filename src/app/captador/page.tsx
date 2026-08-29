"use client";

import type { ReactNode } from "react";
import { useState, useRef, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  MapPin, Rocket, Square, Webhook, Filter, Loader2, CheckCircle2, XCircle, Terminal,
  Download, Trash2, Send, ToggleLeft, Eye, Star, Clock, Image as ImageIcon, Link2, MapPinned, MessageSquare, Building2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

interface ReviewDetalhe {
  autor?: string;
  nota?: string;
  data?: string;
  texto?: string;
  fotoAutor?: string;  fotos?: string[];
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

interface BusinessDetails {
  about?: string;
  descricao?: string;
  services?: string[];
  subcategorias?: string[];
  pessoasProcuramPor?: string[];
  popularTimes?: Record<string, any>;
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
  categories: string;
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
  openingHours?: Record<string, any>;
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
  const [activeTab, setActiveTab] = useState<"config" | "leads">("config");
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
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
    // Also fetch existing leads
    fetch("/api/scraper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "get_leads" }) })
      .then((r) => r.json())
      .then((d) => { if (d.leads) setLeads(d.leads); })
      .catch(() => {});
    return () => { eventSourceRef.current?.close(); };
  }, [connectSSE]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  async function handleStart() {
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
          captureAllReviews,
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
    await fetch("/api/scraper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    });
    setLeads([]);
    addLog("Leads limpos.", "info");
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
        // Basic landline check: 10 digits or 12 starting with 55 (and not 9th digit)
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
    const reviewsRows: any[][] = [];
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
    const fotosRows: any[][] = [];
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

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      <Header />
      <div className="flex-1 p-3 sm:p-6 space-y-4 overflow-y-auto w-full max-w-7xl mx-auto mobile-safe-bottom">
        {/* Tab Switcher */}
        <div className="flex items-center gap-2">
          <Button variant={activeTab === "config" ? "default" : "ghost"} size="sm" className="gap-2 text-xs" onClick={() => setActiveTab("config")}>
            <MapPin className="w-3.5 h-3.5" /> Configuração
          </Button>
          <Button variant={activeTab === "leads" ? "default" : "ghost"} size="sm" className="gap-2 text-xs" onClick={() => setActiveTab("leads")}>
            <Terminal className="w-3.5 h-3.5" /> Leads & Console
            {leads.length > 0 && <Badge variant="secondary" className="ml-1 text-[10px]">{leads.length}</Badge>}
          </Button>
          {isRunning && (
            <Badge className={cn(
                "ml-auto animate-pulse text-[10px]",
                isPaused ? "bg-amber-500/20 text-amber-400 border-amber-500/30" : "bg-green-500/20 text-green-400 border-green-500/30"
            )}>
              {isPaused ? <Square className="w-3 h-3 mr-1" /> : <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              {isPaused ? "Pausado" : "Extraindo..."}
            </Badge>
          )}
        </div>

        {activeTab === "config" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Config Panel */}
            <Card className="border-border/50 bg-card/80">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-primary" />
                  <CardTitle className="text-sm font-semibold">Configuração da Captação</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">Nichos (um por linha)</label>
                    <Textarea placeholder={"Contabilidade\nAdvocacia\nPsicologia"} value={niches} onChange={(e) => setNiches(e.target.value)} className="h-32 bg-secondary/50 border-border/50 text-sm resize-none" />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">Regiões (uma por linha)</label>
                    <Textarea placeholder={"São Paulo SP\nSerra ES\nVitória ES"} value={regions} onChange={(e) => setRegions(e.target.value)} className="h-32 bg-secondary/50 border-border/50 text-sm resize-none" />
                  </div>
                </div>


                <Separator />

                {/* Filters */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <div className="flex items-center gap-1.5">
                      <Filter className="w-3 h-3 text-muted-foreground" />
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Filtros Automáticos</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <label htmlFor="capture-all-reviews" className="text-xs text-muted-foreground cursor-pointer">Capturar todas as avaliações</label>
                      <Switch id="capture-all-reviews" checked={captureAllReviews} onCheckedChange={setCaptureAllReviews} size="sm" />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground/80">Quando ativado, carrega e salva todos os comentários e avaliações disponíveis no Google Maps. A captação pode levar mais tempo.</p>
                  {[
                    { label: "Remover leads sem telefone", value: filterEmpty, set: setFilterEmpty },
                    { label: "Remover telefones duplicados", value: filterDuplicates, set: setFilterDuplicates },
                    { label: "Remover telefones fixos", value: filterLandlines, set: setFilterLandlines },
                  ].map((f) => (
                    <div 
                      key={f.label} 
                      className="flex items-center justify-between p-2 rounded-lg hover:bg-secondary/20 cursor-pointer"
                      onClick={() => f.set(!f.value)}
                    >
                      <span className="text-sm text-foreground/90 select-none flex-1">{f.label}</span>
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

                <Separator />

                <div className="flex flex-col gap-3">
                  <div className="flex gap-2">
                    {!isRunning ? (
                        <Button className="flex-1 gap-2 glow-primary" onClick={handleStart}>
                            <Rocket className="w-4 h-4" /> Iniciar Captação
                        </Button>
                    ) : (
                        <>
                           {isPaused ? (
                               <Button className="flex-1 gap-2 bg-green-600 hover:bg-green-700" onClick={handleResume}>
                                   <Rocket className="w-4 h-4" /> Retomar
                               </Button>
                           ) : (
                               <Button className="flex-1 gap-2 bg-amber-600 hover:bg-amber-700" onClick={handlePause}>
                                   <Square className="w-4 h-4" /> Pausar
                               </Button>
                           )}
                           <Button variant="destructive" className="px-6" onClick={handleStop}>
                                Parar
                           </Button>
                        </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Console */}
            <Card className="border-border/50 bg-card/80 flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-primary" />
                    <CardTitle className="text-sm font-semibold">Console de Logs</CardTitle>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[10px]">{logs.length} logs</Badge>
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setLogs([])}>Limpar</Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 p-0">
                <div className="bg-[oklch(0.08_0.01_260)] rounded-b-lg h-[420px] overflow-y-auto p-4 font-mono text-xs leading-6">
                  {logs.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground/40">
                      <p>Aguardando execução...</p>
                    </div>
                  ) : (
                    logs.map((log, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-muted-foreground/60 shrink-0">[{log.time}]</span>
                        {log.type === "success" && <CheckCircle2 className="w-3 h-3 mt-1 text-green-400 shrink-0" />}
                        {log.type === "error" && <XCircle className="w-3 h-3 mt-1 text-red-400 shrink-0" />}
                        <span className={cn(
                          log.type === "success" && "text-green-400",
                          log.type === "error" && "text-red-400",
                          log.type === "warning" && "text-amber-400",
                          log.type === "info" && "text-muted-foreground",
                        )}>{log.message}</span>
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "leads" && (
          <Card className="border-border/50 bg-card/80">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ToggleLeft className="w-4 h-4 text-primary" />
                  <CardTitle className="text-sm font-semibold">Clientes Extraídos</CardTitle>
                  <Badge variant="secondary" className="text-[10px]">{leads.length} clientes</Badge>
                </div>
                <div className="flex items-center gap-2">
                  {webhookEnabled && leads.length > 0 && sendMode === "batch" && (
                    <Button variant="outline" size="sm" className="gap-2 text-xs" onClick={handleSendBatch}>
                      <Send className="w-3 h-3" /> Enviar para n8n
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="gap-2 text-[10px] uppercase font-bold text-amber-500 hover:text-amber-400" onClick={filterLocalDuplicates}>
                    Duplicados
                  </Button>
                  <Button variant="ghost" size="sm" className="gap-2 text-[10px] uppercase font-bold text-amber-500 hover:text-amber-400" onClick={filterLocalLandlines}>
                    Fixos
                  </Button>
                  <Button variant="ghost" size="sm" className="gap-2 text-[10px] uppercase font-bold text-amber-500 hover:text-amber-400" onClick={filterLocalEmpty}>
                    Sem Tel
                  </Button>
                  <div className="w-px h-4 bg-border/50 mx-1" />
                  <Button variant="outline" size="sm" className="gap-2 text-xs" onClick={handleExport} disabled={leads.length === 0}>
                    <Download className="w-3" /> Exportar
                  </Button>
                  <Button variant="ghost" size="sm" className="gap-2 text-xs text-red-400" onClick={handleClear} disabled={leads.length === 0}>
                    <Trash2 className="w-3" /> Limpar
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto max-h-[500px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border/50 hover:bg-transparent">
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Nome do Negócio</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Telefone</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Categoria</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Endereço</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Avaliação</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Reviews</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Detalhes</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Website</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Extraído Em</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leads.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center py-12 text-muted-foreground text-sm">
                          {isRunning ? "Aguardando leads..." : "Nenhum lead extraído"}
                        </TableCell>
                      </TableRow>
                    ) : (
                      leads.map((lead, i) => {
                        const temExtras = (lead.reviewsDetalhes?.length || 0) + (lead.photos?.length || 0) + (lead.businessDetails ? 1 : 0) + (lead.attributes?.length || 0) > 0;
                        return (
                          <TableRow key={i} className="border-border/30 text-xs">
                            <TableCell className="font-medium max-w-[200px] truncate">{lead.name}</TableCell>
                            <TableCell className="text-green-400 font-mono whitespace-nowrap">{lead.phones || "—"}</TableCell>
                            <TableCell className="max-w-[150px] truncate">{lead.categories}</TableCell>
                            <TableCell className="max-w-[200px] truncate text-muted-foreground">{lead.fullAddress}</TableCell>
                            <TableCell className="text-center whitespace-nowrap">
                              {lead.averageRating ? (
                                <span className="inline-flex items-center gap-0.5">
                                  <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                                  {lead.averageRating}
                                </span>
                              ) : "—"}
                            </TableCell>
                            <TableCell className="text-center">
                              {lead.reviewCount || "—"}
                              {lead.distribuicaoEstrelas && Object.keys(lead.distribuicaoEstrelas).length > 0 && (
                                <span className="block text-[9px] text-muted-foreground/60 mt-0.5">{lead.reviewsDetalhes?.length || 0} detalhadas</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1 text-[10px] h-6 px-2"
                                onClick={() => setSelectedLead(lead)}
                                disabled={!temExtras}
                                title={temExtras ? "Ver reviews, fotos, horários e detalhes" : "Sem detalhes extras"}
                              >
                                <Eye className="w-3 h-3" />
                                {temExtras ? "Ver" : "—"}
                              </Button>
                            </TableCell>
                            <TableCell className="max-w-[150px] truncate">
                              {lead.website ? <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{safeHostname(lead.website)}</a> : "—"}
                            </TableCell>
                            <TableCell className="text-muted-foreground whitespace-nowrap">{lead.extractedAt}</TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile card list */}
              <div className="sm:hidden divide-y divide-white/[0.03] max-h-[500px] overflow-y-auto p-4 space-y-4">
                {leads.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground text-sm">
                    {isRunning ? "Aguardando leads..." : "Nenhum lead extraído"}
                  </div>
                ) : (
                  leads.map((lead, i) => {
                    const temExtras = (lead.reviewsDetalhes?.length || 0) + (lead.photos?.length || 0) + (lead.businessDetails ? 1 : 0) > 0;
                    return (
                      <div key={i} className="py-2 flex flex-col gap-2 text-xs">
                        <div className="flex justify-between items-start gap-2">
                          <span className="font-bold text-sm text-white">{lead.name}</span>
                          <span className="text-green-400 font-mono whitespace-nowrap">{lead.phones || "—"}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-muted-foreground">
                          <div className="col-span-2"><strong className="text-white/60">Cat:</strong> {lead.categories || "—"}</div>
                          <div><strong className="text-white/60">Rating:</strong> {lead.averageRating ? `${lead.averageRating} ⭐` : "—"}</div>
                          <div><strong className="text-white/60">Reviews:</strong> {lead.reviewCount || "0"}</div>
                          <div className="col-span-2"><strong className="text-white/60">End:</strong> {lead.fullAddress || "—"}</div>
                          {lead.cep && <div className="col-span-2"><strong className="text-white/60">CEP:</strong> {lead.cep}</div>}
                          {lead.priceRange && <div><strong className="text-white/60">Preço:</strong> {lead.priceRange}</div>}
                          {lead.openNow && <div className="col-span-2"><strong className="text-white/60">Status:</strong> {lead.openNow}</div>}
                          {lead.website && (
                            <div className="col-span-2 truncate">
                              <strong className="text-white/60">Web:</strong>{" "}
                              <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                {lead.website}
                              </a>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          {temExtras ? (
                            <Button variant="outline" size="sm" className="gap-1 text-[10px] h-6" onClick={() => setSelectedLead(lead)}>
                              <Eye className="w-3 h-3" /> Ver Detalhes ({(lead.reviewsDetalhes?.length || 0)} reviews, {(lead.photos?.length || 0)} fotos)
                            </Button>
                          ) : <span />}
                          <span className="text-[10px] text-muted-foreground/40">{lead.extractedAt}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ---- Modal: Detalhes Completos do Lead ---- */}
      <Dialog open={!!selectedLead} onOpenChange={(open) => !open && setSelectedLead(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-card border-border/50">
          {selectedLead && <LeadDetailContent lead={selectedLead} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================================
// Componente separado: exibe TODOS os campos capturados de um lead dentro do
// modal. Inclui: localização (lat/lng/placeId/plusCode), horários, atributos,
// distribuição de estrelas, fotos, redes sociais, "Sobre", serviços,
// subcategorias, popular times, e reviews com fotoAutor + fotos anexas +
// resposta do dono + contador útil.
// ============================================================================
function LeadDetailContent({ lead }: { lead: Lead }) {
  const bd = lead.businessDetails || {};
  const redes = bd.redesAdicionais || {};
  const dist = lead.distribuicaoEstrelas || {};
  const distKeys = ["5estrelas", "4estrelas", "3estrelas", "2estrelas", "1estrelas"];
  const totalDist = Object.values(dist).reduce((s, v) => s + (v || 0), 0);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-lg">
          <MapPin className="w-4 h-4 text-primary" />
          {lead.name}
        </DialogTitle>
        <p className="text-xs text-muted-foreground -mt-1">{lead.categories || "Sem categoria"} · {lead.fullAddress || "Sem endereço"}</p>
      </DialogHeader>

      {/* Linha de badges principais */}
      <div className="flex flex-wrap gap-1.5 mt-2">
        {lead.averageRating && (
          <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]">
            <Star className="w-3 h-3 mr-1 fill-amber-400" />{lead.averageRating} · {lead.reviewCount} avaliações
          </Badge>
        )}
        {lead.priceRange && <Badge variant="secondary" className="text-[10px]">{lead.priceRange}</Badge>}
        {lead.openNow && (
          <Badge className={lead.openNow.toLowerCase().includes("aberto") ? "bg-green-500/15 text-green-400 border-green-500/30 text-[10px]" : "bg-red-500/15 text-red-400 border-red-500/30 text-[10px]"}>
            <Clock className="w-3 h-3 mr-1" />{lead.openNow}
          </Badge>
        )}
        {lead.cep && <Badge variant="outline" className="text-[10px]">CEP: {lead.cep}</Badge>}
        {lead.plusCode && <Badge variant="outline" className="text-[10px]"><MapPinned className="w-3 h-3 mr-1" />{lead.plusCode}</Badge>}
      </div>

      {/* Localização e contatos */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <DetailRow label="Telefone" value={lead.phones || "—"} mono />
        <DetailRow label="Website" value={lead.website || ""} link />
        <DetailRow label="Instagram" value={lead.instagram || ""} link />
        <DetailRow label="Facebook" value={lead.facebook || ""} link />
        {(redes.linkedin || redes.twitter || redes.youtube || redes.tiktok || redes.whatsapp || redes.telegram || redes.pinterest) && (
          <div className="sm:col-span-2">
            <div className="text-[10px] uppercase font-semibold text-muted-foreground mb-1">Redes Adicionais</div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(redes).map(([k, v]) => (
                <a key={k} href={v} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 rounded bg-secondary/50 hover:bg-secondary text-[10px]">
                  <Link2 className="w-3 h-3" />{k}
                </a>
              ))}
            </div>
          </div>
        )}
        {(lead.lat && lead.lng) && (
          <DetailRow label="Lat/Lng" value={`${lead.lat}, ${lead.lng}`} mono />
        )}
        {lead.placeId && <DetailRow label="Place ID" value={lead.placeId} mono />}
        {bd.menuUrl && <DetailRow label="Menu" value={bd.menuUrl} link />}
        {bd.reservaUrl && <DetailRow label="Reservas" value={bd.reservaUrl} link />}
        {lead.mapsUrl && <DetailRow label="Maps URL" value={lead.mapsUrl} link />}
      </div>

      {/* Distribuição de estrelas */}
      {totalDist > 0 && (
        <div className="mt-4">
          <div className="text-[10px] uppercase font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
            <Star className="w-3 h-3 text-amber-400" />Distribuição de Estrelas
          </div>
          <div className="space-y-1.5">
            {distKeys.map((k) => {
              const count = dist[k] || 0;
              const pct = totalDist > 0 ? (count / totalDist) * 100 : 0;
              const star = k.charAt(0);
              return (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <span className="w-3 text-amber-400">{star}</span>
                  <div className="flex-1 h-2 rounded-full bg-secondary/50 overflow-hidden">
                    <div className="h-full bg-amber-400/70" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-16 text-right text-muted-foreground">{count} ({pct.toFixed(0)}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Horários de funcionamento */}
      {lead.openingHours && Object.keys(lead.openingHours).length > 0 && (
        <DetailSection title="Horários de Funcionamento" icon={<Clock className="w-3 h-3" />}>
          <div className="grid grid-cols-2 gap-1 text-xs">
            {Object.entries(lead.openingHours).map(([dia, hora]) => (
              <div key={dia} className="flex justify-between gap-2">
                <span className="text-muted-foreground capitalize">{dia}:</span>
                <span className="font-mono text-foreground/90">{String(hora)}</span>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      {/* Atributos */}
      {lead.attributes && lead.attributes.length > 0 && (
        <DetailSection title={`Atributos (${lead.attributes.length})`} icon={<MapPin className="w-3 h-3" />}>
          <div className="flex flex-wrap gap-1.5">
            {lead.attributes.map((a, i) => (
              <Badge key={i} variant="secondary" className="text-[10px]">{a}</Badge>
            ))}
          </div>
        </DetailSection>
      )}

      {/* Subcategorias / Serviços / "Pessoas procuram por" */}
      {(bd.subcategorias?.length || bd.services?.length || bd.pessoasProcuramPor?.length) && (
        <DetailSection title="Detalhes do Negócio" icon={<MapPin className="w-3 h-3" />}>
          {bd.subcategorias && bd.subcategorias.length > 0 && (
            <DetailList label="Subcategorias" items={bd.subcategorias} />
          )}
          {bd.services && bd.services.length > 0 && (
            <DetailList label="Serviços" items={bd.services} />
          )}
          {bd.pessoasProcuramPor && bd.pessoasProcuramPor.length > 0 && (
            <DetailList label="As pessoas procuram por" items={bd.pessoasProcuramPor} />
          )}
        </DetailSection>
      )}

      {/* Descrição / Sobre */}
      {(bd.about || bd.descricao) && (
        <DetailSection title="Descrição" icon={<MapPin className="w-3 h-3" />}>
          {bd.descricao && <p className="text-xs text-foreground/80 whitespace-pre-wrap">{bd.descricao}</p>}
          {bd.about && bd.about !== bd.descricao && (
            <p className="text-xs text-muted-foreground whitespace-pre-wrap mt-2">{bd.about}</p>
          )}
          {bd.atualizadoEm && <p className="text-[10px] text-muted-foreground/60 mt-2">Atualizado há: {bd.atualizadoEm}</p>}
        </DetailSection>
      )}

      {/* Popular times */}
      {bd.popularTimes && Object.keys(bd.popularTimes).length > 0 && (
        <DetailSection title="Horários de Movimento (Popular Times)" icon={<Clock className="w-3 h-3" />}>
          {bd.popularTimes.atual && <p className="text-xs text-green-400 mb-2">Movimentação atual: {bd.popularTimes.atual}</p>}
          <div className="space-y-1.5">
            {Object.entries(bd.popularTimes)
              .filter(([k]) => k !== "atual")
              .map(([dia, horas]: [string, any]) => (
                <div key={dia} className="text-xs">
                  <div className="text-muted-foreground capitalize mb-0.5">{dia}:</div>
                  <div className="flex items-end gap-0.5 h-8">
                    {Array.isArray(horas) && horas.map((h: any, i: number) => (
                      <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${h.hora}h: ${h.ocupacao}%`}>
                        <div
                          className="w-full bg-primary/40 hover:bg-primary rounded-t"
                          style={{ height: `${h.ocupacao}%` }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </DetailSection>
      )}

      {/* Fotos */}
      {lead.photos && lead.photos.length > 0 && (
        <DetailSection title={`Fotos (${lead.photos.length})`} icon={<ImageIcon className="w-3 h-3" />}>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {lead.photos.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block aspect-square rounded overflow-hidden bg-secondary/30 hover:opacity-80">
                <img src={url} alt={`Foto ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
              </a>
            ))}
          </div>
        </DetailSection>
      )}

      {lead.reviewsDetalhes && lead.reviewsDetalhes.length > 0 && (
        <DetailSection title={`Avaliações dos clientes (${lead.reviewsDetalhes.length})`} icon={<MessageSquare className="w-3 h-3" />}>
          <div className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 bg-card/95 backdrop-blur border-b border-white/10">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center shrink-0">
                  <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                </div>
                <div>
                  <p className="text-xs font-bold">Comentários completos</p>
                  <p className="text-[10px] text-muted-foreground">Role para ler todas as avaliações capturadas</p>
                </div>
              </div>
              <Badge variant="secondary" className="shrink-0 text-[10px]">{lead.reviewsDetalhes.length}</Badge>
            </div>
            <div className="max-h-[58vh] overflow-y-auto p-3 sm:p-4 space-y-3">
              {lead.reviewsDetalhes.map((r, i) => (
                <article key={`${r.autor || "anon"}-${r.data || i}-${i}`} className="rounded-xl border border-white/10 bg-white/[0.025] p-3 sm:p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    {r.fotoAutor ? (
                      <img src={r.fotoAutor} alt={r.autor || "Autor da avaliação"} className="w-9 h-9 rounded-full object-cover ring-1 ring-white/15 shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-secondary border border-white/10 flex items-center justify-center text-sm shrink-0">👤</div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">{r.autor || "Cliente anônimo"}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        {r.nota && <span className="inline-flex items-center gap-1 font-semibold text-amber-300"><Star className="w-3 h-3 fill-amber-400 text-amber-400" />{r.nota}/5</span>}
                        {r.data && <span>{r.data}</span>}
                        {r.util ? <span>👍 {r.util} acharam útil</span> : null}
                      </div>
                    </div>
                  </div>
                  {r.texto && <p className="text-sm leading-6 text-foreground/90 whitespace-pre-wrap break-words">{r.texto}</p>}
                  {r.fotos && r.fotos.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {r.fotos.map((f, j) => (
                        <a key={j} href={f} target="_blank" rel="noopener noreferrer" className="w-16 h-16 rounded-lg overflow-hidden ring-1 ring-white/10 hover:ring-primary/70 transition-colors">
                          <img src={f} alt={`Foto enviada na avaliação ${j + 1}`} className="w-full h-full object-cover" loading="lazy" />
                        </a>
                      ))}
                    </div>
                  )}
                  {r.respostaDono && (
                    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3 sm:p-3.5">
                      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-emerald-300">
                        <Building2 className="w-3.5 h-3.5" /> Resposta do estabelecimento
                      </div>
                      <p className="mt-2 text-sm leading-6 text-emerald-50/90 whitespace-pre-wrap break-words">{r.respostaDono}</p>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
        </DetailSection>
      )}
    </>
  );
}

function DetailRow({ label, value, mono, link }: { label: string; value: string; mono?: boolean; link?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase font-semibold text-muted-foreground">{label}</span>
      {link ? (
        <a href={value} target="_blank" rel="noopener noreferrer" className={cn("text-xs text-primary hover:underline truncate", mono && "font-mono")}>{value}</a>
      ) : (
        <span className={cn("text-xs text-foreground/90 break-words", mono && "font-mono")}>{value}</span>
      )}
    </div>
  );
}

function DetailSection({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="text-[10px] uppercase font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
        {icon}{title}
      </div>
      {children}
    </div>
  );
}

function DetailList({ label, items }: { label: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="mb-2">
      <div className="text-[10px] text-muted-foreground mb-1">{label}:</div>
      <div className="flex flex-wrap gap-1">
        {items.map((s, i) => (
          <Badge key={i} variant="outline" className="text-[10px] font-normal">{s}</Badge>
        ))}
      </div>
    </div>
  );
}
