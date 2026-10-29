"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogTitle,
} from "@/components/ui/dialog";
import {
    Search, Download, ChevronLeft, ChevronRight, Phone,
    ExternalLink, Star, LayoutGrid, List,
    Trash2, Filter, Bot, X, CheckSquare, Loader2, UserPlus,
    MapPin, Send, CheckCircle2, RotateCw,
} from "lucide-react";
import { toast } from "sonner";
import { LeadDrawer } from "@/components/leads/lead-drawer";
import { AddLeadDialog } from "@/components/add-lead-dialog";
import { LeadAvatar } from "@/components/leads/lead-avatar";
import { syncLeadPhotosSequentially, type SyncProgressState } from "@/lib/lead-photo-sync";
import { supabase } from "@/lib/supabase";
import { getPhotoJid, safePhotoUrl } from "@/lib/whatsapp-photo-utils";
import dynamic from "next/dynamic";

const KanbanBoard = dynamic(
  () => import("./_components/KanbanBoard"),
  { ssr: false, loading: () => <KanbanSkeleton /> }
);

function KanbanSkeleton() {
  return (
    <div className="flex-1 w-full overflow-x-auto pb-8">
      <div className="flex gap-3 sm:gap-6 min-w-max p-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="w-[280px] sm:w-[320px] flex flex-col gap-4">
            <div className="h-12 rounded-2xl bg-white/5 animate-pulse" />
            <div className="space-y-4">
              {[1, 2, 3].map((j) => (
                <div key={j} className="h-32 rounded-2xl bg-white/5 animate-pulse" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
import { cn } from "@/lib/utils";
import { useClientSession } from "@/lib/use-session";
import styles from "./leads.module.css";

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
  maps_url: string;
  status: string; // 'novo', 'interessado', 'follow-up', 'agendado', 'fechado', 'sem_interesse', 'descartado'
  next_follow_up: string | null;
  lembrete_texto?: string | null;
  observacoes?: string | null;
  profilePicUrl?: string | null;
  justificativa_ia: string | null;
  resumo_ia: string | null;
  ia_last_analyzed_at: string | null;
  created_at: string;
  primeiro_contato_source: string | null;
  primeiro_contato_at: string | null;
}

// helper: constroi URL Maps canônica — usa maps_url salvo (place_id embutido);
// fallback busca por nome+endereço se lead antigo sem maps_url.
function mapsUrlFor(lead: Pick<Lead, "maps_url" | "nome_negocio" | "endereco">): string {
  if (lead.maps_url) return lead.maps_url;
  const q = encodeURIComponent(`${lead.nome_negocio || ""} ${lead.endereco || ""}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
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

// Projeção explícita: exclui dezenas de colunas JSONB pesadas do Google Maps
// (reviews_detalhes, featured_reviews, photos, opening_hours, attributes, etc.)
// que não são usadas na listagem, Kanban ou gaveta CRM, reduzindo em até 90%
// o tráfego de rede e leitura de TOAST no Postgres (especialmente no Kanban de 500 leads).
const LEAD_LIST_COLUMNS = [
  "id",
  '"remoteJid"',
  "nome_negocio",
  "telefone",
  "email",
  "ramo_negocio",
  "categoria",
  "endereco",
  "avaliacao",
  "rating",
  "reviews",
  "website",
  "instagram",
  "facebook",
  "maps_url",
  "status",
  "instance_name",
  "next_follow_up",
  "observacoes",
  "business_details",
  "justificativa_ia",
  "resumo_ia",
  "ia_last_analyzed_at",
  "created_at",
  "primeiro_contato_source",
  "primeiro_contato_at",
  "intelligence",
  "intelligence_at",
  "icp_score",
  "lead_type",
].join(", ");

export default function LeadsPage() {
  const { clientId } = useClientSession();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "kanban">("list");
  const [disparoFilter, setDisparoFilter] = useState<"all" | "pending" | "sent">("all");
  const [disparoJids, setDisparoJids] = useState<Set<string>>(new Set());
  const [syncProgress, setSyncProgress] = useState<SyncProgressState | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const syncCancelRef = useRef<{ current: boolean }>({ current: false });
  const syncGenerationRef = useRef(0);
  const fetchGenerationRef = useRef<number>(0);
  const useWildcardSelectRef = useRef<boolean>(false);

  // Cancela sincronização e descarta fetch pendente ao desmontar ou trocar tenant
  useEffect(() => {
    setSyncProgress(null);
    return () => {
      fetchGenerationRef.current++;
      syncGenerationRef.current++;
      syncAbortRef.current?.abort();
      syncAbortRef.current = null;
      syncCancelRef.current.current = true;
    };
  }, [clientId]);

  // Escuta parâmetro de URL openLeadId (ex: vindo da Dashboard)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const openLeadId = params.get("openLeadId");
    if (openLeadId && clientId) {
      fetch(`/api/leads/${openLeadId}/crm`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.lead) {
            setSelectedLead({
              ...data.lead,
              profilePicUrl: data.profilePicUrl,
            });
          }
        })
        .catch(() => {});
    }
  }, [clientId]);

  const handleSyncPhotos = async () => {
    if (!clientId || syncAbortRef.current) return;
    syncCancelRef.current = { current: false };
    const controller = new AbortController();
    const generation = ++syncGenerationRef.current;
    syncAbortRef.current = controller;

    setSyncProgress({
      processed: 0,
      total: 0,
      updated: 0,
      noPhoto: 0,
      skipped: 0,
      failed: 0,
      avatars: {},
      inFlight: true,
      cancelled: false,
      error: null,
    });

    const isCurrentSync = () => !controller.signal.aborted && syncGenerationRef.current === generation;
    const applyAvatars = (newAvatars: Record<string, string | null>) => {
      if (!isCurrentSync()) return;
      setLeads((prev) =>
        !isCurrentSync() ? prev : prev.map((lead) => {
          const jid = getPhotoJid(lead.remoteJid) ?? getPhotoJid(lead.telefone);
          if (jid && jid in newAvatars) {
            const freshUrl = newAvatars[jid] ?? safePhotoUrl(lead.profilePicUrl);
            if (freshUrl !== lead.profilePicUrl) {
              return { ...lead, profilePicUrl: freshUrl };
            }
          }
          return lead;
        })
      );
      setSelectedLead((prev) => {
        if (!isCurrentSync() || !prev) return prev;
        const jid = getPhotoJid(prev.remoteJid) ?? getPhotoJid(prev.telefone);
        if (jid && jid in newAvatars) {
          const freshUrl = newAvatars[jid] ?? safePhotoUrl(prev.profilePicUrl);
          if (freshUrl !== prev.profilePicUrl) {
            return { ...prev, profilePicUrl: freshUrl };
          }
        }
        return prev;
      });
    };

    try {
      const finalState = await syncLeadPhotosSequentially(
        {
          signal: controller.signal,
          onProgress: (state) => { if (isCurrentSync()) setSyncProgress(state); },
          onBatchAvatars: (batchAvatars) => applyAvatars(batchAvatars),
        },
        syncCancelRef.current
      );

      if (!isCurrentSync()) return;
      setSyncProgress(finalState);

      if (finalState.cancelled) {
        toast.info(
          `Sincronização interrompida: ${finalState.updated} fotos atualizadas (${finalState.processed}/${finalState.total || finalState.processed} processados).`
        );
      } else if (finalState.failed > 0) {
        toast.warning(
          `Sincronização concluída com avisos: ${finalState.updated} atualizadas, ${finalState.noPhoto} sem foto, ${finalState.failed} falhas.`
        );
      } else {
        toast.success(
          `Sincronização concluída: ${finalState.updated} fotos atualizadas, ${finalState.noPhoto} sem foto disponibilizada pelo WhatsApp, ${finalState.skipped} ignoradas (${finalState.processed} leads processados).`
        );
      }
    } catch (err: unknown) {
      if (isCurrentSync()) {
        const msg = err instanceof Error ? err.message : "Erro na sincronização de fotos";
        toast.error(msg);
        setSyncProgress((prev) => (prev ? { ...prev, inFlight: false, error: msg } : null));
      }
    } finally {
      if (syncAbortRef.current === controller) syncAbortRef.current = null;
    }
  };

  const handleCancelSync = () => {
    syncCancelRef.current.current = true;
    setSyncProgress((prev) => (prev ? { ...prev, cancelled: true } : null));
  };

  // Colunas do Kanban — fonte única é a tabela kanban_columns (editável no
  // Organizador). Começa com o fallback hardcoded e troca pelo que vier da API
  // pra CRM, Organizador e auto-promote do agente sempre baterem.
  const [columns, setColumns] = useState<{ id: string; uuid: string; label: string; color: string; isTerminal: boolean }[]>(KANBAN_COLUMNS.map((c: any) => ({ id: c.id, uuid: "", label: c.label, color: c.color, isTerminal: false })));
  useEffect(() => {
    fetch("/api/kanban-columns", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        console.log("[kanban-cols] GET", r.status, j);
        if (j?.ok && Array.isArray(j.columns) && j.columns.length > 0) {
          setColumns(j.columns.map((c: any) => ({ id: c.status_key, uuid: c.id, label: c.label, color: c.color, isTerminal: !!c.is_terminal })));
        }
      })
      .catch((e) => console.error("[kanban-cols] GET erro", e));
  }, []);

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
  }, [page, search, categoryFilter, clientId, viewMode, disparoFilter]);



  const fetchLeads = useCallback(async () => {
    if (!clientId) return;
    const currentFetchId = ++fetchGenerationRef.current;
    setLoading(true);
    try {
      const buildLeadsQuery = (columnsToSelect: string) => {
        let query = supabase
          .from("leads_extraidos")
          .select(columnsToSelect, { count: "exact" })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });

        if (clientId) {
          query = query.eq("client_id", clientId);
        }

        if (search) {
          query = query.or(`nome_negocio.ilike.%${search}%,ramo_negocio.ilike.%${search}%,telefone.ilike.%${search}%`);
        }

        if (categoryFilter !== "all") {
          query = query.eq("ramo_negocio", categoryFilter);
        }

        // Disparo filter: sent = source='disparo' OR in campaign_targets;
        // pending = everything else
        if (disparoFilter === "sent") {
          query = query.eq("primeiro_contato_source", "disparo");
        } else if (disparoFilter === "pending") {
          query = query.or("primeiro_contato_source.is.null,primeiro_contato_source.neq.disparo");
        }

        // Aplica paginação apenas na lista. No kanban traz mais (ex 500)
        if (viewMode === "list") {
          query = query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        } else {
          query = query.limit(500);
        }

        return query;
      };

      // Dispara busca de campaign_targets e leads_extraidos em paralelo (1 RTT ao invés de 2 sequenciais)
      const sentTargetsPromise = supabase
        .from("campaign_targets")
        .select("remote_jid")
        .eq("status", "sent")
        .eq("client_id", clientId);

      const initialColumns = useWildcardSelectRef.current ? "*" : LEAD_LIST_COLUMNS;
      const [sentTargetsRes, initialLeadsRes] = await Promise.all([
        sentTargetsPromise,
        buildLeadsQuery(initialColumns),
      ]);

      if (currentFetchId !== fetchGenerationRef.current) return;

      const sentTargets = sentTargetsRes?.data as { remote_jid: string }[] | null | undefined;
      if (sentTargets) {
        setDisparoJids(new Set(sentTargets.map((t) => t.remote_jid)));
      }

      // Fallback automático caso alguma coluna da projeção ainda não exista no banco do tenant
      let leadsRes = initialLeadsRes;
      if (leadsRes?.error && !useWildcardSelectRef.current) {
        useWildcardSelectRef.current = true;
        leadsRes = await buildLeadsQuery("*");
        if (currentFetchId !== fetchGenerationRef.current) return;
      }

      const data = leadsRes?.data as unknown as Lead[] | null;
      const count = leadsRes?.count;
      const fetchedList = (data || []) as Lead[];

      // Garante remoteJid normalizado para todos os leads (inclusive os extraídos sem conversa prévia)
      fetchedList.forEach((l) => {
        l.remoteJid = l.remoteJid || getPhotoJid(l.telefone) || "";
      });

      // Hidratação das fotos em cache (chunks de até 200 JIDs, sem chamadas ao provedor na visualização)
      if (fetchedList.length > 0) {
        const jids = Array.from(new Set(fetchedList.map((l) => getPhotoJid(l.remoteJid) ?? getPhotoJid(l.telefone)).filter((jid): jid is string => !!jid)));
        if (jids.length > 0) {
          const CHUNK_SIZE = 200;
          const chunks: string[][] = [];
          for (let i = 0; i < jids.length; i += CHUNK_SIZE) {
            chunks.push(jids.slice(i, i + CHUNK_SIZE));
          }
          try {
            const avatarResponses = await Promise.all(
              chunks.map((chunk) =>
                fetch("/api/contacts/avatars", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ jids: chunk, cachedOnly: true }),
                })
                  .then((r) => (r.ok ? r.json() : null))
                  .catch(() => null)
              )
            );

            if (currentFetchId === fetchGenerationRef.current) {
              const cachedMap: Record<string, string | null> = {};
              for (const res of avatarResponses) {
                if (res?.avatars) {
                  Object.assign(cachedMap, res.avatars);
                }
              }

              fetchedList.forEach((l) => {
                const jid = getPhotoJid(l.remoteJid) ?? getPhotoJid(l.telefone);
                if (jid && cachedMap[jid]) l.profilePicUrl = cachedMap[jid];
              });
            }
          } catch {
            // Ignora falhas de avatar para não prejudicar listagem
          }
        }
      }

      if (currentFetchId !== fetchGenerationRef.current) return;
      setLeads(fetchedList);
      setTotal(count || 0);

      // Extract unique categories for filter
      if (data) {
          const uniqueCats = Array.from(new Set(data.map(l => l.ramo_negocio).filter(Boolean))) as string[];
          setCategories(prev => Array.from(new Set([...prev, ...uniqueCats])));
      }
    } catch (err) {
      if (currentFetchId === fetchGenerationRef.current) {
        console.error("Erro ao carregar leads:", err);
      }
    } finally {
      if (currentFetchId === fetchGenerationRef.current) {
        setLoading(false);
      }
    }
  }, [page, search, viewMode, categoryFilter, clientId, disparoFilter]);

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
    
    let query = supabase.from("leads_extraidos")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });

    if (clientId) {
      query = query.eq("client_id", clientId);
    }
    
    const { data } = await query;
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
  const hasFilters = search !== "" || categoryFilter !== "all" || disparoFilter !== "all";
  const clearFilters = () => {
    setSearch("");
    setCategoryFilter("all");
    setDisparoFilter("all");
    setPage(0);
  };
  const statusLabel = (status: string | null | undefined): string => {
    const key = status || "novo";
    const label = columns.find((column) => column.id === key)?.label || KANBAN_COLUMNS.find((column) => column.id === key)?.label || key.replace(/_/g, " ");
    return label.replace(/\s*✅/g, "");
  };

  const handleKanbanLeadsUpdated = useCallback((updatedLeads: Lead[]) => {
    setLeads(updatedLeads);
  }, []);

  return (
    <div className={cn(styles.crm, "flex h-[100dvh] min-w-0 flex-col overflow-hidden")}>
      <Header />
      <div className={cn(styles.content, "flex-1 min-h-0 overflow-y-auto")}>
        <div className={styles.heading}>
          <div>
            <h2>Clientes</h2>
            <p>Seus contatos, suas oportunidades e o próximo passo.</p>
          </div>
          <Button onClick={() => setAddLeadOpen(true)} className={styles.primaryAction}>
            <UserPlus className="size-4" /> Adicionar Cliente
          </Button>
        </div>
        {/* Toolbar */}
        <section className={styles.toolbar} aria-label="Filtros e visualização dos clientes">
          <div className={styles.searchRow}>
              <div className={styles.search}>
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="Buscar clientes"
                  placeholder="Buscar nome ou telefone"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  className={styles.searchInput}
                />
              </div>
              
              <Select value={categoryFilter} onValueChange={(val) => setCategoryFilter(val as string || "all")}>
                  <SelectTrigger className={styles.categoryFilter} aria-label="Filtrar por categoria">
                      <Filter className="size-4 text-muted-foreground" />
                      <SelectValue>{categoryFilter === "all" ? "Todas as categorias" : categoryFilter}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="border-[#3b483e] bg-[#181d19] text-[#edf2ee]">
                      <SelectItem value="all">Todas as Categorias</SelectItem>
                      {categories.map(c => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                  </SelectContent>
              </Select>
              {hasFilters && (
                <Button variant="ghost" onClick={clearFilters} className={styles.clearFilters}>
                  <X className="size-3.5" /> Limpar filtros
                </Button>
              )}
          </div>

          <div className={styles.viewRow}>
            <div className={styles.segmented} role="group" aria-label="Visualização dos clientes">
                <Button 
                    variant={viewMode === "list" ? "secondary" : "ghost"} 
                    size="sm" 
                    className={styles.viewButton}
                    aria-pressed={viewMode === "list"}
                    onClick={() => setViewMode("list")}
                >
                    <List className="w-3.5 h-3.5" /> Lista
                </Button>
                <Button 
                    variant={viewMode === "kanban" ? "secondary" : "ghost"} 
                    size="sm" 
                    className={styles.viewButton}
                    aria-pressed={viewMode === "kanban"}
                    onClick={() => setViewMode("kanban")}
                >
                    <LayoutGrid className="w-3.5 h-3.5" /> Kanban
                </Button>
            </div>
            
            {/* Disparo Status Segmented Control */}
            {viewMode === "list" && (
            <div className={styles.disparoFilters} role="group" aria-label="Filtrar por disparo">
                <Button 
                    variant="ghost" 
                    size="sm" 
                    className={styles.filterButton}
                    aria-pressed={disparoFilter === "all"}
                    onClick={() => { setDisparoFilter("all"); setPage(0); }}
                >
                    Todos
                </Button>
                <Button 
                    variant="ghost" 
                    size="sm" 
                    className={styles.filterButton}
                    aria-pressed={disparoFilter === "pending"}
                    onClick={() => { setDisparoFilter("pending"); setPage(0); }}
                >
                    <Send className="w-3 h-3" /> Pendentes
                </Button>
                <Button 
                    variant="ghost" 
                    size="sm" 
                    className={styles.filterButton}
                    aria-pressed={disparoFilter === "sent"}
                    onClick={() => { setDisparoFilter("sent"); setPage(0); }}
                >
                    <CheckCircle2 className="w-3 h-3" /> Disparados
                </Button>
            </div>
            )}
            
            <span className={styles.total}>{loading ? "Carregando..." : `${total.toLocaleString("pt-BR")} ${total === 1 ? "contato" : "contatos"}`}</span>

            <div className={styles.maintenance}>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncPhotos}
              disabled={syncProgress?.inFlight}
              className={styles.secondaryAction}
              title="Sincronizar fotos de todos os leads cadastrados (independente de filtros)"
              aria-label="Sincronizar fotos de todos os leads"
            >
              {syncProgress?.inFlight ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
              ) : (
                <RotateCw className="w-3.5 h-3.5 text-emerald-400" />
              )}
              <span>{syncProgress?.inFlight ? "Sincronizando..." : "Sincronizar fotos"}</span>
            </Button>
            
            <Button variant="outline" size="sm" onClick={exportXLSX} className={styles.secondaryAction} aria-label="Exportar clientes para Excel">
              <Download className="size-3.5" /> Exportar
            </Button>
            </div>
          </div>
        </section>

        {syncProgress && (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-wrap items-center justify-between gap-3 p-3 px-4 rounded-2xl border border-emerald-500/30 bg-emerald-950/20 text-xs text-emerald-200 animate-in fade-in slide-in-from-top-1"
          >
            <div className="flex items-center gap-2">
              {syncProgress.inFlight ? (
                <Loader2 className="w-4 h-4 animate-spin text-emerald-400 shrink-0" />
              ) : syncProgress.error ? (
                <X className="w-4 h-4 text-red-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
              <span className="font-medium">
                {syncProgress.inFlight
                  ? syncProgress.total === 0 && syncProgress.processed === 0
                    ? "Preparando sincronização de todos os leads…"
                    : `Sincronizando todos os leads (${syncProgress.processed}/${syncProgress.total}): ${syncProgress.updated} atualizadas, ${syncProgress.noPhoto} sem foto, ${syncProgress.skipped} ignoradas${syncProgress.failed > 0 ? `, ${syncProgress.failed} falhas` : ""}`
                  : syncProgress.cancelled
                  ? `Sincronização interrompida: ${syncProgress.updated} atualizadas (${syncProgress.processed}/${syncProgress.total || syncProgress.processed} processados)`
                  : syncProgress.error
                  ? `Erro na sincronização: ${syncProgress.error} (${syncProgress.updated} fotos atualizadas antes da falha)`
                  : `Sincronização concluída${syncProgress.failed ? " com avisos" : ""}: ${syncProgress.updated} fotos atualizadas, ${syncProgress.noPhoto} sem foto disponibilizada pelo WhatsApp, ${syncProgress.skipped} ignoradas, ${syncProgress.failed} falhas (${syncProgress.processed} leads processados).`}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {syncProgress.inFlight && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-3 text-xs text-zinc-300 hover:text-white hover:bg-white/10"
                  onClick={handleCancelSync}
                  disabled={syncProgress.cancelled}
                >
                  {syncProgress.cancelled ? "Interrompendo..." : "Cancelar"}
                </Button>
              )}
              {!syncProgress.inFlight && (
                <button
                  type="button"
                  onClick={() => setSyncProgress(null)}
                  className="text-zinc-400 hover:text-zinc-200 p-1"
                  aria-label="Fechar status de sincronização"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        <AddLeadDialog
          open={addLeadOpen}
          onOpenChange={setAddLeadOpen}
          onCreated={() => { if (page === 0) void fetchLeads(); else setPage(0); }}
        />

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
          <Card className={styles.listPanel}>
            <CardContent className="p-0">
              <div className={styles.listHeading}>
                <div><h3>Seus contatos</h3><p>Selecione um cliente para abrir a ficha completa.</p></div>
                <span className={styles.resultCount}>{loading ? "Atualizando" : `${leads.length} nesta página`}</span>
              </div>
              {/* Desktop Table */}
              <div className={styles.desktopTable} aria-busy={loading}>
                <Table className={styles.table} aria-label="Clientes cadastrados">
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
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Cliente / Etapa</TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Contato</TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Categoria</TableHead>
                      <TableHead className="text-[10px] uppercase font-black tracking-wider text-muted-foreground py-5">Reputação</TableHead>
                      <TableHead className={cn(styles.dateColumn, "text-muted-foreground")}>Cadastro</TableHead>
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
                          <div className={styles.empty}>
                            <Search className="size-8" />
                            <h3>{hasFilters ? "Nenhum cliente encontrado" : "Sua carteira começa aqui"}</h3>
                            <p>{hasFilters ? "Tente outro nome, telefone ou categoria." : "Adicione um cliente para acompanhar suas oportunidades."}</p>
                            <Button variant="outline" onClick={hasFilters ? clearFilters : () => setAddLeadOpen(true)}>{hasFilters ? "Remover filtros" : "Adicionar primeiro cliente"}</Button>
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
                              <div className="flex items-center gap-3">
                                <LeadAvatar
                                  url={lead.profilePicUrl}
                                  name={lead.nome_negocio}
                                  className="w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700 text-xs font-bold text-zinc-300"
                                  fallbackClassName="text-xs font-bold bg-zinc-800 text-zinc-300"
                                />
                                <div className="min-w-0">
                                  <div className={styles.identity}>
                                    <button type="button" className={styles.clientName} aria-label={`Abrir ficha de ${lead.nome_negocio || "cliente"}`} title={lead.nome_negocio} onClick={(event) => { event.stopPropagation(); setSelectedLead(lead); }}>{lead.nome_negocio || "Sem nome"}</button>
                                    {(lead.primeiro_contato_source === "disparo" || disparoJids.has(lead.remoteJid)) && (
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 text-[9px] font-bold border border-cyan-500/25 whitespace-nowrap" title={lead.primeiro_contato_at ? `Disparado em ${new Date(lead.primeiro_contato_at).toLocaleDateString("pt-BR")}` : "Lead já recebeu disparo"}>
                                        <Send className="w-2.5 h-2.5" /> Disparado
                                      </span>
                                    )}
                                  </div>
                                  <div className={styles.stage} data-status={lead.status || "novo"}>{statusLabel(lead.status)}</div>
                                </div>
                              </div>
                          </TableCell>
                          <TableCell className="py-4">
                              <div className={styles.phone}>
                                  <Phone className="w-3 h-3" />
                                  {lead.telefone || formatPhone(lead.remoteJid)}
                              </div>
                          </TableCell>
                          <TableCell className="py-4">
                            <span className={styles.category}>
                                {lead.ramo_negocio || "Sem categoria"}
                            </span>
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
                          <TableCell className={cn(styles.dateColumn, "text-xs text-muted-foreground tabular-nums")}>
                            {new Date(lead.created_at).toLocaleDateString("pt-BR")}
                          </TableCell>
                          <TableCell className="text-right py-4 pr-6">
                              <div className={styles.rowActions}>
                                  <Button size="icon" variant="ghost" className={styles.rowAction} aria-label={`Ver detalhes de ${lead.nome_negocio || "cliente"}`} onClick={(e) => { e.stopPropagation(); setSelectedLead(lead); }} title="Abrir ficha">
                                      <ExternalLink className="w-3.5 h-3.5 text-blue-400" />
                                  </Button>
                                  <Button size="icon" variant="ghost" className={styles.rowAction} aria-label={`Ver ${lead.nome_negocio || "cliente"} no Maps`} onClick={(e) => { e.stopPropagation(); window.open(mapsUrlFor(lead), "_blank", "noopener,noreferrer"); }} title="Ver no Maps">
                                      <MapPin className="w-3.5 h-3.5 text-rose-400" />
                                  </Button>
                                  <Button size="icon" variant="ghost" className={cn(styles.rowAction, styles.deleteAction)} aria-label={`Excluir ${lead.nome_negocio || "cliente"}`} title="Excluir cliente" onClick={(e) => {
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
              <div className={styles.mobileList} aria-busy={loading}>
                {loading ? (
                  [...Array(6)].map((_, i) => <div key={i} className="h-20 animate-pulse bg-white/5" />)
                ) : leads.length === 0 ? (
                  <div className={styles.empty}>
                    <Search className="size-8" />
                    <h3>{hasFilters ? "Nenhum cliente encontrado" : "Sua carteira começa aqui"}</h3>
                    <p>{hasFilters ? "Tente outro nome, telefone ou categoria." : "Adicione seu primeiro cliente para começar."}</p>
                    <Button variant="outline" onClick={hasFilters ? clearFilters : () => setAddLeadOpen(true)}>{hasFilters ? "Remover filtros" : "Adicionar primeiro cliente"}</Button>
                  </div>
                ) : (
                  leads.map((lead) => (
                    <button
                      key={lead.id}
                      type="button"
                      aria-label={`Abrir ficha de ${lead.nome_negocio || "cliente"}`}
                      onClick={() => setSelectedLead(lead)}
                      className={styles.mobileContact}
                    >
                      <LeadAvatar
                        url={lead.profilePicUrl}
                        name={lead.nome_negocio}
                        className="w-10 h-10 rounded-xl bg-zinc-800 border border-zinc-700 text-sm font-black text-primary"
                        fallbackClassName="text-sm font-black bg-zinc-800 text-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-bold text-sm truncate">{lead.nome_negocio || "—"}</p>
                          {(lead.primeiro_contato_source === "disparo" || disparoJids.has(lead.remoteJid)) && (
                            <Send className="w-3 h-3 text-cyan-400 shrink-0" />
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          <span className="text-xs text-muted-foreground">{lead.ramo_negocio || "Sem categoria"}</span>
                          {lead.rating && (
                            <span className="flex items-center gap-0.5 text-[10px] text-amber-400">
                              <Star className="w-2.5 h-2.5 fill-amber-400" />{lead.rating}
                            </span>
                          )}
                        </div>
                        <div className={styles.mobilePhone}><Phone className="size-3" />{lead.telefone || formatPhone(lead.remoteJid)}</div>
                        <div className={styles.stage} data-status={lead.status || "novo"}>{statusLabel(lead.status)}</div>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))
                )}
              </div>

              {totalPages > 1 && (
                <div className={styles.pagination} aria-label="Paginação dos clientes">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Página {page + 1} de {totalPages}
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
          <KanbanBoard
            leads={leads}
            columns={columns}
            onLeadClick={setSelectedLead}
            formatPhone={formatPhone}
            onLeadsUpdated={handleKanbanLeadsUpdated}
            onColumnsChange={(cols) => setColumns(cols.map((c) => ({ id: c.id, uuid: c.uuid, label: c.label, color: c.color, isTerminal: !!c.isTerminal })))}
          />
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
                  <DialogTitle className="text-xl font-semibold text-white">Excluir cliente?</DialogTitle>
                  <p className="text-sm text-neutral-300">
                      Você está prestes a excluir <strong className="text-white">&quot;{leadToDelete?.nome_negocio || "este lead"}&quot;</strong>.
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

      {/* Ficha CRM do Lead (Drawer Lateral) */}
      <LeadDrawer
        lead={selectedLead as any}
        open={!!selectedLead && !showConfirmDelete}
        onOpenChange={(open) => {
          if (!open) setSelectedLead(null);
        }}
        onLeadUpdated={(updated) => {
          setLeads((prev) =>
            prev.map((l) =>
              l.id === Number(updated.id) ? ({ ...l, ...updated, id: l.id } as Lead) : l
            )
          );
          setSelectedLead((prev) =>
            prev?.id === Number(updated.id) ? ({ ...prev, ...updated, id: prev.id } as Lead) : prev
          );
        }}
        onDelete={(l) => {
          setLeadToDelete(l as any);
          setShowConfirmDelete(true);
        }}
        extraContent={
          selectedLead ? (
            <LeadIntelligenceSection
              lead={selectedLead}
              onUpdated={(updated) =>
                setSelectedLead({ ...selectedLead, ...updated })
              }
            />
          ) : null
        }
      />
    </div>
  );
}// =====================================================================
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
                <p className="text-[10px] text-white/70 mt-1 italic line-clamp-6">&quot;{intel.sources.site_excerpt}&quot;</p>
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
