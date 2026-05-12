"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  MapPin, Rocket, Square, Webhook, Filter, Loader2, CheckCircle2, XCircle, Terminal,
  Download, Trash2, Send, ToggleLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
}

interface LogEntry {
  message: string;
  type: string;
  time: string;
}

export default function CaptadorPage() {
  const [niches, setNiches] = useState("");
  const [regions, setRegions] = useState("");
  const [webhookUrl, setWebhookUrl] = useState(process.env.NEXT_PUBLIC_N8N_WEBHOOK_LEAD || "https://n8n-n8n.sfrto8.easypanel.host/webhook/LEAD");
  const [webhookEnabled, setWebhookEnabled] = useState(true);
  const [sendMode, setSendMode] = useState<"realtime" | "batch">("realtime");
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filterEmpty, setFilterEmpty] = useState(true);
  const [filterDuplicates, setFilterDuplicates] = useState(true);
  const [filterLandlines, setFilterLandlines] = useState(true);
  const [activeTab, setActiveTab] = useState<"config" | "leads">("config");
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
    const header = ["Nome do Negócio", "Telefone", "Categoria", "Endereço", "Avaliação", "Nº Reviews", "Website", "Instagram", "Facebook", "Extraído Em"];
    const data = leads.map((l) => [
      l.name, l.phones, l.categories, l.fullAddress, l.averageRating, l.reviewCount, l.website, l.instagram, l.facebook, l.extractedAt,
    ]);
    data.unshift(header);
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [
      { wch: 45 }, { wch: 22 }, { wch: 35 }, { wch: 70 }, { wch: 12 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 30 }, { wch: 20 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Leads");
    const niche = niches.split("\n")[0]?.trim().replace(/\s+/g, "_") || "Leads";
    const region = regions.split("\n")[0]?.trim().replace(/\s+/g, "_") || "Exportados";
    XLSX.writeFile(wb, `${niche}_${region}.xlsx`);
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

                {/* Webhook Config */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Webhook className="w-3 h-3 text-muted-foreground" />
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Webhook n8n</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">{webhookEnabled ? "Ativo" : "Inativo"}</span>
                      <input 
                        type="checkbox" 
                        checked={webhookEnabled} 
                        onChange={(e) => setWebhookEnabled(e.target.checked)} 
                        className="w-4 h-4 accent-primary cursor-pointer"
                      />
                    </div>
                  </div>
                  {webhookEnabled && (
                    <>
                      <Input placeholder="https://..." value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} className="bg-secondary/50 border-border/50 text-sm font-mono" />
                      <div className="flex gap-2">
                        <Button variant={sendMode === "realtime" ? "default" : "outline"} size="sm" className="flex-1 text-xs" onClick={() => setSendMode("realtime")}>
                          Tempo Real
                        </Button>
                        <Button variant={sendMode === "batch" ? "default" : "outline"} size="sm" className="flex-1 text-xs" onClick={() => setSendMode("batch")}>
                          Em Lote
                        </Button>
                      </div>
                    </>
                  )}
                </div>

                <Separator />

                {/* Filters */}
                <div className="space-y-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Filter className="w-3 h-3 text-muted-foreground" />
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Filtros Automáticos</label>
                  </div>
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
                  <CardTitle className="text-sm font-semibold">Leads Extraídos</CardTitle>
                  <Badge variant="secondary" className="text-[10px]">{leads.length} leads</Badge>
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
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Website</TableHead>
                      <TableHead className="text-[10px] uppercase sticky top-0 bg-card z-10">Extraído Em</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leads.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-12 text-muted-foreground text-sm">
                          {isRunning ? "Aguardando leads..." : "Nenhum lead extraído"}
                        </TableCell>
                      </TableRow>
                    ) : (
                      leads.map((lead, i) => (
                        <TableRow key={i} className="border-border/30 text-xs">
                          <TableCell className="font-medium max-w-[200px] truncate">{lead.name}</TableCell>
                          <TableCell className="text-green-400 font-mono whitespace-nowrap">{lead.phones || "—"}</TableCell>
                          <TableCell className="max-w-[150px] truncate">{lead.categories}</TableCell>
                          <TableCell className="max-w-[200px] truncate text-muted-foreground">{lead.fullAddress}</TableCell>
                          <TableCell className="text-center">{lead.averageRating || "—"}</TableCell>
                          <TableCell className="text-center">{lead.reviewCount || "—"}</TableCell>
                          <TableCell className="max-w-[150px] truncate">
                            {lead.website ? <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{new URL(lead.website).hostname}</a> : "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground whitespace-nowrap">{lead.extractedAt}</TableCell>
                        </TableRow>
                      ))
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
                  leads.map((lead, i) => (
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
                        {lead.website && (
                          <div className="col-span-2 truncate">
                            <strong className="text-white/60">Web:</strong>{" "}
                            <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              {lead.website}
                            </a>
                          </div>
                        )}
                      </div>
                      <div className="text-right text-[10px] text-muted-foreground/40">{lead.extractedAt}</div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
