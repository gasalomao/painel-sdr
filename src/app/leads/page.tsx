"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogTitle,
} from "@/components/ui/dialog";
import {
    Search, Download, ChevronLeft, ChevronRight, Phone, Building2,
    Calendar, ExternalLink, Globe, Star, MessageSquare, LayoutGrid, List,
    Clock, Trash2, Filter, Bot, X, CheckSquare, Loader2
} from "lucide-react";
import { 
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor,
  useSensor, useSensors, DragOverlay, defaultDropAnimationSideEffects
} from "@dnd-kit/core";
import { 
  arrayMove, SortableContext, sortableKeyboardCoordinates, 
  verticalListSortingStrategy, useSortable 
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

interface Lead {
  id: number;
  remoteJid: string;
  nome_negocio: string;
  telefone: string;
  ramo_negocio: string;
  endereco: string;
  rating: string;
  reviews: string;
  website: string;
  instagram: string;
  facebook: string;
  status: string; // 'novo', 'interessado', 'follow-up', 'agendado', 'fechado', 'sem_interesse', 'descartado'
  next_follow_up: string | null;
  justificativa_ia: string | null;
  resumo_ia: string | null;
  ia_last_analyzed_at: string | null;
  created_at: string;
}

const KANBAN_COLUMNS = [
  { id: "novo", label: "Lead Extraído", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  { id: "primeiro_contato", label: "Primeiro Contato", color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" },
  { id: "interessado", label: "Interessado", color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  { id: "follow-up", label: "Follow-Up", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  { id: "agendado", label: "Agendado", color: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  { id: "fechado", label: "Venda Fechada \u2705", color: "bg-green-500/10 text-green-400 border-green-500/20" },
  { id: "sem_interesse", label: "Sem Interesse", color: "bg-red-500/10 text-red-400 border-red-500/20" },
  { id: "descartado", label: "Descartado", color: "bg-neutral-500/10 text-neutral-400 border-neutral-500/20" },
];

const PAGE_SIZE = 15;

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "kanban">("list");
  const [activeId, setActiveId] = useState<number | null>(null);

  // Modal Confirm Delete
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [leadToDelete, setLeadToDelete] = useState<Lead | null>(null);

  // Seleção em massa
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectAllAcrossPages, setSelectAllAcrossPages] = useState(false);
  const [showConfirmBulkDelete, setShowConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const allVisibleSelected = leads.length > 0 && leads.every((l) => selectedIds.has(l.id));
  const someVisibleSelected = leads.some((l) => selectedIds.has(l.id));
  const selectedCount = selectAllAcrossPages ? total : selectedIds.size;

  useEffect(() => {
    if (selectAllRef.current) {
      const isIndeterminate =
        !selectAllAcrossPages && someVisibleSelected && !allVisibleSelected;
      selectAllRef.current.indeterminate = isIndeterminate;
    }
  }, [someVisibleSelected, allVisibleSelected, selectAllAcrossPages]);

  const toggleSelectOne = useCallback((id: number) => {
    setSelectAllAcrossPages(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAllVisible = useCallback(() => {
    setSelectAllAcrossPages(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const everyOn = leads.length > 0 && leads.every((l) => next.has(l.id));
      if (everyOn) {
        leads.forEach((l) => next.delete(l.id));
      } else {
        leads.forEach((l) => next.add(l.id));
      }
      return next;
    });
  }, [leads]);

  const selectEveryMatching = useCallback(() => {
    setSelectAllAcrossPages(true);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectAllAcrossPages(false);
    setSelectedIds(new Set());
  }, []);

  // Limpa seleção ao trocar filtros/página/modo para evitar IDs fantasmas
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectAllAcrossPages(false);
  }, [page, search, categoryFilter, viewMode]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 15 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("leads_extraidos")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });

      if (search) {
        query = query.or(`nome_negocio.ilike.%${search}%,ramo_negocio.ilike.%${search}%,telefone.ilike.%${search}%`);
      }
      
      if (categoryFilter !== "all") {
        query = query.eq("ramo_negocio", categoryFilter);
      }

      // Aplica paginação apenas na lista. No kanban traz mais (ex 500)
      if (viewMode === "list") {
          query = query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      } else {
          query = query.limit(500);
      }

      const { data, count } = await query;
      setLeads(data || []);
      setTotal(count || 0);

      // Extract unique categories for filter
      if (data) {
          const uniqueCats = Array.from(new Set(data.map(l => l.ramo_negocio).filter(Boolean))) as string[];
          setCategories(prev => Array.from(new Set([...prev, ...uniqueCats])));
      }
    } catch (err) {
      console.error("Erro ao carregar leads:", err);
    } finally {
      setLoading(false);
    }
  }, [page, search, viewMode, categoryFilter]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  function formatPhone(jid: string) {
    if (!jid) return "—";
    const num = jid.replace("@s.whatsapp.net", "");
    if (num.length >= 12) {
      return `+${num.slice(0, 2)} (${num.slice(2, 4)}) ${num.slice(4, 9)}-${num.slice(9)}`;
    }
    return num;
  }

  async function exportXLSX() {
    const XLSX = await import("xlsx");
    const { data } = await supabase.from("leads_extraidos")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
    if (!data) return;

    const rows = data.map((l: Lead) => ({
      "Nome do Negócio": l.nome_negocio || "",
      "Telefone": l.telefone || formatPhone(l.remoteJid),
      "Categoria": l.ramo_negocio || "",
      "Avaliação": l.rating || "",
      "Data Extração": new Date(l.created_at).toLocaleDateString("pt-BR"),
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Leads CRM");
    XLSX.writeFile(wb, `crm_leads_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const handleDeleteLead = async (mode: "lead_only" | "all") => {
      if (!leadToDelete) return;
      try {
          await fetch(`/api/leads/delete?id=${leadToDelete.id}&mode=${mode}&remoteJid=${leadToDelete.remoteJid}`, { method: "DELETE" });
          setLeads(prev => prev.filter(l => l.id !== leadToDelete.id));
          setSelectedIds(prev => {
            const next = new Set(prev);
            next.delete(leadToDelete.id);
            return next;
          });
          setShowConfirmDelete(false);
          setSelectedLead(null);
      } catch(err) {
          console.error("Erro ao deletar", err);
      }
  };

  const handleBulkDelete = async (mode: "lead_only" | "all") => {
      if (!selectAllAcrossPages && selectedIds.size === 0) return;
      setBulkDeleting(true);
      try {
          const params = new URLSearchParams();
          params.set("mode", mode);

          if (selectAllAcrossPages) {
              params.set("allMatching", "1");
              if (search) params.set("search", search);
              if (categoryFilter && categoryFilter !== "all") {
                  params.set("category", categoryFilter);
              }
          } else {
              const ids = Array.from(selectedIds);
              const jids = leads
                  .filter((l) => selectedIds.has(l.id) && l.remoteJid)
                  .map((l) => l.remoteJid);
              params.set("ids", ids.join(","));
              if (mode === "all" && jids.length > 0) {
                  params.set("remoteJids", jids.join(","));
              }
          }

          const res = await fetch(`/api/leads/delete?${params.toString()}`, { method: "DELETE" });
          if (!res.ok) throw new Error(await res.text());

          setSelectedIds(new Set());
          setSelectAllAcrossPages(false);
          setShowConfirmBulkDelete(false);
          setPage(0);
          fetchLeads();
      } catch (err) {
          console.error("Erro ao deletar em massa", err);
      } finally {
          setBulkDeleting(false);
      }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleDragEnd = async (event: any) => {
    const { active, over } = event;
    if (!over) return;
    const leadId = active.id;
    const overId = over.id;
    let newStatus = KANBAN_COLUMNS.find(c => c.id === overId) ? overId : null;
    if (!newStatus) {
        const overLead = leads.find(l => l.id === overId);
        if (overLead) newStatus = overLead.status || "novo";
    }
    if (newStatus && newStatus !== (leads.find(l => l.id === leadId)?.status || 'novo')) {
        setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: newStatus as string } : l));
        await supabase.from("leads_extraidos").update({ status: newStatus }).eq("id", leadId);
    }
    setActiveId(null);
  };

  const handleUpdateFollowUp = async (leadId: number, date: string) => {
    const { error } = await supabase.from("leads_extraidos").update({ 
        next_follow_up: date,
        status: "follow-up" 
    }).eq("id", leadId);
    if (!error) {
        setLeads(prev => prev.map(l => l.id === leadId ? { ...l, next_follow_up: date, status: "follow-up" } : l));
        if (selectedLead?.id === leadId) setSelectedLead({ ...selectedLead, next_follow_up: date, status: "follow-up" });
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden" style={{backgroundImage: "radial-gradient(ellipse at 50% -20%, rgba(120,119,198,0.1), transparent 80%)"}}>
      <Header />
      <div className="flex-1 p-3 sm:p-6 space-y-4 sm:space-y-6 mobile-safe-bottom overflow-y-auto custom-scrollbar">
        {/* Toolbar */}
        <div className="flex flex-col gap-3 sm:gap-4 glass-card p-3 sm:p-4 rounded-2xl border-white/10">
          
          <div className="flex flex-col sm:flex-row gap-3 w-full xl:w-auto flex-1">
              <div className="relative w-full sm:w-80">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por nome, telefone..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  className="pl-9 bg-white/5 border-white/10 rounded-xl"
                />
              </div>
              
              <Select value={categoryFilter} onValueChange={(val) => setCategoryFilter(val as string || "all")}>
                  <SelectTrigger className="w-full sm:w-[220px] bg-white/5 border-white/10 rounded-xl text-xs">
                      <Filter className="w-4 h-4 mr-2 text-muted-foreground" />
                      <SelectValue placeholder="Categoria" />
                  </SelectTrigger>
                  <SelectContent className="glass-card">
                      <SelectItem value="all">Todas as Categorias</SelectItem>
                      {categories.map(c => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                  </SelectContent>
              </Select>
          </div>

          <div className="flex items-center gap-2 w-full overflow-x-auto">
            <div className="flex bg-white/5 p-1 rounded-xl border border-white/10 mr-2">
                <Button 
                    variant={viewMode === "list" ? "secondary" : "ghost"} 
                    size="sm" 
                    className={cn("h-8 px-4 gap-2 text-xs rounded-lg transition-all", viewMode === "list" && "bg-primary text-primary-foreground shadow-md")}
                    onClick={() => setViewMode("list")}
                >
                    <List className="w-3.5 h-3.5" /> Lista
                </Button>
                <Button 
                    variant={viewMode === "kanban" ? "secondary" : "ghost"} 
                    size="sm" 
                    className={cn("h-8 px-4 gap-2 text-xs rounded-lg transition-all", viewMode === "kanban" && "bg-primary text-primary-foreground shadow-md")}
                    onClick={() => setViewMode("kanban")}
                >
                    <LayoutGrid className="w-3.5 h-3.5" /> Kanban
                </Button>
            </div>
            
            <Badge variant="secondary" className="px-3 py-1 bg-white/5 border-white/10 font-mono">
                {total.toLocaleString("pt-BR")} Leads
            </Badge>
            
            <Button variant="outline" size="sm" onClick={exportXLSX} className="gap-2 shadow-sm rounded-xl border-white/10 bg-white/5 hover:bg-white/10 shrink-0">
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Exportar</span>
            </Button>
          </div>
        </div>

        {viewMode === "list" && selectedCount > 0 && (
          <div className="flex flex-col gap-2 glass-card p-3 px-5 rounded-2xl border-primary/30 bg-primary/10 animate-in fade-in slide-in-from-top-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <CheckSquare className="w-4 h-4 text-primary" />
                <span className="text-sm font-bold text-white">
                  {selectAllAcrossPages
                    ? `Todos os ${total.toLocaleString("pt-BR")} leads dos filtros atuais selecionados`
                    : `${selectedCount} ${selectedCount === 1 ? "lead selecionado" : "leads selecionados"}`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-white"
                  onClick={clearSelection}
                >
                  <X className="w-3 h-3 mr-1" /> Limpar
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-8 gap-2 bg-red-600 hover:bg-red-700"
                  onClick={() => setShowConfirmBulkDelete(true)}
                  disabled={bulkDeleting}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Excluir selecionados
                </Button>
              </div>
            </div>

            {!selectAllAcrossPages && allVisibleSelected && total > leads.length && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-300 pl-7">
                <span>
                  Apenas os {leads.length} leads desta página estão selecionados.
                </span>
                <button
                  type="button"
                  onClick={selectEveryMatching}
                  className="font-bold text-primary hover:text-primary/80 underline underline-offset-2"
                >
                  Selecionar todos os {total.toLocaleString("pt-BR")} leads dos filtros atuais
                </button>
              </div>
            )}
          </div>
        )}

        {viewMode === "list" ? (
          <Card className="border-white/10 bg-black/40 backdrop-blur-xl shadow-2xl rounded-2xl overflow-hidden">
            <CardContent className="p-0">
              {/* Desktop Table */}
              <div className="overflow-x-auto min-h-[300px] sm:min-h-[500px] hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-transparent bg-white/5">
                      <TableHead className="w-[44px] py-5 pl-6 pr-0">
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          aria-label="Selecionar todos os leads desta página"
                          className="h-4 w-4 rounded border-white/20 bg-white/5 accent-primary cursor-pointer"
                          checked={selectAllAcrossPages || allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          disabled={loading || leads.length === 0}
                        />
                      </TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Lead</TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Contato</TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Categoria</TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Reputação</TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Data</TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5 text-right pr-6">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="divide-y divide-white/5">
                    {loading ? (
                      [...Array(8)].map((_, i) => (
                        <TableRow key={i} className="border-none">
                          <TableCell className="pl-6 pr-0"><div className="skeleton w-4 h-4 rounded" /></TableCell>
                          <TableCell><div className="skeleton w-48 h-5 rounded-md" /></TableCell>
                          <TableCell><div className="skeleton w-32 h-5 rounded-md" /></TableCell>
                          <TableCell><div className="skeleton w-28 h-5 rounded-md" /></TableCell>
                          <TableCell><div className="skeleton w-20 h-5 rounded-md" /></TableCell>
                          <TableCell><div className="skeleton w-20 h-5 rounded-md" /></TableCell>
                          <TableCell className="pr-6"><div className="skeleton w-10 h-8 ml-auto rounded-md" /></TableCell>
                        </TableRow>
                      ))
                    ) : leads.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-32 text-muted-foreground">
                          <div className="flex flex-col items-center gap-3">
                              <Search className="w-12 h-12 opacity-10" />
                              <p className="text-sm font-medium">Nenhum resultado encontrado nesta visão.</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      leads.map((lead) => (
                        <TableRow
                          key={lead.id}
                          className={cn(
                            "border-none cursor-pointer hover:bg-white/[0.02] transition-colors group",
                            (selectAllAcrossPages || selectedIds.has(lead.id)) && "bg-primary/5 hover:bg-primary/10"
                          )}
                          onClick={() => setSelectedLead(lead)}
                        >
                          <TableCell className="pl-6 pr-0 py-4" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label={`Selecionar ${lead.nome_negocio || "lead"}`}
                                className="h-4 w-4 rounded border-white/20 bg-white/5 accent-primary cursor-pointer"
                                checked={selectAllAcrossPages || selectedIds.has(lead.id)}
                                onChange={() => toggleSelectOne(lead.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                          </TableCell>
                          <TableCell className="py-4">
                              <div className="font-bold text-white/90 max-w-[250px] truncate">{lead.nome_negocio || "—"}</div>
                              <div className="text-[10px] text-muted-foreground mt-0.5 uppercase tracking-wider">{lead.status || "NOVO"}</div>
                          </TableCell>
                          <TableCell className="py-4">
                              <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-green-500/10 text-green-400 font-mono text-xs border border-green-500/20">
                                  <Phone className="w-3 h-3" />
                                  {lead.telefone || formatPhone(lead.remoteJid)}
                              </div>
                          </TableCell>
                          <TableCell className="py-4">
                            <Badge variant="secondary" className="bg-white/5 hover:bg-white/10 text-[10px] text-white/70 font-medium py-1">
                                {lead.ramo_negocio || "—"}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-4">
                              <div className="flex items-center gap-1.5">
                                  {lead.rating ? (
                                      <>
                                          <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                                          <span className="text-xs font-bold text-white/90">{lead.rating}</span>
                                      </>
                                  ) : <span className="text-muted-foreground text-xs">—</span>}
                              </div>
                          </TableCell>
                          <TableCell className="text-[11px] text-muted-foreground py-4 tabular-nums">
                            {new Date(lead.created_at).toLocaleDateString("pt-BR")}
                          </TableCell>
                          <TableCell className="text-right py-4 pr-6">
                              <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-white/10" onClick={(e) => { e.stopPropagation(); setSelectedLead(lead); }}>
                                      <ExternalLink className="w-3.5 h-3.5 text-blue-400" />
                                  </Button>
                                  <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-red-500/20" onClick={(e) => { 
                                      e.stopPropagation(); 
                                      setLeadToDelete(lead); 
                                      setShowConfirmDelete(true); 
                                  }}>
                                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                                  </Button>
                              </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile Card List */}
              <div className="sm:hidden divide-y divide-white/5">
                {loading ? (
                  [...Array(6)].map((_, i) => <div key={i} className="h-20 animate-pulse bg-white/5" />)
                ) : leads.length === 0 ? (
                  <div className="py-16 text-center text-muted-foreground">
                    <Search className="w-10 h-10 mx-auto opacity-10 mb-3" />
                    <p className="text-sm">Nenhum lead encontrado</p>
                  </div>
                ) : (
                  leads.map((lead) => (
                    <button
                      key={lead.id}
                      onClick={() => setSelectedLead(lead)}
                      className="w-full text-left flex items-center gap-3 p-3 active:bg-white/5 transition-colors"
                    >
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-primary font-black text-sm shrink-0">
                        {(lead.nome_negocio || "?")[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm truncate">{lead.nome_negocio || "—"}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted-foreground">{lead.ramo_negocio || "Geral"}</span>
                          {lead.rating && (
                            <span className="flex items-center gap-0.5 text-[10px] text-amber-400">
                              <Star className="w-2.5 h-2.5 fill-amber-400" />{lead.rating}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge variant="secondary" className="text-[9px] bg-white/5 border-white/10">{lead.status || "novo"}</Badge>
                      </div>
                    </button>
                  ))
                )}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-t border-white/5 bg-black/20 backdrop-blur-md">
                  <span className="text-[10px] sm:text-xs text-muted-foreground font-medium">
                    {page + 1}/{totalPages}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="h-8 px-3 text-xs bg-white/5 border-white/10" disabled={page === 0} onClick={() => setPage(page - 1)}>
                      <ChevronLeft className="w-4 h-4 mr-1" /> Anterior
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 px-3 text-xs bg-white/5 border-white/10" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                      Próximo <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="flex-1 w-full overflow-x-auto custom-scrollbar pb-8 cursor-default kanban-scroll-container mobile-safe-bottom">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(e) => setActiveId(e.active.id as number)} onDragEnd={handleDragEnd}>
              <div className="flex gap-3 sm:gap-6 min-w-max p-2 h-full min-h-[calc(100vh-250px)]">
                {KANBAN_COLUMNS.map((col) => (
                  <SortableContext key={col.id} items={leads.filter(l => (l.status || 'novo') === col.id).map(l => l.id)} strategy={verticalListSortingStrategy}>
                    <KanbanColumn 
                        column={col} 
                        leads={leads.filter(l => (l.status || 'novo') === col.id)} 
                        onLeadClick={setSelectedLead}
                        formatPhone={formatPhone}
                    />
                  </SortableContext>
                ))}
              </div>
              <DragOverlay>
                {activeId ? <KanbanCard lead={leads.find(l => l.id === activeId)} isOverlay formatPhone={formatPhone} /> : null}
              </DragOverlay>
            </DndContext>
          </div>
        )}
      </div>

      {/* Modal Confirm Bulk Delete */}
      <Dialog open={showConfirmBulkDelete} onOpenChange={(open) => !bulkDeleting && setShowConfirmBulkDelete(open)}>
          <DialogContent className="glass-card max-w-md w-[95vw] p-4 sm:p-6 border-red-500/30 bg-red-950/10">
              <div className="flex flex-col items-center text-center space-y-4">
                  <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
                      <Trash2 className="w-8 h-8 text-red-500" />
                  </div>
                  <DialogTitle className="text-xl font-black text-white">Excluir {selectedCount} {selectedCount === 1 ? "lead" : "leads"}?</DialogTitle>
                  <p className="text-sm text-neutral-300">
                      Esta ação é irreversível. Escolha o quão profunda será a exclusão dos <strong className="text-white">{selectedCount}</strong> leads selecionados.
                  </p>

                  <div className="w-full flex flex-col sm:flex-row justify-between gap-2 sm:gap-3 mt-4 pt-4 border-t border-white/10">
                      <Button variant="ghost" className="flex-1" onClick={() => setShowConfirmBulkDelete(false)} disabled={bulkDeleting}>Cancelar</Button>
                      <Button
                          variant="outline"
                          className="flex-1 border-white/20 hover:bg-red-500/20 text-red-400 hover:text-red-300"
                          onClick={() => handleBulkDelete("lead_only")}
                          disabled={bulkDeleting}
                      >
                          {bulkDeleting ? "Excluindo..." : "Apenas Leads"}
                      </Button>
                      <Button
                          variant="destructive"
                          className="flex-1 bg-red-600 hover:bg-red-700"
                          onClick={() => handleBulkDelete("all")}
                          disabled={bulkDeleting}
                      >
                          {bulkDeleting ? "Excluindo..." : "Leads + Chats"}
                      </Button>
                  </div>
              </div>
          </DialogContent>
      </Dialog>

      {/* Modal Confirm Delete */}
      <Dialog open={showConfirmDelete} onOpenChange={setShowConfirmDelete}>
          <DialogContent className="glass-card max-w-md w-[95vw] p-4 sm:p-6 border-red-500/30 bg-red-950/10">
              <div className="flex flex-col items-center text-center space-y-4">
                  <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
                      <Trash2 className="w-8 h-8 text-red-500" />
                  </div>
                  <DialogTitle className="text-xl font-black text-white">Purgar Lead Definitivamente?</DialogTitle>
                  <p className="text-sm text-neutral-300">
                      Você está prestes a excluir <strong className="text-white">"{leadToDelete?.nome_negocio || "este lead"}"</strong>.
                      <br/>Escolha abaixo o quão profunda será esta exclusão.
                  </p>
                  
                  <div className="w-full flex flex-col sm:flex-row justify-between gap-2 sm:gap-3 mt-4 pt-4 border-t border-white/10">
                      <Button variant="ghost" className="flex-1" onClick={() => setShowConfirmDelete(false)}>Cancelar</Button>
                      <Button variant="outline" className="flex-1 border-white/20 hover:bg-red-500/20 text-red-400 hover:text-red-300" onClick={() => handleDeleteLead("lead_only")}>
                          Apenas Lead
                      </Button>
                      <Button variant="destructive" className="flex-1 bg-red-600 hover:bg-red-700" onClick={() => handleDeleteLead("all")}>
                          Lead + Chats
                      </Button>
                  </div>
              </div>
          </DialogContent>
      </Dialog>

      {/* Lead Detail Dialog */}
      <Dialog open={!!selectedLead && !showConfirmDelete} onOpenChange={() => setSelectedLead(null)}>
        {/* max-h e flex-col com header fixo + body com scroll interno: o briefing
            do Lead Intelligence pode ser longo e antes ficava cortado. */}
        <DialogContent className="glass-card border-white/20 max-w-xl w-[95vw] p-0 max-h-[90vh] overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.5)] outline-none flex flex-col">
          <div className="relative bg-gradient-to-r from-primary/20 via-purple-500/10 to-transparent p-6 sm:p-8 border-b border-white/10 shrink-0">
                <div className="absolute top-4 right-4 flex items-center gap-2">
                    <Button variant="ghost" size="icon" className="w-8 h-8 hover:bg-red-500/20 text-red-400" onClick={() => { setLeadToDelete(selectedLead); setShowConfirmDelete(true); }}>
                        <Trash2 className="w-4 h-4" />
                    </Button>
                </div>
                <div className="flex items-center gap-5 mt-2">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-white shadow-xl shadow-primary/20 shrink-0">
                        {selectedLead?.nome_negocio ? (
                            <span className="text-2xl font-black tracking-tighter">{selectedLead.nome_negocio.substring(0, 2).toUpperCase()}</span>
                        ) : (
                            <Building2 className="w-8 h-8" />
                        )}
                    </div>
                    <div className="min-w-0 pr-6">
                        <DialogTitle className="text-xl sm:text-2xl font-black text-white drop-shadow-sm leading-tight">{selectedLead?.nome_negocio || "Sem nome"}</DialogTitle>
                        <Badge className="mt-2 bg-primary/20 text-primary-300 border border-primary/30 text-[10px] px-2 py-0.5 whitespace-normal">{selectedLead?.ramo_negocio || "Setor não informado"}</Badge>
                    </div>
                </div>
          </div>
          
          <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1 min-h-0">
            <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 hover:border-white/20 transition-colors">
                    <p className="text-[10px] font-black tracking-widest text-muted-foreground uppercase mb-2">WhatsApp</p>
                    <div className="flex items-center gap-2">
                        <Phone className="w-4 h-4 text-green-400" />
                        <span className="text-sm font-mono font-bold text-white/90">{selectedLead ? (selectedLead.telefone || formatPhone(selectedLead.remoteJid)) : "—"}</span>
                    </div>
                </div>
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 hover:border-white/20 transition-colors">
                    <p className="text-[10px] font-black tracking-widest text-muted-foreground uppercase mb-2">Avaliação Google</p>
                    <div className="flex items-center gap-2">
                        <Star className="w-4 h-4 text-amber-400 fill-amber-400 drop-shadow-sm" />
                        <span className="text-sm font-bold text-white/90">{selectedLead?.rating || "—"} <span className="text-muted-foreground font-normal text-xs ml-1">({selectedLead?.reviews} av)</span></span>
                    </div>
                </div>
            </div>

            <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-primary/10 border border-primary/20 relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-r from-primary/0 via-primary/5 to-transparent -translate-x-full group-hover:translate-x-full duration-1000 transition-transform"></div>
                    <p className="text-[10px] font-black text-primary uppercase mb-3 flex items-center gap-2 relative z-10">
                        <Clock className="w-3.5 h-3.5" /> Agendar Retorno (Follow-up)
                    </p>
                    <div className="flex gap-2 relative z-10">
                        <Input 
                            type="datetime-local" 
                            className="bg-black/50 border-white/10 text-xs h-10 rounded-xl focus:ring-primary/40"
                            value={selectedLead?.next_follow_up || ""}
                            onChange={(e) => selectedLead && handleUpdateFollowUp(selectedLead.id, e.target.value)}
                        />
                    </div>
                </div>
                
                {(selectedLead?.justificativa_ia || selectedLead?.resumo_ia) && (
                   <div className="space-y-3 animate-in fade-in slide-in-from-top-1">
                      {selectedLead?.justificativa_ia && (
                          <div className="p-4 rounded-2xl bg-purple-500/10 border border-purple-500/20">
                              <p className="text-[10px] font-black text-purple-400 uppercase mb-2 flex items-center gap-2">
                                  <Bot className="w-3.5 h-3.5" /> Motivo IA
                              </p>
                              <p className="text-xs text-purple-200/90 italic leading-relaxed">
                                  "{selectedLead.justificativa_ia}"
                              </p>
                          </div>
                      )}
                      {selectedLead?.resumo_ia && (
                          <div className="p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/20">
                              <p className="text-[10px] font-black text-indigo-300 uppercase mb-2 flex items-center gap-2">
                                  <MessageSquare className="w-3.5 h-3.5" /> Resumo da conversa
                              </p>
                              <p className="text-xs text-indigo-100/90 leading-relaxed">
                                  {selectedLead.resumo_ia}
                              </p>
                          </div>
                      )}
                      {selectedLead?.ia_last_analyzed_at && (
                          <p className="text-[10px] text-muted-foreground text-right font-mono">
                              Analisado em {new Date(selectedLead.ia_last_analyzed_at).toLocaleString("pt-BR")}
                          </p>
                      )}
                   </div>
                )}

                {/* Lead Intelligence — briefing IA. Renderizado se já existe;
                    botão "Analisar com IA" se ainda não foi gerado. */}
                <LeadIntelligenceSection
                  lead={selectedLead}
                  onUpdated={(updated) => setSelectedLead({ ...selectedLead, ...updated })}
                />

                <div className="flex mt-6 gap-3">
                    <Button
                        className="flex-1 gap-2 glow-primary h-12 rounded-xl font-bold bg-primary hover:bg-primary/90 text-primary-foreground transition-all duration-300 hover:scale-[1.02]"
                        onClick={() => {
                            const num = selectedLead?.remoteJid?.replace("@s.whatsapp.net", "") || selectedLead?.telefone?.replace(/\D/g, "");
                            window.open(`https://wa.me/${num}`, "_blank");
                        }}
                    >
                        <ExternalLink className="w-4 h-4" />
                        Chamar Direto
                    </Button>
                    <Button
                        variant="secondary"
                        className="flex-1 gap-2 h-12 rounded-xl font-bold bg-white/10 hover:bg-white/20 text-white transition-all duration-300 hover:scale-[1.02]"
                        onClick={() => {
                            if (selectedLead) {
                                // Passa instance_name pra o /chat trocar pra ela
                                // automaticamente (senão abria na lista geral
                                // se a instância ativa fosse outra).
                                const params = new URLSearchParams({
                                  session: selectedLead.remoteJid,
                                });
                                if ((selectedLead as any).instance_name) {
                                  params.set("instance", (selectedLead as any).instance_name);
                                }
                                window.location.href = `/chat?${params.toString()}`;
                            }
                        }}
                    >
                        <MessageSquare className="w-4 h-4 text-purple-300" />
                        Abrir Chat Interno
                    </Button>
                </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- Kanban Sub-components ---

function KanbanColumn({ column, leads, onLeadClick, formatPhone }: any) {
    const { setNodeRef } = useSortable({ id: column.id });

    return (
        <div className="w-[280px] sm:w-[320px] flex flex-col gap-4">
            <div className={cn("px-5 py-3 rounded-2xl border text-xs font-black uppercase tracking-widest flex items-center justify-between backdrop-blur-md shadow-lg", column.color)}>
                {column.label}
                <Badge variant="secondary" className="bg-black/40 text-inherit border-none text-[10px] w-6 h-6 p-0 flex items-center justify-center rounded-full">{leads.length}</Badge>
            </div>
            
            <div ref={setNodeRef} className="flex-1 space-y-4 p-1 min-h-[200px] overflow-y-auto custom-scrollbar pr-2 max-h-[calc(100vh-320px)]">
                {leads.map((lead: any) => (
                    <KanbanCard key={lead.id} lead={lead} onClick={() => onLeadClick(lead)} formatPhone={formatPhone} />
                ))}
            </div>
        </div>
    );
}

function KanbanCard({ lead, onClick, isOverlay, formatPhone }: any) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: lead?.id || 0 });

    if (!lead) return null;

    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging || isOverlay ? 50 : 1,
        opacity: isDragging ? 0.6 : 1,
    };

    const isOverdue = lead.next_follow_up && new Date(lead.next_follow_up) < new Date();
    
    // Pegar iniciais para avatar
    const initials = (lead.nome_negocio || "UD").substring(0,2).toUpperCase();

    return (
        <Card 
            ref={setNodeRef}
            style={style}
            className={cn(
                "group border-white/5 bg-white/5 backdrop-blur-xl transition-all duration-300 rounded-2xl overflow-hidden",
                isOverlay && "scale-[1.03] shadow-2xl shadow-primary/20 rotate-2 border-primary/40 ring-1 ring-primary/30 z-[100]",
                !isOverlay && "hover:bg-white/10 hover:border-white/20 hover:shadow-xl hover:-translate-y-0.5"
            )}
            onClick={onClick}
        >
            {/* Drag handle — only this area triggers drag on mobile */}
            <div
              {...attributes}
              {...listeners}
              className="flex items-center justify-center h-5 cursor-grab active:cursor-grabbing bg-white/[0.03] border-b border-white/5 md:hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-8 h-1 rounded-full bg-white/20" />
            </div>
            <CardContent className="p-4" {...(typeof window !== 'undefined' && window.matchMedia('(min-width:768px)').matches ? { ...attributes, ...listeners, style: { cursor: 'grab' } } : {})}>
                <div className="flex gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-purple-500/20 flex items-center justify-center shrink-0 border border-white/10 group-hover:border-primary/50 transition-colors">
                        <span className="text-xs font-black text-white/90">{initials}</span>
                    </div>
                    
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-bold leading-tight group-hover:text-primary-300 transition-colors line-clamp-2 text-white pb-1">
                            {lead.nome_negocio || "Sem Registro"}
                        </p>
                        
                        <div className="flex items-center gap-1.5 mt-1 opacity-80 group-hover:opacity-100 transition-opacity">
                            <Phone className="w-3 h-3 text-green-400" />
                            <span className="text-[10px] font-mono text-green-100">{lead.telefone || formatPhone(lead.remoteJid)}</span>
                        </div>
                    </div>
                </div>
                
                <div className="flex flex-wrap gap-2 mt-3 items-center justify-between">
                    <Badge variant="outline" className="text-[9px] font-bold tracking-wider py-0.5 px-2.5 border-white/10 bg-black/40 text-neutral-300 rounded-md">
                        {lead.ramo_negocio ? (lead.ramo_negocio.length > 25 ? lead.ramo_negocio.substring(0, 25) + '...' : lead.ramo_negocio) : "GERAL"}
                    </Badge>
                    
                    {lead.rating && (
                        <div className="flex items-center gap-1 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">
                            <Star className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
                            <span className="text-[9px] font-bold text-amber-400">{lead.rating}</span>
                        </div>
                    )}
                </div>

                {lead.next_follow_up && (
                    <div className={cn(
                        "mt-3 p-2 rounded-lg flex items-center gap-1.5 text-[10px] font-bold border",
                        isOverdue ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-primary/10 text-primary-300 border-primary/20"
                    )}>
                        <Clock className="w-3.5 h-3.5" />
                        {isOverdue ? "ATRASADO: " : "RETORNO: "}
                        {new Date(lead.next_follow_up).toLocaleString("pt-BR", {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

// =====================================================================
// LeadIntelligenceSection — mostra o briefing IA do lead OU botão pra gerar.
// Reutilizável: mesmo componente vai entrar depois no /disparo e /automacao
// na seleção de leads.
// =====================================================================
function LeadIntelligenceSection({ lead, onUpdated }: { lead: any; onUpdated: (u: any) => void }) {
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!lead) return null;
  const intel = lead.intelligence as any;
  const fetchedAt = lead.intelligence_at;

  const analyze = async (force = false) => {
    setAnalyzing(true);
    setError(null);
    try {
      const r = await fetch("/api/leads/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_id: lead.id, force }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha");
      onUpdated({
        intelligence: d.result.intelligence,
        intelligence_at: new Date().toISOString(),
        icp_score: d.result.intelligence.icp_score,
        lead_type: d.result.intelligence.lead_type,
      });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  // Sem briefing ainda → CTA pra gerar.
  if (!intel) {
    return (
      <div className="p-4 rounded-2xl bg-gradient-to-br from-cyan-500/10 to-purple-500/10 border border-cyan-500/20">
        <p className="text-[10px] font-black text-cyan-300 uppercase mb-2 flex items-center gap-2">
          <Bot className="w-3.5 h-3.5" /> Lead Intelligence
        </p>
        <p className="text-xs text-cyan-100/80 leading-relaxed mb-3">
          IA analisa o site, dados Maps e nicho do lead e te entrega um briefing estratégico em 10s. Reutilizado depois pelo disparo/automação pra personalizar mensagens automaticamente.
        </p>
        <Button onClick={() => analyze(false)} disabled={analyzing} className="w-full h-10 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-100 font-bold text-xs gap-2">
          {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
          {analyzing ? "Analisando..." : "Analisar com IA"}
        </Button>
        {error && <p className="text-[10px] text-red-300 mt-2">{error}</p>}
      </div>
    );
  }

  const tipoLabel: Record<string, string> = {
    b2b_recurring: "B2B Recorrente 💎",
    b2c_oneshot: "B2C One-shot",
    mixed: "B2B + B2C",
    unknown: "Indefinido",
  };
  const scoreColor =
    intel.icp_score >= 80 ? "text-emerald-300 bg-emerald-500/15 border-emerald-500/30" :
    intel.icp_score >= 60 ? "text-cyan-300 bg-cyan-500/15 border-cyan-500/30" :
    intel.icp_score >= 40 ? "text-amber-300 bg-amber-500/15 border-amber-500/30" :
                            "text-red-300 bg-red-500/15 border-red-500/30";

  return (
    <div className="p-4 rounded-2xl bg-gradient-to-br from-cyan-500/10 to-purple-500/10 border border-cyan-500/20 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-black text-cyan-300 uppercase flex items-center gap-2">
          <Bot className="w-3.5 h-3.5" /> Lead Intelligence
        </p>
        <div className="flex items-center gap-2">
          <span className={cn("px-2 py-0.5 rounded-md text-[10px] font-black border", scoreColor)}>
            ICP {intel.icp_score}/100
          </span>
          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-white/5 border border-white/10 text-white/80">
            {tipoLabel[intel.lead_type] || intel.lead_type}
          </span>
        </div>
      </div>

      {intel.dores?.length > 0 && (
        <div>
          <p className="text-[9px] uppercase font-bold text-muted-foreground mb-1">Dores prováveis</p>
          <ul className="text-[11px] text-white/85 space-y-0.5">
            {intel.dores.slice(0, 4).map((d: string, i: number) => <li key={i}>• {d}</li>)}
          </ul>
        </div>
      )}

      {intel.abordagem && (
        <div>
          <p className="text-[9px] uppercase font-bold text-muted-foreground mb-1">Ângulo recomendado</p>
          <p className="text-[11px] text-cyan-100/90 italic">{intel.abordagem}</p>
        </div>
      )}

      {intel.decisor && intel.decisor !== "não identificado" && (
        <div className="text-[10px] text-white/70">
          <span className="font-bold">Decisor:</span> {intel.decisor}
        </div>
      )}

      {intel.alerta && (
        <div className="p-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-200">
          ⚠ {intel.alerta}
        </div>
      )}

      {intel.briefing_md && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-cyan-300 hover:text-cyan-200 font-bold">Ver briefing completo</summary>
          <pre className="mt-2 p-2 rounded-md bg-black/40 border border-white/5 text-white/85 whitespace-pre-wrap font-sans leading-relaxed">{intel.briefing_md}</pre>
        </details>
      )}

      {/* FONTES — transparência: mostra exatamente o que a IA leu pra chegar
          nas conclusões acima. Usuário pode auditar / questionar. */}
      {intel.sources && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-cyan-300/80 hover:text-cyan-200 font-bold">📚 Fontes consultadas pela IA</summary>
          <div className="mt-2 space-y-3">
            {intel.sources.model_used && (
              <p className="text-[9px] text-muted-foreground font-mono">
                Modelo usado: <strong>{intel.sources.model_used}</strong>
              </p>
            )}
            {intel.sources.site_excerpt && (
              <div className="p-2 rounded-md bg-black/40 border border-white/5">
                <p className="text-[9px] uppercase font-bold text-emerald-300 mb-1">🌐 Site oficial</p>
                {intel.sources.site_url && (
                  <a href={intel.sources.site_url} target="_blank" rel="noreferrer" className="text-[9px] text-emerald-400 underline break-all">{intel.sources.site_url}</a>
                )}
                <p className="text-[10px] text-white/70 mt-1 italic line-clamp-6">"{intel.sources.site_excerpt}"</p>
              </div>
            )}
            {Array.isArray(intel.sources.search_lead) && intel.sources.search_lead.length > 0 && (
              <div className="p-2 rounded-md bg-black/40 border border-white/5">
                <p className="text-[9px] uppercase font-bold text-cyan-300 mb-1">🔎 Busca web sobre o lead ({intel.sources.search_lead.length})</p>
                <ul className="space-y-1.5">
                  {intel.sources.search_lead.map((r: any, i: number) => (
                    <li key={i} className="text-[10px]">
                      <a href={r.url} target="_blank" rel="noreferrer" className="text-cyan-400 underline font-bold">{r.title || r.url}</a>
                      {r.snippet && <p className="text-white/60 mt-0.5">{r.snippet}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {Array.isArray(intel.sources.search_competitors) && intel.sources.search_competitors.length > 0 && (
              <div className="p-2 rounded-md bg-black/40 border border-white/5">
                <p className="text-[9px] uppercase font-bold text-purple-300 mb-1">🏢 Concorrentes / top players ({intel.sources.search_competitors.length})</p>
                <ul className="space-y-1.5">
                  {intel.sources.search_competitors.map((r: any, i: number) => (
                    <li key={i} className="text-[10px]">
                      <a href={r.url} target="_blank" rel="noreferrer" className="text-purple-400 underline font-bold">{r.title || r.url}</a>
                      {r.snippet && <p className="text-white/60 mt-0.5">{r.snippet}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!intel.sources.site_excerpt &&
             (!intel.sources.search_lead || intel.sources.search_lead.length === 0) &&
             (!intel.sources.search_competitors || intel.sources.search_competitors.length === 0) && (
              <p className="text-[10px] text-amber-300/80 italic">
                ⚠ Nenhuma fonte externa coletada. A análise se baseou só nos dados do Google Maps. Pode ser que o site bloqueou crawler ou a busca DDG não retornou nada.
              </p>
            )}
          </div>
        </details>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-white/5">
        <p className="text-[9px] font-mono text-muted-foreground">
          {fetchedAt ? `Analisado em ${new Date(fetchedAt).toLocaleString("pt-BR")}` : ""}
        </p>
        <button
          onClick={() => analyze(true)}
          disabled={analyzing}
          className="text-[10px] font-bold text-cyan-300 hover:text-cyan-100 disabled:opacity-50"
        >
          {analyzing ? "Reanalisando..." : "🔄 Reanalisar"}
        </button>
      </div>
      {error && <p className="text-[10px] text-red-300">{error}</p>}
    </div>
  );
}
