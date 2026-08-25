"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor,
  useSensor, useSensors, DragOverlay,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable, horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Phone, Clock, Star, Plus, MoreVertical, Pencil, Trash2, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";

export interface KanbanColumnDef {
  id: string;          // status_key (estável p/ drag)
  uuid: string;        // id real DB (p/ editar/apagar)
  label: string;
  color: string;       // hex "#3b82f6" OU classe tailwind legada
  isTerminal?: boolean;
}

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
  status: string;
  next_follow_up: string | null;
  justificativa_ia: string | null;
  resumo_ia: string | null;
  ia_last_analyzed_at: string | null;
  created_at: string;
  primeiro_contato_source: string | null;
  primeiro_contato_at: string | null;
}

function mapsUrlFor(lead: Pick<Lead, "maps_url" | "nome_negocio" | "endereco">): string {
  if (lead.maps_url) return lead.maps_url;
  const q = encodeURIComponent(`${lead.nome_negocio || ""} ${lead.endereco || ""}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

interface KanbanBoardProps {
  leads: Lead[];
  columns: KanbanColumnDef[];
  onLeadClick: (lead: Lead) => void;
  formatPhone: (jid: string) => string;
  onLeadsUpdated?: (leads: Lead[]) => void;
  onColumnsChange?: (cols: KanbanColumnDef[]) => void;
}

const COLOR_PRESETS = [
  "#3b82f6", "#06b6d4", "#a855f7", "#8b5cf6", "#ec4899",
  "#f59e0b", "#f97316", "#22c55e", "#10b981", "#14b8a6",
  "#ef4444", "#737373", "#6366f1", "#0ea5e9",
];

export default function KanbanBoard({ leads, columns, onLeadClick, formatPhone, onLeadsUpdated, onColumnsChange }: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [localLeads, setLocalLeads] = useState<Lead[]>(leads);
  const [localCols, setLocalCols] = useState<KanbanColumnDef[]>(columns);

  useEffect(() => setLocalLeads(leads), [leads]);
  useEffect(() => setLocalCols(columns), [columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // --- CRUD colunas (otimista + rollback) ---
  const persistColumn = useCallback(async (uuid: string, patch: Partial<KanbanColumnDef>) => {
    if (!uuid) {
      alert("Coluna ainda carregando do servidor. Recarregue a página e tente novamente.");
      return;
    }
    let prev: KanbanColumnDef[] = [];
    setLocalCols((cur) => {
      prev = cur;
      return cur.map((c) => (c.uuid === uuid ? { ...c, ...patch } : c));
    });
    onColumnsChange?.(prev.map((c) => (c.uuid === uuid ? { ...c, ...patch } : c)));
    try {
      const body: Record<string, any> = {};
      if (patch.label !== undefined) body.label = patch.label;
      if (patch.color !== undefined) body.color = patch.color;
      const res = await fetch(`/api/kanban-columns/${uuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`PATCH ${res.status}: ${errText.slice(0, 200)}`);
      }
    } catch (err) {
      console.error("coluna patch rollback", err);
      setLocalCols(prev);
      onColumnsChange?.(prev.map((c) => ({ id: c.id, uuid: c.uuid, label: c.label, color: c.color, isTerminal: !!c.isTerminal })));
    }
  }, [onColumnsChange]);

  const addColumn = useCallback(async () => {
    const label = prompt("Nome da nova coluna:");
    if (!label?.trim()) return;
    const color = COLOR_PRESETS[localCols.length % COLOR_PRESETS.length];
    const status_key = label.trim().toLowerCase().slice(0, 20).replace(/[^a-z0-9_-]/g, "_");
    try {
      const res = await fetch("/api/kanban-columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status_key, label: label.trim(), color }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "POST fail");
      const newCol: KanbanColumnDef = {
        id: j.column.status_key, uuid: j.column.id,
        label: j.column.label, color: j.column.color, isTerminal: !!j.column.is_terminal,
      };
      setLocalCols([...localCols, newCol]);
      onColumnsChange?.([...localCols, newCol]);
    } catch (err) {
      console.error("coluna add fail", err);
      alert("Erro ao criar coluna: " + (err as Error).message);
    }
  }, [localCols, onColumnsChange]);

  const deleteColumn = useCallback(async (uuid: string) => {
    if (!confirm("Apagar essa coluna? Leads dentro dela não serão removidos, mas ficarão sem coluna visual.")) return;
    try {
      const res = await fetch(`/api/kanban-columns/${uuid}`, { method: "DELETE" });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "DELETE fail");
      setLocalCols(localCols.filter((c) => c.uuid !== uuid));
      onColumnsChange?.(localCols.filter((c) => c.uuid !== uuid));
    } catch (err) {
      alert("Erro ao apagar coluna: " + (err as Error).message);
    }
  }, [localCols, onColumnsChange]);

  // --- Drag leads entre colunas ---
  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const leadId = active.id as number;
    const overId = String(over.id);

    let newStatus: string | null = null;
    const colById = localCols.find((c) => c.id === overId);
    if (colById) newStatus = colById.id;
    else {
      const overLead = localLeads.find((l) => String(l.id) === overId);
      if (overLead) newStatus = overLead.status || "novo";
    }
    if (!newStatus) return;

    const current = localLeads.find((l) => l.id === leadId)?.status || "novo";
    if (newStatus === current) return;

    const updated = localLeads.map((l) =>
      l.id === leadId ? { ...l, status: newStatus! } : l
    );
    setLocalLeads(updated);
    onLeadsUpdated?.(updated);

    await supabase.from("leads_extraidos").update({ status: newStatus }).eq("id", leadId);
  }, [localCols, localLeads, onLeadsUpdated]);

  const displayLeads = activeId ? localLeads : leads;

  return (
    <div className="flex-1 w-full overflow-x-auto custom-scrollbar pb-8 cursor-default kanban-scroll-container mobile-safe-bottom">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e: DragStartEvent) => setActiveId(e.active.id as number)}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 sm:gap-4 min-w-max p-2 h-full min-h-[calc(100vh-250px)] items-start">
          {localCols.map((col) => (
            <SortableContext
              key={col.uuid || col.id || col.label}
              items={displayLeads.filter((l) => (l.status || "novo") === col.id).map((l) => l.id)}
              strategy={verticalListSortingStrategy}
            >
              <KanbanColumn
                column={col}
                leads={displayLeads.filter((l) => (l.status || "novo") === col.id)}
                onLeadClick={onLeadClick}
                formatPhone={formatPhone}
                onRename={(label: string) => persistColumn(col.uuid, { label })}
                onDelete={() => deleteColumn(col.uuid)}
                onColorChange={(color: string) => persistColumn(col.uuid, { color })}
              />
            </SortableContext>
          ))}

          {/* Add coluna */}
          <button
            onClick={addColumn}
            className="w-[280px] sm:w-[300px] shrink-0 rounded-2xl border-2 border-dashed border-white/10 text-white/40 hover:text-white/80 hover:border-white/30 transition-all duration-200 py-4 flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest backdrop-blur-sm"
            title="Adicionar coluna"
          >
            <Plus className="w-4 h-4" /> Nova Coluna
          </button>
        </div>
        <DragOverlay>
          {activeId ? (
            <KanbanCard lead={displayLeads.find((l) => l.id === activeId)} isOverlay formatPhone={formatPhone} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// --- Kanban Sub-components ---

function KanbanColumn({ column, leads, onLeadClick, formatPhone, onRename, onDelete, onColorChange }: any) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.label);
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  // Sincroniza o draft quando o label muda por fora — padrão "adjust during render"
  // (React docs) em vez de useEffect.
  const [prevLabel, setPrevLabel] = useState(column.label);
  if (prevLabel !== column.label) {
    setPrevLabel(column.label);
    setDraft(column.label);
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus(), inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false); setColorOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const commitRename = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== column.label) onRename(v);
    else setDraft(column.label);
  };

  const cancelRename = () => { setEditing(false); setDraft(column.label); };

  const isHex = typeof column.color === "string" && column.color.startsWith("#");
  const hexStyle = isHex
    ? { backgroundColor: `${column.color}1f`, borderColor: `${column.color}50`, color: column.color }
    : undefined;
  const dotStyle = isHex ? { backgroundColor: column.color } : undefined;

  return (
    <div className="w-[280px] sm:w-[300px] flex flex-col gap-3 shrink-0">
      {/* Header coluna */}
      <div
        className={cn(
          "px-3 py-2.5 rounded-xl border text-xs font-bold tracking-wide flex items-center justify-between backdrop-blur-md shadow-md transition-colors",
          !isHex && column.color
        )}
        style={hexStyle}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className={cn("w-2.5 h-2.5 rounded-full shrink-0", !isHex && column.color)}
            style={dotStyle}
          />
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
              }}
              className="bg-black/40 border border-white/30 rounded px-1.5 py-0.5 text-xs font-bold text-white outline-none focus:border-white/60 flex-1 min-w-0"
              style={isHex ? { color: "#fff" } : undefined}
              maxLength={40}
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="text-left truncate hover:underline underline-offset-2 flex-1 min-w-0"
              title="Clique para editar o nome"
            >
              {column.label}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Badge variant="secondary" className="bg-black/40 text-inherit border border-current/20 text-[10px] w-6 h-6 p-0 flex items-center justify-center rounded-full font-black">
            {leads.length}
          </Badge>
          <div className="relative" ref={menuRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
              className="p-1 rounded-md hover:bg-black/30 text-current/70 hover:text-current transition-colors"
              title="Opções da coluna"
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-7 z-50 min-w-[180px] bg-neutral-900/98 backdrop-blur-xl border border-white/15 rounded-lg shadow-2xl shadow-black/50 py-1 text-white">
                <button
                  onClick={() => { setEditing(true); setMenuOpen(false); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-white/10 flex items-center gap-2"
                >
                  <Pencil className="w-3.5 h-3.5" /> Renomear
                </button>
                <button
                  onClick={() => setColorOpen(!colorOpen)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-white/10 flex items-center gap-2"
                >
                  <span className="w-3.5 h-3.5 rounded-full border border-white/30" style={dotStyle} /> Cor
                </button>
                {colorOpen && (
                  <div className="px-3 pb-2 pt-1 grid grid-cols-7 gap-1.5 border-t border-white/10 mt-1">
                    {COLOR_PRESETS.map((c) => (
                      <button
                        key={c}
                        onClick={() => { onColorChange(c); setColorOpen(false); }}
                        className="w-5 h-5 rounded-full border-2 hover:scale-110 transition-transform"
                        style={{ backgroundColor: c, borderColor: column.color === c ? "#fff" : "transparent" }}
                        title={c}
                      />
                    ))}
                  </div>
                )}
                <div className="border-t border-white/10 my-1" />
                <button
                  onClick={() => { setMenuOpen(false); onDelete(); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-red-500/15 text-red-400 flex items-center gap-2"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Apagar
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Lista de cards */}
      <div className="flex-1 space-y-2.5 p-1 min-h-[200px] overflow-y-auto custom-scrollbar pr-1 max-h-[calc(100vh-290px)] rounded-lg">
        {leads.length === 0 ? (
          <div className="h-32 rounded-xl border border-dashed border-white/10 flex items-center justify-center text-[10px] text-white/30 uppercase tracking-wider">
            Vazio — arraste aqui
          </div>
        ) : (
          leads.map((lead: any) => (
            <KanbanCard key={lead.id} lead={lead} onClick={() => onLeadClick(lead)} formatPhone={formatPhone} />
          ))
        )}
      </div>
    </div>
  );
}

function KanbanCard({ lead, onClick, isOverlay, formatPhone }: any) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: lead?.id || 0 });

  if (!lead) return null;

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging || isOverlay ? 50 : 1,
    opacity: isDragging ? 0.6 : 1,
  };

  const isOverdue = lead.next_follow_up && new Date(lead.next_follow_up) < new Date();
  const initials = (lead.nome_negocio || "UD").substring(0, 2).toUpperCase();

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "group border-white/5 bg-white/[0.04] backdrop-blur-xl transition-all duration-300 rounded-xl overflow-hidden",
        isOverlay && "scale-[1.03] shadow-2xl shadow-primary/20 rotate-1 border-primary/40 ring-1 ring-primary/30 z-[100]",
        !isOverlay && "hover:bg-white/10 hover:border-white/20 hover:shadow-xl hover:-translate-y-0.5"
      )}
      onClick={onClick}
    >
      {/* Drag handle mobile */}
      <div
        {...attributes}
        {...listeners}
        className="flex items-center justify-center h-5 cursor-grab active:cursor-grabbing bg-white/[0.03] border-b border-white/5 md:hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-8 h-1 rounded-full bg-white/20" />
      </div>
      <CardContent
        className="p-3"
        {...(typeof window !== "undefined" && window.matchMedia("(min-width:768px)").matches ? { ...attributes, ...listeners, style: { cursor: "grab" } } : {})}
      >
        <div className="flex gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary/20 to-purple-500/20 flex items-center justify-center shrink-0 border border-white/10 group-hover:border-primary/50 transition-colors">
            <span className="text-[11px] font-black text-white/90">{initials}</span>
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-bold leading-tight group-hover:text-primary-300 transition-colors line-clamp-2 text-white pb-0.5">
              {lead.nome_negocio || "Sem Registro"}
            </p>

            <div className="flex items-center gap-1 mt-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
              <Phone className="w-3 h-3 text-green-400 shrink-0" />
              <span className="text-[10px] font-mono text-green-100/90 truncate">
                {lead.telefone || formatPhone(lead.remoteJid)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-2.5 items-center justify-between">
          <Badge variant="outline" className="text-[9px] font-bold tracking-wider py-0 px-2 border-white/10 bg-black/40 text-neutral-300 rounded-md max-w-[140px] truncate">
            {lead.ramo_negocio ? (lead.ramo_negocio.length > 20 ? lead.ramo_negocio.substring(0, 20) + '…' : lead.ramo_negocio) : "GERAL"}
          </Badge>

          {lead.rating && (
            <div className="flex items-center gap-0.5 bg-amber-500/10 px-1.5 py-0.5 rounded-md border border-amber-500/20">
              <Star className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
              <span className="text-[9px] font-bold text-amber-400">{lead.rating}</span>
              {lead.reviews && <span className="text-[8px] text-amber-400/60">({lead.reviews})</span>}
            </div>
          )}
        </div>

        {lead.next_follow_up && (
          <div className={cn(
            "mt-2.5 p-1.5 rounded-md flex items-center gap-1.5 text-[10px] font-bold border",
            isOverdue ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-primary/10 text-primary-300 border-primary/20"
          )}>
            <Clock className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {isOverdue ? "ATRASADO " : "RETORNO "}
              {new Date(lead.next_follow_up).toLocaleString("pt-BR", { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}

        <div className="mt-2 flex justify-end">
          <a
            href={mapsUrlFor(lead)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[9px] font-bold text-rose-300/80 hover:text-rose-200 hover:bg-rose-500/10 px-1.5 py-0.5 rounded-md transition-colors"
            title="Ver no Google Maps"
          >
            <MapPin className="w-3 h-3" />
            Maps
          </a>
        </div>
      </CardContent>
    </Card>
  );
}