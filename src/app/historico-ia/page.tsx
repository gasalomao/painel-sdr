"use client";

import { useEffect, useState, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { supabase } from "@/lib/supabase";
import { History, Search, Filter, Loader2, ArrowRight, Calendar, BrainCircuit, ChevronRight, ChevronDown, Trash2, X, Check, Play, Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface AIHistoryLog {
  id: number;
  remote_jid: string;
  nome_negocio: string;
  status_antigo: string;
  status_novo: string;
  razao: string;
  created_at: string;
  batch_id?: string;
}

interface LogGroup {
  batch_id: string;
  date: string;
  logs: AIHistoryLog[];
  count: number;
}

interface OrganizerRun {
  id: number;
  batch_id: string | null;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  chats_analyzed: number;
  leads_moved: number;
  status: string;
  error: string | null;
  summary: string | null;
  model: string | null;
  provider: string | null;
}

export default function HistoricoIAPage() {
  const [logs, setLogs] = useState<AIHistoryLog[]>([]);
  const [runs, setRuns] = useState<OrganizerRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);

  // Custom Confirmation State
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'log' | 'batch', id: number | string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Estado do agendador + ação manual
  const [schedulerCfg, setSchedulerCfg] = useState<null | { enabled: boolean; execution_hour: number; last_run: string | null; provider: string | null; model: string | null; has_api_key: boolean }>(null);
  const [running, setRunning] = useState(false);
  const [runFeedback, setRunFeedback] = useState<null | { ok: boolean; msg: string }>(null);

  const fetchRuns = useCallback(async () => {
    const { data } = await supabase
      .from("ai_organizer_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(30);
    if (data) setRuns(data as OrganizerRun[]);
  }, []);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    let query = supabase.from("historico_ia_leads")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    
    if (filterStatus !== "all") {
       query = query.eq("status_novo", filterStatus);
    }
    
    const { data, error } = await query;
    if (!error && data) {
      setLogs(data);
      if (data.length > 0 && !expandedBatch) setExpandedBatch(data[0].batch_id || "legacy");
    }
    setLoading(false);
  }, [filterStatus, expandedBatch]);

  useEffect(() => {
    fetchLogs();
    fetchRuns();
  }, [fetchLogs, fetchRuns]);

  // Carrega o estado do agendador (próxima execução, ativo/inativo, etc)
  const fetchSchedulerCfg = useCallback(async () => {
    try {
      const r = await fetch("/api/ai-organize/config", { cache: "no-store" });
      const d = await r.json();
      if (d?.success && d?.config) {
        setSchedulerCfg({
          enabled: !!d.config.enabled,
          execution_hour: d.config.execution_hour ?? 20,
          last_run: d.config.last_run || null,
          provider: d.config.provider || null,
          model: d.config.model || null,
          has_api_key: !!d.config.has_api_key,
        });
      }
    } catch {}
  }, []);

  useEffect(() => { fetchSchedulerCfg(); }, [fetchSchedulerCfg]);

  // ────────────────────────────────────────────────────────────────────────
  // REALTIME: assina ai_organizer_runs + historico_ia_leads. Toda vez que o
  // organizador roda (manual, auto ou catch-up), a UI atualiza sozinha — sem
  // F5. Antes a página só fazia 1 fetch no mount, então rodadas automáticas
  // pareciam "perdidas" mesmo estando salvas no DB.
  // ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel("historico-ia-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_organizer_runs" }, () => {
        fetchRuns();
        fetchSchedulerCfg();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "historico_ia_leads" }, () => {
        fetchLogs();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchRuns, fetchLogs, fetchSchedulerCfg]);

  // Disparo manual a partir desta tela — pra você ver o histórico aparecer ao vivo.
  const runOrganizerNow = async () => {
    setRunning(true);
    setRunFeedback(null);
    try {
      // O endpoint lê a config central (api_key, model, provider) sozinho.
      const r = await fetch("/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggered_by: "manual" }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.success) {
        setRunFeedback({ ok: true, msg: `${d.updatedCount ?? 0} lead(s) movido(s). Histórico atualizado abaixo.` });
      } else {
        setRunFeedback({ ok: false, msg: d?.error || `Falha (HTTP ${r.status}).` });
      }
    } catch (e: any) {
      setRunFeedback({ ok: false, msg: e?.message || "Erro de rede" });
    } finally {
      setRunning(false);
      // Garante refresh mesmo se o realtime atrasar.
      fetchRuns();
      fetchLogs();
      fetchSchedulerCfg();
    }
  };

  // Calcula a próxima execução automática com base em execution_hour
  const nextAutoRun = (() => {
    if (!schedulerCfg?.enabled || schedulerCfg.execution_hour == null) return null;
    const now = new Date();
    const t = new Date(now);
    t.setHours(schedulerCfg.execution_hour, 0, 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t;
  })();

  async function executeDelete() {
    if (!confirmDelete) return;
    setIsDeleting(true);
    
    try {
        if (confirmDelete.type === 'log') {
            const id = confirmDelete.id as number;
            const { error } = await supabase.from("historico_ia_leads").delete().eq("id", id);
            if (error) throw error;
            setLogs(prev => prev.filter(l => l.id !== id));
        } else {
            const batchId = confirmDelete.id as string;
            let query = supabase.from("historico_ia_leads").delete();
            if (batchId === "legacy") {
                query = query.is("batch_id", null);
            } else {
                query = query.eq("batch_id", batchId);
            }
            const { error } = await query;
            if (error) throw error;
            setLogs(prev => prev.filter(l => (l.batch_id || "legacy") !== batchId));
            if (expandedBatch === batchId) setExpandedBatch(null);
        }
    } catch (err: any) {
        alert("Erro ao excluir: " + err.message);
    } finally {
        setIsDeleting(false);
        setConfirmDelete(null);
    }
  }

  const filteredLogs = logs.filter(log => {
      const s = searchTerm.toLowerCase();
      return log.nome_negocio?.toLowerCase().includes(s) || log.remote_jid?.includes(s) || log.razao?.toLowerCase().includes(s);
  });

  const groups: LogGroup[] = [];
  filteredLogs.forEach(log => {
      const bid = log.batch_id || "legacy";
      let group = groups.find(g => g.batch_id === bid);
      if (!group) {
          group = { batch_id: bid, date: log.created_at, logs: [], count: 0 };
          groups.push(group);
      }
      group.logs.push(log);
      group.count++;
  });

  return (
    <div className="flex flex-col h-[100dvh] bg-background text-white select-none overflow-hidden">
      <Header />
      <div className="flex-1 p-3 sm:p-6 space-y-4 sm:space-y-8 max-w-7xl mx-auto w-full animate-in fade-in duration-700 relative mobile-safe-bottom overflow-y-auto">
      
      {/* Custom Confirmation Overlay */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="bg-zinc-900 border border-white/10 p-8 rounded-[2.5rem] max-w-sm w-full shadow-2xl space-y-6 text-center">
                <div className="w-16 h-16 bg-red-500/20 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Trash2 className="w-8 h-8" />
                </div>
                <div>
                    <h3 className="text-xl font-black text-white">Confirmar Exclusão</h3>
                    <p className="text-sm text-muted-foreground mt-2">
                        {confirmDelete.type === 'batch' 
                            ? "Tem certeza que deseja excluir TODO este lote de execuções?" 
                            : "Tem certeza que deseja excluir este registro?"}
                    </p>
                </div>
                <div className="flex gap-3 pt-2">
                    <Button 
                        variant="secondary" 
                        onClick={() => setConfirmDelete(null)}
                        className="flex-1 h-12 rounded-2xl bg-white/5 hover:bg-white/10 text-white font-bold"
                        disabled={isDeleting}
                    >
                        Não, cancelar
                    </Button>
                    <Button 
                        onClick={executeDelete}
                        className="flex-1 h-12 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-bold glow-red"
                        disabled={isDeleting}
                    >
                        {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sim, excluir"}
                    </Button>
                </div>
            </div>
        </div>
      )}

      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
             <div className="p-2 rounded-xl bg-purple-500/10 border border-purple-500/20">
                <History className="w-6 h-6 text-purple-400" />
             </div>
             <h1 className="text-3xl font-black tracking-tighter text-white">
               Histórico da IA
             </h1>
          </div>
          <p className="text-sm text-muted-foreground max-w-lg">
            Acompanhe cronologicamente todas as decisões tomadas pelo Organizador de IA e as justificativas técnicas.
          </p>
        </div>
      </header>

      {/* Status do agendador + botão Rodar Agora */}
      <div className="rounded-3xl bg-gradient-to-br from-purple-500/10 via-transparent to-indigo-500/5 border border-purple-500/20 backdrop-blur-xl shadow-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <p className="text-[10px] uppercase font-black tracking-widest text-purple-300 flex items-center gap-2">
              <Clock className="w-3 h-3" /> Agendador automático
            </p>
            {schedulerCfg ? (
              <div className="space-y-1 text-[12px]">
                <p className="text-white">
                  {schedulerCfg.enabled ? (
                    <span className="text-emerald-400 font-bold">● Ativo</span>
                  ) : (
                    <span className="text-zinc-400 font-bold">○ Desativado</span>
                  )}
                  {" "}— roda 1x por dia às{" "}
                  <span className="font-mono font-bold text-white">{String(schedulerCfg.execution_hour).padStart(2, "0")}:00</span>
                  {schedulerCfg.provider && schedulerCfg.model && (
                    <span className="text-muted-foreground"> · {schedulerCfg.provider}/{schedulerCfg.model}</span>
                  )}
                </p>
                {schedulerCfg.enabled && nextAutoRun && (
                  <p className="text-[11px] text-purple-200/80 font-mono">
                    → próxima: {nextAutoRun.toLocaleString("pt-BR")} (em {Math.round((nextAutoRun.getTime() - Date.now()) / 60000)} min)
                  </p>
                )}
                {schedulerCfg.last_run && (
                  <p className="text-[11px] text-muted-foreground font-mono">
                    última execução: {new Date(schedulerCfg.last_run).toLocaleString("pt-BR")}
                  </p>
                )}
                {!schedulerCfg.has_api_key && (
                  <p className="text-[11px] text-amber-300">⚠ API Key do Gemini não configurada — vai falhar até salvar em <strong>Configurações</strong>.</p>
                )}
                {!schedulerCfg.enabled && (
                  <p className="text-[11px] text-zinc-400">
                    Pra ligar: vá em <strong>Chat → Organizar IA</strong> ou <strong>Configurações</strong> e marque "Habilitar execução automática".
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">Carregando estado do agendador…</p>
            )}
          </div>
          <Button
            onClick={runOrganizerNow}
            disabled={running}
            className="h-10 rounded-2xl px-5 bg-purple-500/20 border border-purple-500/40 hover:bg-purple-500/30 text-purple-100 font-bold text-xs uppercase tracking-widest gap-2"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? "Rodando…" : "Rodar agora"}
          </Button>
        </div>
        {runFeedback && (
          <div
            className={cn(
              "rounded-2xl px-3 py-2 text-[11px] border",
              runFeedback.ok
                ? "bg-emerald-500/10 text-emerald-200 border-emerald-500/30"
                : "bg-red-500/10 text-red-200 border-red-500/30"
            )}
          >
            {runFeedback.ok ? "✓ " : "⚠ "}{runFeedback.msg}
          </div>
        )}
      </div>

      {/* Execuções do Organizador — manual / auto / catch-up */}
      {runs.length > 0 && (
        <div className="rounded-3xl bg-white/5 border border-white/10 backdrop-blur-xl shadow-2xl overflow-hidden">
          <div className="p-4 border-b border-white/5 flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase font-black tracking-widest text-purple-300">Execuções do Organizador</p>
              <p className="text-[11px] text-muted-foreground">Toda vez que rodou (manual, automático ou catch-up). As últimas 30.</p>
            </div>
            <button onClick={fetchRuns} className="text-[10px] uppercase font-black tracking-widest text-purple-300 hover:text-purple-200">↻ Atualizar</button>
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-white/5">
            {runs.map(r => {
              const statusColor =
                r.status === "ok" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                : r.status === "error" ? "text-red-400 bg-red-500/10 border-red-500/30"
                : r.status === "noop" ? "text-muted-foreground bg-white/5 border-white/10"
                : "text-yellow-400 bg-yellow-500/10 border-yellow-500/30";
              const triggerLabel = r.triggered_by === "auto" ? "🤖 Auto"
                : r.triggered_by === "schedule_catchup" ? "⏰ Catch-up"
                : "👤 Manual";
              return (
                <div key={r.id} className="p-3 flex items-start gap-3 text-[11px]">
                  <div className="flex flex-col items-start gap-1 shrink-0 min-w-[130px]">
                    <span className="text-muted-foreground font-mono">{new Date(r.started_at).toLocaleString("pt-BR")}</span>
                    <span className="text-[9px] uppercase font-black tracking-widest text-white/70">{triggerLabel}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white/90 break-words">{r.summary || (r.status === "running" ? "Em execução..." : "(sem resumo)")}</p>
                    {r.error && <p className="text-red-300 text-[10px] mt-0.5 break-words">⚠ {r.error}</p>}
                    <p className="text-[9px] text-muted-foreground mt-1 font-mono">
                      {r.chats_analyzed} chats · {r.leads_moved} movidos
                      {r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : ""}
                      {r.model ? ` · ${r.model}` : ""}
                    </p>
                  </div>
                  <span className={cn("text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border shrink-0", statusColor)}>
                    {r.status}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-4 p-4 rounded-3xl bg-white/5 border border-white/10 backdrop-blur-xl shadow-2xl">
         <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
               placeholder="Buscar em justificativas ou nomes..."
               value={searchTerm}
               onChange={(e) => setSearchTerm(e.target.value)}
               className="pl-10 h-12 bg-black/20 border-white/5 rounded-2xl focus:ring-purple-500/40"
            />
         </div>
         <Select value={filterStatus} onValueChange={(val) => setFilterStatus(val as string || "all")}>
            <SelectTrigger className="w-full sm:w-[240px] h-12 bg-black/20 border-white/5 rounded-2xl">
               <Filter className="w-4 h-4 mr-2 text-muted-foreground" />
               <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent className="glass-card border-white/10 rounded-2xl">
               <SelectItem value="all">Todas as transições</SelectItem>
               <SelectItem value="interessado">🔥 Interessado</SelectItem>
               <SelectItem value="follow-up">⏳ Follow-up</SelectItem>
               <SelectItem value="agendado">📅 Agendado</SelectItem>
               <SelectItem value="fechado">💰 Venda Fechada</SelectItem>
            </SelectContent>
         </Select>
      </div>

      <div className="space-y-4">
        {loading ? (
          <div className="h-96 flex flex-col items-center justify-center gap-4 text-muted-foreground">
             <Loader2 className="w-10 h-10 animate-spin text-purple-500" />
             <p className="text-xs uppercase tracking-widest font-bold font-mono">Carregando...</p>
          </div>
        ) : groups.length === 0 ? (
          <div className="h-96 flex flex-col items-center justify-center gap-4 text-muted-foreground bg-white/5 rounded-[2rem] border border-dashed border-white/10">
             <BrainCircuit className="w-12 h-12 opacity-20" />
             <p className="font-medium">Nenhuma atividade registrada ainda.</p>
          </div>
        ) : (
          groups.map(group => (
            <div key={group.batch_id} className="group overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-all duration-300 shadow-xl">
               
               <div className="flex items-center w-full relative">
                  <div 
                     onClick={() => setExpandedBatch(expandedBatch === group.batch_id ? null : group.batch_id)}
                     className="flex-1 flex items-center justify-between p-6 cursor-pointer select-none"
                  >
                     <div className="flex items-center gap-4">
                        <div className={cn(
                           "p-3 rounded-2xl bg-gradient-to-br transition-all",
                           group.batch_id === "legacy" ? "from-zinc-800 to-zinc-900 border border-white/5 text-zinc-500" : "from-purple-500/20 to-indigo-500/20 border border-purple-500/20 text-purple-400"
                        )}>
                           <Calendar className="w-5 h-5" />
                        </div>
                        <div>
                           <div className="text-sm font-black text-white/90">
                              {new Date(group.date).toLocaleDateString("pt-BR", { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
                           </div>
                           <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-muted-foreground uppercase font-black tracking-widest bg-white/5 px-2 py-0.5 rounded-full border border-white/5">
                                 {new Date(group.date).toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' })}
                              </span>
                              <span className="text-[10px] text-purple-400 font-bold uppercase tracking-widest px-2 py-0.5 bg-purple-500/5 rounded-full">
                                 {group.count} {group.count === 1 ? 'Lead' : 'Leads'}
                              </span>
                           </div>
                        </div>
                     </div>
                     <div className="flex items-center gap-4 mr-12">
                        {expandedBatch === group.batch_id ? <ChevronDown className="w-5 h-5 text-muted-foreground" /> : <ChevronRight className="w-5 h-5 text-muted-foreground" />}
                     </div>
                  </div>
                  
                  {/* DELETE BATCH BUTTON */}
                  <div className="absolute right-4 top-1/2 -translate-y-1/2">
                    <button 
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setConfirmDelete({ type: 'batch', id: group.batch_id });
                        }}
                        className="w-10 h-10 flex items-center justify-center rounded-xl text-red-500/40 hover:text-red-500 hover:bg-red-500/10 transition-all border border-transparent hover:border-red-500/20"
                    >
                        <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
               </div>

               {expandedBatch === group.batch_id && (
                  <div className="px-6 pb-6 animate-in slide-in-from-top-2 duration-300">
                     <div className="space-y-3 pt-4 border-t border-white/5">
                        {group.logs.map(log => (
                           <div key={log.id} className="flex flex-col md:flex-row gap-4 p-5 rounded-2xl bg-black/30 border border-white/5 hover:border-white/10 transition-all group/item relative">
                              <div className="md:w-64 shrink-0 space-y-2">
                                 <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                                    <span className="font-bold text-white text-sm truncate">{log.nome_negocio}</span>
                                 </div>
                                 <div className="text-[10px] font-mono text-muted-foreground bg-white/5 px-2 py-1 rounded inline-block">
                                    {log.remote_jid.split('@')[0]}
                                 </div>
                              </div>
                              
                              <div className="md:w-72 shrink-0 flex items-center">
                                 <div className="flex items-center gap-3 bg-white/5 px-3 py-2 rounded-xl border border-white/5">
                                    <span className="text-[9px] uppercase font-black text-muted-foreground/60">{log.status_antigo || '—'}</span>
                                    <ArrowRight className="w-3 h-3 text-white/20" />
                                    <span className={cn(
                                       "text-[10px] uppercase font-black px-2.5 py-1 rounded-lg shadow",
                                       log.status_novo === "fechado" ? "bg-emerald-500 text-white" :
                                       log.status_novo === "interessado" ? "bg-amber-600 text-white" :
                                       log.status_novo === "agendado" ? "bg-blue-600 text-white" :
                                       "bg-purple-600 text-white"
                                    )}>
                                       {log.status_novo}
                                    </span>
                                 </div>
                              </div>

                              <div className="flex-1 pr-12">
                                 <div className="text-xs text-white/70 leading-relaxed pl-4 border-l-2 border-purple-500/30 font-medium italic">
                                    “{log.razao}”
                                 </div>
                              </div>

                              {/* DELETE SINGLE LOG BUTTON */}
                              <div className="absolute top-4 right-4 opacity-0 group-hover/item:opacity-100 transition-opacity">
                                  <button 
                                     onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setConfirmDelete({ type: 'log', id: log.id });
                                     }}
                                     className="w-8 h-8 flex items-center justify-center rounded-lg text-red-500/40 hover:text-red-500 hover:bg-red-500/10 transition-all border border-transparent hover:border-red-500/20"
                                  >
                                     <Trash2 className="w-4 h-4" />
                                  </button>
                              </div>
                           </div>
                        ))}
                     </div>
                  </div>
               )}
            </div>
          ))
        )}
      </div>
    </div>
    </div>
  );
}
